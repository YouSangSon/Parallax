// UI data-access layer: SQLite readers and row->preview converters that build
// the UI preview objects consumed by ui.ts (buildUiSnapshot / uiApiResponse).
// Functions here depend only on Node, the store/graph/work-artifact modules,
// ./shared.js, and ui.ts types (type-only import — erased at compile time, so
// there is no runtime import cycle with ui.ts). Moved verbatim from ui.ts.

import type { MarkdownArtifactMetadata } from '../artifacts.js';
import { exportImpactGraph } from '../graph.js';
import {
  workArtifactEvidenceResourceUri,
  workArtifactPathSet,
  workArtifactsFromImpactReport
} from '../work_artifacts.js';
import { getRepoId, latestCompletedIndexRun, openDatabase } from '../store.js';
import type { ImpactReport } from '../types.js';
import type {
  ReportRow,
  UiContextPackSummary,
  UiCoverageSnapshot,
  UiEvidencePreview,
  UiGraphPreview,
  UiReportPreview,
  UiReportSummary,
  UiWorkArtifactImpact,
  UiWorkspaceContract,
  UiWorkspaceLink,
  UiWorkspaceSnapshot
} from '../ui.js';
import { errorMessage, objectAt, stringAt } from './shared.js';

type ContextPackRow = {
  id: string;
  budget: string;
  index_run_id: number;
  returned_bytes: number;
  hit_count: number;
  created_at: string;
  last_accessed_at: string;
};

type WorkspaceRow = {
  id: number;
  name: string;
};

type WorkspaceRepoRow = {
  local_path: string;
  service_name: string | null;
};

type WorkspaceContractRow = {
  id: string;
  kind: string;
  service_name: string | null;
  path: string | null;
  schema_version: string | null;
  endpoint_count: number;
};

type WorkspaceLinkRow = {
  id: string;
  kind: string;
  confidence: string;
  provenance: string;
  source_path: string;
  source_service: string | null;
  target_path: string;
  target_service: string | null;
};

export function reportSummaryFromRow(row: ReportRow): UiReportSummary {
  const report = JSON.parse(row.json) as ImpactReport;
  return {
    id: row.id,
    indexRunId: row.index_run_id,
    createdAt: row.created_at,
    changedFiles: report.changedFiles,
    changedCount: report.changed.length,
    affectedCount: report.affectedFiles.length,
    evidenceCount: report.evidence.length,
    actionCount: report.actions.length
  };
}

export function reportPreviewFromRow(row: ReportRow): UiReportPreview {
  const report = JSON.parse(row.json) as ImpactReport;
  return {
    ...reportSummaryFromRow(row),
    changed: report.changed,
    affectedFiles: report.affectedFiles,
    evidence: evidencePreviewFromReport(report),
    adapterInsights: report.adapterInsights ?? [],
    actions: report.actions,
    warnings: report.warnings ?? []
  };
}

const omittedWorkArtifactEvidenceSnippet = 'Work artifact evidence omitted from UI bootstrap. Open the entity resource for document details.';

export function evidencePreviewFromReport(report: ImpactReport): UiEvidencePreview[] {
  const workArtifactPaths = workArtifactPathSet(report);
  return report.evidence.map((item) => {
    const resourceUri = workArtifactEvidenceResourceUri(item, workArtifactPaths);
    if (!resourceUri) return item;
    return {
      ...item,
      snippet: omittedWorkArtifactEvidenceSnippet,
      snippetOmitted: true,
      omittedReason: 'work-artifact-resource-on-demand',
      resourceUri
    };
  });
}

export function workArtifactsFromReportRow(row: ReportRow): UiWorkArtifactImpact[] {
  const report = JSON.parse(row.json) as ImpactReport;
  return workArtifactsFromImpactReport(report, { asOfIso: row.created_at, includeDepth: true });
}

export function workArtifactMetadataText(metadata: MarkdownArtifactMetadata | undefined): string {
  if (!metadata) return '';
  return [
    metadata.owner ? `owner ${metadata.owner}` : undefined,
    metadata.status ? `status ${metadata.status}` : undefined,
    metadata.updatedAt ? `updated ${metadata.updatedAt}` : undefined
  ].filter((item): item is string => Boolean(item)).join(' · ');
}

export async function graphPreview(repoRoot: string, reportId: string): Promise<UiGraphPreview | null> {
  try {
    const graph = await exportImpactGraph({ repoRoot, reportId, format: 'json' });
    return {
      nodes: graph.nodes.slice(0, 80),
      edges: graph.edges.slice(0, 80),
      totalNodes: graph.nodes.length,
      totalEdges: graph.edges.length
    };
  } catch {
    return null;
  }
}

export function readContextPacks(db: ReturnType<typeof openDatabase>, repoId: number): UiContextPackSummary[] {
  if (!tableExists(db, 'context_packs')) return [];
  const rows = db
    .prepare(`
      SELECT id, budget, index_run_id, returned_bytes, hit_count, created_at, last_accessed_at
      FROM context_packs
      WHERE repo_id = ?
      ORDER BY last_accessed_at DESC, created_at DESC
      LIMIT 20
    `)
    .all(repoId) as ContextPackRow[];
  return rows.map((row) => ({
    id: row.id,
    budget: row.budget,
    indexRunId: row.index_run_id,
    returnedBytes: row.returned_bytes,
    hitCount: row.hit_count,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at
  }));
}

export function readReport(repoRoot: string, reportId: string): unknown {
  const db = openDatabase(repoRoot, { readOnly: true });
  try {
    const repoId = getRepoId(db, repoRoot);
    const row = db
      .prepare('SELECT json FROM reports WHERE repo_id = ? AND id = ?')
      .get(repoId, reportId) as { json: string } | undefined;
    if (!row) return { error: { code: 'report_not_found', message: `Impact report not found: ${reportId}` } };
    return JSON.parse(row.json) as unknown;
  } finally {
    db.close();
  }
}

export function readContextPack(repoRoot: string, contextPackId: string): unknown {
  const db = openDatabase(repoRoot, { readOnly: true });
  try {
    const repoId = getRepoId(db, repoRoot);
    const row = tableExists(db, 'context_packs')
      ? db
          .prepare('SELECT pack_json FROM context_packs WHERE repo_id = ? AND id = ?')
          .get(repoId, contextPackId) as { pack_json: string } | undefined
      : undefined;
    if (!row) return { error: { code: 'context_pack_not_found', message: `Context pack not found: ${contextPackId}` } };
    return JSON.parse(row.pack_json) as unknown;
  } finally {
    db.close();
  }
}

export function readLatestCoverage(db: ReturnType<typeof openDatabase>, repoId: number): UiCoverageSnapshot | null {
  const run = db
    .prepare("SELECT id FROM index_runs WHERE repo_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1")
    .get(repoId) as { id: number } | undefined;
  if (!run || !tableExists(db, 'index_coverage')) return null;
  const limit = 80;
  const rows = db
    .prepare(`
      SELECT path, language_id, status, reason, adapter_id
      FROM index_coverage
      WHERE index_run_id = ?
      ORDER BY status DESC, path
      LIMIT ?
    `)
    .all(run.id, limit + 1) as Array<{
      path: string;
      language_id: string | null;
      status: string;
      reason: string;
      adapter_id: string;
    }>;
  return {
    indexRunId: run.id,
    coverage: rows.slice(0, limit).map((row) => ({
      path: row.path,
      languageId: row.language_id,
      status: row.status,
      reason: row.reason,
      adapterId: row.adapter_id
    })),
    limit,
    truncated: rows.length > limit
  };
}

export function readWorkspace(repoRoot: string, workspaceName: string): unknown {
  const db = openDatabase(repoRoot, { readOnly: true });
  try {
    const workspace = readWorkspaceSnapshots(db).find((item) => item.name === workspaceName);
    if (!workspace) {
      return { error: { code: 'workspace_not_found', message: `Workspace not found: ${workspaceName}` } };
    }
    return workspace;
  } finally {
    db.close();
  }
}

export function readWorkspaceSnapshots(db: ReturnType<typeof openDatabase>): UiWorkspaceSnapshot[] {
  if (!tableExists(db, 'workspaces') || !tableExists(db, 'workspace_repos')) return [];
  const rows = db
    .prepare('SELECT id, name FROM workspaces ORDER BY name')
    .all() as WorkspaceRow[];
  return rows.map((workspace) => {
    const warnings: string[] = [];
    const repos = readWorkspaceReposForUi(db, workspace.id);
    const contractResult = readWorkspaceContractsForUi(workspace.name, repos, warnings);
    const linkResult = readWorkspaceLinksForUi(db, workspace.id);
    return {
      name: workspace.name,
      repoCount: repos.length,
      contracts: contractResult.contracts,
      links: linkResult.links,
      warnings,
      resources: workspaceResources(workspace.name),
      limits: {
        contracts: contractResult.limit,
        links: linkResult.limit,
        contractsTruncated: contractResult.truncated,
        linksTruncated: linkResult.truncated
      }
    };
  });
}

export function readWorkspaceReposForUi(db: ReturnType<typeof openDatabase>, workspaceId: number): WorkspaceRepoRow[] {
  return db
    .prepare(`
      SELECT local_path, service_name
      FROM workspace_repos
      WHERE workspace_id = ?
      ORDER BY local_path
    `)
    .all(workspaceId) as WorkspaceRepoRow[];
}

export function readWorkspaceContractsForUi(
  workspaceName: string,
  repos: WorkspaceRepoRow[],
  warnings: string[]
): { contracts: UiWorkspaceContract[]; limit: number; truncated: boolean } {
  const limit = 80;
  const contracts: UiWorkspaceContract[] = [];
  let truncated = false;
  for (const repo of repos) {
    if (contracts.length >= limit) {
      truncated = true;
      break;
    }
    let repoDb: ReturnType<typeof openDatabase> | undefined;
    try {
      repoDb = openDatabase(repo.local_path, { readOnly: true });
      const repoId = getRepoId(repoDb, repo.local_path);
      const indexRunId = latestCompletedIndexRun(repoDb, repoId);
      const remaining = limit - contracts.length;
      const rows = repoDb
        .prepare(`
          SELECT
            c.id,
            c.kind,
            c.service_name,
            c.path,
            v.schema_version,
            (
              SELECT count(*)
              FROM relations r
              INNER JOIN entities target
                 ON target.id = r.target_entity_id
                AND target.repo_id = r.repo_id
              WHERE r.repo_id = c.repo_id
                AND r.index_run_id = ?
                AND r.source_entity_id = c.id
                AND r.kind = 'DECLARES'
                AND target.kind = 'endpoint'
            ) AS endpoint_count
          FROM contracts c
          INNER JOIN contract_versions v
             ON v.contract_id = c.id
            AND v.index_run_id = ?
          WHERE c.repo_id = ?
          ORDER BY COALESCE(c.service_name, ''), c.path, c.id
          LIMIT ?
        `)
        .all(indexRunId, indexRunId, repoId, remaining + 1) as WorkspaceContractRow[];
      if (rows.length > remaining) truncated = true;
      contracts.push(...rows.slice(0, remaining).map((row) => ({
        id: row.id,
        serviceName: row.service_name ?? repo.service_name ?? repo.local_path,
        repoPath: repo.local_path,
        path: row.path ?? row.id,
        kind: row.kind,
        indexRunId,
        endpointCount: row.endpoint_count,
        ...(row.schema_version !== null ? { schemaVersion: row.schema_version } : {})
      })));
    } catch (error) {
      warnings.push(`workspace contract repo skipped: ${workspaceName}:${repo.local_path}: ${errorMessage(error)}`);
    } finally {
      repoDb?.close();
    }
  }
  return { contracts, limit, truncated };
}

export function readWorkspaceLinksForUi(
  db: ReturnType<typeof openDatabase>,
  workspaceId: number
): { links: UiWorkspaceLink[]; limit: number; truncated: boolean } {
  const limit = 120;
  if (!tableExists(db, 'cross_repo_links')) return { links: [], limit, truncated: false };
  const rows = db
    .prepare(`
      SELECT
        link.id,
        link.kind,
        link.confidence,
        link.provenance,
        source_member.local_path AS source_path,
        source_member.service_name AS source_service,
        target_member.local_path AS target_path,
        target_member.service_name AS target_service
      FROM cross_repo_links link
      INNER JOIN workspace_repos source_member
         ON source_member.workspace_id = link.workspace_id
        AND source_member.repo_id = link.source_repo_id
      INNER JOIN workspace_repos target_member
         ON target_member.workspace_id = link.workspace_id
        AND target_member.repo_id = link.target_repo_id
      WHERE link.workspace_id = ?
      ORDER BY link.kind, source_member.service_name, target_member.service_name, link.id
      LIMIT ?
    `)
    .all(workspaceId, limit + 1) as WorkspaceLinkRow[];
  return {
    links: rows.slice(0, limit).map((row) => {
      const provenance = parsedProvenance(row.provenance);
      const routeLabel = routeLabelFromProvenance(provenance);
      const consumerPath =
        stringAt(objectAt(provenance, 'consumer'), 'path')
        ?? stringAt(objectAt(provenance, 'evidence'), 'filePath');
      const providerContractPath = stringAt(objectAt(provenance, 'provider'), 'contractPath');
      const eventTopology = eventTopologyFromProvenance(provenance);
      return {
        id: row.id,
        kind: row.kind,
        confidence: row.confidence,
        sourceService: row.source_service ?? row.source_path,
        targetService: row.target_service ?? row.target_path,
        ...(routeLabel !== undefined ? { routeLabel } : {}),
        ...(consumerPath !== undefined ? { consumerPath } : {}),
        ...(providerContractPath !== undefined ? { providerContractPath } : {}),
        ...(eventTopology !== undefined ? { eventTopology } : {})
      };
    }),
    limit,
    truncated: rows.length > limit
  };
}

export function workspaceResourceUri(workspaceName: string): string {
  return `parallax://workspaces/${encodeURIComponent(workspaceName)}`;
}

export function entityResourceUri(entity: ImpactReport['changed'][number]): string {
  return `parallax://entities/${encodeURIComponent(entity.id)}`;
}

export function workspaceResources(workspaceName: string): UiWorkspaceSnapshot['resources'] {
  const workspace = workspaceResourceUri(workspaceName);
  return {
    workspace,
    contracts: `${workspace}/contracts`,
    crossRepoLinks: `${workspace}/cross-repo-links`
  };
}

export function parsedProvenance(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function routeLabelFromProvenance(provenance: unknown): string | undefined {
  const http = objectAt(provenance, 'http');
  const method = stringAt(http, 'method');
  const routePath = stringAt(http, 'path');
  if (method && routePath) return `${method} ${routePath}`;

  const change = objectAt(provenance, 'change');
  const changeMethod = stringAt(change, 'method');
  const changePath = stringAt(change, 'path');
  if (changeMethod && changePath) return `${changeMethod} ${changePath}`;
  return routePath ?? changePath;
}

export function eventTopologyFromProvenance(provenance: unknown): UiWorkspaceLink['eventTopology'] | undefined {
  const topology = objectAt(provenance, 'eventTopology');
  const providerAction = stringAt(topology, 'providerAction');
  const counterpartyRole = stringAt(topology, 'counterpartyRole');
  const pattern = stringAt(topology, 'pattern');
  if (!providerAction || !pattern) return undefined;
  if (counterpartyRole !== 'consumer' && counterpartyRole !== 'producer' && counterpartyRole !== 'unknown') {
    return undefined;
  }
  return { providerAction, counterpartyRole, pattern };
}

function tableExists(db: ReturnType<typeof openDatabase>, name: string): boolean {
  return db
    .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;
}
