import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { importScipJson, indexProject, initProject } from '../src/index.js';
import { remember } from '../src/agent_memory.js';
import type { ScannedFile } from '../src/types.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { indexProjectWithRegistryForTest } from '../src/indexer.js';
import { readGitSnapshot } from '../src/git-snapshot.js';
import { normalizeRepoRoot } from '../src/security.js';
import { getRepoId, latestCompletedIndexRun, openDatabase } from '../src/store.js';

// Correctness oracle for incremental indexing (S1). The graph rows
// (entities/relations/relation_evidence) of the latest completed run, with the
// run id stripped, are the contract that any future incremental path must
// reproduce exactly. This scaffold pins the property that matters today — a full
// reindex is deterministic across runs (modulo index_run_id and run timestamps).
// Slice 2 will reuse `snapshotGraph` to assert: incremental-to-an-end-state ==
// full-reindex-of-that-end-state.

type GraphSnapshot = {
  files: Array<Record<string, unknown>>;
  coverage: Array<Record<string, unknown>>;
  entities: Array<Record<string, unknown>>;
  entityVersions: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  relationEvidence: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  symbols: Array<Record<string, unknown>>;
  contracts: Array<Record<string, unknown>>;
  contractVersions: Array<Record<string, unknown>>;
};

// Snapshot every table the incremental carry-forward mutates, modulo the columns
// that legitimately differ between two repos: index_run_id (the cohort marker)
// and autoincrement surrogate ids (files.id/symbols.id/edges.id). Content-
// addressed ids (entities/relations/*_evidence) are stable, so they are
// compared directly; autoincrement-keyed rows (symbols/edges) are projected
// through files.path so the comparison is identity-free.
function snapshotGraph(root: string): GraphSnapshot {
  const normalized = normalizeRepoRoot(root);
  const db = openDatabase(normalized, { readOnly: true });
  const repoId = getRepoId(db, normalized);
  const runId = latestCompletedIndexRun(db, repoId);
  const files = db
    .prepare(
      `SELECT path, language, content_hash
       FROM files WHERE repo_id = ? AND index_run_id = ? ORDER BY path`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  const coverage = db
    .prepare(
      `SELECT path, adapter_id, language_id, status, reason
       FROM index_coverage WHERE index_run_id = ? ORDER BY path, adapter_id`
    )
    .all(runId) as Array<Record<string, unknown>>;
  const entities = db
    .prepare(
      `SELECT id, kind, path, symbol, language_id, display_name
       FROM entities WHERE repo_id = ? AND updated_index_run_id = ? ORDER BY id`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  const entityVersions = db
    .prepare(
      `SELECT ev.entity_id, ev.content_hash, ev.location_json, ev.state
       FROM entity_versions ev
       JOIN entities e ON e.id = ev.entity_id
       WHERE e.repo_id = ? AND ev.index_run_id = ? ORDER BY ev.entity_id`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  const relations = db
    .prepare(
      `SELECT id, source_entity_id, target_entity_id, kind, confidence, provenance
       FROM relations WHERE repo_id = ? AND index_run_id = ? ORDER BY id`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  const relationEvidence = db
    .prepare(
      `SELECT id, relation_id, file_path, kind, snippet, confidence, start_line, end_line, start_col, end_col
       FROM relation_evidence WHERE repo_id = ? AND index_run_id = ? ORDER BY id`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  const evidence = db
    .prepare(
      `SELECT id, file_path, kind, snippet, confidence
       FROM evidence WHERE repo_id = ? AND index_run_id = ? ORDER BY id`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  // edges/symbols use autoincrement ids that differ between repos; project
  // through files.path and order by stable columns only.
  const edges = db
    .prepare(
      `SELECT src.path AS source_path, tgt.path AS target_path_resolved,
              e.kind, e.target_path, e.confidence, e.provenance
       FROM edges e
       JOIN files src ON src.id = e.source_file_id
       LEFT JOIN files tgt ON tgt.id = e.target_file_id
       WHERE e.repo_id = ? AND e.index_run_id = ?
       ORDER BY src.path, e.kind, e.target_path`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  const symbols = db
    .prepare(
      `SELECT f.path AS file_path, s.name, s.kind, s.exported, s.semantic_id
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE f.repo_id = ? AND s.index_run_id = ?
       ORDER BY f.path, s.semantic_id`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  const contracts = db.prepare(`SELECT id, kind, service_name, path, display_name, metadata_json
    FROM contracts WHERE repo_id = ? ORDER BY id`).all(repoId) as Array<Record<string, unknown>>;
  const contractVersions = db.prepare(`SELECT contract_id, content_hash, schema_version,
      compatibility_json, breaking_change_summary FROM contract_versions
    WHERE index_run_id = ? ORDER BY contract_id`).all(runId) as Array<Record<string, unknown>>;
  db.close();
  return {
    files,
    coverage,
    entities,
    entityVersions,
    relations,
    relationEvidence,
    evidence,
    edges,
    symbols,
    contracts,
    contractVersions
  };
}

function writeChain(root: string): void {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src/leaf.ts'), 'export function foo() {\n  return 1;\n}\n');
  writeFileSync(
    path.join(root, 'src/a.ts'),
    "import { foo } from './leaf.js';\nexport function bar() {\n  return foo();\n}\n"
  );
  writeFileSync(
    path.join(root, 'src/aa.ts'),
    "import { bar } from './a.js';\nexport function baz() {\n  return bar();\n}\n"
  );
}

test('a full reindex is byte-identical across runs (modulo run id) — the S1 oracle baseline', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-oracle-'));
  try {
    writeChain(root);
    await initProject({ repoRoot: root });

    await indexProject({ repoRoot: root });
    const first = snapshotGraph(root);

    // Re-index with zero source changes: the graph must be reproduced exactly.
    await indexProject({ repoRoot: root });
    const second = snapshotGraph(root);

    assert.deepEqual(second, first);
    assert.ok(first.relations.length > 0, 'fixture must produce relations to make the oracle meaningful');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The S1 oracle proper: a changed full-index adapter input must use full
// extraction, and the resulting graph must be byte-identical to a single full
// reindex of the same end state.
const EDITED_LEAF = 'export function foo() {\n  return 2;\n}\n';

test('a changed full-index file is fully re-extracted and byte-identical to a fresh index', async () => {
  const incrementalRoot = mkdtempSync(path.join(tmpdir(), 'parallax-oracle-incr-'));
  const fullRoot = mkdtempSync(path.join(tmpdir(), 'parallax-oracle-full-'));
  try {
    // Existing repo: full index, then edit leaf.ts body only and re-index.
    writeChain(incrementalRoot);
    await initProject({ repoRoot: incrementalRoot });
    await indexProject({ repoRoot: incrementalRoot });
    writeFileSync(path.join(incrementalRoot, 'src/leaf.ts'), EDITED_LEAF);
    const rerun = await indexProject({ repoRoot: incrementalRoot });
    assert.equal(
      rerun.mode,
      'full',
      'editing a full-index file must promote the rerun to full extraction'
    );
    const incrementalSnapshot = snapshotGraph(incrementalRoot);

    // Full repo: a single full index of the same end state.
    writeChain(fullRoot);
    writeFileSync(path.join(fullRoot, 'src/leaf.ts'), EDITED_LEAF);
    await initProject({ repoRoot: fullRoot });
    const full = await indexProject({ repoRoot: fullRoot });
    assert.equal(full.mode, 'full', 'a first index of a fresh repo is always full');
    const fullSnapshot = snapshotGraph(fullRoot);

    // The oracle is only meaningful if the carried-forward tables are non-empty;
    // otherwise the deepEqual is vacuously true. The import chain produces
    // cross-file edges + call relations, and the functions produce symbols.
    assert.ok(fullSnapshot.relations.length > 0, 'fixture must produce relations');
    assert.ok(fullSnapshot.edges.length > 0, 'fixture must produce cross-file edges');
    assert.ok(fullSnapshot.symbols.length > 0, 'fixture must produce symbols');
    assert.deepEqual(incrementalSnapshot, fullSnapshot);
  } finally {
    rmSync(incrementalRoot, { recursive: true, force: true });
    rmSync(fullRoot, { recursive: true, force: true });
  }
});

// A changed file with outgoing rows exercises the stale-row risk directly. Two
// consecutive edits pin that every promoted run reconstructs the complete graph.
const A_DROP_CALL = "import { foo } from './leaf.js';\nexport function bar() {\n  return 0;\n}\n";
const AA_EDIT = "import { bar } from './a.js';\nexport function baz() {\n  return bar() + 1;\n}\n";

test('consecutive full-index edits drop vanished relations and remain byte-identical to fresh', async () => {
  const incrementalRoot = mkdtempSync(path.join(tmpdir(), 'parallax-oracle-drop-incr-'));
  const fullRoot = mkdtempSync(path.join(tmpdir(), 'parallax-oracle-drop-full-'));
  try {
    // Full, then edit a.ts (drops its CALLS to foo, keeps the import), then edit
    // aa.ts. Both reruns must reconstruct all full-index output.
    writeChain(incrementalRoot);
    await initProject({ repoRoot: incrementalRoot });
    await indexProject({ repoRoot: incrementalRoot });
    writeFileSync(path.join(incrementalRoot, 'src/a.ts'), A_DROP_CALL);
    const hop1 = await indexProject({ repoRoot: incrementalRoot });
    assert.equal(hop1.mode, 'full', 'editing a full-index file must force full extraction');
    writeFileSync(path.join(incrementalRoot, 'src/aa.ts'), AA_EDIT);
    const hop2 = await indexProject({ repoRoot: incrementalRoot });
    assert.equal(hop2.mode, 'full', 'a second full-index edit must also force full extraction');
    const incrementalSnapshot = snapshotGraph(incrementalRoot);

    // Full reindex of the same end state.
    writeChain(fullRoot);
    writeFileSync(path.join(fullRoot, 'src/a.ts'), A_DROP_CALL);
    writeFileSync(path.join(fullRoot, 'src/aa.ts'), AA_EDIT);
    await initProject({ repoRoot: fullRoot });
    await indexProject({ repoRoot: fullRoot });
    const fullSnapshot = snapshotGraph(fullRoot);

    // The dropped a.ts->foo CALLS relation must be stranded on the prior run, not
    // carried forward into the new cohort.
    assert.ok(
      !incrementalSnapshot.relations.some(
        (row) => row.kind === 'CALLS' && row.source_entity_id === 'file:src/a.ts'
      ),
      'the dropped CALLS from a.ts must not survive in the new run cohort'
    );
    assert.deepEqual(incrementalSnapshot, fullSnapshot);
  } finally {
    rmSync(incrementalRoot, { recursive: true, force: true });
    rmSync(fullRoot, { recursive: true, force: true });
  }
});

function writeAliasProject(root: string, target: 'src' | 'other'): void {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'other'), { recursive: true });
  writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': [`${target}/*`] } } })
  );
  writeFileSync(path.join(root, 'src/app.ts'), "import { session } from '@app/session';\nsession();\n");
  writeFileSync(path.join(root, 'src/session.ts'), 'export function session() { return "src"; }\n');
  writeFileSync(path.join(root, 'other/session.ts'), 'export function session() { return "other"; }\n');
}

test('changing full-index context forces a full extraction and matches a fresh index', async () => {
  const incrementalRoot = mkdtempSync(path.join(tmpdir(), 'parallax-oracle-context-incr-'));
  const fullRoot = mkdtempSync(path.join(tmpdir(), 'parallax-oracle-context-full-'));
  try {
    writeAliasProject(incrementalRoot, 'src');
    await initProject({ repoRoot: incrementalRoot });
    await indexProject({ repoRoot: incrementalRoot });
    writeAliasProject(incrementalRoot, 'other');
    const rerun = await indexProject({ repoRoot: incrementalRoot });

    writeAliasProject(fullRoot, 'other');
    await initProject({ repoRoot: fullRoot });
    await indexProject({ repoRoot: fullRoot });

    const incrementalSnapshot = snapshotGraph(incrementalRoot);
    const fullSnapshot = snapshotGraph(fullRoot);
    assert.ok(
      incrementalSnapshot.edges.some(
        (row) => row.source_path === 'src/app.ts' && row.target_path_resolved === 'other/session.ts'
      ),
      'the final alias must resolve src/app.ts to other/session.ts'
    );
    assert.deepEqual(incrementalSnapshot, fullSnapshot);
    assert.equal(rerun.mode, 'full', 'full-index adapter context invalidates changed-only extraction');
  } finally {
    rmSync(incrementalRoot, { recursive: true, force: true });
    rmSync(fullRoot, { recursive: true, force: true });
  }
});

for (const output of ['entity', 'file diagnostic', 'global diagnostic', 'contract', 'foreign placeholder'] as const) {
  test(`unchanged carry-forward preserves ${output} while refreshing skipped coverage`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'parallax-carry-parity-'));
    const fresh = mkdtempSync(path.join(tmpdir(), 'parallax-carry-fresh-'));
    try {
      const makeFiles = (dir: string, unsupported: string) => {
        writeFileSync(path.join(dir, 'a#diagnostic:literal.ts'), 'export const a = 1;\n');
        if (output === 'contract') writeFileSync(path.join(dir, 'schema.proto'), 'syntax = "proto3";\n');
        writeFileSync(path.join(dir, 'unsupported.py'), unsupported);
      };
      makeFiles(root, 'pass\n');
      makeFiles(fresh, 'x'.repeat(200));
      const registry = new AdapterRegistry();
      registry.register({
        id: 'carry-oracle', version: '1', capabilities: ['references'],
        ...(['global diagnostic', 'foreign placeholder'].includes(output) ? {} : { outputOwnership: 'processed-file' as const }),
        supports: (file) => file.language === 'typescript' || file.language === 'protobuf',
        start: () => ({ async *process(file) {
          if (output === 'contract') {
            if (file.language === 'protobuf') yield { kind: 'entity', entity: {
              kind: 'contract', path: file.relativePath, displayName: 'Custom contract',
              metadata: { serviceName: 'custom-service', schemaVersion: 'v2', compatibility: { marker: 'preserve' } }
            } };
            return;
          }
          if (output === 'foreign placeholder') {
            yield { kind: 'relation', relation: {
              source: { kind: 'file', path: file.relativePath },
              target: { kind: 'contract', path: 'external.proto' }, kind: 'DEPENDS_ON'
            } };
            return;
          }
          if (output === 'entity') {
            yield { kind: 'entity', entity: { kind: 'file', path: file.relativePath, metadata: { marker: 'preserve' } } };
          } else {
            yield { kind: 'diagnostic', level: 'warn', message: 'persistent warning',
              ...(output === 'file diagnostic' ? { file: file.relativePath } : {}) };
          }
        } })
      });
      await indexProjectWithRegistryForTest({ repoRoot: root, maxFileBytes: 100 }, registry);
      writeFileSync(path.join(root, 'unsupported.py'), 'x'.repeat(200));
      const rerun = await indexProjectWithRegistryForTest({ repoRoot: root, maxFileBytes: 100 }, registry);
      await indexProjectWithRegistryForTest({ repoRoot: fresh, maxFileBytes: 100 }, registry);
      assert.equal(rerun.mode, 'incremental');
      const warnings = (dir: string) => {
        const db = openDatabase(dir, { readOnly: true });
        try {
          return db.prepare(`SELECT adapter_id, error_summary FROM adapter_runs
            WHERE index_run_id = (SELECT max(id) FROM index_runs WHERE status = 'completed')
            ORDER BY adapter_id`).all();
        } finally { db.close(); }
      };
      assert.deepEqual(warnings(root), warnings(fresh));
      assert.deepEqual(snapshotGraph(root), snapshotGraph(fresh));
      await indexProjectWithRegistryForTest({ repoRoot: root, maxFileBytes: 100 }, registry);
      assert.deepEqual(warnings(root), warnings(fresh));
      assert.deepEqual(snapshotGraph(root), snapshotGraph(fresh), 'a second carry must preserve the same output');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fresh, { recursive: true, force: true });
    }
  });
}

test('unchanged carry-forward preserves imported SCIP graph with contracts', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-carry-scip-'));
  try {
    const source = 'const value = greet();\n';
    const target = 'export function greet() {}\n';
    writeFileSync(path.join(root, 'app.ts'), source);
    writeFileSync(path.join(root, 'api.ts'), target);
    writeFileSync(path.join(root, 'schema.proto'), 'syntax = "proto3";\n');
    await initProject({ repoRoot: root });
    await indexProject({ repoRoot: root });
    const symbol = 'test npm demo 1.0.0 api.ts/greet().';
    const file = path.join(root, '.parallax', 'fixture.scip.json');
    writeFileSync(file, JSON.stringify({ documents: [
      { relativePath: 'api.ts', language: 'typescript', text: target,
        occurrences: [{ range: [0, 16, 21], symbol, symbolRoles: 1 }],
        symbols: [{ symbol, displayName: 'greet', kind: 'Function' }] },
      { relativePath: 'app.ts', language: 'typescript', text: source,
        occurrences: [{ range: [0, 14, 19], symbol, symbolRoles: 8 }] }
    ] }));
    const imported = importScipJson({ repoRoot: root, file });
    assert.ok(imported.relationsImported > 0, 'fixture must import relations');
    const before = snapshotGraph(root);
    const rerun = await indexProject({ repoRoot: root });
    assert.equal(rerun.mode, 'incremental');
    assert.deepEqual(snapshotGraph(root), before);
    const replacement = { documents: [
      { relativePath: 'api.ts', language: 'typescript', text: target, occurrences: [], symbols: [] },
      { relativePath: 'app.ts', language: 'typescript', text: source, occurrences: [] }
    ] };
    writeFileSync(file, JSON.stringify(replacement));
    const reimported = importScipJson({ repoRoot: root, file });
    assert.equal(reimported.relationsImported, 0);
    const db = openDatabase(root, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM relations WHERE adapter_run_id = ?')
        .get(reimported.adapterRunId)?.n, 0, 'reimport must remove vanished carried SCIP relations');
      assert.equal(db.prepare(`SELECT count(*) AS n FROM relations r JOIN adapter_runs a ON a.id = r.adapter_run_id
        WHERE a.adapter_id = 'scip-import'`).get()?.n, 0);
    } finally { db.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('overlapping no-op indexes preserve the published cohort and reject stale publication', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-overlapping-noop-'));
  try {
    writeChain(root);
    await indexProject({ repoRoot: root });
    const before = snapshotGraph(root);
    assert.ok(before.files.length > 0, 'fixture must have a nonempty published graph');
    const results = await Promise.allSettled([
      indexProject({ repoRoot: root }),
      indexProject({ repoRoot: root })
    ]);
    assert.deepEqual(snapshotGraph(root), before, 'a stale carry must not publish an empty cohort');
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    const rejected = results.find((r) => r.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof Error);
    assert.match(rejected.reason.message, /publication baseline changed.*retry/);
    assertFailedRunsUnpublished(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


function pausableRegistry() {
  let pauseNext = false;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const registry = new AdapterRegistry();
  registry.register({
    id: 'publication-oracle', version: '1', capabilities: [],
    supports: (file) => file.language === 'typescript',
    async start() {
      if (pauseNext) {
        pauseNext = false;
        entered();
        await released;
      }
      return { async *process(file: ScannedFile) {
        yield { kind: 'entity' as const, entity: {
          kind: 'file' as const, path: file.relativePath, metadata: { captured: file.content }
        } };
      } };
    }
  });
  return { registry, started, release, pause: () => { pauseNext = true; } };
}

for (const withBaseline of [false, true]) {
  test(`an older full index cannot overwrite a later completion (baseline=${withBaseline})`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'parallax-overlapping-full-'));
    const paused = pausableRegistry();
    let completion: Promise<unknown> | undefined;
    try {
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
      if (withBaseline) await indexProjectWithRegistryForTest({ repoRoot: root }, paused.registry);
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 2;\n');
      paused.pause();
      completion = indexProjectWithRegistryForTest({ repoRoot: root }, paused.registry)
        .then(() => null, (error: unknown) => error);
      await Promise.race([paused.started, completion.then((error) => {
        throw error ?? new Error('index finished before adapter start');
      })]);
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 3;\n');
      const newer = await indexProjectWithRegistryForTest({ repoRoot: root }, paused.registry);
      const published = snapshotGraph(root);
      assert.ok(published.files.length > 0);
      paused.release();
      const failure = await completion;
      assert.deepEqual(snapshotGraph(root), published, 'late completion must preserve the newer graph');
      assert.ok(failure instanceof Error);
      assert.match(failure.message, /publication baseline changed.*retry/);
      assertFailedRunsUnpublished(root);
      const db = openDatabase(root, { readOnly: true });
      try {
        assert.equal(latestCompletedIndexRun(db, getRepoId(db, root)), newer.indexRunId);
        assert.equal(db.prepare("SELECT count(*) AS n FROM index_runs WHERE status = 'running'").get()?.n, 0);
      } finally { db.close(); }
    } finally {
      paused.release();
      await completion;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('an index cannot discard a memory head published while its adapter is running', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-overlapping-memory-'));
  const paused = pausableRegistry();
  let completion: Promise<unknown> | undefined;
  try {
    writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    await indexProjectWithRegistryForTest({ repoRoot: root }, paused.registry);
    writeFileSync(path.join(root, 'a.ts'), 'export const a = 2;\n');
    paused.pause();
    completion = indexProjectWithRegistryForTest({ repoRoot: root }, paused.registry)
      .then(() => null, (error: unknown) => error);
    await Promise.race([paused.started, completion.then((error) => {
        throw error ?? new Error('index finished before adapter start');
      })]);
    const db = openDatabase(root);
    let memoryHead: string;
    try {
      memoryHead = remember(db, { entity: 'file:a.ts', attribute: 'observed', value: 'keep' }, null).txId;
    } finally { db.close(); }
    const published = snapshotGraph(root);
    paused.release();
    const failure = await completion;
    assert.deepEqual(snapshotGraph(root), published);
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /publication baseline changed.*retry/);
    assertFailedRunsUnpublished(root);
    const after = openDatabase(root, { readOnly: true });
    try {
      assert.equal(after.prepare("SELECT head_tx_id FROM branches WHERE name = 'main'").get()?.head_tx_id, memoryHead);
    } finally { after.close(); }
  } finally {
    paused.release();
    await completion;
    rmSync(root, { recursive: true, force: true });
  }
});


function assertFailedRunsUnpublished(root: string): void {
  const db = openDatabase(root, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM index_runs WHERE status = 'failed'").get()?.n, 1);
    for (const table of ['files', 'entity_versions', 'contract_versions', 'relations', 'transactions']) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}
        WHERE index_run_id IN (SELECT id FROM index_runs WHERE status = 'failed')`).get()?.n,
      0, `failed publication leaked ${table}`);
    }
  } finally { db.close(); }
}


function initOracleGitRepo(root: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Parallax Test', '-c', 'user.email=parallax@example.com',
    'commit', '-m', 'baseline'], { cwd: root, stdio: 'ignore' });
}

test('restoring clean HEAD after a dirty index rebuilds the current cohort before reuse', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-restored-head-'));
  const fresh = mkdtempSync(path.join(tmpdir(), 'parallax-restored-fresh-'));
  try {
    writeChain(root);
    writeChain(fresh);
    initOracleGitRepo(root);
    const first = await indexProject({ repoRoot: root });
    writeFileSync(path.join(root, 'src/leaf.ts'), 'export function foo() { return 2; }\n');
    const dirty = await indexProject({ repoRoot: root });
    assert.equal(dirty.mode, 'full');
    assert.notEqual(dirty.indexRunId, first.indexRunId);
    execFileSync('git', ['restore', 'src/leaf.ts'], { cwd: root });
    const restored = await indexProject({ repoRoot: root });
    assert.notEqual(restored.indexRunId, first.indexRunId, 'historical clean rows no longer own the current graph');
    assert.equal(restored.mode, 'full');
    assert.equal(restored.filesIndexed, first.filesIndexed);
    await indexProject({ repoRoot: fresh });
    assert.deepEqual(snapshotGraph(root), snapshotGraph(fresh));
    const reused = await indexProject({ repoRoot: root });
    assert.equal(reused.indexRunId, restored.indexRunId);
    assert.equal(reused.mode, 'incremental');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});

test('clean reuse reads one coherent cohort while another process publishes a new run', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-reuse-snapshot-'));
  try {
    writeChain(root);
    initOracleGitRepo(root);
    const first = await indexProject({ repoRoot: root });
    assert.ok(first.filesIndexed > 0);
    const original = childProcess.execFileSync;
    let moved = false;
    let childRunId: number | undefined;
    let childFailure: string | undefined;
    t.mock.method(childProcess, 'execFileSync', (...args: unknown[]) => {
      if (!moved && args[0] === 'git' && Array.isArray(args[1]) && args[1].join(' ') === 'ls-files -z') {
        moved = true;
        const child = indexWithChildCli(root);
        if (child.status !== 0) {
          childFailure = child.error?.message ?? child.stderr;
        } else {
          try { childRunId = JSON.parse(child.stdout).indexRunId as number; }
          catch (error) { childFailure = String(error); }
        }
      }
      return Reflect.apply(original, childProcess, args);
    });
    syncBuiltinESMExports();
    let scanned = false;
    const reused = await indexProject({ repoRoot: root, perfObserver: () => { scanned = true; } });
    assert.equal(moved, true, 'writer must run after candidate selection');
    assert.equal(childFailure, undefined);
    assert.ok(childRunId !== undefined && childRunId > first.indexRunId);
    assert.equal(scanned, false, 'the fixture must exercise reuse, not fall back to scanning');
    assert.equal(reused.indexRunId, first.indexRunId);
    assert.equal(reused.filesIndexed, first.filesIndexed, 'cohort movement must not mix an old ID with empty live rows');
    const db = openDatabase(root, { readOnly: true });
    try { assert.equal(latestCompletedIndexRun(db, getRepoId(db, root)), childRunId); }
    finally { db.close(); }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});


test('a fatal clean-reuse snapshot error closes the database before returning failure', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-reuse-failure-'));
  let failedDb: DatabaseSync | undefined;
  try {
    writeChain(root);
    initOracleGitRepo(root);
    const original = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) {
      if (sql === 'BEGIN DEFERRED') {
        failedDb = this;
        throw new Error('injected read snapshot failure');
      }
      return Reflect.apply(original, this, [sql]);
    });
    await assert.rejects(indexProject({ repoRoot: root }), /injected read snapshot failure/);
    assert.ok(failedDb);
    assert.equal(failedDb.isOpen, false, 'reuse fails before the normal failed-run catch');
  } finally {
    t.mock.restoreAll();
    if (failedDb?.isOpen) failedDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});


function indexWithChildCli(root: string) {
  return childProcess.spawnSync(process.execPath, [
    '--import', createRequire(import.meta.url).resolve('tsx'),
    fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
    'index', '--max-file-bytes', '1000000'
  ], { cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PARALLAX_EMBEDDING_MODEL: 'stub-sha256', PARALLAX_REFLECTION_MODEL: 'stub' } });
}

test('a run overtaken during scan cannot move a newer completed cohort to its older ID', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-preplan-overtake-'));
  let child: ReturnType<typeof indexWithChildCli> | undefined;
  try {
    writeChain(root);
    initOracleGitRepo(root);
    const failure = await indexProject({ repoRoot: root, perfObserver: () => {
      child = indexWithChildCli(root);
    } }).then(() => null, (error: unknown) => error);
    assert.ok(child);
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    const winner = JSON.parse(child.stdout) as { indexRunId: number; filesIndexed: number };
    assert.ok(winner.filesIndexed > 0);
    assert.ok(snapshotGraph(root).files.length > 0, 'pre-plan overtaking must not empty the latest cohort');
    assert.ok(failure instanceof Error, 'a lower-ID run cannot publish using a newer completed baseline');
    assert.match(failure.message, /publication baseline changed.*retry/);
    assertFailedRunsUnpublished(root);
    const reused = await indexProject({ repoRoot: root });
    assert.equal(reused.indexRunId, winner.indexRunId);
    assert.equal(reused.filesIndexed, winner.filesIndexed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


const hiddenGitInputs = [
  'assume-unchanged', 'skip-worktree', 'active-autocrlf', 'active-text-eol',
  'unsafe-baseline-then-clear', 'temporary-autocrlf', 'removed-same-length-filter'
] as const;

for (const hidden of hiddenGitInputs) {
  for (const forced of [false, true]) {
    test(`Git cache ${hidden}: ${forced ? 'explicit CLI byte limit revalidates' : 'default cache must revalidate'} bodies`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'parallax-hidden-git-'));
      const fresh = mkdtempSync(path.join(tmpdir(), 'parallax-hidden-fresh-'));
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
      try {
        writeChain(root);
        writeChain(fresh);
        if (hidden === 'active-text-eol') {
          for (const dir of [root, fresh]) writeFileSync(path.join(dir, '.gitattributes'), '*.ts text eol=lf\n');
        }
        initOracleGitRepo(root);
        git('config', 'core.autocrlf', 'false');
        const first = await indexProject({ repoRoot: root });
        const leaf = path.join(root, 'src/leaf.ts');
        const original = readFileSync(leaf, 'utf8');
        let priorId = first.indexRunId;
        const isEol = ['active-autocrlf', 'active-text-eol', 'temporary-autocrlf'].includes(hidden);
        const changed = isEol ? original.replace(/\n/g, '\r\n') : original.replace('return 1', 'return 2');
        if (hidden === 'assume-unchanged' || hidden === 'unsafe-baseline-then-clear') {
          git('update-index', '--assume-unchanged', 'src/leaf.ts');
        } else if (hidden === 'skip-worktree') {
          git('update-index', '--skip-worktree', 'src/leaf.ts');
        }
        writeFileSync(leaf, changed);
        if (hidden === 'active-autocrlf') git('config', 'core.autocrlf', 'true');
        if (isEol || hidden === 'removed-same-length-filter') {
          // Keep mtime older than the index so Git's racy-entry check is not the oracle.
          const old = new Date('2000-01-01T00:00:00Z');
          utimesSync(leaf, old, old);
          if (hidden === 'temporary-autocrlf') {
            git('-c', 'core.autocrlf=true', 'add', 'src/leaf.ts');
          } else if (hidden === 'removed-same-length-filter') {
            const attrs = path.join(root, '.git/info/attributes');
            writeFileSync(attrs, 'src/leaf.ts filter=probe\n');
            const filter = "node -e \"let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(s.replace(/return 2/g,'return 1')));\"";
            git('config', 'filter.probe.clean', filter);
            git('add', 'src/leaf.ts');
            git('config', '--unset', 'filter.probe.clean');
            rmSync(attrs);
          } else {
            git('add', 'src/leaf.ts');
          }
        }
        if (hidden === 'unsafe-baseline-then-clear') {
          const unsafe = await indexProject({ repoRoot: root, maxFileBytes: 1_000_000 });
          assert.equal(unsafe.mode, 'full');
          priorId = unsafe.indexRunId;
          writeFileSync(leaf, original);
          git('update-index', '--no-assume-unchanged', 'src/leaf.ts');
        }
        const observedGit = readGitSnapshot(root);
        assert.equal(observedGit.commitSha, git('rev-parse', 'HEAD').trim());
        assert.equal(observedGit.isDirty, false, 'fixture must hide its raw input change from Git status');
        assert.equal(git('write-tree').trim(), git('rev-parse', 'HEAD^{tree}').trim());
        writeFileSync(path.join(fresh, 'src/leaf.ts'), readFileSync(leaf));
        let result;
        if (forced) {
          const child = indexWithChildCli(root);
          assert.equal(child.status, 0, child.error?.message ?? child.stderr.slice(-1000));
          result = JSON.parse(child.stdout) as Awaited<ReturnType<typeof indexProject>>;
        } else {
          result = await indexProject({ repoRoot: root });
        }
        assert.notEqual(result.indexRunId, priorId, 'raw input changes require a new extraction cohort');
        assert.equal(result.mode, 'full');
        await indexProject({ repoRoot: fresh });
        assert.deepEqual(snapshotGraph(root), snapshotGraph(fresh));
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(fresh, { recursive: true, force: true });
      }
    });
  }
}

for (const forced of [false, true]) {
  test(`Git cache shallow deepen: ${forced ? 'explicit CLI byte limit refreshes' : 'default cache must refresh'} history-derived graph`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'parallax-hidden-history-'));
    const origin = path.join(root, 'origin');
    const clone = path.join(root, 'clone');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', [
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args
    ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    const commit = () => {
      git(origin, 'add', '.');
      git(origin, '-c', 'user.name=Parallax Test', '-c', 'user.email=parallax@example.invalid',
        'commit', '-m', 'synthetic co-change history');
    };
    try {
      mkdirSync(origin);
      git(origin, 'init', '-b', 'main');
      writeFileSync(path.join(origin, '.gitignore'), '.parallax/\n');
      for (const value of [1, 2, 3]) {
        writeFileSync(path.join(origin, 'a.ts'), `export const a = ${value};\n`);
        writeFileSync(path.join(origin, 'b.ts'), `export const b = ${value};\n`);
        commit();
      }
      writeFileSync(path.join(origin, 'note.txt'), 'latest commit changes neither source\n');
      commit();
      git(root, '-c', 'protocol.file.allow=always', 'clone', '--depth=1', pathToFileURL(origin).href, clone);
      const beforeGit = readGitSnapshot(clone);
      const beforeTree = git(clone, 'rev-parse', 'HEAD^{tree}');
      const bodies = ['a.ts', 'b.ts'].map((name) => readFileSync(path.join(clone, name), 'utf8'));
      await indexProject({ repoRoot: clone });
      assert.equal(snapshotGraph(clone).relations.filter((row) => row.kind === 'CO_CHANGES').length, 0);
      git(clone, '-c', 'protocol.file.allow=always', 'fetch', '--unshallow');
      assert.equal(git(clone, 'rev-parse', '--is-shallow-repository').trim(), 'false');
      assert.equal(git(clone, 'status', '--porcelain').trim(), '');
      assert.equal(git(clone, 'rev-parse', 'HEAD^{tree}'), beforeTree);
      assert.deepEqual(readGitSnapshot(clone), beforeGit);
      assert.deepEqual(['a.ts', 'b.ts'].map((name) => readFileSync(path.join(clone, name), 'utf8')), bodies);

      await indexProject({ repoRoot: origin });
      const oracle = snapshotGraph(origin);
      assert.equal(oracle.relations.filter((row) => row.kind === 'CO_CHANGES').length, 2,
        'fresh full extraction must observe both directed co-change relations');
      if (forced) {
        const child = indexWithChildCli(clone);
        assert.equal(child.status, 0, child.error?.message ?? child.stderr.slice(-1000));
      } else {
        await indexProject({ repoRoot: clone });
      }
      assert.deepEqual(snapshotGraph(clone), oracle);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
