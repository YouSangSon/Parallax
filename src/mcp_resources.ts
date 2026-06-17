import { asConfidence } from './confidence.js';
import { contextPackResourceUri, entityResourceUri, evidenceResourceUri } from './context_pack.js';
import type { EventTopologyProvenance } from './contract_diff.js';
import { GraphPaginationInputError, paginateGraph } from './graph_pagination.js';
import { redactSecrets } from './security.js';
import { getRepoId, latestCompletedIndexRun, openDatabase } from './store.js';
import type { EntityRef, GraphExport, GraphExportFormat } from './types.js';
import { listWorkspaces } from './workspace.js';
import {
  compactEvidenceResource,
  errorMessage,
  evidenceSpanColumnSelect,
  isRecord,
  mcpHasTable,
  parseJsonObject,
  typedMcpError,
  withReadOnlyDb
} from './mcp_shared.js';
import type { CompactEvidenceResource, ExplainEvidenceRow } from './mcp_shared.js';
import type { McpContext } from './mcp.js';

type McpResourceListItem = { uri: string; name: string; mimeType: string };

type WorkspaceContractRow = {
  id: string;
  kind: string;
  service_name: string | null;
  path: string;
  schema_version: string | null;
  content_hash: string;
  endpoint_count: number;
};

type WorkspaceCrossRepoLinkRow = {
  id: string;
  kind: string;
  confidence: string;
  provenance: string;
  index_run_id: number | null;
  source_repo_path: string;
  source_service: string;
  target_repo_path: string;
  target_service: string;
};

function workspaceResourceUri(workspaceName: string): string {
  return `parallax://workspaces/${encodeURIComponent(workspaceName)}`;
}

function workspaceContractsResourceUri(workspaceName: string): string {
  return `${workspaceResourceUri(workspaceName)}/contracts`;
}

function workspaceCrossRepoLinksResourceUri(workspaceName: string): string {
  return `${workspaceResourceUri(workspaceName)}/cross-repo-links`;
}

export function workspaceResources(workspaceName: string): { workspace: string; contracts: string; crossRepoLinks: string } {
  return {
    workspace: workspaceResourceUri(workspaceName),
    contracts: workspaceContractsResourceUri(workspaceName),
    crossRepoLinks: workspaceCrossRepoLinksResourceUri(workspaceName)
  };
}

function selectMcpWorkspace(context: McpContext, workspaceName: string): ReturnType<typeof listWorkspaces>['workspaces'][number] {
  const workspace = listWorkspaces({ repoRoot: context.repoRoot, name: workspaceName }).workspaces[0];
  if (!workspace) throw typedMcpError(new Error(`impact workspace not found: ${workspaceName}`), 'resource_not_found');
  return workspace;
}

function listMcpWorkspaces(context: McpContext): ReturnType<typeof listWorkspaces>['workspaces'] {
  return listWorkspaces({ repoRoot: context.repoRoot }).workspaces;
}

export function listWorkspaceResources(context: McpContext): McpResourceListItem[] {
  return listMcpWorkspaces(context).map((workspace) => ({
    uri: workspaceResourceUri(workspace.name),
    name: `Workspace ${workspace.name}`,
    mimeType: 'application/json'
  }));
}

export function listWorkspaceContractResources(context: McpContext): McpResourceListItem[] {
  return listMcpWorkspaces(context).map((workspace) => ({
    uri: workspaceContractsResourceUri(workspace.name),
    name: `Workspace ${workspace.name} contracts`,
    mimeType: 'application/json'
  }));
}

export function listWorkspaceCrossRepoLinkResources(context: McpContext): McpResourceListItem[] {
  return listMcpWorkspaces(context).map((workspace) => ({
    uri: workspaceCrossRepoLinksResourceUri(workspace.name),
    name: `Workspace ${workspace.name} cross-repo links`,
    mimeType: 'application/json'
  }));
}

export function readWorkspaceResource(context: McpContext, workspaceName: string): unknown {
  const workspace = selectMcpWorkspace(context, workspaceName);
  return {
    version: 0,
    workspace,
    resources: workspaceResources(workspace.name)
  };
}

export function readWorkspaceContractsResource(context: McpContext, workspaceName: string): unknown {
  const workspace = selectMcpWorkspace(context, workspaceName);
  const warnings: string[] = [];
  const contracts = workspace.repos.flatMap((repo) => {
    let db: ReturnType<typeof openDatabase> | undefined;
    try {
      db = openDatabase(repo.localPath, { readOnly: true });
      const repoId = getRepoId(db, repo.localPath);
      const indexRunId = latestCompletedIndexRun(db, repoId);
      const rows = db
        .prepare(`
          SELECT
            c.id,
            c.kind,
            c.service_name,
            c.path,
            v.schema_version,
            v.content_hash,
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
        `)
        .all(indexRunId, indexRunId, repoId) as WorkspaceContractRow[];
      return rows.map((row) => ({
        id: row.id,
        serviceName: row.service_name ?? repo.serviceName,
        repoPath: repo.localPath,
        path: row.path,
        kind: row.kind,
        ...(row.schema_version !== null ? { schemaVersion: row.schema_version } : {}),
        contentHash: row.content_hash,
        indexRunId,
        endpointCount: row.endpoint_count,
        contractDiffHint: {
          tool: 'parallax_contract_diff',
          workspaceName: workspace.name,
          contractPath: row.path,
          providerServiceName: row.service_name ?? repo.serviceName
        }
      }));
    } catch (error) {
      warnings.push(`workspace contract repo skipped: ${repo.localPath}: ${errorMessage(error)}`);
      return [];
    } finally {
      db?.close();
    }
  });

  return {
    version: 0,
    workspace: workspace.name,
    contracts,
    warnings,
    resources: workspaceResources(workspace.name)
  };
}

export function readWorkspaceCrossRepoLinksResource(context: McpContext, workspaceName: string): unknown {
  const workspace = selectMcpWorkspace(context, workspaceName);
  return withReadOnlyDb(context, (db) => {
    const workspaceRow = db
      .prepare('SELECT id FROM workspaces WHERE name = ?')
      .get(workspace.name) as { id: number } | undefined;
    if (!workspaceRow) throw typedMcpError(new Error(`impact workspace not found: ${workspace.name}`), 'resource_not_found');
    const limit = 500;
    const rows = db
      .prepare(`
        SELECT
          link.id,
          link.kind,
          link.confidence,
          link.provenance,
          link.index_run_id,
          source_member.local_path AS source_repo_path,
          source_member.service_name AS source_service,
          target_member.local_path AS target_repo_path,
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
      .all(workspaceRow.id, limit + 1) as WorkspaceCrossRepoLinkRow[];
    return {
      version: 0,
      workspace: workspace.name,
      links: rows.slice(0, limit).map((row) => {
        const provenance = parsedProvenance(row.provenance);
        const eventTopology = eventTopologyFromProvenance(provenance);
        return {
          id: row.id,
          kind: row.kind,
          confidence: row.confidence,
          sourceRepoPath: row.source_repo_path,
          sourceService: row.source_service,
          targetRepoPath: row.target_repo_path,
          targetService: row.target_service,
          indexRunId: row.index_run_id,
          ...(eventTopology !== undefined ? { eventTopology } : {}),
          provenance
        };
      }),
      limits: {
        links: limit,
        truncated: rows.length > limit
      },
      resources: workspaceResources(workspace.name)
    };
  });
}

function parsedProvenance(value: string): unknown {
  const parsed = parseJsonObject(value);
  return Object.keys(parsed).length > 0 ? parsed : value;
}

function eventTopologyFromProvenance(provenance: unknown): EventTopologyProvenance | undefined {
  if (!isRecord(provenance) || !isRecord(provenance.eventTopology)) return undefined;
  const providerAction = provenance.eventTopology.providerAction;
  const counterpartyRole = provenance.eventTopology.counterpartyRole;
  const pattern = provenance.eventTopology.pattern;
  if (typeof providerAction !== 'string' || typeof pattern !== 'string') return undefined;
  if (!providerAction || !pattern) return undefined;
  if (counterpartyRole !== 'consumer' && counterpartyRole !== 'producer' && counterpartyRole !== 'unknown') {
    return undefined;
  }
  return { providerAction, counterpartyRole, pattern };
}

export function listReportResources(context: McpContext): Array<{ uri: string; name: string; mimeType: string }> {
  return withReadOnlyDb(context, (db, repoId) => {
    const rows = db
      .prepare('SELECT id FROM reports WHERE repo_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(repoId) as Array<{ id: string }>;
    return rows.map((row) => ({
      uri: `parallax://reports/${row.id}`,
      name: `Impact report ${row.id}`,
      mimeType: 'application/json'
    }));
  });
}

export function listEntityResources(context: McpContext): Array<{ uri: string; name: string; mimeType: string }> {
  return withReadOnlyDb(context, (db, repoId) => {
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const rows = db
      .prepare(`
        SELECT id, display_name
        FROM entities
        WHERE repo_id = ? AND updated_index_run_id = ?
        ORDER BY display_name
        LIMIT 50
      `)
      .all(repoId, indexRunId) as Array<{ id: string; display_name: string }>;
    return rows.map((row) => ({
      uri: `parallax://entities/${encodeURIComponent(row.id)}`,
      name: row.display_name,
      mimeType: 'application/json'
    }));
  });
}

export function listEvidenceResources(context: McpContext): Array<{ uri: string; name: string; mimeType: string }> {
  return withReadOnlyDb(context, (db, repoId) => {
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const rows = db
      .prepare(`
        SELECT id, file_path, kind
        FROM relation_evidence
        WHERE repo_id = ? AND index_run_id = ?
        ORDER BY file_path, kind, id
        LIMIT 50
      `)
      .all(repoId, indexRunId) as Array<{ id: string; file_path: string; kind: string }>;
    return rows.map((row) => ({
      uri: evidenceResourceUri(row.id),
      name: `${row.kind} evidence in ${row.file_path}`,
      mimeType: 'application/json'
    }));
  });
}

export function listContextPackResources(context: McpContext): Array<{ uri: string; name: string; mimeType: string }> {
  return withReadOnlyDb(context, (db, repoId) => {
    if (!mcpHasTable(db, 'context_packs')) return [];
    const rows = db
      .prepare(`
        SELECT id, budget, index_run_id
        FROM context_packs
        WHERE repo_id = ?
        ORDER BY last_accessed_at DESC, created_at DESC
        LIMIT 50
      `)
      .all(repoId) as Array<{ id: string; budget: string; index_run_id: number }>;
    return rows.map((row) => ({
      uri: contextPackResourceUri(row.id),
      name: `${row.budget} context pack for index run ${row.index_run_id}`,
      mimeType: 'application/json'
    }));
  });
}

export function listGraphResources(context: McpContext): Array<{ uri: string; name: string; mimeType: string }> {
  return withReadOnlyDb(context, (db, repoId) => {
    const rows = db
      .prepare('SELECT id FROM reports WHERE repo_id = ? ORDER BY created_at DESC LIMIT 10')
      .all(repoId) as Array<{ id: string }>;
    return rows.flatMap((row) => (['mermaid', 'json', 'dot'] as const).map((format) => ({
      uri: `parallax://reports/${row.id}/graph/${format}`,
      name: `Impact report ${row.id} graph (${format})`,
      mimeType: format === 'json' ? 'application/json' : 'text/plain'
    })));
  });
}

export function graphFormatVariable(value: string): string {
  return value.split(/[?#]/, 1)[0] ?? value;
}

export function graphResourceText(uri: URL, graph: GraphExport, format: GraphExportFormat): string {
  if (format !== 'json') return graph.rendered;
  const requirePagination = uri.searchParams.has('limit') || uri.searchParams.has('cursor');
  try {
    const payload = paginateGraph(graph, {
      limit: uri.searchParams.get('limit'),
      cursor: uri.searchParams.get('cursor'),
      requirePagination
    });
    if (!requirePagination) return graph.rendered;
    return JSON.stringify(payload, null, 2);
  } catch (error) {
    if (error instanceof GraphPaginationInputError) {
      throw typedMcpError(error, 'invalid_pagination');
    }
    throw error;
  }
}

export function readReport(context: McpContext, reportId: string): unknown {
  return withReadOnlyDb(context, (db, repoId) => {
    const row = db.prepare('SELECT json FROM reports WHERE repo_id = ? AND id = ?').get(repoId, reportId) as { json: string } | undefined;
    if (!row) throw typedMcpError(new Error(`impact report not found: ${reportId}`), 'resource_not_found');
    return JSON.parse(row.json) as unknown;
  });
}

export function readContextPack(context: McpContext, contextPackId: string): unknown {
  return withReadOnlyDb(context, (db, repoId) => {
    if (!mcpHasTable(db, 'context_packs')) {
      throw typedMcpError(new Error(`impact context pack not found: ${contextPackId}`), 'resource_not_found');
    }
    const row = db
      .prepare('SELECT pack_json FROM context_packs WHERE repo_id = ? AND id = ?')
      .get(repoId, contextPackId) as { pack_json: string } | undefined;
    if (!row) {
      throw typedMcpError(new Error(`impact context pack not found: ${contextPackId}`), 'resource_not_found');
    }
    return JSON.parse(row.pack_json) as unknown;
  });
}

export function readEntity(context: McpContext, entityId: string): unknown {
  return withReadOnlyDb(context, (db, repoId) => {
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const relationLimit = 100;
    const entity = db
      .prepare('SELECT * FROM entities WHERE repo_id = ? AND id = ? AND updated_index_run_id = ?')
      .get(repoId, entityId, indexRunId) as Record<string, unknown> | undefined;
    if (!entity) throw typedMcpError(new Error(`impact entity not found: ${entityId}`), 'resource_not_found');
    const outgoing = db
      .prepare('SELECT id, target_entity_id, kind, confidence, provenance FROM relations WHERE repo_id = ? AND source_entity_id = ? AND index_run_id = ? ORDER BY kind, target_entity_id LIMIT ?')
      .all(repoId, entityId, indexRunId, relationLimit + 1);
    const incoming = db
      .prepare('SELECT id, source_entity_id, kind, confidence, provenance FROM relations WHERE repo_id = ? AND target_entity_id = ? AND index_run_id = ? ORDER BY kind, source_entity_id LIMIT ?')
      .all(repoId, entityId, indexRunId, relationLimit + 1);
    return {
      entity,
      indexRunId,
      outgoing: outgoing.slice(0, relationLimit),
      incoming: incoming.slice(0, relationLimit),
      limits: {
        relations: relationLimit,
        outgoingTruncated: outgoing.length > relationLimit,
        incomingTruncated: incoming.length > relationLimit
      }
    };
  });
}

type EvidenceResourceRow = {
  evidence_id: string;
  evidence_file_path: string;
  evidence_kind: string;
  evidence_snippet: string;
  evidence_confidence: string;
  evidence_index_run_id: number;
  evidence_start_line: number | null;
  evidence_end_line: number | null;
  evidence_start_col: number | null;
  evidence_end_col: number | null;
  relation_id: string;
  relation_kind: string;
  relation_confidence: string;
  relation_provenance: string;
  source_id: string | null;
  source_kind: string | null;
  source_path: string | null;
  source_symbol: string | null;
  source_language_id: string | null;
  source_display_name: string | null;
  target_id: string | null;
  target_kind: string | null;
  target_path: string | null;
  target_symbol: string | null;
  target_language_id: string | null;
  target_display_name: string | null;
};

type EntityExplainOptions = {
  entityId: string;
  relationLimit: number;
  evidenceLimit: number;
};

type ExplainEntityRow = {
  id: string;
  kind: string;
  path: string | null;
  symbol: string | null;
  language_id: string | null;
  display_name: string;
};

type ExplainRelationRow = {
  relation_id: string;
  relation_kind: string;
  relation_confidence: string;
  relation_provenance: string;
  source_id: string;
  source_kind: string;
  source_path: string | null;
  source_symbol: string | null;
  source_language_id: string | null;
  source_display_name: string;
  target_id: string;
  target_kind: string;
  target_path: string | null;
  target_symbol: string | null;
  target_language_id: string | null;
  target_display_name: string;
};

export function explainEntity(context: McpContext, options: EntityExplainOptions): unknown {
  return withReadOnlyDb(context, (db, repoId) => {
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const entity = db
      .prepare(`
        SELECT id, kind, path, symbol, language_id, display_name
        FROM entities
        WHERE repo_id = ? AND id = ? AND updated_index_run_id = ?
      `)
      .get(repoId, options.entityId, indexRunId) as ExplainEntityRow | undefined;
    if (!entity) throw typedMcpError(new Error(`impact entity not found: ${options.entityId}`), 'resource_not_found');

    const incomingCount = relationCount(db, repoId, indexRunId, 'target_entity_id', options.entityId);
    const outgoingCount = relationCount(db, repoId, indexRunId, 'source_entity_id', options.entityId);
    const incomingRows = explainRelationRows(db, repoId, indexRunId, 'target_entity_id', options.entityId, options.relationLimit);
    const outgoingRows = explainRelationRows(db, repoId, indexRunId, 'source_entity_id', options.entityId, options.relationLimit);
    const selectedRelationIds = [...incomingRows, ...outgoingRows].map((row) => row.relation_id);
    const evidenceRows = explainEvidenceRows(db, repoId, indexRunId, selectedRelationIds, options.evidenceLimit + 1);
    const evidenceCount = explainEvidenceCount(db, repoId, indexRunId, selectedRelationIds);
    const selectedEvidenceRows = evidenceRows.slice(0, options.evidenceLimit);
    const evidenceByRelation = new Map<string, CompactEvidenceResource[]>();
    for (const row of selectedEvidenceRows) {
      const item = compactEvidenceResource(row);
      const bucket = evidenceByRelation.get(row.relation_id) ?? [];
      bucket.push(item);
      evidenceByRelation.set(row.relation_id, bucket);
    }
    const evidenceUris = selectedEvidenceRows.map((row) => evidenceResourceUri(row.evidence_id));

    return {
      entity: entityFromExplainRow(entity),
      indexRunId,
      relations: {
        incoming: incomingRows.map((row) => explainRelation(row, evidenceByRelation)),
        outgoing: outgoingRows.map((row) => explainRelation(row, evidenceByRelation))
      },
      resources: {
        entity: entityResourceUri(entityFromExplainRow(entity)),
        evidence: [...new Set(evidenceUris)].sort()
      },
      limits: {
        relationLimit: options.relationLimit,
        evidenceLimit: options.evidenceLimit,
        snippetChars: 300,
        incomingTruncated: incomingCount > options.relationLimit,
        outgoingTruncated: outgoingCount > options.relationLimit,
        evidenceTruncated: evidenceCount > options.evidenceLimit
      },
      counts: {
        incoming: incomingCount,
        outgoing: outgoingCount,
        evidence: evidenceCount
      }
    };
  });
}

function relationCount(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  column: 'source_entity_id' | 'target_entity_id',
  entityId: string
): number {
  const row = db
    .prepare(`SELECT count(*) AS count FROM relations WHERE repo_id = ? AND index_run_id = ? AND ${column} = ?`)
    .get(repoId, indexRunId, entityId) as { count: number };
  return row.count;
}

function explainRelationRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  column: 'source_entity_id' | 'target_entity_id',
  entityId: string,
  limit: number
): ExplainRelationRow[] {
  return db
    .prepare(`
      SELECT
        relations.id AS relation_id,
        relations.kind AS relation_kind,
        relations.confidence AS relation_confidence,
        relations.provenance AS relation_provenance,
        source.id AS source_id,
        source.kind AS source_kind,
        source.path AS source_path,
        source.symbol AS source_symbol,
        source.language_id AS source_language_id,
        source.display_name AS source_display_name,
        target.id AS target_id,
        target.kind AS target_kind,
        target.path AS target_path,
        target.symbol AS target_symbol,
        target.language_id AS target_language_id,
        target.display_name AS target_display_name
      FROM relations
      INNER JOIN entities source ON source.id = relations.source_entity_id AND source.repo_id = relations.repo_id
      INNER JOIN entities target ON target.id = relations.target_entity_id AND target.repo_id = relations.repo_id
      WHERE relations.repo_id = ?
        AND relations.index_run_id = ?
        AND relations.${column} = ?
      ORDER BY relations.kind, source.display_name, target.display_name, relations.id
      LIMIT ?
    `)
    .all(repoId, indexRunId, entityId, limit) as ExplainRelationRow[];
}

function explainEvidenceRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  relationIds: string[],
  limit: number
): ExplainEvidenceRow[] {
  if (relationIds.length === 0 || limit <= 0) return [];
  const placeholders = relationIds.map(() => '?').join(', ');
  const spanColumns = evidenceSpanColumnSelect(db, 'evidence');
  return db
    .prepare(`
      SELECT
        evidence.id AS evidence_id,
        evidence.relation_id AS relation_id,
        evidence.file_path AS evidence_file_path,
        evidence.kind AS evidence_kind,
        evidence.snippet AS evidence_snippet,
        evidence.confidence AS evidence_confidence,
        ${spanColumns}
      FROM relation_evidence evidence
      WHERE evidence.repo_id = ?
        AND evidence.index_run_id = ?
        AND evidence.relation_id IN (${placeholders})
      ORDER BY evidence.file_path, evidence.kind, evidence.id
      LIMIT ?
    `)
    .all(repoId, indexRunId, ...relationIds, limit) as ExplainEvidenceRow[];
}

function explainEvidenceCount(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  relationIds: string[]
): number {
  if (relationIds.length === 0) return 0;
  const placeholders = relationIds.map(() => '?').join(', ');
  const row = db
    .prepare(`
      SELECT count(*) AS count
      FROM relation_evidence
      WHERE repo_id = ?
        AND index_run_id = ?
        AND relation_id IN (${placeholders})
    `)
    .get(repoId, indexRunId, ...relationIds) as { count: number };
  return row.count;
}

function explainRelation(
  row: ExplainRelationRow,
  evidenceByRelation: ReadonlyMap<string, CompactEvidenceResource[]>
): unknown {
  return {
    id: row.relation_id,
    kind: row.relation_kind,
    confidence: asConfidence(row.relation_confidence),
    provenance: row.relation_provenance,
    sourceEntity: entityFromExplainRelationRow(row, 'source'),
    targetEntity: entityFromExplainRelationRow(row, 'target'),
    evidence: evidenceByRelation.get(row.relation_id) ?? []
  };
}

function entityFromExplainRow(row: ExplainEntityRow): EntityRef {
  return {
    id: row.id,
    kind: row.kind as EntityRef['kind'],
    ...(row.path !== null ? { path: row.path } : {}),
    ...(row.symbol !== null ? { symbol: row.symbol } : {}),
    ...(row.language_id !== null ? { languageId: row.language_id } : {}),
    displayName: row.display_name
  };
}

function entityFromExplainRelationRow(row: ExplainRelationRow, prefix: 'source' | 'target'): EntityRef {
  const id = prefix === 'source' ? row.source_id : row.target_id;
  const kind = prefix === 'source' ? row.source_kind : row.target_kind;
  const filePath = prefix === 'source' ? row.source_path : row.target_path;
  const symbol = prefix === 'source' ? row.source_symbol : row.target_symbol;
  const languageId = prefix === 'source' ? row.source_language_id : row.target_language_id;
  const displayName = prefix === 'source' ? row.source_display_name : row.target_display_name;
  return {
    id,
    kind: kind as EntityRef['kind'],
    ...(filePath !== null ? { path: filePath } : {}),
    ...(symbol !== null ? { symbol } : {}),
    ...(languageId !== null ? { languageId } : {}),
    displayName
  };
}

export function readEvidence(context: McpContext, evidenceId: string): unknown {
  return withReadOnlyDb(context, (db, repoId) => {
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const spanColumns = evidenceSpanColumnSelect(db, 'evidence');
    const row = db
      .prepare(`
        SELECT
          evidence.id AS evidence_id,
          evidence.file_path AS evidence_file_path,
          evidence.kind AS evidence_kind,
          evidence.snippet AS evidence_snippet,
          evidence.confidence AS evidence_confidence,
          evidence.index_run_id AS evidence_index_run_id,
          ${spanColumns},
          relations.id AS relation_id,
          relations.kind AS relation_kind,
          relations.confidence AS relation_confidence,
          relations.provenance AS relation_provenance,
          source.id AS source_id,
          source.kind AS source_kind,
          source.path AS source_path,
          source.symbol AS source_symbol,
          source.language_id AS source_language_id,
          source.display_name AS source_display_name,
          target.id AS target_id,
          target.kind AS target_kind,
          target.path AS target_path,
          target.symbol AS target_symbol,
          target.language_id AS target_language_id,
          target.display_name AS target_display_name
        FROM relation_evidence evidence
        INNER JOIN relations
          ON relations.id = evidence.relation_id
         AND relations.repo_id = evidence.repo_id
         AND relations.index_run_id = evidence.index_run_id
        INNER JOIN entities source
          ON source.id = relations.source_entity_id
         AND source.repo_id = evidence.repo_id
         AND source.updated_index_run_id = evidence.index_run_id
        INNER JOIN entities target
          ON target.id = relations.target_entity_id
         AND target.repo_id = evidence.repo_id
         AND target.updated_index_run_id = evidence.index_run_id
        WHERE evidence.repo_id = ? AND evidence.id = ? AND evidence.index_run_id = ?
      `)
      .get(repoId, evidenceId, indexRunId) as EvidenceResourceRow | undefined;
    if (!row) throw typedMcpError(new Error(`impact evidence not found: ${evidenceId}`), 'resource_not_found');
    return {
      id: row.evidence_id,
      file: row.evidence_file_path,
      kind: row.evidence_kind,
      snippet: redactSecrets(row.evidence_snippet),
      confidence: asConfidence(row.evidence_confidence),
      ...(row.evidence_start_line !== null ? { startLine: row.evidence_start_line } : {}),
      ...(row.evidence_end_line !== null ? { endLine: row.evidence_end_line } : {}),
      ...(row.evidence_start_col !== null ? { startCol: row.evidence_start_col } : {}),
      ...(row.evidence_end_col !== null ? { endCol: row.evidence_end_col } : {}),
      relation: {
        id: row.relation_id,
        kind: row.relation_kind,
        confidence: asConfidence(row.relation_confidence),
        provenance: row.relation_provenance
      },
      sourceEntity: row.source_id ? entityFromEvidenceRow(row, 'source') : null,
      targetEntity: row.target_id ? entityFromEvidenceRow(row, 'target') : null,
      indexRunId: row.evidence_index_run_id
    };
  });
}

function entityFromEvidenceRow(row: EvidenceResourceRow, prefix: 'source' | 'target'): EntityRef {
  const id = prefix === 'source' ? row.source_id! : row.target_id!;
  const kind = prefix === 'source' ? row.source_kind! : row.target_kind!;
  const path = prefix === 'source' ? row.source_path : row.target_path;
  const symbol = prefix === 'source' ? row.source_symbol : row.target_symbol;
  const languageId = prefix === 'source' ? row.source_language_id : row.target_language_id;
  const displayName = prefix === 'source' ? row.source_display_name : row.target_display_name;
  return {
    id,
    kind: kind as EntityRef['kind'],
    ...(path !== null ? { path } : {}),
    ...(symbol !== null ? { symbol } : {}),
    ...(languageId !== null ? { languageId } : {}),
    displayName: displayName ?? id
  };
}

export function readLatestCoverage(context: McpContext): unknown {
  return withReadOnlyDb(context, (db, repoId) => {
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const coverageLimit = 500;
    const coverage = db
      .prepare('SELECT path, language_id, status, reason FROM index_coverage WHERE index_run_id = ? ORDER BY path LIMIT ?')
      .all(indexRunId, coverageLimit + 1);
    return {
      indexRunId,
      coverage: coverage.slice(0, coverageLimit),
      limit: coverageLimit,
      truncated: coverage.length > coverageLimit
    };
  });
}
export function parseGraphFormat(value: string): GraphExportFormat {
  if (value === 'json' || value === 'mermaid' || value === 'dot') return value;
  throw typedMcpError(new Error('graph resource format must be mermaid, json, or dot'), 'invalid_resource_format');
}
