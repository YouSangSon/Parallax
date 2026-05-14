import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

import * as sqliteVec from 'sqlite-vec';

export type Db = DatabaseSync;
export const CURRENT_SCHEMA_VERSION = 15;

type OpenDatabaseOptions = {
  readOnly?: boolean;
  // Telemetry writes can skip current-schema projection scans; upgrade and
  // missing-table backfills still run because they do not rely on this flag.
  skipProjectionRepair?: boolean;
};

export function impactDir(repoRoot: string): string {
  return path.join(repoRoot, '.impact-trace');
}

export function databasePath(repoRoot: string): string {
  return path.join(impactDir(repoRoot), 'impact.db');
}

export function ensureImpactDir(repoRoot: string): string {
  const rootReal = realpathSync(path.resolve(repoRoot));
  const dir = impactDir(rootReal);
  mkdirSync(dir, { recursive: true });
  assertPathInside(rootReal, realpathSync(dir), '.impact-trace directory');
  return dir;
}

export function openDatabase(repoRoot: string, options: OpenDatabaseOptions = {}): Db {
  const rootReal = realpathSync(path.resolve(repoRoot));
  const dbPath = databasePath(rootReal);
  if (options.readOnly) {
    if (!existsSync(dbPath)) {
      throw new Error('impact trace database not found; run impact-trace init and impact-trace index first');
    }
    assertExistingPathInside(rootReal, dbPath, 'impact trace database');
  } else {
    ensureImpactDir(rootReal);
    if (pathExists(dbPath)) {
      assertExistingPathInside(rootReal, dbPath, 'impact trace database');
    }
  }

  const db = new DatabaseSync(dbPath, { readOnly: options.readOnly ?? false, timeout: 5000, allowExtension: true });
  db.exec('PRAGMA foreign_keys = ON;');
  if (!options.readOnly) {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    migrate(db, { skipProjectionRepair: options.skipProjectionRepair === true });
  }
  // Phase 4 P5 / ADR D-018: try to load sqlite-vec for ANN-accelerated
  // semantic recall. On failure (extension missing / arch mismatch),
  // recallSemantic silently falls back to the brute-force int8 path so
  // existing callers are unaffected.
  vectorExtensionState.set(db, loadVectorExtension(db));
  return db;
}

// Track per-handle whether sqlite-vec successfully loaded. WeakMap so
// the entry is GCed alongside the db handle.
const vectorExtensionState = new WeakMap<Db, boolean>();

export function isVectorExtensionLoaded(db: Db): boolean {
  return vectorExtensionState.get(db) === true;
}

const VEC_TABLE_PREFIX = 'vec_facts_';

/**
 * Map a model identifier (e.g. 'Xenova/multilingual-e5-base') to a
 * SQL-safe per-model vec0 table name. Lower-cased and non-alphanumeric
 * characters become underscores so the result is a valid identifier.
 */
export function vecTableName(model: string): string {
  return VEC_TABLE_PREFIX + model.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

/**
 * Lazily create a per-model vec0 virtual table. Called the first time
 * we write an embedding for a given model on a given db handle. Returns
 * false when the sqlite-vec extension is not available, when the model
 * name fails the safe-identifier guard, or when CREATE itself errors —
 * dual-write skips the vec INSERT and recallSemantic stays in
 * brute-force mode for that model. ADR D-018 (D2 lazy creation).
 */
export function ensureVecTable(db: Db, model: string, dim: number): boolean {
  if (!isVectorExtensionLoaded(db)) return false;
  if (!Number.isInteger(dim) || dim <= 0 || dim > 4096) return false;
  const tableName = vecTableName(model);
  if (tableName === VEC_TABLE_PREFIX) return false;
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
         fact_id TEXT PRIMARY KEY,
         embedding int8[${dim}]
       )`
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe whether a vec0 table exists for the given model on this db.
 * Used by recallSemantic to choose the ANN path vs the brute-force
 * fallback for a given query. Cheap (single sqlite_master lookup).
 */
export function hasVecTable(db: Db, model: string): boolean {
  if (!isVectorExtensionLoaded(db)) return false;
  const row = db
    .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(vecTableName(model)) as { one: number } | undefined;
  return row !== undefined;
}

function pathExists(targetPath: string): boolean {
  try {
    lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function assertExistingPathInside(rootReal: string, targetPath: string, label: string): void {
  let resolved: string;
  try {
    resolved = realpathSync(targetPath);
  } catch {
    throw new Error(`${label} is not accessible inside repo root`);
  }
  assertPathInside(rootReal, resolved, label);
}

function assertPathInside(rootReal: string, resolvedPath: string, label: string): void {
  const relative = path.relative(rootReal, resolvedPath);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`${label} resolves outside repo root`);
}

type MigrateOptions = {
  skipProjectionRepair: boolean;
};

function migrate(db: Db, options: MigrateOptions): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (1, datetime('now'));
    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (2, datetime('now'));
    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (3, datetime('now'));

    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY,
      root TEXT NOT NULL UNIQUE,
      config_hash TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS index_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      extractor_version TEXT NOT NULL,
      git_commit_sha TEXT,
      git_branch_name TEXT,
      git_is_dirty INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(repo_id) REFERENCES repos(id)
    );

    CREATE TABLE IF NOT EXISTS adapter_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      index_run_id INTEGER NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      language_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_summary TEXT,
      UNIQUE(index_run_id, adapter_id),
      FOREIGN KEY(index_run_id) REFERENCES index_runs(id)
    );

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      repo_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      path TEXT,
      symbol TEXT,
      language_id TEXT,
      display_name TEXT NOT NULL,
      created_index_run_id INTEGER NOT NULL,
      updated_index_run_id INTEGER NOT NULL,
      FOREIGN KEY(repo_id) REFERENCES repos(id),
      FOREIGN KEY(created_index_run_id) REFERENCES index_runs(id),
      FOREIGN KEY(updated_index_run_id) REFERENCES index_runs(id)
    );

    CREATE TABLE IF NOT EXISTS entity_versions (
      entity_id TEXT NOT NULL,
      index_run_id INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      location_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL,
      PRIMARY KEY(entity_id, index_run_id),
      FOREIGN KEY(entity_id) REFERENCES entities(id),
      FOREIGN KEY(index_run_id) REFERENCES index_runs(id)
    );

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      repo_id INTEGER NOT NULL,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      confidence TEXT NOT NULL,
      adapter_run_id INTEGER,
      index_run_id INTEGER NOT NULL,
      provenance TEXT NOT NULL,
      FOREIGN KEY(repo_id) REFERENCES repos(id),
      FOREIGN KEY(source_entity_id) REFERENCES entities(id),
      FOREIGN KEY(target_entity_id) REFERENCES entities(id),
      FOREIGN KEY(adapter_run_id) REFERENCES adapter_runs(id),
      FOREIGN KEY(index_run_id) REFERENCES index_runs(id)
    );

    CREATE TABLE IF NOT EXISTS relation_evidence (
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
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      repo_id INTEGER,
      local_path TEXT NOT NULL,
      remote_url TEXT,
      service_name TEXT,
      trust_policy_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(workspace_id, local_path),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY(repo_id) REFERENCES repos(id)
    );

    CREATE TABLE IF NOT EXISTS contracts (
      id TEXT PRIMARY KEY,
      workspace_id INTEGER,
      repo_id INTEGER,
      kind TEXT NOT NULL,
      service_name TEXT,
      path TEXT,
      display_name TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY(repo_id) REFERENCES repos(id)
    );

    CREATE TABLE IF NOT EXISTS contract_versions (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      index_run_id INTEGER,
      content_hash TEXT NOT NULL,
      schema_version TEXT,
      compatibility_json TEXT NOT NULL DEFAULT '{}',
      breaking_change_summary TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(contract_id) REFERENCES contracts(id),
      FOREIGN KEY(index_run_id) REFERENCES index_runs(id)
    );

    CREATE TABLE IF NOT EXISTS cross_repo_links (
      id TEXT PRIMARY KEY,
      workspace_id INTEGER,
      source_repo_id INTEGER,
      target_repo_id INTEGER,
      source_entity_id TEXT,
      target_entity_id TEXT,
      kind TEXT NOT NULL,
      confidence TEXT NOT NULL,
      provenance TEXT NOT NULL,
      index_run_id INTEGER,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY(source_repo_id) REFERENCES repos(id),
      FOREIGN KEY(target_repo_id) REFERENCES repos(id),
      FOREIGN KEY(source_entity_id) REFERENCES entities(id),
      FOREIGN KEY(target_entity_id) REFERENCES entities(id),
      FOREIGN KEY(index_run_id) REFERENCES index_runs(id)
    );

    CREATE TABLE IF NOT EXISTS work_artifacts (
      id TEXT PRIMARY KEY,
      workspace_id INTEGER,
      repo_id INTEGER,
      kind TEXT NOT NULL,
      path TEXT,
      external_uri TEXT,
      title TEXT NOT NULL,
      owner TEXT,
      content_hash TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_index_run_id INTEGER,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY(repo_id) REFERENCES repos(id),
      FOREIGN KEY(updated_index_run_id) REFERENCES index_runs(id)
    );

    CREATE TABLE IF NOT EXISTS artifact_links (
      id TEXT PRIMARY KEY,
      workspace_id INTEGER,
      source_entity_id TEXT,
      target_entity_id TEXT,
      kind TEXT NOT NULL,
      confidence TEXT NOT NULL,
      provenance TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      index_run_id INTEGER,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY(source_entity_id) REFERENCES entities(id),
      FOREIGN KEY(target_entity_id) REFERENCES entities(id),
      FOREIGN KEY(index_run_id) REFERENCES index_runs(id)
    );

    CREATE TABLE IF NOT EXISTS index_coverage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      index_run_id INTEGER NOT NULL,
      adapter_id TEXT NOT NULL,
      path TEXT NOT NULL,
      language_id TEXT,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      UNIQUE(index_run_id, adapter_id, path),
      FOREIGN KEY(index_run_id) REFERENCES index_runs(id)
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      language TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      index_run_id INTEGER NOT NULL,
      UNIQUE(repo_id, path),
      FOREIGN KEY(repo_id) REFERENCES repos(id),
      FOREIGN KEY(index_run_id) REFERENCES index_runs(id)
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      exported INTEGER NOT NULL,
      semantic_id TEXT NOT NULL,
      index_run_id INTEGER NOT NULL,
      UNIQUE(file_id, semantic_id),
      FOREIGN KEY(file_id) REFERENCES files(id),
      FOREIGN KEY(index_run_id) REFERENCES index_runs(id)
    );

    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL,
      source_file_id INTEGER NOT NULL,
      target_file_id INTEGER,
      kind TEXT NOT NULL,
      target_path TEXT NOT NULL,
      confidence TEXT NOT NULL,
      provenance TEXT NOT NULL,
      index_run_id INTEGER NOT NULL,
      UNIQUE(repo_id, source_file_id, kind, target_path),
      FOREIGN KEY(repo_id) REFERENCES repos(id),
      FOREIGN KEY(source_file_id) REFERENCES files(id),
      FOREIGN KEY(target_file_id) REFERENCES files(id),
      FOREIGN KEY(index_run_id) REFERENCES index_runs(id)
    );

    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      repo_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      snippet TEXT NOT NULL,
      confidence TEXT NOT NULL,
      index_run_id INTEGER NOT NULL,
      FOREIGN KEY(repo_id) REFERENCES repos(id),
      FOREIGN KEY(index_run_id) REFERENCES index_runs(id)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      repo_id INTEGER NOT NULL,
      index_run_id INTEGER NOT NULL,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(repo_id) REFERENCES repos(id),
      FOREIGN KEY(index_run_id) REFERENCES index_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_entities_repo_kind ON entities(repo_id, kind);
    CREATE INDEX IF NOT EXISTS idx_entities_repo_path ON entities(repo_id, path);
    CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(repo_id, target_entity_id, index_run_id);
    CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(repo_id, source_entity_id, index_run_id);
    CREATE INDEX IF NOT EXISTS idx_index_coverage_run ON index_coverage(index_run_id, status);
    CREATE INDEX IF NOT EXISTS idx_workspace_repos_workspace ON workspace_repos(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_contracts_workspace ON contracts(workspace_id, kind);
    CREATE INDEX IF NOT EXISTS idx_cross_repo_links_workspace ON cross_repo_links(workspace_id, kind);
    CREATE INDEX IF NOT EXISTS idx_work_artifacts_workspace ON work_artifacts(workspace_id, kind);
  `);

  db.exec(`
    -- Agent memory layer (schema v4). See docs/agent-db-exploration.ko.md.
    CREATE TABLE IF NOT EXISTS attribute_defs (
      name TEXT PRIMARY KEY NOT NULL,
      value_type TEXT NOT NULL,
      is_code_relation INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS branches (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      head_tx_id TEXT,
      parent_branch_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(parent_branch_id) REFERENCES branches(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY NOT NULL,
      parent_tx_id TEXT,
      branch_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      agent TEXT NOT NULL,
      index_run_id INTEGER,
      FOREIGN KEY(parent_tx_id) REFERENCES transactions(id),
      FOREIGN KEY(branch_id) REFERENCES branches(id),
      FOREIGN KEY(index_run_id) REFERENCES index_runs(id)
    );

    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY NOT NULL,
      entity_id TEXT NOT NULL,
      attribute TEXT NOT NULL,
      value_blob TEXT NOT NULL,
      op TEXT NOT NULL DEFAULT 'assert',
      tx_id TEXT NOT NULL,
      redacted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(attribute) REFERENCES attribute_defs(name),
      FOREIGN KEY(tx_id) REFERENCES transactions(id)
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      fact_id TEXT PRIMARY KEY NOT NULL,
      dim64_binary BLOB,
      dim768_int8 BLOB,
      FOREIGN KEY(fact_id) REFERENCES facts(id)
    );

    CREATE TABLE IF NOT EXISTS fact_provenance (
      id TEXT PRIMARY KEY NOT NULL,
      fact_id TEXT NOT NULL,
      source_fact_id TEXT NOT NULL,
      tx_id TEXT,
      kind TEXT NOT NULL DEFAULT 'evidence',
      UNIQUE(fact_id, source_fact_id, kind, tx_id),
      FOREIGN KEY(fact_id) REFERENCES facts(id),
      FOREIGN KEY(source_fact_id) REFERENCES facts(id),
      FOREIGN KEY(tx_id) REFERENCES transactions(id)
    );

    -- Multi-parent transaction graph (schema v5). transactions.parent_tx_id is
    -- kept as the primary parent for backward compatibility; merge transactions
    -- record additional parents here so recall walks the full DAG.
    CREATE TABLE IF NOT EXISTS transaction_parents (
      tx_id TEXT NOT NULL,
      parent_tx_id TEXT NOT NULL,
      PRIMARY KEY (tx_id, parent_tx_id),
      FOREIGN KEY(tx_id) REFERENCES transactions(id),
      FOREIGN KEY(parent_tx_id) REFERENCES transactions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_facts_entity_attr ON facts(entity_id, attribute);
    CREATE INDEX IF NOT EXISTS idx_facts_tx ON facts(tx_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_branch ON transactions(branch_id, ts);
    CREATE INDEX IF NOT EXISTS idx_fact_provenance_fact ON fact_provenance(fact_id);
    CREATE INDEX IF NOT EXISTS idx_transaction_parents_tx ON transaction_parents(tx_id);

    -- Backfill v5: every existing transactions row with non-null parent gets
    -- a transaction_parents row. Idempotent on re-run.
    INSERT OR IGNORE INTO transaction_parents (tx_id, parent_tx_id)
    SELECT id, parent_tx_id FROM transactions WHERE parent_tx_id IS NOT NULL;

    -- Schema v6: model-agnostic fact embeddings. The earlier embeddings
    -- table hardcoded dim64_binary/dim768_int8 to a single retrieval
    -- strategy and a single model. fact_embeddings stores int8 vectors
    -- of arbitrary dim and tags them with a model identifier so the
    -- same fact can carry vectors from multiple models during a swap.
    CREATE TABLE IF NOT EXISTS fact_embeddings (
      fact_id TEXT NOT NULL,
      model TEXT NOT NULL,
      vector BLOB NOT NULL,
      dim INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (fact_id, model),
      FOREIGN KEY(fact_id) REFERENCES facts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_fact_embeddings_model ON fact_embeddings(model);

    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (4, datetime('now'));
    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (5, datetime('now'));
    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (6, datetime('now'));

    INSERT OR IGNORE INTO attribute_defs (name, value_type, is_code_relation, description) VALUES
      ('imports', 'entity_ref', 1, 'File or module import edge'),
      ('calls', 'entity_ref', 1, 'Function or method call edge'),
      ('exports', 'entity_ref', 1, 'File, module, or symbol export edge'),
      ('implements', 'entity_ref', 1, 'Type implementation edge'),
      ('extends', 'entity_ref', 1, 'Inheritance or extension edge'),
      ('reads', 'entity_ref', 1, 'Read access edge'),
      ('writes', 'entity_ref', 1, 'Write access edge'),
      ('raises', 'entity_ref', 1, 'Raised error or event edge'),
      ('handles', 'entity_ref', 1, 'Handled error or event edge'),
      ('owns', 'entity_ref', 1, 'Ownership edge'),
      ('tests', 'entity_ref', 1, 'Test or verification edge'),
      ('documents', 'entity_ref', 1, 'Documentation edge'),
      ('configures', 'entity_ref', 1, 'Configuration edge'),
      ('breaks_compat', 'entity_ref', 1, 'Breaking compatibility edge'),
      ('references', 'entity_ref', 1, 'Reference edge'),
      ('declares', 'entity_ref', 1, 'Declaration edge'),
      ('governs', 'entity_ref', 1, 'Governance edge'),
      ('affects', 'entity_ref', 1, 'Inferred side-effect dependency'),
      ('depends_on', 'entity_ref', 1, 'Declared package or module dependency');

    INSERT OR IGNORE INTO branches (id, name, head_tx_id, parent_branch_id, created_at)
    VALUES ('br_main', 'main', NULL, NULL, datetime('now'));
  `);

  // Schema v7: reflection consolidation + speculative branch GC.
  // ALTER TABLE ADD COLUMN has no native IF NOT EXISTS in SQLite, so each
  // column probe runs against pragma_table_info before issuing the ALTER.
  // CREATE TABLE / INSERT continue to use IF NOT EXISTS / OR IGNORE.
  tryAddColumn(db, 'branches', 'state', "TEXT NOT NULL DEFAULT 'active'");
  tryAddColumn(db, 'transactions', 'archived', 'INTEGER NOT NULL DEFAULT 0');
  tryAddColumn(db, 'fact_provenance', 'kind', "TEXT NOT NULL DEFAULT 'evidence'");
  tryAddColumn(db, 'fact_provenance', 'tx_id', 'TEXT');
  tryAddColumn(db, 'relation_evidence', 'start_line', 'INTEGER');
  tryAddColumn(db, 'relation_evidence', 'end_line', 'INTEGER');
  tryAddColumn(db, 'relation_evidence', 'start_col', 'INTEGER');
  tryAddColumn(db, 'relation_evidence', 'end_col', 'INTEGER');
  tryAddColumn(db, 'index_runs', 'git_commit_sha', 'TEXT');
  tryAddColumn(db, 'index_runs', 'git_branch_name', 'TEXT');
  tryAddColumn(db, 'index_runs', 'git_is_dirty', 'INTEGER NOT NULL DEFAULT 0');
  ensureFactProvenanceKindUniqueness(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reflections (
      id TEXT PRIMARY KEY NOT NULL,
      branch_id TEXT NOT NULL,
      model TEXT NOT NULL,
      summary_fact_id TEXT NOT NULL,
      source_fact_count INTEGER NOT NULL,
      criteria_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(branch_id) REFERENCES branches(id),
      FOREIGN KEY(summary_fact_id) REFERENCES facts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_reflections_branch ON reflections(branch_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_archived ON transactions(archived);
    CREATE INDEX IF NOT EXISTS idx_fact_provenance_fact ON fact_provenance(fact_id);
    CREATE INDEX IF NOT EXISTS idx_fact_provenance_source_kind ON fact_provenance(source_fact_id, kind);
    CREATE INDEX IF NOT EXISTS idx_fact_provenance_tx_kind ON fact_provenance(tx_id, kind);

    UPDATE fact_provenance
    SET tx_id = (
      SELECT facts.tx_id
      FROM facts
      WHERE facts.id = fact_provenance.fact_id
    )
    WHERE tx_id IS NULL;

    INSERT OR IGNORE INTO attribute_defs (name, value_type, is_code_relation, description)
    VALUES ('reflection', 'text', 0, 'LLM-generated semantic summary of an entity history');

    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (7, datetime('now'));
    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (8, datetime('now'));
    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (9, datetime('now'));
  `);

  // Schema v10: local context access telemetry. These rows are append-only
  // observability for MCP context tools/resources and do not change reports,
  // index runs, facts, or relation graph semantics.
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_tool_runs (
      id TEXT PRIMARY KEY NOT NULL,
      repo_id INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      index_run_id INTEGER,
      budget TEXT,
      query TEXT,
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      returned_bytes INTEGER NOT NULL,
      resource_count INTEGER NOT NULL,
      omitted_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      FOREIGN KEY(repo_id) REFERENCES repos(id),
      FOREIGN KEY(index_run_id) REFERENCES index_runs(id)
    );

    CREATE TABLE IF NOT EXISTS context_resource_accesses (
      id TEXT PRIMARY KEY NOT NULL,
      repo_id INTEGER NOT NULL,
      uri TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      resource_id TEXT,
      index_run_id INTEGER,
      returned_bytes INTEGER NOT NULL,
      accessed_at TEXT NOT NULL,
      FOREIGN KEY(repo_id) REFERENCES repos(id),
      FOREIGN KEY(index_run_id) REFERENCES index_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_context_tool_runs_repo_time
      ON context_tool_runs(repo_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_context_resource_accesses_repo_time
      ON context_resource_accesses(repo_id, accessed_at);
    CREATE INDEX IF NOT EXISTS idx_context_resource_accesses_uri
      ON context_resource_accesses(repo_id, uri);

    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (10, datetime('now'));
  `);

  // Schema v15: persisted MCP context packs. Context tools can return a
  // content-addressed resource reference on repeated calls instead of
  // retransmitting the same large compact context payload.
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_packs (
      id TEXT PRIMARY KEY NOT NULL,
      repo_id INTEGER NOT NULL,
      index_run_id INTEGER NOT NULL,
      budget TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      changed_files_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      pack_json TEXT NOT NULL,
      returned_bytes INTEGER NOT NULL,
      resource_count INTEGER NOT NULL,
      omitted_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY(repo_id) REFERENCES repos(id),
      FOREIGN KEY(index_run_id) REFERENCES index_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_context_packs_repo_time
      ON context_packs(repo_id, last_accessed_at);
    CREATE INDEX IF NOT EXISTS idx_context_packs_repo_request
      ON context_packs(repo_id, request_hash);
    CREATE INDEX IF NOT EXISTS idx_context_packs_repo_index
      ON context_packs(repo_id, index_run_id);

    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (15, datetime('now'));
  `);

  // Schema v11/v14: persistent FTS projections for context search. These
  // projections make entities, relation evidence, and selected memory facts
  // searchable from read-only MCP calls without rebuilding temp FTS tables per
  // query.
  const searchFtsSchemaVersion = maxAppliedSchemaVersion(db);
  const searchFtsNeedsInitialBackfill =
    searchFtsSchemaVersion < 11
    || !tableExists(db, 'search_relation_evidence_fts')
    || !tableExists(db, 'search_facts_fts')
    || searchFtsSchemaVersion < 14
    || !tableExists(db, 'search_entities_fts');

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS search_entities_fts
    USING fts5(
      entity_id UNINDEXED,
      repo_id UNINDEXED,
      updated_index_run_id UNINDEXED,
      id_text,
      display_name,
      path,
      symbol
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS search_relation_evidence_fts
    USING fts5(
      evidence_id UNINDEXED,
      relation_id UNINDEXED,
      repo_id UNINDEXED,
      index_run_id UNINDEXED,
      file_path,
      kind,
      snippet
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS search_facts_fts
    USING fts5(
      fact_id UNINDEXED,
      entity_id UNINDEXED,
      tx_id UNINDEXED,
      attribute,
      value_blob
    );

    CREATE TRIGGER IF NOT EXISTS trg_entities_fts_ai
    AFTER INSERT ON entities
    BEGIN
      DELETE FROM search_entities_fts WHERE entity_id = new.id;
      INSERT INTO search_entities_fts (
        entity_id, repo_id, updated_index_run_id, id_text, display_name, path, symbol
      )
      VALUES (
        new.id, new.repo_id, new.updated_index_run_id, new.id, new.display_name,
        COALESCE(new.path, ''), COALESCE(new.symbol, '')
      );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_entities_fts_ad
    AFTER DELETE ON entities
    BEGIN
      DELETE FROM search_entities_fts WHERE entity_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_entities_fts_au
    AFTER UPDATE ON entities
    BEGIN
      DELETE FROM search_entities_fts WHERE entity_id = old.id;
      INSERT INTO search_entities_fts (
        entity_id, repo_id, updated_index_run_id, id_text, display_name, path, symbol
      )
      VALUES (
        new.id, new.repo_id, new.updated_index_run_id, new.id, new.display_name,
        COALESCE(new.path, ''), COALESCE(new.symbol, '')
      );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_relation_evidence_fts_ai
    AFTER INSERT ON relation_evidence
    BEGIN
      DELETE FROM search_relation_evidence_fts WHERE evidence_id = new.id;
      INSERT INTO search_relation_evidence_fts (
        evidence_id, relation_id, repo_id, index_run_id, file_path, kind, snippet
      )
      VALUES (
        new.id, new.relation_id, new.repo_id, new.index_run_id, new.file_path, new.kind, new.snippet
      );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_relation_evidence_fts_ad
    AFTER DELETE ON relation_evidence
    BEGIN
      DELETE FROM search_relation_evidence_fts WHERE evidence_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_relation_evidence_fts_au
    AFTER UPDATE ON relation_evidence
    BEGIN
      DELETE FROM search_relation_evidence_fts WHERE evidence_id = old.id;
      INSERT INTO search_relation_evidence_fts (
        evidence_id, relation_id, repo_id, index_run_id, file_path, kind, snippet
      )
      VALUES (
        new.id, new.relation_id, new.repo_id, new.index_run_id, new.file_path, new.kind, new.snippet
      );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_facts_fts_ai
    AFTER INSERT ON facts
    BEGIN
      DELETE FROM search_facts_fts WHERE fact_id = new.id;
      INSERT INTO search_facts_fts (fact_id, entity_id, tx_id, attribute, value_blob)
      SELECT new.id, new.entity_id, new.tx_id, new.attribute, new.value_blob
      WHERE new.op = 'assert' AND new.redacted = 0;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_facts_fts_ad
    AFTER DELETE ON facts
    BEGIN
      DELETE FROM search_facts_fts WHERE fact_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_facts_fts_au
    AFTER UPDATE ON facts
    BEGIN
      DELETE FROM search_facts_fts WHERE fact_id = old.id;
      INSERT INTO search_facts_fts (fact_id, entity_id, tx_id, attribute, value_blob)
      SELECT new.id, new.entity_id, new.tx_id, new.attribute, new.value_blob
      WHERE new.op = 'assert' AND new.redacted = 0;
    END;

    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (11, datetime('now'));
    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (12, datetime('now'));
    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (13, datetime('now'));
    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (14, datetime('now'));
  `);

  const searchFtsNeedsBackfill =
    searchFtsNeedsInitialBackfill
    || (!options.skipProjectionRepair && searchFtsProjectionNeedsBackfill(db));

  if (searchFtsNeedsBackfill) {
    db.exec(`
      DELETE FROM search_entities_fts;
      INSERT INTO search_entities_fts (
        entity_id, repo_id, updated_index_run_id, id_text, display_name, path, symbol
      )
      SELECT id, repo_id, updated_index_run_id, id, display_name, COALESCE(path, ''), COALESCE(symbol, '')
      FROM entities;

      DELETE FROM search_relation_evidence_fts;
      INSERT INTO search_relation_evidence_fts (
        evidence_id, relation_id, repo_id, index_run_id, file_path, kind, snippet
      )
      SELECT id, relation_id, repo_id, index_run_id, file_path, kind, snippet
      FROM relation_evidence;

      DELETE FROM search_facts_fts;
      INSERT INTO search_facts_fts (fact_id, entity_id, tx_id, attribute, value_blob)
      SELECT id, entity_id, tx_id, attribute, value_blob
      FROM facts
      WHERE op = 'assert' AND redacted = 0;
    `);
  }
}

// Identifier allowlists guard the only place in this codebase that
// interpolates user-style strings into a DDL statement. SQLite has no
// IF NOT EXISTS form for ADD COLUMN and does not bind identifiers in
// ALTER TABLE, so we accept the interpolation but constrain it. Every
// caller must pass a literal that appears in these sets.
const ALLOWED_TABLES = new Set(['branches', 'transactions', 'fact_provenance', 'relation_evidence', 'index_runs']);
const ALLOWED_COLUMNS = new Set([
  'state',
  'archived',
  'kind',
  'tx_id',
  'start_line',
  'end_line',
  'start_col',
  'end_col',
  'git_commit_sha',
  'git_branch_name',
  'git_is_dirty'
]);
const ALLOWED_DEFINITIONS = /^(?:TEXT|INTEGER|REAL|BLOB|NUMERIC)\b[\sA-Za-z0-9_'-]*$/;

function tryAddColumn(db: Db, table: string, column: string, definition: string): void {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`tryAddColumn: table not in allowlist: ${table}`);
  }
  if (!ALLOWED_COLUMNS.has(column)) {
    throw new Error(`tryAddColumn: column not in allowlist: ${column}`);
  }
  if (!ALLOWED_DEFINITIONS.test(definition)) {
    throw new Error(`tryAddColumn: definition shape rejected: ${definition}`);
  }
  const exists = db
    .prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?')
    .get(table, column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureFactProvenanceKindUniqueness(db: Db): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fact_provenance'")
    .get() as { sql: string } | undefined;
  const normalizedSql = row?.sql.toLowerCase().replace(/\s+/g, ' ') ?? '';
  if (normalizedSql.includes('unique(fact_id, source_fact_id, kind, tx_id)')) {
    return;
  }

  db.exec(`
    ALTER TABLE fact_provenance RENAME TO fact_provenance_before_kind_unique;

    CREATE TABLE fact_provenance (
      id TEXT PRIMARY KEY NOT NULL,
      fact_id TEXT NOT NULL,
      source_fact_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'evidence',
      tx_id TEXT,
      UNIQUE(fact_id, source_fact_id, kind, tx_id),
      FOREIGN KEY(fact_id) REFERENCES facts(id),
      FOREIGN KEY(source_fact_id) REFERENCES facts(id),
      FOREIGN KEY(tx_id) REFERENCES transactions(id)
    );

    INSERT OR IGNORE INTO fact_provenance (id, fact_id, source_fact_id, kind, tx_id)
    SELECT id, fact_id, source_fact_id, COALESCE(kind, 'evidence'), tx_id
    FROM fact_provenance_before_kind_unique;

    DROP TABLE fact_provenance_before_kind_unique;
  `);
}

function tableExists(db: Db, name: string): boolean {
  return db
    .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;
}

function countRows(db: Db, sql: string): number {
  const row = db.prepare(sql).get() as { count: number };
  return row.count;
}

function searchFtsProjectionNeedsBackfill(db: Db): boolean {
  const missingEntities = countRows(
    db,
    `SELECT count(*) AS count
       FROM entities
      WHERE NOT EXISTS (
        SELECT 1
        FROM search_entities_fts fts
        WHERE fts.entity_id = entities.id
      )`
  );
  const staleEntities = countRows(
    db,
    `SELECT count(*) AS count
       FROM search_entities_fts fts
      WHERE NOT EXISTS (
        SELECT 1
        FROM entities
        WHERE entities.id = fts.entity_id
      )`
  );
  const mismatchedEntities = countRows(
    db,
    `SELECT count(*) AS count
       FROM search_entities_fts fts
       INNER JOIN entities
         ON entities.id = fts.entity_id
      WHERE CAST(fts.repo_id AS INTEGER) <> entities.repo_id
         OR CAST(fts.updated_index_run_id AS INTEGER) <> entities.updated_index_run_id
         OR fts.id_text <> entities.id
         OR fts.display_name <> entities.display_name
         OR fts.path <> COALESCE(entities.path, '')
         OR fts.symbol <> COALESCE(entities.symbol, '')`
  );
  const missingEvidence = countRows(
    db,
    `SELECT count(*) AS count
       FROM relation_evidence
      WHERE NOT EXISTS (
        SELECT 1
        FROM search_relation_evidence_fts fts
        WHERE fts.evidence_id = relation_evidence.id
      )`
  );
  const staleEvidence = countRows(
    db,
    `SELECT count(*) AS count
       FROM search_relation_evidence_fts fts
      WHERE NOT EXISTS (
        SELECT 1
        FROM relation_evidence
        WHERE relation_evidence.id = fts.evidence_id
      )`
  );
  const missingFacts = countRows(
    db,
    `SELECT count(*) AS count
       FROM facts
      WHERE op = 'assert'
        AND redacted = 0
        AND NOT EXISTS (
          SELECT 1
          FROM search_facts_fts fts
          WHERE fts.fact_id = facts.id
        )`
  );
  const staleFacts = countRows(
    db,
    `SELECT count(*) AS count
       FROM search_facts_fts fts
      WHERE NOT EXISTS (
        SELECT 1
        FROM facts
        WHERE facts.id = fts.fact_id
          AND facts.op = 'assert'
          AND facts.redacted = 0
      )`
  );
  return (
    missingEntities > 0
    || staleEntities > 0
    || mismatchedEntities > 0
    || missingEvidence > 0
    || staleEvidence > 0
    || missingFacts > 0
    || staleFacts > 0
  );
}

function maxAppliedSchemaVersion(db: Db): number {
  const row = db.prepare('SELECT max(version) AS version FROM schema_versions').get() as { version: number | null };
  return row.version ?? 0;
}

export function assertCurrentSchema(db: Db, feature: string): void {
  const version = maxAppliedSchemaVersion(db);
  const hasProvenanceTx = columnExists(db, 'fact_provenance', 'tx_id');
  const hasCurrentSearchProjections =
    tableExists(db, 'search_entities_fts')
    && tableExists(db, 'search_relation_evidence_fts')
    && tableExists(db, 'search_facts_fts');
  const hasContextPackStore = tableExists(db, 'context_packs');
  if (version < CURRENT_SCHEMA_VERSION || !hasProvenanceTx || !hasCurrentSearchProjections || !hasContextPackStore) {
    throw new Error(
      `${feature} requires Impact Trace schema v${CURRENT_SCHEMA_VERSION} with current search projections and context pack store; current database is v${version}. Run impact-trace init with the current build to apply additive migrations.`
    );
  }
}

function columnExists(db: Db, table: string, column: string): boolean {
  return db
    .prepare('SELECT 1 AS one FROM pragma_table_info(?) WHERE name = ?')
    .get(table, column) !== undefined;
}

export function ensureRepo(db: Db, repoRoot: string): number {
  db.prepare('INSERT OR IGNORE INTO repos (root, config_hash) VALUES (?, ?)').run(repoRoot, 'v1');
  return getRepoId(db, repoRoot);
}

export function getRepoId(db: Db, repoRoot: string): number {
  const row = db.prepare('SELECT id FROM repos WHERE root = ?').get(repoRoot) as { id: number } | undefined;
  if (!row) {
    throw new Error('repo is not indexed; run impact-trace init and impact-trace index first');
  }
  return row.id;
}

export function latestCompletedIndexRun(db: Db, repoId: number): number {
  const row = db
    .prepare('SELECT id FROM index_runs WHERE repo_id = ? AND status = ? ORDER BY id DESC LIMIT 1')
    .get(repoId, 'completed') as { id: number } | undefined;
  if (!row) {
    throw new Error('no completed index found; run impact-trace index first');
  }
  return row.id;
}

export function contentHash(...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update(' ');
  }
  return hash.digest('hex');
}

export function loadVectorExtension(db: Db): boolean {
  try {
    sqliteVec.load(db as unknown as Parameters<typeof sqliteVec.load>[0]);
    return true;
  } catch {
    return false;
  }
}
