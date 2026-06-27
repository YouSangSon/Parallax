import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  addWorkspaceRepo,
  analyzeDiff,
  indexProject,
  initProject,
  initWorkspace,
  resolveCrossRepoContracts,
  workspaceCatalogPath
} from '../src/index.js';
import { computeEmbeddingSync, STUB_MODEL_NAME } from '../src/embeddings.js';
import {
  databasePath,
  ensureVecTable,
  hasVecTable,
  isVectorExtensionLoaded,
  openDatabase,
  vecTableName
} from '../src/store.js';
import type { Db } from '../src/store.js';

// Force the deterministic SHA-256 stub so spawned MCP subprocesses don't
// download a real embedding model (~278 MB) during the test run.
process.env.PARALLAX_EMBEDDING_MODEL = 'stub-sha256';
// Stub reflection LLM so the MCP reflect round-trip never touches the
// network and does not require ANTHROPIC_API_KEY / OPENAI_API_KEY / Ollama.
process.env.PARALLAX_REFLECTION_MODEL = 'stub';

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

type DocumentedMcpTool = {
  name: string;
  readOnly: boolean;
};

type McpDocsToolTable = {
  filePath: string;
  toolsHeading: string;
  yesLabel: string;
  noLabel: string;
  readOnlyColumnIndex: number;
};

const mcpDocsToolTables: McpDocsToolTable[] = [
  {
    filePath: 'docs/mcp.md',
    toolsHeading: '## Tools',
    yesLabel: 'Yes',
    noLabel: 'No',
    readOnlyColumnIndex: 2
  },
  {
    filePath: 'docs/mcp.ko.md',
    toolsHeading: '## Tool',
    yesLabel: '예',
    noLabel: '아니오',
    readOnlyColumnIndex: 2
  },
  {
    filePath: 'docs/mcp.zh.md',
    toolsHeading: '## Tool',
    yesLabel: '是',
    noLabel: '否',
    readOnlyColumnIndex: 2
  },
  {
    filePath: 'skills/parallax/SKILL.md',
    toolsHeading: '## MCP tools surfaced (23)',
    yesLabel: '✅',
    noLabel: '❌',
    readOnlyColumnIndex: 1
  },
  {
    filePath: 'skills/parallax/SKILL.ko.md',
    toolsHeading: '## MCP tools surfaced (23)',
    yesLabel: '✅',
    noLabel: '❌',
    readOnlyColumnIndex: 1
  },
  {
    filePath: 'skills/parallax/SKILL.zh.md',
    toolsHeading: '## MCP tools surfaced (23)',
    yesLabel: '✅',
    noLabel: '❌',
    readOnlyColumnIndex: 1
  }
];

function documentedMcpTools(table: McpDocsToolTable): DocumentedMcpTool[] {
  const markdown = readFileSync(path.resolve(table.filePath), 'utf8');
  const lines = markdown.split('\n');
  const toolsStart = lines.findIndex((line) => line.trim() === table.toolsHeading);
  assert.notEqual(toolsStart, -1, `${table.filePath} must have a ${table.toolsHeading} section`);
  const sectionEnd = lines.findIndex(
    (line, index) => index > toolsStart && line.startsWith('## ')
  );
  const toolsSection = lines.slice(toolsStart + 1, sectionEnd === -1 ? lines.length : sectionEnd);

  const tools: DocumentedMcpTool[] = [];
  for (const line of toolsSection) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    const toolCell = cells[0];
    const readOnlyCell = cells[table.readOnlyColumnIndex];
    if (!toolCell || !readOnlyCell) {
      continue;
    }
    const toolName = toolCell.match(/^`(parallax_[^`]+)`$/)?.[1];
    if (!toolName) {
      continue;
    }
    assert.ok(
      readOnlyCell === table.yesLabel || readOnlyCell === table.noLabel,
      `${table.filePath} Tools table row for ${toolName} must use ${table.yesLabel}/${table.noLabel} read-only labels`
    );
    tools.push({
      name: toolName,
      readOnly: readOnlyCell === table.yesLabel
    });
  }

  assert.ok(tools.length > 0, `${table.filePath} Tools table must document parallax_* tools`);
  assert.equal(
    new Set(tools.map((tool) => tool.name)).size,
    tools.length,
    `${table.filePath} Tools table must not contain duplicate tools`
  );
  return tools;
}

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
        name: 'parallax-test',
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
    const deadlineMs = 5_000;
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

function assertNoMcpRepoRootLeak(payload: unknown, repoRoots: string[]): void {
  const serialized = JSON.stringify(payload);
  for (const field of ['consumerRepoPath', 'providerRepoPath', 'consumerRoot', 'providerRoot']) {
    assert.equal(serialized.includes(`"${field}"`), false, `MCP payload must not include ${field}`);
  }

  const forbiddenPaths = new Set<string>();
  for (const repoRoot of repoRoots) {
    forbiddenPaths.add(repoRoot);
    forbiddenPaths.add(realpathSync(repoRoot));
  }
  for (const repoRoot of forbiddenPaths) {
    assert.equal(serialized.includes(repoRoot), false, `MCP payload must not include absolute repo path ${repoRoot}`);
  }
}

async function makeRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-mcp-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(repoRoot, 'src/b.ts'), 'import { a } from "./a"; export const b = a;\n');
  await initProject({ repoRoot });
  await indexProject({ repoRoot });
  return repoRoot;
}

async function makeMcpWorkArtifactRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-mcp-artifacts-'));
  await mkdir(path.join(repoRoot, 'src/auth'), { recursive: true });
  await mkdir(path.join(repoRoot, 'policies'), { recursive: true });
  await mkdir(path.join(repoRoot, 'docs/decisions'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/auth/session.ts'), 'export function rotateSession() { return "ok"; }\n');
  await writeFile(
    path.join(repoRoot, 'policies/security-auth.md'),
    [
      '---',
      'title: Security Auth Policy',
      'owner: security-platform',
      'status: approved',
      'updated: 2000-01-01',
      '---',
      '# Security auth policy',
      '',
      'Changes to src/auth/session.ts require security review.',
      '',
      'PRIVATE BODY SENTENCE should stay behind resource expansion.',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'docs/decisions/auth-session.md'),
    [
      '---',
      'title: Auth session decision',
      'updated: 2026-02-30',
      '---',
      '# Auth session decision',
      '',
      'This decision governs src/auth/session.ts.',
      '',
      'SECRET DECISION BODY should not be in context pack payload.',
      ''
    ].join('\n')
  );
  await initProject({ repoRoot });
  await indexProject({ repoRoot });
  return repoRoot;
}

async function makeContractWorkspaceRepo(options: { skipResolve?: boolean } = {}): Promise<{ consumerRoot: string; providerRoot: string }> {
  const consumerRoot = await mkdtemp(path.join(tmpdir(), 'parallax-mcp-contract-consumer-'));
  const providerRoot = await mkdtemp(path.join(tmpdir(), 'parallax-mcp-contract-provider-'));
  await mkdir(path.join(consumerRoot, 'src'), { recursive: true });
  await writeFile(
    path.join(consumerRoot, 'src/client.ts'),
    [
      'export async function loadUsers() {',
      '  return fetch("https://users.example.test/api/users");',
      '}',
      ''
    ].join('\n')
  );
  await writeMcpOpenApiContract(providerRoot, ['/api/users', '/api/status']);

  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });
  initWorkspace({ repoRoot: consumerRoot, name: 'platform', serviceName: 'web' });
  addWorkspaceRepo({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    localPath: providerRoot,
    serviceName: 'users-api'
  });
  if (options.skipResolve !== true) {
    const resolved = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });
    assert.equal(resolved.links.length, 1);
  }
  return { consumerRoot, providerRoot };
}

async function writeMcpWorkspaceCatalogServices(options: {
  consumerRoot: string;
  providerRoot: string;
  consumerServiceName: string;
  providerServiceName: string;
}): Promise<void> {
  const catalogPath = workspaceCatalogPath(options.consumerRoot);
  const catalogDir = path.dirname(catalogPath);
  await writeFile(catalogPath, `${JSON.stringify({
    schemaVersion: 1,
    name: 'platform',
    repos: [
      {
        localPath: path.relative(catalogDir, realpathSync(options.consumerRoot)),
        serviceName: options.consumerServiceName,
        remoteUrl: null,
        trustPolicy: { readOnly: true }
      },
      {
        localPath: path.relative(catalogDir, realpathSync(options.providerRoot)),
        serviceName: options.providerServiceName,
        remoteUrl: null,
        trustPolicy: { readOnly: true }
      }
    ]
  }, null, 2)}\n`);
}

function workspaceRepoServiceNames(repoRoot: string): string[] {
  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const rows = db
      .prepare('SELECT service_name FROM workspace_repos ORDER BY service_name')
      .all() as Array<{ service_name: string | null }>;
    return rows.map((row) => row.service_name ?? '');
  } finally {
    db.close();
  }
}

function seedMcpConsumesEventTopology(repoRoot: string): void {
  const db = new DatabaseSync(databasePath(repoRoot));
  try {
    const row = db
      .prepare(
        `SELECT id, provenance
         FROM cross_repo_links
         WHERE kind = ?`
      )
      .get('CONSUMES_HTTP_ENDPOINT') as { id: string; provenance: string };
    const provenance = JSON.parse(row.provenance) as Record<string, unknown>;
    provenance.eventTopology = {
      providerAction: 'SEND',
      counterpartyRole: 'consumer',
      pattern: 'subscriber-call'
    };
    db.prepare('UPDATE cross_repo_links SET provenance = ? WHERE id = ?')
      .run(JSON.stringify(provenance), row.id);
  } finally {
    db.close();
  }
}

async function writeMcpOpenApiContract(repoRoot: string, routes: string[]): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  const routeLines = routes.flatMap((route) => [
    `  ${route}:`,
    '    get:',
    `      operationId: ${route.replace(/[^a-z0-9]/gi, '') || 'root'}`,
    '      responses:',
    "        '200':",
    '          description: ok'
  ]);
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'info:',
      '  title: Users API',
      '  version: 1.0.0',
      'paths:',
      ...routeLines,
      ''
    ].join('\n')
  );
}

function insertFactEmbedding(db: Db, factId: string, value: string): void {
  const embedding = computeEmbeddingSync(value);
  db.prepare(
    "INSERT OR REPLACE INTO fact_embeddings (fact_id, model, vector, dim, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run(factId, embedding.model, embedding.vector, embedding.dim);
  if (!isVectorExtensionLoaded(db) || !ensureVecTable(db, embedding.model, embedding.dim)) return;
  db.prepare(
    `INSERT OR REPLACE INTO ${vecTableName(embedding.model)} (fact_id, embedding) VALUES (?, vec_int8(?))`
  ).run(factId, embedding.vector);
}

function downgradeFactProvenanceWithoutTxId(repoRoot: string): void {
  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: false });
  try {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM schema_versions WHERE version >= 13;

      ALTER TABLE fact_provenance RENAME TO fact_provenance_pre_v13;
      CREATE TABLE fact_provenance (
        id TEXT PRIMARY KEY NOT NULL,
        fact_id TEXT NOT NULL,
        source_fact_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'evidence',
        UNIQUE(fact_id, source_fact_id, kind),
        FOREIGN KEY(fact_id) REFERENCES facts(id),
        FOREIGN KEY(source_fact_id) REFERENCES facts(id)
      );
      INSERT OR IGNORE INTO fact_provenance (id, fact_id, source_fact_id, kind)
      SELECT id, fact_id, source_fact_id, kind
      FROM fact_provenance_pre_v13;
      DROP TABLE fact_provenance_pre_v13;
      PRAGMA foreign_keys = ON;
    `);
  } finally {
    db.close();
  }
}

async function makeSecretPathRepo(): Promise<{ repoRoot: string; secretPath: string }> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-mcp-secret-path-'));
  const secretPath = 'src/sk-12345678901234567890.ts';
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, secretPath), 'export const secretNamedFile = 1;\n');
  await initProject({ repoRoot });
  await indexProject({ repoRoot });
  return { repoRoot, secretPath };
}

async function makeWideContextRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-mcp-wide-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await mkdir(path.join(repoRoot, 'tests'), { recursive: true });
  await mkdir(path.join(repoRoot, 'docs'), { recursive: true });
  await mkdir(path.join(repoRoot, '.github/workflows'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
  for (const name of ['b', 'c', 'd', 'e', 'f', 'g']) {
    const alias = `a${name.toUpperCase()}${'x'.repeat(420)}`;
    await writeFile(
      path.join(repoRoot, `src/${name}.ts`),
      [
        `import { a as ${alias} } from "./a";`,
        `const padded${name.toUpperCase()} = "${'x'.repeat(420)}";`,
        `export const ${name} = ${alias} + padded${name.toUpperCase()}.length;`
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
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-mcp-search-escaping-'));
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

async function makeSearchDepthRepo(): Promise<string> {
  const repoRoot = await makeRepo();
  const db = openDatabase(repoRoot);
  try {
    const repo = db.prepare('SELECT id FROM repos LIMIT 1').get() as { id: number };
    const run = db
      .prepare('SELECT id FROM index_runs WHERE repo_id = ? AND status = ? ORDER BY id DESC LIMIT 1')
      .get(repo.id, 'completed') as { id: number };
    const branch = db.prepare("SELECT head_tx_id FROM branches WHERE name = 'main'").get() as { head_tx_id: string };

    const insertEntity = db.prepare(`
      INSERT INTO entities (
        id, repo_id, kind, path, symbol, language_id, display_name,
        created_index_run_id, updated_index_run_id
      )
      VALUES (?, ?, ?, ?, ?, 'typescript', ?, ?, ?)
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

    insertEntity.run(
      'file:depth/root.ts',
      repo.id,
      'file',
      'depth/root.ts',
      null,
      'Token Refresh Validator',
      run.id,
      run.id
    );
    insertEntity.run(
      'file:depth/session.ts',
      repo.id,
      'file',
      'depth/session.ts',
      null,
      'Session Gate',
      run.id,
      run.id
    );
    insertRelation.run(
      'depth:root-session',
      repo.id,
      'file:depth/root.ts',
      'file:depth/session.ts',
      'CALLS',
      run.id,
      'depth-fixture'
    );
    insertEvidence.run(
      'depth:root-session:evidence',
      'depth:root-session',
      repo.id,
      'depth/root.ts',
      'CALLS',
      'plain graph edge evidence',
      run.id
    );

    insertEntity.run(
      'file:depth/evidence.ts',
      repo.id,
      'file',
      'depth/evidence.ts',
      null,
      'Evidence Target',
      run.id,
      run.id
    );
    insertRelation.run(
      'depth:evidence-self',
      repo.id,
      'file:depth/evidence.ts',
      'file:depth/evidence.ts',
      'DOCUMENTS',
      run.id,
      'depth-fixture'
    );
    insertEvidence.run(
      'depth:evidence-self:evidence',
      'depth:evidence-self',
      repo.id,
      'depth/evidence.ts',
      'DOCUMENTS',
      'rotation handles stale policy checkpoints',
      run.id
    );

    insertEntity.run(
      'file:depth/semantic.ts',
      repo.id,
      'file',
      'depth/semantic.ts',
      null,
      'Checkout Worker',
      run.id,
      run.id
    );
    db.prepare("INSERT OR IGNORE INTO attribute_defs (name, value_type, is_code_relation, description) VALUES ('session_summary', 'json', 0, '')").run();
    insertEntity.run(
      'file:depth/fact.ts',
      repo.id,
      'file',
      'depth/fact.ts',
      null,
      'Fact Target',
      run.id,
      run.id
    );
    db.prepare(
      'INSERT OR IGNORE INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted) VALUES (?, ?, ?, ?, ?, ?, 0)'
    ).run(
      'depth-fact-fts',
      'file:depth/fact.ts',
      'session_summary',
      JSON.stringify('operator memory keeps retention guard'),
      'assert',
      branch.head_tx_id
    );
    db.prepare(
      'INSERT OR IGNORE INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted) VALUES (?, ?, ?, ?, ?, ?, 0)'
    ).run(
      'depth-semantic-fact',
      'file:depth/semantic.ts',
      'session_summary',
      JSON.stringify('retry idempotent checkout signal'),
      'assert',
      branch.head_tx_id
    );
    insertFactEmbedding(db, 'depth-semantic-fact', 'retry idempotent checkout signal');
  } finally {
    db.close();
  }
  return repoRoot;
}

async function makeLargeSemanticRepo(): Promise<string> {
  const repoRoot = await makeRepo();
  const db = openDatabase(repoRoot);
  try {
    const repo = db.prepare('SELECT id FROM repos LIMIT 1').get() as { id: number };
    const run = db
      .prepare('SELECT id FROM index_runs WHERE repo_id = ? AND status = ? ORDER BY id DESC LIMIT 1')
      .get(repo.id, 'completed') as { id: number };
    const branch = db.prepare("SELECT head_tx_id FROM branches WHERE name = 'main'").get() as { head_tx_id: string };
    const insertEntity = db.prepare(`
      INSERT INTO entities (
        id, repo_id, kind, path, symbol, language_id, display_name,
        created_index_run_id, updated_index_run_id
      )
      VALUES (?, ?, 'file', ?, NULL, 'typescript', ?, ?, ?)
    `);
    const insertFact = db.prepare(
      'INSERT OR IGNORE INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted) VALUES (?, ?, ?, ?, ?, ?, 0)'
    );
    db.prepare("INSERT OR IGNORE INTO attribute_defs (name, value_type, is_code_relation, description) VALUES ('session_summary', 'json', 0, '')").run();

    for (let index = 0; index < 520; index += 1) {
      const suffix = index.toString().padStart(3, '0');
      const entityId = `file:semantic/filler-${suffix}.ts`;
      const factId = `semantic-filler-${suffix}`;
      const value = `unrelated semantic filler ${suffix}`;
      insertEntity.run(entityId, repo.id, `semantic/filler-${suffix}.ts`, `Semantic filler ${suffix}`, run.id, run.id);
      insertFact.run(factId, entityId, 'session_summary', JSON.stringify(value), 'assert', branch.head_tx_id);
      insertFactEmbedding(db, factId, value);
    }

    const targetValue = 'late semantic target exact checkout vector';
    insertEntity.run(
      'file:semantic/late-target.ts',
      repo.id,
      'semantic/late-target.ts',
      'Late Semantic Target',
      run.id,
      run.id
    );
    insertFact.run(
      'semantic-late-target',
      'file:semantic/late-target.ts',
      'session_summary',
      JSON.stringify(targetValue),
      'assert',
      branch.head_tx_id
    );
    insertFactEmbedding(db, 'semantic-late-target', targetValue);
  } finally {
    db.close();
  }
  return repoRoot;
}

async function makeBroadSearchRepo(): Promise<string> {
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

    for (let index = 0; index < 520; index += 1) {
      const suffix = index.toString().padStart(3, '0');
      insertEntity.run(
        `file:broad/BROAD_CAP_${suffix}.ts`,
        repo.id,
        `broad/BROAD_CAP_${suffix}.ts`,
        `Broad cap ${suffix}`,
        run.id,
        run.id
      );
    }
  } finally {
    db.close();
  }
  return repoRoot;
}

async function makeDiversificationRepo(): Promise<string> {
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
      VALUES (?, ?, ?, ?, NULL, 'typescript', ?, ?, ?)
    `);
    const insertRelation = db.prepare(`
      INSERT INTO relations (
        id, repo_id, source_entity_id, target_entity_id, kind, confidence,
        adapter_run_id, index_run_id, provenance
      )
      VALUES (?, ?, ?, ?, ?, 'medium', NULL, ?, 'DIVERSIFY_MARKER')
    `);
    const insertEvidence = db.prepare(`
      INSERT INTO relation_evidence (
        id, relation_id, repo_id, file_path, kind, snippet, confidence, index_run_id
      )
      VALUES (?, ?, ?, ?, ?, 'diversify marker evidence', 'medium', ?)
    `);

    const add = (
      entityId: string,
      kind: string,
      filePath: string,
      displayName: string,
      relationKind = 'CALLS'
    ): void => {
      const relationId = `diversify:${entityId}`;
      insertEntity.run(entityId, repo.id, kind, filePath, displayName, run.id, run.id);
      insertRelation.run(relationId, repo.id, entityId, entityId, relationKind, run.id);
      insertEvidence.run(`${relationId}:evidence`, relationId, repo.id, filePath, relationKind, run.id);
    };

    for (let index = 0; index < 5; index += 1) {
      add(`file:src/diverse-${index}.ts`, 'file', `src/diverse-${index}.ts`, `A src dominant ${index}`);
    }
    add('file:src/diverse-doc-relation.ts', 'file', 'src/diverse-doc-relation.ts', 'C src documents relation', 'DOCUMENTS');
    add('symbol:src/diverse#handler', 'symbol', 'src/diverse-handler.ts', 'B symbol candidate', 'DECLARES');
    add('file:docs/diverse.md', 'file', 'docs/diverse.md', 'Y docs candidate', 'DOCUMENTS');
    add('file:tests/diverse.test.ts', 'file', 'tests/diverse.test.ts', 'Z tests candidate', 'VERIFIES');
  } finally {
    db.close();
  }
  return repoRoot;
}

async function makeHugeEvidenceRepo(): Promise<string> {
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
      VALUES (?, ?, ?, ?, 'CALLS', 'medium', NULL, ?, 'HUGE_EVIDENCE_MARKER')
    `);
    const insertEvidence = db.prepare(`
      INSERT INTO relation_evidence (
        id, relation_id, repo_id, file_path, kind, snippet, confidence, index_run_id
      )
      VALUES (?, ?, ?, ?, 'CALLS', ?, 'medium', ?)
    `);

    const longPath = `huge/${'p'.repeat(3_000)}.ts`;
    const longDisplayName = `Huge Evidence ${'d'.repeat(700)}`;
    insertEntity.run('file:huge/evidence.ts', repo.id, longPath, longDisplayName, run.id, run.id);
    insertRelation.run('huge:evidence', repo.id, 'file:huge/evidence.ts', 'file:huge/evidence.ts', run.id);
    insertEvidence.run(
      'huge:evidence:0',
      'huge:evidence',
      repo.id,
      'huge/evidence.ts',
      `HUGE_EVIDENCE_MARKER ${'x'.repeat(24_000)}`,
      run.id
    );
  } finally {
    db.close();
  }
  return repoRoot;
}

async function makeUnavoidableBudgetRepo(): Promise<string> {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(databasePath(repoRoot));
  try {
    const repo = db.prepare('SELECT id FROM repos LIMIT 1').get() as { id: number };
    const run = db
      .prepare('SELECT id FROM index_runs WHERE repo_id = ? AND status = ? ORDER BY id DESC LIMIT 1')
      .get(repo.id, 'completed') as { id: number };
    const longPath = `huge/${'p'.repeat(8_000)}.ts`;
    const longDisplayName = `Unavoidable Budget ${'d'.repeat(8_000)}`;
    db.prepare(`
      INSERT INTO entities (
        id, repo_id, kind, path, symbol, language_id, display_name,
        created_index_run_id, updated_index_run_id
      )
      VALUES (?, ?, 'file', ?, NULL, 'typescript', ?, ?, ?)
    `).run('file:huge/unavoidable.ts', repo.id, longPath, longDisplayName, run.id, run.id);
  } finally {
    db.close();
  }
  return repoRoot;
}

async function makeBoundaryBudgetRepo(): Promise<string> {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(databasePath(repoRoot));
  try {
    const repo = db.prepare('SELECT id FROM repos LIMIT 1').get() as { id: number };
    const run = db
      .prepare('SELECT id FROM index_runs WHERE repo_id = ? AND status = ? ORDER BY id DESC LIMIT 1')
      .get(repo.id, 'completed') as { id: number };
    const boundaryPath = `boundary/${'p'.repeat(3_888)}.ts`;
    const boundaryDisplayName = `Boundary ${'d'.repeat(200)}`;
    db.prepare(`
      INSERT INTO entities (
        id, repo_id, kind, path, symbol, language_id, display_name,
        created_index_run_id, updated_index_run_id
      )
      VALUES (?, ?, 'file', ?, NULL, 'typescript', ?, ?, ?)
    `).run('file:boundary.ts', repo.id, boundaryPath, boundaryDisplayName, run.id, run.id);
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

function contextPackRows(repoRoot: string): Array<{ id: string; hit_count: number; returned_bytes: number }> {
  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    return db
      .prepare('SELECT id, hit_count, returned_bytes FROM context_packs ORDER BY created_at, id')
      .all() as Array<{ id: string; hit_count: number; returned_bytes: number }>;
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
    db.prepare('DELETE FROM schema_versions WHERE version >= 10').run();
  } finally {
    db.close();
  }
}

function dbArtifacts(repoRoot: string): string[] {
  return ['impact.db', 'impact.db-wal', 'impact.db-shm']
    .filter((file) => existsSync(path.join(repoRoot, '.parallax', file)));
}

function assertStructuredContentMirrorsText(response: JsonRpcMessage, label: string): void {
  assert.equal(response.error, undefined, `${label} must not have a JSON-RPC error`);
  assert.notEqual(response.result?.structuredContent, undefined, `${label} must return structuredContent`);
  assert.deepEqual(
    response.result.structuredContent,
    JSON.parse(response.result.content[0].text),
    `${label} structuredContent must mirror content[0].text JSON`
  );
}

test('MCP stdio server initializes and exposes the full agent memory tool surface', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    const initialize = await client.initialize();
    assert.equal(initialize.error, undefined);
    assert.equal(typeof initialize.result.protocolVersion, 'string');
    assert.equal(initialize.result.serverInfo.name, 'parallax');

    const response = await client.request('tools/list', {});
    assert.equal(response.error, undefined);
    const tools = response.result.tools as Array<{
      name: string;
      inputSchema?: {
        properties?: Record<string, any>;
        required?: string[];
      };
      outputSchema?: {
        type?: string;
        properties?: Record<string, any>;
        required?: string[];
      };
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
    }>;
    const toolByName = new Map<string, (typeof tools)[number]>(
      tools.map((tool) => [tool.name, tool])
    );
    for (const table of mcpDocsToolTables) {
      const documentedTools = documentedMcpTools(table);
      const documentedToolByName = new Map(
        documentedTools.map((tool) => [tool.name, tool])
      );
      assert.deepEqual(
        [...documentedToolByName.keys()].sort(),
        tools.map((tool) => tool.name).sort(),
        `${table.filePath} Tools table must match tools/list`
      );
      for (const tool of tools) {
        assert.equal(
          documentedToolByName.get(tool.name)?.readOnly,
          tool.annotations?.readOnlyHint,
          `${table.filePath} read-only value must match readOnlyHint for ${tool.name}`
        );
      }
    }
    const expectedTools = [
      'parallax_analyze_diff',
      'parallax_context_for_change',
      'parallax_search_context',
      'parallax_remember',
      'parallax_recall',
      'parallax_query',
      'parallax_co_change',
      'parallax_branch',
      'parallax_merge',
      'parallax_trace',
      'parallax_reflect',
      'parallax_abandon_branch',
      'parallax_gc_branches',
      'parallax_profile',
      'parallax_explain_entity',
      'parallax_contract_diff',
      'parallax_cross_repo_consumers',
      'parallax_cross_repo_providers',
      'parallax_resolve_cross_repo_contracts',
      'parallax_repair_reflections',
      'parallax_restore_branch',
      'parallax_context_telemetry',
      'parallax_doctor'
    ];
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [...expectedTools].sort()
    );
    for (const expected of expectedTools) {
      assert.ok(toolByName.has(expected), `expected MCP tool ${expected} to be advertised`);
    }
    for (const tool of tools) {
      assert.equal(tool.outputSchema?.type, 'object', `${tool.name} must advertise an object outputSchema`);
      assert.ok(
        (tool.outputSchema?.required?.length ?? 0) > 0,
        `${tool.name} outputSchema must document required top-level fields`
      );
    }
    assert.deepEqual(toolByName.get('parallax_remember')!.outputSchema?.required?.sort(), ['factId', 'txId']);
    assert.ok(
      toolByName.get('parallax_analyze_diff')!.outputSchema?.required?.includes('affectedFiles'),
      'parallax_analyze_diff outputSchema must include affectedFiles'
    );
    assert.ok(
      toolByName.get('parallax_context_for_change')!.outputSchema?.required?.includes('omittedCounts'),
      'parallax_context_for_change outputSchema must include omittedCounts'
    );
    assert.equal(toolByName.get('parallax_analyze_diff')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('parallax_context_for_change')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('parallax_search_context')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('parallax_analyze_diff')!.inputSchema?.properties?.changedFiles?.type, 'array');
    assert.equal(toolByName.get('parallax_analyze_diff')!.inputSchema?.properties?.changedFiles?.items?.type, 'string');
    assert.equal(toolByName.get('parallax_analyze_diff')!.inputSchema?.properties?.maxDepth?.maximum, 8);
    assert.equal(toolByName.get('parallax_remember')!.inputSchema?.properties?.supersedesFactIds?.type, 'array');
    assert.equal(toolByName.get('parallax_remember')!.inputSchema?.properties?.supersedesFactIds?.items?.type, 'string');
    assert.deepEqual(toolByName.get('parallax_context_for_change')!.inputSchema?.properties?.budget?.enum, [
      'brief',
      'standard',
      'deep'
    ]);
    assert.deepEqual(toolByName.get('parallax_context_for_change')!.inputSchema?.properties?.reusePolicy?.enum, [
      'auto',
      'full',
      'reference'
    ]);
    assert.equal(toolByName.get('parallax_search_context')!.inputSchema?.properties?.query?.type, 'string');
    assert.equal(toolByName.get('parallax_search_context')!.inputSchema?.properties?.k?.maximum, 50);
    assert.equal(toolByName.get('parallax_explain_entity')!.inputSchema?.properties?.relationLimit?.maximum, 100);
    assert.equal(toolByName.get('parallax_contract_diff')!.inputSchema?.properties?.contractPath?.type, 'string');
    assert.equal(toolByName.get('parallax_contract_diff')!.inputSchema?.properties?.providerServiceName?.type, 'string');
    assert.equal(toolByName.get('parallax_contract_diff')!.inputSchema?.properties?.persist?.type, 'boolean');
    assert.equal(toolByName.get('parallax_analyze_diff')!.annotations?.idempotentHint, false);
    assert.equal(toolByName.get('parallax_context_for_change')!.annotations?.idempotentHint, false);
    assert.equal(toolByName.get('parallax_search_context')!.annotations?.idempotentHint, false);
    assert.equal(toolByName.get('parallax_recall')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('parallax_trace')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('parallax_profile')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('parallax_explain_entity')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('parallax_explain_entity')!.annotations?.idempotentHint, false);
    assert.equal(toolByName.get('parallax_contract_diff')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('parallax_contract_diff')!.annotations?.idempotentHint, false);
    assert.equal(toolByName.get('parallax_cross_repo_consumers')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('parallax_cross_repo_consumers')!.annotations?.idempotentHint, true);
    assert.equal(toolByName.get('parallax_cross_repo_providers')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('parallax_cross_repo_providers')!.annotations?.idempotentHint, true);
    assert.equal(toolByName.get('parallax_resolve_cross_repo_contracts')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('parallax_resolve_cross_repo_contracts')!.annotations?.idempotentHint, true);
    assert.equal(toolByName.get('parallax_context_telemetry')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('parallax_context_telemetry')!.annotations?.idempotentHint, true);
    assert.equal(toolByName.get('parallax_doctor')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('parallax_doctor')!.annotations?.idempotentHint, true);
    assert.equal(toolByName.get('parallax_remember')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('parallax_branch')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('parallax_merge')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('parallax_reflect')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('parallax_abandon_branch')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('parallax_gc_branches')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('parallax_repair_reflections')!.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get('parallax_restore_branch')!.annotations?.readOnlyHint, false);
    for (const tool of tools) {
      assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} must not advertise destructive MCP access`);
      if (tool.name !== 'parallax_reflect') {
        assert.equal(tool.annotations?.openWorldHint, false, `${tool.name} must not advertise open-world MCP access`);
      }
    }
    for (const forbiddenSurface of [
      'obsidian',
      'compress_file',
      'export',
      'import_session',
      'session_import',
      'mesh',
      'team',
      'heal',
      'routine',
      'signal',
      'lease',
      'snapshot',
      'write_file',
      'delete_file'
    ]) {
      assert.equal(
        tools.some((tool) => tool.name.includes(forbiddenSurface)),
        false,
        `forbidden MCP surface leaked into tools/list: ${forbiddenSurface}`
      );
    }
  } finally {
    await client.close();
  }
});

test('MCP rejects forbidden agentmemory-style tool calls even when called directly', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    for (const name of [
      'memory_export',
      'memory_obsidian_export',
      'memory_mesh_sync',
      'memory_write_file',
      'parallax_export',
      'parallax_import_session'
    ]) {
      const response = await client.request('tools/call', { name, arguments: {} });
      assert.ok(response.error || response.result?.isError, `forbidden tool call must fail: ${name}`);
      const text = response.error?.message ?? response.result?.content?.[0]?.text ?? '';
      assert.match(text, /Unknown tool|not found|Invalid|forbidden|error/i);
    }
  } finally {
    await client.close();
  }
});

test('MCP doctor returns the local health report without telemetry writes', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'parallax_doctor',
      arguments: {}
    });

    assert.equal(response.error, undefined);
    assertStructuredContentMirrorsText(response, 'parallax_doctor');
    const report = JSON.parse(response.result.content[0].text) as {
      version: number;
      repoRoot: string;
      database: { path: string; schemaVersion: number };
      index: { latestCompletedRun: { status: string } | null };
      telemetry: { toolRuns: number };
    };
    assert.equal(report.version, 0);
    assert.equal(report.repoRoot, '[REPO_ROOT]');
    assert.equal(report.database.path, '.parallax/impact.db');
    assert.equal(report.database.schemaVersion, 16);
    assert.equal(report.index.latestCompletedRun?.status, 'completed');
    assert.equal(report.telemetry.toolRuns, 0);
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
      name: 'parallax_analyze_diff',
      arguments: { changedFiles: ['src/a.ts'] }
    });

    assert.equal(response.error, undefined);
    assertStructuredContentMirrorsText(response, 'parallax_analyze_diff');
    assert.equal(response.result.content[0].type, 'text');
    const report = JSON.parse(response.result.content[0].text) as { affectedFiles: Array<{ path: string }> };
    assert.ok(report.affectedFiles.some((file) => file.path === 'src/b.ts'));

    const bad = await client.request('tools/call', {
      name: 'parallax_analyze_diff',
      arguments: { changedFiles: ['../outside.ts'] }
    });

    assert.equal(bad.error, undefined);
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /outside repo root/);
    const errorBody = JSON.parse(bad.result.content[0].text) as {
      error: { code: string; problem: string; cause: string; fix: string; evidence: unknown[] };
    };
    assert.equal(errorBody.error.code, 'path_outside_repo');
    assert.match(errorBody.error.problem, /outside repo root/);
    assert.ok(errorBody.error.cause.length > 0);
    assert.ok(errorBody.error.fix.length > 0);
    assert.deepEqual(errorBody.error.evidence, []);
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
      name: 'parallax_analyze_diff',
      arguments: { changedFiles: ['src/a.ts'] }
    });

    assert.equal(response.error, undefined);
    assert.equal(countReports(repoRoot), 0);
    const filterWalAux = (names: string[]): string[] =>
      names.filter((name) => !/\.db-(wal|shm)$/.test(name));
    assert.deepEqual(filterWalAux(dbArtifacts(repoRoot)), filterWalAux(artifactsBefore));
    assert.equal(existsSync(path.join(repoRoot, '.parallax/reports')), false);
  } finally {
    await client.close();
  }
});

test('MCP contract_diff returns compact workspace resources and persists breaking contract links', async () => {
  const { consumerRoot, providerRoot } = await makeContractWorkspaceRepo();
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  seedMcpConsumesEventTopology(consumerRoot);
  await writeMcpOpenApiContract(providerRoot, ['/api/status', '/api/admin']);
  const client = new McpProcessClient(consumerRoot);
  try {
    await client.initialize();

    const diffResponse = await client.request('tools/call', {
      name: 'parallax_contract_diff',
      arguments: {
        workspaceName: 'platform',
        providerServiceName: 'users-api',
        contractPath: 'contracts/openapi.yaml'
      }
    });

    assert.equal(diffResponse.error, undefined);
    const diff = JSON.parse(diffResponse.result.content[0].text) as {
      workspace: { name: string };
      provider: { serviceName: string; repoPath: string };
      summary: {
        classification: string;
        breakingChangeCount: number;
        impactedConsumerCount: number;
        eventTopologyCount?: number;
        eventTopologyBreakdown?: Array<{
          providerAction: string;
          counterpartyRole: string;
          pattern: string;
          count: number;
        }>;
      };
      changes: Array<{ kind: string; classification: string; httpMethod?: string; routePath?: string }>;
      impactedConsumers: Array<{
        consumerPath: string;
        routePath: string;
        eventTopology?: { providerAction: string; counterpartyRole: string; pattern: string };
      }>;
      resources: { workspace: string; contracts: string; crossRepoLinks: string };
    };
    assert.equal(diff.workspace.name, 'platform');
    assert.equal(diff.provider.serviceName, 'users-api');
    assert.equal(diff.provider.repoPath, providerReal);
    assert.equal(diff.summary.classification, 'breaking');
    assert.equal(diff.summary.breakingChangeCount, 1);
    assert.equal(diff.summary.impactedConsumerCount, 1);
    assert.equal(diff.summary.eventTopologyCount, 1);
    assert.deepEqual(diff.summary.eventTopologyBreakdown, [
      {
        providerAction: 'SEND',
        counterpartyRole: 'consumer',
        pattern: 'subscriber-call',
        count: 1
      }
    ]);
    assert.ok(diff.changes.some((change) =>
      change.kind === 'removed_endpoint' &&
      change.classification === 'breaking' &&
      change.httpMethod === 'GET' &&
      change.routePath === '/api/users'
    ));
    assert.deepEqual(diff.impactedConsumers.map((consumer) => ({
      consumerPath: consumer.consumerPath,
      routePath: consumer.routePath
    })), [
      {
        consumerPath: 'src/client.ts',
        routePath: '/api/users'
      }
    ]);
    assert.deepEqual(diff.impactedConsumers[0]?.eventTopology, {
      providerAction: 'SEND',
      counterpartyRole: 'consumer',
      pattern: 'subscriber-call'
    });
    assert.equal(diff.resources.workspace, 'parallax://workspaces/platform');
    assert.equal(diff.resources.contracts, 'parallax://workspaces/platform/contracts');
    assert.equal(diff.resources.crossRepoLinks, 'parallax://workspaces/platform/cross-repo-links');

    const workspaceResource = await client.request('resources/read', { uri: diff.resources.workspace });
    assert.equal(workspaceResource.error, undefined);
    const workspaceJson = JSON.parse(workspaceResource.result.contents[0].text) as {
      workspace: { name: string; repos: Array<{ serviceName: string; localPath: string }> };
      resources: { contracts: string; crossRepoLinks: string };
    };
    assert.equal(workspaceJson.workspace.name, 'platform');
    assert.deepEqual(
      workspaceJson.workspace.repos.map((repo) => [repo.serviceName, repo.localPath]).sort(),
      [
        ['users-api', providerReal],
        ['web', consumerReal]
      ].sort()
    );
    assert.equal(workspaceJson.resources.contracts, diff.resources.contracts);
    assert.equal(workspaceJson.resources.crossRepoLinks, diff.resources.crossRepoLinks);

    const contractsResource = await client.request('resources/read', { uri: diff.resources.contracts });
    assert.equal(contractsResource.error, undefined);
    const contractsJson = JSON.parse(contractsResource.result.contents[0].text) as {
      workspace: string;
      contracts: Array<{
        serviceName: string;
        repoPath: string;
        path: string;
        kind: string;
        schemaVersion?: string;
        endpointCount: number;
        contractDiffHint: { tool: string; contractPath: string; providerServiceName: string };
      }>;
      warnings: string[];
    };
    assert.equal(contractsJson.workspace, 'platform');
    const usersContract = contractsJson.contracts.find((contract) =>
      contract.serviceName === 'users-api' && contract.path === 'contracts/openapi.yaml'
    );
    assert.ok(usersContract);
    assert.equal(usersContract.repoPath, providerReal);
    assert.equal(usersContract.kind, 'openapi');
    assert.equal(usersContract.schemaVersion, '3.0.0');
    assert.equal(usersContract.endpointCount, 2);
    assert.deepEqual(usersContract.contractDiffHint, {
      tool: 'parallax_contract_diff',
      workspaceName: 'platform',
      contractPath: 'contracts/openapi.yaml',
      providerServiceName: 'users-api'
    });
    assert.deepEqual(contractsJson.warnings, []);

    const linksResource = await client.request('resources/read', { uri: diff.resources.crossRepoLinks });
    assert.equal(linksResource.error, undefined);
    const linksJson = JSON.parse(linksResource.result.contents[0].text) as {
      workspace: string;
      links: Array<{
        id: string;
        kind: string;
        sourceService: string;
        targetService: string;
        sourceRepoPath: string;
        targetRepoPath: string;
        eventTopology?: { providerAction: string; counterpartyRole: string; pattern: string };
        provenance: any;
      }>;
    };
    assert.equal(linksJson.workspace, 'platform');
    assert.ok(linksJson.links.some((link) =>
      link.kind === 'CONSUMES_HTTP_ENDPOINT' &&
      link.sourceService === 'web' &&
      link.targetService === 'users-api' &&
      link.sourceRepoPath === consumerReal &&
      link.targetRepoPath === providerReal &&
      link.eventTopology?.providerAction === 'SEND' &&
      link.eventTopology.counterpartyRole === 'consumer' &&
      link.eventTopology.pattern === 'subscriber-call' &&
      link.provenance.http.path === '/api/users'
    ));
    assert.ok(linksJson.links.some((link) =>
      link.kind === 'BREAKS_COMPATIBILITY_WITH' &&
      link.sourceService === 'web' &&
      link.targetService === 'users-api' &&
      link.eventTopology?.providerAction === 'SEND' &&
      link.eventTopology.counterpartyRole === 'consumer' &&
      link.eventTopology.pattern === 'subscriber-call' &&
      link.provenance.change.path === '/api/users'
    ));

    const db = new DatabaseSync(databasePath(consumerRoot));
    try {
      const malformed = linksJson.links.find((link) => link.kind === 'CONSUMES_HTTP_ENDPOINT');
      assert.ok(malformed);
      const malformedProvenance = {
        ...malformed.provenance,
        eventTopology: {
          providerAction: '',
          counterpartyRole: 'consumer',
          pattern: 'subscriber-call'
        }
      };
      db.prepare('UPDATE cross_repo_links SET provenance = ? WHERE id = ?')
        .run(JSON.stringify(malformedProvenance), malformed.id);
    } finally {
      db.close();
    }

    const malformedLinksResource = await client.request('resources/read', { uri: diff.resources.crossRepoLinks });
    assert.equal(malformedLinksResource.error, undefined);
    const malformedLinksJson = JSON.parse(malformedLinksResource.result.contents[0].text) as {
      links: Array<{
        id: string;
        kind: string;
        eventTopology?: { providerAction: string; counterpartyRole: string; pattern: string };
        provenance: any;
      }>;
    };
    const malformedConsumes = malformedLinksJson.links.find((link) => link.kind === 'CONSUMES_HTTP_ENDPOINT');
    assert.ok(malformedConsumes);
    assert.equal(malformedConsumes.eventTopology, undefined);
    assert.deepEqual(malformedConsumes.provenance.eventTopology, {
      providerAction: '',
      counterpartyRole: 'consumer',
      pattern: 'subscriber-call'
    });

    const templates = await client.request('resources/templates/list', {});
    assert.equal(templates.error, undefined);
    const templateUris = templates.result.resourceTemplates.map((item: { uriTemplate: string }) => item.uriTemplate);
    assert.ok(templateUris.includes('parallax://workspaces/{workspaceName}'));
    assert.ok(templateUris.includes('parallax://workspaces/{workspaceName}/contracts'));
    assert.ok(templateUris.includes('parallax://workspaces/{workspaceName}/cross-repo-links'));

    const resources = await client.request('resources/list', {});
    assert.equal(resources.error, undefined);
    const resourceUris = resources.result.resources.map((item: { uri: string }) => item.uri);
    assert.ok(resourceUris.includes('parallax://workspaces/platform'));
    assert.ok(resourceUris.includes('parallax://workspaces/platform/contracts'));
    assert.ok(resourceUris.includes('parallax://workspaces/platform/cross-repo-links'));
  } finally {
    await client.close();
  }
});

test('MCP cross-repo consumers and providers query persisted workspace links', async () => {
  const { consumerRoot, providerRoot } = await makeContractWorkspaceRepo();
  const client = new McpProcessClient(consumerRoot);
  try {
    await client.initialize();

    const consumers = await client.request('tools/call', {
      name: 'parallax_cross_repo_consumers',
      arguments: {
        workspaceName: 'platform',
        providerServiceName: 'users-api',
        providerContractPath: 'contracts/openapi.yaml',
        method: 'get',
        routePath: '/api/users'
      }
    });
    assert.equal(consumers.error, undefined);
    const consumersJson = JSON.parse(consumers.result.content[0].text) as {
      workspace: { name: string; repos: Array<{ serviceName: string }> };
      consumers: Array<{ consumerService: string; consumerPath: string; providerService: string }>;
      resources: { crossRepoLinks: string };
    };
    assertNoMcpRepoRootLeak(consumersJson, [consumerRoot, providerRoot]);
    assert.equal(consumersJson.workspace.name, 'platform');
    assert.deepEqual(consumersJson.workspace.repos.map((repo) => repo.serviceName).sort(), ['users-api', 'web']);
    assert.deepEqual(consumersJson.consumers.map((consumer) => ({
      consumerService: consumer.consumerService,
      consumerPath: consumer.consumerPath,
      providerService: consumer.providerService
    })), [{
      consumerService: 'web',
      consumerPath: 'src/client.ts',
      providerService: 'users-api'
    }]);
    assert.equal(consumersJson.resources.crossRepoLinks, 'parallax://workspaces/platform/cross-repo-links');

    const providers = await client.request('tools/call', {
      name: 'parallax_cross_repo_providers',
      arguments: {
        workspaceName: 'platform',
        consumerServiceName: 'web',
        consumerPath: 'src/client.ts'
      }
    });
    assert.equal(providers.error, undefined);
    const providersJson = JSON.parse(providers.result.content[0].text) as {
      workspace: { name: string; repos: Array<{ serviceName: string }> };
      providers: Array<{ providerService: string; providerContractPath: string; httpMethod: string; routePath: string }>;
    };
    assertNoMcpRepoRootLeak(providersJson, [consumerRoot, providerRoot]);
    assert.equal(providersJson.workspace.name, 'platform');
    assert.deepEqual(providersJson.workspace.repos.map((repo) => repo.serviceName).sort(), ['users-api', 'web']);
    assert.deepEqual(providersJson.providers.map((provider) => ({
      providerService: provider.providerService,
      providerContractPath: provider.providerContractPath,
      httpMethod: provider.httpMethod,
      routePath: provider.routePath
    })), [{
      providerService: 'users-api',
      providerContractPath: 'contracts/openapi.yaml',
      httpMethod: 'GET',
      routePath: '/api/users'
    }]);
  } finally {
    await client.close();
  }
});

test('MCP cross-repo consumers providers and resolve_cross_repo do not sync catalog renames', async () => {
  const { consumerRoot, providerRoot } = await makeContractWorkspaceRepo();
  assert.deepEqual(workspaceRepoServiceNames(consumerRoot), ['users-api', 'web']);

  await writeMcpWorkspaceCatalogServices({
    consumerRoot,
    providerRoot,
    consumerServiceName: 'frontend-file',
    providerServiceName: 'accounts-api-file'
  });
  assert.deepEqual(workspaceRepoServiceNames(consumerRoot), ['users-api', 'web']);

  const client = new McpProcessClient(consumerRoot);
  try {
    await client.initialize();

    const consumers = await client.request('tools/call', {
      name: 'parallax_cross_repo_consumers',
      arguments: {
        workspaceName: 'platform',
        providerServiceName: 'users-api',
        providerContractPath: 'contracts/openapi.yaml',
        method: 'get',
        routePath: '/api/users'
      }
    });
    assert.equal(consumers.error, undefined);
    assert.deepEqual(workspaceRepoServiceNames(consumerRoot), ['users-api', 'web']);

    const providers = await client.request('tools/call', {
      name: 'parallax_cross_repo_providers',
      arguments: {
        workspaceName: 'platform',
        consumerServiceName: 'web',
        consumerPath: 'src/client.ts'
      }
    });
    assert.equal(providers.error, undefined);
    assert.deepEqual(workspaceRepoServiceNames(consumerRoot), ['users-api', 'web']);

    const preview = await client.request('tools/call', {
      name: 'parallax_resolve_cross_repo_contracts',
      arguments: { workspaceName: 'platform' }
    });
    assert.equal(preview.error, undefined);
    assert.deepEqual(workspaceRepoServiceNames(consumerRoot), ['users-api', 'web']);
  } finally {
    await client.close();
  }
});

test('MCP resolve_cross_repo_contracts previews links without mutating persisted links', async () => {
  const { consumerRoot, providerRoot } = await makeContractWorkspaceRepo({ skipResolve: true });
  const client = new McpProcessClient(consumerRoot);
  try {
    await client.initialize();
    const response = await client.request('tools/call', {
      name: 'parallax_resolve_cross_repo_contracts',
      arguments: { workspaceName: 'platform' }
    });
    assert.equal(response.error, undefined);
    const preview = JSON.parse(response.result.content[0].text) as {
      workspace: { name: string; repos: Array<{ serviceName: string }> };
      links: Array<{
        consumerService: string;
        consumerPath: string;
        providerService: string;
        providerContractPath: string;
        providerEndpointId: string;
        routePath: string;
      }>;
      resources: { crossRepoLinks: string };
    };
    assertNoMcpRepoRootLeak(preview, [consumerRoot, providerRoot]);
    assert.equal(preview.workspace.name, 'platform');
    assert.deepEqual(preview.workspace.repos.map((repo) => repo.serviceName).sort(), ['users-api', 'web']);
    assert.deepEqual(preview.links.map((link) => ({
      consumerService: link.consumerService,
      consumerPath: link.consumerPath,
      providerService: link.providerService,
      providerContractPath: link.providerContractPath,
      providerEndpointId: link.providerEndpointId,
      routePath: link.routePath
    })), [{
      consumerService: 'web',
      consumerPath: 'src/client.ts',
      providerService: 'users-api',
      providerContractPath: 'contracts/openapi.yaml',
      providerEndpointId: 'endpoint:yaml:GET /api/users',
      routePath: '/api/users'
    }]);

    const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
    try {
      const row = db.prepare('SELECT count(*) AS count FROM cross_repo_links').get() as { count: number };
      assert.equal(row.count, 0);
    } finally {
      db.close();
    }
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
      name: 'parallax_context_for_change',
      arguments: { changedFiles: ['src/a.ts'], budget: 'brief' }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.content[0].type, 'text');
    const pack = JSON.parse(response.result.content[0].text) as {
      version: number;
      contextPackId: string;
      resourceUri: string;
      contentHash: string;
      reused: boolean;
      budget: string;
      indexRunId: number;
      changed: Array<{ entity: { id: string }; resourceUri: string }>;
      context: Array<{ path: string; resourceUri: string; relations: string[] }>;
      evidence: Array<{ id: string; snippet: string; file: string; resourceUri?: string }>;
      resources: { contextPack: string; coverage: string; entities: string[]; evidence: string[] };
      limits: { affectedLimit: number; evidenceLimit: number; snippetChars: number };
      omittedCounts: { affected: number; evidence: number; actions: number };
    };
    assert.equal(pack.version, 0);
    assert.match(pack.contextPackId, /^ctxpack:/);
    assert.equal(pack.resourceUri, `parallax://context-packs/${encodeURIComponent(pack.contextPackId)}`);
    assert.equal(pack.resources.contextPack, pack.resourceUri);
    assert.equal(pack.reused, false);
    assert.match(pack.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(pack.budget, 'brief');
    assert.equal(pack.changed[0]?.entity.id, 'file:src/a.ts');
    assert.equal(pack.changed[0]?.resourceUri, `parallax://entities/${encodeURIComponent('file:src/a.ts')}`);
    assert.ok(pack.context.some((item) => item.path === 'src/b.ts'));
    assert.ok(pack.context.every((item) => item.resourceUri.startsWith('parallax://entities/')));
    assert.ok(pack.context.every((item) => item.relations.length > 0));
    assert.ok(pack.evidence.length > 0);
    assert.ok(pack.evidence.every((item) => item.snippet.length <= pack.limits.snippetChars));
    assert.ok(pack.resources.evidence.length > 0);
    assert.ok(pack.evidence.some((item) => item.resourceUri));
    assert.ok(pack.evidence.every((item) =>
      item.resourceUri === undefined || item.resourceUri === `parallax://evidence/${encodeURIComponent(item.id)}`
    ));
    assert.equal(pack.resources.coverage, 'parallax://coverage/latest');
    assert.ok(pack.resources.entities.includes(`parallax://entities/${encodeURIComponent('file:src/a.ts')}`));
    assert.ok(pack.resources.evidence.every((uri) =>
      pack.evidence.some((item) => item.resourceUri === uri)
    ));
    for (const uri of pack.resources.evidence) {
      const evidenceResource = await client.request('resources/read', { uri });
      assert.equal(evidenceResource.error, undefined);
      const evidenceJson = JSON.parse(evidenceResource.result.contents[0].text) as { id: string };
      assert.ok(pack.evidence.some((item) => item.id === evidenceJson.id));
    }
    const packResource = await client.request('resources/read', { uri: pack.resourceUri });
    assert.equal(packResource.error, undefined);
    const persistedPack = JSON.parse(packResource.result.contents[0].text) as {
      contextPackId: string;
      reused: boolean;
      context: unknown[];
      evidence: unknown[];
    };
    assert.equal(persistedPack.contextPackId, pack.contextPackId);
    assert.equal(persistedPack.reused, false);
    assert.equal(persistedPack.context.length, pack.context.length);
    assert.equal(persistedPack.evidence.length, pack.evidence.length);
    const packRows = contextPackRows(repoRoot);
    assert.equal(packRows.length, 1);
    assert.equal(packRows[0]!.id, pack.contextPackId);
    const telemetryRuns = contextToolRuns(repoRoot);
    assert.equal(telemetryRuns.length, 1);
    assert.equal(telemetryRuns[0]!.tool_name, 'parallax_context_for_change');
    assert.equal(telemetryRuns[0]!.budget, 'brief');
    assert.equal(telemetryRuns[0]!.query, null);
    assert.deepEqual(JSON.parse(telemetryRuns[0]!.changed_files_json), ['src/a.ts']);
    assert.equal(telemetryRuns[0]!.index_run_id, pack.indexRunId);
    assert.ok(telemetryRuns[0]!.returned_bytes > 0);
    assert.equal(telemetryRuns[0]!.resource_count, pack.resources.entities.length + pack.resources.evidence.length + 2);
    assert.deepEqual(JSON.parse(telemetryRuns[0]!.omitted_json), pack.omittedCounts);
    const telemetryAccesses = contextResourceAccesses(repoRoot);
    assert.equal(telemetryAccesses.length, pack.resources.evidence.length + 1);
    assert.equal(telemetryAccesses.filter((item) => item.resource_kind === 'evidence').length, pack.resources.evidence.length);
    assert.equal(telemetryAccesses.filter((item) => item.resource_kind === 'context_pack').length, 1);
    assert.ok(telemetryAccesses.every((item) => item.index_run_id === pack.indexRunId));
    assert.ok(telemetryAccesses.every((item) => item.returned_bytes > 0));
    assert.equal(pack.limits.affectedLimit, 5);
    assert.equal(pack.limits.evidenceLimit, 5);
    assert.equal(pack.omittedCounts.affected, 0);
    assert.equal(countReports(repoRoot), 0);
    const filterWalAux = (names: string[]): string[] =>
      names.filter((name) => !/\.db-(wal|shm)$/.test(name));
    assert.deepEqual(filterWalAux(dbArtifacts(repoRoot)), filterWalAux(artifactsBefore));
    assert.equal(existsSync(path.join(repoRoot, '.parallax/reports')), false);
  } finally {
    await client.close();
  }
});

test('MCP context_for_change includes body-free work artifact previews', async () => {
  const repoRoot = await makeMcpWorkArtifactRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();
    const response = await client.request('tools/call', {
      name: 'parallax_context_for_change',
      arguments: { changedFiles: ['src/auth/session.ts'], budget: 'brief' }
    });

    assert.equal(response.error, undefined);
    const pack = JSON.parse(response.result.content[0].text) as {
      workArtifacts: Array<{
        kind: string;
        path: string;
        displayName: string;
        resourceUri: string;
        metadata?: {
          title?: string;
          owner?: string;
          status?: string;
          updatedAt?: string;
          source?: string;
        };
        freshness: {
          state: string;
          label: string;
          thresholdDays: number;
          ageDays?: number;
        };
      }>;
      evidence: Array<{ snippet: string; file: string }>;
      resources: { entities: string[] };
      omittedCounts: { workArtifacts: number };
      limits: { workArtifactLimit: number };
    };

    const policy = pack.workArtifacts.find((item) => item.path === 'policies/security-auth.md');
    assert.equal(policy?.displayName, 'Security Auth Policy');
    assert.deepEqual(policy?.metadata, {
      title: 'Security Auth Policy',
      owner: 'security-platform',
      status: 'approved',
      updatedAt: '2000-01-01',
      source: 'frontmatter'
    });
    assert.equal(policy?.freshness.state, 'stale');
    assert.equal(policy?.freshness.thresholdDays, 90);
    assert.ok((policy?.freshness.ageDays ?? 0) > 90);
    assert.equal(policy?.resourceUri, `parallax://entities/${encodeURIComponent('file:policies/security-auth.md')}`);

    const decision = pack.workArtifacts.find((item) => item.path === 'docs/decisions/auth-session.md');
    assert.equal(decision?.metadata?.updatedAt, '2026-02-30');
    assert.equal(decision?.freshness.state, 'unknown');
    assert.equal(decision?.freshness.label, 'review date unknown');
    assert.equal(pack.omittedCounts.workArtifacts, 0);
    assert.equal(pack.limits.workArtifactLimit, 5);
    assert.ok(pack.resources.entities.includes(policy!.resourceUri));
    assert.equal(JSON.stringify(pack).includes('PRIVATE BODY SENTENCE'), false);
    assert.equal(JSON.stringify(pack).includes('SECRET DECISION BODY'), false);
    assert.ok(pack.evidence.some((item) =>
      item.snippet === 'Work artifact evidence omitted from context pack. Fetch the entity or evidence resource for document details.'
    ));
  } finally {
    await client.close();
  }
});

test('MCP context_for_change reuses persisted context packs by reference', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();
    const firstResponse = await client.request('tools/call', {
      name: 'parallax_context_for_change',
      arguments: { changedFiles: ['src/a.ts'], budget: 'brief' }
    });
    assert.equal(firstResponse.error, undefined);
    const first = JSON.parse(firstResponse.result.content[0].text) as {
      contextPackId: string;
      resourceUri: string;
      reused: boolean;
      context: unknown[];
      evidence: unknown[];
      actions: unknown[];
      resources: { contextPack: string };
    };
    assert.equal(first.reused, false);
    assert.ok(first.context.length > 0);
    assert.equal(first.resources.contextPack, first.resourceUri);

    const secondResponse = await client.request('tools/call', {
      name: 'parallax_context_for_change',
      arguments: { changedFiles: ['src/a.ts'], budget: 'brief' }
    });
    assert.equal(secondResponse.error, undefined);
    const second = JSON.parse(secondResponse.result.content[0].text) as {
      kind: string;
      contextPackId: string;
      resourceUri: string;
      reused: boolean;
      resources: { contextPack: string };
      omittedCounts: { contextItems: number; workArtifacts: number; evidence: number; actions: number; fullContextPackBytes: number };
      context?: unknown[];
      workArtifacts?: unknown[];
      evidence?: unknown[];
      actions?: unknown[];
    };
    assert.equal(second.kind, 'context_pack_reference');
    assert.equal(second.reused, true);
    assert.equal(second.contextPackId, first.contextPackId);
    assert.equal(second.resourceUri, first.resourceUri);
    assert.equal(second.resources.contextPack, first.resourceUri);
    assert.equal(second.context, undefined);
    assert.equal(second.workArtifacts, undefined);
    assert.equal(second.evidence, undefined);
    assert.equal(second.actions, undefined);
    assert.equal(second.omittedCounts.contextItems, first.context.length);
    assert.equal(second.omittedCounts.evidence, first.evidence.length);
    assert.equal(second.omittedCounts.actions, first.actions.length);
    assert.ok(secondResponse.result.content[0].text.length < firstResponse.result.content[0].text.length);

    const packResource = await client.request('resources/read', { uri: first.resourceUri });
    assert.equal(packResource.error, undefined);
    const persisted = JSON.parse(packResource.result.contents[0].text) as {
      contextPackId: string;
      reused: boolean;
      context: unknown[];
      evidence: unknown[];
    };
    assert.equal(persisted.contextPackId, first.contextPackId);
    assert.equal(persisted.reused, false);
    assert.equal(persisted.context.length, first.context.length);
    assert.equal(persisted.evidence.length, first.evidence.length);

    const deepResponse = await client.request('tools/call', {
      name: 'parallax_context_for_change',
      arguments: { changedFiles: ['src/a.ts'], budget: 'deep' }
    });
    const deep = JSON.parse(deepResponse.result.content[0].text) as { contextPackId: string; reused: boolean };
    assert.notEqual(deep.contextPackId, first.contextPackId);
    assert.equal(deep.reused, false);

    await writeFile(path.join(repoRoot, 'src/a.ts'), 'import { b } from "./b";\nexport const a = b + 2;\n');
    const dirtyResponse = await client.request('tools/call', {
      name: 'parallax_context_for_change',
      arguments: { changedFiles: ['src/a.ts'], budget: 'brief' }
    });
    const dirty = JSON.parse(dirtyResponse.result.content[0].text) as { contextPackId: string; reused: boolean };
    assert.notEqual(dirty.contextPackId, first.contextPackId);
    assert.equal(dirty.reused, false);

    const rows = contextPackRows(repoRoot);
    assert.equal(rows.length, 3);
    assert.equal(rows.find((row) => row.id === first.contextPackId)?.hit_count, 2);
    assert.ok(contextResourceAccesses(repoRoot).some((item) =>
      item.resource_kind === 'context_pack' && item.resource_id === first.contextPackId
    ));
  } finally {
    await client.close();
  }
});

test('MCP context_for_change honors explicit context pack reuse policies', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();
    const firstResponse = await client.request('tools/call', {
      name: 'parallax_context_for_change',
      arguments: { changedFiles: ['src/a.ts'], budget: 'brief' }
    });
    const first = JSON.parse(firstResponse.result.content[0].text) as {
      contextPackId: string;
      resourceUri: string;
      reused: boolean;
      context: unknown[];
      evidence: unknown[];
    };
    assert.equal(first.reused, false);
    assert.ok(Array.isArray(first.context));

    const fullResponse = await client.request('tools/call', {
      name: 'parallax_context_for_change',
      arguments: { changedFiles: ['src/a.ts'], budget: 'brief', reusePolicy: 'full' }
    });
    const full = JSON.parse(fullResponse.result.content[0].text) as {
      kind?: string;
      contextPackId: string;
      resourceUri: string;
      reused: boolean;
      context: unknown[];
      evidence: unknown[];
    };
    assert.equal(full.kind, undefined);
    assert.equal(full.contextPackId, first.contextPackId);
    assert.equal(full.resourceUri, first.resourceUri);
    assert.equal(full.reused, false);
    assert.equal(full.context.length, first.context.length);
    assert.equal(full.evidence.length, first.evidence.length);

    const referenceRepo = await makeRepo();
    const referenceClient = new McpProcessClient(referenceRepo);
    try {
      await referenceClient.initialize();
      const referenceResponse = await referenceClient.request('tools/call', {
        name: 'parallax_context_for_change',
        arguments: { changedFiles: ['src/a.ts'], budget: 'brief', reusePolicy: 'reference' }
      });
      const reference = JSON.parse(referenceResponse.result.content[0].text) as {
        kind: string;
        contextPackId: string;
        resourceUri: string;
        reused: boolean;
        context?: unknown[];
        evidence?: unknown[];
      };
      assert.equal(reference.kind, 'context_pack_reference');
      assert.equal(reference.reused, true);
      assert.equal(reference.context, undefined);
      assert.equal(reference.evidence, undefined);
      const packResource = await referenceClient.request('resources/read', { uri: reference.resourceUri });
      assert.equal(packResource.error, undefined);
      const persisted = JSON.parse(packResource.result.contents[0].text) as {
        contextPackId: string;
        context: unknown[];
        evidence: unknown[];
      };
      assert.equal(persisted.contextPackId, reference.contextPackId);
      assert.ok(persisted.context.length > 0);
      assert.ok(persisted.evidence.length > 0);
      assert.equal(contextPackRows(referenceRepo).length, 1);
    } finally {
      await referenceClient.close();
    }
  } finally {
    await client.close();
  }
});

test('MCP context_for_change cache key tracks normalized inputs and index freshness', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();
    const orderedResponse = await client.request('tools/call', {
      name: 'parallax_context_for_change',
      arguments: { changedFiles: ['src/a.ts', 'src/b.ts'], budget: 'brief' }
    });
    const ordered = JSON.parse(orderedResponse.result.content[0].text) as {
      contextPackId: string;
      reused: boolean;
    };
    assert.equal(ordered.reused, false);

    const reversedResponse = await client.request('tools/call', {
      name: 'parallax_context_for_change',
      arguments: { changedFiles: ['src/b.ts', 'src/a.ts'], budget: 'brief' }
    });
    const reversed = JSON.parse(reversedResponse.result.content[0].text) as {
      kind: string;
      contextPackId: string;
      reused: boolean;
    };
    assert.equal(reversed.kind, 'context_pack_reference');
    assert.equal(reversed.contextPackId, ordered.contextPackId);
    assert.equal(reversed.reused, true);

    const depthResponse = await client.request('tools/call', {
      name: 'parallax_context_for_change',
      arguments: { changedFiles: ['src/a.ts', 'src/b.ts'], budget: 'brief', maxDepth: 2, maxFanout: 50 }
    });
    const depth = JSON.parse(depthResponse.result.content[0].text) as {
      contextPackId: string;
      reused: boolean;
    };
    assert.notEqual(depth.contextPackId, ordered.contextPackId);
    assert.equal(depth.reused, false);

    await indexProject({ repoRoot });
    const reindexedResponse = await client.request('tools/call', {
      name: 'parallax_context_for_change',
      arguments: { changedFiles: ['src/a.ts', 'src/b.ts'], budget: 'brief' }
    });
    const reindexed = JSON.parse(reindexedResponse.result.content[0].text) as {
      contextPackId: string;
      reused: boolean;
    };
    assert.notEqual(reindexed.contextPackId, ordered.contextPackId);
    assert.equal(reindexed.reused, false);

    const rowsBeforeBadInput = contextPackRows(repoRoot).length;
    const bad = await client.request('tools/call', {
      name: 'parallax_context_for_change',
      arguments: { changedFiles: ['../outside.ts'], budget: 'brief' }
    });
    assert.equal(bad.error, undefined);
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /outside repo root/);
    assert.equal(contextPackRows(repoRoot).length, rowsBeforeBadInput);
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
      name: 'parallax_search_context',
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
      name: 'parallax_context_telemetry',
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
    assert.equal(telemetry.toolRuns[0]!.toolName, 'parallax_search_context');
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
      name: 'parallax_analyze_diff',
      arguments: { changedFiles: ['src/a.ts'] }
    });
    assert.equal(analyzeResponse.error, undefined);

    const explainResponse = await client.request('tools/call', {
      name: 'parallax_explain_entity',
      arguments: { entity: 'file:src/a.ts', evidenceLimit: 1 }
    });
    assert.equal(explainResponse.error, undefined);

    const secretSearchResponse = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'sk-12345678901234567890', includeEvidence: false }
    });
    assert.equal(secretSearchResponse.error, undefined);

    const entityResource = await client.request('resources/read', {
      uri: `parallax://entities/${encodeURIComponent('file:src/a.ts')}`
    });
    assert.equal(entityResource.error, undefined);

    const coverageResource = await client.request('resources/read', {
      uri: 'parallax://coverage/latest'
    });
    assert.equal(coverageResource.error, undefined);

    const telemetryResponse = await client.request('tools/call', {
      name: 'parallax_context_telemetry',
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
    assert.deepEqual(toolByName.get('parallax_analyze_diff')!.changedFiles, ['src/a.ts']);
    assert.equal(toolByName.get('parallax_explain_entity')!.query, 'file:src/a.ts');
    assert.ok(toolByName.get('parallax_explain_entity')!.resourceCount > 0);
    assert.equal(toolByName.get('parallax_search_context')!.query, '[REDACTED_OPENAI_KEY]');
    const resourceKinds = new Set(telemetry.resourceAccesses.map((item) => item.resourceKind));
    assert.ok(resourceKinds.has('entity'));
    assert.ok(resourceKinds.has('coverage'));
    assert.ok(telemetry.resourceAccesses.every((item) => item.returnedBytes > 0));
    assert.equal(countReports(repoRoot), 0);
  } finally {
    await client.close();
  }
});

test('MCP parallax_co_change ranks coupled partners and records telemetry', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-mcp-cochange-'));
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'] });
  };
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  for (let round = 1; round <= 3; round++) {
    await writeFile(path.join(repoRoot, 'src/alpha.ts'), `export const alpha = ${round};\n`);
    await writeFile(path.join(repoRoot, 'src/beta.ts'), `export const beta = ${round};\n`);
    git(['add', '-A']);
    git(['commit', '-m', `round ${round}`]);
  }
  await initProject({ repoRoot });
  await indexProject({ repoRoot });

  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'parallax_co_change',
      arguments: { file: 'src/alpha.ts' }
    });
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const result = JSON.parse(response.result.content[0].text) as {
      file: string;
      indexRunId: number;
      partners: Array<{ path: string; coChangeCount: number; couplingScore: number; confidence: string }>;
      resources: { entities: string[] };
    };
    const beta = result.partners.find((partner) => partner.path === 'src/beta.ts');
    assert.ok(beta, `expected src/beta.ts coupled to alpha in ${JSON.stringify(result.partners)}`);
    assert.equal(beta.confidence, 'heuristic');
    assert.ok(result.resources.entities.includes('file:src/beta.ts'));

    const runs = contextToolRuns(repoRoot);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.tool_name, 'parallax_co_change');
    assert.equal(runs[0]!.query, 'src/alpha.ts');
    assert.equal(runs[0]!.index_run_id, result.indexRunId);
    assert.equal(runs[0]!.resource_count, result.resources.entities.length);
  } finally {
    await client.close();
  }
});

test('MCP parallax_query records telemetry with the query, index run, and entity resource count', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const cypher = "MATCH (a) WHERE a.path CONTAINS 'src/a.ts' RETURN a.id";
    const response = await client.request('tools/call', {
      name: 'parallax_query',
      arguments: { query: cypher }
    });
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const result = JSON.parse(response.result.content[0].text) as {
      columns: string[];
      rows: Array<Record<string, unknown>>;
      indexRunId: number;
      resources: { entities: string[] };
    };
    assert.ok(result.resources.entities.length > 0, 'an id projection should yield navigable entity resources');

    const runs = contextToolRuns(repoRoot);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.tool_name, 'parallax_query');
    assert.equal(runs[0]!.query, cypher);
    assert.equal(runs[0]!.index_run_id, result.indexRunId);
    assert.equal(runs[0]!.resource_count, result.resources.entities.length);
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
      name: 'parallax_analyze_diff',
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

    const uri = `parallax://entities/${encodeURIComponent(`file:${secretPath}`)}`;
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
      name: 'parallax_context_telemetry',
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
  const previous = process.env.PARALLAX_TELEMETRY_FORCE_FAILURE;
  process.env.PARALLAX_TELEMETRY_FORCE_FAILURE = '1';
  const client = new McpProcessClient(repoRoot);
  if (previous === undefined) {
    delete process.env.PARALLAX_TELEMETRY_FORCE_FAILURE;
  } else {
    process.env.PARALLAX_TELEMETRY_FORCE_FAILURE = previous;
  }
  try {
    await client.initialize();

    const searchResponse = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'src/a.ts', includeEvidence: false }
    });
    assert.equal(searchResponse.error, undefined);
    assert.equal(searchResponse.result.isError, undefined);
    const search = JSON.parse(searchResponse.result.content[0].text) as { results: Array<{ entity: { id: string } }> };
    assert.ok(search.results.some((item) => item.entity.id === 'file:src/a.ts'));

    const entityResponse = await client.request('resources/read', {
      uri: `parallax://entities/${encodeURIComponent('file:src/a.ts')}`
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
      name: 'parallax_context_for_change',
      arguments: { changedFiles: ['src/a.ts'], budget: 'brief' }
    });
    const deepResponse = await client.request('tools/call', {
      name: 'parallax_context_for_change',
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
      name: 'parallax_context_for_change',
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
      name: 'parallax_search_context',
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
    assert.equal(search.results[0]!.resourceUri, `parallax://entities/${encodeURIComponent('file:src/a.ts')}`);
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
      name: 'parallax_search_context',
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
      name: 'parallax_search_context',
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
      name: 'parallax_search_context',
      arguments: { query: '   ' }
    });
    assert.equal(blank.error, undefined);
    assert.equal(blank.result.isError, true);
    assert.match(blank.result.content[0].text, /Too small|must not be empty/i);
    const blankEnvelope = JSON.parse(blank.result.content[0].text) as {
      error: { code: string; problem: string; cause: string; fix: string; evidence: unknown[] };
    };
    assert.equal(blankEnvelope.error.code, 'empty_search_query');
    assert.ok(blankEnvelope.error.cause.length > 0);
    assert.ok(blankEnvelope.error.fix.length > 0);

    assert.equal(countReports(repoRoot), 0);
    const filterWalAux = (names: string[]): string[] =>
      names.filter((name) => !/\.db-(wal|shm)$/.test(name));
    assert.deepEqual(filterWalAux(dbArtifacts(repoRoot)), filterWalAux(artifactsBefore));
    assert.equal(existsSync(path.join(repoRoot, '.parallax/reports')), false);
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
        name: 'parallax_search_context',
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
      name: 'parallax_search_context',
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
      name: 'parallax_search_context',
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
      name: 'parallax_search_context',
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
      name: 'parallax_search_context',
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
      semanticRank: null,
      graphProximityRank: null,
      rrfScore: search.results[0]!.rankSignals.rrfScore
    });
    assert.deepEqual(search.results[1]!.rankSignals, {
      algorithm: 'rrf',
      keywordRank: 38,
      relationRank: 35,
      evidenceRank: 35,
      semanticRank: null,
      graphProximityRank: null,
      rrfScore: search.results[1]!.rankSignals.rrfScore
    });
  } finally {
    await client.close();
  }
});

test('MCP search_context fuses FTS, semantic, and graph proximity rank signals', async () => {
  const repoRoot = await makeSearchDepthRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const ftsResponse = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'token validator', k: 5, includeEvidence: false }
    });
    assert.equal(ftsResponse.error, undefined);
    assert.equal(ftsResponse.result.isError, undefined);
    const ftsSearch = JSON.parse(ftsResponse.result.content[0].text) as {
      results: Array<{
        entity: { id: string };
        reasons: string[];
        rankSignals: {
          keywordRank: number | null;
          semanticRank: number | null;
          graphProximityRank: number | null;
        };
      }>;
    };
    const root = ftsSearch.results.find((item) => item.entity.id === 'file:depth/root.ts');
    assert.ok(root, 'FTS should match non-contiguous query terms that LIKE misses');
    assert.equal(root.rankSignals.keywordRank, 1);
    assert.ok(root.reasons.includes('keyword'));

    const neighbor = ftsSearch.results.find((item) => item.entity.id === 'file:depth/session.ts');
    assert.ok(neighbor, 'graph proximity should pull one-hop neighbors of keyword hits');
    assert.equal(neighbor.rankSignals.keywordRank, null);
    assert.ok(neighbor.rankSignals.graphProximityRank !== null);
    assert.ok(neighbor.reasons.includes('graph-proximity'));

    const semanticResponse = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'retry idempotent checkout signal', k: 5, includeEvidence: false }
    });
    assert.equal(semanticResponse.error, undefined);
    assert.equal(semanticResponse.result.isError, undefined);
    const semanticSearch = JSON.parse(semanticResponse.result.content[0].text) as {
      results: Array<{
        entity: { id: string };
        reasons: string[];
        rankSignals: {
          keywordRank: number | null;
          semanticRank: number | null;
          graphProximityRank: number | null;
        };
      }>;
    };
    const semantic = semanticSearch.results.find((item) => item.entity.id === 'file:depth/semantic.ts');
    assert.ok(semantic, 'semantic lane should map embedded facts back to indexed entities');
    assert.equal(semantic.rankSignals.keywordRank, null);
    assert.equal(semantic.rankSignals.semanticRank, 1);
    assert.ok(semantic.reasons.includes('semantic'));
  } finally {
    await client.close();
  }
});

test('MCP search_context searches persistent evidence and fact FTS projections', async () => {
  const repoRoot = await makeSearchDepthRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const evidenceResponse = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'rotation policy', k: 3, includeEvidence: false }
    });
    assert.equal(evidenceResponse.error, undefined);
    assert.equal(evidenceResponse.result.isError, undefined);
    const evidenceSearch = JSON.parse(evidenceResponse.result.content[0].text) as {
      results: Array<{
        entity: { id: string };
        reasons: string[];
        rankSignals: { keywordRank: number | null; evidenceRank: number | null };
      }>;
    };
    const evidenceMatch = evidenceSearch.results.find((item) => item.entity.id === 'file:depth/evidence.ts');
    assert.ok(evidenceMatch, 'persistent evidence FTS should match non-contiguous evidence terms');
    assert.equal(evidenceMatch.rankSignals.keywordRank, null);
    assert.equal(evidenceMatch.rankSignals.evidenceRank, 1);
    assert.ok(evidenceMatch.reasons.includes('evidence:1'));

    const factResponse = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'operator retention', k: 3, includeEvidence: false }
    });
    assert.equal(factResponse.error, undefined);
    assert.equal(factResponse.result.isError, undefined);
    const factSearch = JSON.parse(factResponse.result.content[0].text) as {
      results: Array<{
        entity: { id: string };
        reasons: string[];
        rankSignals: { keywordRank: number | null; evidenceRank: number | null };
      }>;
    };
    const factMatch = factSearch.results.find((item) => item.entity.id === 'file:depth/fact.ts');
    assert.ok(factMatch, 'persistent facts FTS should match non-contiguous fact terms');
    assert.equal(factMatch.rankSignals.keywordRank, null);
    assert.equal(factMatch.rankSignals.evidenceRank, 1);
    assert.ok(factMatch.reasons.includes('facts:1'));

    const branchResponse = await client.request('tools/call', {
      name: 'parallax_branch',
      arguments: { name: 'experimental-search' }
    });
    assert.equal(branchResponse.error, undefined);
    assert.equal(branchResponse.result.isError, undefined);

    const branchSupersedingResponse = await client.request('tools/call', {
      name: 'parallax_remember',
      arguments: {
        branch: 'experimental-search',
        entity: 'file:depth/fact.ts',
        attribute: 'session_summary',
        value: 'experimental replacement guard',
        supersedesFactIds: ['depth-fact-fts']
      }
    });
    assert.equal(branchSupersedingResponse.error, undefined);
    assert.equal(branchSupersedingResponse.result.isError, undefined);

    const branchOnlyFactResponse = await client.request('tools/call', {
      name: 'parallax_remember',
      arguments: {
        branch: 'experimental-search',
        entity: 'file:depth/root.ts',
        attribute: 'session_summary',
        value: 'branch-only hidden sentinel'
      }
    });
    assert.equal(branchOnlyFactResponse.error, undefined);
    assert.equal(branchOnlyFactResponse.result.isError, undefined);

    const branchOnlySearchResponse = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'branch-only hidden sentinel', k: 3, includeEvidence: false }
    });
    const branchOnlySearch = JSON.parse(branchOnlySearchResponse.result.content[0].text) as {
      results: Array<{ entity: { id: string }; reasons: string[] }>;
    };
    assert.equal(
      branchOnlySearch.results.some((item) => item.entity.id === 'file:depth/root.ts'),
      false,
      'default search_context must not surface branch-only memory facts'
    );

    const mainScopedFactResponse = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'operator retention', k: 3, includeEvidence: false }
    });
    const mainScopedFactSearch = JSON.parse(mainScopedFactResponse.result.content[0].text) as {
      results: Array<{ entity: { id: string }; reasons: string[] }>;
    };
    const mainScopedFactMatch = mainScopedFactSearch.results.find(
      (item) => item.entity.id === 'file:depth/fact.ts'
    );
    assert.equal(
      mainScopedFactMatch?.reasons.some((reason) => reason.startsWith('facts:')) ?? false,
      true,
      'experimental branch supersession must not hide main search_context facts'
    );

    const supersedingFactResponse = await client.request('tools/call', {
      name: 'parallax_remember',
      arguments: {
        entity: 'file:depth/fact.ts',
        attribute: 'session_summary',
        value: 'operator memory keeps replacement guard',
        supersedesFactIds: ['depth-fact-fts']
      }
    });
    assert.equal(supersedingFactResponse.error, undefined);
    assert.equal(supersedingFactResponse.result.isError, undefined);

    const supersededFactResponse = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'retention', k: 3, includeEvidence: false }
    });
    const supersededFactSearch = JSON.parse(supersededFactResponse.result.content[0].text) as {
      results: Array<{ entity: { id: string }; reasons: string[] }>;
    };
    const supersededFactMatch = supersededFactSearch.results.find(
      (item) => item.entity.id === 'file:depth/fact.ts'
    );
    assert.equal(
      supersededFactMatch?.reasons.some((reason) => reason.startsWith('facts:')) ?? false,
      false,
      'facts FTS should not surface facts superseded by a visible replacement'
    );
  } finally {
    await client.close();
  }
});

test('MCP search_context semantic lane sees replacements made visible by supersession edge txs', async () => {
  const repoRoot = await makeSearchDepthRepo();
  const db = openDatabase(repoRoot);
  try {
    const repo = db.prepare('SELECT id FROM repos LIMIT 1').get() as { id: number };
    const run = db
      .prepare('SELECT id FROM index_runs WHERE repo_id = ? AND status = ? ORDER BY id DESC LIMIT 1')
      .get(repo.id, 'completed') as { id: number };
    db.prepare(`
      INSERT INTO entities (
        id, repo_id, kind, path, symbol, language_id, display_name,
        created_index_run_id, updated_index_run_id
      )
      VALUES ('file:depth/archived-semantic.ts', ?, 'file', 'depth/archived-semantic.ts', NULL, 'typescript', 'Archived Semantic', ?, ?)
    `).run(repo.id, run.id, run.id);
    db.prepare("INSERT OR IGNORE INTO attribute_defs (name, value_type, is_code_relation, description) VALUES ('session_summary', 'json', 0, '')").run();
    db.prepare(`
      INSERT INTO branches (id, name, head_tx_id, parent_branch_id, created_at, state)
      VALUES ('br_archived_semantic', 'archived-semantic', 'tx:archived-semantic-replacement', 'br_main', datetime('now'), 'abandoned')
    `).run();
    db.prepare(`
      INSERT INTO transactions (id, parent_tx_id, branch_id, ts, agent, index_run_id, archived)
      VALUES ('tx:archived-semantic-old', NULL, 'br_main', datetime('now'), 'test', ?, 0)
    `).run(run.id);
    db.prepare(`
      INSERT INTO transactions (id, parent_tx_id, branch_id, ts, agent, index_run_id, archived)
      VALUES ('tx:archived-semantic-replacement', NULL, 'br_archived_semantic', datetime('now'), 'test', ?, 1)
    `).run(run.id);
    db.prepare(`
      INSERT INTO transactions (id, parent_tx_id, branch_id, ts, agent, index_run_id, archived)
      VALUES ('tx:archived-semantic-edge', 'tx:archived-semantic-old', 'br_main', datetime('now'), 'test', ?, 0)
    `).run(run.id);
    db.prepare(`
      INSERT INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted)
      VALUES ('fact:archived-semantic-old', 'file:depth/archived-semantic.ts', 'session_summary', '"archived semantic retries twice"', 'assert', 'tx:archived-semantic-old', 0)
    `).run();
    insertFactEmbedding(db, 'fact:archived-semantic-old', 'archived semantic retries twice');
    const replacementValue = 'archived semantic replacement exact vector';
    db.prepare(`
      INSERT INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted)
      VALUES ('fact:archived-semantic-replacement', 'file:depth/archived-semantic.ts', 'session_summary', ?, 'assert', 'tx:archived-semantic-replacement', 0)
    `).run(JSON.stringify(replacementValue));
    insertFactEmbedding(db, 'fact:archived-semantic-replacement', replacementValue);
    db.prepare(`
      INSERT INTO fact_provenance (id, fact_id, source_fact_id, kind, tx_id)
      VALUES ('prov:archived-semantic-supersedes', 'fact:archived-semantic-replacement', 'fact:archived-semantic-old', 'supersedes', 'tx:archived-semantic-edge')
    `).run();
  } finally {
    db.close();
  }

  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();
    const response = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: {
        query: 'archived semantic replacement exact vector',
        k: 5,
        includeEvidence: false
      }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const search = JSON.parse(response.result.content[0].text) as {
      results: Array<{
        entity: { id: string };
        reasons: string[];
        rankSignals: { semanticRank: number | null };
      }>;
    };
    const match = search.results.find((item) => item.entity.id === 'file:depth/archived-semantic.ts');
    assert.ok(match, 'semantic lane should include archived-origin replacements visible through main supersession edges');
    assert.equal(match.rankSignals.semanticRank, 1);
    assert.ok(match.reasons.includes('semantic'));

  } finally {
    await client.close();
  }
});

test('MCP search_context semantic lane hides facts superseded by visible main edges', async () => {
  const repoRoot = await makeSearchDepthRepo();
  const db = openDatabase(repoRoot);
  try {
    const repo = db.prepare('SELECT id FROM repos LIMIT 1').get() as { id: number };
    const run = db
      .prepare('SELECT id FROM index_runs WHERE repo_id = ? AND status = ? ORDER BY id DESC LIMIT 1')
      .get(repo.id, 'completed') as { id: number };
    db.prepare(`
      INSERT INTO entities (
        id, repo_id, kind, path, symbol, language_id, display_name,
        created_index_run_id, updated_index_run_id
      )
      VALUES
        ('file:depth/superseded-semantic-old.ts', ?, 'file', 'depth/superseded-semantic-old.ts', NULL, 'typescript', 'Superseded Semantic Old', ?, ?),
        ('file:depth/superseded-semantic-new.ts', ?, 'file', 'depth/superseded-semantic-new.ts', NULL, 'typescript', 'Superseded Semantic New', ?, ?)
    `).run(repo.id, run.id, run.id, repo.id, run.id, run.id);
    db.prepare("INSERT OR IGNORE INTO attribute_defs (name, value_type, is_code_relation, description) VALUES ('session_summary', 'json', 0, '')").run();
    db.prepare(`
      INSERT INTO transactions (id, parent_tx_id, branch_id, ts, agent, index_run_id, archived)
      VALUES ('tx:semantic-superseded-old', NULL, 'br_main', datetime('now'), 'test', ?, 0)
    `).run(run.id);
    db.prepare(`
      INSERT INTO transactions (id, parent_tx_id, branch_id, ts, agent, index_run_id, archived)
      VALUES ('tx:semantic-superseded-new', 'tx:semantic-superseded-old', 'br_main', datetime('now'), 'test', ?, 0)
    `).run(run.id);
    const oldValue = 'semantic old hidden exact vector';
    db.prepare(`
      INSERT INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted)
      VALUES ('fact:semantic-superseded-old', 'file:depth/superseded-semantic-old.ts', 'session_summary', ?, 'assert', 'tx:semantic-superseded-old', 0)
    `).run(JSON.stringify(oldValue));
    db.prepare(`
      INSERT INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted)
      VALUES ('fact:semantic-superseded-new', 'file:depth/superseded-semantic-new.ts', 'session_summary', '"semantic replacement visible marker"', 'assert', 'tx:semantic-superseded-new', 0)
    `).run();
    insertFactEmbedding(db, 'fact:semantic-superseded-old', oldValue);
    insertFactEmbedding(db, 'fact:semantic-superseded-new', 'semantic replacement visible marker');
    db.prepare(`
      INSERT INTO fact_provenance (id, fact_id, source_fact_id, kind, tx_id)
      VALUES ('prov:semantic-supersedes-old', 'fact:semantic-superseded-new', 'fact:semantic-superseded-old', 'supersedes', 'tx:semantic-superseded-new')
    `).run();
  } finally {
    db.close();
  }

  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();
    const response = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: {
        query: 'semantic old hidden exact vector',
        k: 5,
        includeEvidence: false
      }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const search = JSON.parse(response.result.content[0].text) as {
      results: Array<{ entity: { id: string }; rankSignals: { semanticRank: number | null } }>;
    };
    assert.equal(
      search.results.some(
        (item) => item.entity.id === 'file:depth/superseded-semantic-old.ts' && item.rankSignals.semanticRank !== null
      ),
      false,
      'semantic lane should not surface old facts superseded by a visible main edge'
    );
  } finally {
    await client.close();
  }
});

test('MCP search_context returns schema_outdated for pre-v16 read-only databases', async () => {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: false });
  try {
    db.prepare('DELETE FROM schema_versions WHERE version >= 16').run();
  } finally {
    db.close();
  }

  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();
    const response = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'anything', k: 3, includeEvidence: false }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, true);
    const envelope = JSON.parse(response.result.content[0].text) as {
      error: { code: string; problem: string; fix: string };
    };
    assert.equal(envelope.error.code, 'schema_outdated');
    assert.match(envelope.error.problem, /schema v16/);
    assert.match(envelope.error.fix, /parallax init/);
  } finally {
    await client.close();
  }
});

test('MCP search_context semantic lane scores beyond the stream cap before ranking', async () => {
  const repoRoot = await makeLargeSemanticRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'late semantic target exact checkout vector', k: 1, includeEvidence: false }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const search = JSON.parse(response.result.content[0].text) as {
      results: Array<{
        entity: { id: string };
        rankSignals: { keywordRank: number | null; semanticRank: number | null };
      }>;
    };
    assert.equal(search.results[0]!.entity.id, 'file:semantic/late-target.ts');
    assert.equal(search.results[0]!.rankSignals.keywordRank, null);
    assert.equal(search.results[0]!.rankSignals.semanticRank, 1);
  } finally {
    await client.close();
  }
});

test('MCP search_context semantic lane falls back when the sqlite-vec table is absent', async () => {
  const repoRoot = await makeLargeSemanticRepo();
  const db = openDatabase(repoRoot);
  try {
    if (isVectorExtensionLoaded(db) && hasVecTable(db, STUB_MODEL_NAME)) {
      db.exec(`DROP TABLE ${vecTableName(STUB_MODEL_NAME)}`);
    }
  } finally {
    db.close();
  }

  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'late semantic target exact checkout vector', k: 1, includeEvidence: false }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const search = JSON.parse(response.result.content[0].text) as {
      results: Array<{
        entity: { id: string };
        rankSignals: { keywordRank: number | null; semanticRank: number | null };
      }>;
    };
    assert.equal(search.results[0]!.entity.id, 'file:semantic/late-target.ts');
    assert.equal(search.results[0]!.rankSignals.keywordRank, null);
    assert.equal(search.results[0]!.rankSignals.semanticRank, 1);
  } finally {
    await client.close();
  }
});

test('MCP search_context semantic lane falls back when the sqlite-vec table is empty', async () => {
  const repoRoot = await makeLargeSemanticRepo();
  const db = openDatabase(repoRoot);
  try {
    if (isVectorExtensionLoaded(db) && hasVecTable(db, STUB_MODEL_NAME)) {
      db.exec(`DELETE FROM ${vecTableName(STUB_MODEL_NAME)}`);
    }
  } finally {
    db.close();
  }

  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'late semantic target exact checkout vector', k: 1, includeEvidence: false }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const search = JSON.parse(response.result.content[0].text) as {
      results: Array<{
        entity: { id: string };
        rankSignals: { keywordRank: number | null; semanticRank: number | null };
      }>;
    };
    assert.equal(search.results[0]!.entity.id, 'file:semantic/late-target.ts');
    assert.equal(search.results[0]!.rankSignals.keywordRank, null);
    assert.equal(search.results[0]!.rankSignals.semanticRank, 1);
  } finally {
    await client.close();
  }
});

test('MCP search_context caps broad LIKE candidate streams before final RRF fusion', async () => {
  const repoRoot = await makeBroadSearchRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'BROAD_CAP', k: 1, includeEvidence: false }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const search = JSON.parse(response.result.content[0].text) as {
      counts: { matchedEntitiesLowerBound: number };
      limits: { truncated: boolean };
    };
    assert.equal(search.counts.matchedEntitiesLowerBound, 500);
    assert.equal(search.limits.truncated, true);
  } finally {
    await client.close();
  }
});

test('MCP search_context brief budget reports returned bytes and omitted entities', async () => {
  const repoRoot = await makeWideContextRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'src/a.ts', k: 10, includeEvidence: true, budget: 'brief' }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const search = JSON.parse(response.result.content[0].text) as {
      results: Array<{ evidence: unknown[] }>;
      limits: {
        budget: string;
        returnedBytes: number;
        returnedBytesLimit: number;
        estimatedTokens: number;
        estimatedTokensLimit: number;
      };
      omittedCounts: { entities: number; evidence: number };
      counts: { returnedEntities: number; matchedEntitiesLowerBound: number };
    };
    assert.equal(search.limits.budget, 'brief');
    assert.ok(search.limits.returnedBytes <= search.limits.returnedBytesLimit);
    assert.ok(search.limits.estimatedTokens <= search.limits.estimatedTokensLimit);
    assert.ok(search.counts.returnedEntities < search.counts.matchedEntitiesLowerBound);
    assert.ok(search.omittedCounts.entities > 0);
    assert.ok(search.omittedCounts.evidence > 0);
    assert.ok(search.results.every((item) => item.evidence.length <= 2));
  } finally {
    await client.close();
  }
});

test('MCP search_context exposes all search budget presets', async () => {
  const repoRoot = await makeWideContextRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    for (const [budget, returnedBytesLimit, estimatedTokensLimit] of [
      ['standard', 12_000, 3_000],
      ['deep', 30_000, 7_500]
    ] as const) {
      const response = await client.request('tools/call', {
        name: 'parallax_search_context',
        arguments: { query: 'src/a.ts', k: 3, includeEvidence: true, budget }
      });

      assert.equal(response.error, undefined);
      assert.equal(response.result.isError, undefined);
      const search = JSON.parse(response.result.content[0].text) as {
        limits: {
          budget: string;
          returnedBytes: number;
          returnedBytesLimit: number;
          estimatedTokens: number;
          estimatedTokensLimit: number;
        };
      };
      assert.equal(search.limits.budget, budget);
      assert.equal(search.limits.returnedBytesLimit, returnedBytesLimit);
      assert.equal(search.limits.estimatedTokensLimit, estimatedTokensLimit);
      assert.ok(search.limits.returnedBytes <= returnedBytesLimit);
      assert.ok(search.limits.estimatedTokens <= estimatedTokensLimit);
    }
  } finally {
    await client.close();
  }
});

test('MCP search_context trims evidence before violating a single-result byte budget', async () => {
  const repoRoot = await makeHugeEvidenceRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'HUGE_EVIDENCE_MARKER', k: 1, includeEvidence: true, budget: 'brief' }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const text = response.result.content[0].text as string;
    const search = JSON.parse(text) as {
      results: Array<{ evidence: unknown[] }>;
      limits: { returnedBytes: number; returnedBytesLimit: number; budgetExceeded: boolean };
      omittedCounts: { entities: number; evidence: number };
    };
    assert.ok(Buffer.byteLength(text, 'utf8') <= search.limits.returnedBytesLimit);
    assert.ok(search.limits.returnedBytes <= search.limits.returnedBytesLimit);
    assert.equal(search.limits.budgetExceeded, false);
    assert.deepEqual(search.results[0]!.evidence, []);
    assert.equal(search.omittedCounts.evidence, 1);
  } finally {
    await client.close();
  }
});

test('MCP search_context reports final bytes when one entity cannot fit budget', async () => {
  const repoRoot = await makeUnavoidableBudgetRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'unavoidable', k: 1, includeEvidence: false, budget: 'brief' }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const text = response.result.content[0].text as string;
    const search = JSON.parse(text) as {
      limits: { returnedBytes: number; returnedBytesLimit: number; budgetExceeded: boolean };
      counts: { returnedEntities: number };
    };
    assert.equal(search.counts.returnedEntities, 1);
    assert.equal(search.limits.budgetExceeded, true);
    assert.ok(search.limits.returnedBytes > search.limits.returnedBytesLimit);
    assert.equal(search.limits.returnedBytes, Buffer.byteLength(text, 'utf8'));
  } finally {
    await client.close();
  }
});

test('MCP search_context reports exact final bytes at the budgetExceeded boundary', async () => {
  const repoRoot = await makeBoundaryBudgetRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'boundary', k: 1, includeEvidence: false, budget: 'brief' }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const text = response.result.content[0].text as string;
    const search = JSON.parse(text) as {
      limits: { returnedBytes: number; returnedBytesLimit: number; budgetExceeded: boolean };
    };
    assert.equal(search.limits.returnedBytes, Buffer.byteLength(text, 'utf8'));
    assert.equal(search.limits.returnedBytes, search.limits.returnedBytesLimit);
    assert.equal(search.limits.budgetExceeded, true);
  } finally {
    await client.close();
  }
});

test('MCP search_context diversifies ranked entities by path, entity kind, and relation kind', async () => {
  const repoRoot = await makeDiversificationRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('tools/call', {
      name: 'parallax_search_context',
      arguments: { query: 'DIVERSIFY_MARKER', k: 5, includeEvidence: false, budget: 'deep' }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    const search = JSON.parse(response.result.content[0].text) as {
      results: Array<{ entity: { id: string; kind: string; path: string }; rankSignals: { relationRank: number | null } }>;
    };
    const prefixes = search.results.map((item) => item.entity.path?.split('/')[0]);
    const kinds = search.results.map((item) => item.entity.kind);
    const ids = search.results.map((item) => item.entity.id);
    assert.deepEqual(prefixes, ['src', 'src', 'src', 'docs', 'tests']);
    assert.ok(kinds.includes('file'));
    assert.ok(kinds.includes('symbol'));
    assert.ok(ids.includes('symbol:src/diverse#handler'));
    assert.ok(ids.includes('file:src/diverse-doc-relation.ts'));
    assert.ok(ids.includes('file:docs/diverse.md'));
    assert.ok(ids.includes('file:tests/diverse.test.ts'));
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
      name: 'parallax_search_context',
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
      name: 'parallax_search_context',
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
    assert.ok(templateUris.includes('parallax://reports/{reportId}'));
    assert.ok(templateUris.includes('parallax://entities/{entityId}'));
    assert.ok(templateUris.includes('parallax://evidence/{evidenceId}'));
    assert.ok(templateUris.includes('parallax://context-packs/{contextPackId}'));
    assert.ok(templateUris.includes('parallax://reports/{reportId}/graph/{format}'));

    const resources = await client.request('resources/list', {});
    assert.equal(resources.error, undefined);
    const resourceUris = resources.result.resources.map((item: { uri: string }) => item.uri);
    assert.ok(resourceUris.includes(`parallax://reports/${report.id}`));
    assert.ok(resourceUris.includes(`parallax://evidence/${encodeURIComponent(evidence.id)}`));
    assert.ok(resourceUris.includes(`parallax://reports/${report.id}/graph/dot`));
    assert.ok(resourceUris.includes('parallax://coverage/latest'));

    const reportResource = await client.request('resources/read', {
      uri: `parallax://reports/${report.id}`
    });
    assert.equal(reportResource.error, undefined);
    const reportJson = JSON.parse(reportResource.result.contents[0].text) as { id: string };
    assert.equal(reportJson.id, report.id);

    const entityResource = await client.request('resources/read', {
      uri: `parallax://entities/${encodeURIComponent('file:src/a.ts')}`
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
      uri: `parallax://evidence/${encodeURIComponent(evidence.id)}`
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
      uri: 'parallax://evidence/not-found'
    });
    assert.ok(missingEvidence.error);
    assert.match(missingEvidence.error.message, /impact evidence not found/);
    const missingEvidenceEnvelope = JSON.parse(missingEvidence.error.message) as {
      error: { code: string; problem: string; cause: string; fix: string; evidence: unknown[] };
    };
    assert.equal(missingEvidenceEnvelope.error.code, 'resource_not_found');
    assert.match(missingEvidenceEnvelope.error.problem, /impact evidence not found/);
    assert.ok(missingEvidenceEnvelope.error.fix.length > 0);

    const missingContextPack = await client.request('resources/read', {
      uri: 'parallax://context-packs/not-found'
    });
    assert.ok(missingContextPack.error);
    const missingContextPackEnvelope = JSON.parse(missingContextPack.error.message) as {
      error: { code: string; problem: string; fix: string };
    };
    assert.equal(missingContextPackEnvelope.error.code, 'resource_not_found');
    assert.match(missingContextPackEnvelope.error.problem, /impact context pack not found/);
    assert.ok(missingContextPackEnvelope.error.fix.length > 0);

    const graphResource = await client.request('resources/read', {
      uri: `parallax://reports/${report.id}/graph/dot`
    });
    assert.equal(graphResource.error, undefined);
    assert.match(graphResource.result.contents[0].text, /^digraph parallax/);

    const unpagedGraphResource = await client.request('resources/read', {
      uri: `parallax://reports/${report.id}/graph/json`
    });
    assert.equal(unpagedGraphResource.error, undefined);
    const unpagedGraphJson = JSON.parse(unpagedGraphResource.result.contents[0].text) as {
      reportId: string;
      indexRunId: number;
      format: string;
      nodes: unknown[];
      edges: unknown[];
      page?: unknown;
    };
    assert.equal(unpagedGraphJson.reportId, report.id);
    assert.equal(unpagedGraphJson.indexRunId, report.indexRunId);
    assert.equal(unpagedGraphJson.format, 'json');
    assert.equal('page' in unpagedGraphJson, false);
    assert.ok(unpagedGraphJson.nodes.length > 0);
    assert.ok(unpagedGraphJson.edges.length > 0);

    const firstGraphPage = await client.request('resources/read', {
      uri: `parallax://reports/${report.id}/graph/json?limit=1`
    });
    assert.equal(firstGraphPage.error, undefined);
    const firstGraphJson = JSON.parse(firstGraphPage.result.contents[0].text) as {
      nodes: unknown[];
      edges: unknown[];
      page: {
        limit: number;
        totalNodes: number;
        totalEdges: number;
        returnedNodes: number;
        returnedEdges: number;
        nextCursor: string | null;
      };
    };
    assert.equal(firstGraphJson.page.limit, 1);
    assert.equal(firstGraphJson.nodes.length, 1);
    assert.ok(firstGraphJson.page.totalNodes > firstGraphJson.page.returnedNodes);
    assert.ok(firstGraphJson.page.nextCursor);

    const secondGraphPage = await client.request('resources/read', {
      uri: `parallax://reports/${report.id}/graph/json?limit=1&cursor=${encodeURIComponent(firstGraphJson.page.nextCursor!)}`
    });
    assert.equal(secondGraphPage.error, undefined);
    const secondGraphJson = JSON.parse(secondGraphPage.result.contents[0].text) as {
      nodes: Array<{ id: string }>;
      page: { cursor: string | null; limit: number };
    };
    assert.equal(secondGraphJson.page.cursor, firstGraphJson.page.nextCursor);
    assert.equal(secondGraphJson.page.limit, 1);
    assert.notEqual(secondGraphJson.nodes[0]?.id, (firstGraphJson.nodes[0] as { id: string }).id);

    const invalidCursor = await client.request('resources/read', {
      uri: `parallax://reports/${report.id}/graph/json?limit=1&cursor=${'9'.repeat(400)}:${'9'.repeat(400)}`
    });
    assert.ok(invalidCursor.error);
    const invalidCursorEnvelope = JSON.parse(invalidCursor.error.message) as {
      error: { code: string; problem: string; cause: string; fix: string; evidence: unknown[] };
    };
    assert.equal(invalidCursorEnvelope.error.code, 'invalid_pagination');
    assert.match(invalidCursorEnvelope.error.problem, /graph page cursor/);
    assert.ok(invalidCursorEnvelope.error.fix.length > 0);

    const invalidLimit = await client.request('resources/read', {
      uri: `parallax://reports/${report.id}/graph/json?limit=abc`
    });
    assert.ok(invalidLimit.error);
    const invalidLimitEnvelope = JSON.parse(invalidLimit.error.message) as {
      error: { code: string; problem: string; cause: string; fix: string; evidence: unknown[] };
    };
    assert.equal(invalidLimitEnvelope.error.code, 'invalid_pagination');
    assert.match(invalidLimitEnvelope.error.problem, /graph page limit/);
    assert.ok(invalidLimitEnvelope.error.fix.length > 0);

    const coverageResource = await client.request('resources/read', {
      uri: 'parallax://coverage/latest'
    });
    assert.equal(coverageResource.error, undefined);
    const coverageJson = JSON.parse(coverageResource.result.contents[0].text) as { coverage: unknown[]; truncated: boolean };
    assert.ok(coverageJson.coverage.length > 0);
    assert.equal(coverageJson.truncated, false);
  } finally {
    await client.close();
  }
});

test('MCP evidence resource rejects evidence outside the latest completed index', async () => {
  const repoRoot = await makeRepo();
  const staleEvidenceId = 'stale:evidence:old-run';
  const db = openDatabase(repoRoot);
  try {
    const repo = db.prepare('SELECT id FROM repos LIMIT 1').get() as { id: number };
    const oldRun = db
      .prepare('SELECT id FROM index_runs WHERE repo_id = ? AND status = ? ORDER BY id DESC LIMIT 1')
      .get(repo.id, 'completed') as { id: number };
    const relation = db
      .prepare('SELECT id FROM relations WHERE repo_id = ? AND index_run_id = ? LIMIT 1')
      .get(repo.id, oldRun.id) as { id: string } | undefined;
    assert.ok(relation, 'fixture should have a relation in the original completed index');
    db.prepare(`
      INSERT INTO relation_evidence (
        id, relation_id, repo_id, file_path, kind, snippet, confidence, index_run_id
      )
      VALUES (?, ?, ?, 'src/a.ts', 'DEPENDS_ON', 'stale evidence from an older index', 'medium', ?)
    `).run(staleEvidenceId, relation.id, repo.id, oldRun.id);
    db.prepare(`
      INSERT INTO index_runs (repo_id, status, started_at, finished_at, extractor_version)
      VALUES (?, 'completed', datetime('now'), datetime('now'), 'newer-empty-index')
    `).run(repo.id);
  } finally {
    db.close();
  }

  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();
    const response = await client.request('resources/read', {
      uri: `parallax://evidence/${encodeURIComponent(staleEvidenceId)}`
    });

    assert.ok(response.error);
    const envelope = JSON.parse(response.error.message) as {
      error: { code: string; problem: string; fix: string };
    };
    assert.equal(envelope.error.code, 'resource_not_found');
    assert.match(envelope.error.problem, /impact evidence not found/);
  } finally {
    await client.close();
  }
});

test('MCP coverage resource returns a typed error before the first completed index', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-mcp-coverage-error-'));
  await initProject({ repoRoot });
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const response = await client.request('resources/read', {
      uri: 'parallax://coverage/latest'
    });
    assert.ok(response.error);
    const envelope = JSON.parse(response.error.message) as {
      error: { code: string; problem: string; cause: string; fix: string; evidence: unknown[] };
    };
    assert.equal(envelope.error.code, 'index_not_ready');
    assert.match(envelope.error.problem, /no completed index found/);
    assert.ok(envelope.error.cause.length > 0);
    assert.ok(envelope.error.fix.length > 0);
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
      name: 'parallax_explain_entity',
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
    assert.equal(explanation.resources.entity, `parallax://entities/${encodeURIComponent('file:src/a.ts')}`);
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
      name: 'parallax_explain_entity',
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
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-mcp-uninit-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();
    const response = await client.request('tools/call', {
      name: 'parallax_analyze_diff',
      arguments: { changedFiles: ['src/a.ts'] }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /database not found|init and parallax index/);
    assert.equal(existsSync(path.join(repoRoot, '.parallax')), false);
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
      name: 'parallax_remember',
      arguments: {
        entity: 'file:src/a.ts',
        attribute: 'observed',
        value: 'compiled cleanly'
      }
    });

    assert.equal(remembered.error, undefined);
    assert.equal(remembered.result.isError, undefined);
    assertStructuredContentMirrorsText(remembered, 'parallax_remember');
    const rememberPayload = JSON.parse(remembered.result.content[0].text) as { factId: string; txId: string };
    assert.match(rememberPayload.factId, /^[0-9a-f]{64}$/);
    assert.match(rememberPayload.txId, /^[0-9a-f]{64}$/);

    const recalled = await client.request('tools/call', {
      name: 'parallax_recall',
      arguments: { entity: 'file:src/a.ts', attribute: 'observed' }
    });

    assert.equal(recalled.error, undefined);
    assertStructuredContentMirrorsText(recalled, 'parallax_recall');
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
      name: 'parallax_branch',
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
      name: 'parallax_branch',
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
      name: 'parallax_remember',
      arguments: {
        entity: 'file:src/a.ts',
        attribute: 'observed',
        value: 'export-symbol-a'
      }
    });
    const source = JSON.parse(sourceResp.result.content[0].text) as { factId: string };

    const derivedResp = await client.request('tools/call', {
      name: 'parallax_remember',
      arguments: {
        entity: 'file:src/b.ts',
        attribute: 'observed',
        value: 'imports-a',
        evidenceFactIds: [source.factId]
      }
    });
    const derived = JSON.parse(derivedResp.result.content[0].text) as { factId: string };

    const traced = await client.request('tools/call', {
      name: 'parallax_trace',
      arguments: { factId: derived.factId }
    });
    assert.equal(traced.error, undefined);
    const tracePayload = JSON.parse(traced.result.content[0].text) as {
      chain: Array<{ id: string }>;
    };
    const chainIds = tracePayload.chain.map((entry) => entry.id);
    assert.deepEqual(chainIds, [derived.factId, source.factId]);

    const missing = await client.request('tools/call', {
      name: 'parallax_trace',
      arguments: { factId: '0000000000000000000000000000000000000000000000000000000000000000' }
    });
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /fact not found/);
  } finally {
    await client.close();
  }
});

test('MCP trace reports schema_outdated for pre-v16 fact_provenance tables', async () => {
  const repoRoot = await makeRepo();
  let factId = '';
  const writer = new McpProcessClient(repoRoot);
  try {
    await writer.initialize();
    const remembered = await writer.request('tools/call', {
      name: 'parallax_remember',
      arguments: {
        entity: 'file:src/a.ts',
        attribute: 'observed',
        value: 'legacy trace guard'
      }
    });
    factId = (JSON.parse(remembered.result.content[0].text) as { factId: string }).factId;
  } finally {
    await writer.close();
  }

  downgradeFactProvenanceWithoutTxId(repoRoot);

  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();
    const response = await client.request('tools/call', {
      name: 'parallax_trace',
      arguments: { factId }
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, true);
    const envelope = JSON.parse(response.result.content[0].text) as {
      error: { code: string; problem: string; fix: string };
    };
    assert.equal(envelope.error.code, 'schema_outdated');
    assert.match(envelope.error.problem, /schema v16/);
    assert.doesNotMatch(envelope.error.problem, /no such column/);
    assert.match(envelope.error.fix, /parallax init/);
  } finally {
    await client.close();
  }
});

test('MCP remember supports explicit supersession and trace exposes the edge kind', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const oldResp = await client.request('tools/call', {
      name: 'parallax_remember',
      arguments: {
        entity: 'policy:checkout',
        attribute: 'decision',
        value: 'retry twice before fallback'
      }
    });
    const oldFact = JSON.parse(oldResp.result.content[0].text) as { factId: string };

    const newResp = await client.request('tools/call', {
      name: 'parallax_remember',
      arguments: {
        entity: 'policy:checkout',
        attribute: 'decision',
        value: 'retry once before fallback',
        supersedesFactIds: [oldFact.factId]
      }
    });
    const newFact = JSON.parse(newResp.result.content[0].text) as { factId: string };

    const recalled = await client.request('tools/call', {
      name: 'parallax_recall',
      arguments: { entity: 'policy:checkout', attribute: 'decision', currentOnly: true }
    });
    const recallPayload = JSON.parse(recalled.result.content[0].text) as {
      facts: Array<{ id: string; value: unknown }>;
    };
    assert.deepEqual(recallPayload.facts.map((fact) => fact.id), [newFact.factId]);
    assert.deepEqual(recallPayload.facts.map((fact) => fact.value), ['retry once before fallback']);

    const traced = await client.request('tools/call', {
      name: 'parallax_trace',
      arguments: { factId: newFact.factId }
    });
    const tracePayload = JSON.parse(traced.result.content[0].text) as {
      edges: Array<{ factId: string; sourceFactId: string; kind: string }>;
    };
    assert.deepEqual(tracePayload.edges, [
      { factId: newFact.factId, sourceFactId: oldFact.factId, kind: 'supersedes' }
    ]);
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
      name: 'parallax_remember',
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
      name: 'parallax_abandon_branch',
      arguments: { name: 'main' }
    });
    assert.equal(refuseMain.result.isError, true);
    assert.match(refuseMain.result.content[0].text, /cannot abandon protected branch/);

    const branchResp = await client.request('tools/call', {
      name: 'parallax_branch',
      arguments: { name: 'mcp-spec' }
    });
    assert.equal(branchResp.result.isError, undefined);

    const rememberResp = await client.request('tools/call', {
      name: 'parallax_remember',
      arguments: {
        branch: 'mcp-spec',
        entity: 'file:src/spec.ts',
        attribute: 'observed',
        value: 'spec-fact'
      }
    });
    assert.equal(rememberResp.result.isError, undefined);

    const abandonResp = await client.request('tools/call', {
      name: 'parallax_abandon_branch',
      arguments: { name: 'mcp-spec' }
    });
    const abandonPayload = JSON.parse(abandonResp.result.content[0].text) as {
      state: string;
      alreadyAbandoned: boolean;
    };
    assert.equal(abandonPayload.state, 'abandoned');
    assert.equal(abandonPayload.alreadyAbandoned, false);

    const dryGcResp = await client.request('tools/call', {
      name: 'parallax_gc_branches',
      arguments: { dryRun: true }
    });
    const dryGcPayload = JSON.parse(dryGcResp.result.content[0].text) as {
      dryRun: boolean;
      archivedTransactions: number;
    };
    assert.equal(dryGcPayload.dryRun, true);
    assert.equal(dryGcPayload.archivedTransactions, 1);

    const gcResp = await client.request('tools/call', {
      name: 'parallax_gc_branches',
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
        name: 'parallax_remember',
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
      name: 'parallax_reflect',
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

const mcpPromptDocFiles = ['docs/mcp.md', 'docs/mcp.ko.md', 'docs/mcp.zh.md'];

function documentedMcpPrompts(filePath: string): string[] {
  const markdown = readFileSync(path.resolve(filePath), 'utf8');
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## MCP prompts');
  assert.notEqual(start, -1, `${filePath} must have a ## MCP prompts section`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const section = lines.slice(start + 1, end === -1 ? lines.length : end);
  const names: string[] = [];
  for (const line of section) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    const name = cells[0]?.match(/^`([a-z_]+)`$/)?.[1];
    if (name) {
      names.push(name);
    }
  }
  assert.ok(names.length > 0, `${filePath} MCP prompts table must document prompts`);
  return names;
}

test('MCP server exposes workflow prompts that match the docs and reference real tools', async () => {
  const repoRoot = await makeRepo();
  const client = new McpProcessClient(repoRoot);
  try {
    await client.initialize();

    const listed = await client.request('prompts/list', {});
    assert.equal(listed.error, undefined);
    const prompts = listed.result.prompts as Array<{ name: string; description?: string }>;
    const promptNames = prompts.map((prompt) => prompt.name).sort();
    assert.deepEqual(promptNames, ['impact_workflow', 'triage_change']);

    for (const filePath of mcpPromptDocFiles) {
      assert.deepEqual(
        documentedMcpPrompts(filePath).sort(),
        promptNames,
        `${filePath} MCP prompts table must match prompts/list`
      );
    }

    const got = await client.request('prompts/get', {
      name: 'impact_workflow',
      arguments: { changedFiles: 'src/store.ts' }
    });
    assert.equal(got.error, undefined);
    const messages = got.result.messages as Array<{
      role: string;
      content: { type: string; text: string };
    }>;
    const text = messages.map((message) => message.content.text).join('\n');
    assert.match(text, /parallax_analyze_diff/);
    assert.match(text, /parallax_co_change/);
    assert.match(text, /parallax_remember/);
    assert.match(text, /src\/store\.ts/);
  } finally {
    await client.close();
  }
});
