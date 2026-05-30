import path from 'node:path';
import ts from 'typescript';

import {
  extractAsyncApiJsonCompatibility,
  extractAsyncApiYamlCompatibility,
  type AsyncApiOperationSignature
} from '../asyncapi_compat.js';
import { markdownEntityKindForPath } from '../artifacts.js';
import { extractGraphqlCompatibility, stripGraphqlComments } from '../graphql_compat.js';
import { extractOpenApiJsonCompatibility, extractOpenApiYamlCompatibility } from '../openapi_compat.js';
import { extractProtobufCompatibility, stripProtobufComments } from '../protobuf_compat.js';
import type { Confidence, RelationKind, ScannedFile } from '../types.js';
import type {
  AdapterCapability,
  AdapterRun,
  EntityDescriptor,
  ExtractCtx,
  IndexEvent,
  PendingEvidence,
  PendingRelation,
  SemanticAdapter
} from './types.js';

export const MULTI_LANG_REGEX_ADAPTER_ID = 'multi-language-regex-mvp';
export const MULTI_LANG_REGEX_ADAPTER_VERSION = '3';
export const TS_JS_SEMANTIC_ADAPTER_ID = 'typescript-javascript-semantic-v0';
export const JVM_SPRING_SEMANTIC_ADAPTER_ID = 'jvm-spring-semantic-v0';
export const PYTHON_SEMANTIC_ADAPTER_ID = 'python-semantic-v0';
export const GO_SEMANTIC_ADAPTER_ID = 'go-semantic-v0';
export const RUST_SEMANTIC_ADAPTER_ID = 'rust-semantic-v0';

const capabilities: readonly AdapterCapability[] = ['imports', 'symbols', 'calls', 'docrefs', 'tests'];

type ExtractedSymbol = {
  name: string;
  kind: string;
  exported: boolean;
  evidence?: EvidenceSpan;
};

type EvidenceSpan = {
  snippet: string;
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
};

type ExtractedImport = EvidenceSpan & {
  specifier: string;
};

type InferredTestTarget = {
  path: string;
  evidence?: EvidenceSpan;
};

type ExtractedCall = EvidenceSpan & {
  source?: EntityDescriptor;
  target: EntityDescriptor;
  callee: string;
  provenance: string;
};

type TsLocalCallable = {
  name: string;
  symbolKind: string;
  descriptor: EntityDescriptor;
};

type TsLocalInstanceBinding = {
  className: string;
};

type SpringClass = {
  name: string;
  kind: string;
  annotations: readonly SpringAnnotation[];
  declaration: string;
  body: string;
  bodyOffset: number;
  evidence: EvidenceSpan;
};

type SpringAnnotation = {
  name: string;
  args: string;
  index: number;
  text: string;
};

const springMappingMethods = new Map<string, string | undefined>([
  ['GetMapping', 'GET'],
  ['PostMapping', 'POST'],
  ['PutMapping', 'PUT'],
  ['PatchMapping', 'PATCH'],
  ['DeleteMapping', 'DELETE'],
  ['RequestMapping', undefined]
]);

const springComponentAnnotations = new Map<string, string>([
  ['RestController', 'RestController'],
  ['Controller', 'Controller'],
  ['Service', 'Service'],
  ['Repository', 'Repository'],
  ['Configuration', 'Configuration'],
  ['ConfigurationProperties', 'ConfigurationProperties'],
  ['Entity', 'Entity'],
  ['FeignClient', 'FeignClient']
]);

abstract class RegexBackedSemanticAdapter implements SemanticAdapter {
  readonly version = MULTI_LANG_REGEX_ADAPTER_VERSION;
  readonly capabilities = capabilities;
  readonly confidence = 'heuristic';
  readonly knownGaps = [
    'regex/lightweight parser extraction can miss dynamic references, generated code, and complex call graphs',
    'source spans are partial outside the parser-backed TypeScript/JavaScript lanes'
  ];

  constructor(
    readonly id: string,
    private readonly supportedLanguageIds: ReadonlySet<string>
  ) {}

  supports(file: ScannedFile): boolean {
    return this.supportedLanguageIds.has(file.language);
  }

  start(ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun {
    const filePathSet = new Set(ctx.indexedFiles.map((f) => f.relativePath));
    const importResolver = createImportResolver(ctx.indexedFiles);
    return {
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        yield* extractEvents(file, filePathSet, importResolver);
      }
    };
  }
}

export class TypeScriptJavaScriptSemanticAdapter extends RegexBackedSemanticAdapter {
  override readonly knownGaps = [
    'TypeScript/JavaScript import, declaration, imported call-site, local identifier call, same-class this.method, static ClassName.method, same-file factory return type instance method call, interface/type-literal method/function-property signature and typed receiver method call, typed local variable instance method call, typed parameter instance method call, constructor parameter property instance method call, constructor assignment instance method call, class field arrow method caller/target, typed class field instance method call, class field instance method call, same-file new ClassName instance call, and direct new ClassName().method call spans are parser-backed, but broader dynamic dispatch and type relation resolution are not yet complete',
    'polymorphism, alias-heavy object flows, generated code, and framework-specific routing may require deeper adapters'
  ];

  constructor() {
    super(TS_JS_SEMANTIC_ADAPTER_ID, new Set(['typescript', 'javascript']));
  }
}

export class JvmSpringSemanticAdapter extends RegexBackedSemanticAdapter {
  override readonly knownGaps = [
    'Spring endpoint and component extraction is lightweight and does not run a JVM parser or DI container',
    'persistence, reflection, generated clients, and framework conventions may be incomplete'
  ];

  constructor() {
    super(JVM_SPRING_SEMANTIC_ADAPTER_ID, new Set(['java', 'kotlin']));
  }
}

export class PythonSemanticAdapter extends RegexBackedSemanticAdapter {
  override readonly knownGaps = [
    'Python extraction is declaration/import oriented and does not execute module import resolution',
    'dynamic attributes, decorators, and generated code may be incomplete'
  ];

  constructor() {
    super(PYTHON_SEMANTIC_ADAPTER_ID, new Set(['python']));
  }
}

export class GoSemanticAdapter extends RegexBackedSemanticAdapter {
  override readonly knownGaps = [
    'Go extraction is lightweight and does not run go/packages or type checking',
    'build tags, generated files, and interface implementation edges may be incomplete'
  ];

  constructor() {
    super(GO_SEMANTIC_ADAPTER_ID, new Set(['go']));
  }
}

export class RustSemanticAdapter extends RegexBackedSemanticAdapter {
  override readonly knownGaps = [
    'Rust extraction is lightweight and does not run rust-analyzer or cargo metadata',
    'macro expansion, trait implementation edges, and generated code may be incomplete'
  ];

  constructor() {
    super(RUST_SEMANTIC_ADAPTER_ID, new Set(['rust']));
  }
}

export class MultiLanguageRegexAdapter implements SemanticAdapter {
  readonly id = MULTI_LANG_REGEX_ADAPTER_ID;
  readonly version = MULTI_LANG_REGEX_ADAPTER_VERSION;
  readonly capabilities = capabilities;
  readonly confidence = 'heuristic';
  readonly knownGaps = [
    'fallback extraction is broad but shallow and should be treated as coverage guidance, not semantic proof',
    'language-specific parser adapters should replace this path for high-risk changes'
  ];

  supports(_file: ScannedFile): boolean {
    return true;
  }

  start(ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun {
    const filePathSet = new Set(ctx.indexedFiles.map((f) => f.relativePath));
    const importResolver = createImportResolver(ctx.indexedFiles);
    return {
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        yield* extractEvents(file, filePathSet, importResolver);
      }
    };
  }
}

type ImportResolver = (sourcePath: string, specifier: string) => readonly string[];
type ImportResolverWithDiagnostics = {
  resolve: ImportResolver;
  diagnosticsForFile(relativePath: string): readonly string[];
};

async function* extractEvents(
  file: ScannedFile,
  filePathSet: ReadonlySet<string>,
  importResolver: ImportResolverWithDiagnostics
): AsyncIterable<IndexEvent> {
  const contractFile = isContractLikeFile(file.relativePath, file.language);
  const fileDescriptor: EntityDescriptor = {
    kind: contractFile ? 'contract' : 'file',
    path: file.relativePath,
    languageId: file.language,
    displayName: file.relativePath,
    ...(contractFile ? { metadata: contractMetadataForFile(file) } : {})
  };
  const evidenceSnippet = file.content;
  const evidenceFile = file.relativePath;

  if (contractFile) {
    yield {
      kind: 'entity',
      entity: fileDescriptor
    };
  }

  for (const message of importResolver.diagnosticsForFile(file.relativePath)) {
    yield {
      kind: 'diagnostic',
      level: 'warn',
      message,
      file: file.relativePath
    };
  }

  for (const symbol of extractSymbols(file)) {
    const symbolDescriptor: EntityDescriptor = {
      kind: 'symbol',
      path: file.relativePath,
      symbol: symbol.name,
      symbolKind: symbol.kind,
      languageId: file.language,
      displayName: `${symbol.name} (${file.relativePath})`
    };
    yield {
      kind: 'entity',
      entity: { ...symbolDescriptor, metadata: { exported: symbol.exported } }
    };
    yield {
      kind: 'relation',
      relation: makeRelation({
        source: fileDescriptor,
        target: symbolDescriptor,
        kind: 'DECLARES',
        confidence: 'proven',
        provenance: `${symbol.kind}:${symbol.name}`,
        evidenceFile,
        evidenceSnippet: symbol.evidence?.snippet ?? evidenceSnippet,
        ...(symbol.evidence
          ? {
              startLine: symbol.evidence.startLine,
              endLine: symbol.evidence.endLine,
              startCol: symbol.evidence.startCol,
              endCol: symbol.evidence.endCol
            }
          : {})
      })
    };
  }

  if (isJvmLanguage(file.language)) {
    yield* extractSpringEvents(file, fileDescriptor);
  }

  if (contractFile) {
    yield* extractContractEndpointEvents(file, fileDescriptor);
  }

  for (const imported of extractImports(file)) {
    const resolved = resolveImportPath(file.relativePath, imported.specifier, filePathSet, importResolver.resolve);
    if (resolved) {
      yield {
        kind: 'relation',
        relation: makeRelation({
          source: fileDescriptor,
          target: { kind: 'file', path: resolved, languageId: file.language },
          kind: 'DEPENDS_ON',
          confidence: 'proven',
          provenance: imported.specifier,
          evidenceFile,
          evidenceSnippet: imported.snippet,
          startLine: imported.startLine,
          endLine: imported.endLine,
          startCol: imported.startCol,
          endCol: imported.endCol
        })
      };
    } else {
      const externalDescriptor: EntityDescriptor = {
        kind: 'external_entity',
        languageId: file.language,
        displayName: imported.specifier
      };
      yield {
        kind: 'entity',
        entity: { ...externalDescriptor, metadata: { specifier: imported.specifier } }
      };
      yield {
        kind: 'relation',
        relation: makeRelation({
          source: fileDescriptor,
          target: externalDescriptor,
          kind: 'DEPENDS_ON',
          confidence: 'heuristic',
          provenance: imported.specifier,
          evidenceFile,
          evidenceSnippet: imported.snippet,
          startLine: imported.startLine,
          endLine: imported.endLine,
          startCol: imported.startCol,
          endCol: imported.endCol
        })
      };
    }
  }

  for (const call of extractCalls(file, filePathSet, importResolver.resolve)) {
    yield {
      kind: 'relation',
      relation: makeRelation({
        source: call.source ?? fileDescriptor,
        target: call.target,
        kind: 'CALLS',
        confidence: 'inferred',
        provenance: call.provenance,
        evidenceFile,
        evidenceSnippet: call.snippet,
        startLine: call.startLine,
        endLine: call.endLine,
        startCol: call.startCol,
        endCol: call.endCol
      })
    };
  }

  if (isTestSource(file)) {
    for (const target of inferTestTargets(file.relativePath, file.content, file.language, filePathSet, importResolver.resolve)) {
      yield {
        kind: 'relation',
        relation: makeRelation({
          source: fileDescriptor,
          target: { kind: 'file', path: target.path },
          kind: 'VERIFIES',
          confidence: 'inferred',
          provenance: 'test import/name',
          evidenceFile,
          evidenceSnippet: target.evidence?.snippet ?? evidenceSnippet,
          ...(target.evidence
            ? {
                startLine: target.evidence.startLine,
                endLine: target.evidence.endLine,
                startCol: target.evidence.startCol,
                endCol: target.evidence.endCol
              }
            : {})
        })
      };
    }
  }

  if (file.relativePath.toLowerCase().endsWith('.md')) {
    const relationKind = relationKindForMarkdownReference(file.relativePath);
    for (const sourcePath of inferDocTargets(file.content, filePathSet)) {
      yield {
        kind: 'relation',
        relation: makeRelation({
          source: fileDescriptor,
          target: { kind: 'file', path: sourcePath },
          kind: relationKind,
          confidence: 'heuristic',
          provenance: `${markdownEntityKindForPath(file.relativePath)} mention`,
          evidenceFile,
          evidenceSnippet
        })
      };
    }
  }

  if (isSystemOrContractLanguage(file.language)) {
    const relationKind = (contractFile ? 'REFERENCES' : relationKindForSystemReference(file.language)) as RelationKind;
    const textTargets = contractFile
      ? inferExplicitTextTargetsWithEvidence(file.relativePath, file.content, filePathSet)
      : inferTextTargetsWithEvidence(file.relativePath, file.content, filePathSet);
    for (const target of textTargets) {
      yield {
        kind: 'relation',
        relation: makeRelation({
          source: fileDescriptor,
          target: { kind: 'file', path: target.path },
          kind: relationKind,
          confidence: 'heuristic',
          provenance: 'system/config mention',
          evidenceFile,
          evidenceSnippet: target.evidence.snippet,
          startLine: target.evidence.startLine,
          endLine: target.evidence.endLine,
          startCol: target.evidence.startCol,
          endCol: target.evidence.endCol
        })
      };
      if (contractFile) {
        yield {
          kind: 'relation',
          relation: makeRelation({
            source: { kind: 'file', path: target.path },
            target: fileDescriptor,
            kind: 'IMPLEMENTS',
            confidence: 'heuristic',
            provenance: 'contract mention',
            evidenceFile,
            evidenceSnippet: target.evidence.snippet,
            startLine: target.evidence.startLine,
            endLine: target.evidence.endLine,
            startCol: target.evidence.startCol,
            endCol: target.evidence.endCol
          })
        };
      }
    }
  }
}

async function* extractContractEndpointEvents(
  file: ScannedFile,
  fileDescriptor: EntityDescriptor
): AsyncIterable<IndexEvent> {
  const contractKind = contractKindForPath(file.relativePath);
  const endpoints =
    file.language === 'protobuf'
      ? extractProtobufEndpoints(file)
      : file.language === 'graphql'
        ? extractGraphqlEndpoints(file)
        : contractKind === 'asyncapi'
          ? extractAsyncApiEndpoints(file)
          : extractOpenApiEndpoints(file);

  for (const endpoint of endpoints) {
    const endpointDescriptor: EntityDescriptor = {
      kind: 'endpoint',
      languageId: endpoint.languageId ?? file.language,
      displayName: endpoint.displayName,
      metadata: endpoint.metadata
    };
    yield {
      kind: 'entity',
      entity: endpointDescriptor
    };
    yield {
      kind: 'relation',
      relation: makeRelation({
        source: fileDescriptor,
        target: endpointDescriptor,
        kind: 'DECLARES',
        confidence: 'inferred',
        provenance: 'contract operation',
        evidenceFile: file.relativePath,
        evidenceSnippet: endpoint.evidence.snippet,
        startLine: endpoint.evidence.startLine,
        endLine: endpoint.evidence.endLine,
        startCol: endpoint.evidence.startCol,
        endCol: endpoint.evidence.endCol
      })
    };
  }
}

type ContractEndpoint = {
  displayName: string;
  languageId?: string;
  metadata: Readonly<Record<string, unknown>>;
  evidence: EvidenceSpan;
};

const openApiMethods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function extractOpenApiEndpoints(file: ScannedFile): ContractEndpoint[] {
  if (file.language === 'json') return extractOpenApiJsonEndpoints(file);
  return extractOpenApiYamlEndpoints(file);
}

function contractMetadataForFile(file: ScannedFile): Readonly<Record<string, unknown>> {
  if (file.language === 'protobuf') {
    const compatibility = extractProtobufCompatibility(file.content);
    return {
      contractKind: 'protobuf',
      ...(compatibility !== undefined ? { compatibility } : {})
    };
  }
  if (file.language === 'graphql') {
    const compatibility = extractGraphqlCompatibility(file.content);
    return {
      contractKind: 'graphql',
      ...(compatibility !== undefined ? { compatibility } : {})
    };
  }
  if (file.language === 'json') return openApiJsonMetadata(file.content, contractKindForPath(file.relativePath));
  return openApiYamlMetadata(file.content, contractKindForPath(file.relativePath));
}

function contractKindForPath(relativePath: string): string {
  const basename = path.posix.basename(relativePath);
  const withoutExtension = basename.replace(/\.[^.]+$/, '').toLowerCase();
  if (withoutExtension.includes('asyncapi')) return 'asyncapi';
  return 'openapi';
}

function openApiJsonMetadata(
  content: string,
  contractKind: string
): Readonly<Record<string, unknown>> {
  if (contractKind === 'asyncapi') return asyncApiJsonMetadata(content);
  const metadata: Record<string, unknown> = { contractKind };
  try {
    const parsed = JSON.parse(content) as {
      openapi?: unknown;
      swagger?: unknown;
      asyncapi?: unknown;
      info?: { version?: unknown; title?: unknown; 'x-service-name'?: unknown };
      'x-service-name'?: unknown;
    };
    const schemaVersion = contractKind === 'asyncapi' ? parsed.asyncapi : parsed.openapi ?? parsed.swagger;
    if (typeof schemaVersion === 'string') metadata.schemaVersion = schemaVersion;
    const serviceName = parsed['x-service-name'] ?? parsed.info?.['x-service-name'] ?? parsed.info?.title;
    if (typeof serviceName === 'string' && serviceName.length > 0) metadata.serviceName = serviceName;
    const compatibility = extractOpenApiJsonCompatibility(content);
    if (compatibility !== undefined) metadata.compatibility = compatibility;
  } catch {
    // Path-obvious contracts still get a baseline row even if the JSON is invalid.
  }
  return metadata;
}

function openApiYamlMetadata(
  content: string,
  contractKind: string
): Readonly<Record<string, unknown>> {
  if (contractKind === 'asyncapi') return asyncApiYamlMetadata(content);
  const metadata: Record<string, unknown> = { contractKind };
  const schemaMatch = /^\s*(?:openapi|swagger)\s*:\s*['"]?([^'"\s#]+)/im.exec(content);
  if (schemaMatch?.[1]) metadata.schemaVersion = schemaMatch[1];
  const serviceMatch = /^\s*x-service-name\s*:\s*['"]?([^'"\n#]+)/im.exec(content);
  if (serviceMatch?.[1]) metadata.serviceName = serviceMatch[1].trim();
  const compatibility = extractOpenApiYamlCompatibility(content);
  if (compatibility !== undefined) metadata.compatibility = compatibility;
  return metadata;
}

function asyncApiJsonMetadata(content: string): Readonly<Record<string, unknown>> {
  const metadata: Record<string, unknown> = { contractKind: 'asyncapi' };
  try {
    const parsed = JSON.parse(content) as {
      asyncapi?: unknown;
      info?: { version?: unknown; title?: unknown; 'x-service-name'?: unknown };
      'x-service-name'?: unknown;
    };
    if (typeof parsed.asyncapi === 'string') metadata.schemaVersion = parsed.asyncapi;
    const serviceName = parsed['x-service-name'] ?? parsed.info?.['x-service-name'] ?? parsed.info?.title;
    if (typeof serviceName === 'string' && serviceName.length > 0) metadata.serviceName = serviceName;
    const compatibility = extractAsyncApiJsonCompatibility(content);
    if (compatibility !== undefined) metadata.compatibility = compatibility;
  } catch {
    // Path-obvious AsyncAPI contracts still get a baseline row even if the JSON is invalid.
  }
  return metadata;
}

function asyncApiYamlMetadata(content: string): Readonly<Record<string, unknown>> {
  const metadata: Record<string, unknown> = { contractKind: 'asyncapi' };
  const schemaMatch = /^\s*asyncapi\s*:\s*['"]?([^'"\s#]+)/im.exec(content);
  if (schemaMatch?.[1]) metadata.schemaVersion = schemaMatch[1];
  const serviceMatch = /^\s*x-service-name\s*:\s*['"]?([^'"\n#]+)/im.exec(content);
  if (serviceMatch?.[1]) metadata.serviceName = serviceMatch[1].trim();
  const compatibility = extractAsyncApiYamlCompatibility(content);
  if (compatibility !== undefined) metadata.compatibility = compatibility;
  return metadata;
}

function extractOpenApiJsonEndpoints(file: ScannedFile): ContractEndpoint[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const marker = (parsed as { openapi?: unknown; swagger?: unknown }).openapi ??
    (parsed as { openapi?: unknown; swagger?: unknown }).swagger;
  if (typeof marker !== 'string' || marker.length === 0) return [];
  const paths = (parsed as { paths?: unknown }).paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return [];
  const endpoints: ContractEndpoint[] = [];
  for (const [apiPath, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!apiPath.startsWith('/')) continue;
    if (!pathItem || typeof pathItem !== 'object' || Array.isArray(pathItem)) return [];
    for (const method of Object.keys(pathItem as Record<string, unknown>)) {
      const normalizedMethod = method.toLowerCase();
      if (!openApiMethods.has(normalizedMethod)) continue;
      const operation = (pathItem as Record<string, unknown>)[method];
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return [];
      endpoints.push({
        displayName: `${normalizedMethod.toUpperCase()} ${apiPath}`,
        metadata: { path: apiPath, method: normalizedMethod.toUpperCase() },
        evidence: jsonOpenApiMethodEvidence(file.content, apiPath, normalizedMethod)
      });
    }
  }
  return endpoints;
}

function extractAsyncApiEndpoints(file: ScannedFile): ContractEndpoint[] {
  const compatibility = file.language === 'json'
    ? extractAsyncApiJsonCompatibility(file.content)
    : extractAsyncApiYamlCompatibility(file.content);
  if (compatibility === undefined) return [];
  return compatibility.operations.map((operation) => ({
    displayName: `${operation.action.toUpperCase()} ${operation.address}`,
    languageId: 'asyncapi',
    metadata: {
      contractKind: 'asyncapi',
      action: operation.action,
      channelId: operation.channelId,
      address: operation.address,
      messageIds: operation.messageIds
    },
    evidence: evidenceLineAt(file.content, asyncApiOperationOffset(file.content, operation))
  }));
}

function asyncApiOperationOffset(content: string, operation: AsyncApiOperationSignature): number {
  const candidates = [
    operation.address,
    operation.channelId,
    ...operation.messageIds,
    operation.action
  ].filter((candidate) => candidate.length > 0);
  for (const candidate of candidates) {
    const index = content.indexOf(candidate);
    if (index >= 0) return index;
  }
  return 0;
}

function jsonOpenApiMethodEvidence(
  content: string,
  apiPath: string,
  normalizedMethod: string
): EvidenceSpan {
  const methodIndex = findOpenApiJsonMethodKeyIndex(content, apiPath, normalizedMethod);
  return evidenceLineAt(content, methodIndex ?? 0);
}

function findOpenApiJsonMethodKeyIndex(
  content: string,
  apiPath: string,
  normalizedMethod: string
): number | undefined {
  const rootStart = content.indexOf('{');
  if (rootStart < 0) return undefined;
  const rootEnd = findMatchingJsonObjectEnd(content, rootStart);
  if (rootEnd === undefined) return undefined;
  const pathsProperty = findJsonPropertyInObject(content, rootStart, rootEnd, 'paths');
  if (!pathsProperty) return undefined;
  const pathsObjectStart = findNextNonWhitespaceIndex(content, pathsProperty.colonIndex + 1);
  if (content[pathsObjectStart] !== '{') return undefined;
  const pathsObjectEnd = findMatchingJsonObjectEnd(content, pathsObjectStart);
  if (pathsObjectEnd === undefined) return undefined;
  const pathProperty = findJsonPropertyInObject(content, pathsObjectStart, pathsObjectEnd, apiPath);
  if (!pathProperty) return undefined;
  const pathItemStart = findNextNonWhitespaceIndex(content, pathProperty.colonIndex + 1);
  if (content[pathItemStart] !== '{') return undefined;
  const pathItemEnd = findMatchingJsonObjectEnd(content, pathItemStart);
  if (pathItemEnd === undefined) return undefined;
  return findJsonPropertyInObject(content, pathItemStart, pathItemEnd, normalizedMethod)?.keyStart;
}

type JsonPropertyLocation = {
  keyStart: number;
  keyEnd: number;
  colonIndex: number;
};

function findJsonPropertyInObject(
  content: string,
  objectStart: number,
  objectEnd: number,
  propertyName: string
): JsonPropertyLocation | undefined {
  let depth = 0;
  for (let index = objectStart; index <= objectEnd; index++) {
    const char = content[index];
    if (char === '"') {
      const keyEnd = findJsonStringEnd(content, index);
      if (keyEnd === undefined) return undefined;
      const colonIndex = findNextNonWhitespaceIndex(content, keyEnd + 1);
      if (depth === 1 && colonIndex <= objectEnd && content[colonIndex] === ':') {
        const decoded = decodeJsonStringLiteral(content.slice(index, keyEnd + 1));
        if (decoded === propertyName) {
          return { keyStart: index, keyEnd, colonIndex };
        }
      }
      index = keyEnd;
      continue;
    }
    if (char === '{' || char === '[') {
      depth++;
    } else if (char === '}' || char === ']') {
      depth--;
    }
  }
  return undefined;
}

function findMatchingJsonObjectEnd(content: string, objectStart: number): number | undefined {
  let depth = 0;
  for (let index = objectStart; index < content.length; index++) {
    const char = content[index];
    if (char === '"') {
      const stringEnd = findJsonStringEnd(content, index);
      if (stringEnd === undefined) return undefined;
      index = stringEnd;
      continue;
    }
    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function findJsonStringEnd(content: string, stringStart: number): number | undefined {
  let escaped = false;
  for (let index = stringStart + 1; index < content.length; index++) {
    const char = content[index];
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      return index;
    }
  }
  return undefined;
}

function decodeJsonStringLiteral(literal: string): string | undefined {
  try {
    const decoded = JSON.parse(literal) as unknown;
    return typeof decoded === 'string' ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function findNextNonWhitespaceIndex(content: string, start: number): number {
  for (let index = start; index < content.length; index++) {
    if (!/\s/.test(content[index]!)) return index;
  }
  return content.length;
}

function extractOpenApiYamlEndpoints(file: ScannedFile): ContractEndpoint[] {
  if (!/^\s*(?:openapi|swagger)\s*:/im.test(file.content)) return [];

  const endpoints: ContractEndpoint[] = [];
  const lines = file.content.split(/\r?\n/);
  let inPaths = false;
  let currentPath: { value: string; indent: number; childIndent?: number } | undefined;
  let pathsIndent = -1;
  let offset = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    if (line.includes('\t')) return [];
    const trimmed = stripYamlComment(line).trim();
    if (trimmed.length === 0) {
      offset += line.length + 1;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (!inPaths) {
      if (indent !== 0) {
        offset += line.length + 1;
        continue;
      }
      if (/^paths\s*:\s*\{\s*\}\s*(?:#.*)?$/.test(trimmed)) return [];
      if (/^paths\s*:\s*(?:#.*)?$/.test(trimmed)) {
        inPaths = true;
        pathsIndent = indent;
        currentPath = undefined;
        offset += line.length + 1;
        continue;
      }
      offset += line.length + 1;
      continue;
    }

    if (indent <= pathsIndent) break;
    const pathValue = parseYamlPathEntry(trimmed);
    if (pathValue !== undefined) {
      currentPath = { value: pathValue, indent };
      offset += line.length + 1;
      continue;
    }
    if (/^['"]?\//.test(trimmed)) return [];

    const methodWithoutColon = /^([A-Za-z]+)\s*$/.exec(trimmed);
    if (methodWithoutColon && openApiMethods.has(methodWithoutColon[1]!.toLowerCase())) return [];

    if (!currentPath || indent <= currentPath.indent) {
      const methodBeforePath = /^([A-Za-z]+)\s*:/.exec(trimmed);
      if (methodBeforePath && openApiMethods.has(methodBeforePath[1]!.toLowerCase())) return [];
      offset += line.length + 1;
      continue;
    }

    if (currentPath && indent > currentPath.indent && trimmed.length > 0 && !trimmed.startsWith('#')) {
      if (currentPath.childIndent === undefined || indent < currentPath.childIndent) {
        currentPath.childIndent = indent;
      }
    }
    const methodMatch = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(trimmed);
    if (
      currentPath &&
      methodMatch &&
      indent > currentPath.indent &&
      indent === currentPath.childIndent &&
      openApiMethods.has(methodMatch[1]!.toLowerCase())
    ) {
      const inlineValue = methodMatch[2]!.trim();
      if (inlineValue.length > 0 && !(inlineValue.startsWith('{') && inlineValue.endsWith('}'))) return [];
      if (inlineValue.length === 0 && !hasYamlMappingChild(lines, lineIndex, indent)) return [];
      const method = methodMatch[1]!.toUpperCase();
      endpoints.push({
        displayName: `${method} ${currentPath.value}`,
        metadata: { path: currentPath.value, method },
        evidence: evidenceLineAt(file.content, offset)
      });
    }
    offset += line.length + 1;
  }
  return inPaths ? endpoints : [];
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
    if (line.length - line.trimStart().length <= parentIndent) return false;
    return /^['"]?[A-Za-z0-9_$.-]+['"]?\s*:/.test(trimmed);
  }
  return false;
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

function extractProtobufEndpoints(file: ScannedFile): ContractEndpoint[] {
  const compatibility = extractProtobufCompatibility(file.content);
  if (compatibility === undefined) return [];
  return compatibility.operations.map((operation) => ({
    displayName: `${operation.service}.${operation.rpc}`,
    metadata: { rpc: operation.rpc, service: operation.service },
    evidence: evidenceLineAt(file.content, protobufRpcOffset(file.content, operation.rpc))
  }));
}

function protobufRpcOffset(content: string, rpcName: string): number {
  const stripped = stripProtobufComments(content);
  const escapedRpcName = rpcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\brpc\\s+${escapedRpcName}\\s*\\(`).exec(stripped);
  return match?.index ?? 0;
}

function extractGraphqlEndpoints(file: ScannedFile): ContractEndpoint[] {
  const compatibility = extractGraphqlCompatibility(file.content);
  if (compatibility === undefined) return [];
  return compatibility.operations.map((operation) => ({
    displayName: operation.path,
    metadata: { type: operation.rootType, field: operation.field },
    evidence: evidenceLineAt(file.content, graphqlFieldOffset(file.content, operation.rootType, operation.field))
  }));
}

function graphqlFieldOffset(content: string, rootType: string, fieldName: string): number {
  const stripped = stripGraphqlComments(content);
  const escapedRootType = rootType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const typeMatch = new RegExp(`\\b(?:extend\\s+)?type\\s+${escapedRootType}\\b[^{}]*\\{`, 'g').exec(stripped);
  if (!typeMatch) return 0;
  const fieldMatch = new RegExp(`\\b${escapedFieldName}\\s*(?:\\([^)]*\\))?\\s*:`).exec(stripped.slice(typeMatch.index));
  return fieldMatch === null ? typeMatch.index : typeMatch.index + fieldMatch.index;
}

function makeRelation(input: {
  source: EntityDescriptor;
  target: EntityDescriptor;
  kind: RelationKind;
  confidence: Confidence;
  provenance: string;
  evidenceFile: string;
  evidenceSnippet: string;
  startLine?: number;
  endLine?: number;
  startCol?: number;
  endCol?: number;
}): PendingRelation {
  const evidence: PendingEvidence = {
    file: input.evidenceFile,
    snippet: input.evidenceSnippet,
    confidence: input.confidence,
    ...(input.startLine !== undefined ? { startLine: input.startLine } : {}),
    ...(input.endLine !== undefined ? { endLine: input.endLine } : {}),
    ...(input.startCol !== undefined ? { startCol: input.startCol } : {}),
    ...(input.endCol !== undefined ? { endCol: input.endCol } : {})
  };
  return {
    source: input.source,
    target: input.target,
    kind: input.kind,
    metadata: { provenance: input.provenance, confidence: input.confidence },
    evidence: [evidence]
  };
}

function* extractSpringEvents(
  file: ScannedFile,
  fileDescriptor: EntityDescriptor
): Iterable<IndexEvent> {
  const classes = extractSpringClasses(file.content);
  for (const springClass of classes) {
    const classDescriptor: EntityDescriptor = {
      kind: 'symbol',
      path: file.relativePath,
      symbol: springClass.name,
      symbolKind: springClass.kind,
      languageId: file.language,
      displayName: `${springClass.name} (${file.relativePath})`
    };

    for (const role of springRolesForClass(springClass)) {
      yield {
        kind: 'entity',
        entity: {
          ...classDescriptor,
          metadata: { springRole: role }
        }
      };
      yield {
        kind: 'relation',
        relation: makeRelation({
          source: fileDescriptor,
          target: classDescriptor,
          kind: 'DECLARES',
          confidence: 'proven',
          provenance: `spring:${role}:${springClass.name}`,
          evidenceFile: file.relativePath,
          evidenceSnippet: springClass.evidence.snippet,
          startLine: springClass.evidence.startLine,
          endLine: springClass.evidence.endLine,
          startCol: springClass.evidence.startCol,
          endCol: springClass.evidence.endCol
        })
      };
    }

    if (isSpringController(springClass)) {
      yield* extractSpringEndpoints(file, springClass, classDescriptor, fileDescriptor);
    }
  }

  for (const bean of extractSpringBeanMethods(file)) {
    const beanDescriptor: EntityDescriptor = {
      kind: 'symbol',
      path: file.relativePath,
      symbol: bean.name,
      symbolKind: 'method',
      languageId: file.language,
      displayName: `${bean.name} (${file.relativePath})`,
      metadata: { springRole: 'Bean' }
    };
    yield {
      kind: 'entity',
      entity: beanDescriptor
    };
    yield {
      kind: 'relation',
      relation: makeRelation({
        source: fileDescriptor,
        target: beanDescriptor,
        kind: 'DECLARES',
        confidence: 'proven',
        provenance: `spring:Bean:${bean.name}`,
        evidenceFile: file.relativePath,
        evidenceSnippet: bean.evidence.snippet,
        startLine: bean.evidence.startLine,
        endLine: bean.evidence.endLine,
        startCol: bean.evidence.startCol,
        endCol: bean.evidence.endCol
      })
    };
  }
}

function* extractSpringEndpoints(
  file: ScannedFile,
  springClass: SpringClass,
  classDescriptor: EntityDescriptor,
  fileDescriptor: EntityDescriptor
): Iterable<IndexEvent> {
  const basePaths = routePathsForAnnotations(
    springClass.annotations.filter((annotation) => annotation.name === 'RequestMapping')
  );
  for (const mapping of extractSpringMethodMappings(file.content, springClass)) {
    const routes = combineSpringPaths(basePaths, mapping.paths);
    for (const routePath of routes) {
      const httpMethod = mapping.httpMethod;
      const displayName = httpMethod ? `${httpMethod} ${routePath}` : routePath;
      const endpointDescriptor: EntityDescriptor = {
        kind: 'endpoint',
        languageId: file.language,
        symbol: `${file.relativePath}#${springClass.name}.${mapping.methodName}:${displayName}`,
        displayName,
        metadata: {
          framework: 'spring',
          routePath,
          ...(httpMethod ? { httpMethod } : {}),
          controller: springClass.name,
          handler: mapping.methodName
        }
      };
      const relationInput = {
        target: endpointDescriptor,
        kind: 'IMPLEMENTS' as const,
        confidence: 'proven' as const,
        provenance: `spring:endpoint:${springClass.name}.${mapping.methodName}`,
        evidenceFile: file.relativePath,
        evidenceSnippet: mapping.evidence.snippet,
        startLine: mapping.evidence.startLine,
        endLine: mapping.evidence.endLine,
        startCol: mapping.evidence.startCol,
        endCol: mapping.evidence.endCol
      };
      yield {
        kind: 'entity',
        entity: endpointDescriptor
      };
      yield {
        kind: 'relation',
        relation: makeRelation({
          ...relationInput,
          source: classDescriptor
        })
      };
      yield {
        kind: 'relation',
        relation: makeRelation({
          ...relationInput,
          source: fileDescriptor
        })
      };
    }
  }
}

function extractSpringClasses(content: string): SpringClass[] {
  const classes: SpringClass[] = [];
  const classPattern =
    /^([ \t]*(?:@[A-Za-z_][\w.]*[ \t]*(?:\([^)]*\))?[ \t]*(?:\r?\n[ \t]*|[ \t]+))*)(?:(?:public|private|protected|internal|abstract|final|open|data|sealed|static)\s+)*(class|interface|enum|record|object)\s+([A-Za-z_]\w*)\b([^{;\n]*)/gm;
  const matches = [...content.matchAll(classPattern)];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]!;
    const annotationBlock = match[1] ?? '';
    const declaration = match[0]!;
    const startIndex = match.index ?? 0;
    const openBrace = content.indexOf('{', startIndex + declaration.length);
    const bodyOffset = openBrace >= 0 ? openBrace + 1 : startIndex + declaration.length;
    const bodyEnd = openBrace >= 0 ? matchingBraceEnd(content, openBrace) : content.length;
    const annotations = parseSpringAnnotations(annotationBlock, startIndex);
    const annotationStart = annotations.at(0)?.index;
    const evidenceStart = annotationStart ?? firstNonWhitespaceIndex(content, startIndex);
    const evidenceEnd = lineEndIndex(content, openBrace >= 0 ? openBrace + 1 : startIndex + declaration.length);
    classes.push({
      name: match[3]!,
      kind: match[2]!,
      annotations,
      declaration,
      body: content.slice(bodyOffset, bodyEnd),
      bodyOffset,
      evidence: evidenceSpanFromRange(content, evidenceStart, evidenceEnd)
    });
  }
  return classes;
}

function matchingBraceEnd(content: string, openBrace: number): number {
  let depth = 0;
  let mode: 'normal' | 'single' | 'double' | 'triple' | 'line-comment' | 'block-comment' = 'normal';
  for (let index = openBrace; index < content.length; index++) {
    const char = content[index];
    const next = content[index + 1];

    if (mode === 'line-comment') {
      if (char === '\n') mode = 'normal';
      continue;
    }
    if (mode === 'block-comment') {
      if (char === '*' && next === '/') {
        mode = 'normal';
        index++;
      }
      continue;
    }
    if (mode === 'single') {
      if (char === '\\') index++;
      else if (char === "'") mode = 'normal';
      continue;
    }
    if (mode === 'double') {
      if (char === '\\') index++;
      else if (char === '"') mode = 'normal';
      continue;
    }
    if (mode === 'triple') {
      if (content.startsWith('"""', index)) {
        mode = 'normal';
        index += 2;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      mode = 'line-comment';
      index++;
      continue;
    }
    if (char === '/' && next === '*') {
      mode = 'block-comment';
      index++;
      continue;
    }
    if (content.startsWith('"""', index)) {
      mode = 'triple';
      index += 2;
      continue;
    }
    if (char === "'") {
      mode = 'single';
      continue;
    }
    if (char === '"') {
      mode = 'double';
      continue;
    }

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return content.length;
}

function parseSpringAnnotations(annotationBlock: string, offset: number): SpringAnnotation[] {
  const annotations: SpringAnnotation[] = [];
  const annotationPattern = /@([A-Za-z_][\w.]*)(\s*\([^)]*\))?/g;
  let match: RegExpExecArray | null;
  while ((match = annotationPattern.exec(annotationBlock))) {
    const text = match[0]!;
    annotations.push({
      name: simpleAnnotationName(match[1]!),
      args: match[2]?.trim() ?? '',
      index: offset + match.index,
      text: text.trim()
    });
  }
  return annotations;
}

function simpleAnnotationName(name: string): string {
  return name.split('.').at(-1) ?? name;
}

function springRolesForClass(springClass: SpringClass): string[] {
  const roles = new Set<string>();
  for (const annotation of springClass.annotations) {
    const role = springComponentAnnotations.get(annotation.name);
    if (role) roles.add(role);
  }
  if (
    springClass.kind === 'interface' &&
    /\b(?:Repository|JpaRepository|CrudRepository)\s*</.test(springClass.declaration)
  ) {
    roles.add('SpringDataRepository');
  }
  return [...roles].sort();
}

function isSpringController(springClass: SpringClass): boolean {
  return springClass.annotations.some(
    (annotation) => annotation.name === 'RestController' || annotation.name === 'Controller'
  );
}

function extractSpringMethodMappings(
  content: string,
  springClass: SpringClass
): Array<{
  methodName: string;
  httpMethod?: string;
  paths: readonly string[];
  evidence: EvidenceSpan;
}> {
  const mappings: Array<{
    methodName: string;
    httpMethod?: string;
    paths: readonly string[];
    evidence: EvidenceSpan;
  }> = [];
  const mappingPattern =
    /@([A-Za-z_][\w.]*Mapping)\s*(\([^)]*\))?/g;
  let match: RegExpExecArray | null;
  while ((match = mappingPattern.exec(springClass.body))) {
    const annotationName = simpleAnnotationName(match[1]!);
    if (!springMappingMethods.has(annotationName)) continue;

    const afterAnnotation = springClass.body.slice(match.index + match[0]!.length);
    const signature = methodSignatureAfterSpringAnnotation(afterAnnotation);
    if (!signature) continue;

    const startIndex = springClass.bodyOffset + match.index;
    const endIndex = springClass.bodyOffset + match.index + match[0]!.length + signature.endOffset;
    const httpMethod =
      springMappingMethods.get(annotationName) ?? httpMethodFromRequestMapping(match[2] ?? '');
    mappings.push({
      methodName: signature.methodName,
      paths: routePathsFromAnnotationArgs(match[2] ?? ''),
      evidence: evidenceSpanFromRange(content, startIndex, endIndex),
      ...(httpMethod ? { httpMethod } : {})
    });
  }
  return mappings;
}

function methodNameAfterSpringAnnotation(afterAnnotation: string): string | undefined {
  return methodSignatureAfterSpringAnnotation(afterAnnotation)?.methodName;
}

function methodSignatureAfterSpringAnnotation(
  afterAnnotation: string
): { methodName: string; endOffset: number } | undefined {
  const kotlin = afterAnnotation.match(
    /^\s*(?:@[A-Za-z_][\w.]*\s*(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|internal|open|override|suspend)\s+)*fun\s+([A-Za-z_]\w*)\s*\(/
  );
  if (kotlin) return methodSignatureMatch(afterAnnotation, kotlin);
  const java = afterAnnotation.match(
    /^\s*(?:@[A-Za-z_][\w.]*\s*(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)*(?:[A-Za-z_][\w$<>,.?[\]\s]*\s+)?([A-Za-z_]\w*)\s*\(/
  );
  return java ? methodSignatureMatch(afterAnnotation, java) : undefined;
}

function methodSignatureMatch(
  source: string,
  match: RegExpMatchArray
): { methodName: string; endOffset: number } {
  const methodName = match[1]!;
  const nameOffset = match[0]!.lastIndexOf(methodName);
  return {
    methodName,
    endOffset: lineEndIndex(source, nameOffset)
  };
}

function httpMethodFromRequestMapping(args: string): string | undefined {
  return args.match(/\bRequestMethod\.(GET|POST|PUT|PATCH|DELETE)\b/)?.[1]
    ?? args.match(/\bmethod\s*=\s*(?:RequestMethod\.)?(GET|POST|PUT|PATCH|DELETE)\b/)?.[1];
}

function routePathsForAnnotations(annotations: readonly SpringAnnotation[]): string[] {
  const paths = annotations.flatMap((annotation) => routePathsFromAnnotationArgs(annotation.args));
  return paths.length > 0 ? paths : [''];
}

function routePathsFromAnnotationArgs(args: string): string[] {
  if (!args || args === '()') return [''];
  const body = args.slice(1, -1);
  const namedPaths = [...body.matchAll(/\b(?:value|path)\s*=\s*(\{[^}]*\}|\[[^\]]*\]|["'][^"']*["'])/g)]
    .flatMap((match) => stringsInAnnotationValue(match[1] ?? ''));
  if (namedPaths.length > 0) return namedPaths;

  const positionalValue = body.match(/^\s*(\{[^}]*\}|\[[^\]]*\]|["'][^"']*["'])/)?.[1];
  if (positionalValue) {
    const positionalPaths = stringsInAnnotationValue(positionalValue);
    if (positionalPaths.length > 0) return positionalPaths;
  }
  return [''];
}

function stringsInAnnotationValue(value: string): string[] {
  return [...value.matchAll(/["']([^"']*)["']/g)].map((match) => match[1] ?? '');
}

function combineSpringPaths(basePaths: readonly string[], methodPaths: readonly string[]): string[] {
  const bases = basePaths.length > 0 ? basePaths : [''];
  const methods = methodPaths.length > 0 ? methodPaths : [''];
  return [...new Set(bases.flatMap((base) => methods.map((method) => normalizeSpringPath(base, method))))].sort();
}

function normalizeSpringPath(base: string, method: string): string {
  const parts = [base, method]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => part.replace(/^\/+|\/+$/g, ''));
  return `/${parts.join('/')}`.replace(/\/+/g, '/');
}

function extractSpringBeanMethods(
  file: ScannedFile
): Array<{ name: string; evidence: EvidenceSpan }> {
  const beans: Array<{ name: string; evidence: EvidenceSpan }> = [];
  const beanPattern = /@(?:[A-Za-z_][\w.]*\.)?Bean\s*(?:\([^)]*\))?/g;
  let match: RegExpExecArray | null;
  while ((match = beanPattern.exec(file.content))) {
    const signature = methodSignatureAfterSpringAnnotation(
      file.content.slice(match.index + match[0]!.length)
    );
    if (!signature) continue;
    beans.push({
      name: signature.methodName,
      evidence: evidenceSpanFromRange(
        file.content,
        match.index,
        match.index + match[0]!.length + signature.endOffset
      )
    });
  }
  return beans;
}

function snippetFrom(content: string, startIndex: number, endIndex: number): string {
  const start = content.lastIndexOf('\n', startIndex) + 1;
  const nextNewline = content.indexOf('\n', endIndex);
  const end = nextNewline === -1 ? content.length : nextNewline;
  return content.slice(start, end).trim();
}

function evidenceSpanFromRange(content: string, startIndex: number, endIndex: number): EvidenceSpan {
  const boundedEnd = Math.max(startIndex, endIndex);
  const start = offsetPosition(content, startIndex);
  const end = offsetPosition(content, boundedEnd);
  return {
    snippet: snippetFrom(content, startIndex, boundedEnd),
    startLine: start.line,
    endLine: end.line,
    startCol: start.col,
    endCol: end.col
  };
}

function exactEvidenceSpanFromRange(content: string, startIndex: number, endIndex: number): EvidenceSpan {
  const boundedEnd = Math.max(startIndex, endIndex);
  const start = offsetPosition(content, startIndex);
  const end = offsetPosition(content, boundedEnd);
  return {
    snippet: content.slice(startIndex, boundedEnd).trim(),
    startLine: start.line,
    endLine: end.line,
    startCol: start.col,
    endCol: end.col
  };
}

function lineEndIndex(content: string, index: number): number {
  const nextNewline = content.indexOf('\n', Math.max(0, index));
  return nextNewline === -1 ? content.length : nextNewline;
}

function firstNonWhitespaceIndex(content: string, index: number): number {
  const lineStart = content.lastIndexOf('\n', Math.max(0, index)) + 1;
  const match = content.slice(lineStart).match(/[^\s]/);
  return match ? lineStart + match.index! : lineStart;
}

function extractSymbols(file: ScannedFile): ExtractedSymbol[] {
  if (file.relativePath.endsWith('.md') || isSystemOrContractLanguage(file.language)) return [];
  const symbols: ExtractedSymbol[] = [];
  const addMatches = (
    pattern: RegExp,
    kindIndex: number,
    nameIndex: number,
    exportedIndex?: number
  ) => {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(file.content))) {
      symbols.push({
        name: match[nameIndex]!,
        kind: match[kindIndex]!,
        exported: exportedIndex === undefined ? false : Boolean(match[exportedIndex]),
        ...symbolEvidenceForMatch(file, match)
      });
    }
  };
  const addFixedKindMatches = (
    pattern: RegExp,
    kind: string,
    nameIndex: number,
    exportedIndex?: number
  ) => {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(file.content))) {
      symbols.push({
        name: match[nameIndex]!,
        kind,
        exported: exportedIndex === undefined ? false : Boolean(match[exportedIndex]),
        ...symbolEvidenceForMatch(file, match)
      });
    }
  };

  if (file.language === 'typescript' || file.language === 'javascript') {
    return extractTypeScriptJavaScriptSymbols(file);
  } else if (file.language === 'python') {
    addMatches(/^\s*(?:async\s+)?(def)\s+([A-Za-z_]\w*)\s*\(/gm, 1, 2);
    addMatches(/^\s*(class)\s+([A-Za-z_]\w*)\b/gm, 1, 2);
  } else if (file.language === 'go') {
    addMatches(/\b(func)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/g, 1, 2);
    addMatches(/\b(type)\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/g, 1, 2);
  } else if (file.language === 'rust') {
    addMatches(/\b(pub\s+)?(fn)\s+([A-Za-z_]\w*)\s*[<(]/g, 2, 3, 1);
    addMatches(/\b(pub\s+)?(struct|enum|trait)\s+([A-Za-z_]\w*)\b/g, 2, 3, 1);
  } else if (file.language === 'java' || file.language === 'kotlin' || file.language === 'csharp') {
    addMatches(/\b(public|private|protected|internal|export)?\s*(class|interface|enum|record|object)\s+([A-Za-z_]\w*)\b/g, 2, 3, 1);
    addFixedKindMatches(/\bfun\s+([A-Za-z_]\w*)\s*\(/g, 'function', 1);
    addFixedKindMatches(/\b(?:public|private|protected|internal|static|final|override|async|\s){1,40}[A-Za-z_<>,.[\]?]{1,200}\s+([A-Za-z_]\w*)\s*\(/g, 'method', 1);
  } else if (file.language === 'c' || file.language === 'cpp') {
    addMatches(/\b(class|struct|enum)\s+([A-Za-z_]\w*)\b/g, 1, 2);
    addFixedKindMatches(/^[ \t]*[A-Za-z_][\w:*<>,\s]{0,200}\s+([A-Za-z_]\w*)\s*\([^;{}\n]{0,500}\)\s*\{/gm, 'function', 1);
  }

  return dedupeSymbols(symbols);
}

function extractTypeScriptJavaScriptSymbols(file: ScannedFile): ExtractedSymbol[] {
  const sourceFile = ts.createSourceFile(
    file.relativePath,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file.relativePath)
  );
  const symbols: ExtractedSymbol[] = [];

  const addNamedNode = (
    name: ts.Node | undefined,
    kind: string,
    node: ts.Node,
    exported: boolean
  ): void => {
    if (!name || !ts.isIdentifier(name)) return;
    addSymbol(name.text, kind, node, exported);
  };

  const addSymbol = (
    name: string,
    kind: string,
    node: ts.Node,
    exported: boolean
  ): void => {
    symbols.push({
      name,
      kind,
      exported,
      evidence: nodeEvidence(file.content, sourceFile, node)
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) {
      addNamedNode(node.name, 'function', node, hasExportModifier(node));
    } else if (ts.isClassDeclaration(node)) {
      addNamedNode(node.name, 'class', node, hasExportModifier(node));
    } else if (ts.isInterfaceDeclaration(node)) {
      addNamedNode(node.name, 'interface', node, hasExportModifier(node));
    } else if (ts.isTypeAliasDeclaration(node)) {
      addNamedNode(node.name, 'type', node, hasExportModifier(node));
    } else if (ts.isEnumDeclaration(node)) {
      addNamedNode(node.name, 'enum', node, hasExportModifier(node));
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      const className = enclosingTypeScriptJavaScriptClassName(node);
      if (className) {
        addSymbol(`${className}.${node.name.text}`, 'method', node, classHasExportModifier(node));
      }
    } else if (ts.isMethodSignature(node) && ts.isIdentifier(node.name)) {
      const typeName = enclosingTypeScriptJavaScriptTypeMemberOwnerName(node);
      if (typeName) {
        addSymbol(`${typeName}.${node.name.text}`, 'method', node, typeMemberOwnerHasExportModifier(node));
      }
    } else if (isCallableTypePropertySignature(node)) {
      const typeName = enclosingTypeScriptJavaScriptTypeMemberOwnerName(node);
      if (typeName && ts.isIdentifier(node.name)) {
        addSymbol(`${typeName}.${node.name.text}`, 'method', node, typeMemberOwnerHasExportModifier(node));
      }
    } else if (isCallableClassProperty(node)) {
      const className = enclosingTypeScriptJavaScriptClassName(node);
      if (className && ts.isIdentifier(node.name)) {
        addSymbol(`${className}.${node.name.text}`, 'method', node, classHasExportModifier(node));
      }
    } else if (ts.isVariableStatement(node)) {
      const exported = hasExportModifier(node);
      const kind = variableKind(node.declarationList);
      for (const declaration of node.declarationList.declarations) {
        addNamedNode(declaration.name, kind, node, exported);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return dedupeSymbols(symbols);
}

function nodeEvidence(content: string, sourceFile: ts.SourceFile, node: ts.Node): EvidenceSpan {
  return evidenceSpanFromRange(content, node.getStart(sourceFile), node.getEnd());
}

function nodeExactEvidence(content: string, sourceFile: ts.SourceFile, node: ts.Node): EvidenceSpan {
  return exactEvidenceSpanFromRange(content, node.getStart(sourceFile), node.getEnd());
}

function variableKind(declarationList: ts.VariableDeclarationList): string {
  if ((declarationList.flags & ts.NodeFlags.Const) !== 0) return 'const';
  if ((declarationList.flags & ts.NodeFlags.Let) !== 0) return 'let';
  return 'var';
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(
    (node as { modifiers?: readonly ts.ModifierLike[] }).modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    )
  );
}

function hasStaticModifier(node: ts.Node): boolean {
  return Boolean(
    (node as { modifiers?: readonly ts.ModifierLike[] }).modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword
    )
  );
}

function isConstructorParameterProperty(node: ts.ParameterDeclaration): boolean {
  return ts.isConstructorDeclaration(node.parent)
    && Boolean(
      (node as { modifiers?: readonly ts.ModifierLike[] }).modifiers?.some((modifier) =>
        modifier.kind === ts.SyntaxKind.PrivateKeyword
        || modifier.kind === ts.SyntaxKind.PublicKeyword
        || modifier.kind === ts.SyntaxKind.ProtectedKeyword
        || modifier.kind === ts.SyntaxKind.ReadonlyKeyword
      )
    );
}

function symbolEvidenceForMatch(
  file: ScannedFile,
  match: RegExpExecArray
): { evidence: EvidenceSpan } | Record<string, never> {
  if (file.language !== 'python' && file.language !== 'go' && file.language !== 'rust') return {};
  return {
    evidence: declarationLineEvidence(file.content, match.index, match[0]!.length, file.language)
  };
}

function declarationLineEvidence(
  content: string,
  matchIndex: number,
  matchLength: number,
  language: string
): EvidenceSpan {
  const startIndex = declarationEvidenceStart(content, matchIndex, language);
  return evidenceSpanFromRange(content, startIndex, lineEndIndex(content, matchIndex + matchLength));
}

function declarationEvidenceStart(content: string, declarationIndex: number, language: string): number {
  let start = firstNonWhitespaceIndex(content, declarationIndex);
  if (language !== 'python' && language !== 'rust') return start;

  let lineStart = content.lastIndexOf('\n', Math.max(0, declarationIndex - 1)) + 1;
  while (lineStart > 0) {
    const previousLineEnd = lineStart - 1;
    const previousLineStart = content.lastIndexOf('\n', previousLineEnd - 1) + 1;
    const previousLine = content.slice(previousLineStart, previousLineEnd).trim();
    const isAttribute =
      language === 'python'
        ? previousLine.startsWith('@')
        : /^#\s*\[/.test(previousLine);
    if (!isAttribute) break;
    start = firstNonWhitespaceIndex(content, previousLineStart);
    lineStart = previousLineStart;
  }
  return start;
}

function extractImports(file: ScannedFile): ExtractedImport[] {
  if (file.relativePath.endsWith('.md')) return [];
  if (file.language === 'typescript' || file.language === 'javascript') {
    return extractTypeScriptJavaScriptImports(file);
  }
  const imports: ExtractedImport[] = [];
  const patterns: RegExp[] = [];
  if (file.language === 'python') {
    patterns.push(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\b[^\n]*/gm, /^\s*import\s+([A-Za-z_][\w.]*)[^\n]*/gm);
  } else if (file.language === 'go') {
    patterns.push(/\bimport\s+"([^"]+)"/g, /^\s*"([^"]+)"\s*$/gm);
  } else if (file.language === 'rust') {
    patterns.push(/\buse\s+([^;]+);/g, /\bextern\s+crate\s+([A-Za-z_]\w*)\s*;/g);
  } else if (file.language === 'java' || file.language === 'kotlin') {
    patterns.push(/^\s*import\s+([A-Za-z_][\w.*]*)\s*;?/gm);
  } else if (file.language === 'csharp') {
    patterns.push(/^\s*using\s+([A-Za-z_][\w.]*)\s*;/gm);
  } else if (file.language === 'c' || file.language === 'cpp') {
    patterns.push(/^\s*#include\s+[<"]([^>"]+)[>"]/gm);
  } else if (file.language === 'shell') {
    patterns.push(/^\s*(?:source|\.)\s+([^\s#]+)/gm);
  } else if (file.language === 'dockerfile') {
    patterns.push(/^\s*(?:COPY|ADD)\s+([^\s]+)\s+/gim);
  } else if (file.language === 'protobuf') {
    patterns.push(/^\s*import\s+"([^"]+)";/gm);
  }
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(file.content))) {
      const specifier = match[1]!;
      imports.push(importEvidence(file.content, specifier, match.index, match.index + match[0]!.length));
    }
  }
  return dedupeImports(imports);
}

function extractTypeScriptJavaScriptImports(file: ScannedFile): ExtractedImport[] {
  const sourceFile = ts.createSourceFile(
    file.relativePath,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file.relativePath)
  );
  const imports: ExtractedImport[] = [];
  const addImport = (specifier: string | undefined, node: ts.Node): void => {
    if (!specifier) return;
    imports.push(importEvidence(file.content, specifier, node.getStart(sourceFile), node.getEnd()));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      addImport(moduleSpecifierText(node.moduleSpecifier), node);
    } else if (ts.isExportDeclaration(node)) {
      addImport(moduleSpecifierText(node.moduleSpecifier), node);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addImport(moduleSpecifierText(node.moduleReference.expression), node);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        addImport(moduleSpecifierText(node.arguments[0]), node);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        addImport(moduleSpecifierText(node.arguments[0]), node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return dedupeImports(imports);
}

function extractCalls(
  file: ScannedFile,
  filePathSet: ReadonlySet<string>,
  importResolver?: ImportResolver
): ExtractedCall[] {
  if (file.language !== 'typescript' && file.language !== 'javascript') return [];
  const sourceFile = ts.createSourceFile(
    file.relativePath,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file.relativePath)
  );
  const importBindings = collectTypeScriptJavaScriptImportBindings(
    file,
    sourceFile,
    filePathSet,
    importResolver
  );
  const localCallables = collectTypeScriptJavaScriptLocalCallables(file, sourceFile);
  const factoryReturnTypes = collectTypeScriptJavaScriptFactoryReturnTypes(sourceFile);
  const localInstanceBindings = collectTypeScriptJavaScriptLocalInstanceBindings(
    sourceFile,
    localCallables,
    factoryReturnTypes
  );
  const classInstanceBindings = collectTypeScriptJavaScriptClassInstanceBindings(
    sourceFile,
    localCallables,
    factoryReturnTypes
  );
  const staticClassCallables = collectTypeScriptJavaScriptStaticClassCallables(sourceFile);
  const calls: ExtractedCall[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const target = callTargetForExpression(node.expression, importBindings);
      if (target) {
        const evidence = nodeExactEvidence(file.content, sourceFile, node);
        calls.push({
          ...evidence,
          target: { kind: 'file', path: target.targetPath, languageId: file.language },
          callee: target.callee,
          provenance: `call:${target.callee}:${evidence.startLine}:${evidence.startCol}`
        });
      } else {
        const localSource = enclosingLocalCaller(node, localCallables);
        const localTarget = localSource
          ? localCallTargetForExpression(
            node.expression,
            localCallables,
            localInstanceBindings,
            classInstanceBindings,
            staticClassCallables,
            localSource.name
          )
          : undefined;
        if (localSource && localTarget) {
          const evidence = nodeExactEvidence(file.content, sourceFile, node);
          const provenanceKind = isThisFieldInstanceCallExpression(node.expression)
            ? 'field-instance-call'
            : isDirectNewInstanceCallExpression(node.expression)
            ? 'direct-instance-call'
            : isStaticClassCallExpression(node.expression, staticClassCallables)
            ? 'static-call'
            : ts.isPropertyAccessExpression(node.expression)
            && ts.isIdentifier(node.expression.expression)
            ? 'instance-call'
            : ts.isPropertyAccessExpression(node.expression)
            && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
            ? 'method-call'
            : 'local-call';
          calls.push({
            ...evidence,
            source: localSource.descriptor,
            target: localTarget.descriptor,
            callee: localTarget.name,
            provenance: `${provenanceKind}:${localSource.name}->${localTarget.name}:${evidence.startLine}:${evidence.startCol}`
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return dedupeCalls(calls);
}

function collectTypeScriptJavaScriptLocalCallables(
  file: ScannedFile,
  sourceFile: ts.SourceFile
): Map<string, TsLocalCallable> {
  const callables = new Map<string, TsLocalCallable>();

  const addCallable = (name: string | undefined, symbolKind: string): void => {
    if (!name) return;
    callables.set(name, {
      name,
      symbolKind,
      descriptor: {
        kind: 'symbol',
        path: file.relativePath,
        symbol: name,
        symbolKind,
        languageId: file.language,
        displayName: `${name} (${file.relativePath})`
      }
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      addCallable(node.name.text, 'function');
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      const className = enclosingTypeScriptJavaScriptClassName(node);
      if (className) addCallable(`${className}.${node.name.text}`, 'method');
    } else if (ts.isMethodSignature(node) && ts.isIdentifier(node.name)) {
      const typeName = enclosingTypeScriptJavaScriptTypeMemberOwnerName(node);
      if (typeName) addCallable(`${typeName}.${node.name.text}`, 'method');
    } else if (isCallableTypePropertySignature(node)) {
      const typeName = enclosingTypeScriptJavaScriptTypeMemberOwnerName(node);
      if (typeName && ts.isIdentifier(node.name)) {
        addCallable(`${typeName}.${node.name.text}`, 'method');
      }
    } else if (isCallableClassProperty(node)) {
      const className = enclosingTypeScriptJavaScriptClassName(node);
      if (className && ts.isIdentifier(node.name)) {
        addCallable(`${className}.${node.name.text}`, 'method');
      }
    } else if (ts.isVariableStatement(node)) {
      const symbolKind = variableKind(node.declarationList);
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        if (!isCallableInitializer(declaration.initializer)) continue;
        addCallable(declaration.name.text, symbolKind);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return callables;
}

function collectTypeScriptJavaScriptFactoryReturnTypes(sourceFile: ts.SourceFile): Map<string, string> {
  const factoryReturnTypes = new Map<string, string>();

  const addReturnType = (name: string | undefined, type: ts.TypeNode | undefined): void => {
    if (!name) return;
    const className = classNameFromTypeReference(type);
    if (!className) return;
    factoryReturnTypes.set(name, className);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      addReturnType(node.name.text, node.type);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      addReturnType(node.name.text, returnTypeFromCallableInitializer(node.initializer));
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return factoryReturnTypes;
}

function collectTypeScriptJavaScriptLocalInstanceBindings(
  sourceFile: ts.SourceFile,
  localCallables: ReadonlyMap<string, TsLocalCallable>,
  factoryReturnTypes: ReadonlyMap<string, string>
): Map<string, TsLocalInstanceBinding> {
  const bindings = new Map<string, TsLocalInstanceBinding>();

  const addBinding = (scopeName: string, localName: string, className: string): void => {
    if (!hasLocalTypeMemberMethod(localCallables, className)) return;
    bindings.set(scopedLocalName(scopeName, localName), { className });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const className = classNameFromKnownInstanceExpression(node.initializer, factoryReturnTypes)
        ?? classNameFromInitializedTypeReference(node);
      const scope = enclosingLocalCaller(node, localCallables);
      if (className && scope) addBinding(scope.name, node.name.text, className);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      const className = classNameFromTypeReference(node.type);
      const scope = enclosingLocalCaller(node, localCallables);
      if (className && scope) addBinding(scope.name, node.name.text, className);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return bindings;
}

function collectTypeScriptJavaScriptClassInstanceBindings(
  sourceFile: ts.SourceFile,
  localCallables: ReadonlyMap<string, TsLocalCallable>,
  factoryReturnTypes: ReadonlyMap<string, string>
): Map<string, TsLocalInstanceBinding> {
  const bindings = new Map<string, TsLocalInstanceBinding>();

  const addBinding = (ownerClassName: string, propertyName: string, className: string): void => {
    if (!hasLocalTypeMemberMethod(localCallables, className)) return;
    bindings.set(scopedLocalName(ownerClassName, propertyName), { className });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      const ownerClassName = enclosingTypeScriptJavaScriptClassName(node);
      const className = classNameFromKnownInstanceExpression(node.initializer, factoryReturnTypes)
        ?? classNameFromInitializedTypeReference(node);
      if (ownerClassName && className) addBinding(ownerClassName, node.name.text, className);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name) && isConstructorParameterProperty(node)) {
      const ownerClassName = enclosingTypeScriptJavaScriptClassName(node);
      const className = classNameFromTypeReference(node.type);
      if (ownerClassName && className) addBinding(ownerClassName, node.name.text, className);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const ownerClassName = enclosingTypeScriptJavaScriptClassName(node);
      const propertyName = thisPropertyName(node.left);
      const className = classNameFromConstructorAssignment(node, factoryReturnTypes);
      if (ownerClassName && propertyName && className) addBinding(ownerClassName, propertyName, className);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return bindings;
}

function collectTypeScriptJavaScriptStaticClassCallables(sourceFile: ts.SourceFile): Set<string> {
  const callables = new Set<string>();

  const addCallable = (className: string | undefined, methodName: string | undefined): void => {
    if (!className || !methodName) return;
    callables.add(`${className}.${methodName}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && hasStaticModifier(node)) {
      addCallable(enclosingTypeScriptJavaScriptClassName(node), node.name.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return callables;
}

function hasLocalTypeMemberMethod(
  localCallables: ReadonlyMap<string, TsLocalCallable>,
  typeName: string
): boolean {
  for (const name of localCallables.keys()) {
    if (name.startsWith(`${typeName}.`)) return true;
  }
  return false;
}

function classNameFromNewExpression(node: ts.Expression | undefined): string | undefined {
  if (!node || !ts.isNewExpression(node)) return undefined;
  return ts.isIdentifier(node.expression) ? node.expression.text : undefined;
}

function classNameFromKnownInstanceExpression(
  node: ts.Expression | undefined,
  factoryReturnTypes: ReadonlyMap<string, string>
): string | undefined {
  return classNameFromNewExpression(node) ?? classNameFromFactoryCall(node, factoryReturnTypes);
}

function classNameFromFactoryCall(
  node: ts.Expression | undefined,
  factoryReturnTypes: ReadonlyMap<string, string>
): string | undefined {
  if (!node || !ts.isCallExpression(node)) return undefined;
  if (!ts.isIdentifier(node.expression)) return undefined;
  return factoryReturnTypes.get(node.expression.text);
}

function classNameFromTypeReference(node: ts.TypeNode | undefined): string | undefined {
  if (!node || !ts.isTypeReferenceNode(node)) return undefined;
  return ts.isIdentifier(node.typeName) ? node.typeName.text : undefined;
}

function returnTypeFromCallableInitializer(node: ts.Expression | undefined): ts.TypeNode | undefined {
  if (!node) return undefined;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node.type;
  return undefined;
}

function classNameFromInitializedTypeReference(
  node: ts.VariableDeclaration | ts.PropertyDeclaration
): string | undefined {
  if (!node.initializer) return undefined;
  return classNameFromTypeReference(node.type);
}

function classNameFromConstructorAssignment(
  node: ts.BinaryExpression,
  factoryReturnTypes: ReadonlyMap<string, string>
): string | undefined {
  const constructorNode = enclosingConstructorDeclaration(node);
  if (!constructorNode) return undefined;
  const className = classNameFromKnownInstanceExpression(node.right, factoryReturnTypes);
  if (className) return className;
  if (!ts.isIdentifier(node.right)) return undefined;
  return classNameFromConstructorParameter(constructorNode, node.right.text);
}

function classNameFromConstructorParameter(
  node: ts.ConstructorDeclaration,
  parameterName: string
): string | undefined {
  for (const parameter of node.parameters) {
    if (!ts.isIdentifier(parameter.name) || parameter.name.text !== parameterName) continue;
    return classNameFromTypeReference(parameter.type);
  }
  return undefined;
}

function isCallableInitializer(node: ts.Expression | undefined): boolean {
  return Boolean(node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)));
}

function isCallableClassProperty(node: ts.Node): node is ts.PropertyDeclaration {
  return ts.isPropertyDeclaration(node)
    && ts.isIdentifier(node.name)
    && isCallableInitializer(node.initializer);
}

function isCallableTypePropertySignature(node: ts.Node): node is ts.PropertySignature {
  return ts.isPropertySignature(node)
    && ts.isIdentifier(node.name)
    && Boolean(node.type && ts.isFunctionTypeNode(node.type));
}

type TsImportBinding = {
  targetPath: string;
  importedName?: string;
  namespace: boolean;
};

function collectTypeScriptJavaScriptImportBindings(
  file: ScannedFile,
  sourceFile: ts.SourceFile,
  filePathSet: ReadonlySet<string>,
  importResolver?: ImportResolver
): Map<string, TsImportBinding> {
  const bindings = new Map<string, TsImportBinding>();

  const addBinding = (
    localName: string | undefined,
    specifier: string | undefined,
    importedName: string | undefined,
    namespace: boolean
  ): void => {
    if (!localName || !specifier) return;
    const targetPath = resolveImportPath(file.relativePath, specifier, filePathSet, importResolver);
    if (!targetPath) return;
    bindings.set(localName, {
      targetPath,
      ...(importedName ? { importedName } : {}),
      namespace
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = moduleSpecifierText(node.moduleSpecifier);
      if (node.importClause?.name) {
        addBinding(node.importClause.name.text, specifier, 'default', false);
      }
      const namedBindings = node.importClause?.namedBindings;
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        addBinding(namedBindings.name.text, specifier, undefined, true);
      } else if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          addBinding(
            element.name.text,
            specifier,
            element.propertyName?.text ?? element.name.text,
            false
          );
        }
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addBinding(
        node.name.text,
        moduleSpecifierText(node.moduleReference.expression),
        undefined,
        true
      );
    } else if (ts.isVariableStatement(node)) {
      collectRequireBindings(node, addBinding);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return bindings;
}

function collectRequireBindings(
  node: ts.VariableStatement,
  addBinding: (
    localName: string | undefined,
    specifier: string | undefined,
    importedName: string | undefined,
    namespace: boolean
  ) => void
): void {
  for (const declaration of node.declarationList.declarations) {
    const specifier = requireSpecifier(declaration.initializer);
    if (!specifier) continue;
    if (ts.isIdentifier(declaration.name)) {
      addBinding(declaration.name.text, specifier, undefined, true);
    } else if (ts.isObjectBindingPattern(declaration.name)) {
      for (const element of declaration.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const importedName = element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.text;
        addBinding(element.name.text, specifier, importedName, false);
      }
    }
  }
}

function requireSpecifier(node: ts.Expression | undefined): string | undefined {
  if (!node || !ts.isCallExpression(node)) return undefined;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'require') return undefined;
  return moduleSpecifierText(node.arguments[0]);
}

function callTargetForExpression(
  expression: ts.Expression,
  importBindings: ReadonlyMap<string, TsImportBinding>
): { targetPath: string; callee: string } | undefined {
  if (ts.isIdentifier(expression)) {
    const binding = importBindings.get(expression.text);
    if (!binding || binding.namespace) return undefined;
    return {
      targetPath: binding.targetPath,
      callee: binding.importedName && binding.importedName !== expression.text
        ? binding.importedName
        : expression.text
    };
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const binding = importBindings.get(expression.expression.text);
    if (!binding || !binding.namespace) return undefined;
    return {
      targetPath: binding.targetPath,
      callee: `${expression.expression.text}.${expression.name.text}`
    };
  }
  return undefined;
}

function localCallTargetForExpression(
  expression: ts.Expression,
  localCallables: ReadonlyMap<string, TsLocalCallable>,
  localInstanceBindings: ReadonlyMap<string, TsLocalInstanceBinding>,
  classInstanceBindings: ReadonlyMap<string, TsLocalInstanceBinding>,
  staticClassCallables: ReadonlySet<string>,
  sourceScopeName: string
): TsLocalCallable | undefined {
  if (ts.isIdentifier(expression)) {
    return localCallables.get(expression.text);
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const instance = localInstanceBindings.get(scopedLocalName(sourceScopeName, expression.expression.text));
    if (instance) return localCallables.get(`${instance.className}.${expression.name.text}`);
    const staticName = `${expression.expression.text}.${expression.name.text}`;
    return staticClassCallables.has(staticName) ? localCallables.get(staticName) : undefined;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const propertyName = thisPropertyName(expression.expression);
    const className = enclosingTypeScriptJavaScriptClassName(expression);
    const instance = className && propertyName
      ? classInstanceBindings.get(scopedLocalName(className, propertyName))
      : undefined;
    if (instance) return localCallables.get(`${instance.className}.${expression.name.text}`);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const className = classNameFromNewExpression(expression.expression);
    if (className) return localCallables.get(`${className}.${expression.name.text}`);
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    const className = enclosingTypeScriptJavaScriptClassName(expression);
    return className ? localCallables.get(`${className}.${expression.name.text}`) : undefined;
  }
  return undefined;
}

function isThisFieldInstanceCallExpression(expression: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(expression) && thisPropertyName(expression.expression) !== undefined;
}

function isDirectNewInstanceCallExpression(expression: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(expression)
    && classNameFromNewExpression(expression.expression) !== undefined;
}

function isStaticClassCallExpression(
  expression: ts.Expression,
  staticClassCallables: ReadonlySet<string>
): boolean {
  return ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && staticClassCallables.has(`${expression.expression.text}.${expression.name.text}`);
}

function thisPropertyName(expression: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  if (expression.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  return ts.isIdentifier(expression.name) ? expression.name.text : undefined;
}

function scopedLocalName(scopeName: string, localName: string): string {
  return `${scopeName}:${localName}`;
}

function enclosingLocalCaller(
  node: ts.Node,
  localCallables: ReadonlyMap<string, TsLocalCallable>
): TsLocalCallable | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      const callable = localCallables.get(current.name.text);
      if (callable) return callable;
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      const callable = localCallables.get(current.name.text);
      if (callable) return callable;
    }
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) {
      const className = enclosingTypeScriptJavaScriptClassName(current);
      const callable = className ? localCallables.get(`${className}.${current.name.text}`) : undefined;
      if (callable) return callable;
    }
    if (isCallableClassProperty(current) && ts.isIdentifier(current.name)) {
      const className = enclosingTypeScriptJavaScriptClassName(current);
      const callable = className ? localCallables.get(`${className}.${current.name.text}`) : undefined;
      if (callable) return callable;
    }
    current = current.parent;
  }
  return undefined;
}

function enclosingConstructorDeclaration(node: ts.Node): ts.ConstructorDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isConstructorDeclaration(current)) return current;
    if (
      ts.isFunctionDeclaration(current)
      || ts.isFunctionExpression(current)
      || ts.isArrowFunction(current)
      || ts.isMethodDeclaration(current)
      || isCallableClassProperty(current)
    ) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function enclosingTypeScriptJavaScriptClassName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) && current.name) return current.name.text;
    current = current.parent;
  }
  return undefined;
}

function enclosingTypeScriptJavaScriptInterfaceName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isInterfaceDeclaration(current)) return current.name.text;
    current = current.parent;
  }
  return undefined;
}

function enclosingTypeScriptJavaScriptTypeMemberOwnerName(node: ts.Node): string | undefined {
  return enclosingTypeScriptJavaScriptInterfaceName(node)
    ?? enclosingTypeScriptJavaScriptTypeLiteralAliasName(node);
}

function enclosingTypeScriptJavaScriptTypeLiteralAliasName(node: ts.Node): string | undefined {
  const parent = node.parent;
  if (!parent || !ts.isTypeLiteralNode(parent)) return undefined;
  const typeAlias = parent.parent;
  return ts.isTypeAliasDeclaration(typeAlias) ? typeAlias.name.text : undefined;
}

function classHasExportModifier(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current)) return hasExportModifier(current);
    current = current.parent;
  }
  return false;
}

function typeMemberOwnerHasExportModifier(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent && ts.isInterfaceDeclaration(parent)) return hasExportModifier(parent);
  if (parent && ts.isTypeLiteralNode(parent) && ts.isTypeAliasDeclaration(parent.parent)) {
    return hasExportModifier(parent.parent);
  }
  return false;
}

function dedupeCalls(calls: readonly ExtractedCall[]): ExtractedCall[] {
  return [...new Map(calls.map((call) => [
    `${entityDescriptorKey(call.source)}:${entityDescriptorKey(call.target)}:${call.callee}:${call.startLine}:${call.startCol}`,
    call
  ])).values()]
    .sort((a, b) =>
      entityDescriptorKey(a.target).localeCompare(entityDescriptorKey(b.target)) ||
      a.startLine - b.startLine ||
      a.startCol - b.startCol
    );
}

function entityDescriptorKey(entity: EntityDescriptor | undefined): string {
  if (!entity) return 'file';
  return [
    entity.kind,
    entity.languageId ?? '',
    entity.path ?? '',
    entity.symbolKind ?? '',
    entity.symbol ?? '',
    entity.displayName ?? ''
  ].join(':');
}

function moduleSpecifierText(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function scriptKindFor(relativePath: string): ts.ScriptKind {
  if (relativePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (relativePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (relativePath.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function importEvidence(content: string, specifier: string, startIndex: number, endIndex: number): ExtractedImport {
  const start = offsetPosition(content, startIndex);
  const end = offsetPosition(content, endIndex);
  return {
    specifier,
    snippet: content.slice(startIndex, endIndex).trim(),
    startLine: start.line,
    endLine: end.line,
    startCol: start.col,
    endCol: end.col
  };
}

function offsetPosition(content: string, index: number): { line: number; col: number } {
  const prefix = content.slice(0, Math.max(0, index));
  const lines = prefix.split(/\r?\n/);
  return {
    line: lines.length,
    col: (lines.at(-1)?.length ?? 0) + 1
  };
}

function dedupeImports(imports: readonly ExtractedImport[]): ExtractedImport[] {
  return [...new Map(imports.map((item) => [`${item.specifier}:${item.startLine}:${item.startCol}`, item])).values()]
    .sort(compareImports);
}

function compareImports(a: ExtractedImport, b: ExtractedImport): number {
  const bySpecifier = a.specifier.localeCompare(b.specifier);
  if (bySpecifier !== 0) return bySpecifier;
  if (a.startLine !== b.startLine) return a.startLine - b.startLine;
  return a.startCol - b.startCol;
}

function resolveImportPath(
  sourcePath: string,
  specifier: string,
  filePathSet: ReadonlySet<string>,
  importResolver?: ImportResolver
): string | undefined {
  const dirname = path.posix.dirname(sourcePath);
  const bases = specifier.startsWith('.')
    ? [path.posix.normalize(path.posix.join(dirname, specifier))]
    : [
        path.posix.normalize(path.posix.join(dirname, specifier)),
        specifier,
        specifier.replace(/\./g, '/'),
        `src/${specifier.replace(/\./g, '/')}`,
        `src/main/java/${specifier.replace(/\./g, '/')}`,
        `src/main/kotlin/${specifier.replace(/\./g, '/')}`,
        ...(importResolver?.(sourcePath, specifier) ?? [])
      ];
  const candidates = bases.flatMap((base) => [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.py`,
    `${base}.go`,
    `${base}.rs`,
    `${base}.java`,
    `${base}.kt`,
    `${base}.cs`,
    `${base}.c`,
    `${base}.h`,
    `${base}.cpp`,
    `${base}.hpp`,
    `${base}.sh`,
    `${base}.yaml`,
    `${base}.yml`,
    `${base}.json`,
    `${base}.toml`,
    `${base}.proto`,
    `${base}.graphql`,
    path.posix.join(base, '__init__.py'),
    path.posix.join(base, 'mod.rs'),
    path.posix.join(base, 'index.ts'),
    path.posix.join(base, 'index.tsx'),
    path.posix.join(base, 'index.js')
  ]);
  return candidates.find((candidate) => filePathSet.has(candidate));
}

function createImportResolver(files: readonly Readonly<ScannedFile>[]): ImportResolverWithDiagnostics {
  const aliases: TsconfigAlias[] = [];
  const diagnostics = new Map<string, string[]>();
  for (const file of files) {
    if (path.posix.basename(file.relativePath) !== 'tsconfig.json') continue;
    const parsed = parseTsconfigPathAliases(file);
    aliases.push(...parsed.aliases);
    if (parsed.error) {
      diagnostics.set(file.relativePath, [
        `tsconfig path alias parse failed: ${parsed.error}`
      ]);
    }
  }
  return {
    resolve(sourcePath: string, specifier: string): readonly string[] {
      const resolved = aliases
        .filter((alias) => isAliasInScope(alias, sourcePath))
        .flatMap((alias) => expandTsconfigAlias(alias, specifier));
      if (resolved.length > 0) return resolved;
      const bareAlias = specifier.match(/^@[^/]+\/(.+)$/)?.[1] ?? specifier.match(/^~\/(.+)$/)?.[1];
      if (!bareAlias) return [];
      const packageRoot = packageRootForSource(sourcePath);
      return [
        joinPosix(packageRoot, 'src', bareAlias),
        joinPosix(packageRoot, 'src/ts', bareAlias),
        `src/${bareAlias}`,
        `src/ts/${bareAlias}`
      ];
    },
    diagnosticsForFile(relativePath: string): readonly string[] {
      return diagnostics.get(relativePath) ?? [];
    }
  };
}

type TsconfigAlias = {
  configDir: string;
  baseUrl: string;
  pattern: string;
  targets: readonly string[];
};

function parseTsconfigPathAliases(
  file: Readonly<ScannedFile>
): { aliases: TsconfigAlias[]; error?: string } {
  try {
    const parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(file.content)) as {
      compilerOptions?: { baseUrl?: unknown; paths?: Record<string, string[]> };
    };
    const paths = parsed.compilerOptions?.paths;
    if (!paths || typeof paths !== 'object') return { aliases: [] };
    const configDir = path.posix.dirname(file.relativePath);
    const baseUrl =
      typeof parsed.compilerOptions?.baseUrl === 'string'
        ? parsed.compilerOptions.baseUrl
        : '.';
    return {
      aliases: Object.entries(paths)
        .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
        .map(([pattern, targets]) => ({
          configDir,
          baseUrl,
          pattern,
          targets: targets.filter((target) => typeof target === 'string')
        }))
    };
  } catch (error) {
    return {
      aliases: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function expandTsconfigAlias(alias: TsconfigAlias, specifier: string): string[] {
  const starIndex = alias.pattern.indexOf('*');
  if (starIndex === -1) {
    return alias.pattern === specifier
      ? alias.targets.map((target) => normalizeTsconfigTarget(alias.configDir, alias.baseUrl, target))
      : [];
  }
  const prefix = alias.pattern.slice(0, starIndex);
  const suffix = alias.pattern.slice(starIndex + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return [];
  const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
  return alias.targets.map((target) =>
    normalizeTsconfigTarget(alias.configDir, alias.baseUrl, target.replace('*', captured))
  );
}

function normalizeTsconfigTarget(configDir: string, baseUrl: string, target: string): string {
  const relativeTarget = target.replace(/^\.?\//, '');
  const relativeBaseUrl = baseUrl.replace(/^\.?\//, '');
  return joinPosix(configDir, relativeBaseUrl, relativeTarget);
}

function isAliasInScope(alias: TsconfigAlias, sourcePath: string): boolean {
  return alias.configDir === '.' || sourcePath === alias.configDir || sourcePath.startsWith(`${alias.configDir}/`);
}

function packageRootForSource(sourcePath: string): string {
  const segments = sourcePath.split('/');
  const srcIndex = segments.indexOf('src');
  return srcIndex > 0 ? segments.slice(0, srcIndex).join('/') : '';
}

function joinPosix(...parts: readonly string[]): string {
  return path.posix.normalize(parts.filter(Boolean).join('/'));
}

function stripJsonCommentsAndTrailingCommas(content: string): string {
  let output = '';
  let mode: 'normal' | 'string' | 'line-comment' | 'block-comment' = 'normal';
  for (let index = 0; index < content.length; index++) {
    const char = content[index]!;
    const next = content[index + 1];

    if (mode === 'line-comment') {
      if (char === '\n' || char === '\r') {
        mode = 'normal';
        output += char;
      }
      continue;
    }
    if (mode === 'block-comment') {
      if (char === '*' && next === '/') {
        mode = 'normal';
        index++;
      } else if (char === '\n' || char === '\r') {
        output += char;
      }
      continue;
    }
    if (mode === 'string') {
      output += char;
      if (char === '\\') {
        index++;
        output += content[index] ?? '';
      } else if (char === '"') {
        mode = 'normal';
      }
      continue;
    }

    if (char === '"') {
      mode = 'string';
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      mode = 'line-comment';
      index++;
      continue;
    }
    if (char === '/' && next === '*') {
      mode = 'block-comment';
      index++;
      continue;
    }
    output += char;
  }
  return output.replace(/,\s*([}\]])/g, '$1');
}

export function isTestFile(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath);
  return (
    /(^|\/)(tests?|__tests__)\/|(^|\/)src\/test\//.test(relativePath) ||
    /(\.|-)(test|spec)\.[cm]?[tj]sx?$/.test(basename) ||
    /(?:Test|Tests|Spec)\.(?:java|kt)$/.test(basename) ||
    /(?:^test_.*|.*_test)\.py$/.test(basename) ||
    /_test\.go$/.test(basename) ||
    /(?:_test|_spec)\.rs$/.test(basename)
  );
}

function isTestSource(file: ScannedFile): boolean {
  return isTestFile(file.relativePath) || (file.language === 'rust' && /#\s*\[\s*test\s*\]/.test(file.content));
}

function inferTestTargets(
  relativePath: string,
  content: string,
  language: string,
  filePathSet: ReadonlySet<string>,
  importResolver?: ImportResolver
): InferredTestTarget[] {
  const imported = extractImports({
    absolutePath: '',
    relativePath,
    content,
    hash: '',
    language
  }).flatMap((importedItem) => {
    const resolved = resolveImportPath(relativePath, importedItem.specifier, filePathSet, importResolver);
    const paths = resolved ? [resolved] : inferUnresolvedImportTargets(importedItem.specifier, language, filePathSet);
    return paths.map((targetPath) => ({ path: targetPath, evidence: importedItem }));
  });
  const filenameTargets = inferFilenameTestTargets(relativePath, language, filePathSet)
    .map((targetPath) => {
      const evidence = testDeclarationEvidence(content, language);
      return {
        path: targetPath,
        ...(evidence ? { evidence } : {})
      };
    });
  return dedupeTestTargets([...imported, ...filenameTargets])
    .filter((target) => target.path !== relativePath)
    .sort((a, b) => a.path.localeCompare(b.path));
}

function testDeclarationEvidence(content: string, language: string): EvidenceSpan | undefined {
  if (language === 'java' || language === 'kotlin') {
    return firstJvmTestDeclarationEvidence(content);
  }
  if (language === 'python') {
    return firstPythonTestDeclarationEvidence(content);
  }
  if (language === 'go') {
    return firstGoTestDeclarationEvidence(content);
  }
  if (language === 'rust') {
    return firstRustTestDeclarationEvidence(content);
  }
  return undefined;
}

function firstJvmTestDeclarationEvidence(content: string): EvidenceSpan | undefined {
  const classPattern =
    /^\s*(?:(?:@[A-Za-z_][\w.]*\s*(?:\([^)]*\))?)\s*)*(?:(?:public|private|protected|internal|abstract|final|open|data|sealed|static)\s+)*(?:class|interface|enum|record|object)\s+[A-Za-z_]\w*\b[^{\n]*/gm;
  const methodPattern =
    /^\s*(?:(?:@[A-Za-z_][\w.]*\s*(?:\([^)]*\))?)\s*)*(?:(?:public|private|protected|internal|static|final|open|override|suspend)\s+)*(?:fun\s+[A-Za-z_]\w*\s*\(|(?:[A-Za-z_][\w$<>,.?[\]\s]*\s+)?[A-Za-z_]\w*\s*\()/gm;
  const classMatch = classPattern.exec(content);
  const match = classMatch ?? methodPattern.exec(content);
  if (!match) return undefined;
  const startIndex = firstNonWhitespaceIndex(content, match.index);
  return evidenceSpanFromRange(
    content,
    startIndex,
    lineEndIndex(content, match.index + match[0]!.length)
  );
}

function firstPythonTestDeclarationEvidence(content: string): EvidenceSpan | undefined {
  const match = firstPatternMatch(content, [
    /^\s*(?:async\s+)?def\s+test_[A-Za-z_]\w*\s*\(/gm,
    /^\s*class\s+Test[A-Za-z_]\w*\b[^\n]*/gm
  ]);
  return match ? declarationLineEvidence(content, match.index, match[0]!.length, 'python') : undefined;
}

function firstGoTestDeclarationEvidence(content: string): EvidenceSpan | undefined {
  const patterns = [
    /^\s*func\s+Test[A-Za-z0-9_]*\s*\(/gm,
    /^\s*func\s+Benchmark[A-Za-z0-9_]*\s*\(/gm,
    /^\s*func\s+Fuzz[A-Za-z0-9_]*\s*\(/gm
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (match) return declarationLineEvidence(content, match.index, match[0]!.length, 'go');
  }
  return undefined;
}

function firstRustTestDeclarationEvidence(content: string): EvidenceSpan | undefined {
  const attributePattern =
    /^\s*#\s*\[\s*test\s*\]\s*(?:\r?\n\s*#\s*\[[^\n]*\]\s*)*\r?\n\s*(?:(?:pub(?:\([^)]*\))?|async)\s+)*fn\s+[A-Za-z_]\w*\s*\(/gm;
  const attributeMatch = attributePattern.exec(content);
  if (attributeMatch) {
    return evidenceSpanFromRange(
      content,
      firstNonWhitespaceIndex(content, attributeMatch.index),
      lineEndIndex(content, attributeMatch.index + attributeMatch[0]!.length)
    );
  }

  const functionPattern =
    /^\s*(?:(?:pub(?:\([^)]*\))?|async)\s+)*fn\s+(?:test_[A-Za-z_]\w*|[A-Za-z_]\w*_test)\s*\(/gm;
  const functionMatch = functionPattern.exec(content);
  return functionMatch
    ? declarationLineEvidence(content, functionMatch.index, functionMatch[0]!.length, 'rust')
    : undefined;
}

function firstPatternMatch(content: string, patterns: readonly RegExp[]): RegExpExecArray | undefined {
  const matches = patterns
    .map((pattern) => pattern.exec(content))
    .filter((match): match is RegExpExecArray => match !== null);
  return matches.sort((left, right) => left.index - right.index)[0];
}

function dedupeTestTargets(targets: readonly InferredTestTarget[]): InferredTestTarget[] {
  const byPath = new Map<string, InferredTestTarget>();
  for (const target of targets) {
    const existing = byPath.get(target.path);
    if (!existing || (!existing.evidence && target.evidence)) {
      byPath.set(target.path, target);
    }
  }
  return [...byPath.values()];
}

function isJvmLanguage(languageId: string): boolean {
  return languageId === 'java' || languageId === 'kotlin';
}

function inferUnresolvedImportTargets(
  specifier: string,
  language: string,
  filePathSet: ReadonlySet<string>
): string[] {
  if (language === 'java' || language === 'kotlin') {
    return inferJvmImportTargets(specifier, filePathSet);
  }
  const typeName = specifier.split('.').at(-1);
  if (!typeName || !/^[A-Z][A-Za-z0-9_]*$/.test(typeName)) return [];
  return findFilesByStem(typeName, ['.java', '.kt', '.cs'], filePathSet);
}

function inferJvmImportTargets(
  specifier: string,
  filePathSet: ReadonlySet<string>
): string[] {
  if (specifier.endsWith('.*')) return [];
  const packagePath = specifier.replace(/\./g, '/');
  const expected = new Set(['.java', '.kt'].map((extension) => `${packagePath}${extension}`));
  return [...filePathSet]
    .filter((file) => [...expected].some((candidate) => file.endsWith(`/${candidate}`) || file === candidate))
    .sort();
}

function inferFilenameTestTargets(
  relativePath: string,
  language: string,
  filePathSet: ReadonlySet<string>
): string[] {
  const basename = path.posix.basename(relativePath);
  if (language === 'java' || language === 'kotlin') {
    const stem = basename.replace(/\.(?:java|kt)$/, '').replace(/(?:Tests?|Spec)$/, '');
    if (stem === basename) return [];
    return candidateTargetsForStem(relativePath, stem, ['.java', '.kt'], filePathSet);
  }
  if (language === 'python') {
    const match = basename.match(/^(?:test_(.+)|(.+)_test)\.py$/);
    const stem = match?.[1] ?? match?.[2];
    return stem ? candidateTargetsForStem(relativePath, stem, ['.py'], filePathSet) : [];
  }
  if (language === 'go') {
    const stem = basename.match(/^(.+)_test\.go$/)?.[1];
    return stem ? candidateTargetsForStem(relativePath, stem, ['.go'], filePathSet) : [];
  }
  if (language === 'rust') {
    const stem = basename.match(/^(.+)_(?:test|spec)\.rs$/)?.[1];
    return stem ? candidateTargetsForStem(relativePath, stem, ['.rs'], filePathSet) : [];
  }
  return [];
}

function candidateTargetsForStem(
  relativePath: string,
  stem: string,
  extensions: readonly string[],
  filePathSet: ReadonlySet<string>
): string[] {
  const dirname = path.posix.dirname(relativePath);
  for (const candidateDir of sourceCandidateDirectories(dirname)) {
    const matches = extensions
      .map((extension) => path.posix.join(candidateDir, `${stem}${extension}`))
      .filter((candidate) => filePathSet.has(candidate));
    if (matches.length > 0) return matches.sort();
  }
  return [];
}

function sourceCandidateDirectories(dirname: string): string[] {
  const candidates = [dirname];
  const segments = dirname.split('/');
  if (segments[0] === 'src' && segments[1] === 'test') {
    const languageRoot = segments[2];
    if (languageRoot === 'java' || languageRoot === 'kotlin') {
      candidates.push(['src', 'main', languageRoot, ...segments.slice(3)].join('/'));
      candidates.push(['src', 'main', languageRoot === 'java' ? 'kotlin' : 'java', ...segments.slice(3)].join('/'));
    } else {
      candidates.push(['src', 'main', ...segments.slice(2)].join('/'));
    }
  }
  for (const testSegment of ['test', 'tests']) {
    const index = segments.indexOf(testSegment);
    if (index === 0) {
      candidates.push(['src', ...segments.slice(1)].join('/'));
    }
    if (index > 0 && segments[index - 1] !== 'src') {
      candidates.push([...segments.slice(0, index), 'src', ...segments.slice(index + 1)].join('/'));
    }
  }
  return [...new Set(candidates)];
}

function findFilesByStem(
  stem: string,
  extensions: readonly string[],
  filePathSet: ReadonlySet<string>
): string[] {
  const expected = new Set(extensions.map((extension) => `${stem}${extension}`));
  return [...filePathSet]
    .filter((file) => expected.has(path.posix.basename(file)))
    .sort();
}

function inferDocTargets(content: string, filePathSet: ReadonlySet<string>): string[] {
  return inferTextTargets('', content, filePathSet);
}

function relationKindForMarkdownReference(relativePath: string): RelationKind {
  const kind = markdownEntityKindForPath(relativePath);
  if (kind === 'policy' || kind === 'decision') return 'GOVERNS';
  if (kind === 'proposal') return 'PROPOSES';
  if (kind === 'prd' || kind === 'requirement') return 'REQUIRES';
  return 'DOCUMENTS';
}

function inferTextTargets(
  relativePath: string,
  content: string,
  filePathSet: ReadonlySet<string>
): string[] {
  return inferTextTargetsWithEvidence(relativePath, content, filePathSet).map((target) => target.path);
}

function inferTextTargetsWithEvidence(
  relativePath: string,
  content: string,
  filePathSet: ReadonlySet<string>
): Array<{ path: string; evidence: EvidenceSpan }> {
  const targets: string[] = [];
  const normalizedContent = content.toLowerCase();
  for (const file of filePathSet) {
    if (file === relativePath) continue;
    const stem = path.posix.basename(file).replace(/\.[^.]+$/, '').toLowerCase();
    if (
      normalizedContent.includes(file.toLowerCase()) ||
      (stem.length >= 4 && contentContainsToken(normalizedContent, stem))
    ) {
      targets.push(file);
    }
  }
  return targets.sort().map((targetPath) => ({
    path: targetPath,
    evidence: textTargetEvidence(content, targetPath)
  }));
}

function inferExplicitTextTargetsWithEvidence(
  relativePath: string,
  content: string,
  filePathSet: ReadonlySet<string>
): Array<{ path: string; evidence: EvidenceSpan }> {
  const targets: string[] = [];
  const normalizedContent = content.toLowerCase();
  for (const file of filePathSet) {
    if (file === relativePath) continue;
    if (normalizedContent.includes(file.toLowerCase())) {
      targets.push(file);
    }
  }
  return targets.sort().map((targetPath) => ({
    path: targetPath,
    evidence: textTargetEvidence(content, targetPath)
  }));
}

function textTargetEvidence(content: string, targetPath: string): EvidenceSpan {
  const normalizedContent = content.toLowerCase();
  const pathIndex = normalizedContent.indexOf(targetPath.toLowerCase());
  if (pathIndex >= 0) {
    return evidenceLineAt(content, pathIndex);
  }
  const stem = path.posix.basename(targetPath).replace(/\.[^.]+$/, '').toLowerCase();
  const tokenIndex = findTokenIndex(normalizedContent, stem);
  return evidenceLineAt(content, tokenIndex >= 0 ? tokenIndex : 0);
}

function evidenceLineAt(content: string, index: number): EvidenceSpan {
  const start = content.lastIndexOf('\n', Math.max(0, index)) + 1;
  return evidenceSpanFromRange(content, firstNonWhitespaceIndex(content, start), lineEndIndex(content, index));
}

function contentContainsToken(normalizedContent: string, token: string): boolean {
  return findTokenIndex(normalizedContent, token) >= 0;
}

function findTokenIndex(normalizedContent: string, token: string): number {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|[^a-z0-9_-])(${escaped})($|[^a-z0-9_-])`).exec(normalizedContent);
  return match?.index === undefined ? -1 : match.index + (match[1]?.length ?? 0);
}

export function isSystemOrContractLanguage(languageId: string): boolean {
  return [
    'shell',
    'yaml',
    'json',
    'toml',
    'dockerfile',
    'makefile',
    'terraform',
    'protobuf',
    'graphql',
    'properties',
    'policy'
  ].includes(languageId);
}

function isContractLikeFile(relativePath: string, languageId: string): boolean {
  if (languageId === 'protobuf' || languageId === 'graphql') return true;
  if (languageId !== 'yaml' && languageId !== 'json') return false;
  const basename = path.posix.basename(relativePath);
  const withoutExtension = basename.replace(/\.[^.]+$/, '').toLowerCase();
  return (
    withoutExtension.includes('openapi') ||
    withoutExtension.includes('swagger') ||
    withoutExtension.includes('asyncapi')
  );
}

function relationKindForSystemReference(languageId: string): string {
  if (languageId === 'policy') return 'GOVERNS';
  if (
    languageId === 'dockerfile' ||
    languageId === 'terraform' ||
    languageId === 'yaml' ||
    languageId === 'json' ||
    languageId === 'toml' ||
    languageId === 'properties'
  ) {
    return 'CONFIGURES';
  }
  if (languageId === 'protobuf' || languageId === 'graphql') return 'IMPLEMENTS';
  if (languageId === 'shell' || languageId === 'makefile') return 'CALLS';
  return 'REFERENCES';
}

function dedupeSymbols(symbols: ExtractedSymbol[]): ExtractedSymbol[] {
  return [...new Map(symbols.map((symbol) => [`${symbol.kind}:${symbol.name}`, symbol])).values()].sort(
    (a, b) => {
      const byName = a.name.localeCompare(b.name);
      return byName === 0 ? a.kind.localeCompare(b.kind) : byName;
    }
  );
}
