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

test('migrate records schema_versions through v15', () => {
  withTempDb((db) => {
    const versions = db
      .prepare('SELECT version FROM schema_versions ORDER BY version')
      .all() as Array<{ version: number }>;
    assert.deepEqual(
      versions.map((row) => row.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
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
      'context_resource_accesses',
      'context_packs',
      'search_entities_fts',
      'search_relation_evidence_fts',
      'search_facts_fts'
    ];
    for (const name of expected) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name);
      assert.ok(row, `expected table ${name} to exist`);
    }
  });
});

test('migrate v11/v14 adds persistent search FTS projection triggers', () => {
  withTempDb((db) => {
    for (const name of [
      'trg_entities_fts_ai',
      'trg_entities_fts_ad',
      'trg_entities_fts_au',
      'trg_relation_evidence_fts_ai',
      'trg_relation_evidence_fts_ad',
      'trg_relation_evidence_fts_au',
      'trg_facts_fts_ai',
      'trg_facts_fts_ad',
      'trg_facts_fts_au'
    ]) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .get(name);
      assert.ok(row, `expected trigger ${name} to exist`);
    }
  });
});

test('migrate v11/v14 maintains persistent search FTS projections', () => {
  withTempDb((db) => {
    db.prepare("INSERT INTO repos (id, root, config_hash) VALUES (1, '/repo', 'v1')").run();
    db.prepare(`
      INSERT INTO index_runs (id, repo_id, status, started_at, finished_at, extractor_version)
      VALUES (1, 1, 'completed', datetime('now'), datetime('now'), 'test')
    `).run();
    db.prepare(`
      INSERT INTO entities (
        id, repo_id, kind, path, symbol, language_id, display_name,
        created_index_run_id, updated_index_run_id
      )
      VALUES ('file:source.ts', 1, 'file', 'source.ts', NULL, 'typescript', 'Source', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO entities (
        id, repo_id, kind, path, symbol, language_id, display_name,
        created_index_run_id, updated_index_run_id
      )
      VALUES ('file:entity-search.ts', 1, 'file', 'entity-search.ts', 'validate_token', 'typescript', 'Token Refresh Validator', 1, 1)
    `).run();
    assert.deepEqual(
      db
        .prepare("SELECT entity_id FROM search_entities_fts WHERE search_entities_fts MATCH 'token'")
        .all()
        .map((row) => (row as { entity_id: string }).entity_id),
      ['file:entity-search.ts']
    );
    assert.deepEqual(
      db
        .prepare("SELECT entity_id FROM search_entities_fts WHERE search_entities_fts MATCH 'validate'")
        .all()
        .map((row) => (row as { entity_id: string }).entity_id),
      ['file:entity-search.ts']
    );
    db.prepare(`
      UPDATE entities
      SET display_name = 'Session Gate', path = 'session-gate.ts', symbol = 'session_gate'
      WHERE id = 'file:entity-search.ts'
    `).run();
    assert.deepEqual(
      db
        .prepare("SELECT entity_id FROM search_entities_fts WHERE search_entities_fts MATCH 'token'")
        .all()
        .map((row) => (row as { entity_id: string }).entity_id),
      []
    );
    assert.deepEqual(
      db
        .prepare("SELECT entity_id FROM search_entities_fts WHERE search_entities_fts MATCH 'session'")
        .all()
        .map((row) => (row as { entity_id: string }).entity_id),
      ['file:entity-search.ts']
    );
    db.prepare("DELETE FROM entities WHERE id = 'file:entity-search.ts'").run();
    assert.deepEqual(
      db
        .prepare("SELECT entity_id FROM search_entities_fts WHERE search_entities_fts MATCH 'session'")
        .all()
        .map((row) => (row as { entity_id: string }).entity_id),
      []
    );
    db.prepare(`
      INSERT INTO relations (
        id, repo_id, source_entity_id, target_entity_id, kind, confidence,
        adapter_run_id, index_run_id, provenance
      )
      VALUES ('rel:source', 1, 'file:source.ts', 'file:source.ts', 'DOCUMENTS', 'medium', NULL, 1, 'test')
    `).run();

    db.prepare(`
      INSERT INTO relation_evidence (
        id, relation_id, repo_id, file_path, kind, snippet, confidence, index_run_id
      )
      VALUES ('ev:source', 'rel:source', 1, 'policy.md', 'DOCUMENTS', 'rotation policy signal', 'medium', 1)
    `).run();
    assert.deepEqual(
      db
        .prepare("SELECT evidence_id FROM search_relation_evidence_fts WHERE search_relation_evidence_fts MATCH 'rotation'")
        .all()
        .map((row) => (row as { evidence_id: string }).evidence_id),
      ['ev:source']
    );
    db.prepare("UPDATE relation_evidence SET snippet = 'retention signal' WHERE id = 'ev:source'").run();
    assert.deepEqual(
      db
        .prepare("SELECT evidence_id FROM search_relation_evidence_fts WHERE search_relation_evidence_fts MATCH 'rotation'")
        .all()
        .map((row) => (row as { evidence_id: string }).evidence_id),
      []
    );
    assert.deepEqual(
      db
        .prepare("SELECT evidence_id FROM search_relation_evidence_fts WHERE search_relation_evidence_fts MATCH 'retention'")
        .all()
        .map((row) => (row as { evidence_id: string }).evidence_id),
      ['ev:source']
    );
    db.prepare(`
      INSERT OR REPLACE INTO relation_evidence (
        id, relation_id, repo_id, file_path, kind, snippet, confidence, index_run_id
      )
      VALUES ('ev:source', 'rel:source', 1, 'policy.md', 'DOCUMENTS', 'replacement signal', 'medium', 1)
    `).run();
    assert.deepEqual(
      db
        .prepare("SELECT evidence_id FROM search_relation_evidence_fts WHERE search_relation_evidence_fts MATCH 'retention'")
        .all()
        .map((row) => (row as { evidence_id: string }).evidence_id),
      []
    );
    assert.deepEqual(
      db
        .prepare("SELECT evidence_id FROM search_relation_evidence_fts WHERE search_relation_evidence_fts MATCH 'replacement'")
        .all()
        .map((row) => (row as { evidence_id: string }).evidence_id),
      ['ev:source']
    );

    db.prepare(`
      INSERT INTO transactions (id, parent_tx_id, branch_id, ts, agent, index_run_id)
      VALUES ('tx:fts', NULL, 'br_main', datetime('now'), 'test', 1)
    `).run();
    db.prepare(`
      INSERT INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted)
      VALUES ('fact:source', 'file:source.ts', 'imports', '"operator memory signal"', 'assert', 'tx:fts', 0)
    `).run();
    db.prepare(`
      INSERT INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted)
      VALUES ('fact:redacted', 'file:source.ts', 'imports', '"secret projection marker"', 'assert', 'tx:fts', 1)
    `).run();
    db.prepare(`
      INSERT INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted)
      VALUES ('fact:retract', 'file:source.ts', 'imports', '"retracted projection marker"', 'retract', 'tx:fts', 0)
    `).run();
    assert.deepEqual(
      db
        .prepare("SELECT fact_id FROM search_facts_fts WHERE search_facts_fts MATCH 'operator'")
        .all()
        .map((row) => (row as { fact_id: string }).fact_id),
      ['fact:source']
    );
    assert.deepEqual(
      db
        .prepare("SELECT fact_id FROM search_facts_fts WHERE search_facts_fts MATCH 'secret'")
        .all()
        .map((row) => (row as { fact_id: string }).fact_id),
      []
    );
    assert.deepEqual(
      db
        .prepare("SELECT fact_id FROM search_facts_fts WHERE search_facts_fts MATCH 'retracted'")
        .all()
        .map((row) => (row as { fact_id: string }).fact_id),
      []
    );
    db.prepare("UPDATE facts SET redacted = 1 WHERE id = 'fact:source'").run();
    assert.deepEqual(
      db
        .prepare("SELECT fact_id FROM search_facts_fts WHERE search_facts_fts MATCH 'operator'")
        .all()
        .map((row) => (row as { fact_id: string }).fact_id),
      []
    );
    db.prepare("UPDATE facts SET redacted = 0 WHERE id = 'fact:source'").run();
    db.prepare("UPDATE facts SET value_blob = '\"session retention marker\"' WHERE id = 'fact:source'").run();
    assert.deepEqual(
      db
        .prepare("SELECT fact_id FROM search_facts_fts WHERE search_facts_fts MATCH 'operator'")
        .all()
        .map((row) => (row as { fact_id: string }).fact_id),
      []
    );
    assert.deepEqual(
      db
        .prepare("SELECT fact_id FROM search_facts_fts WHERE search_facts_fts MATCH 'session'")
        .all()
        .map((row) => (row as { fact_id: string }).fact_id),
      ['fact:source']
    );
    db.prepare(`
      INSERT OR REPLACE INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted)
      VALUES ('fact:source', 'file:source.ts', 'imports', '"secret replacement marker"', 'assert', 'tx:fts', 1)
    `).run();
    assert.deepEqual(
      db
        .prepare("SELECT fact_id FROM search_facts_fts WHERE search_facts_fts MATCH 'session'")
        .all()
        .map((row) => (row as { fact_id: string }).fact_id),
      []
    );
    assert.deepEqual(
      db
        .prepare("SELECT fact_id FROM search_facts_fts WHERE search_facts_fts MATCH 'secret'")
        .all()
        .map((row) => (row as { fact_id: string }).fact_id),
      []
    );
    db.prepare(`
      INSERT OR REPLACE INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted)
      VALUES ('fact:source', 'file:source.ts', 'imports', '"retract replacement marker"', 'retract', 'tx:fts', 0)
    `).run();
    assert.deepEqual(
      db
        .prepare("SELECT fact_id FROM search_facts_fts WHERE search_facts_fts MATCH 'retract'")
        .all()
        .map((row) => (row as { fact_id: string }).fact_id),
      []
    );
    db.prepare(`
      INSERT OR REPLACE INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted)
      VALUES ('fact:source', 'file:source.ts', 'imports', '"final projection marker"', 'assert', 'tx:fts', 0)
    `).run();
    db.prepare("DELETE FROM facts WHERE id = 'fact:source'").run();
    assert.deepEqual(
      db
        .prepare("SELECT fact_id FROM search_facts_fts WHERE search_facts_fts MATCH 'final'")
        .all()
        .map((row) => (row as { fact_id: string }).fact_id),
      []
    );
  });
});

test('migrate v11/v14 repairs persistent search FTS projection rows on re-run', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'impact-trace-store-fts-repair-'));
  try {
    const first = openDatabase(dir);
    try {
      first.prepare("INSERT INTO repos (id, root, config_hash) VALUES (1, '/repo', 'v1')").run();
      first.prepare(`
        INSERT INTO index_runs (id, repo_id, status, started_at, finished_at, extractor_version)
        VALUES (1, 1, 'completed', datetime('now'), datetime('now'), 'test')
      `).run();
      first.prepare(`
        INSERT INTO entities (
          id, repo_id, kind, path, symbol, language_id, display_name,
          created_index_run_id, updated_index_run_id
        )
        VALUES ('file:repair.ts', 1, 'file', 'repair.ts', NULL, 'typescript', 'Repair', 1, 1)
      `).run();
      first.prepare(`
        INSERT INTO relations (
          id, repo_id, source_entity_id, target_entity_id, kind, confidence,
          adapter_run_id, index_run_id, provenance
        )
        VALUES ('rel:repair', 1, 'file:repair.ts', 'file:repair.ts', 'DOCUMENTS', 'medium', NULL, 1, 'test')
      `).run();
      first.prepare(`
        INSERT INTO relation_evidence (
          id, relation_id, repo_id, file_path, kind, snippet, confidence, index_run_id
        )
        VALUES ('ev:repair', 'rel:repair', 1, 'repair.ts', 'DOCUMENTS', 'crash resumable evidence backfill', 'medium', 1)
      `).run();
      first.prepare(`
        INSERT INTO transactions (id, parent_tx_id, branch_id, ts, agent, index_run_id)
        VALUES ('tx:repair', NULL, 'br_main', datetime('now'), 'test', 1)
      `).run();
      first.prepare(`
        INSERT INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted)
        VALUES ('fact:repair', 'file:repair.ts', 'imports', '"crash resumable fact backfill"', 'assert', 'tx:repair', 0)
      `).run();

      first.prepare('DELETE FROM search_entities_fts').run();
      first.prepare(`
        INSERT INTO search_entities_fts (
          entity_id, repo_id, updated_index_run_id, id_text, display_name, path, symbol
        )
        VALUES ('file:stale.ts', 1, 1, 'file:stale.ts', 'Stale Entity', 'stale.ts', 'stale')
      `).run();
      first.prepare('DELETE FROM search_relation_evidence_fts').run();
      first.prepare('DELETE FROM search_facts_fts').run();
      assert.equal(
        (first.prepare('SELECT count(*) AS count FROM search_entities_fts').get() as { count: number }).count,
        1
      );
      assert.equal(
        (first.prepare('SELECT count(*) AS count FROM search_relation_evidence_fts').get() as { count: number }).count,
        0
      );
      assert.equal(
        (first.prepare('SELECT count(*) AS count FROM search_facts_fts').get() as { count: number }).count,
        0
      );
    } finally {
      first.close();
    }

    const reopened = openDatabase(dir);
    try {
      assert.deepEqual(
        reopened
          .prepare("SELECT entity_id FROM search_entities_fts WHERE search_entities_fts MATCH 'repair'")
          .all()
          .map((row) => (row as { entity_id: string }).entity_id),
        ['file:repair.ts']
      );
      assert.deepEqual(
        reopened
          .prepare("SELECT entity_id FROM search_entities_fts WHERE search_entities_fts MATCH 'stale'")
          .all()
          .map((row) => (row as { entity_id: string }).entity_id),
        []
      );
      assert.deepEqual(
        reopened
          .prepare("SELECT evidence_id FROM search_relation_evidence_fts WHERE search_relation_evidence_fts MATCH 'evidence'")
          .all()
          .map((row) => (row as { evidence_id: string }).evidence_id),
        ['ev:repair']
      );
      assert.deepEqual(
        reopened
          .prepare("SELECT fact_id FROM search_facts_fts WHERE search_facts_fts MATCH 'fact'")
          .all()
          .map((row) => (row as { fact_id: string }).fact_id),
        ['fact:repair']
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate v14 repairs stale entity FTS payload for existing entities on re-run', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'impact-trace-store-entity-fts-stale-'));
  try {
    const first = openDatabase(dir);
    try {
      first.prepare("INSERT INTO repos (id, root, config_hash) VALUES (1, '/repo', 'v1')").run();
      first.prepare(`
        INSERT INTO index_runs (id, repo_id, status, started_at, finished_at, extractor_version)
        VALUES (1, 1, 'completed', datetime('now'), datetime('now'), 'test')
      `).run();
      first.prepare(`
        INSERT INTO entities (
          id, repo_id, kind, path, symbol, language_id, display_name,
          created_index_run_id, updated_index_run_id
        )
        VALUES ('file:current.ts', 1, 'file', 'current.ts', 'current_symbol', 'typescript', 'Current Entity', 1, 1)
      `).run();
      first.prepare('DELETE FROM search_entities_fts').run();
      first.prepare(`
        INSERT INTO search_entities_fts (
          entity_id, repo_id, updated_index_run_id, id_text, display_name, path, symbol
        )
        VALUES ('file:current.ts', 99, 99, 'file:old.ts', 'Old Entity', 'old.ts', 'old_symbol')
      `).run();
      assert.deepEqual(
        first
          .prepare("SELECT entity_id FROM search_entities_fts WHERE search_entities_fts MATCH 'old'")
          .all()
          .map((row) => (row as { entity_id: string }).entity_id),
        ['file:current.ts']
      );
    } finally {
      first.close();
    }

    const reopened = openDatabase(dir);
    try {
      assert.deepEqual(
        reopened
          .prepare("SELECT entity_id FROM search_entities_fts WHERE search_entities_fts MATCH 'old'")
          .all()
          .map((row) => (row as { entity_id: string }).entity_id),
        []
      );
      assert.deepEqual(
        reopened
          .prepare("SELECT entity_id FROM search_entities_fts WHERE search_entities_fts MATCH 'current'")
          .all()
          .map((row) => (row as { entity_id: string }).entity_id),
        ['file:current.ts']
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openDatabase can skip projection repair for lightweight telemetry writes', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'impact-trace-store-skip-fts-repair-'));
  try {
    const first = openDatabase(dir);
    try {
      first.prepare("INSERT INTO repos (id, root, config_hash) VALUES (1, '/repo', 'v1')").run();
      first.prepare(`
        INSERT INTO index_runs (id, repo_id, status, started_at, finished_at, extractor_version)
        VALUES (1, 1, 'completed', datetime('now'), datetime('now'), 'test')
      `).run();
      first.prepare(`
        INSERT INTO entities (
          id, repo_id, kind, path, symbol, language_id, display_name,
          created_index_run_id, updated_index_run_id
        )
        VALUES ('file:telemetry.ts', 1, 'file', 'telemetry.ts', NULL, 'typescript', 'Telemetry Entity', 1, 1)
      `).run();
      first.prepare('DELETE FROM search_entities_fts').run();
    } finally {
      first.close();
    }

    const skipped = openDatabase(dir, { skipProjectionRepair: true });
    try {
      assert.equal(
        (skipped.prepare('SELECT count(*) AS count FROM search_entities_fts').get() as { count: number }).count,
        0
      );
    } finally {
      skipped.close();
    }

    const repaired = openDatabase(dir);
    try {
      assert.deepEqual(
        repaired
          .prepare("SELECT entity_id FROM search_entities_fts WHERE search_entities_fts MATCH 'telemetry'")
          .all()
          .map((row) => (row as { entity_id: string }).entity_id),
        ['file:telemetry.ts']
      );
    } finally {
      repaired.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

    const provTx = db
      .prepare("SELECT name FROM pragma_table_info('fact_provenance') WHERE name = 'tx_id'")
      .get();
    assert.ok(provTx, 'fact_provenance.tx_id column should exist');

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

test('migrate allows multiple provenance kinds for the same fact pair', () => {
  withTempDb((db) => {
    db.prepare(
      "INSERT INTO transactions (id, parent_tx_id, branch_id, ts, agent, index_run_id) VALUES ('tx:prov-kind', NULL, 'br_main', datetime('now'), 'test', NULL)"
    ).run();
    db.prepare(
      "INSERT INTO transactions (id, parent_tx_id, branch_id, ts, agent, index_run_id) VALUES ('tx:prov-kind-2', 'tx:prov-kind', 'br_main', datetime('now'), 'test', NULL)"
    ).run();
    db.prepare(
      "INSERT INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted) VALUES ('fact:source', 'file:source.ts', 'imports', '\"source\"', 'assert', 'tx:prov-kind', 0)"
    ).run();
    db.prepare(
      "INSERT INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted) VALUES ('fact:target', 'file:target.ts', 'imports', '\"target\"', 'assert', 'tx:prov-kind', 0)"
    ).run();

    db.prepare(
      "INSERT INTO fact_provenance (id, fact_id, source_fact_id, kind, tx_id) VALUES ('prov:evidence', 'fact:target', 'fact:source', 'evidence', 'tx:prov-kind')"
    ).run();
    db.prepare(
      "INSERT INTO fact_provenance (id, fact_id, source_fact_id, kind, tx_id) VALUES ('prov:supersedes', 'fact:target', 'fact:source', 'supersedes', 'tx:prov-kind')"
    ).run();
    db.prepare(
      "INSERT INTO fact_provenance (id, fact_id, source_fact_id, kind, tx_id) VALUES ('prov:supersedes-2', 'fact:target', 'fact:source', 'supersedes', 'tx:prov-kind-2')"
    ).run();

    const rows = db
      .prepare(
        "SELECT kind FROM fact_provenance WHERE fact_id = 'fact:target' AND source_fact_id = 'fact:source' ORDER BY kind, tx_id"
      )
      .all() as Array<{ kind: string; tx_id: string }>;
    assert.deepEqual(rows.map((row) => row.kind), ['evidence', 'supersedes', 'supersedes']);
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
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
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
      seed.prepare('DELETE FROM schema_versions WHERE version = 11').run();
      seed.prepare('DELETE FROM schema_versions WHERE version = 12').run();
      seed.prepare('DELETE FROM schema_versions WHERE version = 13').run();
      seed.prepare('DELETE FROM schema_versions WHERE version = 14').run();
      seed.prepare('DELETE FROM schema_versions WHERE version = 15').run();
      seed.prepare('DROP TABLE IF EXISTS reflections').run();
      seed.prepare('DROP TABLE IF EXISTS context_tool_runs').run();
      seed.prepare('DROP TABLE IF EXISTS context_resource_accesses').run();
      seed.prepare('DROP TABLE IF EXISTS context_packs').run();
      seed.prepare('DROP TABLE IF EXISTS search_entities_fts').run();
      seed.prepare('DROP TABLE IF EXISTS search_relation_evidence_fts').run();
      seed.prepare('DROP TABLE IF EXISTS search_facts_fts').run();
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
      assert.equal(versions.v, 15);
      const telemetry = upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_tool_runs'")
        .get();
      assert.ok(telemetry, 'context_tool_runs table must exist after upgrade');
      const contextPacks = upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_packs'")
        .get();
      assert.ok(contextPacks, 'context_packs table must exist after upgrade');
      const entitySearchFts = upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'search_entities_fts'")
        .get();
      assert.ok(entitySearchFts, 'search_entities_fts table must exist after upgrade');
      const searchFts = upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'search_relation_evidence_fts'")
        .get();
      assert.ok(searchFts, 'search_relation_evidence_fts table must exist after upgrade');
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
