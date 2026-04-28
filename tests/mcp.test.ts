import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { analyzeDiff, indexProject, initProject } from '../src/index.js';
import { databasePath } from '../src/store.js';

const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve('tsx');

type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

class McpProcessClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly messages: JsonRpcMessage[] = [];
  private readonly waiters: Array<(message: JsonRpcMessage) => void> = [];
  private buffer = '';
  private nextId = 1;
  private stderr = '';

  constructor(repoRoot: string) {
    this.child = spawn(process.execPath, ['--import', tsxLoaderPath, path.resolve('src/cli.ts'), 'mcp', 'serve'], {
      cwd: repoRoot,
      stdio: 'pipe'
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
  }

  async initialize(): Promise<JsonRpcMessage> {
    const response = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {
        name: 'impact-trace-test',
        version: '0.0.0'
      }
    });
    this.notify('notifications/initialized', {});
    return response;
  }

  async request(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const response = this.waitForResponse(id);
    this.write({ jsonrpc: '2.0', id, method, params });
    return response;
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  close(): Promise<void> {
    if (this.child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.kill();
      setTimeout(resolve, 500).unref();
    });
  }

  private write(message: JsonRpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line) as JsonRpcMessage;
        const waiter = this.waiters.shift();
        if (waiter) waiter(message);
        else this.messages.push(message);
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private async waitForResponse(id: string | number): Promise<JsonRpcMessage> {
    const deadlineMs = 2_000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < deadlineMs) {
      const index = this.messages.findIndex((message) => message.id === id);
      if (index >= 0) return this.messages.splice(index, 1)[0]!;
      const message = await this.readNext(deadlineMs - (Date.now() - startedAt));
      if (message.id === id) return message;
      this.messages.push(message);
    }
    throw new Error(`timed out waiting for MCP response ${id}. stderr: ${this.stderr.trim()}`);
  }

  private readNext(timeoutMs: number): Promise<JsonRpcMessage> {
    if (this.messages.length > 0) return Promise.resolve(this.messages.shift()!);
    return new Promise((resolve, reject) => {
      const waiter = (message: JsonRpcMessage) => {
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timed out waiting for MCP message. stderr: ${this.stderr.trim()}`));
      }, Math.max(timeoutMs, 1));
      this.waiters.push(waiter);
    });
  }
}

async function makeRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-mcp-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(repoRoot, 'src/b.ts'), 'import { a } from "./a"; export const b = a;\n');
  await initProject({ repoRoot });
  await indexProject({ repoRoot });
  return repoRoot;
}

function countReports(repoRoot: string): number {
  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const row = db.prepare('SELECT count(*) AS count FROM reports').get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function dbArtifacts(repoRoot: string): string[] {
  return ['impact.db', 'impact.db-wal', 'impact.db-shm']
    .filter((file) => existsSync(path.join(repoRoot, '.impact-trace', file)));
}

test('MCP stdio server initializes and exposes only read-only tools by default', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    const initialize = await client.initialize();
    assert.equal(initialize.error, undefined);
    assert.equal(typeof initialize.result.protocolVersion, 'string');
    assert.equal(initialize.result.serverInfo.name, 'impact-trace');

    const response = await client.request('tools/list', {});
    assert.equal(response.error, undefined);
    assert.ok(response.result.tools.some((tool: { name: string }) => tool.name === 'impact_trace_analyze_diff'));
    assert.equal(response.result.tools.some((tool: { name: string }) => tool.name.includes('obsidian')), false);
  } finally {
    await client.close();
  }
});

test('MCP analyze_diff validates paths and returns affected files', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'impact_trace_analyze_diff',
      arguments: { changedFiles: ['src/a.ts'] }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.content[0].type, 'text');
    const report = JSON.parse(response.result.content[0].text) as { affectedFiles: Array<{ path: string }> };
    assert.ok(report.affectedFiles.some((file) => file.path === 'src/b.ts'));

    const bad = await client.request('tools/call', {
      name: 'impact_trace_analyze_diff',
      arguments: { changedFiles: ['../outside.ts'] }
    });

    assert.equal(bad.error, undefined);
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /outside repo root/);
  } finally {
    await client.close();
  }
});

test('MCP analyze_diff does not persist reports', async () => {
  const repoRoot = await makeRepo();
  const artifactsBefore = dbArtifacts(repoRoot);
  assert.equal(countReports(repoRoot), 0);
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();
    const response = await client.request('tools/call', {
      name: 'impact_trace_analyze_diff',
      arguments: { changedFiles: ['src/a.ts'] }
    });

    assert.equal(response.error, undefined);
    assert.equal(countReports(repoRoot), 0);
    assert.deepEqual(dbArtifacts(repoRoot), artifactsBefore);
    assert.equal(existsSync(path.join(repoRoot, '.impact-trace/reports')), false);
  } finally {
    await client.close();
  }
});

test('MCP exposes report, entity, graph, and coverage resources', async () => {
  const repoRoot = await makeRepo();
  const report = await analyzeDiff({ repoRoot, changedFiles: ['src/a.ts'] });
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const templates = await client.request('resources/templates/list', {});
    assert.equal(templates.error, undefined);
    const templateUris = templates.result.resourceTemplates.map((item: { uriTemplate: string }) => item.uriTemplate);
    assert.ok(templateUris.includes('impact-trace://reports/{reportId}'));
    assert.ok(templateUris.includes('impact-trace://entities/{entityId}'));
    assert.ok(templateUris.includes('impact-trace://reports/{reportId}/graph/{format}'));

    const resources = await client.request('resources/list', {});
    assert.equal(resources.error, undefined);
    const resourceUris = resources.result.resources.map((item: { uri: string }) => item.uri);
    assert.ok(resourceUris.includes(`impact-trace://reports/${report.id}`));
    assert.ok(resourceUris.includes(`impact-trace://reports/${report.id}/graph/dot`));
    assert.ok(resourceUris.includes('impact-trace://coverage/latest'));

    const reportResource = await client.request('resources/read', {
      uri: `impact-trace://reports/${report.id}`
    });
    assert.equal(reportResource.error, undefined);
    const reportJson = JSON.parse(reportResource.result.contents[0].text) as { id: string };
    assert.equal(reportJson.id, report.id);

    const entityResource = await client.request('resources/read', {
      uri: `impact-trace://entities/${encodeURIComponent('file:src/a.ts')}`
    });
    assert.equal(entityResource.error, undefined);
    const entityJson = JSON.parse(entityResource.result.contents[0].text) as {
      entity: { id: string };
      incoming: unknown[];
      limits: { incomingTruncated: boolean; outgoingTruncated: boolean };
    };
    assert.equal(entityJson.entity.id, 'file:src/a.ts');
    assert.ok(entityJson.incoming.length > 0);
    assert.equal(entityJson.limits.incomingTruncated, false);
    assert.equal(entityJson.limits.outgoingTruncated, false);

    const graphResource = await client.request('resources/read', {
      uri: `impact-trace://reports/${report.id}/graph/dot`
    });
    assert.equal(graphResource.error, undefined);
    assert.match(graphResource.result.contents[0].text, /^digraph impact_trace/);

    const coverageResource = await client.request('resources/read', {
      uri: 'impact-trace://coverage/latest'
    });
    assert.equal(coverageResource.error, undefined);
    const coverageJson = JSON.parse(coverageResource.result.contents[0].text) as { coverage: unknown[]; truncated: boolean };
    assert.ok(coverageJson.coverage.length > 0);
    assert.equal(coverageJson.truncated, false);
  } finally {
    await client.close();
  }
});

test('MCP analyze_diff on uninitialized repo does not create workspace files', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-mcp-uninit-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();
    const response = await client.request('tools/call', {
      name: 'impact_trace_analyze_diff',
      arguments: { changedFiles: ['src/a.ts'] }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /database not found|init and impact-trace index/);
    assert.equal(existsSync(path.join(repoRoot, '.impact-trace')), false);
  } finally {
    await client.close();
  }
});
