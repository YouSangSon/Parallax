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
  return { entities, entityVersions, relations, relationEvidence, evidence, edges, symbols };
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

// The S1 oracle proper: editing one file's body (the path set and extractor
// unchanged) must take the incremental carry-forward path, and the resulting
// graph must be byte-identical to a single full reindex of the same end state.
// This catches the primary carry-forward bug (an unchanged file's rows left in
// the old run cohort, hence invisible) and any edge type that turns out to be
// target-content-dependent.
const EDITED_LEAF = 'export function foo() {\n  return 2;\n}\n';

test('an incremental reindex (edit one file body, stable path set) is byte-identical to a full reindex of the end state — the S1 oracle', async () => {
  const incrementalRoot = mkdtempSync(path.join(tmpdir(), 'parallax-oracle-incr-'));
  const fullRoot = mkdtempSync(path.join(tmpdir(), 'parallax-oracle-full-'));
  try {
    // Incremental repo: full index, then edit leaf.ts body only and re-index.
    writeChain(incrementalRoot);
    await initProject({ repoRoot: incrementalRoot });
    await indexProject({ repoRoot: incrementalRoot });
    writeFileSync(path.join(incrementalRoot, 'src/leaf.ts'), EDITED_LEAF);
    const incremental = await indexProject({ repoRoot: incrementalRoot });
    assert.equal(
      incremental.mode,
      'incremental',
      'editing one file body with a stable path set must take the incremental path'
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
