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

// Force the deterministic SHA-256 stub so spawned MCP subprocesses don't
// download a real embedding model (~278 MB) during the test run.
process.env.IMPACT_TRACE_EMBEDDING_MODEL = 'stub-sha256';
// Stub reflection LLM so the MCP reflect round-trip never touches the
// network and does not require ANTHROPIC_API_KEY / OPENAI_API_KEY / Ollama.
process.env.IMPACT_TRACE_REFLECTION_MODEL = 'stub';

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

async function makeWideContextRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-mcp-wide-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await mkdir(path.join(repoRoot, 'tests'), { recursive: true });
  await mkdir(path.join(repoRoot, 'docs'), { recursive: true });
  await mkdir(path.join(repoRoot, '.github/workflows'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
  for (const name of ['b', 'c', 'd', 'e', 'f', 'g']) {
    await writeFile(
      path.join(repoRoot, `src/${name}.ts`),
      [
        'import { a } from "./a";',
        `const padded${name.toUpperCase()} = "${'x'.repeat(420)}";`,
        `export const ${name} = a + padded${name.toUpperCase()}.length;`
      ].join('\n')
    );
  }
  await writeFile(
    path.join(repoRoot, 'tests/a.test.ts'),
    [
      'import { a } from "../src/a";',
      `const paddedTest = "${'t'.repeat(420)}";`,
      'export const verified = a + paddedTest.length;'
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'docs/a.md'),
    [
      '# A module',
      `The implementation in src/a.ts is part of this flow. ${'d'.repeat(420)}`
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, '.github/workflows/ci.yml'),
    [
      'name: ci',
      'on: [push]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      `      - run: npm test -- src/a.ts ${'c'.repeat(420)}`
    ].join('\n')
  );

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

test('MCP stdio server initializes and exposes the full agent memory tool surface', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    const initialize = await client.initialize();
    assert.equal(initialize.error, undefined);
    assert.equal(typeof initialize.result.protocolVersion, 'string');
    assert.equal(initialize.result.serverInfo.name, 'impact-trace');

    const response = await client.request('tools/list', {});
    assert.equal(response.error, undefined);
    const toolByName = new Map<string, { name: string; annotations?: { readOnlyHint?: boolean } }>(
      (response.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>).map((tool) => [tool.name, tool])
    );
    for (const expected of [
      'impact_trace_analyze_diff',
      'impact_trace_context_for_change',
      'impact_trace_remember',
      'impact_trace_recall',
      'impact_trace_branch',
      'impact_trace_merge',
      'impact_trace_trace',
      'impact_trace_reflect',
      'impact_trace_abandon_branch',
      'impact_trace_gc_branches',
      'impact_trace_profile',
      'impact_trace_repair_reflections',
      'impact_trace_restore_branch'
    ]) {
      assert.ok(toolByName.has(expected), `expected MCP tool ${expected} to be advertised`);
    }
    assert.equal(toolByName.get('impact_trace_analyze_diff')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('impact_trace_context_for_change')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('impact_trace_recall')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('impact_trace_trace')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('impact_trace_profile')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('impact_trace_remember')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('impact_trace_branch')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('impact_trace_merge')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('impact_trace_reflect')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('impact_trace_abandon_branch')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('impact_trace_gc_branches')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('impact_trace_repair_reflections')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('impact_trace_restore_branch')!.annotations?.readOnlyHint, false);
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
    const filterWalAux = (names: string[]): string[] =>
      names.filter((name) => !/\.db-(wal|shm)$/.test(name));
    assert.deepEqual(filterWalAux(dbArtifacts(repoRoot)), filterWalAux(artifactsBefore));
    assert.equal(existsSync(path.join(repoRoot, '.impact-trace/reports')), false);
  } finally {
    await client.close();
  }
});

test('MCP context_for_change returns budgeted compact context without persisting reports', async () => {
  const repoRoot = await makeRepo();
  const artifactsBefore = dbArtifacts(repoRoot);
  assert.equal(countReports(repoRoot), 0);
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();
    const response = await client.request('tools/call', {
      name: 'impact_trace_context_for_change',
      arguments: { changedFiles: ['src/a.ts'], budget: 'brief' }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.content[0].type, 'text');
    const pack = JSON.parse(response.result.content[0].text) as {
      version: number;
      budget: string;
      changed: Array<{ entity: { id: string }; resourceUri: string }>;
      context: Array<{ path: string; resourceUri: string; relations: string[] }>;
      evidence: Array<{ snippet: string; file: string }>;
      resources: { coverage: string; entities: string[] };
      limits: { affectedLimit: number; evidenceLimit: number; snippetChars: number };
      omittedCounts: { affected: number; evidence: number; actions: number };
    };
    assert.equal(pack.version, 0);
    assert.equal(pack.budget, 'brief');
    assert.equal(pack.changed[0]?.entity.id, 'file:src/a.ts');
    assert.equal(pack.changed[0]?.resourceUri, `impact-trace://entities/${encodeURIComponent('file:src/a.ts')}`);
    assert.ok(pack.context.some((item) => item.path === 'src/b.ts'));
    assert.ok(pack.context.every((item) => item.resourceUri.startsWith('impact-trace://entities/')));
    assert.ok(pack.context.every((item) => item.relations.length > 0));
    assert.ok(pack.evidence.length > 0);
    assert.ok(pack.evidence.every((item) => item.snippet.length <= pack.limits.snippetChars));
    assert.equal(pack.resources.coverage, 'impact-trace://coverage/latest');
    assert.ok(pack.resources.entities.includes(`impact-trace://entities/${encodeURIComponent('file:src/a.ts')}`));
    assert.equal(pack.limits.affectedLimit, 5);
    assert.equal(pack.limits.evidenceLimit, 5);
    assert.equal(pack.omittedCounts.affected, 0);
    assert.equal(countReports(repoRoot), 0);
    const filterWalAux = (names: string[]): string[] =>
      names.filter((name) => !/\.db-(wal|shm)$/.test(name));
    assert.deepEqual(filterWalAux(dbArtifacts(repoRoot)), filterWalAux(artifactsBefore));
    assert.equal(existsSync(path.join(repoRoot, '.impact-trace/reports')), false);
  } finally {
    await client.close();
  }
});

test('MCP context_for_change applies budget presets and validates paths', async () => {
  const repoRoot = await makeWideContextRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const briefResponse = await client.request('tools/call', {
      name: 'impact_trace_context_for_change',
      arguments: { changedFiles: ['src/a.ts'], budget: 'brief' }
    });
    const deepResponse = await client.request('tools/call', {
      name: 'impact_trace_context_for_change',
      arguments: { changedFiles: ['src/a.ts'], budget: 'deep' }
    });
    const brief = JSON.parse(briefResponse.result.content[0].text) as {
      context: Array<{ path: string }>;
      evidence: Array<{ snippet: string }>;
      omittedCounts: { affected: number; evidence: number };
      limits: {
        affectedLimit: number;
        evidenceLimit: number;
        snippetChars: number;
        affectedTruncated: boolean;
        evidenceTruncated: boolean;
      };
    };
    const deep = JSON.parse(deepResponse.result.content[0].text) as {
      context: Array<{ path: string }>;
      evidence: Array<{ snippet: string }>;
      omittedCounts: { affected: number; evidence: number };
      limits: {
        affectedLimit: number;
        evidenceLimit: number;
        snippetChars: number;
        affectedTruncated: boolean;
        evidenceTruncated: boolean;
      };
    };
    assert.ok(deep.limits.affectedLimit > brief.limits.affectedLimit);
    assert.ok(deep.limits.evidenceLimit > brief.limits.evidenceLimit);
    assert.ok(deep.limits.snippetChars > brief.limits.snippetChars);
    assert.equal(brief.context.length, brief.limits.affectedLimit);
    assert.equal(brief.evidence.length, brief.limits.evidenceLimit);
    assert.equal(brief.limits.affectedTruncated, true);
    assert.equal(brief.limits.evidenceTruncated, true);
    assert.ok(brief.omittedCounts.affected > 0);
    assert.ok(brief.omittedCounts.evidence > 0);
    assert.ok(brief.evidence.every((item) => item.snippet.length <= brief.limits.snippetChars));
    assert.ok(brief.evidence.some((item) => item.snippet.endsWith('...')));
    assert.ok(deep.context.length > brief.context.length);
    assert.ok(deep.evidence.length > brief.evidence.length);
    assert.equal(deep.omittedCounts.affected, 0);

    const bad = await client.request('tools/call', {
      name: 'impact_trace_context_for_change',
      arguments: { changedFiles: ['../outside.ts'] }
    });
    assert.equal(bad.error, undefined);
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /outside repo root/);
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

test('MCP remember persists a fact and recall returns it on the main branch', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const remembered = await client.request('tools/call', {
      name: 'impact_trace_remember',
      arguments: {
        entity: 'file:src/a.ts',
        attribute: 'observed',
        value: 'compiled cleanly'
      }
    });

    assert.equal(remembered.error, undefined);
    assert.equal(remembered.result.isError, undefined);
    const rememberPayload = JSON.parse(remembered.result.content[0].text) as { factId: string; txId: string };
    assert.match(rememberPayload.factId, /^[0-9a-f]{64}$/);
    assert.match(rememberPayload.txId, /^[0-9a-f]{64}$/);

    const recalled = await client.request('tools/call', {
      name: 'impact_trace_recall',
      arguments: { entity: 'file:src/a.ts', attribute: 'observed' }
    });

    assert.equal(recalled.error, undefined);
    const recallPayload = JSON.parse(recalled.result.content[0].text) as {
      facts: Array<{ id: string; entityId: string; attribute: string; value: unknown; op: string }>;
    };
    assert.equal(recallPayload.facts.length, 1);
    const fact = recallPayload.facts[0]!;
    assert.equal(fact.id, rememberPayload.factId);
    assert.equal(fact.entityId, 'file:src/a.ts');
    assert.equal(fact.attribute, 'observed');
    assert.equal(fact.value, 'compiled cleanly');
    assert.equal(fact.op, 'assert');
  } finally {
    await client.close();
  }
});

test('MCP branch forks a new branch from main without copying facts', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const created = await client.request('tools/call', {
      name: 'impact_trace_branch',
      arguments: { name: 'experiment-1' }
    });

    assert.equal(created.error, undefined);
    assert.equal(created.result.isError, undefined);
    const payload = JSON.parse(created.result.content[0].text) as { branchId: string; headTxId: string | null };
    assert.match(payload.branchId, /^br_[0-9a-f]{16}$/);
    // After makeRepo runs the indexer, main.head_tx_id is the indexer-produced tx hash;
    // a fresh fork inherits that head pointer rather than null.
    assert.match(payload.headTxId ?? '', /^[0-9a-f]{64}$/);

    const duplicate = await client.request('tools/call', {
      name: 'impact_trace_branch',
      arguments: { name: 'experiment-1' }
    });
    assert.equal(duplicate.result.isError, true);
    assert.match(duplicate.result.content[0].text, /branch already exists/);
  } finally {
    await client.close();
  }
});

test('MCP trace walks fact_provenance back through the causal chain', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const sourceResp = await client.request('tools/call', {
      name: 'impact_trace_remember',
      arguments: {
        entity: 'file:src/a.ts',
        attribute: 'observed',
        value: 'export-symbol-a'
      }
    });
    const source = JSON.parse(sourceResp.result.content[0].text) as { factId: string };

    const derivedResp = await client.request('tools/call', {
      name: 'impact_trace_remember',
      arguments: {
        entity: 'file:src/b.ts',
        attribute: 'observed',
        value: 'imports-a',
        evidenceFactIds: [source.factId]
      }
    });
    const derived = JSON.parse(derivedResp.result.content[0].text) as { factId: string };

    const traced = await client.request('tools/call', {
      name: 'impact_trace_trace',
      arguments: { factId: derived.factId }
    });
    assert.equal(traced.error, undefined);
    const tracePayload = JSON.parse(traced.result.content[0].text) as {
      chain: Array<{ id: string }>;
    };
    const chainIds = tracePayload.chain.map((entry) => entry.id);
    assert.deepEqual(chainIds, [derived.factId, source.factId]);

    const missing = await client.request('tools/call', {
      name: 'impact_trace_trace',
      arguments: { factId: '0000000000000000000000000000000000000000000000000000000000000000' }
    });
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /fact not found/);
  } finally {
    await client.close();
  }
});

test('MCP remember rejects unknown branches', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'impact_trace_remember',
      arguments: {
        entity: 'file:src/a.ts',
        attribute: 'observed',
        value: 'whatever',
        branch: 'does-not-exist'
      }
    });

    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /branch not found/);
  } finally {
    await client.close();
  }
});

test('MCP abandon_branch + gc_branches round-trip', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const refuseMain = await client.request('tools/call', {
      name: 'impact_trace_abandon_branch',
      arguments: { name: 'main' }
    });
    assert.equal(refuseMain.result.isError, true);
    assert.match(refuseMain.result.content[0].text, /cannot abandon protected branch/);

    const branchResp = await client.request('tools/call', {
      name: 'impact_trace_branch',
      arguments: { name: 'mcp-spec' }
    });
    assert.equal(branchResp.result.isError, undefined);

    const rememberResp = await client.request('tools/call', {
      name: 'impact_trace_remember',
      arguments: {
        branch: 'mcp-spec',
        entity: 'file:src/spec.ts',
        attribute: 'observed',
        value: 'spec-fact'
      }
    });
    assert.equal(rememberResp.result.isError, undefined);

    const abandonResp = await client.request('tools/call', {
      name: 'impact_trace_abandon_branch',
      arguments: { name: 'mcp-spec' }
    });
    const abandonPayload = JSON.parse(abandonResp.result.content[0].text) as {
      state: string;
      alreadyAbandoned: boolean;
    };
    assert.equal(abandonPayload.state, 'abandoned');
    assert.equal(abandonPayload.alreadyAbandoned, false);

    const dryGcResp = await client.request('tools/call', {
      name: 'impact_trace_gc_branches',
      arguments: { dryRun: true }
    });
    const dryGcPayload = JSON.parse(dryGcResp.result.content[0].text) as {
      dryRun: boolean;
      archivedTransactions: number;
    };
    assert.equal(dryGcPayload.dryRun, true);
    assert.equal(dryGcPayload.archivedTransactions, 1);

    const gcResp = await client.request('tools/call', {
      name: 'impact_trace_gc_branches',
      arguments: {}
    });
    const gcPayload = JSON.parse(gcResp.result.content[0].text) as {
      archivedTransactions: number;
    };
    assert.equal(gcPayload.archivedTransactions, 1);
  } finally {
    await client.close();
  }
});

test('MCP reflect summarizes via stub provider', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    for (const value of ['"first"', '"second"']) {
      const remembered = await client.request('tools/call', {
        name: 'impact_trace_remember',
        arguments: {
          entity: 'file:src/mcp-reflect.ts',
          attribute: 'observed',
          value: JSON.parse(value) as unknown
        }
      });
      assert.equal(remembered.result.isError, undefined);
    }

    // Age the transactions in-process so reflect picks them up. Spawned
    // subprocess shares the on-disk DB.
    const db = new DatabaseSync(databasePath(repoRoot), { readOnly: false });
    try {
      db.prepare("UPDATE transactions SET ts = '2020-01-01T00:00:00.000Z'").run();
    } finally {
      db.close();
    }

    const reflectResp = await client.request('tools/call', {
      name: 'impact_trace_reflect',
      arguments: { olderThanDays: 1, entity: 'file:src/mcp-reflect.ts' }
    });
    assert.equal(reflectResp.result.isError, undefined);
    const payload = JSON.parse(reflectResp.result.content[0].text) as {
      summarized: number;
      model: string;
      reflections: Array<{ entity: string; sourceCount: number }>;
    };
    assert.equal(payload.summarized, 1);
    assert.equal(payload.reflections[0]!.entity, 'file:src/mcp-reflect.ts');
    assert.equal(payload.reflections[0]!.sourceCount, 2);
    assert.match(payload.model, /^stub|ollama:|anthropic:|openai:/);
  } finally {
    await client.close();
  }
});
