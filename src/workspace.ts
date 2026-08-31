import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

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

export type DiscoverWorkspacePackagesOptions = {
  repoRoot: string;
  workspaceName?: string;
};

export type DiscoveredWorkspacePackage = {
  localPath: string;
  relativePath: string;
  manifestPath: string;
  serviceName: string;
};

export type DiscoverWorkspacePackagesResult = {
  catalogPath: string;
  workspace: WorkspaceSummary;
  sources: string[];
  packages: DiscoveredWorkspacePackage[];
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
  syncCatalog?: boolean;
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
const IGNORED_DISCOVERY_DIRS = new Set([
  '.git',
  DATA_DIR,
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.nx',
  '.turbo',
  '.yarn',
  '.pnpm-store'
]);

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

export function discoverWorkspacePackages(options: DiscoverWorkspacePackagesOptions): DiscoverWorkspacePackagesResult {
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

  const workspaceDefinitions = readWorkspacePackageDefinitions(repoRoot);
  const discovered = discoverWorkspacePackageMembers(repoRoot, workspaceDefinitions);
  if (discovered.length > 0) {
    const baseDir = path.dirname(catalogPath);
    const existingByPath = new Map<string, WorkspaceCatalogRepo>();
    for (const repo of catalog.repos) {
      existingByPath.set(resolveWorkspaceRepoPath(baseDir, repo.localPath), repo);
    }
    const outsideRepos = catalog.repos.filter((repo) => {
      const resolvedPath = resolveWorkspaceRepoPath(baseDir, repo.localPath);
      return !isInsidePath(repoRoot, resolvedPath);
    });
    const packageRepos = discovered.map((member) => {
      const existing = existingByPath.get(member.localPath);
      return {
        localPath: toPortableRelativePath(baseDir, member.localPath),
        serviceName: existing?.serviceName ?? member.serviceName,
        remoteUrl: existing?.remoteUrl ?? null,
        trustPolicy: normalizeTrustPolicy(existing?.trustPolicy)
      };
    });
    const repos = [...outsideRepos, ...packageRepos].sort((left, right) =>
      resolveWorkspaceRepoPath(baseDir, left.localPath)
        .localeCompare(resolveWorkspaceRepoPath(baseDir, right.localPath))
    );
    writeCatalog(catalogPath, { ...catalog, repos });
  }

  const synced = syncWorkspaceCatalog({ repoRoot, file: catalogPath });
  return {
    catalogPath,
    workspace: synced.workspace,
    sources: workspaceDefinitions.sources,
    packages: discovered
  };
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
  if (options.syncCatalog !== false && existsSync(workspaceCatalogPath(repoRoot))) {
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

type WorkspacePackageDefinitions = {
  sources: string[];
  patterns: string[];
  includeNxProjects: boolean;
};

type DiscoveredWorkspacePackageMember = DiscoveredWorkspacePackage;

function readWorkspacePackageDefinitions(repoRoot: string): WorkspacePackageDefinitions {
  const sources: string[] = [];
  const patterns: string[] = [];

  const packageJsonPath = path.join(repoRoot, 'package.json');
  if (existsSync(packageJsonPath)) {
    const packageJson = parseJsonObject(packageJsonPath, 'package.json');
    const npmPatterns = workspacePatternsFromPackageJson(packageJson.workspaces);
    if (npmPatterns.length > 0) {
      sources.push('package.json');
      patterns.push(...npmPatterns);
    }
  }

  const pnpmWorkspacePath = path.join(repoRoot, 'pnpm-workspace.yaml');
  if (existsSync(pnpmWorkspacePath)) {
    const parsed = parseYaml(readFileSync(pnpmWorkspacePath, 'utf8')) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('pnpm-workspace.yaml must be a YAML object');
    }
    if (parsed.packages !== undefined) {
      if (!Array.isArray(parsed.packages) || parsed.packages.some((item) => typeof item !== 'string')) {
        throw new Error('pnpm-workspace.yaml packages must be an array of strings');
      }
      sources.push('pnpm-workspace.yaml');
      patterns.push(...parsed.packages.map((item) => item.trim()).filter(Boolean));
    }
  }

  const nxJsonPath = path.join(repoRoot, 'nx.json');
  const includeNxProjects = existsSync(nxJsonPath);
  if (includeNxProjects) {
    parseJsonObject(nxJsonPath, 'nx.json');
    sources.push('nx.json');
  }

  return { sources, patterns, includeNxProjects };
}

function workspacePatternsFromPackageJson(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) {
    if (raw.some((item) => typeof item !== 'string')) {
      throw new Error('package.json workspaces must be an array of strings');
    }
    return raw.map((item) => item.trim()).filter(Boolean);
  }
  if (isRecord(raw) && raw.packages !== undefined) {
    if (!Array.isArray(raw.packages) || raw.packages.some((item) => typeof item !== 'string')) {
      throw new Error('package.json workspaces.packages must be an array of strings');
    }
    return raw.packages.map((item) => item.trim()).filter(Boolean);
  }
  throw new Error('package.json workspaces must be an array or an object with packages');
}

function discoverWorkspacePackageMembers(
  repoRoot: string,
  definitions: WorkspacePackageDefinitions
): DiscoveredWorkspacePackageMember[] {
  const members = new Map<string, DiscoveredWorkspacePackageMember>();
  for (const member of discoverPackageManifestMembers(repoRoot, definitions.patterns)) {
    members.set(member.localPath, member);
  }
  if (definitions.includeNxProjects) {
    for (const member of discoverNxProjectMembers(repoRoot)) {
      if (!members.has(member.localPath)) {
        members.set(member.localPath, member);
      }
    }
  }
  return [...members.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function discoverPackageManifestMembers(
  repoRoot: string,
  patterns: readonly string[]
): DiscoveredWorkspacePackageMember[] {
  if (patterns.length === 0) return [];
  const expandedPatterns = patterns.flatMap((pattern) => expandBracePatterns(pattern));
  const includePatterns = expandedPatterns.filter((pattern) => !pattern.startsWith('!'));
  const excludePatterns = expandedPatterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => pattern.slice(1));
  const candidates = scanPackageManifestDirs(repoRoot);
  const members = candidates
    .filter((candidate) => candidate.relativePath !== '.')
    .filter((candidate) => includePatterns.some((pattern) => workspaceGlobMatches(pattern, candidate.relativePath)))
    .filter((candidate) => !excludePatterns.some((pattern) => workspaceGlobMatches(pattern, candidate.relativePath)))
    .map((candidate) => {
      const manifest = parseJsonObject(candidate.manifestPath, candidate.relativeManifestPath);
      const packageName = typeof manifest.name === 'string' && manifest.name.trim() !== ''
        ? manifest.name.trim()
        : undefined;
      return {
        localPath: candidate.localPath,
        relativePath: candidate.relativePath,
        manifestPath: candidate.relativeManifestPath,
        serviceName: packageName ?? path.basename(candidate.localPath)
      };
    });
  members.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return members;
}

function discoverNxProjectMembers(repoRoot: string): DiscoveredWorkspacePackageMember[] {
  const candidates = scanNxProjectConfigDirs(repoRoot);
  const members = candidates
    .filter((candidate) => candidate.relativePath !== '.')
    .map((candidate) => {
      const manifest = parseJsonObject(candidate.manifestPath, candidate.relativeManifestPath);
      const configuredName = typeof manifest.name === 'string' && manifest.name.trim() !== ''
        ? manifest.name.trim()
        : undefined;
      return {
        localPath: candidate.localPath,
        relativePath: candidate.relativePath,
        manifestPath: candidate.relativeManifestPath,
        serviceName: configuredName ?? path.basename(candidate.localPath)
      };
    });
  members.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return members;
}

type PackageManifestCandidate = {
  localPath: string;
  relativePath: string;
  manifestPath: string;
  relativeManifestPath: string;
};

function scanPackageManifestDirs(repoRoot: string): PackageManifestCandidate[] {
  const candidates: PackageManifestCandidate[] = [];
  const visit = (dir: string): void => {
    const relativePath = toPortableRelativePath(repoRoot, dir);
    const manifestPath = path.join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      candidates.push({
        localPath: realpathSync(dir),
        relativePath,
        manifestPath,
        relativeManifestPath: relativePath === '.' ? 'package.json' : `${relativePath}/package.json`
      });
    }

    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (IGNORED_DISCOVERY_DIRS.has(entry.name)) continue;
      visit(path.join(dir, entry.name));
    }
  };
  visit(repoRoot);
  return candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function scanNxProjectConfigDirs(repoRoot: string): PackageManifestCandidate[] {
  const candidates: PackageManifestCandidate[] = [];
  const visit = (dir: string): void => {
    const relativePath = toPortableRelativePath(repoRoot, dir);
    const projectJsonPath = path.join(dir, 'project.json');
    if (existsSync(projectJsonPath)) {
      candidates.push({
        localPath: realpathSync(dir),
        relativePath,
        manifestPath: projectJsonPath,
        relativeManifestPath: relativePath === '.' ? 'project.json' : `${relativePath}/project.json`
      });
    } else {
      const packageJsonPath = path.join(dir, 'package.json');
      if (existsSync(packageJsonPath)) {
        let packageJson: Record<string, unknown> | undefined;
        try {
          packageJson = parseJsonObject(packageJsonPath, relativePath === '.' ? 'package.json' : `${relativePath}/package.json`);
        } catch {
          packageJson = undefined;
        }
        if (packageJson !== undefined && isRecord(packageJson.nx)) {
          candidates.push({
            localPath: realpathSync(dir),
            relativePath,
            manifestPath: packageJsonPath,
            relativeManifestPath: relativePath === '.' ? 'package.json' : `${relativePath}/package.json`
          });
        }
      }
    }

    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (IGNORED_DISCOVERY_DIRS.has(entry.name)) continue;
      visit(path.join(dir, entry.name));
    }
  };
  visit(repoRoot);
  return candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function parseJsonObject(filePath: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('must be a JSON object');
    }
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} parse failed: ${detail}`);
  }
}

function expandBracePatterns(pattern: string): string[] {
  const start = pattern.indexOf('{');
  const end = pattern.indexOf('}', start + 1);
  if (start < 0 || end < 0) return [pattern];
  const before = pattern.slice(0, start);
  const after = pattern.slice(end + 1);
  return pattern
    .slice(start + 1, end)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((item) => expandBracePatterns(`${before}${item}${after}`));
}

function workspaceGlobMatches(rawPattern: string, candidate: string): boolean {
  const pattern = normalizeWorkspacePattern(rawPattern);
  if (pattern === undefined) return false;
  const patternSegments = pattern === '.' ? [] : pattern.split('/');
  const candidateSegments = candidate === '.' ? [] : candidate.split('/');
  return matchGlobSegments(patternSegments, candidateSegments, 0, 0);
}

function normalizeWorkspacePattern(rawPattern: string): string | undefined {
  const pattern = rawPattern.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!pattern || pattern.includes('\0')) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pattern)) return undefined;
  if (path.posix.isAbsolute(pattern)) return undefined;
  const withoutDot = pattern.startsWith('./') ? pattern.slice(2) : pattern;
  if (withoutDot === '') return '.';
  return withoutDot.endsWith('/package.json')
    ? withoutDot.slice(0, -'/package.json'.length) || '.'
    : withoutDot;
}

function matchGlobSegments(
  patternSegments: readonly string[],
  candidateSegments: readonly string[],
  patternIndex: number,
  candidateIndex: number
): boolean {
  if (patternIndex === patternSegments.length) {
    return candidateIndex === candidateSegments.length;
  }
  const segment = patternSegments[patternIndex]!;
  if (segment === '**') {
    for (let nextIndex = candidateIndex; nextIndex <= candidateSegments.length; nextIndex++) {
      if (matchGlobSegments(patternSegments, candidateSegments, patternIndex + 1, nextIndex)) return true;
    }
    return false;
  }
  if (candidateIndex >= candidateSegments.length) return false;
  return segmentGlobMatches(segment, candidateSegments[candidateIndex]!)
    && matchGlobSegments(patternSegments, candidateSegments, patternIndex + 1, candidateIndex + 1);
}

function segmentGlobMatches(pattern: string, candidate: string): boolean {
  let regex = '^';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === '*') {
      regex += '[^/]*';
    } else if (char === '?') {
      regex += '[^/]';
    } else {
      regex += escapeRegExp(char);
    }
  }
  regex += '$';
  return new RegExp(regex).test(candidate);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
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

function isInsidePath(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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
