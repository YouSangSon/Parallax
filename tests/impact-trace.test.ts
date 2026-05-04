import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { AdapterRegistry } from '../src/adapters/registry.js';
import type { AdapterRun, ExtractCtx, IndexEvent, SemanticAdapter } from '../src/adapters/types.js';
import { analyzeDiff, exportImpactGraph, indexProject, initProject, profileEntity } from '../src/index.js';
import { indexProjectWithRegistryForTest } from '../src/indexer.js';
import { databasePath } from '../src/store.js';
import type { RelationKind, ScannedFile } from '../src/types.js';

// Force the deterministic SHA-256 stub so embedding tests don't download a
// real model (~278 MB) and stay fast/offline. Spawned CLI subprocesses
// inherit this env automatically.
process.env.IMPACT_TRACE_EMBEDDING_MODEL = 'stub-sha256';

const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve('tsx');

if (false) {
  const registry = new AdapterRegistry();
  // @ts-expect-error registry injection is intentionally not part of the public indexProject API
  void indexProject({ repoRoot: '' }, { registry });
}

async function makeFixtureRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-'));
  await mkdir(path.join(repoRoot, 'src/auth'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src/routes'), { recursive: true });
  await mkdir(path.join(repoRoot, 'tests'), { recursive: true });
  await mkdir(path.join(repoRoot, '.github/workflows'), { recursive: true });

  await writeFile(
    path.join(repoRoot, 'src/auth/session.ts'),
    [
      'export function validateSession(token: string) {',
      '  const apiKey = "sk-test-secret-1234567890";',
      '  return token.length > 0 && apiKey.length > 0;',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/routes/private.ts'),
    [
      'import { validateSession } from "../auth/session";',
      'export function privateRoute(token: string) {',
      '  return validateSession(token) ? "ok" : "no";',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'tests/session.test.ts'),
    [
      'import { validateSession } from "../src/auth/session";',
      'test("validateSession accepts non-empty token", () => {',
      '  expect(validateSession("abc")).toBe(true);',
      '});',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'README.md'),
    'Call `validateSession` before rendering private routes.\n'
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
      '      - run: npm test -- src/auth/session.ts',
      ''
    ].join('\n')
  );

  return repoRoot;
}

function makeAttributionAdapter(id: string, language: string): SemanticAdapter {
  return {
    id,
    version: '1',
    capabilities: ['references'],
    supports: (file) => file.language === language,
    start: (_ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun => ({
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        yield {
          kind: 'relation',
          relation: {
            source: { kind: 'file', path: file.relativePath, languageId: file.language },
            target: { kind: 'file', path: file.relativePath, languageId: file.language },
            kind: 'REFERENCES',
            metadata: {
              confidence: 'proven',
              provenance: `${id}:${file.relativePath}`
            },
            evidence: [
              {
                file: file.relativePath,
                snippet: file.content,
                confidence: 'proven'
              }
            ]
          }
        };
      }
    })
  };
}

function makeFailingAdapter(id: string, language: string, message: string): SemanticAdapter {
  return {
    id,
    version: '1',
    capabilities: ['references'],
    supports: (file) => file.language === language,
    start: (_ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun => ({
      async *process(_file: ScannedFile): AsyncIterable<IndexEvent> {
        throw new Error(message);
      }
    })
  };
}

test('initProject creates config and SQLite database tables', async () => {
  const repoRoot = await makeFixtureRepo();

  const result = await initProject({ repoRoot });

  assert.equal(result.created, true);
  assert.equal(result.configPath.endsWith('.impact-trace/config.json'), true);
  assert.equal(result.databasePath.endsWith('.impact-trace/impact.db'), true);
  const config = JSON.parse(await readFile(result.configPath, 'utf8')) as { schemaVersion: number };
  assert.equal(config.schemaVersion, 3);
  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const tables = db.prepare('SELECT group_concat(name) AS names FROM sqlite_master WHERE type = ?').get('table') as { names: string };
    const schemaVersion = db.prepare('SELECT max(version) AS version FROM schema_versions').get() as { version: number };
    assert.match(tables.names, /workspaces/);
    assert.match(tables.names, /contracts/);
    assert.match(tables.names, /cross_repo_links/);
    assert.match(tables.names, /work_artifacts/);
    assert.equal(schemaVersion.version, 7);
  } finally {
    db.close();
  }
});

test('indexProject and analyzeDiff report direct importers, tests, docs, runnable commands, and redacted evidence', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const report = await analyzeDiff({
    repoRoot,
    changedFiles: ['src/auth/session.ts'],
    writeReport: true
  });

  assert.ok(index.filesIndexed >= 4);
  assert.deepEqual(report.changedFiles, ['src/auth/session.ts']);
  assert.ok(report.affectedFiles.some((file) => file.path === 'src/routes/private.ts'));
  assert.ok(report.affectedFiles.some((file) => file.path === 'tests/session.test.ts'));
  assert.ok(report.affectedFiles.some((file) => file.path === 'README.md'));
  assert.ok(report.affectedFiles.some((file) => file.path === '.github/workflows/ci.yml'));
  assert.ok(report.testCommands.some((command) => command.command === 'npm' && command.args?.includes('tests/session.test.ts')));
  assert.ok(report.evidence.length > 0);
  assert.ok(report.evidence.some((item) => item.extractorId === 'canonical-entity-graph'));
  assert.equal(report.evidence.some((item) => item.snippet.includes('sk-test-secret')), false);
  assert.ok(report.reportPath);
  const markdown = await readFile(path.join(repoRoot, report.reportPath), 'utf8');
  assert.match(markdown, /Impact Trace Report/);
  assert.doesNotMatch(markdown, /sk-test-secret/);
});

test('indexProject writes canonical entity graph and broad language file entities', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-entity-'));
  await mkdir(path.join(repoRoot, 'src/native'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/util.py'), 'def helper():\n    return 1\n');
  await writeFile(path.join(repoRoot, 'src/app.py'), 'from util import helper\n\ndef run():\n    return helper()\n');
  await writeFile(path.join(repoRoot, 'src/main.go'), 'package main\n\nfunc Run() {}\n');
  await writeFile(path.join(repoRoot, 'src/lib.rs'), 'pub fn run() {}\npub struct User;\n');
  await writeFile(path.join(repoRoot, 'src/Main.java'), 'package app;\npublic class Main { public void run() {} }\n');
  await writeFile(path.join(repoRoot, 'src/App.kt'), 'package app\nclass App { fun run() {} }\n');
  await writeFile(path.join(repoRoot, 'src/Program.cs'), 'using System;\npublic class Program { public void Run() {} }\n');
  await writeFile(path.join(repoRoot, 'src/native/main.hpp'), 'int add(int a, int b);\n');
  await writeFile(path.join(repoRoot, 'src/native/main.cpp'), '#include "main.hpp"\nint add(int a, int b) { return a + b; }\n');
  await writeFile(path.join(repoRoot, 'Dockerfile'), 'COPY src/Main.java /app/Main.java\n');
  await writeFile(path.join(repoRoot, 'schema.proto'), 'syntax = "proto3";\nservice UserService {}\n');

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  assert.ok(index.entitiesIndexed && index.entitiesIndexed >= index.filesIndexed);
  assert.ok(index.relationsIndexed && index.relationsIndexed > 0);
  assert.ok(index.adaptersUsed?.[0]?.languageIds.includes('java'));
  assert.ok(index.adaptersUsed?.[0]?.languageIds.includes('kotlin'));
  assert.ok(index.adaptersUsed?.[0]?.languageIds.includes('csharp'));
  assert.ok(index.adaptersUsed?.[0]?.languageIds.includes('cpp'));
  assert.ok(index.adaptersUsed?.[0]?.languageIds.includes('dockerfile'));
  assert.ok(index.adaptersUsed?.[0]?.languageIds.includes('protobuf'));

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const entityCount = db.prepare('SELECT count(*) AS count FROM entities').get() as { count: number };
    const relationKinds = db.prepare('SELECT group_concat(DISTINCT kind) AS kinds FROM relations').get() as { kinds: string };
    const indexedLanguages = db
      .prepare('SELECT group_concat(DISTINCT language_id) AS languages FROM index_coverage WHERE status = ?')
      .get('indexed') as { languages: string };
    const adapterRuns = db.prepare('SELECT count(*) AS count FROM adapter_runs WHERE status = ?').get('completed') as { count: number };

    assert.ok(entityCount.count >= index.filesIndexed);
    assert.match(relationKinds.kinds, /DECLARES/);
    assert.match(relationKinds.kinds, /DEPENDS_ON/);
    assert.match(indexedLanguages.languages, /java/);
    assert.match(indexedLanguages.languages, /kotlin/);
    assert.match(indexedLanguages.languages, /csharp/);
    assert.match(indexedLanguages.languages, /cpp/);
    assert.match(indexedLanguages.languages, /dockerfile/);
    assert.match(indexedLanguages.languages, /protobuf/);
    assert.equal(adapterRuns.count, 1);
  } finally {
    db.close();
  }
});

test('indexProject makes symbol entity version content hash track containing file changes', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-symbol-version-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  const sourcePath = path.join(repoRoot, 'src/calc.ts');
  await writeFile(
    sourcePath,
    [
      'export function calculate(input: number) {',
      '  return input + 1;',
      '}',
      ''
    ].join('\n')
  );
  await initProject({ repoRoot });

  const symbolVersionHash = (indexRunId: number): string => {
    const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
    try {
      const row = db
        .prepare(
          `SELECT ev.content_hash
           FROM entity_versions ev
           INNER JOIN entities e ON e.id = ev.entity_id
           WHERE ev.index_run_id = ?
             AND e.kind = 'symbol'
             AND e.path = ?
             AND e.symbol = ?`
        )
        .get(indexRunId, 'src/calc.ts', 'calculate') as { content_hash: string } | undefined;
      assert.ok(row, 'expected symbol entity version row for calculate');
      return row.content_hash;
    } finally {
      db.close();
    }
  };

  const firstIndex = await indexProject({ repoRoot });
  const firstHash = symbolVersionHash(firstIndex.indexRunId);

  const sameContentIndex = await indexProject({ repoRoot });
  assert.equal(symbolVersionHash(sameContentIndex.indexRunId), firstHash);

  await writeFile(
    sourcePath,
    [
      'export function calculate(input: number) {',
      '  const doubled = input * 2;',
      '  return doubled + 1;',
      '}',
      ''
    ].join('\n')
  );
  const changedContentIndex = await indexProject({ repoRoot });

  assert.notEqual(symbolVersionHash(changedContentIndex.indexRunId), firstHash);
});

test('indexProject attributes adapter runs, relations, coverage, and usage per classified adapter', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-adapters-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await mkdir(path.join(repoRoot, 'scripts'), { recursive: true });
  await mkdir(path.join(repoRoot, 'docs'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/app.ts'), 'export const app = 1;\n');
  await writeFile(path.join(repoRoot, 'scripts/tool.py'), 'def tool():\n    return 1\n');
  await writeFile(path.join(repoRoot, 'scripts/large.py'), `value = "${'x'.repeat(160)}"\n`);
  await writeFile(path.join(repoRoot, 'docs/large.md'), `${'oversized docs\n'.repeat(20)}`);
  await initProject({ repoRoot });

  const registry = new AdapterRegistry();
  registry.register(makeAttributionAdapter('typescript-test-adapter', 'typescript'));
  registry.register(makeAttributionAdapter('python-test-adapter', 'python'));

  const index = await indexProjectWithRegistryForTest({ repoRoot, maxFileBytes: 80 }, registry);

  assert.deepEqual(
    index.adaptersUsed?.map((adapter) => ({
      id: adapter.id,
      languageIds: adapter.languageIds
    })),
    [
      { id: 'typescript-test-adapter', languageIds: ['typescript'] },
      { id: 'python-test-adapter', languageIds: ['python'] }
    ]
  );

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const adapterRuns = db
      .prepare(
        'SELECT id, adapter_id, language_ids, status FROM adapter_runs WHERE index_run_id = ? ORDER BY id'
      )
      .all(index.indexRunId) as Array<{
        id: number;
        adapter_id: string;
        language_ids: string;
        status: string;
      }>;
    assert.deepEqual(
      adapterRuns.map((run) => ({
        adapterId: run.adapter_id,
        languageIds: JSON.parse(run.language_ids) as string[],
        status: run.status
      })),
      [
        { adapterId: 'typescript-test-adapter', languageIds: ['typescript'], status: 'completed' },
        { adapterId: 'python-test-adapter', languageIds: ['python'], status: 'completed' }
      ]
    );

    const relationRows = db
      .prepare(
        `SELECT r.provenance, ar.adapter_id
         FROM relations r
         JOIN adapter_runs ar ON ar.id = r.adapter_run_id
         WHERE r.index_run_id = ?
         ORDER BY r.provenance`
      )
      .all(index.indexRunId) as Array<{ provenance: string; adapter_id: string }>;
    assert.deepEqual(
      relationRows.map((row) => ({
        provenance: row.provenance,
        adapter_id: row.adapter_id
      })),
      [
        {
          provenance: 'python-test-adapter:scripts/tool.py',
          adapter_id: 'python-test-adapter'
        },
        {
          provenance: 'typescript-test-adapter:src/app.ts',
          adapter_id: 'typescript-test-adapter'
        }
      ]
    );

    const coverageRows = db
      .prepare(
        `SELECT path, adapter_id, status
         FROM index_coverage
         WHERE index_run_id = ?
         ORDER BY path`
      )
      .all(index.indexRunId) as Array<{ path: string; adapter_id: string; status: string }>;
    assert.deepEqual(
      coverageRows.map((row) => ({
        path: row.path,
        adapter_id: row.adapter_id,
        status: row.status
      })),
      [
        { path: 'docs/large.md', adapter_id: 'unsupported', status: 'skipped' },
        { path: 'scripts/large.py', adapter_id: 'python-test-adapter', status: 'skipped' },
        { path: 'scripts/tool.py', adapter_id: 'python-test-adapter', status: 'indexed' },
        { path: 'src/app.ts', adapter_id: 'typescript-test-adapter', status: 'indexed' }
      ]
    );
  } finally {
    db.close();
  }
});

test('indexProject preserves skipped-file adapter attribution for skipped-only adapters', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-skipped-only-adapter-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/big.ts'), `export const big = "${'x'.repeat(200)}";\n`);
  await initProject({ repoRoot });

  const registry = new AdapterRegistry();
  registry.register(makeAttributionAdapter('typescript-skipped-adapter', 'typescript'));

  const index = await indexProjectWithRegistryForTest({ repoRoot, maxFileBytes: 1 }, registry);

  assert.equal(index.filesIndexed, 0);
  assert.deepEqual(
    index.adaptersUsed?.map((adapter) => ({
      id: adapter.id,
      languageIds: adapter.languageIds
    })),
    [{ id: 'typescript-skipped-adapter', languageIds: ['typescript'] }]
  );

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const adapterRuns = db
      .prepare(
        'SELECT adapter_id, language_ids, status FROM adapter_runs WHERE index_run_id = ? ORDER BY id'
      )
      .all(index.indexRunId) as Array<{
        adapter_id: string;
        language_ids: string;
        status: string;
      }>;
    assert.deepEqual(
      adapterRuns.map((run) => ({
        adapterId: run.adapter_id,
        languageIds: JSON.parse(run.language_ids) as string[],
        status: run.status
      })),
      [{ adapterId: 'typescript-skipped-adapter', languageIds: ['typescript'], status: 'skipped' }]
    );

    const joinableCoverage = db
      .prepare(
        `SELECT ic.path, ic.adapter_id, ic.status
         FROM index_coverage ic
         JOIN adapter_runs ar
           ON ar.index_run_id = ic.index_run_id
          AND ar.adapter_id = ic.adapter_id
         WHERE ic.index_run_id = ?
         ORDER BY ic.path`
      )
      .all(index.indexRunId) as Array<{ path: string; adapter_id: string; status: string }>;
    assert.deepEqual(joinableCoverage, [
      { path: 'src/big.ts', adapter_id: 'typescript-skipped-adapter', status: 'skipped' }
    ]);
  } finally {
    db.close();
  }
});

test('indexProject uses readable skipped file content for skipped-file adapter attribution', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-skipped-content-router-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'src/generated.ts'),
    `// @generated\nexport const generated = "${'x'.repeat(200)}";\n`
  );
  await initProject({ repoRoot });

  let startCalls = 0;
  const registry = new AdapterRegistry();
  registry.register({
    id: 'generated-content-adapter',
    version: '1',
    capabilities: ['references'],
    supports: (file) => file.language === 'typescript' && file.content.startsWith('// @generated'),
    start: (_ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun => {
      startCalls++;
      return {
        async *process(_file: ScannedFile): AsyncIterable<IndexEvent> {}
      };
    }
  });

  const index = await indexProjectWithRegistryForTest({ repoRoot, maxFileBytes: 1 }, registry);

  assert.equal(index.filesIndexed, 0);
  assert.equal(index.relationsIndexed, 0);
  assert.equal(startCalls, 0);
  assert.deepEqual(
    index.adaptersUsed?.map((adapter) => ({
      id: adapter.id,
      languageIds: adapter.languageIds
    })),
    [{ id: 'generated-content-adapter', languageIds: ['typescript'] }]
  );

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const coverage = db
      .prepare(
        `SELECT path, adapter_id, status
         FROM index_coverage
         WHERE index_run_id = ?
         ORDER BY path`
      )
      .all(index.indexRunId) as Array<{ path: string; adapter_id: string; status: string }>;
    assert.deepEqual(coverage, [
      { path: 'src/generated.ts', adapter_id: 'generated-content-adapter', status: 'skipped' }
    ]);

    const relationCount = db
      .prepare('SELECT count(*) AS count FROM relations WHERE index_run_id = ?')
      .get(index.indexRunId) as { count: number };
    assert.equal(relationCount.count, 0);
  } finally {
    db.close();
  }
});

test('indexProject exposes adapter diagnostics while completing the adapter run', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-adapter-diagnostics-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/app.ts'), 'export const app = 1;\n');
  await initProject({ repoRoot });

  const registry = new AdapterRegistry();
  registry.register({
    id: 'diagnostic-test-adapter',
    version: '1',
    capabilities: ['references'],
    supports: (file) => file.language === 'typescript',
    start: (_ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun => ({
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        yield {
          kind: 'diagnostic',
          level: 'warn',
          message: 'parser recovered after syntax ambiguity',
          file: file.relativePath
        };
        yield {
          kind: 'diagnostic',
          level: 'error',
          message: 'missing optional type info',
          file: file.relativePath
        };
        yield {
          kind: 'diagnostic',
          level: 'error',
          message: 'adapter-level cache probe failed'
        };
        yield {
          kind: 'relation',
          relation: {
            source: { kind: 'file', path: file.relativePath, languageId: file.language },
            target: { kind: 'file', path: file.relativePath, languageId: file.language },
            kind: 'REFERENCES',
            metadata: {
              confidence: 'proven',
              provenance: `diagnostic-test-adapter:${file.relativePath}`
            },
            evidence: [
              {
                file: file.relativePath,
                snippet: file.content,
                confidence: 'proven'
              }
            ]
          }
        };
      }
    })
  });

  const index = await indexProjectWithRegistryForTest({ repoRoot }, registry);

  assert.equal(index.filesIndexed, 1);
  assert.equal(index.relationsIndexed, 1);

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const indexRun = db
      .prepare('SELECT status FROM index_runs WHERE id = ?')
      .get(index.indexRunId) as { status: string };
    assert.equal(indexRun.status, 'completed');

    const adapterRun = db
      .prepare(
        `SELECT status, error_summary
         FROM adapter_runs
         WHERE index_run_id = ? AND adapter_id = ?`
      )
      .get(index.indexRunId, 'diagnostic-test-adapter') as {
      status: string;
      error_summary: string | null;
    };
    assert.equal(adapterRun.status, 'completed');
    assert.match(adapterRun.error_summary ?? '', /diagnostic error: adapter-level cache probe failed/);

    const coverageRows = db
      .prepare(
        `SELECT path, status, reason
         FROM index_coverage
         WHERE index_run_id = ? AND adapter_id = ?
         ORDER BY path`
      )
      .all(index.indexRunId, 'diagnostic-test-adapter') as Array<{
      path: string;
      status: string;
      reason: string;
    }>;
    const normalCoverage = coverageRows.find((row) => row.path === 'src/app.ts');
    assert.deepEqual(
      normalCoverage
        ? {
            path: normalCoverage.path,
            status: normalCoverage.status,
            reason: normalCoverage.reason
          }
        : undefined,
      {
        path: 'src/app.ts',
        status: 'indexed',
        reason: 'matched source extension'
      }
    );

    const diagnosticCoverage = coverageRows
      .filter((row) => row.path.startsWith('src/app.ts#diagnostic:'))
      .map((row) => ({
        pathPrefix: row.path.replace(/:[^:]+$/, ':<stable>'),
        status: row.status,
        reason: row.reason
      }));
    assert.deepEqual(diagnosticCoverage, [
      {
        pathPrefix: 'src/app.ts#diagnostic:error:<stable>',
        status: 'skipped',
        reason: 'diagnostic error: missing optional type info'
      },
      {
        pathPrefix: 'src/app.ts#diagnostic:warn:<stable>',
        status: 'skipped',
        reason: 'diagnostic warning: parser recovered after syntax ambiguity'
      }
    ]);
  } finally {
    db.close();
  }
});

test('indexProject preserves diagnostics when an adapter fails after emitting them', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-adapter-diagnostic-fail-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/app.ts'), 'export const app = 1;\n');
  await initProject({ repoRoot });

  const registry = new AdapterRegistry();
  registry.register({
    id: 'diagnostic-then-failing-adapter',
    version: '1',
    capabilities: ['references'],
    supports: (file) => file.language === 'typescript',
    start: (_ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun => ({
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        yield {
          kind: 'diagnostic',
          level: 'warn',
          message: 'adapter cache unavailable'
        };
        yield {
          kind: 'diagnostic',
          level: 'error',
          message: 'file parse recovered before crash',
          file: file.relativePath
        };
        throw new Error('adapter crashed after diagnostics');
      }
    })
  });

  await assert.rejects(
    indexProjectWithRegistryForTest({ repoRoot }, registry),
    /adapter crashed after diagnostics/
  );

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const indexRun = db
      .prepare('SELECT id, status FROM index_runs ORDER BY id DESC LIMIT 1')
      .get() as { id: number; status: string };
    assert.equal(indexRun.status, 'failed');

    const adapterRun = db
      .prepare(
        `SELECT status, error_summary
         FROM adapter_runs
         WHERE index_run_id = ? AND adapter_id = ?`
      )
      .get(indexRun.id, 'diagnostic-then-failing-adapter') as {
      status: string;
      error_summary: string | null;
    };
    assert.equal(adapterRun.status, 'failed');
    assert.match(
      adapterRun.error_summary ?? '',
      /diagnostic warning: adapter cache unavailable[\s\S]+adapter crashed after diagnostics/
    );

    const diagnosticCoverage = db
      .prepare(
        `SELECT path, status, reason
         FROM index_coverage
         WHERE index_run_id = ?
           AND adapter_id = ?
           AND path LIKE ?
         ORDER BY path`
      )
      .all(indexRun.id, 'diagnostic-then-failing-adapter', 'src/app.ts#diagnostic:%') as Array<{
      path: string;
      status: string;
      reason: string;
    }>;
    assert.deepEqual(
      diagnosticCoverage.map((row) => ({
        pathPrefix: row.path.replace(/:[^:]+$/, ':<stable>'),
        status: row.status,
        reason: row.reason
      })),
      [
        {
          pathPrefix: 'src/app.ts#diagnostic:error:<stable>',
          status: 'skipped',
          reason: 'diagnostic error: file parse recovered before crash'
        }
      ]
    );
  } finally {
    db.close();
  }
});

test('indexProject persists adapter-provided relation evidence entries', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-relation-evidence-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  const fullSource = [
    'export const source = "full file content should not be relation evidence";',
    'export const target = source;',
    ''
  ].join('\n');
  await writeFile(path.join(repoRoot, 'src/app.ts'), fullSource);
  await initProject({ repoRoot });

  const firstSnippet = 'adapter short evidence: source references target';
  const secondSnippet = 'adapter secret evidence: sk-test-secret-1234567890';
  let reverseEvidenceOrder = false;
  const registry = new AdapterRegistry();
  registry.register({
    id: 'relation-evidence-test-adapter',
    version: '1',
    capabilities: ['references'],
    supports: (file) => file.language === 'typescript',
    start: (_ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun => ({
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        const evidence = [
          {
            file: 'adapter/evidence-one.ts',
            snippet: firstSnippet,
            confidence: 'proven'
          },
          {
            file: 'adapter/evidence-two.ts',
            snippet: secondSnippet,
            confidence: 'inferred'
          }
        ] as const;
        yield {
          kind: 'relation',
          relation: {
            source: { kind: 'file', path: file.relativePath, languageId: file.language },
            target: { kind: 'file', path: file.relativePath, languageId: file.language },
            kind: 'REFERENCES',
            metadata: {
              confidence: 'proven',
              provenance: `relation-evidence-test-adapter:${file.relativePath}`
            },
            evidence: reverseEvidenceOrder ? [...evidence].reverse() : [...evidence]
          }
        };
      }
    })
  });

  const firstIndex = await indexProjectWithRegistryForTest({ repoRoot }, registry);
  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const firstEvidenceRows = db
      .prepare(
        `SELECT id, file_path, snippet, confidence
         FROM relation_evidence
         WHERE index_run_id = ?
         ORDER BY file_path`
      )
      .all(firstIndex.indexRunId) as Array<{
        id: string;
        file_path: string;
        snippet: string;
        confidence: string;
      }>;
    assert.deepEqual(
      firstEvidenceRows.map((row) => ({
        filePath: row.file_path,
        snippet: row.snippet,
        confidence: row.confidence
      })),
      [
        {
          filePath: 'adapter/evidence-one.ts',
          snippet: firstSnippet,
          confidence: 'proven'
        },
        {
          filePath: 'adapter/evidence-two.ts',
          snippet: 'adapter secret evidence: [REDACTED_OPENAI_KEY]',
          confidence: 'inferred'
        }
      ]
    );
    assert.equal(new Set(firstEvidenceRows.map((row) => row.id)).size, 2);
    assert.equal(firstEvidenceRows.some((row) => row.file_path === 'src/app.ts'), false);
    assert.equal(firstEvidenceRows.some((row) => row.snippet === fullSource), false);

    const evidenceFacts = db
      .prepare(
        `SELECT entity_id, value_blob, redacted
         FROM facts
         WHERE attribute = 'evidence_snippet'
         ORDER BY entity_id, value_blob`
      )
      .all() as Array<{ entity_id: string; value_blob: string; redacted: number }>;
    assert.deepEqual(
      evidenceFacts.map((row) => ({
        entityId: row.entity_id,
        snippet: JSON.parse(row.value_blob) as string,
        redacted: row.redacted
      })),
      [
        {
          entityId: 'file:adapter/evidence-one.ts',
          snippet: firstSnippet,
          redacted: 0
        },
        {
          entityId: 'file:adapter/evidence-two.ts',
          snippet: 'adapter secret evidence: [REDACTED_OPENAI_KEY]',
          redacted: 1
        }
      ]
    );

    const firstEvidenceIdsByIdentity = new Map(
      firstEvidenceRows.map((row) => [
        `${row.file_path}\0${row.snippet}\0${row.confidence}`,
        row.id
      ])
    );

    reverseEvidenceOrder = true;
    const secondIndex = await indexProjectWithRegistryForTest({ repoRoot }, registry);
    const secondEvidenceRows = db
      .prepare(
        `SELECT id, file_path, snippet, confidence
         FROM relation_evidence
         WHERE index_run_id = ?
         ORDER BY file_path`
      )
      .all(secondIndex.indexRunId) as Array<{
        id: string;
        file_path: string;
        snippet: string;
        confidence: string;
      }>;
    const secondEvidenceIdsByIdentity = new Map(
      secondEvidenceRows.map((row) => [
        `${row.file_path}\0${row.snippet}\0${row.confidence}`,
        row.id
      ])
    );
    assert.deepEqual(secondEvidenceIdsByIdentity, firstEvidenceIdsByIdentity);
  } finally {
    db.close();
  }
});

test('indexProject keeps relation evidence identities distinct for different spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-relation-evidence-span-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/app.ts'), 'export const target = 1;\n');
  await initProject({ repoRoot });

  const snippet = 'same evidence snippet';
  let reverseEvidenceOrder = false;
  const registry = new AdapterRegistry();
  registry.register({
    id: 'relation-evidence-span-test-adapter',
    version: '1',
    capabilities: ['references'],
    supports: (file) => file.language === 'typescript',
    start: (_ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun => ({
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        const evidence = [
          {
            file: 'src/app.ts',
            snippet,
            confidence: 'proven',
            startLine: 1
          },
          {
            file: 'src/app.ts',
            snippet,
            confidence: 'proven',
            startLine: 2
          }
        ] as const;
        yield {
          kind: 'relation',
          relation: {
            source: { kind: 'file', path: file.relativePath, languageId: file.language },
            target: { kind: 'file', path: file.relativePath, languageId: file.language },
            kind: 'REFERENCES',
            metadata: {
              confidence: 'proven',
              provenance: `relation-evidence-span-test-adapter:${file.relativePath}`
            },
            evidence: reverseEvidenceOrder ? [...evidence].reverse() : [...evidence]
          }
        };
      }
    })
  });

  const firstIndex = await indexProjectWithRegistryForTest({ repoRoot }, registry);
  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const firstEvidenceRows = db
      .prepare(
        `SELECT id, file_path, snippet, confidence
         FROM relation_evidence
         WHERE index_run_id = ?
         ORDER BY id`
      )
      .all(firstIndex.indexRunId) as Array<{
        id: string;
        file_path: string;
        snippet: string;
        confidence: string;
      }>;
    assert.deepEqual(
      firstEvidenceRows.map((row) => ({
        filePath: row.file_path,
        snippet: row.snippet,
        confidence: row.confidence
      })),
      [
        {
          filePath: 'src/app.ts',
          snippet,
          confidence: 'proven'
        },
        {
          filePath: 'src/app.ts',
          snippet,
          confidence: 'proven'
        }
      ]
    );
    const firstIdSet = new Set(firstEvidenceRows.map((row) => row.id));
    assert.equal(firstEvidenceRows.length, 2);
    assert.equal(firstIdSet.size, 2);

    reverseEvidenceOrder = true;
    const secondIndex = await indexProjectWithRegistryForTest({ repoRoot }, registry);
    const secondEvidenceRows = db
      .prepare(
        `SELECT id
         FROM relation_evidence
         WHERE index_run_id = ?
         ORDER BY id`
      )
      .all(secondIndex.indexRunId) as Array<{ id: string }>;
    assert.deepEqual(
      new Set(secondEvidenceRows.map((row) => row.id)),
      firstIdSet
    );
  } finally {
    db.close();
  }
});

test('indexProject preserves per-adapter terminal status when a later adapter fails', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-adapter-fail-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await mkdir(path.join(repoRoot, 'scripts'), { recursive: true });
  await mkdir(path.join(repoRoot, 'docs'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/app.ts'), 'export const app = 1;\n');
  await writeFile(path.join(repoRoot, 'scripts/tool.py'), 'def tool():\n    return 1\n');
  await writeFile(path.join(repoRoot, 'docs/notes.md'), 'notes for adapter failure test\n');
  await initProject({ repoRoot });

  const registry = new AdapterRegistry();
  registry.register(makeAttributionAdapter('typescript-success-adapter', 'typescript'));
  registry.register(makeFailingAdapter('python-failing-adapter', 'python', 'python adapter failed'));
  registry.register(makeAttributionAdapter('markdown-not-run-adapter', 'markdown'));

  await assert.rejects(
    indexProjectWithRegistryForTest({ repoRoot }, registry),
    /python adapter failed/
  );

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const indexRun = db
      .prepare('SELECT id, status FROM index_runs ORDER BY id DESC LIMIT 1')
      .get() as { id: number; status: string };
    assert.equal(indexRun.status, 'failed');

    const adapterRuns = db
      .prepare(
        `SELECT adapter_id, status, error_summary
         FROM adapter_runs
         WHERE index_run_id = ?
         ORDER BY id`
      )
      .all(indexRun.id) as Array<{
        adapter_id: string;
        status: string;
        error_summary: string | null;
      }>;
    assert.deepEqual(
      adapterRuns.map((run) => ({
        adapterId: run.adapter_id,
        status: run.status,
        errorSummary: run.error_summary
      })),
      [
        {
          adapterId: 'typescript-success-adapter',
          status: 'completed',
          errorSummary: null
        },
        {
          adapterId: 'python-failing-adapter',
          status: 'failed',
          errorSummary: 'python adapter failed'
        },
        {
          adapterId: 'markdown-not-run-adapter',
          status: 'skipped',
          errorSummary: 'not run because python-failing-adapter failed'
        }
      ]
    );
  } finally {
    db.close();
  }
});

test('exportImpactGraph renders report graph from SQLite relations without graph DB', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });
  await indexProject({ repoRoot });
  const report = await analyzeDiff({
    repoRoot,
    changedFiles: ['src/auth/session.ts'],
    writeReport: true
  });

  const jsonGraph = await exportImpactGraph({ repoRoot, reportId: report.id, format: 'json' });
  const parsed = JSON.parse(jsonGraph.rendered) as {
    nodes: Array<{ id: string; group: string }>;
    edges: Array<{ kind: string; source: string; target: string }>;
  };
  assert.equal(jsonGraph.format, 'json');
  assert.ok(parsed.nodes.some((node) => node.id === 'file:src/auth/session.ts' && node.group === 'changed'));
  assert.ok(parsed.nodes.some((node) => node.id === 'file:src/routes/private.ts' && node.group === 'affected'));
  assert.ok(parsed.edges.some((edge) => edge.kind === 'DEPENDS_ON'));
  assert.doesNotMatch(jsonGraph.rendered, /sk-test-secret/);

  const mermaidGraph = await exportImpactGraph({ repoRoot, reportId: report.id, format: 'mermaid' });
  assert.match(mermaidGraph.rendered, /^flowchart LR/);
  assert.match(mermaidGraph.rendered, /src\/auth\/session\.ts/);
  assert.match(mermaidGraph.rendered, /DEPENDS_ON/);
  assert.doesNotMatch(mermaidGraph.rendered, /sk-test-secret/);

  const dotGraph = await exportImpactGraph({ repoRoot, reportId: report.id, format: 'dot' });
  assert.match(dotGraph.rendered, /^digraph impact_trace/);
  assert.match(dotGraph.rendered, /src\/auth\/session\.ts/);
  assert.match(dotGraph.rendered, /DEPENDS_ON/);
  assert.doesNotMatch(dotGraph.rendered, /sk-test-secret/);
});

test('analyzeDiff follows bounded multi-hop relations with cycle protection', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-depth-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await mkdir(path.join(repoRoot, 'tests'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/core.ts'), 'export function core() { return 1; }\n');
  await writeFile(path.join(repoRoot, 'src/service.ts'), 'import { core } from "./core"; export const service = core();\n');
  await writeFile(path.join(repoRoot, 'src/route.ts'), 'import { service } from "./service"; export const route = service;\n');
  await writeFile(path.join(repoRoot, 'tests/route.test.ts'), 'import { route } from "../src/route"; test("route", () => route);\n');
  await initProject({ repoRoot });
  await indexProject({ repoRoot });

  const shallow = await analyzeDiff({ repoRoot, changedFiles: ['src/core.ts'], maxDepth: 1 });
  assert.ok(shallow.affectedFiles.some((file) => file.path === 'src/service.ts'));
  assert.equal(shallow.affectedFiles.some((file) => file.path === 'src/route.ts'), false);

  const deep = await analyzeDiff({ repoRoot, changedFiles: ['src/core.ts'], maxDepth: 3 });
  const route = deep.affectedFiles.find((file) => file.path === 'src/route.ts');
  const testFile = deep.affectedFiles.find((file) => file.path === 'tests/route.test.ts');
  assert.ok(route);
  assert.ok(testFile);
  assert.equal(route.depth, 2);
  assert.equal(testFile.depth, 3);
  assert.ok(testFile.relationPath && testFile.relationPath.length >= 3);

  const bounded = await analyzeDiff({ repoRoot, changedFiles: ['src/core.ts'], maxDepth: 2 });
  const boundedGraph = await exportImpactGraph({ repoRoot, reportId: bounded.id, format: 'json' });
  const parsedGraph = JSON.parse(boundedGraph.rendered) as { nodes: Array<{ id: string }> };
  assert.equal(bounded.affectedFiles.some((file) => file.path === 'tests/route.test.ts'), false);
  assert.equal(parsedGraph.nodes.some((node) => node.id === 'file:tests/route.test.ts'), false);
});

test('analyzeDiff report IDs include fanout options that change impact scope', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-fanout-id-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/core.ts'), 'export const core = 1;\n');
  await writeFile(path.join(repoRoot, 'src/a.ts'), 'import { core } from "./core"; export const a = core;\n');
  await writeFile(path.join(repoRoot, 'src/b.ts'), 'import { core } from "./core"; export const b = core;\n');
  await initProject({ repoRoot });
  await indexProject({ repoRoot });

  const fanoutOne = await analyzeDiff({ repoRoot, changedFiles: ['src/core.ts'], maxFanout: 1 });
  const fanoutTwo = await analyzeDiff({ repoRoot, changedFiles: ['src/core.ts'], maxFanout: 2 });

  assert.notEqual(fanoutOne.id, fanoutTwo.id);
  assert.ok(fanoutTwo.affectedFiles.length >= fanoutOne.affectedFiles.length);
});

test('analyzeDiff fanout limits distinct relations rather than evidence rows', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-fanout-evidence-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/core.ts'), 'export const core = 1;\n');
  await writeFile(path.join(repoRoot, 'src/a.ts'), 'import { core } from "./core"; export const a = core;\n');
  await writeFile(path.join(repoRoot, 'src/b.ts'), 'import { core } from "./core"; export const b = core;\n');
  await initProject({ repoRoot });

  const registry = new AdapterRegistry();
  registry.register({
    id: 'fanout-evidence-test-adapter',
    version: '1',
    capabilities: ['references'],
    supports: (file) => file.language === 'typescript',
    start: (_ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun => ({
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        if (file.relativePath !== 'src/a.ts' && file.relativePath !== 'src/b.ts') {
          return;
        }
        yield {
          kind: 'relation',
          relation: {
            source: { kind: 'file', path: file.relativePath, languageId: file.language },
            target: { kind: 'file', path: 'src/core.ts', languageId: 'typescript' },
            kind: 'DEPENDS_ON',
            metadata: {
              confidence: 'proven',
              provenance: `fanout-evidence-test-adapter:${file.relativePath}`
            },
            evidence: file.relativePath === 'src/a.ts'
              ? [
                  {
                    file: 'evidence/a-one.ts',
                    snippet: 'a depends on core, first evidence',
                    confidence: 'proven'
                  },
                  {
                    file: 'evidence/a-two.ts',
                    snippet: 'a depends on core, second evidence',
                    confidence: 'proven'
                  }
                ]
              : [
                  {
                    file: 'evidence/b-one.ts',
                    snippet: 'b depends on core',
                    confidence: 'proven'
                  }
                ]
          }
        };
      }
    })
  });
  await indexProjectWithRegistryForTest({ repoRoot }, registry);

  const report = await analyzeDiff({
    repoRoot,
    changedFiles: ['src/core.ts'],
    maxFanout: 2
  });

  assert.deepEqual(
    report.affectedFiles.map((file) => file.path),
    ['src/a.ts', 'src/b.ts']
  );
  assert.equal(
    report.warnings?.some((warning) => warning.includes('fanout limit')) ?? false,
    false
  );
  assert.deepEqual(
    report.evidence
      .filter((item) => item.extractorId === 'canonical-entity-graph')
      .map((item) => item.file)
      .sort(),
    ['evidence/a-one.ts', 'evidence/b-one.ts']
  );
});

test('indexProject records skipped files when resource limits are exceeded', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-limits-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/small.ts'), 'export const ok = 1;\n');
  await writeFile(path.join(repoRoot, 'src/large.ts'), `export const big = "${'x'.repeat(200)}";\n`);
  await initProject({ repoRoot });

  const index = await indexProject({ repoRoot, maxFileBytes: 40 });

  assert.equal(index.filesIndexed, 1);
  assert.equal(index.coverage?.skippedPaths, 1);
  assert.equal(index.coverage?.skipped?.[0]?.path, 'src/large.ts');

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const skipped = db
      .prepare('SELECT path, status, reason FROM index_coverage WHERE status = ?')
      .get('skipped') as { path: string; status: string; reason: string };
    assert.equal(skipped.path, 'src/large.ts');
    assert.equal(skipped.status, 'skipped');
    assert.match(skipped.reason, /maxFileBytes/);
  } finally {
    db.close();
  }
});

test('analyzeDiff warns when the working tree is stale relative to the latest index', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });
  await indexProject({ repoRoot });
  await writeFile(path.join(repoRoot, 'src/auth/session.ts'), 'export function validateSession() { return false; }\n');

  const report = await analyzeDiff({ repoRoot, changedFiles: ['src/auth/session.ts'] });

  assert.ok(report.warnings?.some((warning) => warning.includes('stale index')));
});

test('analyzeDiff returns structured test commands for repo-controlled filenames', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-command-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await mkdir(path.join(repoRoot, 'tests'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(repoRoot, 'tests/pwn$(touch_HACKED).test.ts'), 'import { a } from "../src/a"; test("a", () => a);\n');
  await initProject({ repoRoot });
  await indexProject({ repoRoot });

  const report = await analyzeDiff({ repoRoot, changedFiles: ['src/a.ts'], writeReport: true });

  const command = report.testCommands.find((item) => item.args?.includes('tests/pwn$(touch_HACKED).test.ts'));
  assert.ok(command);
  assert.deepEqual(command.args, ['test', '--', 'tests/pwn$(touch_HACKED).test.ts']);
  assert.ok(command.display.includes("'tests/pwn$(touch_HACKED).test.ts'"));
});

test('CLI analyze accepts --base and --head git merge-base diff input', async () => {
  const repoRoot = await makeFixtureRepo();
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'impact-trace@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Impact Trace Test'], { cwd: repoRoot });
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repoRoot, stdio: 'ignore' });
  await writeFile(
    path.join(repoRoot, 'src/auth/session.ts'),
    [
      'export function validateSession(token: string) {',
      '  return token.length > 2;',
      '}',
      ''
    ].join('\n')
  );
  execFileSync('git', ['add', 'src/auth/session.ts'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'change session'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['checkout', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  await writeFile(path.join(repoRoot, 'README.md'), 'Main branch only docs change.\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'main docs change'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['checkout', 'feature'], { cwd: repoRoot, stdio: 'ignore' });
  await initProject({ repoRoot });
  await indexProject({ repoRoot });

  const result = spawnSync(process.execPath, ['--import', tsxLoaderPath, path.resolve('src/cli.ts'), 'analyze', '--base', 'main', '--head', 'HEAD', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout) as { changedFiles: string[]; affectedFiles: Array<{ path: string }> };
  assert.deepEqual(report.changedFiles, ['src/auth/session.ts']);
  assert.equal(report.changedFiles.includes('README.md'), false);
  assert.ok(report.affectedFiles.some((file) => file.path === 'src/routes/private.ts'));
});

test('remember populates fact_embeddings (model, vector, dim) for non-redacted facts', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });

  const { remember, withAgentMemoryDb } = await import('../src/index.js');
  const { factId } = withAgentMemoryDb(repoRoot, false, (db) =>
    remember(db, {
      entity: 'file:src/auth/session.ts',
      attribute: 'observed',
      value: 'compiled cleanly with no warnings'
    })
  );

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const row = db
      .prepare('SELECT fact_id, model, length(vector) AS vec_len, dim FROM fact_embeddings WHERE fact_id = ?')
      .get(factId) as { fact_id: string; model: string; vec_len: number; dim: number } | undefined;
    assert.ok(row, 'expected fact_embeddings row for non-redacted fact');
    assert.equal(row?.model, 'stub-sha256');
    assert.equal(row?.dim, 768);
    assert.equal(row?.vec_len, 768);
  } finally {
    db.close();
  }
});

test('remember skips fact_embeddings when value triggers redaction (privacy gate)', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });

  const { remember, withAgentMemoryDb } = await import('../src/index.js');
  const { factId } = withAgentMemoryDb(repoRoot, false, (db) =>
    remember(db, {
      entity: 'file:src/secrets.ts',
      attribute: 'observed',
      value: 'leaked sk-test-secret-1234567890 in test fixture'
    })
  );

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const fact = db.prepare('SELECT redacted, value_blob FROM facts WHERE id = ?').get(factId) as { redacted: number; value_blob: string };
    assert.equal(fact.redacted, 1, 'redaction flag should be set');
    assert.equal(fact.value_blob, '[REDACTED]');

    const embedding = db.prepare('SELECT fact_id FROM fact_embeddings WHERE fact_id = ?').get(factId);
    assert.equal(embedding, undefined, 'redacted fact must not have a fact_embeddings row');
  } finally {
    db.close();
  }
});

test('remember with op=retract stores a retract fact and skips embedding', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });

  const { remember, withAgentMemoryDb } = await import('../src/index.js');
  const { factId } = withAgentMemoryDb(repoRoot, false, (db) =>
    remember(db, {
      entity: 'file:src/auth.ts',
      attribute: 'observed',
      value: 'no longer compiles',
      op: 'retract'
    })
  );

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const fact = db.prepare('SELECT op FROM facts WHERE id = ?').get(factId) as { op: string };
    assert.equal(fact.op, 'retract');

    const embedding = db.prepare('SELECT fact_id FROM embeddings WHERE fact_id = ?').get(factId);
    assert.equal(embedding, undefined, 'retract facts must not be embedded');
  } finally {
    db.close();
  }
});

test('recall with currentOnly suppresses retracted facts and dedupes by latest op', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });

  const { remember, recall, withAgentMemoryDb } = await import('../src/index.js');

  withAgentMemoryDb(repoRoot, false, (db) =>
    remember(db, { entity: 'file:src/y.ts', attribute: 'observed', value: 'kept' })
  );
  withAgentMemoryDb(repoRoot, false, (db) =>
    remember(db, { entity: 'file:src/y.ts', attribute: 'observed', value: 'dropped' })
  );
  withAgentMemoryDb(repoRoot, false, (db) =>
    remember(db, { entity: 'file:src/y.ts', attribute: 'observed', value: 'dropped', op: 'retract' })
  );

  const all = withAgentMemoryDb(repoRoot, true, (db) =>
    recall(db, { entity: 'file:src/y.ts', attribute: 'observed' })
  );
  assert.equal(all.facts.length, 3, 'without currentOnly all facts surface');

  const current = withAgentMemoryDb(repoRoot, true, (db) =>
    recall(db, { entity: 'file:src/y.ts', attribute: 'observed', currentOnly: true })
  );
  const currentValues = current.facts.map((fact) => fact.value).sort();
  assert.deepEqual(currentValues, ['kept'], 'currentOnly drops the retracted value');
  for (const fact of current.facts) {
    assert.equal(fact.op, 'assert', 'currentOnly returns only assert ops');
  }
});

test('recall with asOfTx returns only facts in the ancestor DAG of that tx', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });

  const { remember, recall, withAgentMemoryDb } = await import('../src/index.js');

  const earlier = withAgentMemoryDb(repoRoot, false, (db) =>
    remember(db, { entity: 'file:src/x.ts', attribute: 'observed', value: 'first' })
  );
  const middle = withAgentMemoryDb(repoRoot, false, (db) =>
    remember(db, { entity: 'file:src/x.ts', attribute: 'observed', value: 'second' })
  );
  withAgentMemoryDb(repoRoot, false, (db) =>
    remember(db, { entity: 'file:src/x.ts', attribute: 'observed', value: 'third' })
  );

  const upToMiddle = withAgentMemoryDb(repoRoot, true, (db) =>
    recall(db, { entity: 'file:src/x.ts', attribute: 'observed', asOfTx: middle.txId })
  );
  const values = upToMiddle.facts.map((fact) => fact.value).sort();
  assert.deepEqual(values, ['first', 'second'], 'asOfTx should exclude facts after the tx');

  const allRecall = withAgentMemoryDb(repoRoot, true, (db) =>
    recall(db, { entity: 'file:src/x.ts', attribute: 'observed' })
  );
  assert.equal(allRecall.facts.length, 3, 'recall without asOfTx returns all facts');

  // sanity: earlier tx alone still includes its own fact
  const earlierOnly = withAgentMemoryDb(repoRoot, true, (db) =>
    recall(db, { entity: 'file:src/x.ts', attribute: 'observed', asOfTx: earlier.txId })
  );
  assert.deepEqual(earlierOnly.facts.map((f) => f.value), ['first']);
});

test('reembedFacts default fills only missing rows; --all overwrites everything', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });

  const { remember, reembedFacts, withAgentMemoryDb } = await import('../src/index.js');

  for (const value of ['alpha', 'beta', 'gamma']) {
    withAgentMemoryDb(repoRoot, false, (db) =>
      remember(db, { entity: 'file:src/r.ts', attribute: 'observed', value })
    );
  }

  // Pretend one row was wiped (simulate a model swap that left one fact uncovered)
  const dbBefore = new DatabaseSync(databasePath(repoRoot), { readOnly: false });
  try {
    dbBefore
      .prepare('DELETE FROM fact_embeddings WHERE rowid IN (SELECT rowid FROM fact_embeddings LIMIT 1)')
      .run();
  } finally {
    dbBefore.close();
  }

  const incremental = await reembedFacts(repoRoot, { model: 'stub-sha256' });
  assert.equal(incremental.embedded, 1, 'default reembed only touches missing facts');
  assert.equal(incremental.candidates, 1);

  const full = await reembedFacts(repoRoot, { model: 'stub-sha256', all: true });
  assert.equal(full.embedded, 3, '--all reembed touches every eligible fact');
  assert.equal(full.candidates, 3);

  const dbAfter = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const count = dbAfter
      .prepare("SELECT count(*) AS n FROM fact_embeddings WHERE model = 'stub-sha256'")
      .get() as { n: number };
    assert.equal(count.n, 3);
  } finally {
    dbAfter.close();
  }
});

test('recallOnRepo semantic mode ranks candidate facts by stub embedding similarity', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });

  const { remember, recallOnRepo, withAgentMemoryDb } = await import('../src/index.js');

  // Three facts with embeddings (stub model is deterministic on text).
  for (const value of ['authentication flow looks fine', 'rate limiter dropped a request', 'vector index works']) {
    withAgentMemoryDb(repoRoot, false, (db) =>
      remember(db, { entity: 'file:src/sem.ts', attribute: 'observed', value })
    );
  }

  const result = await recallOnRepo(repoRoot, {
    query: 'auth',
    semantic: true,
    entity: 'file:src/sem.ts',
    k: 2
  });

  assert.equal(result.facts.length, 2, 'top-k should respect the k limit');
  for (const fact of result.facts) {
    assert.equal(fact.entityId, 'file:src/sem.ts');
    assert.equal(fact.attribute, 'observed');
  }
  // The facts list comes from the ranked semantic search; we only check that
  // the returned ids are a subset of the seeded values' ids (no foreign rows).
  const seededValues = new Set(['authentication flow looks fine', 'rate limiter dropped a request', 'vector index works']);
  for (const fact of result.facts) {
    assert.ok(seededValues.has(fact.value as string), `unexpected fact value: ${fact.value}`);
  }
});

test('mergeBranches creates a multi-parent tx and target recall sees source facts', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });

  const { remember, recall, createBranch, mergeBranches, withAgentMemoryDb } = await import('../src/index.js');

  // Establish baseline on main
  withAgentMemoryDb(repoRoot, false, (db) =>
    remember(db, { entity: 'file:src/m.ts', attribute: 'observed', value: 'on main' })
  );

  // Fork
  withAgentMemoryDb(repoRoot, false, (db) =>
    createBranch(db, { name: 'experiment-merge', from: 'main' })
  );

  // Diverge: assert on the experiment branch only
  withAgentMemoryDb(repoRoot, false, (db) =>
    remember(db, {
      entity: 'file:src/m.ts',
      attribute: 'observed',
      value: 'on experiment',
      branch: 'experiment-merge'
    })
  );

  // Before merge: main does not see the experiment-only fact
  const mainBefore = withAgentMemoryDb(repoRoot, true, (db) =>
    recall(db, { entity: 'file:src/m.ts', attribute: 'observed', branch: 'main' })
  );
  assert.deepEqual(
    mainBefore.facts.map((f) => f.value).sort(),
    ['on main'],
    'main should not see experiment-only fact pre-merge'
  );

  // Merge experiment-merge into main
  const merge = withAgentMemoryDb(repoRoot, false, (db) =>
    mergeBranches(db, { target: 'main', source: 'experiment-merge' })
  );
  assert.match(merge.mergeTxId, /^[0-9a-f]{64}$/);

  // Verify the merge tx has two parents in transaction_parents
  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const parents = db
      .prepare('SELECT parent_tx_id FROM transaction_parents WHERE tx_id = ? ORDER BY parent_tx_id')
      .all(merge.mergeTxId) as Array<{ parent_tx_id: string }>;
    assert.equal(parents.length, 2, 'merge tx should have two parents');
  } finally {
    db.close();
  }

  // After merge: main sees both facts via the multi-parent DAG walk
  const mainAfter = withAgentMemoryDb(repoRoot, true, (db) =>
    recall(db, {
      entity: 'file:src/m.ts',
      attribute: 'observed',
      branch: 'main',
      asOfTx: merge.mergeTxId
    })
  );
  assert.deepEqual(
    mainAfter.facts.map((f) => f.value).sort(),
    ['on experiment', 'on main'],
    'main should see both facts after merge via asOfTx walk'
  );
});

test('mergeBranches refuses self-merge and empty source', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });
  const { mergeBranches, createBranch, withAgentMemoryDb } = await import('../src/index.js');

  assert.throws(
    () => withAgentMemoryDb(repoRoot, false, (db) => mergeBranches(db, { target: 'main', source: 'main' })),
    /cannot merge a branch into itself/
  );

  withAgentMemoryDb(repoRoot, false, (db) => createBranch(db, { name: 'empty-source', from: 'main' }));
  assert.throws(
    () => withAgentMemoryDb(repoRoot, false, (db) => mergeBranches(db, { target: 'main', source: 'empty-source' })),
    /source branch has no head/
  );
});

function runCli(repoRoot: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', tsxLoaderPath, path.resolve('src/cli.ts'), ...args],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('CLI branch + trace + retract subcommands round-trip', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });

  // branch from main
  const branchRun = runCli(repoRoot, ['branch', '--name', 'cli-experiment']);
  assert.equal(branchRun.status, 0, `branch failed: ${branchRun.stderr}`);
  const branchPayload = JSON.parse(branchRun.stdout) as { branchId: string };
  assert.match(branchPayload.branchId, /^br_[0-9a-f]{16}$/);

  // remember a source fact
  const sourceRun = runCli(repoRoot, [
    'remember',
    '--entity', 'file:src/x.ts',
    '--attribute', 'observed',
    '--value', '"first inference"'
  ]);
  assert.equal(sourceRun.status, 0, `source remember failed: ${sourceRun.stderr}`);
  const source = JSON.parse(sourceRun.stdout) as { factId: string };

  // remember a derived fact citing the source as evidence
  const derivedRun = runCli(repoRoot, [
    'remember',
    '--entity', 'file:src/x.ts',
    '--attribute', 'concern',
    '--value', '"derived"',
    '--evidence-fact-ids', source.factId
  ]);
  assert.equal(derivedRun.status, 0, `derived remember failed: ${derivedRun.stderr}`);
  const derived = JSON.parse(derivedRun.stdout) as { factId: string };

  // trace from derived back to source
  const traceRun = runCli(repoRoot, ['trace', '--fact-id', derived.factId]);
  assert.equal(traceRun.status, 0, `trace failed: ${traceRun.stderr}`);
  const tracePayload = JSON.parse(traceRun.stdout) as { chain: Array<{ id: string }> };
  assert.deepEqual(
    tracePayload.chain.map((entry) => entry.id),
    [derived.factId, source.factId]
  );

  // retract sugar: equivalent to remember --op retract
  const retractRun = runCli(repoRoot, [
    'retract',
    '--entity', 'file:src/x.ts',
    '--attribute', 'observed',
    '--value', '"first inference"'
  ]);
  assert.equal(retractRun.status, 0, `retract failed: ${retractRun.stderr}`);

  // recall --current-only should drop the retracted value
  const recallRun = runCli(repoRoot, [
    'recall',
    '--entity', 'file:src/x.ts',
    '--attribute', 'observed',
    '--current-only'
  ]);
  assert.equal(recallRun.status, 0, `recall failed: ${recallRun.stderr}`);
  const recallPayload = JSON.parse(recallRun.stdout) as { facts: Array<{ value: string }> };
  assert.deepEqual(recallPayload.facts, [], 'current-only excludes the retracted value');
});

test('CLI exposes remember/recall as round-trip subcommands', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });

  const rememberRun = spawnSync(
    process.execPath,
    [
      '--import',
      tsxLoaderPath,
      path.resolve('src/cli.ts'),
      'remember',
      '--entity',
      'file:src/auth/session.ts',
      '--attribute',
      'observed',
      '--value',
      '"compiled"'
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  assert.equal(rememberRun.status, 0, `remember failed: ${rememberRun.stderr}`);
  const remembered = JSON.parse(rememberRun.stdout) as { factId: string; txId: string };
  assert.match(remembered.factId, /^[0-9a-f]{64}$/);

  const recallRun = spawnSync(
    process.execPath,
    [
      '--import',
      tsxLoaderPath,
      path.resolve('src/cli.ts'),
      'recall',
      '--entity',
      'file:src/auth/session.ts',
      '--attribute',
      'observed'
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  assert.equal(recallRun.status, 0, `recall failed: ${recallRun.stderr}`);
  const recalled = JSON.parse(recallRun.stdout) as { facts: Array<{ id: string; value: unknown }> };
  assert.equal(recalled.facts.length, 1);
  assert.equal(recalled.facts[0]!.id, remembered.factId);
  assert.equal(recalled.facts[0]!.value, 'compiled');
});

test('indexProject dual-writes relations to facts/transactions and advances main head', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });
  await indexProject({ repoRoot });

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const txCount = db.prepare('SELECT count(*) AS count FROM transactions WHERE agent = ?').get('indexer') as { count: number };
    assert.equal(txCount.count, 1, 'expected one indexer-produced transaction');

    const importsFacts = db
      .prepare(
        "SELECT f.entity_id, f.value_blob FROM facts f INNER JOIN transactions t ON f.tx_id = t.id WHERE t.agent = 'indexer' AND f.attribute = 'imports' ORDER BY f.entity_id"
      )
      .all() as Array<{ entity_id: string; value_blob: string }>;
    assert.ok(
      importsFacts.some(
        (row) => row.entity_id === 'file:src/routes/private.ts' && JSON.parse(row.value_blob) === 'file:src/auth/session.ts'
      ),
      'expected an imports fact from private.ts to session.ts'
    );

    const mainHead = db.prepare("SELECT head_tx_id FROM branches WHERE name = 'main'").get() as { head_tx_id: string | null };
    assert.match(mainHead.head_tx_id ?? '', /^[0-9a-f]{64}$/, 'main branch head should be advanced to indexer tx');

    const declaresAttr = db.prepare("SELECT name, value_type FROM attribute_defs WHERE name = 'declares'").get() as { name: string; value_type: string } | undefined;
    assert.ok(declaresAttr, 'expected declares attribute to be auto-registered');
    assert.equal(declaresAttr?.value_type, 'entity_ref');

    const evidenceAttr = db.prepare("SELECT name, value_type FROM attribute_defs WHERE name = 'evidence_snippet'").get() as { name: string; value_type: string } | undefined;
    assert.ok(evidenceAttr, 'expected evidence_snippet attribute to be auto-registered');
    assert.equal(evidenceAttr?.value_type, 'text');

    const evidenceChain = db
      .prepare(
        `SELECT fp.fact_id, fp.source_fact_id, src.attribute AS source_attribute
         FROM fact_provenance fp
         INNER JOIN facts target ON fp.fact_id = target.id
         INNER JOIN facts src ON fp.source_fact_id = src.id
         WHERE target.attribute = 'imports' AND src.attribute = 'evidence_snippet'`
      )
      .all() as Array<{ fact_id: string; source_fact_id: string; source_attribute: string }>;
    assert.ok(
      evidenceChain.length > 0,
      'expected at least one fact_provenance edge from imports fact to evidence_snippet fact'
    );
  } finally {
    db.close();
  }
});

test('indexProject maps adapter relation kinds to static memory attributes', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-relation-kind-memory-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  const sourcePath = 'src/source.ts';
  const cases: Array<{ kind: RelationKind; target: string; expectedAttribute: string }> = [
    { kind: 'CALLS', target: 'src/callee.ts', expectedAttribute: 'calls' },
    { kind: 'VERIFIES', target: 'src/verified.ts', expectedAttribute: 'tests' },
    { kind: 'REFERENCES', target: 'src/referenced.ts', expectedAttribute: 'references' },
    {
      kind: 'BREAKS_COMPATIBILITY_WITH',
      target: 'src/legacy-api.ts',
      expectedAttribute: 'breaks_compat'
    }
  ];

  await writeFile(path.join(repoRoot, sourcePath), 'export const source = 1;\n');
  for (const testCase of cases) {
    await writeFile(
      path.join(repoRoot, testCase.target),
      `export const ${testCase.kind.toLowerCase()} = 1;\n`
    );
  }
  await initProject({ repoRoot });

  const seedDb = new DatabaseSync(databasePath(repoRoot));
  try {
    for (const attribute of cases.map((testCase) => testCase.expectedAttribute)) {
      seedDb
        .prepare(
          `INSERT INTO attribute_defs (name, value_type, is_code_relation, description)
           VALUES (?, 'entity_ref', 0, 'stale dynamic test row')
           ON CONFLICT(name) DO UPDATE SET is_code_relation = 0`
        )
        .run(attribute);
    }
  } finally {
    seedDb.close();
  }

  const registry = new AdapterRegistry();
  registry.register({
    id: 'relation-kind-memory-test-adapter',
    version: '1',
    capabilities: ['calls', 'references', 'tests'],
    supports: (file) => file.language === 'typescript',
    start: (_ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun => ({
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        if (file.relativePath !== sourcePath) {
          return;
        }
        for (const testCase of cases) {
          yield {
            kind: 'relation',
            relation: {
              source: { kind: 'file', path: sourcePath, languageId: file.language },
              target: { kind: 'file', path: testCase.target, languageId: file.language },
              kind: testCase.kind,
              metadata: {
                confidence: 'proven',
                provenance: `relation-kind-memory-test-adapter:${testCase.kind}`
              },
              evidence: [
                {
                  file: `adapter/${testCase.kind}.evidence`,
                  snippet: `${testCase.kind} evidence`,
                  confidence: 'proven'
                }
              ]
            }
          };
        }
      }
    })
  });

  await indexProjectWithRegistryForTest({ repoRoot }, registry);

  const expectedRows = cases
    .map((testCase) => ({
      attribute: testCase.expectedAttribute,
      target: `file:${testCase.target}`,
      isCodeRelation: 1
    }))
    .sort((a, b) => a.attribute.localeCompare(b.attribute));
  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const factRows = db
      .prepare(
        `SELECT f.attribute, f.value_blob, ad.is_code_relation
         FROM facts f
         INNER JOIN transactions t ON f.tx_id = t.id
         INNER JOIN attribute_defs ad ON ad.name = f.attribute
         WHERE t.agent = 'indexer' AND f.entity_id = ?
         ORDER BY f.attribute`
      )
      .all(`file:${sourcePath}`) as Array<{
        attribute: string;
        value_blob: string;
        is_code_relation: number;
      }>;

    assert.deepEqual(
      factRows.map((row) => ({
        attribute: row.attribute,
        target: JSON.parse(row.value_blob) as string,
        isCodeRelation: row.is_code_relation
      })),
      expectedRows
    );
  } finally {
    db.close();
  }

  const profile = await profileEntity(repoRoot, { entity: `file:${sourcePath}` });
  assert.deepEqual(
    profile.staticFacts
      .map((fact) => ({ attribute: fact.attribute, target: fact.value }))
      .sort((a, b) => a.attribute.localeCompare(b.attribute)),
    expectedRows.map((row) => ({ attribute: row.attribute, target: row.target }))
  );
  assert.deepEqual(profile.dynamicFacts, []);
});

test('CLI reflect with stub provider summarizes older facts', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });

  const remember1 = runCli(repoRoot, [
    'remember',
    '--entity', 'file:src/cli-reflect.ts',
    '--attribute', 'observed',
    '--value', '"first"'
  ]);
  assert.equal(remember1.status, 0, `remember1 failed: ${remember1.stderr}`);
  const remember2 = runCli(repoRoot, [
    'remember',
    '--entity', 'file:src/cli-reflect.ts',
    '--attribute', 'verified',
    '--value', '"second"'
  ]);
  assert.equal(remember2.status, 0, `remember2 failed: ${remember2.stderr}`);

  // Age the transactions so they qualify for reflection.
  const { withAgentMemoryDb } = await import('../src/index.js');
  withAgentMemoryDb(repoRoot, false, (db) => {
    db.prepare("UPDATE transactions SET ts = '2020-01-01T00:00:00.000Z'").run();
  });

  const reflectRun = spawnSync(
    process.execPath,
    [
      '--import',
      tsxLoaderPath,
      path.resolve('src/cli.ts'),
      'reflect',
      '--older-than-days',
      '1',
      '--model',
      'stub'
    ],
    { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, IMPACT_TRACE_REFLECTION_MODEL: 'stub' } }
  );
  assert.equal(reflectRun.status, 0, `reflect failed: ${reflectRun.stderr}`);
  const payload = JSON.parse(reflectRun.stdout) as { summarized: number; model: string };
  assert.equal(payload.summarized, 1);
  assert.equal(payload.model, 'stub');
});

test('CLI branch --abandon and gc-branches round-trip', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });

  const branchRun = runCli(repoRoot, ['branch', '--name', 'speculative-cli']);
  assert.equal(branchRun.status, 0, `branch failed: ${branchRun.stderr}`);

  const rememberRun = runCli(repoRoot, [
    'remember',
    '--branch', 'speculative-cli',
    '--entity', 'file:src/cli-gc.ts',
    '--attribute', 'observed',
    '--value', '"to be archived"'
  ]);
  assert.equal(rememberRun.status, 0, `remember failed: ${rememberRun.stderr}`);

  const abandonRun = runCli(repoRoot, ['branch', '--abandon', 'speculative-cli']);
  assert.equal(abandonRun.status, 0, `abandon failed: ${abandonRun.stderr}`);
  const abandonPayload = JSON.parse(abandonRun.stdout) as { state: string; alreadyAbandoned: boolean };
  assert.equal(abandonPayload.state, 'abandoned');
  assert.equal(abandonPayload.alreadyAbandoned, false);

  const dryGcRun = runCli(repoRoot, ['gc-branches', '--dry-run']);
  assert.equal(dryGcRun.status, 0, `dry-run gc failed: ${dryGcRun.stderr}`);
  const dryPayload = JSON.parse(dryGcRun.stdout) as { dryRun: boolean; archivedTransactions: number };
  assert.equal(dryPayload.dryRun, true);
  assert.equal(dryPayload.archivedTransactions, 1);

  const gcRun = runCli(repoRoot, ['gc-branches']);
  assert.equal(gcRun.status, 0, `gc failed: ${gcRun.stderr}`);
  const gcPayload = JSON.parse(gcRun.stdout) as { dryRun: boolean; archivedTransactions: number };
  assert.equal(gcPayload.dryRun, false);
  assert.equal(gcPayload.archivedTransactions, 1);

  // recall on the speculative branch must now return zero facts.
  const recallRun = runCli(repoRoot, [
    'recall',
    '--branch', 'speculative-cli',
    '--entity', 'file:src/cli-gc.ts'
  ]);
  assert.equal(recallRun.status, 0, `recall failed: ${recallRun.stderr}`);
  const recallPayload = JSON.parse(recallRun.stdout) as { facts: Array<unknown> };
  assert.equal(recallPayload.facts.length, 0, 'archived branch facts must be hidden from recall');
});

test('CLI branch --abandon refuses to abandon main', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });

  const run = runCli(repoRoot, ['branch', '--abandon', 'main']);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /cannot abandon protected branch/);
});
