import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { indexProject, initProject } from '../src/index.js';

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
