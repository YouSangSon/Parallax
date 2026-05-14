import { existsSync } from 'node:fs';

import { normalizeRepoRoot } from './security.js';
import {
  CURRENT_SCHEMA_VERSION,
  databasePath,
  isVectorExtensionLoaded,
  openDatabase,
  vecTableName
} from './store.js';
import type { Db } from './store.js';

export const REQUIRED_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

export type DoctorOptions = {
  repoRoot: string;
};

export type DoctorFindingSeverity = 'info' | 'warn' | 'error';

export type DoctorFinding = {
  severity: DoctorFindingSeverity;
  code: string;
  message: string;
  fix?: string;
};

export type DoctorTableState = {
  schemaVersions: boolean;
  repos: boolean;
  indexRuns: boolean;
  adapterRuns: boolean;
  indexCoverage: boolean;
  factEmbeddings: boolean;
  contextToolRuns: boolean;
  contextResourceAccesses: boolean;
  contextPacks: boolean;
};

export type DoctorIndexRun = {
  id: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  extractorVersion: string | null;
  gitCommitSha: string | null;
  gitBranchName: string | null;
  gitIsDirty: boolean | null;
};

type IndexRunColumnState = {
  gitCommitSha: boolean;
  gitBranchName: boolean;
  gitIsDirty: boolean;
};

export type DoctorCoverage = {
  totalRows: number;
  indexedPaths: number;
  skippedPaths: number;
  unsupportedLanguageIds: string[];
};

export type DoctorAdapterRun = {
  adapterId: string;
  status: string;
  count: number;
};

export type DoctorReport = {
  version: 0;
  generatedAt: string;
  repoRoot: string;
  database: {
    path: string;
    exists: boolean;
    schemaVersion: number | null;
    requiredSchemaVersion: number;
    tables: DoctorTableState;
    telemetryTables: boolean;
    error: string | null;
  };
  index: {
    latestRun: DoctorIndexRun | null;
    latestCompletedRun: DoctorIndexRun | null;
    coverage: DoctorCoverage | null;
    adapterRuns: DoctorAdapterRun[];
  };
  vector: {
    sqliteVecLoaded: boolean | null;
    vecTables: string[];
    factEmbeddingRows: number | null;
    models: Array<{ model: string; rows: number; dim: number }>;
  };
  telemetry: {
    toolRuns: number | null;
    resourceAccesses: number | null;
    latestToolRunAt: string | null;
    latestResourceAccessAt: string | null;
  };
  findings: DoctorFinding[];
};

export function doctorProject(options: DoctorOptions): DoctorReport {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const dbPath = databasePath(repoRoot);
  const report = baseReport(repoRoot, dbPath, existsSync(dbPath));

  if (!report.database.exists) {
    report.findings.push({
      severity: 'error',
      code: 'database_missing',
      message: 'Impact Trace database is missing.',
      fix: 'Run impact-trace init and impact-trace index from the repository root.'
    });
    return report;
  }

  let db: Db;
  try {
    db = openDatabase(repoRoot, { readOnly: true });
  } catch (error) {
    report.database.error = error instanceof Error ? error.message : String(error);
    report.findings.push({
      severity: 'error',
      code: 'database_unreadable',
      message: 'Impact Trace database exists but could not be opened read-only.',
      fix: 'Check that .impact-trace/impact.db is inside this repo and rerun impact-trace init.'
    });
    return report;
  }

  try {
    report.database.tables = readTableState(db);
    report.database.telemetryTables =
      report.database.tables.contextToolRuns && report.database.tables.contextResourceAccesses;
    report.database.schemaVersion = readSchemaVersion(db, report.database.tables);
    report.vector.sqliteVecLoaded = isVectorExtensionLoaded(db);
    report.vector.vecTables = readVecTables(db);

    if (report.database.tables.factEmbeddings) {
      report.vector.factEmbeddingRows = readCount(db, 'SELECT count(*) AS count FROM fact_embeddings');
      report.vector.models = readEmbeddingModels(db);
    }

    addSchemaFindings(report);

    if (!report.database.tables.repos || !report.database.tables.indexRuns) {
      report.findings.push({
        severity: 'error',
        code: 'index_tables_missing',
        message: 'Required index tables are missing from the database.',
        fix: 'Back up .impact-trace, then rerun impact-trace init.'
      });
      return report;
    }

    const repoId = readRepoId(db, repoRoot);
    if (repoId === null) {
      report.findings.push({
        severity: 'warn',
        code: 'repo_missing',
        message: 'The database has no row for this repository root.',
        fix: 'Run impact-trace init from this repository root.'
      });
      return report;
    }

    const indexRunColumns = readIndexRunColumnState(db);
    report.index.latestRun = readLatestIndexRun(db, repoId, false, indexRunColumns);
    report.index.latestCompletedRun = readLatestIndexRun(db, repoId, true, indexRunColumns);
    addIndexFindings(report);

    if (report.index.latestCompletedRun && report.database.tables.indexCoverage) {
      report.index.coverage = readCoverage(db, report.index.latestCompletedRun.id);
      addCoverageFindings(report);
    }
    if (report.index.latestCompletedRun && report.database.tables.adapterRuns) {
      report.index.adapterRuns = readAdapterRuns(db, report.index.latestCompletedRun.id);
    }
    if (report.database.telemetryTables) {
      if (canReadTelemetry(db)) {
        report.telemetry = readTelemetry(db);
      } else {
        report.findings.push({
          severity: 'warn',
          code: 'telemetry_schema_incomplete',
          message: 'Context telemetry tables exist but do not have the expected columns.',
          fix: 'Run impact-trace init with the current build.'
        });
      }
    }
  } catch (error) {
    report.database.error = error instanceof Error ? error.message : String(error);
    report.findings.push({
      severity: 'error',
      code: 'database_probe_failed',
      message: 'Impact Trace database opened read-only but health probing failed.',
      fix: 'Back up .impact-trace, then run impact-trace init with the current build or recreate the index.'
    });
  } finally {
    db.close();
  }

  return report;
}

function baseReport(repoRoot: string, dbPath: string, exists: boolean): DoctorReport {
  return {
    version: 0,
    generatedAt: new Date().toISOString(),
    repoRoot,
    database: {
      path: dbPath,
      exists,
      schemaVersion: null,
      requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,
      tables: emptyTableState(),
      telemetryTables: false,
      error: null
    },
    index: {
      latestRun: null,
      latestCompletedRun: null,
      coverage: null,
      adapterRuns: []
    },
    vector: {
      sqliteVecLoaded: null,
      vecTables: [],
      factEmbeddingRows: null,
      models: []
    },
    telemetry: {
      toolRuns: null,
      resourceAccesses: null,
      latestToolRunAt: null,
      latestResourceAccessAt: null
    },
    findings: []
  };
}

function emptyTableState(): DoctorTableState {
  return {
    schemaVersions: false,
    repos: false,
    indexRuns: false,
    adapterRuns: false,
    indexCoverage: false,
    factEmbeddings: false,
    contextToolRuns: false,
    contextResourceAccesses: false,
    contextPacks: false
  };
}

function readTableState(db: Db): DoctorTableState {
  return {
    schemaVersions: tableExists(db, 'schema_versions'),
    repos: tableExists(db, 'repos'),
    indexRuns: tableExists(db, 'index_runs'),
    adapterRuns: tableExists(db, 'adapter_runs'),
    indexCoverage: tableExists(db, 'index_coverage'),
    factEmbeddings: tableExists(db, 'fact_embeddings'),
    contextToolRuns: tableExists(db, 'context_tool_runs'),
    contextResourceAccesses: tableExists(db, 'context_resource_accesses'),
    contextPacks: tableExists(db, 'context_packs')
  };
}

function tableExists(db: Db, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { one: number } | undefined;
  return row !== undefined;
}

function tableColumns(db: Db, tableName: string): Set<string> {
  const rows = db.prepare('SELECT name FROM pragma_table_info(?)').all(tableName) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function hasColumns(db: Db, tableName: string, columns: string[]): boolean {
  const available = tableColumns(db, tableName);
  return columns.every((column) => available.has(column));
}

function readSchemaVersion(db: Db, tables: DoctorTableState): number | null {
  if (!tables.schemaVersions) return null;
  const row = db.prepare('SELECT max(version) AS version FROM schema_versions').get() as { version: number | null };
  return row.version;
}

function addSchemaFindings(report: DoctorReport): void {
  if (report.database.schemaVersion === null) {
    report.findings.push({
      severity: 'error',
      code: 'schema_missing',
      message: 'Database schema version table is missing or empty.',
      fix: 'Back up .impact-trace, then rerun impact-trace init.'
    });
    return;
  }
  if (report.database.schemaVersion < REQUIRED_SCHEMA_VERSION) {
    report.findings.push({
      severity: 'error',
      code: 'schema_outdated',
      message: `Database schema is v${report.database.schemaVersion}; this build expects v${REQUIRED_SCHEMA_VERSION}.`,
      fix: 'Run impact-trace init with the current build to apply additive migrations.'
    });
  }
  if (!report.database.telemetryTables) {
    report.findings.push({
      severity: report.database.schemaVersion >= REQUIRED_SCHEMA_VERSION ? 'error' : 'warn',
      code: 'telemetry_tables_missing',
      message: 'Context telemetry tables are not available.',
      fix: 'Run impact-trace init with the current build.'
    });
  }
}

function readRepoId(db: Db, repoRoot: string): number | null {
  const row = db.prepare('SELECT id FROM repos WHERE root = ?').get(repoRoot) as { id: number } | undefined;
  return row?.id ?? null;
}

function readIndexRunColumnState(db: Db): IndexRunColumnState {
  const columns = tableColumns(db, 'index_runs');
  return {
    gitCommitSha: columns.has('git_commit_sha'),
    gitBranchName: columns.has('git_branch_name'),
    gitIsDirty: columns.has('git_is_dirty')
  };
}

function readLatestIndexRun(
  db: Db,
  repoId: number,
  completedOnly: boolean,
  columns: IndexRunColumnState
): DoctorIndexRun | null {
  const statusClause = completedOnly ? 'AND status = ?' : '';
  const params = completedOnly ? [repoId, 'completed'] : [repoId];
  const gitCommitShaSelect = columns.gitCommitSha ? 'git_commit_sha AS gitCommitSha' : 'NULL AS gitCommitSha';
  const gitBranchNameSelect = columns.gitBranchName ? 'git_branch_name AS gitBranchName' : 'NULL AS gitBranchName';
  const gitIsDirtySelect = columns.gitIsDirty ? 'git_is_dirty AS gitIsDirty' : 'NULL AS gitIsDirty';
  const row = db
    .prepare(
      `SELECT id, status, started_at AS startedAt, finished_at AS finishedAt,
              extractor_version AS extractorVersion, ${gitCommitShaSelect},
              ${gitBranchNameSelect}, ${gitIsDirtySelect}
         FROM index_runs
        WHERE repo_id = ? ${statusClause}
        ORDER BY id DESC
        LIMIT 1`
    )
    .get(...params) as
    | {
        id: number;
        status: string;
        startedAt: string;
        finishedAt: string | null;
        extractorVersion: string | null;
        gitCommitSha: string | null;
        gitBranchName: string | null;
        gitIsDirty: number | null;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    extractorVersion: row.extractorVersion,
    gitCommitSha: row.gitCommitSha,
    gitBranchName: row.gitBranchName,
    gitIsDirty: row.gitIsDirty === null ? null : row.gitIsDirty === 1
  };
}

function addIndexFindings(report: DoctorReport): void {
  if (!report.index.latestCompletedRun) {
    report.findings.push({
      severity: 'warn',
      code: 'index_missing',
      message: 'No completed index run exists for this repository.',
      fix: 'Run impact-trace index before asking agents for impact context.'
    });
  }
  if (report.index.latestRun && report.index.latestRun.status !== 'completed') {
    report.findings.push({
      severity: report.index.latestRun.status === 'failed' ? 'error' : 'warn',
      code: 'latest_index_not_completed',
      message: `Latest index run ${report.index.latestRun.id} ended with status '${report.index.latestRun.status}'.`,
      fix: 'Inspect adapter diagnostics and rerun impact-trace index.'
    });
  }
  if (report.index.latestCompletedRun?.gitIsDirty) {
    report.findings.push({
      severity: 'warn',
      code: 'index_created_from_dirty_tree',
      message: 'Latest completed index was created while the git working tree was dirty.',
      fix: 'Re-run impact-trace index after committing or stashing unrelated changes.'
    });
  }
}

function readCoverage(db: Db, indexRunId: number): DoctorCoverage {
  const counts = db
    .prepare(
      `SELECT count(*) AS totalRows,
              sum(CASE WHEN status = 'indexed' THEN 1 ELSE 0 END) AS indexedPaths,
              sum(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skippedPaths
         FROM index_coverage
        WHERE index_run_id = ?`
    )
    .get(indexRunId) as { totalRows: number; indexedPaths: number | null; skippedPaths: number | null };
  const unsupportedLanguageIds = db
    .prepare(
      `SELECT DISTINCT language_id AS languageId
         FROM index_coverage
        WHERE index_run_id = ? AND status = 'skipped' AND language_id IS NOT NULL
        ORDER BY language_id`
    )
    .all(indexRunId) as Array<{ languageId: string }>;
  return {
    totalRows: counts.totalRows,
    indexedPaths: counts.indexedPaths ?? 0,
    skippedPaths: counts.skippedPaths ?? 0,
    unsupportedLanguageIds: unsupportedLanguageIds.map((row) => row.languageId)
  };
}

function addCoverageFindings(report: DoctorReport): void {
  const skippedPaths = report.index.coverage?.skippedPaths ?? 0;
  if (skippedPaths > 0) {
    report.findings.push({
      severity: 'warn',
      code: 'coverage_skipped_paths',
      message: `${skippedPaths} path(s) were skipped by the latest completed index.`,
      fix: 'Inspect impact-trace://coverage/latest or rerun index with a higher --max-file-bytes limit if appropriate.'
    });
  }
}

function readAdapterRuns(db: Db, indexRunId: number): DoctorAdapterRun[] {
  return db
    .prepare(
      `SELECT adapter_id AS adapterId, status, count(*) AS count
         FROM adapter_runs
        WHERE index_run_id = ?
        GROUP BY adapter_id, status
        ORDER BY adapter_id, status`
    )
    .all(indexRunId) as DoctorAdapterRun[];
}

function readVecTables(db: Db): string[] {
  return db
    .prepare(
      `SELECT name
         FROM sqlite_master
        WHERE name GLOB ? AND sql LIKE '%USING vec0%'
        ORDER BY name`
    )
    .all(`${vecTableName('')}*`)
    .map((row) => (row as { name: string }).name);
}

function readCount(db: Db, sql: string): number {
  const row = db.prepare(sql).get() as { count: number };
  return row.count;
}

function readEmbeddingModels(db: Db): Array<{ model: string; rows: number; dim: number }> {
  return db
    .prepare(
      `SELECT model, count(*) AS rows, max(dim) AS dim
         FROM fact_embeddings
        GROUP BY model
        ORDER BY rows DESC, model`
    )
    .all() as Array<{ model: string; rows: number; dim: number }>;
}

function readTelemetry(db: Db): DoctorReport['telemetry'] {
  const toolRows = db
    .prepare('SELECT count(*) AS count, max(finished_at) AS latestAt FROM context_tool_runs')
    .get() as { count: number; latestAt: string | null };
  const resourceRows = db
    .prepare('SELECT count(*) AS count, max(accessed_at) AS latestAt FROM context_resource_accesses')
    .get() as { count: number; latestAt: string | null };
  return {
    toolRuns: toolRows.count,
    resourceAccesses: resourceRows.count,
    latestToolRunAt: toolRows.latestAt,
    latestResourceAccessAt: resourceRows.latestAt
  };
}

function canReadTelemetry(db: Db): boolean {
  return hasColumns(db, 'context_tool_runs', ['finished_at']) &&
    hasColumns(db, 'context_resource_accesses', ['accessed_at']);
}

export function hasDoctorErrors(report: DoctorReport): boolean {
  return report.findings.some((finding) => finding.severity === 'error');
}

export function redactDoctorReportForMcp(report: DoctorReport): DoctorReport {
  return {
    ...report,
    repoRoot: '[REPO_ROOT]',
    database: {
      ...report.database,
      path: '.impact-trace/impact.db'
    }
  };
}
