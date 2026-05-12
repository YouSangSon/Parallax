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
  eventTopology?: CrossRepoEventTopology;
};

export type CrossRepoEventTopology = {
  providerAction: string;
  counterpartyRole: 'consumer' | 'producer' | 'unknown';
  pattern: string;
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
  eventTopology?: CrossRepoEventTopology;
};

type ConsumerEvidence = {
  snippet: string;
  eventTopology?: CrossRepoEventTopology;
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
  contract_kind: string | null;
  contract_language_id: string | null;
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
         source.language_id AS contract_language_id,
         contract.kind AS contract_kind,
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
       LEFT JOIN contracts contract
          ON contract.repo_id = source.repo_id
         AND contract.path = source.path
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
    const parsed = parseContractEndpointDisplay(row.endpoint_display_name, providerContractKind(row));
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
          evidenceSnippet: match.snippet,
          ...(match.eventTopology !== undefined ? { eventTopology: match.eventTopology } : {})
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
    if (!shouldScanConsumerFile(row.path, endpoint)) continue;
    const content = readFreshIndexedFile(repo, row.path, row.content_hash, 'consumer file', warnings, warnedFiles);
    if (content === undefined) continue;
    const evidence = firstMatchingEvidence(content, row.path, endpoint);
    if (!evidence) continue;
    matches.push({
      repoPath: repo.repoPath,
      serviceName: repo.serviceName,
      filePath: row.path,
      snippet: evidence.snippet,
      ...(evidence.eventTopology !== undefined ? { eventTopology: evidence.eventTopology } : {})
    });
  }
  return matches;
}

function shouldScanConsumerFile(filePath: string, endpoint: ProviderEndpoint): boolean {
  if (endpoint.httpMethod === 'GRAPHQL') {
    if (isDocumentationPath(filePath)) return false;
    return /\.(?:graphql|gql|tsx?|jsx?)$/i.test(filePath);
  }
  if (endpoint.httpMethod === 'RPC') {
    if (isDocumentationPath(filePath)) return false;
    if (isGeneratedProtobufFilePath(filePath)) return false;
    return isSourceFilePath(filePath);
  }
  if (isAsyncApiEndpointMethod(endpoint.httpMethod)) {
    if (isDocumentationPath(filePath)) return false;
    return isSourceOrConfigFilePath(filePath);
  }
  return true;
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

function firstMatchingEvidence(content: string, filePath: string, endpoint: ProviderEndpoint): ConsumerEvidence | undefined {
  if (endpoint.httpMethod === 'GRAPHQL') {
    const snippet = firstMatchingGraphqlOperationLine(content, filePath, endpoint.routePath);
    return snippet === undefined ? undefined : { snippet };
  }
  if (endpoint.httpMethod === 'RPC') {
    const snippet = firstMatchingProtobufRpcLine(content, filePath, endpoint.routePath);
    return snippet === undefined ? undefined : { snippet };
  }
  if (isAsyncApiEndpointMethod(endpoint.httpMethod)) {
    return firstMatchingAsyncApiEventEvidence(content, filePath, endpoint.httpMethod, endpoint.routePath);
  }
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes(endpoint.routePath)) continue;
    if (!methodMatches(line, endpoint.httpMethod)) continue;
    return { snippet: line.trim() };
  }
  return undefined;
}

function firstMatchingGraphqlOperationLine(content: string, filePath: string, routePath: string): string | undefined {
  const target = parseGraphqlRoutePath(routePath);
  if (target === undefined) return undefined;
  const operationPattern = /\b(query|mutation|subscription)\b/g;
  let match: RegExpExecArray | null;
  while ((match = operationPattern.exec(content)) !== null) {
    if (lineStartsWithComment(content, match.index)) continue;
    if (isJsLikeGraphqlConsumerPath(filePath) && !isInsideBacktickTemplate(content, match.index)) continue;
    const operationType = graphqlRootTypeForOperation(match[1]!);
    if (operationType !== target.rootType) continue;
    const selectionStart = content.indexOf('{', operationPattern.lastIndex);
    if (selectionStart < 0) continue;
    const fieldOffset = graphqlRootSelectionFieldOffset(content, selectionStart, target.fieldName);
    if (fieldOffset !== undefined) return lineAtOffset(content, fieldOffset);
  }

  if (!isGraphqlDocumentPath(filePath)) return undefined;
  const anonymousSelectionStart = firstAnonymousGraphqlSelectionStart(content);
  if (target.rootType !== 'Query' || anonymousSelectionStart === undefined) return undefined;
  const anonymousFieldOffset = graphqlRootSelectionFieldOffset(content, anonymousSelectionStart, target.fieldName);
  return anonymousFieldOffset === undefined ? undefined : lineAtOffset(content, anonymousFieldOffset);
}

function parseGraphqlRoutePath(routePath: string): { rootType: 'Query' | 'Mutation' | 'Subscription'; fieldName: string } | undefined {
  const match = /^(Query|Mutation|Subscription)\.([_A-Za-z][_0-9A-Za-z]*)$/.exec(routePath);
  if (!match) return undefined;
  return {
    rootType: match[1] as 'Query' | 'Mutation' | 'Subscription',
    fieldName: match[2]!
  };
}

function isGraphqlDocumentPath(filePath: string): boolean {
  return /\.(?:graphql|gql)$/i.test(filePath);
}

function isJsLikeGraphqlConsumerPath(filePath: string): boolean {
  return /\.(?:tsx?|jsx?)$/i.test(filePath);
}

function isDocumentationPath(filePath: string): boolean {
  return /^(?:docs?|examples?|samples?)\//i.test(filePath) || /(?:^|\/)README(?:\.[^.]+)?$/i.test(filePath);
}

function isSourceFilePath(filePath: string): boolean {
  return /\.(?:tsx?|jsx?|java|kt|kts|py|go|rs|cs)$/i.test(filePath);
}

function isSourceOrConfigFilePath(filePath: string): boolean {
  return isSourceFilePath(filePath) || /\.(?:ya?ml|json|toml|properties)$/i.test(filePath);
}

function isGeneratedProtobufFilePath(filePath: string): boolean {
  return /(?:^|\/)(?:gen|generated|__generated__)\//i.test(filePath) ||
    /(?:_pb|_grpc_pb|_connect|_connectweb|_pb2|_pb2_grpc)\.[^.]+$/i.test(filePath);
}

function isGeneratedProtobufContent(content: string): boolean {
  const header = content.slice(0, 4096);
  return /(?:^|\n)\s*(?:(?:\/\/|#|\/\*)\s*)?(?:@generated\b|Code generated .* DO NOT EDIT\.?|Generated by the protocol buffer compiler\.?|Generated by protoc|Generated from protobuf schema|This file was generated by)/i.test(header) ||
    /\bprotoc-gen-(?:connect|es|go|grpc|js|ts)\b/i.test(header);
}

function isAsyncApiEndpointMethod(method: string): boolean {
  return /^(?:SEND|RECEIVE|PUBLISH|SUBSCRIBE)$/i.test(method);
}

function graphqlRootTypeForOperation(operation: string): 'Query' | 'Mutation' | 'Subscription' {
  if (operation.toLowerCase() === 'mutation') return 'Mutation';
  if (operation.toLowerCase() === 'subscription') return 'Subscription';
  return 'Query';
}

function graphqlRootSelectionFieldOffset(
  content: string,
  selectionStart: number,
  targetFieldName: string
): number | undefined {
  let depth = 0;
  for (let index = selectionStart; index < content.length; index += 1) {
    const char = content[index];
    if (char === '"' || char === "'") {
      index = skipQuotedString(content, index);
      continue;
    }
    if (char === '#') {
      index = skipLine(content, index);
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth <= 0) return undefined;
      continue;
    }
    if (depth !== 1 || !isGraphqlNameStart(char)) continue;

    const parsed = parseGraphqlSelectionName(content, index);
    if (parsed === undefined) continue;
    if (parsed.fieldName === targetFieldName) return parsed.fieldOffset;
    index = parsed.nextOffset - 1;
  }
  return undefined;
}

function parseGraphqlSelectionName(
  content: string,
  offset: number
): { fieldName: string; fieldOffset: number; nextOffset: number } | undefined {
  const first = readGraphqlName(content, offset);
  if (first === undefined) return undefined;
  let nextOffset = skipWhitespace(content, first.end);
  if (content[nextOffset] !== ':') {
    return {
      fieldName: first.name,
      fieldOffset: first.start,
      nextOffset: first.end
    };
  }

  nextOffset = skipWhitespace(content, nextOffset + 1);
  const aliased = readGraphqlName(content, nextOffset);
  if (aliased === undefined) return undefined;
  return {
    fieldName: aliased.name,
    fieldOffset: aliased.start,
    nextOffset: aliased.end
  };
}

function readGraphqlName(content: string, offset: number): { name: string; start: number; end: number } | undefined {
  if (!isGraphqlNameStart(content[offset])) return undefined;
  let end = offset + 1;
  while (end < content.length && /[_0-9A-Za-z]/.test(content[end]!)) end += 1;
  return {
    name: content.slice(offset, end),
    start: offset,
    end
  };
}

function firstAnonymousGraphqlSelectionStart(content: string): number | undefined {
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === '"' || char === "'") {
      index = skipQuotedString(content, index);
      continue;
    }
    if (char === '#') {
      index = skipLine(content, index);
      continue;
    }
    if (char === '{' && !lineStartsWithComment(content, index)) return index;
  }
  return undefined;
}

function lineAtOffset(content: string, offset: number): string {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = content.indexOf('\n', offset);
  return content.slice(lineStart, lineEnd < 0 ? content.length : lineEnd).trim();
}

function skipWhitespace(content: string, offset: number): number {
  let index = offset;
  while (index < content.length && /\s/.test(content[index]!)) index += 1;
  return index;
}

function skipQuotedString(content: string, offset: number): number {
  const quote = content[offset];
  const tripleQuoted = quote === '"' && content.slice(offset, offset + 3) === '"""';
  if (tripleQuoted) {
    const end = content.indexOf('"""', offset + 3);
    return end < 0 ? content.length : end + 2;
  }
  let index = offset + 1;
  while (index < content.length) {
    if (content[index] === '\\') {
      index += 2;
      continue;
    }
    if (content[index] === quote) return index;
    index += 1;
  }
  return content.length;
}

function skipLine(content: string, offset: number): number {
  const lineEnd = content.indexOf('\n', offset);
  return lineEnd < 0 ? content.length : lineEnd;
}

function lineStartsWithComment(content: string, offset: number): boolean {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
  return /^\s*(?:#|\/\/)/.test(content.slice(lineStart, offset));
}

function isInsideBacktickTemplate(content: string, offset: number): boolean {
  type ScannerState = 'code' | 'line_comment' | 'block_comment' | 'single_quote' | 'double_quote' | 'template';
  let state: ScannerState = 'code';
  for (let index = 0; index < offset; index += 1) {
    const char = content[index]!;
    const next = content[index + 1];
    if (state === 'line_comment') {
      if (char === '\n' || char === '\r') state = 'code';
      continue;
    }
    if (state === 'block_comment') {
      if (char === '*' && next === '/') {
        state = 'code';
        index += 1;
      }
      continue;
    }
    if (state === 'single_quote') {
      if (char === '\\') {
        index += 1;
      } else if (char === "'") {
        state = 'code';
      }
      continue;
    }
    if (state === 'double_quote') {
      if (char === '\\') {
        index += 1;
      } else if (char === '"') {
        state = 'code';
      }
      continue;
    }
    if (state === 'template') {
      if (char === '\\') {
        index += 1;
      } else if (char === '`') {
        state = 'code';
      }
      continue;
    }

    if (char === '/' && next === '/') {
      state = 'line_comment';
      index += 1;
    } else if (char === '/' && next === '*') {
      state = 'block_comment';
      index += 1;
    } else if (char === "'") {
      state = 'single_quote';
    } else if (char === '"') {
      state = 'double_quote';
    } else if (char === '`') {
      state = 'template';
    }
  }
  return state === 'template';
}

function isGraphqlNameStart(value: string | undefined): boolean {
  return value !== undefined && /[_A-Za-z]/.test(value);
}

function firstMatchingProtobufRpcLine(content: string, filePath: string, routePath: string): string | undefined {
  if (isGeneratedProtobufFilePath(filePath) || isGeneratedProtobufContent(content)) return undefined;
  const target = parseProtobufRoutePath(routePath);
  if (target === undefined) return undefined;
  const lines = sourceLinesWithCommentMasks(content);
  const fullPathLine = lines.find((line) => protobufFullPathMatches(line.masked, target.serviceName, target.rpcName));
  if (fullPathLine !== undefined) return fullPathLine.raw.trim();
  const maskedContent = lines.map((line) => line.masked).join('\n');
  if (!protobufServiceContextMatches(maskedContent, target.serviceName)) return undefined;
  const rpcLine = lines.find((line) => protobufRpcCallLineMatches(line.masked, target.rpcName));
  return rpcLine === undefined ? undefined : rpcLine.raw.trim();
}

function parseProtobufRoutePath(routePath: string): { serviceName: string; rpcName: string } | undefined {
  const match = /^([A-Za-z_]\w*)\/([A-Za-z_]\w*)$/.exec(routePath);
  if (!match) return undefined;
  return {
    serviceName: match[1]!,
    rpcName: match[2]!
  };
}

function protobufFullPathMatches(line: string, serviceName: string, rpcName: string): boolean {
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9_.])/?(?:[A-Za-z_]\\w*\\.)*${escapeRegExp(serviceName)}/${escapeRegExp(rpcName)}\\b`);
  return pattern.test(line);
}

function protobufServiceContextMatches(content: string, serviceName: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegExp(serviceName)}(?:Grpc|Client|Stub|BlockingStub|FutureStub|CoroutineStub)?\\b`);
  return pattern.test(content);
}

function protobufRpcCallLineMatches(line: string, rpcName: string): boolean {
  return protobufRpcNameVariants(rpcName).some((variant) => {
    const pattern = new RegExp(`(?:\\.|::)\\s*${escapeRegExp(variant)}\\s*\\(`);
    return pattern.test(line);
  });
}

function protobufRpcNameVariants(rpcName: string): string[] {
  return uniqueStrings([
    rpcName,
    lowerFirst(rpcName),
    camelToSnakeCase(rpcName)
  ]);
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : value[0]!.toLowerCase() + value.slice(1);
}

function camelToSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function firstMatchingAsyncApiEventEvidence(
  content: string,
  filePath: string,
  providerAction: string,
  routePath: string
): ConsumerEvidence | undefined {
  const lines = sourceLinesWithCommentMasks(content);
  const aliases = asyncApiEventAddressAliases(lines, routePath);
  const aliasDeclarationLineIndexes = new Set(aliases.map((alias) => alias.declarationLineIndex));
  const allowBareRouteToken = !isSourceFilePath(filePath);
  for (const [lineIndex, candidate] of lines.entries()) {
    if (!containsAsyncApiRouteLiteral(candidate.masked, routePath, allowBareRouteToken)) continue;
    if (aliasDeclarationLineIndexes.has(lineIndex)) continue;
    if (isSourceFilePath(filePath) && isAsyncApiEventAddressSourceDeclaration(candidate.masked, routePath)) continue;
    const snippet = candidate.raw.trim();
    const topology = classifyAsyncApiEventLine(candidate.masked.trim(), providerAction);
    if (topology.counterpartyRole === 'unknown') {
      continue;
    }
    if (asyncApiCounterpartyRoleMatchesProviderAction(providerAction, topology.counterpartyRole)) {
      return { snippet, eventTopology: topology };
    }
  }
  for (const alias of aliases) {
    for (const [lineIndex, candidate] of lines.entries()) {
      if (lineIndex === alias.declarationLineIndex) continue;
      if (!containsDirectAsyncApiAliasReference(candidate.masked, alias.name)) continue;
      const snippet = candidate.raw.trim();
      const topology = classifyAsyncApiEventLine(candidate.masked.trim(), providerAction);
      if (topology.counterpartyRole === 'unknown') {
        continue;
      }
      if (asyncApiCounterpartyRoleMatchesProviderAction(providerAction, topology.counterpartyRole)) {
        return { snippet, eventTopology: topology };
      }
    }
  }
  return undefined;
}

function asyncApiEventAddressAliases(
  lines: Array<{ masked: string }>,
  routePath: string
): Array<{ name: string; declarationLineIndex: number }> {
  const aliases: Array<{ name: string; declarationLineIndex: number }> = [];
  const quotedRoutePath = escapeRegExp(routePath);
  const assignmentPattern = new RegExp(
    `^\\s*(?:export\\s+)?(?:(?:const|let|var)\\s+)?([_$A-Za-z][_$0-9A-Za-z]*)\\s*(?::\\s*[^=]+)?=\\s*(["'\`])${quotedRoutePath}\\2\\s*(?:[;,}]|$)`
  );

  for (const [lineIndex, line] of lines.entries()) {
    if (isAsyncApiEventCallSyntax(line.masked)) continue;
    const assignment = assignmentPattern.exec(line.masked);
    if (assignment?.[1] !== undefined) {
      aliases.push({ name: assignment[1], declarationLineIndex: lineIndex });
    }
  }

  return uniqueAsyncApiEventAddressAliases(aliases);
}

function uniqueAsyncApiEventAddressAliases(
  aliases: Array<{ name: string; declarationLineIndex: number }>
): Array<{ name: string; declarationLineIndex: number }> {
  const seen = new Set<string>();
  const unique: Array<{ name: string; declarationLineIndex: number }> = [];
  for (const alias of aliases) {
    const key = `${alias.name}:${alias.declarationLineIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(alias);
  }
  return unique;
}

function isAsyncApiEventCallSyntax(line: string): boolean {
  return /@\w+\s*\(|\b[_$A-Za-z][_$0-9A-Za-z]*(?:\s*\.\s*[_$A-Za-z][_$0-9A-Za-z]*)?\s*\(/.test(line);
}

function isAsyncApiEventAddressSourceDeclaration(line: string, routePath: string): boolean {
  if (isAsyncApiEventCallSyntax(line)) return false;
  const quotedRoutePath = escapeRegExp(routePath);
  const pattern = new RegExp(
    `^\\s*(?:export\\s+)?(?:(?:const|let|var)\\s+)?[_$A-Za-z][_$0-9A-Za-z]*(?:\\s*\\.\\s*[_$A-Za-z][_$0-9A-Za-z]*)*[\\s\\S]*=\\s*[\\s\\S]*(["'\`])${quotedRoutePath}\\1`
  );
  return pattern.test(line);
}

function classifyAsyncApiEventLine(line: string, providerAction: string): CrossRepoEventTopology {
  const lowered = line.toLowerCase();
  const consumerPatterns: Array<[RegExp, string]> = [
    [/@kafkalistener\b/i, 'spring-kafka-listener'],
    [/\bconsumer\s*\.\s*subscribe\b/i, 'kafkajs-consumer-subscribe'],
    [/\bsubscribe(?:to)?\s*\(/i, 'subscriber-call'],
    [/\blisten(?:er)?\s*\(/i, 'listener-call'],
    [/\bonmessage\b|\bhandler\s*[:=]/i, 'message-handler'],
    [/\baiokafkaconsumer\b|\bkafkaconsumer\b/i, 'python-kafka-consumer'],
    [/\breaderconfig\b|\bnewreader\b/i, 'go-kafka-reader'],
    [/\bstreamconsumer\b|\bbaseconsumer\b|\bsubscribe\s*\(/i, 'rust-kafka-consumer'],
    [/\bconsumer\b.*(?:topic|topics|channel|queue)/i, 'consumer-config']
  ];
  const producerPatterns: Array<[RegExp, string]> = [
    [/\bkafkatemplate\s*\.\s*send\b/i, 'spring-kafka-template-send'],
    [/\bproducer\s*\.\s*send\b/i, 'producer-send'],
    [/\bsend_and_wait\s*\(/i, 'python-aiokafka-send'],
    [/\bpublish\s*\(/i, 'publisher-call'],
    [/\bemit\s*\(/i, 'emitter-call'],
    [/\bwriterconfig\b|\bnewwriter\b/i, 'go-kafka-writer'],
    [/\bfutureproducer\b|\bbaseproducer\b/i, 'rust-kafka-producer'],
    [/\bproducer\b.*(?:topic|topics|channel|queue)/i, 'producer-config']
  ];

  for (const [pattern, name] of consumerPatterns) {
    if (pattern.test(line)) {
      return { providerAction, counterpartyRole: 'consumer', pattern: name };
    }
  }
  for (const [pattern, name] of producerPatterns) {
    if (pattern.test(line)) {
      return { providerAction, counterpartyRole: 'producer', pattern: name };
    }
  }

  if (/\b(?:subscribe|listener|consumer|reader)\b/.test(lowered)) {
    return { providerAction, counterpartyRole: 'consumer', pattern: 'consumer-keyword' };
  }
  if (/\b(?:publish|producer|send|emit|writer)\b/.test(lowered)) {
    return { providerAction, counterpartyRole: 'producer', pattern: 'producer-keyword' };
  }
  return { providerAction, counterpartyRole: 'unknown', pattern: 'exact-event-address' };
}

function asyncApiCounterpartyRoleMatchesProviderAction(
  providerAction: string,
  counterpartyRole: CrossRepoEventTopology['counterpartyRole']
): boolean {
  const action = providerAction.toUpperCase();
  if (counterpartyRole === 'consumer') return action === 'SEND' || action === 'PUBLISH';
  if (counterpartyRole === 'producer') return action === 'RECEIVE' || action === 'SUBSCRIBE';
  return true;
}

function sourceLinesWithCommentMasks(content: string): Array<{ raw: string; masked: string }> {
  const lines: Array<{ raw: string; masked: string }> = [];
  const rawLines = content.split(/\r?\n/);
  let inBlockComment = false;
  for (const raw of rawLines) {
    let masked = '';
    let state: 'code' | 'single' | 'double' | 'template' = 'code';
    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index]!;
      const next = raw[index + 1];

      if (inBlockComment) {
        if (char === '*' && next === '/') {
          masked += '  ';
          inBlockComment = false;
          index += 1;
        } else {
          masked += char === '\t' ? '\t' : ' ';
        }
        continue;
      }

      if (state === 'single') {
        masked += char;
        if (char === '\\') {
          if (next !== undefined) {
            masked += next;
            index += 1;
          }
        } else if (char === "'") {
          state = 'code';
        }
        continue;
      }

      if (state === 'double') {
        masked += char;
        if (char === '\\') {
          if (next !== undefined) {
            masked += next;
            index += 1;
          }
        } else if (char === '"') {
          state = 'code';
        }
        continue;
      }

      if (state === 'template') {
        masked += char;
        if (char === '\\') {
          if (next !== undefined) {
            masked += next;
            index += 1;
          }
        } else if (char === '`') {
          state = 'code';
        }
        continue;
      }

      if (char === '/' && next === '/') {
        masked += ' '.repeat(raw.length - index);
        break;
      }
      if (char === '/' && next === '*') {
        masked += '  ';
        inBlockComment = true;
        index += 1;
        continue;
      }
      if (char === '#') {
        masked += ' '.repeat(raw.length - index);
        break;
      }
      if (char === "'") state = 'single';
      if (char === '"') state = 'double';
      if (char === '`') state = 'template';
      masked += char;
    }
    lines.push({ raw, masked });
  }
  return lines;
}

function containsDelimitedToken(value: string, token: string): boolean {
  let offset = 0;
  while (offset < value.length) {
    const index = value.indexOf(token, offset);
    if (index < 0) return false;
    const before = index === 0 ? undefined : value[index - 1];
    const after = index + token.length >= value.length ? undefined : value[index + token.length];
    if (!isRouteTokenChar(before) && !isRouteTokenChar(after)) return true;
    offset = index + token.length;
  }
  return false;
}

function containsAsyncApiRouteLiteral(value: string, routePath: string, allowBareRouteToken: boolean): boolean {
  let offset = 0;
  while (offset < value.length) {
    const index = value.indexOf(routePath, offset);
    if (index < 0) return false;
    const before = index === 0 ? undefined : value[index - 1];
    const after = index + routePath.length >= value.length ? undefined : value[index + routePath.length];
    const beforeLiteralQuote = before === '"' || before === "'" || before === '`';
    const matchingLiteralQuote = beforeLiteralQuote && after === before;
    if (matchingLiteralQuote &&
      !hasComputedLiteralHead(value.slice(0, index - 1)) &&
      !hasComputedLiteralTail(value.slice(index + routePath.length + 1))) {
      return true;
    }
    if (allowBareRouteToken && !beforeLiteralQuote && after !== '"' && after !== "'" && after !== '`' &&
      !isRouteTokenChar(before) && !isRouteTokenChar(after)) {
      return true;
    }
    offset = index + routePath.length;
  }
  return false;
}

function hasComputedLiteralHead(valueBeforeOpeningQuote: string): boolean {
  const boundaryIndex = Math.max(
    valueBeforeOpeningQuote.lastIndexOf('('),
    valueBeforeOpeningQuote.lastIndexOf('{'),
    valueBeforeOpeningQuote.lastIndexOf('['),
    valueBeforeOpeningQuote.lastIndexOf(','),
    valueBeforeOpeningQuote.lastIndexOf('='),
    valueBeforeOpeningQuote.lastIndexOf(':')
  );
  return valueBeforeOpeningQuote.slice(boundaryIndex + 1).trim().length > 0;
}

function hasComputedLiteralTail(valueAfterClosingQuote: string): boolean {
  for (let index = 0; index < valueAfterClosingQuote.length; index += 1) {
    const char = valueAfterClosingQuote[index]!;
    if (/\s/.test(char) || char === ')' || char === ']') continue;
    if (char === '+' || char === '.' || valueAfterClosingQuote.startsWith('??', index) ||
      valueAfterClosingQuote.startsWith('||', index) || valueAfterClosingQuote.startsWith('&&', index)) {
      return true;
    }
    if (char === ',' || char === ';' || char === '}') return false;
  }
  return false;
}

function containsIdentifierToken(value: string, token: string): boolean {
  const pattern = new RegExp(`(?<![_$0-9A-Za-z])${escapeRegExp(token)}(?![_$0-9A-Za-z])`);
  return pattern.test(value);
}

function containsDirectAsyncApiAliasReference(value: string, token: string): boolean {
  if (!containsIdentifierToken(value, token)) return false;
  const escaped = escapeRegExp(token);
  if (new RegExp(`\\$\\{\\s*${escaped}\\s*\\}`).test(value)) return false;
  const directReferencePattern = new RegExp(
    `(?:^|[(:,=\\[]|\\b(?:topic|topics|channel|queue)\\s*[:=])\\s*${escaped}\\s*(?:$|[,)}\\];])`
  );
  return directReferencePattern.test(value);
}

function isRouteTokenChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_.:/-]/.test(value);
}

function methodMatches(line: string, method: string): boolean {
  if (method === 'GET' && !/\bmethod\s*[:=]/i.test(line)) return true;
  const methodPattern = new RegExp(`\\b${escapeRegExp(method)}\\b`, 'i');
  return methodPattern.test(line);
}

function parseContractEndpointDisplay(displayName: string, contractKind: string | undefined): { method: string; path: string } | undefined {
  return parseHttpEndpointDisplay(displayName) ?? parseTypedContractEndpointDisplay(displayName, contractKind);
}

function parseHttpEndpointDisplay(displayName: string): { method: string; path: string } | undefined {
  const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(\S+)$/i.exec(displayName.trim());
  if (!match) return undefined;
  return { method: match[1]!.toUpperCase(), path: match[2]! };
}

function parseGraphqlEndpointDisplay(displayName: string): { method: string; path: string } | undefined {
  const match = /^(?:GRAPHQL\s+)?((?:Query|Mutation|Subscription)\.[_A-Za-z][_0-9A-Za-z]*)$/.exec(displayName.trim());
  if (!match) return undefined;
  return { method: 'GRAPHQL', path: match[1]! };
}

function providerContractKind(row: EndpointRow): string | undefined {
  const kind = row.contract_kind ?? row.contract_language_id;
  if (kind && kind.length > 0) return kind.toLowerCase();
  if (/\.proto$/i.test(row.contract_path)) return 'protobuf';
  if (/\.(?:graphql|gql)$/i.test(row.contract_path)) return 'graphql';
  if (isAsyncApiContractPath(row.contract_path)) return 'asyncapi';
  return undefined;
}

function parseTypedContractEndpointDisplay(displayName: string, contractKind: string | undefined): { method: string; path: string } | undefined {
  if (contractKind === 'protobuf') return parseProtobufEndpointDisplay(displayName);
  if (contractKind === 'graphql') return parseGraphqlEndpointDisplay(displayName);
  if (contractKind === 'asyncapi') return parseAsyncApiEndpointDisplay(displayName);
  return undefined;
}

function parseProtobufEndpointDisplay(displayName: string): { method: string; path: string } | undefined {
  const match = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(displayName.trim());
  if (!match) return undefined;
  return { method: 'RPC', path: `${match[1]!}/${match[2]!}` };
}

function parseAsyncApiEndpointDisplay(displayName: string): { method: string; path: string } | undefined {
  const match = /^([A-Z][A-Z0-9_-]*)\s+(.+)$/.exec(displayName.trim());
  if (!match) return undefined;
  return { method: match[1]!, path: match[2]! };
}

function isAsyncApiContractPath(filePath: string): boolean {
  return /(?:^|\/|\\)[^/\\]*asyncapi[^/\\]*\.(?:ya?ml|json)$/i.test(filePath);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
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
    ...(link.eventTopology !== undefined ? { eventTopology: link.eventTopology } : {}),
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
