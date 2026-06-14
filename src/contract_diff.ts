import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import {
  classifyAsyncApiCompatibilityChanges,
  parseAsyncApiCompatibility,
  parseCurrentAsyncApiContract
} from './contract_diff/asyncapi.js';
import {
  classifyGraphqlCompatibilityChanges,
  parseCurrentGraphqlContract,
  parseGraphqlCompatibility
} from './contract_diff/graphql.js';
import {
  classifyOpenApiCompatibilityChanges,
  parseCurrentOpenApiContract,
  parseOpenApiCompatibility
} from './contract_diff/openapi.js';
import {
  classifyProtobufCompatibilityChanges,
  parseCurrentProtobufContract,
  parseProtobufCompatibility
} from './contract_diff/protobuf.js';
import { endpointKey, errorMessage, parseJsonObject } from './contract_diff/shared.js';
import type {
  ContractDiffChange,
  ContractDiffChangeKind,
  ContractDiffClassification,
  ContractEndpoint,
  CurrentContractParse
} from './contract_diff/types.js';
import { normalizeRepoRoot, resolveInsideRoot } from './security.js';
import { contentHash, ensureRepo, getRepoId, latestCompletedIndexRun, openDatabase } from './store.js';
import { listWorkspaces, type WorkspaceSummary } from './workspace.js';
import type { Confidence } from './types.js';

export type {
  ContractDiffChange,
  ContractDiffChangeKind,
  ContractDiffClassification
} from './contract_diff/types.js';

export type AnalyzeContractDiffOptions = {
  repoRoot: string;
  workspaceName?: string;
  providerServiceName?: string;
  providerRepoPath?: string;
  contractPath: string;
  persist?: boolean;
};

export type ContractDiffProvider = {
  serviceName: string;
  repoPath: string;
};

export type ContractDiffContract = {
  path: string;
  id: string;
  kind: string;
  schemaVersion?: string;
  previousContentHash: string;
  currentContentHash?: string;
  indexRunId: number;
};

export type ImpactedContractConsumer = {
  consumerService: string;
  consumerRepoPath: string;
  consumerPath: string;
  providerService: string;
  providerRepoPath: string;
  providerContractPath: string;
  httpMethod: string;
  routePath: string;
  evidenceSnippet: string;
  eventTopology?: EventTopologyProvenance;
};

export type EventTopologyProvenance = {
  providerAction: string;
  counterpartyRole: 'consumer' | 'producer' | 'unknown';
  pattern: string;
};

export type EventTopologySummary = EventTopologyProvenance & {
  count: number;
};

export type AnalyzeContractDiffResult = {
  workspace: WorkspaceSummary;
  provider: ContractDiffProvider;
  contract: ContractDiffContract;
  summary: {
    classification: ContractDiffClassification;
    breakingChangeCount: number;
    nonBreakingChangeCount: number;
    unknownChangeCount: number;
    impactedConsumerCount: number;
    eventTopologyCount?: number;
    eventTopologyBreakdown?: EventTopologySummary[];
  };
  changes: ContractDiffChange[];
  impactedConsumers: ImpactedContractConsumer[];
  warnings: string[];
};

type WorkspaceRow = {
  id: number;
  name: string;
};

type IndexedProvider = {
  repoPath: string;
  serviceName: string;
  db: ReturnType<typeof openDatabase>;
  repoId: number;
  indexRunId: number;
  contract: ContractBaselineRow;
};

type ContractBaselineRow = {
  id: string;
  kind: string;
  service_name: string | null;
  path: string;
  schema_version: string | null;
  content_hash: string;
  compatibility_json: string;
};

type EndpointRow = {
  endpoint_id: string;
  endpoint_display_name: string;
};

type ConsumesLinkRow = {
  provenance: string;
};

type PersistableBreakLink = {
  consumer: ImpactedContractConsumer;
  change: ContractDiffChange;
};

const ANALYZER_ID = 'contract-diff-v0';
const CONSUMES_LINK_KIND = 'CONSUMES_HTTP_ENDPOINT';
const BREAKS_LINK_KIND = 'BREAKS_COMPATIBILITY_WITH';

export function analyzeContractDiff(options: AnalyzeContractDiffOptions): AnalyzeContractDiffResult {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const contractPath = normalizeContractPath(options.contractPath);
  const workspace = selectWorkspace(repoRoot, options.workspaceName);
  const warnings: string[] = [];
  const provider = selectProvider(workspace, options, contractPath, warnings);
  try {
    const previousEndpoints = loadPreviousEndpoints(provider);
    const current = readCurrentContract(provider.repoPath, contractPath, provider.contract.kind, warnings);
    const changes = classifyChanges(provider, previousEndpoints, current, contractPath, warnings);
    const rootDb = openDatabase(repoRoot, { readOnly: options.persist === false });
    try {
      const workspaceRow = readWorkspaceRow(rootDb, workspace.name);
      const impactedConsumers = impactedConsumersForChanges(rootDb, workspaceRow.id, provider, contractPath, changes);
      if (options.persist !== false && canPersistDiff(changes)) {
        persistBreakingLinks(rootDb, workspaceRow.id, provider, contractPath, impactedConsumers, changes);
      }
      return {
        workspace,
        provider: {
          serviceName: provider.serviceName,
          repoPath: provider.repoPath
        },
        contract: {
          path: contractPath,
          id: provider.contract.id,
          kind: provider.contract.kind,
          ...(provider.contract.schema_version !== null ? { schemaVersion: provider.contract.schema_version } : {}),
          previousContentHash: provider.contract.content_hash,
          ...(current.contentHash !== undefined ? { currentContentHash: current.contentHash } : {}),
          indexRunId: provider.indexRunId
        },
        summary: summarizeChanges(changes, impactedConsumers),
        changes,
        impactedConsumers,
        warnings
      };
    } finally {
      rootDb.close();
    }
  } finally {
    provider.db.close();
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

function selectProvider(
  workspace: WorkspaceSummary,
  options: AnalyzeContractDiffOptions,
  contractPath: string,
  warnings: string[]
): IndexedProvider {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const requestedProviderPath = options.providerRepoPath === undefined
    ? undefined
    : realpathSync(
      path.isAbsolute(options.providerRepoPath)
        ? path.resolve(options.providerRepoPath)
        : path.resolve(repoRoot, options.providerRepoPath)
    );
  const candidates: IndexedProvider[] = [];
  for (const repo of workspace.repos) {
    let db: ReturnType<typeof openDatabase> | undefined;
    try {
      const repoPath = realpathSync(repo.localPath);
      if (requestedProviderPath !== undefined && repoPath !== requestedProviderPath) continue;
      if (options.providerServiceName !== undefined && repo.serviceName !== options.providerServiceName) continue;
      db = openDatabase(repoPath, { readOnly: true });
      const repoId = getRepoId(db, repoPath);
      const indexRunId = latestCompletedIndexRun(db, repoId);
      const contract = loadContractBaseline(db, repoId, indexRunId, contractPath);
      if (!contract) {
        db.close();
        db = undefined;
        continue;
      }
      candidates.push({
        repoPath,
        serviceName: repo.serviceName,
        db,
        repoId,
        indexRunId,
        contract
      });
      db = undefined;
    } catch (error) {
      db?.close();
      warnings.push(`workspace provider skipped: ${repo.localPath}: ${errorMessage(error)}`);
    }
  }

  if (candidates.length === 0) {
    throw new Error(`indexed contract not found in workspace: ${contractPath}`);
  }
  if (candidates.length > 1) {
    for (const candidate of candidates) candidate.db.close();
    throw new Error(`multiple workspace providers contain ${contractPath}; pass --provider or --provider-path`);
  }
  return candidates[0]!;
}

function loadContractBaseline(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  contractPath: string
): ContractBaselineRow | undefined {
  return db
    .prepare(
      `SELECT c.id, c.kind, c.service_name, c.path, v.schema_version, v.content_hash, v.compatibility_json
       FROM contracts c
       INNER JOIN contract_versions v
          ON v.contract_id = c.id
         AND v.index_run_id = ?
       WHERE c.repo_id = ?
         AND c.path = ?`
    )
    .get(indexRunId, repoId, contractPath) as ContractBaselineRow | undefined;
}

function loadPreviousEndpoints(provider: IndexedProvider): ContractEndpoint[] {
  const rows = provider.db
    .prepare(
      `SELECT target.id AS endpoint_id, target.display_name AS endpoint_display_name
       FROM relations relation
       INNER JOIN entities source
          ON source.id = relation.source_entity_id
         AND source.repo_id = relation.repo_id
       INNER JOIN entities target
          ON target.id = relation.target_entity_id
         AND target.repo_id = relation.repo_id
       WHERE relation.repo_id = ?
         AND relation.index_run_id = ?
         AND relation.kind = 'DECLARES'
         AND source.kind = 'contract'
         AND source.path = ?
         AND target.kind = 'endpoint'
       ORDER BY target.display_name, target.id`
    )
    .all(provider.repoId, provider.indexRunId, provider.contract.path) as EndpointRow[];
  return rows.flatMap((row) => {
    const parsed = endpointDisplayForContractKind(provider.contract.kind, row.endpoint_display_name);
    if (!parsed) return [];
    return [{
      endpointId: row.endpoint_id,
      httpMethod: parsed.method,
      routePath: parsed.path
    }];
  });
}

function readCurrentContract(
  providerRepoPath: string,
  contractPath: string,
  contractKind: string,
  warnings: string[]
): CurrentContractParse & { contentHash?: string } {
  let absolutePath: string;
  try {
    absolutePath = resolveInsideRoot(providerRepoPath, contractPath);
  } catch (error) {
    warnings.push(`contract file skipped: ${contractPath}: ${errorMessage(error)}`);
    return {
      ok: false,
      endpoints: [],
      warning: 'current contract file could not be read'
    };
  }

  let content: string;
  try {
    content = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    warnings.push(`contract file skipped: ${contractPath}: ${errorMessage(error)}`);
    return {
      ok: false,
      endpoints: [],
      warning: 'current contract file could not be read'
    };
  }

  const parsed = parseCurrentContractByKind(content, contractPath, contractKind);
  if (!parsed.ok && parsed.warning) {
    warnings.push(parsed.warning);
  }
  return {
    ...parsed,
    contentHash: sha256(content)
  };
}

function classifyChanges(
  provider: IndexedProvider,
  previousEndpoints: ContractEndpoint[],
  current: CurrentContractParse & { contentHash?: string },
  contractPath: string,
  warnings: string[]
): ContractDiffChange[] {
  if (!current.ok) {
    return [{
      kind: current.warning === 'current contract file could not be read'
        ? 'unreadable_current_contract'
        : 'unparsed_current_contract',
      classification: 'unknown',
      reason: current.warning ?? 'current contract could not be parsed'
    }];
  }

  const previousByKey = endpointsByKey(previousEndpoints);
  const currentByKey = endpointsByKey(
    current.endpoints.map((endpoint) => ({
      ...endpoint,
      endpointId: endpoint.endpointId ?? currentEndpointId(contractPath, endpoint)
    }))
  );
  const changes: ContractDiffChange[] = [];

  for (const [key, endpoint] of currentByKey) {
    if (previousByKey.has(key)) continue;
    changes.push({
      kind: 'added_endpoint',
      classification: 'non-breaking',
      reason: 'endpoint added to current contract',
      httpMethod: endpoint.httpMethod,
      routePath: endpoint.routePath,
      ...(endpoint.endpointId !== undefined ? { currentEndpointId: endpoint.endpointId } : {})
    });
  }

  for (const [key, endpoint] of previousByKey) {
    if (currentByKey.has(key)) continue;
    changes.push({
      kind: 'removed_endpoint',
      classification: 'breaking',
      reason: 'endpoint removed from current contract',
      httpMethod: endpoint.httpMethod,
      routePath: endpoint.routePath,
      ...(endpoint.endpointId !== undefined ? { previousEndpointId: endpoint.endpointId } : {})
    });
  }

  if (provider.contract.kind === 'protobuf') {
    const previousCompatibility = parseProtobufCompatibility(provider.contract.compatibility_json, warnings);
    if (previousCompatibility !== undefined && current.protobufCompatibility !== undefined) {
      changes.push(...classifyProtobufCompatibilityChanges(previousCompatibility, current.protobufCompatibility));
    }
  } else if (provider.contract.kind === 'graphql') {
    const previousCompatibility = parseGraphqlCompatibility(provider.contract.compatibility_json, warnings);
    if (previousCompatibility !== undefined && current.graphqlCompatibility !== undefined) {
      changes.push(...classifyGraphqlCompatibilityChanges(previousCompatibility, current.graphqlCompatibility));
    }
  } else if (provider.contract.kind === 'asyncapi') {
    const previousCompatibility = parseAsyncApiCompatibility(provider.contract.compatibility_json, warnings);
    if (previousCompatibility !== undefined && current.asyncApiCompatibility !== undefined) {
      changes.push(...classifyAsyncApiCompatibilityChanges(previousCompatibility, current.asyncApiCompatibility));
    }
  } else {
    const previousCompatibility = parseOpenApiCompatibility(provider.contract.compatibility_json, warnings);
    if (previousCompatibility !== undefined && current.compatibility !== undefined) {
      changes.push(...classifyOpenApiCompatibilityChanges(previousCompatibility, current.compatibility));
    }
  }

  if (changes.length === 0 && current.contentHash !== undefined && current.contentHash !== provider.contract.content_hash) {
    changes.push({
      kind: 'changed_contract_without_endpoint_delta',
      classification: 'unknown',
      reason: 'contract content changed but endpoint surface is unchanged in the v0 analyzer'
    });
  }

  return changes.sort(compareChanges);
}

function impactedConsumersForChanges(
  db: ReturnType<typeof openDatabase>,
  workspaceId: number,
  provider: IndexedProvider,
  contractPath: string,
  changes: ContractDiffChange[]
): ImpactedContractConsumer[] {
  const breakingEndpointKeys = new Set(
    changes
      .filter((change) => change.classification === 'breaking' && change.httpMethod && change.routePath)
      .map((change) => endpointKey(change.httpMethod!, change.routePath!))
  );
  if (breakingEndpointKeys.size === 0) return [];

  const rows = db
    .prepare(
      `SELECT link.provenance AS provenance
       FROM cross_repo_links link
       INNER JOIN workspace_repos source_member
          ON source_member.workspace_id = link.workspace_id
         AND source_member.repo_id = link.source_repo_id
       INNER JOIN workspace_repos target_member
          ON target_member.workspace_id = link.workspace_id
         AND target_member.repo_id = link.target_repo_id
       WHERE link.workspace_id = ?
         AND link.kind = ?
       ORDER BY link.id`
    )
    .all(workspaceId, CONSUMES_LINK_KIND) as ConsumesLinkRow[];
  const consumers: ImpactedContractConsumer[] = [];
  for (const row of rows) {
    const link = parseConsumesLink(row.provenance);
    if (!link) continue;
    if (link.provider.repoPath !== provider.repoPath) continue;
    if (link.provider.contractPath !== contractPath) continue;
    if (!breakingEndpointKeys.has(endpointKey(link.http.method, link.http.path))) continue;
    consumers.push({
      consumerService: link.consumer.serviceName,
      consumerRepoPath: link.consumer.repoPath,
      consumerPath: link.consumer.path,
      providerService: provider.serviceName,
      providerRepoPath: provider.repoPath,
      providerContractPath: contractPath,
      httpMethod: link.http.method,
      routePath: link.http.path,
      evidenceSnippet: link.evidence.snippet,
      ...(link.eventTopology !== undefined ? { eventTopology: link.eventTopology } : {})
    });
  }
  return dedupeConsumers(consumers).sort(compareConsumers);
}

function persistBreakingLinks(
  db: ReturnType<typeof openDatabase>,
  workspaceId: number,
  provider: IndexedProvider,
  contractPath: string,
  impactedConsumers: ImpactedContractConsumer[],
  changes: ContractDiffChange[]
): void {
  const breakingByKey = new Map(
    changes.reduce<Array<[string, ContractDiffChange[]]>>((entries, change) => {
      if (change.classification !== 'breaking' || !change.httpMethod || !change.routePath) return entries;
      const key = endpointKey(change.httpMethod, change.routePath);
      const existing = entries.find(([entryKey]) => entryKey === key);
      if (existing) {
        existing[1].push(change);
      } else {
        entries.push([key, [change]]);
      }
      return entries;
    }, [])
  );
  const links = impactedConsumers.flatMap((consumer): PersistableBreakLink[] => {
    const endpointChanges = breakingByKey.get(endpointKey(consumer.httpMethod, consumer.routePath)) ?? [];
    return endpointChanges.map((change) => ({ consumer, change }));
  });

  db.exec('BEGIN');
  try {
    deleteExistingBreakingLinksForContract(db, workspaceId, provider, contractPath);
    const insert = db.prepare(
      `INSERT OR REPLACE INTO cross_repo_links (
         id, workspace_id, source_repo_id, target_repo_id, source_entity_id,
         target_entity_id, kind, confidence, provenance, index_run_id
       )
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`
    );
    for (const link of links) {
      const sourceRepoId = ensureRepo(db, link.consumer.consumerRepoPath);
      const targetRepoId = ensureRepo(db, provider.repoPath);
      insert.run(
        breakingLinkId(workspaceId, link),
        workspaceId,
        sourceRepoId,
        targetRepoId,
        BREAKS_LINK_KIND,
        'heuristic' satisfies Confidence,
        breakingLinkProvenance(link)
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function deleteExistingBreakingLinksForContract(
  db: ReturnType<typeof openDatabase>,
  workspaceId: number,
  provider: IndexedProvider,
  contractPath: string
): void {
  const rows = db
    .prepare(
      `SELECT id, provenance
       FROM cross_repo_links
       WHERE workspace_id = ?
         AND kind = ?`
    )
    .all(workspaceId, BREAKS_LINK_KIND) as Array<{ id: string; provenance: string }>;
  const deleteRow = db.prepare('DELETE FROM cross_repo_links WHERE id = ?');
  for (const row of rows) {
    const provenance = parseJsonObject(row.provenance);
    const providerObject = objectAt(provenance, 'provider');
    if (
      stringAt(providerObject, 'repoPath') === provider.repoPath &&
      stringAt(providerObject, 'contractPath') === contractPath
    ) {
      deleteRow.run(row.id);
    }
  }
}

function readWorkspaceRow(db: ReturnType<typeof openDatabase>, workspaceName: string): WorkspaceRow {
  const workspace = db
    .prepare('SELECT id, name FROM workspaces WHERE name = ?')
    .get(workspaceName) as WorkspaceRow | undefined;
  if (!workspace) {
    throw new Error(`workspace not found after sync: ${workspaceName}`);
  }
  return workspace;
}

function summarizeChanges(
  changes: ContractDiffChange[],
  impactedConsumers: ImpactedContractConsumer[]
): AnalyzeContractDiffResult['summary'] {
  const breakingChangeCount = changes.filter((change) => change.classification === 'breaking').length;
  const nonBreakingChangeCount = changes.filter((change) => change.classification === 'non-breaking').length;
  const unknownChangeCount = changes.filter((change) => change.classification === 'unknown').length;
  const eventTopologyBreakdown = summarizeEventTopology(impactedConsumers);
  return {
    classification: breakingChangeCount > 0
      ? 'breaking'
      : unknownChangeCount > 0
        ? 'unknown'
        : nonBreakingChangeCount > 0
          ? 'non-breaking'
          : 'unchanged',
    breakingChangeCount,
    nonBreakingChangeCount,
    unknownChangeCount,
    impactedConsumerCount: impactedConsumers.length,
    ...(eventTopologyBreakdown.length > 0
      ? {
          eventTopologyCount: eventTopologyBreakdown.reduce((total, item) => total + item.count, 0),
          eventTopologyBreakdown
        }
      : {})
  };
}

function summarizeEventTopology(impactedConsumers: ImpactedContractConsumer[]): EventTopologySummary[] {
  const byKey = new Map<string, EventTopologySummary>();
  for (const consumer of impactedConsumers) {
    if (consumer.eventTopology === undefined) continue;
    const key = [
      consumer.eventTopology.providerAction,
      consumer.eventTopology.counterpartyRole,
      consumer.eventTopology.pattern
    ].join('\0');
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    byKey.set(key, {
      ...consumer.eventTopology,
      count: 1
    });
  }
  return [...byKey.values()].sort((a, b) =>
    a.providerAction.localeCompare(b.providerAction) ||
    a.counterpartyRole.localeCompare(b.counterpartyRole) ||
    a.pattern.localeCompare(b.pattern)
  );
}

function canPersistDiff(changes: ContractDiffChange[]): boolean {
  return !changes.some((change) =>
    change.kind === 'unreadable_current_contract' || change.kind === 'unparsed_current_contract'
  );
}

function parseCurrentContractByKind(content: string, contractPath: string, contractKind: string): CurrentContractParse {
  const lowerPath = contractPath.toLowerCase();
  if (contractKind === 'protobuf' || lowerPath.endsWith('.proto')) return parseCurrentProtobufContract(content);
  if (contractKind === 'graphql' || lowerPath.endsWith('.graphql') || lowerPath.endsWith('.gql')) {
    return parseCurrentGraphqlContract(content);
  }
  if (contractKind === 'asyncapi' || isAsyncApiContractPath(contractPath)) return parseCurrentAsyncApiContract(content, contractPath);
  return parseCurrentOpenApiContract(content, contractPath);
}

function parseConsumesLink(provenanceJson: string): {
  consumer: { serviceName: string; repoPath: string; path: string };
  provider: { repoPath: string; contractPath: string };
  http: { method: string; path: string };
  evidence: { snippet: string };
  eventTopology?: EventTopologyProvenance;
} | undefined {
  const provenance = parseJsonObject(provenanceJson);
  const consumer = objectAt(provenance, 'consumer');
  const provider = objectAt(provenance, 'provider');
  const http = objectAt(provenance, 'http');
  const evidence = objectAt(provenance, 'evidence');
  const eventTopology = parseEventTopology(objectAt(provenance, 'eventTopology'));
  const parsed = {
    consumer: {
      serviceName: stringAt(consumer, 'serviceName'),
      repoPath: stringAt(consumer, 'repoPath'),
      path: stringAt(consumer, 'path')
    },
    provider: {
      repoPath: stringAt(provider, 'repoPath'),
      contractPath: stringAt(provider, 'contractPath')
    },
    http: {
      method: stringAt(http, 'method'),
      path: stringAt(http, 'path')
    },
    evidence: {
      snippet: stringAt(evidence, 'snippet')
    },
    ...(eventTopology !== undefined ? { eventTopology } : {})
  };
  if (
    !parsed.consumer.serviceName ||
    !parsed.consumer.repoPath ||
    !parsed.consumer.path ||
    !parsed.provider.repoPath ||
    !parsed.provider.contractPath ||
    !parsed.http.method ||
    !parsed.http.path
  ) {
    return undefined;
  }
  return parsed;
}

function parseEventTopology(value: Record<string, unknown> | undefined): EventTopologyProvenance | undefined {
  if (value === undefined) return undefined;
  const rawCounterpartyRole = stringAt(value, 'counterpartyRole');
  if (rawCounterpartyRole !== 'consumer' && rawCounterpartyRole !== 'producer' && rawCounterpartyRole !== 'unknown') {
    return undefined;
  }
  const parsed = {
    providerAction: stringAt(value, 'providerAction'),
    counterpartyRole: rawCounterpartyRole,
    pattern: stringAt(value, 'pattern')
  } satisfies EventTopologyProvenance;
  if (!parsed.providerAction || !parsed.pattern) return undefined;
  return parsed;
}

function endpointsByKey(endpoints: ContractEndpoint[]): Map<string, ContractEndpoint> {
  const byKey = new Map<string, ContractEndpoint>();
  for (const endpoint of endpoints) {
    const key = endpointKey(endpoint.httpMethod, endpoint.routePath);
    if (!byKey.has(key)) byKey.set(key, endpoint);
  }
  return byKey;
}

function currentEndpointId(contractPath: string, endpoint: ContractEndpoint): string {
  const lowerPath = contractPath.toLowerCase();
  const languageId = isAsyncApiContractPath(contractPath)
    ? 'asyncapi'
    : lowerPath.endsWith('.proto')
    ? 'protobuf'
    : lowerPath.endsWith('.graphql') || lowerPath.endsWith('.gql')
      ? 'graphql'
      : lowerPath.endsWith('.json')
        ? 'json'
        : 'yaml';
  if (languageId === 'protobuf' && endpoint.httpMethod === 'RPC') {
    return `endpoint:protobuf:${endpoint.routePath.replace('/', '.')}`;
  }
  if (languageId === 'graphql' && endpoint.httpMethod === 'GRAPHQL') {
    return `endpoint:graphql:${endpoint.routePath}`;
  }
  if (languageId === 'asyncapi') {
    return `endpoint:asyncapi:${endpointKey(endpoint.httpMethod, endpoint.routePath)}`;
  }
  return `endpoint:${languageId}:${endpointKey(endpoint.httpMethod, endpoint.routePath)}`;
}

function endpointDisplayForContractKind(kind: string, displayName: string): { method: string; path: string } | undefined {
  if (kind === 'protobuf') return parseProtobufEndpointDisplay(displayName);
  if (kind === 'graphql') return parseGraphqlEndpointDisplay(displayName);
  if (kind === 'asyncapi') return parseAsyncApiEndpointDisplay(displayName);
  return parseHttpEndpointDisplay(displayName);
}

function parseHttpEndpointDisplay(displayName: string): { method: string; path: string } | undefined {
  const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(\S+)$/i.exec(displayName.trim());
  if (!match) return undefined;
  return { method: match[1]!.toUpperCase(), path: match[2]! };
}

function parseProtobufEndpointDisplay(displayName: string): { method: string; path: string } | undefined {
  const match = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(displayName.trim());
  if (!match) return undefined;
  return { method: 'RPC', path: `${match[1]!}/${match[2]!}` };
}

function parseGraphqlEndpointDisplay(displayName: string): { method: string; path: string } | undefined {
  const match = /^(Query|Mutation|Subscription)\.([A-Za-z_]\w*)$/.exec(displayName.trim());
  if (!match) return undefined;
  return { method: 'GRAPHQL', path: `${match[1]!}.${match[2]!}` };
}

function parseAsyncApiEndpointDisplay(displayName: string): { method: string; path: string } | undefined {
  const match = /^([A-Z][A-Z0-9_-]*)\s+(.+)$/.exec(displayName.trim());
  if (!match) return undefined;
  return { method: match[1]!, path: match[2]! };
}

function isAsyncApiContractPath(contractPath: string): boolean {
  const basename = path.posix.basename(contractPath);
  return basename.replace(/\.[^.]+$/, '').toLowerCase().includes('asyncapi');
}

function compareChanges(left: ContractDiffChange, right: ContractDiffChange): number {
  const kindOrder = changeKindOrder(left.kind) - changeKindOrder(right.kind);
  if (kindOrder !== 0) return kindOrder;
  return (
    (left.routePath ?? '').localeCompare(right.routePath ?? '') ||
    (left.httpMethod ?? '').localeCompare(right.httpMethod ?? '') ||
    (left.statusCode ?? '').localeCompare(right.statusCode ?? '') ||
    (left.schemaPath ?? '').localeCompare(right.schemaPath ?? '') ||
    (left.propertyName ?? '').localeCompare(right.propertyName ?? '')
  );
}

function changeKindOrder(kind: ContractDiffChangeKind): number {
  if (kind === 'added_endpoint') return 0;
  if (kind === 'removed_endpoint') return 1;
  if (kind === 'removed_response_status') return 2;
  if (kind === 'removed_response_required_property') return 3;
  if (kind === 'changed_response_property_type') return 4;
  if (kind === 'added_request_required_property') return 5;
  if (kind === 'changed_request_property_type') return 6;
  return 7;
}

function dedupeConsumers(consumers: ImpactedContractConsumer[]): ImpactedContractConsumer[] {
  const byKey = new Map<string, ImpactedContractConsumer>();
  for (const consumer of consumers) {
    const key = [
      consumer.consumerRepoPath,
      consumer.consumerPath,
      consumer.providerRepoPath,
      consumer.providerContractPath,
      consumer.httpMethod,
      consumer.routePath
    ].join('\0');
    if (!byKey.has(key)) byKey.set(key, consumer);
  }
  return [...byKey.values()];
}

function compareConsumers(left: ImpactedContractConsumer, right: ImpactedContractConsumer): number {
  return (
    left.consumerService.localeCompare(right.consumerService) ||
    left.consumerPath.localeCompare(right.consumerPath) ||
    left.providerService.localeCompare(right.providerService) ||
    left.httpMethod.localeCompare(right.httpMethod) ||
    left.routePath.localeCompare(right.routePath)
  );
}

function breakingLinkId(workspaceId: number, link: PersistableBreakLink): string {
  return contentHash(
    ANALYZER_ID,
    String(workspaceId),
    link.consumer.consumerRepoPath,
    link.consumer.consumerPath,
    link.consumer.providerRepoPath,
    link.consumer.providerContractPath,
    link.consumer.httpMethod,
    link.consumer.routePath,
    changeFingerprint(link.change)
  ).slice(0, 24);
}

function breakingLinkProvenance(link: PersistableBreakLink): string {
  return stableJson({
    schemaVersion: 1,
    analyzer: ANALYZER_ID,
    classification: link.change.classification,
    consumer: {
      serviceName: link.consumer.consumerService,
      repoPath: link.consumer.consumerRepoPath,
      path: link.consumer.consumerPath
    },
    provider: {
      serviceName: link.consumer.providerService,
      repoPath: link.consumer.providerRepoPath,
      contractPath: link.consumer.providerContractPath
    },
    change: {
      kind: link.change.kind,
      method: link.consumer.httpMethod,
      path: link.consumer.routePath,
      ...(link.change.previousEndpointId !== undefined ? { previousEndpointId: link.change.previousEndpointId } : {}),
      ...(link.change.currentEndpointId !== undefined ? { currentEndpointId: link.change.currentEndpointId } : {}),
      ...(link.change.statusCode !== undefined ? { statusCode: link.change.statusCode } : {}),
      ...(link.change.propertyName !== undefined ? { propertyName: link.change.propertyName } : {}),
      ...(link.change.schemaPath !== undefined ? { schemaPath: link.change.schemaPath } : {}),
      ...(link.change.previousSchemaType !== undefined ? { previousSchemaType: link.change.previousSchemaType } : {}),
      ...(link.change.currentSchemaType !== undefined ? { currentSchemaType: link.change.currentSchemaType } : {})
    },
    ...(link.consumer.eventTopology !== undefined ? { eventTopology: link.consumer.eventTopology } : {}),
    evidence: {
      filePath: link.consumer.consumerPath,
      snippet: link.consumer.evidenceSnippet
    }
  });
}

function changeFingerprint(change: ContractDiffChange): string {
  return stableJson({
    kind: change.kind,
    method: change.httpMethod,
    path: change.routePath,
    statusCode: change.statusCode,
    propertyName: change.propertyName,
    schemaPath: change.schemaPath,
    previousSchemaType: change.previousSchemaType,
    currentSchemaType: change.currentSchemaType
  });
}

function normalizeContractPath(contractPath: string): string {
  if (!contractPath || contractPath.includes('\0') || path.isAbsolute(contractPath)) {
    throw new Error('contract path must be repo-relative');
  }
  const normalized = path.posix.normalize(contractPath.split(path.sep).join('/'));
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized.endsWith('/..')
  ) {
    throw new Error('contract path must be repo-relative');
  }
  return normalized.replace(/^\.\//, '');
}

function objectAt(source: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = source?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringAt(source: Record<string, unknown> | undefined, key: string): string {
  const value = source?.[key];
  return typeof value === 'string' ? value : '';
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

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
