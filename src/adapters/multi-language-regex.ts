import path from 'node:path';
import ts from 'typescript';

import { markdownEntityKindForPath } from '../artifacts.js';
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

const capabilities: readonly AdapterCapability[] = ['imports', 'symbols', 'docrefs', 'tests'];

type ExtractedSymbol = {
  name: string;
  kind: string;
  exported: boolean;
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
  constructor() {
    super(TS_JS_SEMANTIC_ADAPTER_ID, new Set(['typescript', 'javascript']));
  }
}

export class JvmSpringSemanticAdapter extends RegexBackedSemanticAdapter {
  constructor() {
    super(JVM_SPRING_SEMANTIC_ADAPTER_ID, new Set(['java', 'kotlin']));
  }
}

export class PythonSemanticAdapter extends RegexBackedSemanticAdapter {
  constructor() {
    super(PYTHON_SEMANTIC_ADAPTER_ID, new Set(['python']));
  }
}

export class GoSemanticAdapter extends RegexBackedSemanticAdapter {
  constructor() {
    super(GO_SEMANTIC_ADAPTER_ID, new Set(['go']));
  }
}

export class RustSemanticAdapter extends RegexBackedSemanticAdapter {
  constructor() {
    super(RUST_SEMANTIC_ADAPTER_ID, new Set(['rust']));
  }
}

export class MultiLanguageRegexAdapter implements SemanticAdapter {
  readonly id = MULTI_LANG_REGEX_ADAPTER_ID;
  readonly version = MULTI_LANG_REGEX_ADAPTER_VERSION;
  readonly capabilities = capabilities;

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
  const fileDescriptor: EntityDescriptor = {
    kind: 'file',
    path: file.relativePath,
    languageId: file.language,
    displayName: file.relativePath
  };
  const evidenceSnippet = file.content;
  const evidenceFile = file.relativePath;

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
        evidenceSnippet
      })
    };
  }

  if (isJvmLanguage(file.language)) {
    yield* extractSpringEvents(file, fileDescriptor);
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
    const relationKind = relationKindForSystemReference(file.language) as RelationKind;
    for (const target of inferTextTargetsWithEvidence(file.relativePath, file.content, filePathSet)) {
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
    }
  }
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
        exported: exportedIndex === undefined ? false : Boolean(match[exportedIndex])
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
        exported: exportedIndex === undefined ? false : Boolean(match[exportedIndex])
      });
    }
  };

  if (file.language === 'typescript' || file.language === 'javascript') {
    addMatches(/(export\s+)?(?:async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g, 2, 3, 1);
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
    addFixedKindMatches(/\b(?:public|private|protected|internal|static|final|override|async|\s)+[A-Za-z_<>,.[\]?]+\s+([A-Za-z_]\w*)\s*\(/g, 'method', 1);
  } else if (file.language === 'c' || file.language === 'cpp') {
    addMatches(/\b(class|struct|enum)\s+([A-Za-z_]\w*)\b/g, 1, 2);
    addFixedKindMatches(/^\s*(?:[A-Za-z_][\w:*<>,\s]*\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/gm, 'function', 1);
  }

  return dedupeSymbols(symbols);
}

function extractImports(file: ScannedFile): ExtractedImport[] {
  if (file.relativePath.endsWith('.md')) return [];
  if (file.language === 'typescript' || file.language === 'javascript') {
    return extractTypeScriptJavaScriptImports(file);
  }
  const imports: ExtractedImport[] = [];
  const patterns: RegExp[] = [];
  if (file.language === 'python') {
    patterns.push(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/gm, /^\s*import\s+([A-Za-z_][\w.]*)/gm);
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
      const evidence = isJvmLanguage(language)
        ? testDeclarationEvidence(content, language)
        : undefined;
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
