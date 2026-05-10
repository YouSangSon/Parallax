import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { doctorProject, indexProject, initProject } from '../src/index.js';
import { databasePath } from '../src/store.js';

process.env.IMPACT_TRACE_EMBEDDING_MODEL = 'stub-sha256';

const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve('tsx');

async function makeRepo(prefix = 'impact-trace-doctor-'): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(repoRoot, 'src/b.ts'), 'import { a } from "./a"; export const b = a;\n');
  return repoRoot;
}

function findingCodes(report: Awaited<ReturnType<typeof doctorProject>>): string[] {
  return report.findings.map((finding) => finding.code);
}

test('doctorProject reports a missing database without creating workspace files', async () => {
  const repoRoot = await makeRepo('impact-trace-doctor-missing-');

  const report = doctorProject({ repoRoot });

  assert.equal(report.version, 0);
  assert.equal(report.database.exists, false);
  assert.equal(report.database.schemaVersion, null);
  assert.equal(report.index.latestCompletedRun, null);
  assert.equal(report.telemetry.toolRuns, null);
  assert.ok(findingCodes(report).includes('database_missing'));
  assert.equal(existsSync(path.join(repoRoot, '.impact-trace')), false);
});

test('doctorProject reports initialized repos before the first index', async () => {
  const repoRoot = await makeRepo('impact-trace-doctor-init-');
  await initProject({ repoRoot });

  const report = doctorProject({ repoRoot });

  assert.equal(report.database.exists, true);
  assert.equal(report.database.schemaVersion, 11);
  assert.equal(report.database.tables.contextToolRuns, true);
  assert.equal(report.database.tables.contextResourceAccesses, true);
  assert.equal(report.index.latestRun, null);
  assert.equal(report.index.latestCompletedRun, null);
  assert.equal(report.telemetry.toolRuns, 0);
  assert.equal(report.telemetry.resourceAccesses, 0);
  assert.ok(findingCodes(report).includes('index_missing'));
});

test('doctorProject reports latest completed index, coverage, adapters, and vector state', async () => {
  const repoRoot = await makeRepo('impact-trace-doctor-indexed-');
  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const report = doctorProject({ repoRoot });

  assert.equal(report.database.exists, true);
  assert.equal(report.database.schemaVersion, 11);
  assert.equal(report.index.latestCompletedRun?.id, index.indexRunId);
  assert.equal(report.index.latestCompletedRun?.status, 'completed');
  assert.ok((report.index.coverage?.indexedPaths ?? 0) >= 2);
  assert.ok(report.index.adapterRuns.length > 0);
  assert.equal(typeof report.vector.sqliteVecLoaded, 'boolean');
  assert.ok(!report.findings.some((finding) => finding.severity === 'error'));
});

test('doctorProject handles pre-v10 databases without querying missing telemetry tables', async () => {
  const repoRoot = await makeRepo('impact-trace-doctor-prev10-');
  await initProject({ repoRoot });
  const db = new DatabaseSync(databasePath(repoRoot));
  try {
    db.exec(`
      DELETE FROM schema_versions WHERE version >= 10;
      DROP TABLE context_tool_runs;
      DROP TABLE context_resource_accesses;
    `);
  } finally {
    db.close();
  }

  const report = doctorProject({ repoRoot });

  assert.equal(report.database.schemaVersion, 9);
  assert.equal(report.database.tables.contextToolRuns, false);
  assert.equal(report.database.tables.contextResourceAccesses, false);
  assert.equal(report.telemetry.toolRuns, null);
  assert.ok(findingCodes(report).includes('schema_outdated'));
});

test('doctorProject handles legacy pre-git-snapshot index_runs columns', async () => {
  const repoRoot = await makeRepo('impact-trace-doctor-legacy-index-');
  await initProject({ repoRoot });
  const db = new DatabaseSync(databasePath(repoRoot));
  try {
    db.exec('PRAGMA foreign_keys = OFF;');
    const repoId = (db.prepare('SELECT id FROM repos ORDER BY id LIMIT 1').get() as { id: number }).id;
    db
      .prepare(
        `INSERT INTO index_runs (repo_id, status, started_at, finished_at, extractor_version)
         VALUES (?, 'completed', datetime('now'), datetime('now'), 'legacy-test')`
      )
      .run(repoId);
    db.exec(`
      CREATE TABLE index_runs_legacy AS
        SELECT id, repo_id, status, started_at, finished_at, extractor_version
        FROM index_runs;
      DROP TABLE index_runs;
      CREATE TABLE index_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        extractor_version TEXT NOT NULL,
        FOREIGN KEY(repo_id) REFERENCES repos(id)
      );
      INSERT INTO index_runs (id, repo_id, status, started_at, finished_at, extractor_version)
        SELECT id, repo_id, status, started_at, finished_at, extractor_version
        FROM index_runs_legacy;
      DROP TABLE index_runs_legacy;
      DELETE FROM schema_versions WHERE version >= 7;
      DROP TABLE context_tool_runs;
      DROP TABLE context_resource_accesses;
      PRAGMA foreign_keys = ON;
    `);
  } finally {
    db.close();
  }

  const report = doctorProject({ repoRoot });

  assert.equal(report.database.schemaVersion, 6);
  assert.equal(report.index.latestCompletedRun?.status, 'completed');
  assert.equal(report.index.latestCompletedRun?.gitCommitSha, null);
  assert.equal(report.index.latestCompletedRun?.gitBranchName, null);
  assert.equal(report.index.latestCompletedRun?.gitIsDirty, null);
  assert.ok(findingCodes(report).includes('schema_outdated'));
});

test('doctorProject returns a diagnostic report for malformed required tables', async () => {
  const repoRoot = await makeRepo('impact-trace-doctor-malformed-');
  await initProject({ repoRoot });
  const db = new DatabaseSync(databasePath(repoRoot));
  try {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE repos;
      CREATE TABLE repos (
        id INTEGER PRIMARY KEY
      );
      INSERT INTO repos (id) VALUES (1);
      PRAGMA foreign_keys = ON;
    `);
  } finally {
    db.close();
  }

  const report = doctorProject({ repoRoot });

  assert.ok(findingCodes(report).includes('database_probe_failed'));
  assert.equal(report.database.error?.includes('no such column'), true);
});

test('doctorProject reports incomplete optional telemetry schema without throwing', async () => {
  const repoRoot = await makeRepo('impact-trace-doctor-malformed-telemetry-');
  await initProject({ repoRoot });
  const db = new DatabaseSync(databasePath(repoRoot));
  try {
    db.exec(`
      DROP TABLE context_tool_runs;
      CREATE TABLE context_tool_runs (
        id TEXT PRIMARY KEY NOT NULL
      );
    `);
  } finally {
    db.close();
  }

  const report = doctorProject({ repoRoot });

  assert.ok(findingCodes(report).includes('telemetry_schema_incomplete'));
  assert.equal(report.telemetry.toolRuns, null);
  assert.equal(report.database.error, null);
});

test('CLI doctor prints the doctor report as JSON', async () => {
  const repoRoot = await makeRepo('impact-trace-doctor-cli-');
  await initProject({ repoRoot });
  await indexProject({ repoRoot });

  const result = spawnSync(process.execPath, ['--import', tsxLoaderPath, path.resolve('src/cli.ts'), 'doctor'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as Awaited<ReturnType<typeof doctorProject>>;
  assert.equal(report.version, 0);
  assert.equal(report.database.schemaVersion, 11);
  assert.equal(report.index.latestCompletedRun?.status, 'completed');
});

test('CLI doctor returns non-zero when the database is missing', async () => {
  const repoRoot = await makeRepo('impact-trace-doctor-cli-missing-');

  const result = spawnSync(process.execPath, ['--import', tsxLoaderPath, path.resolve('src/cli.ts'), 'doctor'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout) as Awaited<ReturnType<typeof doctorProject>>;
  assert.ok(findingCodes(report).includes('database_missing'));
});
