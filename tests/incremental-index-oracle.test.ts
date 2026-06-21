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
  relations: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
};

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
  const relations = db
    .prepare(
      `SELECT id, source_entity_id, target_entity_id, kind, confidence, provenance
       FROM relations WHERE repo_id = ? AND index_run_id = ? ORDER BY id`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  const evidence = db
    .prepare(
      `SELECT id, relation_id, file_path, kind, snippet, confidence, start_line, end_line, start_col, end_col
       FROM relation_evidence WHERE repo_id = ? AND index_run_id = ? ORDER BY id`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  return { entities, relations, evidence };
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
