import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import {
  extractOpenApiJsonCompatibility,
  extractOpenApiYamlCompatibility,
  OPENAPI_COMPAT_ANALYZER_ID,
  OPENAPI_COMPAT_SCHEMA_VERSION,
  parseOpenApiYamlCompatibility,
  type OpenApiCompatibilityOperation,
  type OpenApiCompatibilitySignature,
  type OpenApiObjectSchemaSignature,
  type OpenApiResponseSignature
} from './openapi_compat.js';
import {
  extractProtobufCompatibility,
  PROTOBUF_COMPAT_ANALYZER_ID,
  PROTOBUF_COMPAT_SCHEMA_VERSION,
  type ProtobufCompatibilitySignature,
  type ProtobufFieldSignature,
  type ProtobufMessageSignature,
  type ProtobufOperationSignature
} from './protobuf_compat.js';
import { normalizeRepoRoot, resolveInsideRoot } from './security.js';
import { contentHash, ensureRepo, getRepoId, latestCompletedIndexRun, openDatabase } from './store.js';
import { listWorkspaces, type WorkspaceSummary } from './workspace.js';
import type { Confidence } from './types.js';

export type ContractDiffClassification = 'breaking' | 'non-breaking' | 'unknown' | 'unchanged';

export type ContractDiffChangeKind =
  | 'removed_endpoint'
  | 'added_endpoint'
  | 'removed_response_status'
  | 'removed_response_required_property'
  | 'changed_response_property_type'
  | 'added_request_required_property'
  | 'changed_request_property_type'
  | 'unreadable_current_contract'
  | 'unparsed_current_contract'
  | 'changed_contract_without_endpoint_delta';

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

export type ContractDiffChange = {
  kind: ContractDiffChangeKind;
  classification: ContractDiffClassification;
  reason: string;
  httpMethod?: string;
  routePath?: string;
  previousEndpointId?: string;
  currentEndpointId?: string;
  statusCode?: string;
  propertyName?: string;
  schemaPath?: string;
  previousSchemaType?: string;
  currentSchemaType?: string;
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

type ContractEndpoint = {
  endpointId?: string;
  httpMethod: string;
  routePath: string;
};

type CurrentYamlRoute = {
  path: string;
  indent: number;
  childIndent?: number;
};

type CurrentContractParse = {
  ok: boolean;
  endpoints: ContractEndpoint[];
  compatibility?: OpenApiCompatibilitySignature;
  protobufCompatibility?: ProtobufCompatibilitySignature;
  warning?: string;
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
const OPENAPI_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

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
    const parsed = provider.contract.kind === 'protobuf'
      ? parseProtobufEndpointDisplay(row.endpoint_display_name)
      : parseHttpEndpointDisplay(row.endpoint_display_name);
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

  const parsed = contractKind === 'protobuf' || contractPath.toLowerCase().endsWith('.proto')
    ? parseCurrentProtobufContract(content)
    : parseCurrentOpenApiContract(content, contractPath);
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

function classifyOpenApiCompatibilityChanges(
  previous: OpenApiCompatibilitySignature,
  current: OpenApiCompatibilitySignature
): ContractDiffChange[] {
  const previousByKey = compatibilityOperationsByKey(previous.operations);
  const currentByKey = compatibilityOperationsByKey(current.operations);
  const changes: ContractDiffChange[] = [];
  for (const [key, previousOperation] of previousByKey) {
    const currentOperation = currentByKey.get(key);
    if (!currentOperation) continue;
    changes.push(...classifyRequestBodyChanges(previousOperation, currentOperation));
    changes.push(...classifyResponseBodyChanges(previousOperation, currentOperation));
  }
  return changes;
}

function classifyProtobufCompatibilityChanges(
  previous: ProtobufCompatibilitySignature,
  current: ProtobufCompatibilitySignature
): ContractDiffChange[] {
  const previousOperations = protobufOperationsByKey(previous.operations);
  const currentOperations = protobufOperationsByKey(current.operations);
  const previousMessages = protobufMessagesByName(previous.messages);
  const currentMessages = protobufMessagesByName(current.messages);
  const changes: ContractDiffChange[] = [];

  for (const [key, previousOperation] of previousOperations) {
    const currentOperation = currentOperations.get(key);
    if (!currentOperation) continue;
    changes.push(...classifyProtobufRpcTypeChanges(previousOperation, currentOperation));
    changes.push(...classifyProtobufMessageChanges({
      operation: currentOperation,
      previousMessage: previousMessages.get(previousOperation.requestType),
      currentMessage: currentMessages.get(currentOperation.requestType),
      direction: 'request'
    }));
    changes.push(...classifyProtobufMessageChanges({
      operation: currentOperation,
      previousMessage: previousMessages.get(previousOperation.responseType),
      currentMessage: currentMessages.get(currentOperation.responseType),
      direction: 'response'
    }));
  }

  return changes;
}

function classifyProtobufRpcTypeChanges(
  previousOperation: ProtobufOperationSignature,
  currentOperation: ProtobufOperationSignature
): ContractDiffChange[] {
  const changes: ContractDiffChange[] = [];
  if (
    previousOperation.requestType !== currentOperation.requestType ||
    previousOperation.requestStream !== currentOperation.requestStream
  ) {
    changes.push({
      kind: 'changed_request_property_type',
      classification: 'breaking',
      reason: 'protobuf RPC request type changed in current contract',
      httpMethod: 'RPC',
      routePath: currentOperation.path,
      propertyName: '$',
      schemaPath: 'request',
      previousSchemaType: protobufRpcType(previousOperation.requestType, previousOperation.requestStream),
      currentSchemaType: protobufRpcType(currentOperation.requestType, currentOperation.requestStream)
    });
  }
  if (
    previousOperation.responseType !== currentOperation.responseType ||
    previousOperation.responseStream !== currentOperation.responseStream
  ) {
    changes.push({
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'protobuf RPC response type changed in current contract',
      httpMethod: 'RPC',
      routePath: currentOperation.path,
      propertyName: '$',
      schemaPath: 'response',
      previousSchemaType: protobufRpcType(previousOperation.responseType, previousOperation.responseStream),
      currentSchemaType: protobufRpcType(currentOperation.responseType, currentOperation.responseStream)
    });
  }
  return changes;
}

function classifyProtobufMessageChanges(options: {
  operation: ProtobufOperationSignature;
  previousMessage: ProtobufMessageSignature | undefined;
  currentMessage: ProtobufMessageSignature | undefined;
  direction: 'request' | 'response';
}): ContractDiffChange[] {
  if (options.previousMessage === undefined || options.currentMessage === undefined) return [];
  const currentFields = protobufFieldsByNumber(options.currentMessage.fields);
  const changes: ContractDiffChange[] = [];
  for (const previousField of options.previousMessage.fields) {
    const currentField = currentFields.get(previousField.number);
    const propertyName = protobufFieldDisplayName(options.previousMessage, previousField);
    const schemaPath = `${options.direction}.${shortProtobufTypeName(options.previousMessage.name)}.fields.${previousField.number}`;
    if (!currentField) {
      changes.push({
        kind: options.direction === 'request' ? 'changed_request_property_type' : 'removed_response_required_property',
        classification: 'breaking',
        reason: options.direction === 'request'
          ? 'protobuf request field removed from current contract'
          : 'protobuf response field removed from current contract',
        httpMethod: 'RPC',
        routePath: options.operation.path,
        propertyName,
        schemaPath
      });
      continue;
    }
    const previousType = protobufFieldType(previousField);
    const currentType = protobufFieldType(currentField);
    if (previousType === currentType && previousField.name === currentField.name) continue;
    changes.push({
      kind: options.direction === 'request' ? 'changed_request_property_type' : 'changed_response_property_type',
      classification: 'breaking',
      reason: options.direction === 'request'
        ? 'protobuf request field type changed in current contract'
        : 'protobuf response field type changed in current contract',
      httpMethod: 'RPC',
      routePath: options.operation.path,
      propertyName,
      schemaPath,
      previousSchemaType: previousType,
      currentSchemaType: currentType
    });
  }
  return changes;
}

function classifyRequestBodyChanges(
  previousOperation: OpenApiCompatibilityOperation,
  currentOperation: OpenApiCompatibilityOperation
): ContractDiffChange[] {
  const previousBody = previousOperation.requestBody;
  const currentBody = currentOperation.requestBody;
  if (currentBody === undefined) return [];
  const changes: ContractDiffChange[] = [];
  const previousRequired = new Set(previousBody?.required ?? []);
  for (const propertyName of currentBody.required) {
    if (previousRequired.has(propertyName)) continue;
    changes.push({
      kind: 'added_request_required_property',
      classification: 'breaking',
      reason: 'request required property added to current contract',
      httpMethod: currentOperation.method,
      routePath: currentOperation.path,
      propertyName,
      schemaPath: `requestBody.required.${propertyName}`
    });
  }
  changes.push(...classifyPropertyTypeChanges({
    kind: 'changed_request_property_type',
    reason: 'request property type changed in current contract',
    httpMethod: currentOperation.method,
    routePath: currentOperation.path,
    schemaPathPrefix: 'requestBody.properties',
    previousBody,
    currentBody
  }));
  return changes;
}

function classifyResponseBodyChanges(
  previousOperation: OpenApiCompatibilityOperation,
  currentOperation: OpenApiCompatibilityOperation
): ContractDiffChange[] {
  const previousResponses = responsesByStatus(previousOperation.responses);
  const currentResponses = responsesByStatus(currentOperation.responses);
  const changes: ContractDiffChange[] = [];
  for (const [statusCode, previousResponse] of previousResponses) {
    const currentResponse = currentResponses.get(statusCode);
    if (!currentResponse) {
      changes.push({
        kind: 'removed_response_status',
        classification: 'breaking',
        reason: 'response status removed from current contract',
        httpMethod: previousOperation.method,
        routePath: previousOperation.path,
        statusCode,
        schemaPath: `responses.${statusCode}`
      });
      continue;
    }
    const previousBody = previousResponse.body;
    if (previousBody === undefined) continue;
    const currentBody = currentResponse.body;
    const currentRequired = new Set(currentBody?.required ?? []);
    for (const propertyName of previousBody.required) {
      if (currentRequired.has(propertyName)) continue;
      changes.push({
        kind: 'removed_response_required_property',
        classification: 'breaking',
        reason: 'response required property removed from current contract',
        httpMethod: previousOperation.method,
        routePath: previousOperation.path,
        statusCode,
        propertyName,
        schemaPath: `responses.${statusCode}.body.required.${propertyName}`
      });
    }
    changes.push(...classifyPropertyTypeChanges({
      kind: 'changed_response_property_type',
      reason: 'response property type changed in current contract',
      httpMethod: previousOperation.method,
      routePath: previousOperation.path,
      statusCode,
      schemaPathPrefix: `responses.${statusCode}.body.properties`,
      previousBody,
      currentBody
    }));
  }
  return changes;
}

function classifyPropertyTypeChanges(options: {
  kind: 'changed_request_property_type' | 'changed_response_property_type';
  reason: string;
  httpMethod: string;
  routePath: string;
  statusCode?: string;
  schemaPathPrefix: string;
  previousBody: OpenApiObjectSchemaSignature | undefined;
  currentBody: OpenApiObjectSchemaSignature | undefined;
}): ContractDiffChange[] {
  if (options.previousBody === undefined || options.currentBody === undefined) return [];
  const changes: ContractDiffChange[] = [];
  for (const [propertyName, previousProperty] of Object.entries(options.previousBody.properties)) {
    const currentProperty = options.currentBody.properties[propertyName];
    if (currentProperty === undefined) continue;
    if (previousProperty.type === currentProperty.type) continue;
    changes.push({
      kind: options.kind,
      classification: 'breaking',
      reason: options.reason,
      httpMethod: options.httpMethod,
      routePath: options.routePath,
      ...(options.statusCode !== undefined ? { statusCode: options.statusCode } : {}),
      propertyName,
      schemaPath: `${options.schemaPathPrefix}.${propertyName}`,
      previousSchemaType: previousProperty.type,
      currentSchemaType: currentProperty.type
    });
  }
  return changes;
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
      evidenceSnippet: link.evidence.snippet
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
    impactedConsumerCount: impactedConsumers.length
  };
}

function canPersistDiff(changes: ContractDiffChange[]): boolean {
  return !changes.some((change) =>
    change.kind === 'unreadable_current_contract' || change.kind === 'unparsed_current_contract'
  );
}

function parseOpenApiCompatibility(
  compatibilityJson: string,
  warnings: string[]
): OpenApiCompatibilitySignature | undefined {
  const parsed = parseJsonObject(compatibilityJson);
  if (
    parsed?.analyzer === OPENAPI_COMPAT_ANALYZER_ID &&
    parsed.schemaVersion !== undefined &&
    parsed.schemaVersion !== OPENAPI_COMPAT_SCHEMA_VERSION
  ) {
    warnings.push(
      `indexed OpenAPI compatibility baseline uses schemaVersion ${String(parsed.schemaVersion)}; reindex provider contract for schemaVersion ${OPENAPI_COMPAT_SCHEMA_VERSION}`
    );
    return undefined;
  }
  if (
    parsed?.schemaVersion !== OPENAPI_COMPAT_SCHEMA_VERSION ||
    parsed.analyzer !== OPENAPI_COMPAT_ANALYZER_ID ||
    !Array.isArray(parsed.operations)
  ) {
    return undefined;
  }
  return parsed as OpenApiCompatibilitySignature;
}

function parseProtobufCompatibility(
  compatibilityJson: string,
  warnings: string[]
): ProtobufCompatibilitySignature | undefined {
  const parsed = parseJsonObject(compatibilityJson);
  if (
    parsed?.analyzer === PROTOBUF_COMPAT_ANALYZER_ID &&
    parsed.schemaVersion !== undefined &&
    parsed.schemaVersion !== PROTOBUF_COMPAT_SCHEMA_VERSION
  ) {
    warnings.push(
      `indexed Protobuf compatibility baseline uses schemaVersion ${String(parsed.schemaVersion)}; reindex provider contract for schemaVersion ${PROTOBUF_COMPAT_SCHEMA_VERSION}`
    );
    return undefined;
  }
  if (
    parsed?.schemaVersion !== PROTOBUF_COMPAT_SCHEMA_VERSION ||
    parsed.analyzer !== PROTOBUF_COMPAT_ANALYZER_ID ||
    parsed.contractKind !== 'protobuf' ||
    !Array.isArray(parsed.operations) ||
    !Array.isArray(parsed.messages)
  ) {
    return undefined;
  }
  return parsed as ProtobufCompatibilitySignature;
}

function compatibilityOperationsByKey(
  operations: readonly OpenApiCompatibilityOperation[]
): Map<string, OpenApiCompatibilityOperation> {
  const byKey = new Map<string, OpenApiCompatibilityOperation>();
  for (const operation of operations) {
    byKey.set(endpointKey(operation.method, operation.path), operation);
  }
  return byKey;
}

function protobufOperationsByKey(
  operations: readonly ProtobufOperationSignature[]
): Map<string, ProtobufOperationSignature> {
  const byKey = new Map<string, ProtobufOperationSignature>();
  for (const operation of operations) {
    byKey.set(protobufOperationKey(operation), operation);
  }
  return byKey;
}

function protobufOperationKey(operation: ProtobufOperationSignature): string {
  return `${operation.service}.${operation.rpc}`;
}

function protobufMessagesByName(
  messages: readonly ProtobufMessageSignature[]
): Map<string, ProtobufMessageSignature> {
  const byName = new Map<string, ProtobufMessageSignature>();
  for (const message of messages) {
    byName.set(message.name, message);
  }
  return byName;
}

function protobufFieldsByNumber(
  fields: readonly ProtobufFieldSignature[]
): Map<number, ProtobufFieldSignature> {
  const byNumber = new Map<number, ProtobufFieldSignature>();
  for (const field of fields) {
    byNumber.set(field.number, field);
  }
  return byNumber;
}

function protobufRpcType(typeName: string, stream: boolean): string {
  return stream ? `stream ${typeName}` : typeName;
}

function protobufFieldType(field: ProtobufFieldSignature): string {
  return field.label === 'singular' ? field.type : `${field.label} ${field.type}`;
}

function protobufFieldDisplayName(message: ProtobufMessageSignature, field: ProtobufFieldSignature): string {
  return `${shortProtobufTypeName(message.name)}.${field.name}#${field.number}`;
}

function shortProtobufTypeName(typeName: string): string {
  return typeName.split('.').at(-1) ?? typeName;
}

function responsesByStatus(
  responses: readonly OpenApiResponseSignature[]
): Map<string, OpenApiResponseSignature> {
  const byStatus = new Map<string, OpenApiResponseSignature>();
  for (const response of responses) {
    byStatus.set(response.status, response);
  }
  return byStatus;
}

function parseCurrentOpenApiContract(content: string, contractPath: string): CurrentContractParse {
  if (contractPath.toLowerCase().endsWith('.json')) {
    return parseOpenApiJsonEndpoints(content);
  }
  const parsed = parseOpenApiYamlEndpoints(content);
  if (!parsed.ok) return parsed;
  const compatibility = parseOpenApiYamlCompatibility(content);
  if (!compatibility.ok) {
    return {
      ok: false,
      endpoints: [],
      warning: compatibility.warning
    };
  }
  return {
    ...parsed,
    ...(compatibility.compatibility !== undefined ? { compatibility: compatibility.compatibility } : {})
  };
}

function parseCurrentProtobufContract(content: string): CurrentContractParse {
  const compatibility = extractProtobufCompatibility(content);
  if (compatibility === undefined) {
    return {
      ok: false,
      endpoints: [],
      warning: 'current Protobuf contract could not be parsed: no services or messages found'
    };
  }
  return {
    ok: true,
    endpoints: compatibility.operations.map((operation) => ({
      endpointId: `endpoint:protobuf:${operation.service}.${operation.rpc}`,
      httpMethod: 'RPC',
      routePath: operation.path
    })),
    protobufCompatibility: compatibility
  };
}

function parseOpenApiJsonEndpoints(content: string): CurrentContractParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      ok: false,
      endpoints: [],
      warning: `current OpenAPI JSON could not be parsed: ${errorMessage(error)}`
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      endpoints: [],
      warning: 'current OpenAPI JSON could not be parsed: root document must be an object'
    };
  }
  const marker = (parsed as { openapi?: unknown; swagger?: unknown }).openapi ??
    (parsed as { openapi?: unknown; swagger?: unknown }).swagger;
  if (typeof marker !== 'string' || marker.length === 0) {
    return {
      ok: false,
      endpoints: [],
      warning: 'current OpenAPI JSON could not be parsed: missing OpenAPI version marker'
    };
  }
  const paths = (parsed as { paths?: unknown }).paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
    return {
      ok: false,
      endpoints: [],
      warning: 'current OpenAPI JSON could not be parsed: paths must be an object'
    };
  }
  const endpoints: ContractEndpoint[] = [];
  for (const [routePath, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!routePath.startsWith('/')) continue;
    if (!pathItem || typeof pathItem !== 'object' || Array.isArray(pathItem)) {
      return {
        ok: false,
        endpoints: [],
        warning: `current OpenAPI JSON could not be parsed: path item must be an object for ${routePath}`
      };
    }
    for (const method of Object.keys(pathItem as Record<string, unknown>)) {
      const normalizedMethod = method.toLowerCase();
      if (!OPENAPI_METHODS.has(normalizedMethod)) continue;
      const operation = (pathItem as Record<string, unknown>)[method];
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
        return {
          ok: false,
          endpoints: [],
          warning: `current OpenAPI JSON could not be parsed: operation must be an object for ${normalizedMethod.toUpperCase()} ${routePath}`
        };
      }
      endpoints.push({
        httpMethod: normalizedMethod.toUpperCase(),
        routePath
      });
    }
  }
  const compatibility = extractOpenApiJsonCompatibility(content);
  return {
    ok: true,
    endpoints,
    ...(compatibility !== undefined ? { compatibility } : {})
  };
}

function parseOpenApiYamlEndpoints(content: string): CurrentContractParse {
  if (!/^\s*(?:openapi|swagger)\s*:/im.test(content)) {
    return {
      ok: false,
      endpoints: [],
      warning: 'current OpenAPI YAML could not be parsed: missing OpenAPI version marker'
    };
  }

  const lines = content.split(/\r?\n/);
  const endpoints: ContractEndpoint[] = [];
  let inPaths = false;
  let pathsIndent = -1;
  let currentRoute: CurrentYamlRoute | undefined;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    if (line.includes('\t')) {
      return {
        ok: false,
        endpoints: [],
        warning: 'current OpenAPI YAML could not be parsed: tabs are not supported for indentation'
      };
    }
    const trimmed = stripYamlComment(line).trim();
    if (trimmed.length === 0) continue;
    const indent = leadingSpaces(line);
    if (!inPaths) {
      if (indent !== 0) continue;
      if (/^paths\s*:\s*\{\s*\}\s*(?:#.*)?$/.test(trimmed)) {
        return { ok: true, endpoints: [] };
      }
      if (/^paths\s*:\s*(?:#.*)?$/.test(trimmed)) {
        inPaths = true;
        pathsIndent = indent;
      }
      continue;
    }

    if (indent <= pathsIndent) break;
    const routePath = parseYamlPathEntry(trimmed);
    if (routePath !== undefined) {
      currentRoute = {
        path: routePath,
        indent
      };
      continue;
    }

    if (/^['"]?\//.test(trimmed)) {
      return {
        ok: false,
        endpoints: [],
        warning: 'current OpenAPI YAML could not be parsed: malformed path entry under paths'
      };
    }

    const methodWithoutColon = /^([a-zA-Z]+)\s*$/.exec(trimmed);
    if (methodWithoutColon && OPENAPI_METHODS.has(methodWithoutColon[1]!.toLowerCase())) {
      return {
        ok: false,
        endpoints: [],
        warning: 'current OpenAPI YAML could not be parsed: malformed method entry under paths'
      };
    }

    if (!currentRoute || indent <= currentRoute.indent) {
      const methodBeforePath = /^([a-zA-Z]+)\s*:/.exec(trimmed);
      if (methodBeforePath && OPENAPI_METHODS.has(methodBeforePath[1]!.toLowerCase())) {
        return {
          ok: false,
          endpoints: [],
          warning: 'current OpenAPI YAML could not be parsed: method entry appears before a path'
        };
      }
      continue;
    }
    if (currentRoute.childIndent === undefined || indent < currentRoute.childIndent) {
      currentRoute.childIndent = indent;
    }
    const methodMatch = /^([a-zA-Z]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!methodMatch) continue;
    if (indent !== currentRoute.childIndent) continue;
    const method = methodMatch[1]!.toLowerCase();
    if (!OPENAPI_METHODS.has(method)) continue;
    const inlineValue = methodMatch[2]!.trim();
    if (inlineValue.length > 0 && !(inlineValue.startsWith('{') && inlineValue.endsWith('}'))) {
      return {
        ok: false,
        endpoints: [],
        warning: 'current OpenAPI YAML could not be parsed: operation must be an object under paths'
      };
    }
    if (inlineValue.length === 0 && !hasYamlMappingChild(lines, lineIndex, indent)) {
      return {
        ok: false,
        endpoints: [],
        warning: 'current OpenAPI YAML could not be parsed: operation must be an object under paths'
      };
    }
    endpoints.push({
      httpMethod: method.toUpperCase(),
      routePath: currentRoute.path
    });
  }

  if (!inPaths) {
    return {
      ok: false,
      endpoints: [],
      warning: 'current OpenAPI YAML could not be parsed: missing paths object'
    };
  }

  return { ok: true, endpoints };
}

function parseConsumesLink(provenanceJson: string): {
  consumer: { serviceName: string; repoPath: string; path: string };
  provider: { repoPath: string; contractPath: string };
  http: { method: string; path: string };
  evidence: { snippet: string };
} | undefined {
  const provenance = parseJsonObject(provenanceJson);
  const consumer = objectAt(provenance, 'consumer');
  const provider = objectAt(provenance, 'provider');
  const http = objectAt(provenance, 'http');
  const evidence = objectAt(provenance, 'evidence');
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
    }
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

function endpointsByKey(endpoints: ContractEndpoint[]): Map<string, ContractEndpoint> {
  const byKey = new Map<string, ContractEndpoint>();
  for (const endpoint of endpoints) {
    const key = endpointKey(endpoint.httpMethod, endpoint.routePath);
    if (!byKey.has(key)) byKey.set(key, endpoint);
  }
  return byKey;
}

function endpointKey(method: string, routePath: string): string {
  return `${method.toUpperCase()} ${routePath}`;
}

function currentEndpointId(contractPath: string, endpoint: ContractEndpoint): string {
  const lowerPath = contractPath.toLowerCase();
  const languageId = lowerPath.endsWith('.proto')
    ? 'protobuf'
    : lowerPath.endsWith('.json')
      ? 'json'
      : 'yaml';
  if (languageId === 'protobuf' && endpoint.httpMethod === 'RPC') {
    return `endpoint:protobuf:${endpoint.routePath.replace('/', '.')}`;
  }
  return `endpoint:${languageId}:${endpointKey(endpoint.httpMethod, endpoint.routePath)}`;
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

function stripYamlComment(line: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const previous = index > 0 ? line[index - 1] : undefined;
    if (quote === undefined && (char === '"' || char === "'")) {
      quote = char;
      continue;
    }
    if (quote !== undefined && char === quote && previous !== '\\') {
      quote = undefined;
      continue;
    }
    if (quote === undefined && char === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

function leadingSpaces(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

function parseYamlPathEntry(trimmed: string): string | undefined {
  const quoted = /^(['"])(\/.*?)\1\s*:\s*(?:#.*)?$/.exec(trimmed);
  if (quoted) return quoted[2]!;
  const unquoted = /^(\/.*)\s*:\s*(?:#.*)?$/.exec(trimmed);
  return unquoted?.[1]?.trimEnd();
}

function hasYamlMappingChild(lines: string[], parentLineIndex: number, parentIndent: number): boolean {
  for (const line of lines.slice(parentLineIndex + 1)) {
    const trimmed = stripYamlComment(line).trim();
    if (trimmed.length === 0) continue;
    if (leadingSpaces(line) <= parentIndent) return false;
    return /^['"]?[A-Za-z0-9_$.-]+['"]?\s*:/.test(trimmed);
  }
  return false;
}

function parseJsonObject(input: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
