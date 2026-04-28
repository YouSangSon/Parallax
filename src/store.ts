import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export type Db = DatabaseSync;

export function impactDir(repoRoot: string): string {
  return path.join(repoRoot, '.impact-trace');
}

export function databasePath(repoRoot: string): string {
  return path.join(impactDir(repoRoot), 'impact.db');
}

export function openDatabase(repoRoot: string): Db {
  mkdirSync(impactDir(repoRoot), { recursive: true });
  const db = new DatabaseSync(databasePath(repoRoot));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO schema_versions (version, applied_at)
    VALUES (1, datetime('now'));

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
  `);
}

export function ensureRepo(db: Db, repoRoot: string): number {
  db.prepare('INSERT OR IGNORE INTO repos (root, config_hash) VALUES (?, ?)').run(repoRoot, 'v1');
  const row = db.prepare('SELECT id FROM repos WHERE root = ?').get(repoRoot) as { id: number };
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

