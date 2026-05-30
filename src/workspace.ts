import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './branding.js';
import { normalizeRepoRoot } from './security.js';
import { ensureImpactDir, ensureRepo, impactDir, openDatabase } from './store.js';

export type WorkspaceTrustPolicy = {
  readOnly: boolean;
  [key: string]: unknown;
};

export type WorkspaceCatalogRepo = {
  localPath: string;
  serviceName?: string;
  remoteUrl?: string | null;
  trustPolicy?: WorkspaceTrustPolicy;
};

export type WorkspaceCatalog = {
  schemaVersion: 1;
  name: string;
  repos: WorkspaceCatalogRepo[];
};

export type WorkspaceRepoSummary = {
  localPath: string;
  serviceName: string;
  remoteUrl: string | null;
  trustPolicy: WorkspaceTrustPolicy;
};

export type WorkspaceSummary = {
  name: string;
  repos: WorkspaceRepoSummary[];
};

export type InitWorkspaceOptions = {
  repoRoot: string;
  name?: string;
  serviceName?: string;
  force?: boolean;
};

export type InitWorkspaceResult = {
  created: boolean;
  catalogPath: string;
  workspace: WorkspaceSummary;
};

export type AddWorkspaceRepoOptions = {
  repoRoot: string;
  workspaceName?: string;
  localPath: string;
  serviceName?: string;
  remoteUrl?: string | null;
  trustPolicy?: WorkspaceTrustPolicy;
};

export type SyncWorkspaceCatalogOptions = {
  repoRoot: string;
  file?: string;
};

export type SyncWorkspaceCatalogResult = {
  catalogPath: string;
  workspace: WorkspaceSummary;
};

export type ListWorkspacesOptions = {
  repoRoot: string;
  name?: string;
};

export type ListWorkspacesResult = {
  workspaces: WorkspaceSummary[];
};

type ResolvedCatalogRepo = {
  localPath: string;
  serviceName: string;
  remoteUrl: string | null;
  trustPolicy: WorkspaceTrustPolicy;
};

const WORKSPACE_SCHEMA_VERSION = 1;
const DEFAULT_TRUST_POLICY: WorkspaceTrustPolicy = { readOnly: true };

export function workspaceCatalogPath(repoRoot: string): string {
  return path.join(impactDir(normalizeRepoRoot(repoRoot)), 'workspace.json');
}

export function initWorkspace(options: InitWorkspaceOptions): InitWorkspaceResult {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const catalogPath = workspaceCatalogPath(repoRoot);
  ensureImpactDir(repoRoot);

  const created = !existsSync(catalogPath);
  if (created || options.force === true) {
    const catalog = makeInitialCatalog(repoRoot, catalogPath, options);
    writeCatalog(catalogPath, catalog);
  }

  const synced = syncWorkspaceCatalog({ repoRoot, file: catalogPath });
  return { created, catalogPath, workspace: synced.workspace };
}

export function addWorkspaceRepo(options: AddWorkspaceRepoOptions): SyncWorkspaceCatalogResult {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const catalogPath = workspaceCatalogPath(repoRoot);
  if (!existsSync(catalogPath)) {
    initWorkspace({
      repoRoot,
      ...(options.workspaceName !== undefined ? { name: options.workspaceName } : {})
    });
  }

  const catalog = loadWorkspaceCatalog({ repoRoot, file: catalogPath });
  if (options.workspaceName !== undefined && options.workspaceName !== catalog.name) {
    throw new Error(`workspace catalog is named '${catalog.name}', not '${options.workspaceName}'`);
  }

  const resolvedPath = resolveWorkspaceRepoPath(repoRoot, options.localPath);
  const catalogLocalPath = toPortableRelativePath(path.dirname(catalogPath), resolvedPath);
  const existing = catalog.repos.find((repo) =>
    resolveWorkspaceRepoPath(path.dirname(catalogPath), repo.localPath) === resolvedPath
  );
  const nextRepo: WorkspaceCatalogRepo = {
    localPath: catalogLocalPath,
    serviceName: options.serviceName ?? existing?.serviceName ?? path.basename(resolvedPath),
    remoteUrl: options.remoteUrl ?? existing?.remoteUrl ?? null,
    trustPolicy: normalizeTrustPolicy(options.trustPolicy ?? existing?.trustPolicy)
  };
  const repos = catalog.repos.filter((repo) =>
    resolveWorkspaceRepoPath(path.dirname(catalogPath), repo.localPath) !== resolvedPath
  );
  repos.push(nextRepo);
  repos.sort((left, right) =>
    resolveWorkspaceRepoPath(path.dirname(catalogPath), left.localPath)
      .localeCompare(resolveWorkspaceRepoPath(path.dirname(catalogPath), right.localPath))
  );

  writeCatalog(catalogPath, { ...catalog, repos });
  return syncWorkspaceCatalog({ repoRoot, file: catalogPath });
}

export function syncWorkspaceCatalog(options: SyncWorkspaceCatalogOptions): SyncWorkspaceCatalogResult {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const catalogPath = options.file === undefined
    ? workspaceCatalogPath(repoRoot)
    : resolveCatalogFile(repoRoot, options.file);
  const catalog = loadWorkspaceCatalog({ repoRoot, file: catalogPath });
  const resolvedRepos = resolveCatalogRepos(catalogPath, catalog);

  const db = openDatabase(repoRoot);
  try {
    db.exec('BEGIN');
    try {
      const workspaceId = upsertDefaultWorkspace(db, catalog.name, stableStringify(catalog));

      const keepPaths: string[] = [];
      for (const repo of resolvedRepos) {
        const repoId = ensureRepo(db, repo.localPath);
        keepPaths.push(repo.localPath);
        db.prepare(
          `INSERT INTO workspace_repos (
             workspace_id, repo_id, local_path, remote_url, service_name, trust_policy_json, created_at
           )
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(workspace_id, local_path) DO UPDATE SET
             repo_id = excluded.repo_id,
             remote_url = excluded.remote_url,
             service_name = excluded.service_name,
             trust_policy_json = excluded.trust_policy_json`
        ).run(
          workspaceId,
          repoId,
          repo.localPath,
          repo.remoteUrl,
          repo.serviceName,
          stableStringify(repo.trustPolicy)
        );
      }

      pruneWorkspaceRepos(db, workspaceId, keepPaths);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }

  return { catalogPath, workspace: readWorkspace(repoRoot, catalog.name) };
}

export function listWorkspaces(options: ListWorkspacesOptions): ListWorkspacesResult {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  if (existsSync(workspaceCatalogPath(repoRoot))) {
    syncWorkspaceCatalog({ repoRoot });
  }
  return listWorkspacesFromDatabase(repoRoot, options.name);
}

function listWorkspacesFromDatabase(repoRoot: string, name?: string): ListWorkspacesResult {
  const db = openDatabase(repoRoot, { readOnly: true });
  try {
    const workspaces = db
      .prepare(
        `SELECT id, name
         FROM workspaces
         ${name === undefined ? '' : 'WHERE name = ?'}
         ORDER BY name`
      )
      .all(...(name === undefined ? [] : [name])) as Array<{ id: number; name: string }>;

    return {
      workspaces: workspaces.map((workspace) => ({
        name: workspace.name,
        repos: readWorkspaceRepos(db, workspace.id)
      }))
    };
  } finally {
    db.close();
  }
}

export function loadWorkspaceCatalog(options: SyncWorkspaceCatalogOptions): WorkspaceCatalog {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const catalogPath = options.file === undefined
    ? workspaceCatalogPath(repoRoot)
    : resolveCatalogFile(repoRoot, options.file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(catalogPath, 'utf8')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`workspace catalog could not be read: ${detail}`);
  }
  return parseWorkspaceCatalog(raw);
}

function makeInitialCatalog(repoRoot: string, catalogPath: string, options: InitWorkspaceOptions): WorkspaceCatalog {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    name: options.name ?? path.basename(repoRoot),
    repos: [
      {
        localPath: toPortableRelativePath(path.dirname(catalogPath), repoRoot),
        serviceName: options.serviceName ?? path.basename(repoRoot),
        remoteUrl: null,
        trustPolicy: { ...DEFAULT_TRUST_POLICY }
      }
    ]
  };
}

function writeCatalog(catalogPath: string, catalog: WorkspaceCatalog): void {
  const dir = path.dirname(catalogPath);
  mkdirSync(dir, { recursive: true });
  assertCatalogIsRegularPath(catalogPath);
  const tempPath = path.join(dir, `.workspace.json.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tempPath, `${stableStringify(catalog, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    assertCatalogIsRegularPath(catalogPath);
    renameSync(tempPath, catalogPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function resolveCatalogFile(repoRoot: string, inputPath: string): string {
  if (!inputPath || inputPath.includes('\0')) {
    throw new Error('invalid workspace catalog path');
  }
  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(repoRoot, inputPath);
  if (candidate !== workspaceCatalogPath(repoRoot)) {
    throw new Error(`workspace catalog file must be ${DATA_DIR}/workspace.json`);
  }
  assertCatalogIsRegularPath(candidate);
  const resolved = realpathSync(candidate);
  const relative = path.relative(repoRoot, resolved);
  if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error('workspace catalog file must resolve inside repo root');
  }
  return resolved;
}

function assertCatalogIsRegularPath(catalogPath: string): void {
  if (!existsSync(catalogPath)) return;
  const stat = lstatSync(catalogPath);
  if (stat.isSymbolicLink()) {
    throw new Error('workspace catalog must not be a symlink');
  }
  if (!stat.isFile()) {
    throw new Error('workspace catalog path must be a regular file');
  }
}

function parseWorkspaceCatalog(raw: unknown): WorkspaceCatalog {
  if (!isRecord(raw)) {
    throw new Error('workspace catalog must be a JSON object');
  }
  if (raw.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    throw new Error(`workspace catalog schemaVersion must be ${WORKSPACE_SCHEMA_VERSION}`);
  }
  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    throw new Error('workspace catalog name must be a non-empty string');
  }
  if (!Array.isArray(raw.repos)) {
    throw new Error('workspace catalog repos must be an array');
  }
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    name: raw.name.trim(),
    repos: raw.repos.map((repo, index) => parseCatalogRepo(repo, index))
  };
}

function parseCatalogRepo(raw: unknown, index: number): WorkspaceCatalogRepo {
  if (!isRecord(raw)) {
    throw new Error(`workspace catalog repos[${index}] must be an object`);
  }
  if (typeof raw.localPath !== 'string') {
    throw new Error(`workspace catalog repos[${index}].localPath must be a string`);
  }
  const repo: WorkspaceCatalogRepo = { localPath: raw.localPath };
  if (raw.serviceName !== undefined) {
    if (typeof raw.serviceName !== 'string' || raw.serviceName.trim() === '') {
      throw new Error(`workspace catalog repos[${index}].serviceName must be a non-empty string`);
    }
    repo.serviceName = raw.serviceName.trim();
  }
  if (raw.remoteUrl !== undefined) {
    if (raw.remoteUrl !== null && typeof raw.remoteUrl !== 'string') {
      throw new Error(`workspace catalog repos[${index}].remoteUrl must be a string or null`);
    }
    repo.remoteUrl = raw.remoteUrl;
  }
  if (raw.trustPolicy !== undefined) {
    repo.trustPolicy = normalizeTrustPolicy(raw.trustPolicy);
  }
  return repo;
}

function resolveCatalogRepos(catalogPath: string, catalog: WorkspaceCatalog): ResolvedCatalogRepo[] {
  const baseDir = path.dirname(catalogPath);
  const seen = new Set<string>();
  return catalog.repos.map((repo, index) => {
    const localPath = resolveWorkspaceRepoPath(baseDir, repo.localPath);
    if (seen.has(localPath)) {
      throw new Error(`duplicate resolved local path in workspace catalog: ${repo.localPath}`);
    }
    seen.add(localPath);
    return {
      localPath,
      serviceName: repo.serviceName ?? (path.basename(localPath) || `repo-${index + 1}`),
      remoteUrl: repo.remoteUrl ?? null,
      trustPolicy: normalizeTrustPolicy(repo.trustPolicy)
    };
  });
}

function resolveWorkspaceRepoPath(baseDir: string, inputPath: string): string {
  if (!inputPath || inputPath.includes('\0')) {
    throw new Error('invalid workspace repo localPath');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(inputPath)) {
    throw new Error('workspace repo localPath must not be URL-like; use a local filesystem path');
  }
  if (/^[^@\s]+@[^:\s]+:.+/.test(inputPath)) {
    throw new Error('workspace repo localPath must not be git-style; use a local filesystem path');
  }

  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(baseDir, inputPath);
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    throw new Error(`workspace repo path does not exist or is not accessible: ${inputPath}`);
  }
  if (!lstatSync(resolved).isDirectory()) {
    throw new Error(`workspace repo path is not a directory: ${inputPath}`);
  }
  return resolved;
}

function normalizeTrustPolicy(raw: unknown): WorkspaceTrustPolicy {
  if (raw === undefined) return { ...DEFAULT_TRUST_POLICY };
  if (!isRecord(raw)) {
    throw new Error('workspace repo trustPolicy must be an object');
  }
  return { ...sortRecord(raw), readOnly: raw.readOnly === false ? false : true } as WorkspaceTrustPolicy;
}

function readWorkspace(repoRoot: string, name: string): WorkspaceSummary {
  const listed = listWorkspacesFromDatabase(repoRoot, name);
  const workspace = listed.workspaces[0];
  if (!workspace) {
    throw new Error(`workspace not found after sync: ${name}`);
  }
  return workspace;
}

function readWorkspaceRepos(db: ReturnType<typeof openDatabase>, workspaceId: number): WorkspaceRepoSummary[] {
  const rows = db
    .prepare(
      `SELECT local_path, service_name, remote_url, trust_policy_json
       FROM workspace_repos
       WHERE workspace_id = ?
       ORDER BY local_path`
    )
    .all(workspaceId) as Array<{
      local_path: string;
      service_name: string | null;
      remote_url: string | null;
      trust_policy_json: string;
    }>;
  return rows.map((row) => ({
    localPath: row.local_path,
    serviceName: row.service_name ?? path.basename(row.local_path),
    remoteUrl: row.remote_url,
    trustPolicy: parseTrustPolicy(row.trust_policy_json)
  }));
}

function parseTrustPolicy(raw: string): WorkspaceTrustPolicy {
  try {
    return normalizeTrustPolicy(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_TRUST_POLICY };
  }
}

function getWorkspaceId(db: ReturnType<typeof openDatabase>, name: string): number {
  const row = db.prepare('SELECT id FROM workspaces WHERE name = ?').get(name) as { id: number } | undefined;
  if (!row) {
    throw new Error(`workspace not found: ${name}`);
  }
  return row.id;
}

function upsertDefaultWorkspace(db: ReturnType<typeof openDatabase>, name: string, configJson: string): number {
  const existingRows = db
    .prepare('SELECT id, name FROM workspaces ORDER BY id')
    .all() as Array<{ id: number; name: string }>;
  const named = existingRows.find((row) => row.name === name);
  let workspaceId: number;

  if (named) {
    workspaceId = named.id;
    db.prepare('UPDATE workspaces SET config_json = ? WHERE id = ?').run(configJson, workspaceId);
  } else if (existingRows.length === 1) {
    workspaceId = existingRows[0]!.id;
    db.prepare('UPDATE workspaces SET name = ?, config_json = ? WHERE id = ?').run(name, configJson, workspaceId);
  } else {
    db.prepare(
      `INSERT INTO workspaces (name, config_json, created_at)
       VALUES (?, ?, datetime('now'))`
    ).run(name, configJson);
    workspaceId = getWorkspaceId(db, name);
  }

  db.prepare('DELETE FROM workspace_repos WHERE workspace_id <> ?').run(workspaceId);
  db.prepare('DELETE FROM workspaces WHERE id <> ?').run(workspaceId);
  return workspaceId;
}

function pruneWorkspaceRepos(db: ReturnType<typeof openDatabase>, workspaceId: number, keepPaths: string[]): void {
  if (keepPaths.length === 0) {
    db.prepare('DELETE FROM workspace_repos WHERE workspace_id = ?').run(workspaceId);
    return;
  }
  const placeholders = keepPaths.map(() => '?').join(', ');
  db.prepare(
    `DELETE FROM workspace_repos
     WHERE workspace_id = ? AND local_path NOT IN (${placeholders})`
  ).run(workspaceId, ...keepPaths);
}

function toPortableRelativePath(fromDir: string, targetPath: string): string {
  const relative = path.relative(fromDir, targetPath);
  return (relative === '' ? '.' : relative).split(path.sep).join('/');
}

function stableStringify(value: unknown, space?: number): string {
  return JSON.stringify(sortJson(value), null, space);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJson(value[key]);
  }
  return sorted;
}

function sortRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = value[key];
  }
  return sorted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
