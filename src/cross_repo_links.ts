import { asConfidence } from './confidence.js';
import { endpointKey, parseJsonObject } from './contract_diff/shared.js';
import { openDatabase } from './store.js';
import type { Confidence } from './types.js';
import { listWorkspaces, type WorkspaceSummary } from './workspace.js';
import { workspaceResources, type WorkspaceResourceUris } from './workspace_resources.js';

export type CrossRepoLinkKind = 'CONSUMES_HTTP_ENDPOINT' | 'BREAKS_COMPATIBILITY_WITH';
export type CrossRepoDiagnosticKind = 'malformed_link' | 'stale_workspace_link' | 'orphan_breaking_link';

export type CrossRepoEndpoint = {
  method: string;
  path: string;
};

export type CrossRepoLinkRecord = {
  id: string;
  workspace: string;
  kind: CrossRepoLinkKind;
  confidence: Confidence;
  source: {
    serviceName?: string;
    repoPath?: string;
    path?: string;
    inWorkspace: boolean;
  };
  target: {
    serviceName?: string;
    repoPath?: string;
    contractPath?: string;
    inWorkspace: boolean;
  };
  endpoint?: CrossRepoEndpoint;
  change?: {
    kind: string;
    method?: string;
    path?: string;
  };
  evidence?: {
    filePath?: string;
    snippet?: string;
  };
  provenance: unknown;
};

export type CrossRepoDiagnostic = {
  kind: CrossRepoDiagnosticKind;
  id: string;
  linkKind?: string;
  message: string;
};

export type CrossRepoLinkVerifyOptions = {
  repoRoot: string;
  workspaceName?: string;
};

export type CrossRepoLinkVerifyResult = {
  version: 0;
  workspace: WorkspaceSummary;
  summary: {
    passed: boolean;
    totalLinks: number;
    consumesLinks: number;
    breakingLinks: number;
    malformedLinks: number;
    staleWorkspaceLinks: number;
    orphanBreakingLinks: number;
  };
  diagnostics: {
    malformedLinks: CrossRepoDiagnostic[];
    staleWorkspaceLinks: CrossRepoDiagnostic[];
    orphanBreakingLinks: CrossRepoDiagnostic[];
  };
  resources: WorkspaceResourceUris;
};

export type CrossRepoConsumersOptions = {
  repoRoot: string;
  workspaceName?: string;
  providerServiceName: string;
  providerContractPath?: string;
  method?: string;
  routePath?: string;
};

export type CrossRepoProvidersOptions = {
  repoRoot: string;
  workspaceName?: string;
  consumerServiceName: string;
  consumerPath?: string;
};

export type CrossRepoConsumer = {
  linkId: string;
  kind: CrossRepoLinkKind;
  confidence: Confidence;
  consumerService: string;
  consumerRepoPath?: string;
  consumerPath: string;
  providerService: string;
  providerRepoPath?: string;
  providerContractPath: string;
  httpMethod: string;
  routePath: string;
};

export type CrossRepoProvider = CrossRepoConsumer;

export type CrossRepoConsumersResult = {
  version: 0;
  workspace: WorkspaceSummary;
  consumers: CrossRepoConsumer[];
  warnings: string[];
  resources: WorkspaceResourceUris;
};

export type CrossRepoProvidersResult = {
  version: 0;
  workspace: WorkspaceSummary;
  providers: CrossRepoProvider[];
  warnings: string[];
  resources: WorkspaceResourceUris;
};

type CrossRepoLinkRow = {
  id: string;
  kind: string;
  confidence: string;
  provenance: string;
  workspace_name: string | null;
  source_repo_root: string | null;
  target_repo_root: string | null;
  source_member_path: string | null;
  source_service_name: string | null;
  target_member_path: string | null;
  target_service_name: string | null;
};

type RequiredLinkFields = {
  consumer: {
    serviceName: string;
    repoPath?: string;
    path: string;
  };
  provider: {
    serviceName: string;
    repoPath?: string;
    contractPath: string;
  };
  evidence?: {
    filePath?: string;
    snippet?: string;
  };
};

export function verifyCrossRepoLinks(options: CrossRepoLinkVerifyOptions): CrossRepoLinkVerifyResult {
  const workspace = selectWorkspace(options.repoRoot, options.workspaceName);
  const db = openDatabase(options.repoRoot, { readOnly: true });
  try {
    const loaded = loadWorkspaceLinkRecords(db, workspace.name);
    const malformedLinks = loaded.malformed;
    const staleWorkspaceLinks = loaded.records
      .filter((record) => !record.source.inWorkspace || !record.target.inWorkspace)
      .map((record) => staleDiagnostic(record));
    const orphanBreakingLinks = orphanBreakingDiagnostics(loaded.records);
    return {
      version: 0,
      workspace,
      summary: {
        passed: malformedLinks.length === 0 && staleWorkspaceLinks.length === 0 && orphanBreakingLinks.length === 0,
        totalLinks: loaded.rowsSeen,
        consumesLinks: loaded.records.filter((record) => record.kind === 'CONSUMES_HTTP_ENDPOINT').length,
        breakingLinks: loaded.records.filter((record) => record.kind === 'BREAKS_COMPATIBILITY_WITH').length,
        malformedLinks: malformedLinks.length,
        staleWorkspaceLinks: staleWorkspaceLinks.length,
        orphanBreakingLinks: orphanBreakingLinks.length
      },
      diagnostics: { malformedLinks, staleWorkspaceLinks, orphanBreakingLinks },
      resources: workspaceResources(workspace.name)
    };
  } finally {
    db.close();
  }
}

export function consumersOf(options: CrossRepoConsumersOptions): CrossRepoConsumersResult {
  const workspace = selectWorkspace(options.repoRoot, options.workspaceName);
  const db = openDatabase(options.repoRoot, { readOnly: true });
  try {
    const loaded = loadWorkspaceLinkRecords(db, workspace.name);
    const method = options.method?.toUpperCase();
    const consumers = loaded.records
      .filter((record) => record.kind === 'CONSUMES_HTTP_ENDPOINT')
      .filter((record) => record.target.serviceName === options.providerServiceName)
      .filter((record) => options.providerContractPath === undefined || record.target.contractPath === options.providerContractPath)
      .filter((record) => method === undefined || record.endpoint?.method.toUpperCase() === method)
      .filter((record) => options.routePath === undefined || record.endpoint?.path === options.routePath)
      .map(recordToConsumer)
      .sort(compareConsumerRows);
    return {
      version: 0,
      workspace,
      consumers,
      warnings: consumers.length === 0 ? ['no persisted cross-repo consumers matched; run parallax workspace resolve-contracts if links are stale'] : [],
      resources: workspaceResources(workspace.name)
    };
  } finally {
    db.close();
  }
}

export function providersFor(options: CrossRepoProvidersOptions): CrossRepoProvidersResult {
  const workspace = selectWorkspace(options.repoRoot, options.workspaceName);
  const db = openDatabase(options.repoRoot, { readOnly: true });
  try {
    const loaded = loadWorkspaceLinkRecords(db, workspace.name);
    const providers = loaded.records
      .filter((record) => record.kind === 'CONSUMES_HTTP_ENDPOINT')
      .filter((record) => record.source.serviceName === options.consumerServiceName)
      .filter((record) => options.consumerPath === undefined || record.source.path === options.consumerPath)
      .map(recordToConsumer)
      .sort(compareConsumerRows);
    return {
      version: 0,
      workspace,
      providers,
      warnings: providers.length === 0 ? ['no persisted cross-repo providers matched; run parallax workspace resolve-contracts if links are stale'] : [],
      resources: workspaceResources(workspace.name)
    };
  } finally {
    db.close();
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

function loadWorkspaceLinkRecords(db: ReturnType<typeof openDatabase>, workspaceName: string): {
  rowsSeen: number;
  records: CrossRepoLinkRecord[];
  malformed: CrossRepoDiagnostic[];
} {
  const rows = db
    .prepare(
      `SELECT
         link.id, link.kind, link.confidence, link.provenance,
         workspace.name AS workspace_name,
         source_repo.root AS source_repo_root,
         target_repo.root AS target_repo_root,
         source_member.local_path AS source_member_path,
         source_member.service_name AS source_service_name,
         target_member.local_path AS target_member_path,
         target_member.service_name AS target_service_name
       FROM cross_repo_links link
       LEFT JOIN workspaces workspace ON workspace.id = link.workspace_id
       LEFT JOIN repos source_repo ON source_repo.id = link.source_repo_id
       LEFT JOIN repos target_repo ON target_repo.id = link.target_repo_id
       LEFT JOIN workspace_repos source_member
         ON source_member.workspace_id = link.workspace_id
        AND source_member.repo_id = link.source_repo_id
       LEFT JOIN workspace_repos target_member
         ON target_member.workspace_id = link.workspace_id
        AND target_member.repo_id = link.target_repo_id
       WHERE workspace.name = ?
       ORDER BY link.kind, link.id`
    )
    .all(workspaceName) as CrossRepoLinkRow[];

  const records: CrossRepoLinkRecord[] = [];
  const malformed: CrossRepoDiagnostic[] = [];
  for (const row of rows) {
    const parsed = parseLinkRow(row, workspaceName);
    if ('diagnostic' in parsed) {
      malformed.push(parsed.diagnostic);
    } else {
      records.push(parsed.record);
    }
  }
  return { rowsSeen: rows.length, records, malformed };
}

function recordToConsumer(record: CrossRepoLinkRecord): CrossRepoConsumer {
  const consumerRepoPath = record.source.repoPath;
  const providerRepoPath = record.target.repoPath;
  return {
    linkId: record.id,
    kind: record.kind,
    confidence: record.confidence,
    consumerService: record.source.serviceName ?? '',
    ...(consumerRepoPath !== undefined ? { consumerRepoPath } : {}),
    consumerPath: record.source.path ?? '',
    providerService: record.target.serviceName ?? '',
    ...(providerRepoPath !== undefined ? { providerRepoPath } : {}),
    providerContractPath: record.target.contractPath ?? '',
    httpMethod: record.endpoint?.method.toUpperCase() ?? '',
    routePath: record.endpoint?.path ?? ''
  };
}

function parseLinkRow(
  row: CrossRepoLinkRow,
  workspaceName: string
): { record: CrossRepoLinkRecord } | { diagnostic: CrossRepoDiagnostic } {
  const provenance = parseJsonObject(row.provenance);
  if (provenance === undefined) {
    return { diagnostic: malformedDiagnostic(row, 'provenance is not a JSON object') };
  }
  if (row.kind !== 'CONSUMES_HTTP_ENDPOINT' && row.kind !== 'BREAKS_COMPATIBILITY_WITH') {
    return { diagnostic: malformedDiagnostic(row, `unsupported link kind: ${row.kind}`) };
  }

  const base = parseRequiredLinkFields(provenance);
  if (!base.ok) {
    return { diagnostic: malformedDiagnostic(row, base.reason) };
  }

  if (row.kind === 'CONSUMES_HTTP_ENDPOINT') {
    const http = objectAt(provenance, 'http');
    const method = stringAt(http, 'method');
    const routePath = stringAt(http, 'path');
    if (!method || !routePath) {
      return { diagnostic: malformedDiagnostic(row, 'CONSUMES_HTTP_ENDPOINT provenance requires http.method and http.path') };
    }
    return {
      record: makeRecord(row, workspaceName, 'CONSUMES_HTTP_ENDPOINT', provenance, base.fields, {
        endpoint: { method, path: routePath }
      })
    };
  }

  const change = objectAt(provenance, 'change');
  const changeKind = stringAt(change, 'kind');
  const changeMethod = stringAt(change, 'method');
  const changePath = stringAt(change, 'path');
  if (!changeKind || !changeMethod || !changePath) {
    return {
      diagnostic: malformedDiagnostic(
        row,
        'BREAKS_COMPATIBILITY_WITH provenance requires change.kind, change.method, and change.path'
      )
    };
  }
  return {
    record: makeRecord(row, workspaceName, 'BREAKS_COMPATIBILITY_WITH', provenance, base.fields, {
      change: { kind: changeKind, method: changeMethod, path: changePath }
    })
  };
}

function makeRecord(
  row: CrossRepoLinkRow,
  workspaceName: string,
  kind: CrossRepoLinkKind,
  provenance: Record<string, unknown>,
  fields: RequiredLinkFields,
  detail: { endpoint: CrossRepoEndpoint } | { change: { kind: string; method: string; path: string } }
): CrossRepoLinkRecord {
  const sourceRepoPath = fields.consumer.repoPath ?? row.source_member_path ?? row.source_repo_root ?? undefined;
  const targetRepoPath = fields.provider.repoPath ?? row.target_member_path ?? row.target_repo_root ?? undefined;
  const sourceInWorkspace = isCurrentWorkspaceMember(row.source_member_path, fields.consumer.repoPath);
  const targetInWorkspace = isCurrentWorkspaceMember(row.target_member_path, fields.provider.repoPath);
  return {
    id: row.id,
    workspace: row.workspace_name ?? workspaceName,
    kind,
    confidence: asConfidence(row.confidence),
    source: {
      serviceName: fields.consumer.serviceName,
      ...(sourceRepoPath !== undefined ? { repoPath: sourceRepoPath } : {}),
      path: fields.consumer.path,
      inWorkspace: sourceInWorkspace
    },
    target: {
      serviceName: fields.provider.serviceName,
      ...(targetRepoPath !== undefined ? { repoPath: targetRepoPath } : {}),
      contractPath: fields.provider.contractPath,
      inWorkspace: targetInWorkspace
    },
    ...('endpoint' in detail ? { endpoint: detail.endpoint } : { change: detail.change }),
    ...(fields.evidence !== undefined ? { evidence: fields.evidence } : {}),
    provenance
  };
}

function parseRequiredLinkFields(
  provenance: Record<string, unknown>
): { ok: true; fields: RequiredLinkFields } | { ok: false; reason: string } {
  const consumer = objectAt(provenance, 'consumer');
  const provider = objectAt(provenance, 'provider');
  const consumerService = stringAt(consumer, 'serviceName');
  const consumerRepoPath = stringAt(consumer, 'repoPath');
  const consumerPath = stringAt(consumer, 'path');
  const providerService = stringAt(provider, 'serviceName');
  const providerRepoPath = stringAt(provider, 'repoPath');
  const providerContractPath = stringAt(provider, 'contractPath');
  if (!consumerService || !consumerPath || !providerService || !providerContractPath) {
    return {
      ok: false,
      reason: 'provenance requires consumer.serviceName, consumer.path, provider.serviceName, and provider.contractPath'
    };
  }

  const evidence = parseEvidence(objectAt(provenance, 'evidence'));
  return {
    ok: true,
    fields: {
      consumer: {
        serviceName: consumerService,
        ...(consumerRepoPath !== undefined ? { repoPath: consumerRepoPath } : {}),
        path: consumerPath
      },
      provider: {
        serviceName: providerService,
        ...(providerRepoPath !== undefined ? { repoPath: providerRepoPath } : {}),
        contractPath: providerContractPath
      },
      ...(evidence !== undefined ? { evidence } : {})
    }
  };
}

function parseEvidence(value: Record<string, unknown> | undefined): RequiredLinkFields['evidence'] | undefined {
  if (value === undefined) return undefined;
  const filePath = stringAt(value, 'filePath');
  const snippet = stringAt(value, 'snippet');
  if (filePath === undefined && snippet === undefined) return undefined;
  return {
    ...(filePath !== undefined ? { filePath } : {}),
    ...(snippet !== undefined ? { snippet } : {})
  };
}

function isCurrentWorkspaceMember(memberPath: string | null, provenanceRepoPath: string | undefined): boolean {
  if (memberPath === null) return false;
  return provenanceRepoPath === undefined || provenanceRepoPath === memberPath;
}

function staleDiagnostic(record: CrossRepoLinkRecord): CrossRepoDiagnostic {
  const staleParts: string[] = [];
  if (!record.source.inWorkspace) staleParts.push('source repo is not a current workspace member');
  if (!record.target.inWorkspace) staleParts.push('target repo is not a current workspace member');
  return {
    kind: 'stale_workspace_link',
    id: record.id,
    linkKind: record.kind,
    message: `cross-repo link ${record.id} is stale: ${staleParts.join('; ')}`
  };
}

function orphanBreakingDiagnostics(records: CrossRepoLinkRecord[]): CrossRepoDiagnostic[] {
  const consumesKeys = new Set(
    records
      .filter((record) => record.kind === 'CONSUMES_HTTP_ENDPOINT')
      .map((record) => consumesKey(record))
      .filter((key): key is string => key !== undefined)
  );
  return records
    .filter((record) => record.kind === 'BREAKS_COMPATIBILITY_WITH')
    .filter((record) => {
      const key = breakingKey(record);
      return key === undefined || !consumesKeys.has(key);
    })
    .map((record) => ({
      kind: 'orphan_breaking_link',
      id: record.id,
      linkKind: record.kind,
      message: `BREAKS_COMPATIBILITY_WITH link ${record.id} has no matching CONSUMES_HTTP_ENDPOINT parent`
    }));
}

function consumesKey(record: CrossRepoLinkRecord): string | undefined {
  if (record.endpoint === undefined) return undefined;
  return linkKey(record, record.endpoint.method, record.endpoint.path);
}

function breakingKey(record: CrossRepoLinkRecord): string | undefined {
  if (record.change?.method === undefined || record.change.path === undefined) return undefined;
  return linkKey(record, record.change.method, record.change.path);
}

function linkKey(record: CrossRepoLinkRecord, method: string, routePath: string): string {
  return [
    record.source.repoPath ?? '',
    record.source.path ?? '',
    record.target.repoPath ?? '',
    record.target.contractPath ?? '',
    endpointKey(method, routePath)
  ].join('\0');
}

function compareConsumerRows(left: CrossRepoConsumer, right: CrossRepoConsumer): number {
  return (
    left.consumerService.localeCompare(right.consumerService) ||
    left.consumerPath.localeCompare(right.consumerPath) ||
    left.providerService.localeCompare(right.providerService) ||
    left.providerContractPath.localeCompare(right.providerContractPath) ||
    left.httpMethod.localeCompare(right.httpMethod) ||
    left.routePath.localeCompare(right.routePath) ||
    left.linkId.localeCompare(right.linkId)
  );
}

function malformedDiagnostic(row: CrossRepoLinkRow, reason: string): CrossRepoDiagnostic {
  return {
    kind: 'malformed_link',
    id: row.id,
    linkKind: row.kind,
    message: `cross-repo link ${row.id} is malformed: ${reason}`
  };
}

function objectAt(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const child = value?.[key];
  return child !== null && typeof child === 'object' && !Array.isArray(child)
    ? child as Record<string, unknown>
    : undefined;
}

function stringAt(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const child = value?.[key];
  return typeof child === 'string' && child.length > 0 ? child : undefined;
}
