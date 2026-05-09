import path from 'node:path';

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
export const MULTI_LANG_REGEX_ADAPTER_VERSION = '2';

const capabilities: readonly AdapterCapability[] = ['imports', 'symbols', 'docrefs', 'tests'];

type ExtractedSymbol = {
  name: string;
  kind: string;
  exported: boolean;
};

export class MultiLanguageRegexAdapter implements SemanticAdapter {
  readonly id = MULTI_LANG_REGEX_ADAPTER_ID;
  readonly version = MULTI_LANG_REGEX_ADAPTER_VERSION;
  readonly capabilities = capabilities;

  supports(_file: ScannedFile): boolean {
    return true;
  }

  start(ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun {
    const filePathSet = new Set(ctx.indexedFiles.map((f) => f.relativePath));
    return {
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        yield* extractEvents(file, filePathSet);
      }
    };
  }
}

async function* extractEvents(
  file: ScannedFile,
  filePathSet: ReadonlySet<string>
): AsyncIterable<IndexEvent> {
  const fileDescriptor: EntityDescriptor = {
    kind: 'file',
    path: file.relativePath,
    languageId: file.language,
    displayName: file.relativePath
  };
  const evidenceSnippet = file.content;
  const evidenceFile = file.relativePath;

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

  for (const imported of extractImports(file)) {
    const resolved = resolveImportPath(file.relativePath, imported, filePathSet);
    if (resolved) {
      yield {
        kind: 'relation',
        relation: makeRelation({
          source: fileDescriptor,
          target: { kind: 'file', path: resolved, languageId: file.language },
          kind: 'DEPENDS_ON',
          confidence: 'proven',
          provenance: imported,
          evidenceFile,
          evidenceSnippet
        })
      };
    } else {
      const externalDescriptor: EntityDescriptor = {
        kind: 'external_entity',
        languageId: file.language,
        displayName: imported
      };
      yield {
        kind: 'entity',
        entity: { ...externalDescriptor, metadata: { specifier: imported } }
      };
      yield {
        kind: 'relation',
        relation: makeRelation({
          source: fileDescriptor,
          target: externalDescriptor,
          kind: 'DEPENDS_ON',
          confidence: 'heuristic',
          provenance: imported,
          evidenceFile,
          evidenceSnippet
        })
      };
    }
  }

  if (isTestFile(file.relativePath)) {
    for (const sourcePath of inferTestTargets(file.relativePath, file.content, filePathSet)) {
      yield {
        kind: 'relation',
        relation: makeRelation({
          source: fileDescriptor,
          target: { kind: 'file', path: sourcePath },
          kind: 'VERIFIES',
          confidence: 'inferred',
          provenance: 'test import/name',
          evidenceFile,
          evidenceSnippet
        })
      };
    }
  }

  if (file.relativePath.toLowerCase().endsWith('.md')) {
    for (const sourcePath of inferDocTargets(file.content, filePathSet)) {
      yield {
        kind: 'relation',
        relation: makeRelation({
          source: fileDescriptor,
          target: { kind: 'file', path: sourcePath },
          kind: 'DOCUMENTS',
          confidence: 'heuristic',
          provenance: 'doc mention',
          evidenceFile,
          evidenceSnippet
        })
      };
    }
  }

  if (isSystemOrContractLanguage(file.language)) {
    const relationKind = relationKindForSystemReference(file.language) as RelationKind;
    for (const sourcePath of inferTextTargets(file.relativePath, file.content, filePathSet)) {
      yield {
        kind: 'relation',
        relation: makeRelation({
          source: fileDescriptor,
          target: { kind: 'file', path: sourcePath },
          kind: relationKind,
          confidence: 'heuristic',
          provenance: 'system/config mention',
          evidenceFile,
          evidenceSnippet
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
}): PendingRelation {
  const evidence: PendingEvidence = {
    file: input.evidenceFile,
    snippet: input.evidenceSnippet,
    confidence: input.confidence
  };
  return {
    source: input.source,
    target: input.target,
    kind: input.kind,
    metadata: { provenance: input.provenance, confidence: input.confidence },
    evidence: [evidence]
  };
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

function extractImports(file: ScannedFile): string[] {
  if (file.relativePath.endsWith('.md')) return [];
  const imports = new Set<string>();
  const patterns: RegExp[] = [];
  if (file.language === 'typescript' || file.language === 'javascript') {
    patterns.push(
      /import\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
      /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    );
  } else if (file.language === 'python') {
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
      imports.add(match[1]!);
    }
  }
  return [...imports].sort();
}

function resolveImportPath(
  sourcePath: string,
  specifier: string,
  filePathSet: ReadonlySet<string>
): string | undefined {
  const dirname = path.posix.dirname(sourcePath);
  const bases = specifier.startsWith('.')
    ? [path.posix.normalize(path.posix.join(dirname, specifier))]
    : [path.posix.normalize(path.posix.join(dirname, specifier)), specifier];
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

export function isTestFile(relativePath: string): boolean {
  return /(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\.[cm]?[tj]sx?$/.test(relativePath);
}

function inferTestTargets(
  relativePath: string,
  content: string,
  filePathSet: ReadonlySet<string>
): string[] {
  const imported = extractImports({
    absolutePath: '',
    relativePath,
    content,
    hash: '',
    language: 'ts'
  }).flatMap((specifier) => {
    const resolved = resolveImportPath(relativePath, specifier, filePathSet);
    return resolved ? [resolved] : [];
  });
  return [...new Set(imported)].sort();
}

function inferDocTargets(content: string, filePathSet: ReadonlySet<string>): string[] {
  return inferTextTargets('', content, filePathSet);
}

function inferTextTargets(
  relativePath: string,
  content: string,
  filePathSet: ReadonlySet<string>
): string[] {
  const targets: string[] = [];
  const normalizedContent = content.toLowerCase();
  for (const file of filePathSet) {
    if (file === relativePath) continue;
    const stem = path.posix.basename(file).replace(/\.[^.]+$/, '').toLowerCase();
    if (
      normalizedContent.includes(file.toLowerCase()) ||
      (stem.length >= 4 && normalizedContent.includes(stem))
    ) {
      targets.push(file);
    }
  }
  return targets.sort();
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
    languageId === 'toml'
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
