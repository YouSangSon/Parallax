import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { contentHash, loadVectorExtension, openDatabase } from '../src/store.js';
import type { Db } from '../src/store.js';

function withTempDb<T>(callback: (db: Db) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'impact-trace-store-'));
  try {
    const db = openDatabase(dir);
    try {
      return callback(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('migrate records schema_versions through v10', () => {
  withTempDb((db) => {
    const versions = db
      .prepare('SELECT version FROM schema_versions ORDER BY version')
      .all() as Array<{ version: number }>;
    assert.deepEqual(
      versions.map((row) => row.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    );
  });
});

test('migrate creates the agent memory tables and later extension tables', () => {
  withTempDb((db) => {
    const expected = [
      'attribute_defs',
      'branches',
      'transactions',
      'facts',
      'embeddings',
      'fact_provenance',
      'transaction_parents',
      'fact_embeddings',
      'reflections',
      'context_tool_runs',
      'context_resource_accesses'
    ];
    for (const name of expected) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name);
      assert.ok(row, `expected table ${name} to exist`);
    }
  });
});

test('migrate v10 adds context access telemetry tables', () => {
  withTempDb((db) => {
    for (const [table, columns] of [
      ['context_tool_runs', ['id', 'repo_id', 'tool_name', 'index_run_id', 'budget', 'query', 'changed_files_json', 'returned_bytes', 'resource_count', 'omitted_json', 'started_at', 'finished_at']],
      ['context_resource_accesses', ['id', 'repo_id', 'uri', 'resource_kind', 'resource_id', 'index_run_id', 'returned_bytes', 'accessed_at']]
    ] as const) {
      for (const column of columns) {
        const row = db
          .prepare(`SELECT name FROM pragma_table_info('${table}') WHERE name = ?`)
          .get(column);
        assert.ok(row, `${table}.${column} column should exist`);
      }
    }
  });
});

test('migrate v7/v8/v9 adds branch GC, relation evidence spans, and git snapshot columns', () => {
  withTempDb((db) => {
    const branchState = db
      .prepare("SELECT name FROM pragma_table_info('branches') WHERE name = 'state'")
      .get();
    assert.ok(branchState, 'branches.state column should exist');

    const txArchived = db
      .prepare("SELECT name FROM pragma_table_info('transactions') WHERE name = 'archived'")
      .get();
    assert.ok(txArchived, 'transactions.archived column should exist');

    const provKind = db
      .prepare("SELECT name FROM pragma_table_info('fact_provenance') WHERE name = 'kind'")
      .get();
    assert.ok(provKind, 'fact_provenance.kind column should exist');

    for (const column of ['start_line', 'end_line', 'start_col', 'end_col']) {
      const spanColumn = db
        .prepare("SELECT name FROM pragma_table_info('relation_evidence') WHERE name = ?")
        .get(column);
      assert.ok(spanColumn, `relation_evidence.${column} column should exist`);
    }

    for (const column of ['git_commit_sha', 'git_branch_name', 'git_is_dirty']) {
      const snapshotColumn = db
        .prepare("SELECT name FROM pragma_table_info('index_runs') WHERE name = ?")
        .get(column);
      assert.ok(snapshotColumn, `index_runs.${column} column should exist`);
    }

    const seededMain = db
      .prepare("SELECT state FROM branches WHERE name = 'main'")
      .get() as { state: string };
    assert.equal(seededMain.state, 'active');
  });
});

test('migrate is idempotent across re-runs', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'impact-trace-store-idem-'));
  try {
    const first = openDatabase(dir);
    first.close();
    const second = openDatabase(dir);
    try {
      const versions = second
        .prepare('SELECT version FROM schema_versions ORDER BY version')
        .all() as Array<{ version: number }>;
      assert.deepEqual(
        versions.map((row) => row.version),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      );
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate upgrades a synthetic v6 schema by adding v7/v8/v9 columns and tables', () => {
  // Build a stripped-down v6-equivalent schema (the columns we know v7
  // will ADD), then re-open to trigger migrate(). This is the path that
  // executes tryAddColumn in the real upgrade scenario; the fresh-DB
  // tests above run against a single combined migration.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'impact-trace-store-v6-'));
  try {
    const seed = openDatabase(dir);
    try {
      // Drop the v7/v8-added columns and table to simulate an older DB.
      seed.prepare('DELETE FROM schema_versions WHERE version = 7').run();
      seed.prepare('DELETE FROM schema_versions WHERE version = 8').run();
      seed.prepare('DELETE FROM schema_versions WHERE version = 9').run();
      seed.prepare('DELETE FROM schema_versions WHERE version = 10').run();
      seed.prepare('DROP TABLE IF EXISTS reflections').run();
      seed.prepare('DROP TABLE IF EXISTS context_tool_runs').run();
      seed.prepare('DROP TABLE IF EXISTS context_resource_accesses').run();
      seed.prepare('CREATE TABLE branches_v6_only AS SELECT id, name, head_tx_id, parent_branch_id, created_at FROM branches').run();
      seed.prepare('DROP TABLE branches').run();
      seed
        .prepare(
          `CREATE TABLE branches (
             id TEXT PRIMARY KEY NOT NULL,
             name TEXT NOT NULL UNIQUE,
             head_tx_id TEXT,
             parent_branch_id TEXT,
             created_at TEXT NOT NULL,
             FOREIGN KEY(parent_branch_id) REFERENCES branches(id)
           )`
        )
        .run();
      seed
        .prepare(
          'INSERT INTO branches (id, name, head_tx_id, parent_branch_id, created_at) SELECT id, name, head_tx_id, parent_branch_id, created_at FROM branches_v6_only'
        )
        .run();
      seed.prepare('DROP TABLE branches_v6_only').run();
      seed
        .prepare(
          `CREATE TABLE relation_evidence_v6_only AS
           SELECT id, relation_id, repo_id, file_path, kind, snippet, confidence, index_run_id
           FROM relation_evidence`
        )
        .run();
      seed.prepare('DROP TABLE relation_evidence').run();
      seed
        .prepare(
          `CREATE TABLE relation_evidence (
             id TEXT PRIMARY KEY,
             relation_id TEXT NOT NULL,
             repo_id INTEGER NOT NULL,
             file_path TEXT NOT NULL,
             kind TEXT NOT NULL,
             snippet TEXT NOT NULL,
             confidence TEXT NOT NULL,
             index_run_id INTEGER NOT NULL,
             FOREIGN KEY(relation_id) REFERENCES relations(id),
             FOREIGN KEY(repo_id) REFERENCES repos(id),
             FOREIGN KEY(index_run_id) REFERENCES index_runs(id)
           )`
        )
        .run();
      seed
        .prepare(
          `INSERT INTO relation_evidence (
             id, relation_id, repo_id, file_path, kind, snippet, confidence, index_run_id
           )
           SELECT id, relation_id, repo_id, file_path, kind, snippet, confidence, index_run_id
           FROM relation_evidence_v6_only`
        )
        .run();
      seed.prepare('DROP TABLE relation_evidence_v6_only').run();
      seed.exec('PRAGMA foreign_keys = OFF');
      seed
        .prepare(
          `CREATE TABLE index_runs_v8_only AS
           SELECT id, repo_id, status, started_at, finished_at, extractor_version
           FROM index_runs`
        )
        .run();
      seed.prepare('DROP TABLE index_runs').run();
      seed
        .prepare(
          `CREATE TABLE index_runs (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             repo_id INTEGER NOT NULL,
             status TEXT NOT NULL,
             started_at TEXT NOT NULL,
             finished_at TEXT,
             extractor_version TEXT NOT NULL,
             FOREIGN KEY(repo_id) REFERENCES repos(id)
           )`
        )
        .run();
      seed
        .prepare(
          `INSERT INTO index_runs (id, repo_id, status, started_at, finished_at, extractor_version)
           SELECT id, repo_id, status, started_at, finished_at, extractor_version
           FROM index_runs_v8_only`
        )
        .run();
      seed.prepare('DROP TABLE index_runs_v8_only').run();
      seed.exec('PRAGMA foreign_keys = ON');
    } finally {
      seed.close();
    }

    const upgraded = openDatabase(dir);
    try {
      const stateColumn = upgraded
        .prepare("SELECT name FROM pragma_table_info('branches') WHERE name = 'state'")
        .get();
      assert.ok(stateColumn, 'tryAddColumn must add branches.state on real upgrade');
      const reflections = upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reflections'")
        .get();
      assert.ok(reflections, 'reflections table must exist after upgrade');
      const spanColumn = upgraded
        .prepare("SELECT name FROM pragma_table_info('relation_evidence') WHERE name = 'start_line'")
        .get();
      assert.ok(spanColumn, 'tryAddColumn must add relation_evidence.start_line on real upgrade');
      const gitDirtyColumn = upgraded
        .prepare("SELECT name FROM pragma_table_info('index_runs') WHERE name = 'git_is_dirty'")
        .get();
      assert.ok(gitDirtyColumn, 'tryAddColumn must add index_runs.git_is_dirty on real upgrade');
      const versions = upgraded
        .prepare('SELECT max(version) AS v FROM schema_versions')
        .get() as { v: number };
      assert.equal(versions.v, 10);
      const telemetry = upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_tool_runs'")
        .get();
      assert.ok(telemetry, 'context_tool_runs table must exist after upgrade');
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate seeds static relation attribute_defs', () => {
  withTempDb((db) => {
    const rows = db
      .prepare(
        'SELECT name, value_type, is_code_relation FROM attribute_defs WHERE is_code_relation = 1 ORDER BY name'
      )
      .all() as Array<{ name: string; value_type: string; is_code_relation: number }>;
    assert.deepEqual(
      rows.map((row) => row.name),
      [
        'affects',
        'breaks_compat',
        'calls',
        'configures',
        'declares',
        'depends_on',
        'documents',
        'exports',
        'extends',
        'governs',
        'handles',
        'implements',
        'imports',
        'owns',
        'raises',
        'reads',
        'references',
        'tests',
        'writes'
      ]
    );
    for (const row of rows) {
      assert.equal(row.value_type, 'entity_ref');
      assert.equal(row.is_code_relation, 1);
    }
  });
});

test('migrate seeds the main branch', () => {
  withTempDb((db) => {
    const row = db
      .prepare("SELECT id, name, head_tx_id, parent_branch_id FROM branches WHERE name = 'main'")
      .get() as { id: string; name: string; head_tx_id: string | null; parent_branch_id: string | null } | undefined;
    assert.ok(row, 'expected main branch to exist');
    assert.equal(row?.id, 'br_main');
    assert.equal(row?.head_tx_id, null);
    assert.equal(row?.parent_branch_id, null);
  });
});

test('migrate enables WAL journal mode', () => {
  withTempDb((db) => {
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    assert.equal(row.journal_mode.toLowerCase(), 'wal');
  });
});

test('contentHash is deterministic and stable across separator-distinct inputs', () => {
  const a = contentHash('foo', 'bar');
  const b = contentHash('foo', 'bar');
  assert.equal(a, b, 'same inputs must produce same hash');

  const c = contentHash('foobar');
  assert.notEqual(a, c, 'separator must distinguish concatenated inputs');
});

test('loadVectorExtension loads sqlite-vec and exposes vec_version when supported', () => {
  withTempDb((db) => {
    const loaded = loadVectorExtension(db);
    if (!loaded) {
      // No prebuilt sqlite-vec binary for this platform; treat as skipped.
      return;
    }
    const row = db.prepare('SELECT vec_version() AS version').get() as { version: string };
    assert.equal(typeof row.version, 'string');
    assert.match(row.version, /^v\d+\.\d+/);
  });
});
