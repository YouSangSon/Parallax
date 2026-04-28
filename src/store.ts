import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export type Db = DatabaseSync;

type OpenDatabaseOptions = {
  readOnly?: boolean;
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

  const db = new DatabaseSync(dbPath, { readOnly: options.readOnly ?? false, timeout: 5000 });
  db.exec('PRAGMA foreign_keys = ON;');
  if (!options.readOnly) {
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 5000;');
    migrate(db);
  }
  return db;
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

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (1, datetime('now'));
    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (2, datetime('now'));

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
  `);
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
