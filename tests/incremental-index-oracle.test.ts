import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { indexProject, initProject } from '../src/index.js';
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
  return {
    files,
    coverage,
    entities,
    entityVersions,
    relations,
    relationEvidence,
    evidence,
    edges,
    symbols
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
