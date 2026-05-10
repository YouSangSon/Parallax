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

async function makeSecretPathRepo(): Promise<{ repoRoot: string; secretPath: string }> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-mcp-secret-path-'));
  const secretPath = 'src/sk-12345678901234567890.ts';
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, secretPath), 'export const secretNamedFile = 1;\n');
  await initProject({ repoRoot });
  await indexProject({ repoRoot });
  return { repoRoot, secretPath };
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

async function makeSearchEscapingRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-mcp-search-escaping-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/percent%literal.ts'), 'export const percentLiteral = 1;\n');
  await writeFile(path.join(repoRoot, 'src/under_score.ts'), 'export const underScore = 1;\n');
  await writeFile(path.join(repoRoot, 'src/back\\slash.ts'), 'export const backSlash = 1;\n');
  await writeFile(path.join(repoRoot, 'src/plain.ts'), 'export const plain = 1;\n');
  await initProject({ repoRoot });
  await indexProject({ repoRoot });
  return repoRoot;
}

async function makeSearchRankingRepo(): Promise<string> {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(databasePath(repoRoot));
  try {
    const repo = db.prepare('SELECT id FROM repos LIMIT 1').get() as { id: number };
    const run = db
      .prepare('SELECT id FROM index_runs WHERE repo_id = ? AND status = ? ORDER BY id DESC LIMIT 1')
      .get(repo.id, 'completed') as { id: number };

    const insertEntity = db.prepare(`
      INSERT INTO entities (
        id, repo_id, kind, path, symbol, language_id, display_name,
        created_index_run_id, updated_index_run_id
      )
      VALUES (?, ?, 'file', ?, NULL, 'typescript', ?, ?, ?)
    `);
    const insertRelation = db.prepare(`
      INSERT INTO relations (
        id, repo_id, source_entity_id, target_entity_id, kind, confidence,
        adapter_run_id, index_run_id, provenance
      )
      VALUES (?, ?, ?, ?, ?, 'medium', NULL, ?, ?)
    `);
    const insertEvidence = db.prepare(`
      INSERT INTO relation_evidence (
        id, relation_id, repo_id, file_path, kind, snippet, confidence, index_run_id
      )
      VALUES (?, ?, ?, ?, ?, ?, 'medium', ?)
    `);

    const addEntity = (id: string, displayName: string, pathSuffix = id): void => {
      insertEntity.run(id, repo.id, `rank-fixture/${pathSuffix}.ts`, displayName, run.id, run.id);
    };
    const addRelation = (
      entityId: string,
      relationId: string,
      relationKind: string,
      evidenceKind: string,
      snippet: string
    ): void => {
      insertRelation.run(relationId, repo.id, entityId, entityId, relationKind, run.id, 'rank-fixture');
      insertEvidence.run(
        `${relationId}:evidence`,
        relationId,
        repo.id,
        `rank-fixture/${relationId}.ts`,
        evidenceKind,
        snippet,
        run.id
      );
    };

    for (const [id, displayName] of [
      ['file:rank/relation-a.ts', 'A relation only'],
      ['file:rank/relation-b.ts', 'B relation only'],
      ['file:rank/fused.ts', 'M fused winner'],
      ['file:rank/evidence-a.ts', 'A evidence only'],
      ['file:rank/evidence-b.ts', 'B evidence only']
    ] as const) {
      addEntity(id, displayName);
    }
    addRelation('file:rank/relation-a.ts', 'rank:relation-a', 'FUSION_NEEDLE', 'plain', 'plain relation-only snippet');
    addRelation('file:rank/relation-b.ts', 'rank:relation-b', 'FUSION_NEEDLE', 'plain', 'plain relation-only snippet');
    addRelation('file:rank/fused.ts', 'rank:fused', 'FUSION_NEEDLE', 'FUSION_NEEDLE', 'fusion_needle evidence snippet');
    addRelation('file:rank/evidence-a.ts', 'rank:evidence-a', 'plain', 'FUSION_NEEDLE', 'fusion_needle evidence snippet');
    addRelation('file:rank/evidence-b.ts', 'rank:evidence-b', 'plain', 'FUSION_NEEDLE', 'fusion_needle evidence snippet');

    for (const [id, displayName] of [
      ['file:rank/tie-z-alpha.ts', 'Alpha tie candidate'],
      ['file:rank/tie-a-beta.ts', 'Beta tie candidate'],
      ['file:rank/tie-id-a.ts', 'Same tie candidate'],
      ['file:rank/tie-id-b-ENTITY_ID_ONLY_MARKER.ts', 'Same tie candidate']
    ] as const) {
      addEntity(id, displayName);
    }
    addRelation(
      'file:rank/tie-z-alpha.ts',
      'rank:tie-alpha',
      'DISPLAY_TIE_MARKER',
      'plain',
      'plain display tie snippet'
    );
    addRelation(
      'file:rank/tie-a-beta.ts',
      'rank:tie-beta',
      'plain',
      'DISPLAY_TIE_MARKER',
      'display tie evidence snippet'
    );
    addRelation(
      'file:rank/tie-id-a.ts',
      'rank:tie-id-a',
      'ENTITY_ID_ONLY_MARKER',
      'plain',
      'plain id tie snippet'
    );

    const rawRrfNeedle = 'RAW_RRF_NEEDLE';
    const rawWinnerId = 'file:rank/raw-rrf-winner.ts';
    const roundedTrapId = 'file:rank/raw-rrf-rounded-trap.ts';

    for (let index = 0; index < 26; index += 1) {
      const suffix = index.toString().padStart(3, '0');
      addEntity(
        `file:rank/raw-keyword-before-${suffix}.ts`,
        `Raw RRF keyword filler ${suffix}`,
        `raw-rrf/${rawRrfNeedle}/keyword-before-${suffix}`
      );
    }
    addEntity(rawWinnerId, 'Z raw RRF winner', `raw-rrf/${rawRrfNeedle}/winner`);
    for (let index = 0; index < 10; index += 1) {
      const suffix = index.toString().padStart(3, '0');
      addEntity(
        `file:rank/raw-keyword-after-${suffix}.ts`,
        `ZZ raw RRF keyword filler ${suffix}`,
        `raw-rrf/${rawRrfNeedle}/keyword-after-${suffix}`
      );
    }
    addEntity(roundedTrapId, `A rounded RRF trap ${rawRrfNeedle}`);

    for (let index = 0; index < 34; index += 1) {
      const suffix = index.toString().padStart(3, '0');
      const relationId = `rank:raw-relation-before-${suffix}`;
      const entityId = `file:rank/raw-relation-before-${suffix}.ts`;
      addEntity(entityId, `000 raw RRF relation filler ${suffix}`);
      addRelation(entityId, relationId, rawRrfNeedle, 'plain', 'plain raw relation filler snippet');
    }
    addRelation(roundedTrapId, 'rank:raw-rounded-trap-relation', rawRrfNeedle, rawRrfNeedle, 'raw RRF trap evidence');
    addRelation(rawWinnerId, 'rank:raw-winner-relation', rawRrfNeedle, rawRrfNeedle, 'raw RRF winner evidence');

    for (let index = 0; index < 34; index += 1) {
      const suffix = index.toString().padStart(3, '0');
      const relationId = `rank:raw-evidence-before-${suffix}`;
      const entityId = `file:rank/raw-evidence-before-${suffix}.ts`;
      addEntity(entityId, `000 raw RRF evidence filler ${suffix}`);
      addRelation(entityId, relationId, 'plain', rawRrfNeedle, 'raw RRF evidence filler snippet');
    }
    for (let index = 0; index < 11; index += 1) {
      const suffix = index.toString().padStart(3, '0');
      const relationId = `rank:raw-evidence-middle-${suffix}`;
      const entityId = `file:rank/raw-evidence-middle-${suffix}.ts`;
      addEntity(entityId, `M raw RRF evidence filler ${suffix}`);
      addRelation(entityId, relationId, 'plain', rawRrfNeedle, 'raw RRF evidence middle snippet');
    }
  } finally {
    db.close();
  }
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

type ContextToolRunRow = {
  tool_name: string;
  index_run_id: number | null;
  budget: string | null;
  query: string | null;
  changed_files_json: string;
  returned_bytes: number;
  resource_count: number;
  omitted_json: string;
};

function contextToolRuns(repoRoot: string): ContextToolRunRow[] {
  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    return db
      .prepare(`
        SELECT tool_name, index_run_id, budget, query, changed_files_json, returned_bytes, resource_count, omitted_json
        FROM context_tool_runs
        ORDER BY started_at, id
      `)
      .all() as ContextToolRunRow[];
  } finally {
    db.close();
  }
}

type ContextResourceAccessRow = {
  uri: string;
  resource_kind: string;
  resource_id: string | null;
  index_run_id: number | null;
  returned_bytes: number;
};

function contextResourceAccesses(repoRoot: string): ContextResourceAccessRow[] {
  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    return db
      .prepare(`
        SELECT uri, resource_kind, resource_id, index_run_id, returned_bytes
        FROM context_resource_accesses
        ORDER BY accessed_at, id
      `)
      .all() as ContextResourceAccessRow[];
  } finally {
    db.close();
  }
}

function removeTelemetrySchema(repoRoot: string): void {
  const db = new DatabaseSync(databasePath(repoRoot));
  try {
    db.prepare('DROP TABLE IF EXISTS context_tool_runs').run();
    db.prepare('DROP TABLE IF EXISTS context_resource_accesses').run();
    db.prepare('DELETE FROM schema_versions WHERE version = 10').run();
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
    const toolByName = new Map<string, { name: string; annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean } }>(
      (response.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean } }>).map((tool) => [tool.name, tool])
    );
    for (const expected of [
      'impact_trace_analyze_diff',
      'impact_trace_context_for_change',
      'impact_trace_search_context',
      'impact_trace_remember',
      'impact_trace_recall',
      'impact_trace_branch',
      'impact_trace_merge',
      'impact_trace_trace',
      'impact_trace_reflect',
      'impact_trace_abandon_branch',
      'impact_trace_gc_branches',
      'impact_trace_profile',
      'impact_trace_explain_entity',
      'impact_trace_repair_reflections',
      'impact_trace_restore_branch',
      'impact_trace_context_telemetry'
    ]) {
      assert.ok(toolByName.has(expected), `expected MCP tool ${expected} to be advertised`);
    }
    assert.equal(toolByName.get('impact_trace_analyze_diff')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('impact_trace_context_for_change')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('impact_trace_search_context')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('impact_trace_analyze_diff')!.annotations?.idempotentHint, false);
    assert.equal(toolByName.get('impact_trace_context_for_change')!.annotations?.idempotentHint, false);
    assert.equal(toolByName.get('impact_trace_search_context')!.annotations?.idempotentHint, false);
    assert.equal(toolByName.get('impact_trace_recall')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('impact_trace_trace')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('impact_trace_profile')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('impact_trace_explain_entity')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('impact_trace_explain_entity')!.annotations?.idempotentHint, false);
    assert.equal(toolByName.get('impact_trace_context_telemetry')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('impact_trace_context_telemetry')!.annotations?.idempotentHint, true);
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
      indexRunId: number;
      changed: Array<{ entity: { id: string }; resourceUri: string }>;
      context: Array<{ path: string; resourceUri: string; relations: string[] }>;
      evidence: Array<{ id: string; snippet: string; file: string; resourceUri?: string }>;
      resources: { coverage: string; entities: string[]; evidence: string[] };
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
    assert.ok(pack.resources.evidence.length > 0);
    assert.ok(pack.evidence.some((item) => item.resourceUri));
    assert.ok(pack.evidence.every((item) =>
      item.resourceUri === undefined || item.resourceUri === `impact-trace://evidence/${encodeURIComponent(item.id)}`
    ));
    assert.equal(pack.resources.coverage, 'impact-trace://coverage/latest');
    assert.ok(pack.resources.entities.includes(`impact-trace://entities/${encodeURIComponent('file:src/a.ts')}`));
    assert.ok(pack.resources.evidence.every((uri) =>
      pack.evidence.some((item) => item.resourceUri === uri)
    ));
    for (const uri of pack.resources.evidence) {
      const evidenceResource = await client.request('resources/read', { uri });
      assert.equal(evidenceResource.error, undefined);
      const evidenceJson = JSON.parse(evidenceResource.result.contents[0].text) as { id: string };
      assert.ok(pack.evidence.some((item) => item.id === evidenceJson.id));
    }
    const telemetryRuns = contextToolRuns(repoRoot);
    assert.equal(telemetryRuns.length, 1);
    assert.equal(telemetryRuns[0]!.tool_name, 'impact_trace_context_for_change');
    assert.equal(telemetryRuns[0]!.budget, 'brief');
    assert.equal(telemetryRuns[0]!.query, null);
    assert.deepEqual(JSON.parse(telemetryRuns[0]!.changed_files_json), ['src/a.ts']);
    assert.equal(telemetryRuns[0]!.index_run_id, pack.indexRunId);
    assert.ok(telemetryRuns[0]!.returned_bytes > 0);
    assert.equal(telemetryRuns[0]!.resource_count, pack.resources.entities.length + pack.resources.evidence.length + 1);
    assert.deepEqual(JSON.parse(telemetryRuns[0]!.omitted_json), pack.omittedCounts);
    const telemetryAccesses = contextResourceAccesses(repoRoot);
    assert.equal(telemetryAccesses.length, pack.resources.evidence.length);
    assert.ok(telemetryAccesses.every((item) => item.resource_kind === 'evidence'));
    assert.ok(telemetryAccesses.every((item) => item.index_run_id === pack.indexRunId));
    assert.ok(telemetryAccesses.every((item) => item.returned_bytes > 0));
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

test('MCP context telemetry summarizes tool runs and resource reads', async () => {
  const repoRoot = await makeWideContextRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const searchResponse = await client.request('tools/call', {
      name: 'impact_trace_search_context',
      arguments: { query: 'DEPENDS_ON', k: 3 }
    });
    assert.equal(searchResponse.error, undefined);
    const search = JSON.parse(searchResponse.result.content[0].text) as {
      indexRunId: number;
      resources: { entities: string[]; evidence: string[] };
    };
    assert.ok(search.resources.evidence.length > 0);

    const evidenceUri = search.resources.evidence[0]!;
    const evidenceResponse = await client.request('resources/read', { uri: evidenceUri });
    assert.equal(evidenceResponse.error, undefined);

    const telemetryResponse = await client.request('tools/call', {
      name: 'impact_trace_context_telemetry',
      arguments: { limit: 10 }
    });
    assert.equal(telemetryResponse.error, undefined);
    assert.equal(telemetryResponse.result.isError, undefined);
    const telemetry = JSON.parse(telemetryResponse.result.content[0].text) as {
      version: number;
      summary: {
        toolRuns: number;
        resourceAccesses: number;
        returnedBytes: number;
        resourcesAdvertised: number;
      };
      toolRuns: Array<{
        toolName: string;
        indexRunId: number | null;
        query: string | null;
        changedFiles: string[];
        returnedBytes: number;
        resourceCount: number;
      }>;
      resourceAccesses: Array<{
        uri: string;
        resourceKind: string;
        resourceId: string | null;
        indexRunId: number | null;
        returnedBytes: number;
      }>;
    };

    assert.equal(telemetry.version, 0);
    assert.equal(telemetry.summary.toolRuns, 1);
    assert.equal(telemetry.summary.resourceAccesses, 1);
    assert.ok(telemetry.summary.returnedBytes > 0);
    assert.equal(telemetry.summary.resourcesAdvertised, search.resources.entities.length + search.resources.evidence.length);
    assert.equal(telemetry.toolRuns[0]!.toolName, 'impact_trace_search_context');
    assert.equal(telemetry.toolRuns[0]!.query, 'DEPENDS_ON');
    assert.deepEqual(telemetry.toolRuns[0]!.changedFiles, []);
    assert.equal(telemetry.toolRuns[0]!.indexRunId, search.indexRunId);
    assert.equal(telemetry.toolRuns[0]!.resourceCount, search.resources.entities.length + search.resources.evidence.length);
    assert.equal(telemetry.resourceAccesses[0]!.uri, evidenceUri);
    assert.equal(telemetry.resourceAccesses[0]!.resourceKind, 'evidence');
    assert.ok(telemetry.resourceAccesses[0]!.resourceId);
    assert.equal(telemetry.resourceAccesses[0]!.indexRunId, search.indexRunId);
    assert.ok(telemetry.resourceAccesses[0]!.returnedBytes > 0);
  } finally {
    await client.close();
  }
});

test('MCP context telemetry records analyze, explain, resource kinds, and redacted queries', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const analyzeResponse = await client.request('tools/call', {
      name: 'impact_trace_analyze_diff',
      arguments: { changedFiles: ['src/a.ts'] }
    });
    assert.equal(analyzeResponse.error, undefined);

    const explainResponse = await client.request('tools/call', {
      name: 'impact_trace_explain_entity',
      arguments: { entity: 'file:src/a.ts', evidenceLimit: 1 }
    });
    assert.equal(explainResponse.error, undefined);

    const secretSearchResponse = await client.request('tools/call', {
      name: 'impact_trace_search_context',
      arguments: { query: 'sk-12345678901234567890', includeEvidence: false }
    });
    assert.equal(secretSearchResponse.error, undefined);

    const entityResource = await client.request('resources/read', {
      uri: `impact-trace://entities/${encodeURIComponent('file:src/a.ts')}`
    });
    assert.equal(entityResource.error, undefined);

    const coverageResource = await client.request('resources/read', {
      uri: 'impact-trace://coverage/latest'
    });
    assert.equal(coverageResource.error, undefined);

    const telemetryResponse = await client.request('tools/call', {
      name: 'impact_trace_context_telemetry',
      arguments: { limit: 10 }
    });
    assert.equal(telemetryResponse.error, undefined);
    const telemetry = JSON.parse(telemetryResponse.result.content[0].text) as {
      summary: { toolRuns: number; resourceAccesses: number };
      toolRuns: Array<{ toolName: string; query: string | null; changedFiles: string[]; resourceCount: number }>;
      resourceAccesses: Array<{ resourceKind: string; resourceId: string | null; returnedBytes: number }>;
    };

    assert.equal(telemetry.summary.toolRuns, 3);
    assert.equal(telemetry.summary.resourceAccesses, 2);
    const toolByName = new Map(telemetry.toolRuns.map((item) => [item.toolName, item]));
    assert.deepEqual(toolByName.get('impact_trace_analyze_diff')!.changedFiles, ['src/a.ts']);
    assert.equal(toolByName.get('impact_trace_explain_entity')!.query, 'file:src/a.ts');
    assert.ok(toolByName.get('impact_trace_explain_entity')!.resourceCount > 0);
    assert.equal(toolByName.get('impact_trace_search_context')!.query, '[REDACTED_OPENAI_KEY]');
    const resourceKinds = new Set(telemetry.resourceAccesses.map((item) => item.resourceKind));
    assert.ok(resourceKinds.has('entity'));
    assert.ok(resourceKinds.has('coverage'));
    assert.ok(telemetry.resourceAccesses.every((item) => item.returnedBytes > 0));
    assert.equal(countReports(repoRoot), 0);
  } finally {
    await client.close();
  }
});

test('MCP context telemetry redacts changed file paths before storage', async () => {
  const { repoRoot, secretPath } = await makeSecretPathRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'impact_trace_analyze_diff',
      arguments: { changedFiles: [secretPath] }
    });
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);

    const runs = contextToolRuns(repoRoot);
    assert.equal(runs.length, 1);
    const changedFiles = JSON.parse(runs[0]!.changed_files_json) as string[];
    assert.deepEqual(changedFiles, ['src/[REDACTED_OPENAI_KEY].ts']);
    assert.equal(runs[0]!.changed_files_json.includes('sk-12345678901234567890'), false);
  } finally {
    await client.close();
  }
});

test('MCP context telemetry redacts resource uri and id before storage', async () => {
  const { repoRoot, secretPath } = await makeSecretPathRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const uri = `impact-trace://entities/${encodeURIComponent(`file:${secretPath}`)}`;
    const response = await client.request('resources/read', { uri });
    assert.equal(response.error, undefined);

    const accesses = contextResourceAccesses(repoRoot);
    assert.equal(accesses.length, 1);
    assert.equal(accesses[0]!.resource_kind, 'entity');
    assert.equal(accesses[0]!.uri.includes('sk-12345678901234567890'), false);
    assert.equal(accesses[0]!.resource_id?.includes('sk-12345678901234567890'), false);
    assert.ok(accesses[0]!.uri.includes('[REDACTED_OPENAI_KEY]'));
    assert.equal(accesses[0]!.resource_id, 'file:src/[REDACTED_OPENAI_KEY].ts');
  } finally {
    await client.close();
  }
});

test('MCP context telemetry returns empty rows on pre-v10 databases', async () => {
  const repoRoot = await makeRepo();
  removeTelemetrySchema(repoRoot);
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'impact_trace_context_telemetry',
      arguments: { limit: 5 }
    });
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const telemetry = JSON.parse(response.result.content[0].text) as {
      summary: { toolRuns: number; resourceAccesses: number; returnedBytes: number; resourcesAdvertised: number };
      toolRuns: unknown[];
      resourceAccesses: unknown[];
    };
    assert.deepEqual(telemetry.summary, {
      toolRuns: 0,
      resourceAccesses: 0,
      returnedBytes: 0,
      resourcesAdvertised: 0
    });
    assert.deepEqual(telemetry.toolRuns, []);
    assert.deepEqual(telemetry.resourceAccesses, []);
  } finally {
    await client.close();
  }
});

test('MCP context telemetry failures do not fail primary tool or resource responses', async () => {
  const repoRoot = await makeRepo();
  const previous = process.env.IMPACT_TRACE_TELEMETRY_FORCE_FAILURE;
  process.env.IMPACT_TRACE_TELEMETRY_FORCE_FAILURE = '1';
  const client = new McpProcessClient(repoRoot);
  if (previous === undefined) {
    delete process.env.IMPACT_TRACE_TELEMETRY_FORCE_FAILURE;
  } else {
    process.env.IMPACT_TRACE_TELEMETRY_FORCE_FAILURE = previous;
  }
  try {
    await client.initialize();

    const searchResponse = await client.request('tools/call', {
      name: 'impact_trace_search_context',
      arguments: { query: 'src/a.ts', includeEvidence: false }
    });
    assert.equal(searchResponse.error, undefined);
    assert.equal(searchResponse.result.isError, undefined);
    const search = JSON.parse(searchResponse.result.content[0].text) as { results: Array<{ entity: { id: string } }> };
    assert.ok(search.results.some((item) => item.entity.id === 'file:src/a.ts'));

    const entityResponse = await client.request('resources/read', {
      uri: `impact-trace://entities/${encodeURIComponent('file:src/a.ts')}`
    });
    assert.equal(entityResponse.error, undefined);
    const entity = JSON.parse(entityResponse.result.contents[0].text) as { entity: { id: string } };
    assert.equal(entity.entity.id, 'file:src/a.ts');
    assert.deepEqual(contextToolRuns(repoRoot), []);
    assert.deepEqual(contextResourceAccesses(repoRoot), []);
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

test('MCP search_context returns ranked entities with optional evidence links', async () => {
  const repoRoot = await makeWideContextRepo();
  const artifactsBefore = dbArtifacts(repoRoot);
  assert.equal(countReports(repoRoot), 0);
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'impact_trace_search_context',
      arguments: { query: 'src/a.ts', k: 1 }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const search = JSON.parse(response.result.content[0].text) as {
      query: string;
      results: Array<{
        entity: { id: string; path?: string };
        score: number;
        reasons: string[];
        resourceUri: string;
        evidence: Array<{ id: string; snippet: string; resourceUri: string }>;
        rankSignals: {
          algorithm: 'rrf';
          keywordRank: number | null;
          relationRank: number | null;
          evidenceRank: number | null;
          rrfScore: number;
        };
      }>;
      resources: { entities: string[]; evidence: string[] };
      limits: { k: number; includeEvidence: boolean; evidencePerEntity: number; snippetChars: number; truncated: boolean };
      counts: { returnedEntities: number; evidence: number };
    };
    assert.equal(search.query, 'src/a.ts');
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0]!.entity.id, 'file:src/a.ts');
    assert.equal(search.results[0]!.resourceUri, `impact-trace://entities/${encodeURIComponent('file:src/a.ts')}`);
    assert.ok(search.results[0]!.score > 0);
    assert.equal(search.results[0]!.score, search.results[0]!.rankSignals.rrfScore);
    assert.equal(search.results[0]!.rankSignals.algorithm, 'rrf');
    assert.equal(search.results[0]!.rankSignals.keywordRank, 1);
    assert.equal(search.results[0]!.rankSignals.relationRank, null);
    assert.equal(search.results[0]!.rankSignals.evidenceRank, 1);
    assert.ok(search.results[0]!.rankSignals.rrfScore > 0);
    assert.ok(search.results[0]!.reasons.includes('entity-id'));
    assert.ok(search.results[0]!.reasons.includes('path'));
    assert.deepEqual(search.resources.entities, [search.results[0]!.resourceUri]);
    assert.equal(search.limits.k, 1);
    assert.equal(search.limits.includeEvidence, true);
    assert.equal(search.limits.evidencePerEntity, 2);
    assert.equal(search.limits.snippetChars, 240);
    assert.equal(search.limits.truncated, true);
    assert.ok(search.resources.evidence.length > 0);
    assert.ok(search.results[0]!.evidence.every((item) => item.snippet.length <= search.limits.snippetChars));
    for (const uri of search.resources.evidence) {
      const evidenceResource = await client.request('resources/read', { uri });
      assert.equal(evidenceResource.error, undefined);
      const evidenceJson = JSON.parse(evidenceResource.result.contents[0].text) as { id: string };
      assert.ok(search.results[0]!.evidence.some((item) => item.id === evidenceJson.id));
    }

    const relationResponse = await client.request('tools/call', {
      name: 'impact_trace_search_context',
      arguments: { query: 'DEPENDS_ON', k: 3 }
    });
    assert.equal(relationResponse.error, undefined);
    assert.equal(relationResponse.result.isError, undefined);
    const relationSearch = JSON.parse(relationResponse.result.content[0].text) as {
      results: Array<{
        entity: { id: string };
        evidence: Array<{ id: string; snippet: string; resourceUri: string }>;
        rankSignals: {
          algorithm: 'rrf';
          keywordRank: number | null;
          relationRank: number | null;
          evidenceRank: number | null;
          rrfScore: number;
        };
      }>;
      resources: { evidence: string[] };
      counts: { evidence: number };
    };
    assert.ok(relationSearch.results.length > 0);
    assert.ok(relationSearch.results.some((item) => item.rankSignals.relationRank !== null));
    assert.ok(relationSearch.results.some((item) => item.rankSignals.evidenceRank !== null));
    assert.ok(relationSearch.resources.evidence.length > 0);
    assert.equal(relationSearch.counts.evidence, relationSearch.resources.evidence.length);
    assert.ok(
      relationSearch.results
        .flatMap((item) => item.evidence)
        .every((item) => relationSearch.resources.evidence.includes(item.resourceUri))
    );

    const noEvidence = await client.request('tools/call', {
      name: 'impact_trace_search_context',
      arguments: { query: 'docs/a.md', k: 5, includeEvidence: false }
    });
    assert.equal(noEvidence.error, undefined);
    const noEvidenceSearch = JSON.parse(noEvidence.result.content[0].text) as {
      results: Array<{ evidence: unknown[] }>;
      resources: { evidence: string[] };
      limits: { includeEvidence: boolean };
    };
    assert.equal(noEvidenceSearch.limits.includeEvidence, false);
    assert.deepEqual(noEvidenceSearch.resources.evidence, []);
    assert.ok(noEvidenceSearch.results.every((item) => item.evidence.length === 0));

    const blank = await client.request('tools/call', {
      name: 'impact_trace_search_context',
      arguments: { query: '   ' }
    });
    assert.equal(blank.error, undefined);
    assert.equal(blank.result.isError, true);
    assert.match(blank.result.content[0].text, /Too small|must not be empty/i);

    assert.equal(countReports(repoRoot), 0);
    const filterWalAux = (names: string[]): string[] =>
      names.filter((name) => !/\.db-(wal|shm)$/.test(name));
    assert.deepEqual(filterWalAux(dbArtifacts(repoRoot)), filterWalAux(artifactsBefore));
    assert.equal(existsSync(path.join(repoRoot, '.impact-trace/reports')), false);
  } finally {
    await client.close();
  }
});

test('MCP search_context treats LIKE wildcard characters as literal query text', async () => {
  const repoRoot = await makeSearchEscapingRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    for (const [query, expectedLiteral] of [
      ['%', '%'],
      ['_', '_'],
      ['\\', '\\']
    ] as const) {
      const response = await client.request('tools/call', {
        name: 'impact_trace_search_context',
        arguments: { query, k: 20, includeEvidence: false }
      });

      assert.equal(response.error, undefined);
      assert.equal(response.result.isError, undefined);
      const search = JSON.parse(response.result.content[0].text) as {
        results: Array<{ entity: { id: string; path?: string; displayName?: string } }>;
      };
      assert.ok(search.results.length > 0, `expected literal search for ${query} to find fixture rows`);
      assert.ok(
        search.results.every((item) =>
          `${item.entity.id} ${item.entity.path ?? ''} ${item.entity.displayName ?? ''}`.includes(expectedLiteral)
        ),
        `expected ${query} to match only entities containing the literal character`
      );
      assert.equal(
        search.results.some((item) => item.entity.id === 'file:src/plain.ts'),
        false,
        `expected ${query} not to behave like a wildcard that returns plain.ts`
      );
    }
  } finally {
    await client.close();
  }
});

test('MCP search_context fuses beyond the first page of each RRF stream', async () => {
  const repoRoot = await makeSearchRankingRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'impact_trace_search_context',
      arguments: { query: 'FUSION_NEEDLE', k: 1, includeEvidence: false }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const search = JSON.parse(response.result.content[0].text) as {
      results: Array<{
        entity: { id: string };
        rankSignals: {
          keywordRank: number | null;
          relationRank: number | null;
          evidenceRank: number | null;
          rrfScore: number;
        };
      }>;
      limits: { truncated: boolean };
      counts: { matchedEntitiesLowerBound: number };
    };
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0]!.entity.id, 'file:rank/fused.ts');
    assert.equal(search.results[0]!.rankSignals.keywordRank, null);
    assert.equal(search.results[0]!.rankSignals.relationRank, 3);
    assert.equal(search.results[0]!.rankSignals.evidenceRank, 3);
    assert.equal(search.limits.truncated, true);
    assert.ok(search.counts.matchedEntitiesLowerBound >= 5);
  } finally {
    await client.close();
  }
});

test('MCP search_context orders equal RRF scores by display name then entity id', async () => {
  const repoRoot = await makeSearchRankingRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const displayTieResponse = await client.request('tools/call', {
      name: 'impact_trace_search_context',
      arguments: { query: 'DISPLAY_TIE_MARKER', k: 2, includeEvidence: false }
    });
    assert.equal(displayTieResponse.error, undefined);
    assert.equal(displayTieResponse.result.isError, undefined);
    const displayTie = JSON.parse(displayTieResponse.result.content[0].text) as {
      results: Array<{ entity: { id: string; displayName: string }; score: number }>;
    };
    assert.deepEqual(
      displayTie.results.map((item) => item.entity.id),
      ['file:rank/tie-z-alpha.ts', 'file:rank/tie-a-beta.ts']
    );
    assert.equal(displayTie.results[0]!.score, displayTie.results[1]!.score);
    assert.ok(displayTie.results[0]!.entity.displayName < displayTie.results[1]!.entity.displayName);
    assert.ok(displayTie.results[0]!.entity.id > displayTie.results[1]!.entity.id);

    const idTieResponse = await client.request('tools/call', {
      name: 'impact_trace_search_context',
      arguments: { query: 'ENTITY_ID_ONLY_MARKER', k: 2, includeEvidence: false }
    });
    assert.equal(idTieResponse.error, undefined);
    assert.equal(idTieResponse.result.isError, undefined);
    const idTie = JSON.parse(idTieResponse.result.content[0].text) as {
      results: Array<{ entity: { id: string; displayName: string }; score: number }>;
    };
    assert.deepEqual(
      idTie.results.map((item) => item.entity.id),
      ['file:rank/tie-id-a.ts', 'file:rank/tie-id-b-ENTITY_ID_ONLY_MARKER.ts']
    );
    assert.equal(idTie.results[0]!.score, idTie.results[1]!.score);
    assert.equal(idTie.results[0]!.entity.displayName, idTie.results[1]!.entity.displayName);
    assert.ok(idTie.results[0]!.entity.id < idTie.results[1]!.entity.id);
  } finally {
    await client.close();
  }
});

test('MCP search_context orders by raw RRF before rounded presentation score', async () => {
  const repoRoot = await makeSearchRankingRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'impact_trace_search_context',
      arguments: { query: 'RAW_RRF_NEEDLE', k: 2, includeEvidence: false }
    });
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const search = JSON.parse(response.result.content[0].text) as {
      results: Array<{
        entity: { id: string; displayName: string };
        score: number;
        rankSignals: {
          keywordRank: number | null;
          relationRank: number | null;
          evidenceRank: number | null;
          rrfScore: number;
        };
      }>;
    };

    assert.deepEqual(
      search.results.map((item) => item.entity.id),
      ['file:rank/raw-rrf-winner.ts', 'file:rank/raw-rrf-rounded-trap.ts']
    );
    assert.ok(search.results[0]!.entity.displayName > search.results[1]!.entity.displayName);
    assert.equal(search.results[0]!.score, search.results[1]!.score);
    assert.equal(search.results[0]!.rankSignals.rrfScore, search.results[1]!.rankSignals.rrfScore);
    assert.deepEqual(search.results[0]!.rankSignals, {
      algorithm: 'rrf',
      keywordRank: 27,
      relationRank: 36,
      evidenceRank: 47,
      rrfScore: search.results[0]!.rankSignals.rrfScore
    });
    assert.deepEqual(search.results[1]!.rankSignals, {
      algorithm: 'rrf',
      keywordRank: 38,
      relationRank: 35,
      evidenceRank: 35,
      rrfScore: search.results[1]!.rankSignals.rrfScore
    });
  } finally {
    await client.close();
  }
});

test('MCP search_context ignores entities from newer failed index runs', async () => {
  const repoRoot = await makeRepo();
  let completedRunId = 0;
  let failedRunId = 0;
  const db = new DatabaseSync(databasePath(repoRoot));
  try {
    const repo = db.prepare('SELECT id FROM repos LIMIT 1').get() as { id: number };
    const completedRun = db
      .prepare('SELECT id FROM index_runs WHERE repo_id = ? AND status = ? ORDER BY id DESC LIMIT 1')
      .get(repo.id, 'completed') as { id: number };
    completedRunId = completedRun.id;
    failedRunId = Number(
      db
        .prepare(`
          INSERT INTO index_runs (repo_id, status, started_at, finished_at, extractor_version)
          VALUES (?, 'failed', datetime('now'), datetime('now'), 'failed-search-test')
        `)
        .run(repo.id).lastInsertRowid
    );
    db
      .prepare(`
        INSERT INTO entities (
          id, repo_id, kind, path, symbol, language_id, display_name,
          created_index_run_id, updated_index_run_id
        )
        VALUES (?, ?, 'file', ?, NULL, 'typescript', ?, ?, ?)
      `)
      .run(
        'file:src/failed-only.ts',
        repo.id,
        'src/failed-only.ts',
        'src/failed-only.ts',
        failedRunId,
        failedRunId
      );
  } finally {
    db.close();
  }

  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const failedOnly = await client.request('tools/call', {
      name: 'impact_trace_search_context',
      arguments: { query: 'failed-only', k: 10 }
    });
    assert.equal(failedOnly.error, undefined);
    const failedOnlySearch = JSON.parse(failedOnly.result.content[0].text) as {
      indexRunId: number;
      results: Array<{ entity: { id: string } }>;
    };
    assert.equal(failedOnlySearch.indexRunId, completedRunId);
    assert.notEqual(failedOnlySearch.indexRunId, failedRunId);
    assert.deepEqual(failedOnlySearch.results, []);

    const completed = await client.request('tools/call', {
      name: 'impact_trace_search_context',
      arguments: { query: 'src/a.ts', k: 10 }
    });
    const completedSearch = JSON.parse(completed.result.content[0].text) as {
      indexRunId: number;
      results: Array<{ entity: { id: string } }>;
    };
    assert.equal(completedSearch.indexRunId, completedRunId);
    assert.ok(completedSearch.results.some((item) => item.entity.id === 'file:src/a.ts'));
  } finally {
    await client.close();
  }
});

test('MCP exposes report, entity, evidence, graph, and coverage resources', async () => {
  const repoRoot = await makeRepo();
  const report = await analyzeDiff({ repoRoot, changedFiles: ['src/a.ts'] });
  const evidence = report.evidence.find((item) => item.relationKind);
  assert.ok(evidence, 'fixture should produce relation evidence');
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const templates = await client.request('resources/templates/list', {});
    assert.equal(templates.error, undefined);
    const templateUris = templates.result.resourceTemplates.map((item: { uriTemplate: string }) => item.uriTemplate);
    assert.ok(templateUris.includes('impact-trace://reports/{reportId}'));
    assert.ok(templateUris.includes('impact-trace://entities/{entityId}'));
    assert.ok(templateUris.includes('impact-trace://evidence/{evidenceId}'));
    assert.ok(templateUris.includes('impact-trace://reports/{reportId}/graph/{format}'));

    const resources = await client.request('resources/list', {});
    assert.equal(resources.error, undefined);
    const resourceUris = resources.result.resources.map((item: { uri: string }) => item.uri);
    assert.ok(resourceUris.includes(`impact-trace://reports/${report.id}`));
    assert.ok(resourceUris.includes(`impact-trace://evidence/${encodeURIComponent(evidence.id)}`));
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

    const evidenceResource = await client.request('resources/read', {
      uri: `impact-trace://evidence/${encodeURIComponent(evidence.id)}`
    });
    assert.equal(evidenceResource.error, undefined);
    const evidenceJson = JSON.parse(evidenceResource.result.contents[0].text) as {
      id: string;
      snippet: string;
      file: string;
      relation: { id: string; kind: string; confidence: string; provenance: string };
      sourceEntity: { id: string } | null;
      targetEntity: { id: string } | null;
      indexRunId: number;
    };
    assert.equal(evidenceJson.id, evidence.id);
    assert.equal(evidenceJson.file, evidence.file);
    assert.equal(evidenceJson.snippet.includes('SECRET_ACCESS_TOKEN'), false);
    assert.equal(evidenceJson.relation.kind, evidence.relationKind);
    assert.ok(evidenceJson.relation.provenance.length > 0);
    assert.ok(evidenceJson.sourceEntity?.id);
    assert.ok(evidenceJson.targetEntity?.id);
    assert.equal(evidenceJson.indexRunId, report.indexRunId);

    const missingEvidence = await client.request('resources/read', {
      uri: 'impact-trace://evidence/not-found'
    });
    assert.ok(missingEvidence.error);
    assert.match(missingEvidence.error.message, /impact evidence not found/);

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

test('MCP explain_entity returns capped relation context with resolvable evidence links', async () => {
  const repoRoot = await makeWideContextRepo();
  const artifactsBefore = dbArtifacts(repoRoot);
  assert.equal(countReports(repoRoot), 0);
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();
    const response = await client.request('tools/call', {
      name: 'impact_trace_explain_entity',
      arguments: {
        entity: 'file:src/a.ts',
        relationLimit: 2,
        evidenceLimit: 2
      }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const explanation = JSON.parse(response.result.content[0].text) as {
      entity: { id: string };
      relations: {
        incoming: Array<{ id: string; evidence: Array<{ id: string; snippet: string; resourceUri: string }> }>;
        outgoing: Array<{ id: string; evidence: Array<{ id: string; snippet: string; resourceUri: string }> }>;
      };
      resources: { entity: string; evidence: string[] };
      limits: {
        relationLimit: number;
        evidenceLimit: number;
        snippetChars: number;
        incomingTruncated: boolean;
        evidenceTruncated: boolean;
      };
      counts: { incoming: number; evidence: number };
    };
    assert.equal(explanation.entity.id, 'file:src/a.ts');
    assert.equal(explanation.resources.entity, `impact-trace://entities/${encodeURIComponent('file:src/a.ts')}`);
    assert.equal(explanation.relations.incoming.length, 2);
    assert.equal(explanation.limits.relationLimit, 2);
    assert.equal(explanation.limits.evidenceLimit, 2);
    assert.equal(explanation.limits.incomingTruncated, true);
    assert.equal(explanation.limits.evidenceTruncated, true);
    assert.ok(explanation.counts.incoming > explanation.relations.incoming.length);
    assert.ok(explanation.counts.evidence > explanation.resources.evidence.length);
    assert.equal(explanation.resources.evidence.length, 2);
    assert.ok(
      [...explanation.relations.incoming, ...explanation.relations.outgoing]
        .flatMap((relation) => relation.evidence)
        .every((item) => item.snippet.length <= explanation.limits.snippetChars)
    );
    for (const uri of explanation.resources.evidence) {
      const evidenceResource = await client.request('resources/read', { uri });
      assert.equal(evidenceResource.error, undefined);
      const evidenceJson = JSON.parse(evidenceResource.result.contents[0].text) as { id: string };
      assert.ok(
        [...explanation.relations.incoming, ...explanation.relations.outgoing]
          .flatMap((relation) => relation.evidence)
          .some((item) => item.id === evidenceJson.id)
      );
    }
    assert.equal(countReports(repoRoot), 0);
    const filterWalAux = (names: string[]): string[] =>
      names.filter((name) => !/\.db-(wal|shm)$/.test(name));
    assert.deepEqual(filterWalAux(dbArtifacts(repoRoot)), filterWalAux(artifactsBefore));

    const missing = await client.request('tools/call', {
      name: 'impact_trace_explain_entity',
      arguments: { entity: 'file:missing.ts' }
    });
    assert.equal(missing.error, undefined);
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /impact entity not found/);
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
