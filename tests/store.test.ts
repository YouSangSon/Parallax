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

test('migrate records schema_versions through v6', () => {
  withTempDb((db) => {
    const versions = db
      .prepare('SELECT version FROM schema_versions ORDER BY version')
      .all() as Array<{ version: number }>;
    assert.deepEqual(
      versions.map((row) => row.version),
      [1, 2, 3, 4, 5, 6]
    );
  });
});

test('migrate creates the agent memory tables (v4) plus v5/v6 extensions', () => {
  withTempDb((db) => {
    const expected = [
      'attribute_defs',
      'branches',
      'transactions',
      'facts',
      'embeddings',
      'fact_provenance',
      'transaction_parents',
      'fact_embeddings'
    ];
    for (const name of expected) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name);
      assert.ok(row, `expected table ${name} to exist`);
    }
  });
});

test('migrate seeds the four code-relation attribute_defs', () => {
  withTempDb((db) => {
    const rows = db
      .prepare(
        'SELECT name, value_type, is_code_relation FROM attribute_defs WHERE is_code_relation = 1 ORDER BY name'
      )
      .all() as Array<{ name: string; value_type: string; is_code_relation: number }>;
    assert.deepEqual(
      rows.map((row) => row.name),
      ['affects', 'calls', 'depends_on', 'imports']
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
