import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';

import { normalizeRepoRoot, resolveInsideRoot } from './security.js';
import { contentHash, ensureRepo, getRepoId, latestCompletedIndexRun, openDatabase } from './store.js';
import { listWorkspaces, type WorkspaceSummary } from './workspace.js';
import type { Confidence } from './types.js';

export type ResolveCrossRepoContractsOptions = {
  repoRoot: string;
  workspaceName?: string;
};

export type CrossRepoContractLink = {
  kind: 'CONSUMES_HTTP_ENDPOINT';
  confidence: Confidence;
  consumerService: string;
  consumerRepoPath: string;
  consumerPath: string;
  providerService: string;
  providerRepoPath: string;
  providerContractPath: string;
  providerEndpointId: string;
  httpMethod: string;
  routePath: string;
};

export type ResolveCrossRepoContractsResult = {
  workspace: WorkspaceSummary;
  links: CrossRepoContractLink[];
  warnings: string[];
};

type IndexedRepo = {
  repoPath: string;
  serviceName: string;
  db: ReturnType<typeof openDatabase>;
  repoId: number;
  indexRunId: number;
};

type ProviderEndpoint = {
  repoPath: string;
  serviceName: string;
  contractPath: string;
  endpointId: string;
  httpMethod: string;
  routePath: string;
};

type ConsumerMatch = {
  repoPath: string;
  serviceName: string;
  filePath: string;
  snippet: string;
};

type PersistableLink = CrossRepoContractLink & {
  evidenceSnippet: string;
};

type WorkspaceRow = {
  id: number;
  name: string;
};

type EndpointRow = {
  contract_path: string;
  endpoint_id: string;
  endpoint_display_name: string;
  content_hash: string;
};

type FileRow = {
  path: string;
  content_hash: string;
};

const RESOLVER_ID = 'cross-repo-contracts-v0';
const LINK_KIND = 'CONSUMES_HTTP_ENDPOINT';

export function resolveCrossRepoContracts(
  options: ResolveCrossRepoContractsOptions
): ResolveCrossRepoContractsResult {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const workspace = selectWorkspace(repoRoot, options.workspaceName);
  const warnings: string[] = [];
  const warnedFiles = new Set<string>();
  const indexedRepos = openIndexedWorkspaceRepos(workspace, warnings);
  try {
    const providerEndpoints = indexedRepos.flatMap((repo) => loadProviderEndpoints(repo, warnings, warnedFiles));
    const links = resolveLinks(providerEndpoints, indexedRepos, warnings, warnedFiles);
    persistCrossRepoLinks(repoRoot, workspace.name, links);
    return {
      workspace,
      links: links.map(({ evidenceSnippet: _evidenceSnippet, ...link }) => link),
      warnings
    };
  } finally {
    for (const repo of indexedRepos) {
      repo.db.close();
    }
  }
}

function selectWorkspace(repoRoot: string, workspaceName?: string): WorkspaceSummary {
  const listed = listWorkspaces({
    repoRoot,
    ...(workspaceName !== undefined ? { name: workspaceName } : {})
  });
  const workspace = listed.workspaces[0];
  if (!workspace) {
    throw new Error(workspaceName === undefined ? 'workspace catalog is empty' : `workspace not found: ${workspaceName}`);
  }
  return workspace;
}

function openIndexedWorkspaceRepos(workspace: WorkspaceSummary, warnings: string[]): IndexedRepo[] {
  const repos: IndexedRepo[] = [];
  for (const repo of workspace.repos) {
    let db: ReturnType<typeof openDatabase> | undefined;
    try {
      const repoPath = realpathSync(repo.localPath);
      db = openDatabase(repoPath, { readOnly: true });
      const repoId = getRepoId(db, repoPath);
      const indexRunId = latestCompletedIndexRun(db, repoId);
      repos.push({
        repoPath,
        serviceName: repo.serviceName,
        db,
        repoId,
        indexRunId
      });
      db = undefined;
    } catch (error) {
      db?.close();
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`workspace repo skipped: ${repo.localPath}: ${detail}`);
    }
  }
  return repos;
}

function loadProviderEndpoints(repo: IndexedRepo, warnings: string[], warnedFiles: Set<string>): ProviderEndpoint[] {
  const rows = repo.db
    .prepare(
      `SELECT
         source.path AS contract_path,
         target.id AS endpoint_id,
         target.display_name AS endpoint_display_name,
         files.content_hash AS content_hash
       FROM relations relation
       INNER JOIN entities source
          ON source.id = relation.source_entity_id
         AND source.repo_id = relation.repo_id
       INNER JOIN entities target
          ON target.id = relation.target_entity_id
         AND target.repo_id = relation.repo_id
       INNER JOIN files
          ON files.repo_id = relation.repo_id
         AND files.path = source.path
         AND files.index_run_id = relation.index_run_id
       WHERE relation.repo_id = ?
         AND relation.index_run_id = ?
         AND relation.kind = 'DECLARES'
         AND source.kind = 'contract'
         AND target.kind = 'endpoint'
         AND source.path IS NOT NULL
       ORDER BY source.path, target.display_name, target.id`
    )
    .all(repo.repoId, repo.indexRunId) as EndpointRow[];

  return rows.flatMap((row) => {
    const content = readFreshIndexedFile(repo, row.contract_path, row.content_hash, 'provider contract', warnings, warnedFiles);
    if (content === undefined) return [];
    const parsed = parseHttpEndpointDisplay(row.endpoint_display_name);
    if (!parsed) return [];
    return [{
      repoPath: repo.repoPath,
      serviceName: repo.serviceName,
      contractPath: row.contract_path,
      endpointId: row.endpoint_id,
      httpMethod: parsed.method,
      routePath: parsed.path
    }];
  });
}

function resolveLinks(
  providerEndpoints: ProviderEndpoint[],
  repos: IndexedRepo[],
  warnings: string[],
  warnedFiles: Set<string>
): PersistableLink[] {
  const links: PersistableLink[] = [];
  for (const endpoint of providerEndpoints) {
    for (const repo of repos) {
      if (repo.repoPath === endpoint.repoPath) continue;
      const matches = findConsumerMatches(repo, endpoint, warnings, warnedFiles);
      for (const match of matches) {
        links.push({
          kind: LINK_KIND,
          confidence: 'heuristic',
          consumerService: match.serviceName,
          consumerRepoPath: match.repoPath,
          consumerPath: match.filePath,
          providerService: endpoint.serviceName,
          providerRepoPath: endpoint.repoPath,
          providerContractPath: endpoint.contractPath,
          providerEndpointId: endpoint.endpointId,
          httpMethod: endpoint.httpMethod,
          routePath: endpoint.routePath,
          evidenceSnippet: match.snippet
        });
      }
    }
  }
  return dedupeLinks(links).sort(compareLinks);
}

function findConsumerMatches(
  repo: IndexedRepo,
  endpoint: ProviderEndpoint,
  warnings: string[],
  warnedFiles: Set<string>
): ConsumerMatch[] {
  const rows = repo.db
    .prepare(
      `SELECT path, content_hash
       FROM files
       WHERE repo_id = ? AND index_run_id = ?
       ORDER BY path`
    )
    .all(repo.repoId, repo.indexRunId) as FileRow[];
  const matches: ConsumerMatch[] = [];
  for (const row of rows) {
    const content = readFreshIndexedFile(repo, row.path, row.content_hash, 'consumer file', warnings, warnedFiles);
    if (content === undefined) continue;
    const line = firstMatchingLine(content, endpoint);
    if (!line) continue;
    matches.push({
      repoPath: repo.repoPath,
      serviceName: repo.serviceName,
      filePath: row.path,
      snippet: line
    });
  }
  return matches;
}

function readFreshIndexedFile(
  repo: IndexedRepo,
  filePath: string,
  indexedHash: string,
  label: 'consumer file' | 'provider contract',
  warnings: string[],
  warnedFiles: Set<string>
): string | undefined {
  const warningKey = `${label}\0${repo.repoPath}\0${filePath}`;
  let absolutePath: string;
  try {
    absolutePath = resolveInsideRoot(repo.repoPath, filePath);
  } catch (error) {
    warnOnce(warnings, warnedFiles, warningKey, `${label} skipped: ${repo.serviceName}:${filePath}: ${errorMessage(error)}`);
    return undefined;
  }

  let content: string;
  try {
    content = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    warnOnce(warnings, warnedFiles, warningKey, `${label} skipped: ${repo.serviceName}:${filePath}: ${errorMessage(error)}`);
    return undefined;
  }

  if (sha256(content) !== indexedHash) {
    warnOnce(
      warnings,
      warnedFiles,
      warningKey,
      `stale index: ${repo.serviceName}:${filePath} differs from latest completed index run ${repo.indexRunId}`
    );
    return undefined;
  }

  return content;
}

function firstMatchingLine(content: string, endpoint: ProviderEndpoint): string | undefined {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes(endpoint.routePath)) continue;
    if (!methodMatches(line, endpoint.httpMethod)) continue;
    return line.trim();
  }
  return undefined;
}

function methodMatches(line: string, method: string): boolean {
  if (method === 'GET' && !/\bmethod\s*[:=]/i.test(line)) return true;
  const methodPattern = new RegExp(`\\b${escapeRegExp(method)}\\b`, 'i');
  return methodPattern.test(line);
}

function parseHttpEndpointDisplay(displayName: string): { method: string; path: string } | undefined {
  const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(\S+)$/i.exec(displayName.trim());
  if (!match) return undefined;
  return { method: match[1]!.toUpperCase(), path: match[2]! };
}

function persistCrossRepoLinks(repoRoot: string, workspaceName: string, links: PersistableLink[]): void {
  const db = openDatabase(repoRoot);
  try {
    const workspace = db
      .prepare('SELECT id, name FROM workspaces WHERE name = ?')
      .get(workspaceName) as WorkspaceRow | undefined;
    if (!workspace) {
      throw new Error(`workspace not found after sync: ${workspaceName}`);
    }
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM cross_repo_links WHERE workspace_id = ? AND kind = ?')
        .run(workspace.id, LINK_KIND);
      const insert = db.prepare(
        `INSERT OR REPLACE INTO cross_repo_links (
           id, workspace_id, source_repo_id, target_repo_id, source_entity_id,
           target_entity_id, kind, confidence, provenance, index_run_id
         )
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`
      );
      for (const link of links) {
        const sourceRepoId = ensureRepo(db, link.consumerRepoPath);
        const targetRepoId = ensureRepo(db, link.providerRepoPath);
        insert.run(
          linkId(workspace.id, link),
          workspace.id,
          sourceRepoId,
          targetRepoId,
          link.kind,
          link.confidence,
          linkProvenance(link)
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

function linkProvenance(link: PersistableLink): string {
  return stableJson({
    schemaVersion: 1,
    resolver: RESOLVER_ID,
    consumer: {
      serviceName: link.consumerService,
      repoPath: link.consumerRepoPath,
      path: link.consumerPath
    },
    provider: {
      serviceName: link.providerService,
      repoPath: link.providerRepoPath,
      contractPath: link.providerContractPath,
      endpointId: link.providerEndpointId
    },
    http: {
      method: link.httpMethod,
      path: link.routePath
    },
    evidence: {
      filePath: link.consumerPath,
      snippet: link.evidenceSnippet
    }
  });
}

function linkId(workspaceId: number, link: CrossRepoContractLink): string {
  return contentHash(
    RESOLVER_ID,
    String(workspaceId),
    link.consumerRepoPath,
    link.consumerPath,
    link.providerRepoPath,
    link.providerEndpointId,
    link.httpMethod,
    link.routePath
  ).slice(0, 24);
}

function dedupeLinks(links: PersistableLink[]): PersistableLink[] {
  const byId = new Map<string, PersistableLink>();
  for (const link of links) {
    const key = [
      link.consumerRepoPath,
      link.consumerPath,
      link.providerRepoPath,
      link.providerEndpointId,
      link.httpMethod,
      link.routePath
    ].join('\0');
    if (!byId.has(key)) byId.set(key, link);
  }
  return [...byId.values()];
}

function compareLinks(left: CrossRepoContractLink, right: CrossRepoContractLink): number {
  return (
    left.consumerService.localeCompare(right.consumerService) ||
    left.consumerPath.localeCompare(right.consumerPath) ||
    left.providerService.localeCompare(right.providerService) ||
    left.providerContractPath.localeCompare(right.providerContractPath) ||
    left.httpMethod.localeCompare(right.httpMethod) ||
    left.routePath.localeCompare(right.routePath)
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (value === null || typeof value !== 'object') return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function warnOnce(warnings: string[], warnedFiles: Set<string>, key: string, warning: string): void {
  if (warnedFiles.has(key)) return;
  warnedFiles.add(key);
  warnings.push(warning);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
