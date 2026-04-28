import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { contentHash, ensureRepo, openDatabase, type Db } from './store.js';
import { normalizeRepoRoot, redactSecrets, toRelativePath } from './security.js';
import type { EntityKind, IndexOptions, IndexResult } from './types.js';

const ignoredDirs = new Set(['.git', '.impact-trace', 'node_modules', 'dist', 'coverage']);
const languageByExtension = new Map<string, string>([
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.md', 'markdown'],
  ['.py', 'python'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.java', 'java'],
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
  ['.cs', 'csharp'],
  ['.c', 'c'],
  ['.h', 'c'],
  ['.cpp', 'cpp'],
  ['.cc', 'cpp'],
  ['.cxx', 'cpp'],
  ['.hpp', 'cpp'],
  ['.hh', 'cpp'],
  ['.hxx', 'cpp'],
  ['.sh', 'shell'],
  ['.bash', 'shell'],
  ['.zsh', 'shell'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.json', 'json'],
  ['.toml', 'toml'],
  ['.tf', 'terraform'],
  ['.proto', 'protobuf'],
  ['.graphql', 'graphql'],
  ['.gql', 'graphql']
]);
const languageByFileName = new Map<string, string>([
  ['Dockerfile', 'dockerfile'],
  ['Containerfile', 'dockerfile'],
  ['Makefile', 'makefile'],
  ['CODEOWNERS', 'policy']
]);
const adapterId = 'multi-language-regex-mvp';
const adapterVersion = '2';
const defaultMaxFileBytes = 1_000_000;

type ScannedFile = {
  absolutePath: string;
  relativePath: string;
  content: string;
  hash: string;
  language: string;
};

type SkippedFile = {
  relativePath: string;
  language?: string;
  reason: string;
};

type ScanResult = {
  files: ScannedFile[];
  skipped: SkippedFile[];
};

type ExtractedSymbol = {
  name: string;
  kind: string;
  exported: boolean;
};

type Statement = ReturnType<Db['prepare']>;

export async function indexProject(options: IndexOptions): Promise<IndexResult> {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const db = openDatabase(repoRoot);
  const repoId = ensureRepo(db, repoRoot);
  const run = db
    .prepare('INSERT INTO index_runs (repo_id, status, started_at, extractor_version) VALUES (?, ?, datetime(\'now\'), ?)')
    .run(repoId, 'running', `${adapterId}-${adapterVersion}`);
  const indexRunId = Number(run.lastInsertRowid);

  try {
    const scan = scanFiles(repoRoot, options.maxFileBytes ?? defaultMaxFileBytes);
    const files = scan.files;
    const languageIds = [
      ...new Set([
        ...files.map((file) => file.language),
        ...scan.skipped.flatMap((file) => file.language ? [file.language] : [])
      ])
    ].sort();
    const adapterRun = db
      .prepare(`
        INSERT INTO adapter_runs (index_run_id, adapter_id, adapter_version, language_ids, status, started_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `)
      .run(indexRunId, adapterId, adapterVersion, JSON.stringify(languageIds), 'running');
    const adapterRunId = Number(adapterRun.lastInsertRowid);

    // Agent memory dual-write: one transaction per index run on the main branch.
    const mainBranch = db
      .prepare("SELECT id, head_tx_id FROM branches WHERE name = 'main'")
      .get() as { id: string; head_tx_id: string | null } | undefined;
    if (!mainBranch) {
      throw new Error('main branch missing from agent memory schema (schema v4 not applied)');
    }
    const memoryTs = new Date().toISOString();
    const memoryTxId = contentHash(mainBranch.head_tx_id ?? '', mainBranch.id, memoryTs, 'indexer');
    db.prepare(
      'INSERT OR IGNORE INTO transactions (id, parent_tx_id, branch_id, ts, agent, index_run_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(memoryTxId, mainBranch.head_tx_id, mainBranch.id, memoryTs, 'indexer', indexRunId);
    const upsertAttributeDef = db.prepare(
      "INSERT OR IGNORE INTO attribute_defs (name, value_type, is_code_relation, description) VALUES (?, 'entity_ref', 0, '')"
    );
    const insertFact = db.prepare(
      'INSERT OR IGNORE INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    const fileIdByPath = new Map<string, number>();
    const upsertFile = db.prepare(`
      INSERT INTO files (repo_id, path, language, content_hash, index_run_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, path) DO UPDATE SET
        language = excluded.language,
        content_hash = excluded.content_hash,
        index_run_id = excluded.index_run_id
    `);
    const selectFile = db.prepare('SELECT id FROM files WHERE repo_id = ? AND path = ?');
    const upsertEntity = db.prepare(`
      INSERT INTO entities (
        id, repo_id, kind, path, symbol, language_id, display_name, created_index_run_id, updated_index_run_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        path = excluded.path,
        symbol = excluded.symbol,
        language_id = excluded.language_id,
        display_name = excluded.display_name,
        updated_index_run_id = excluded.updated_index_run_id
    `);
    const insertEntityVersion = db.prepare(`
      INSERT OR REPLACE INTO entity_versions (entity_id, index_run_id, content_hash, location_json, state)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertCoverage = db.prepare(`
      INSERT OR REPLACE INTO index_coverage (index_run_id, adapter_id, path, language_id, status, reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertRelation = db.prepare(`
      INSERT OR REPLACE INTO relations (
        id, repo_id, source_entity_id, target_entity_id, kind, confidence, adapter_run_id, index_run_id, provenance
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRelationEvidence = db.prepare(`
      INSERT OR REPLACE INTO relation_evidence (
        id, relation_id, repo_id, file_path, kind, snippet, confidence, index_run_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const canonicalEntityIds = new Set<string>();
    const canonicalRelationIds = new Set<string>();

    for (const skipped of scan.skipped) {
      insertCoverage.run(indexRunId, adapterId, skipped.relativePath, skipped.language ?? null, 'skipped', skipped.reason);
    }

    for (const file of files) {
      upsertFile.run(repoId, file.relativePath, file.language, file.hash, indexRunId);
      const row = selectFile.get(repoId, file.relativePath) as { id: number };
      fileIdByPath.set(file.relativePath, row.id);
      const entity = fileEntity(file.relativePath, file.language);
      upsertEntity.run(
        entity.id,
        repoId,
        entity.kind,
        file.relativePath,
        null,
        file.language,
        file.relativePath,
        indexRunId,
        indexRunId
      );
      insertEntityVersion.run(entity.id, indexRunId, file.hash, JSON.stringify({ path: file.relativePath }), 'active');
      insertCoverage.run(indexRunId, adapterId, file.relativePath, file.language, 'indexed', 'matched source extension');
      canonicalEntityIds.add(entity.id);
    }

    let symbolsIndexed = 0;
    let edgesIndexed = 0;
    const insertSymbol = db.prepare(`
      INSERT OR REPLACE INTO symbols (file_id, name, kind, exported, semantic_id, index_run_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertEdge = db.prepare(`
      INSERT OR REPLACE INTO edges (repo_id, source_file_id, target_file_id, kind, target_path, confidence, provenance, index_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEvidence = db.prepare(`
      INSERT OR REPLACE INTO evidence (id, repo_id, file_path, kind, snippet, confidence, index_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const file of files) {
      const fileId = fileIdByPath.get(file.relativePath);
      if (!fileId) continue;

      for (const symbol of extractSymbols(file)) {
        const symbolId = symbolEntityId(file.relativePath, file.language, symbol);
        insertSymbol.run(
          fileId,
          symbol.name,
          symbol.kind,
          symbol.exported ? 1 : 0,
          `${file.relativePath}#${symbol.kind}:${symbol.name}`,
          indexRunId
        );
        upsertEntity.run(
          symbolId,
          repoId,
          'symbol',
          file.relativePath,
          symbol.name,
          file.language,
          `${symbol.name} (${file.relativePath})`,
          indexRunId,
          indexRunId
        );
        insertEntityVersion.run(
          symbolId,
          indexRunId,
          createHash('sha256').update(`${file.hash}:${symbol.kind}:${symbol.name}`).digest('hex'),
          JSON.stringify({ path: file.relativePath, symbol: symbol.name, kind: symbol.kind }),
          'active'
        );
        insertCanonicalRelation({
          repoId,
          sourceEntityId: fileEntityId(file.relativePath),
          targetEntityId: symbolId,
          kind: 'DECLARES',
          confidence: 'proven',
          provenance: `${symbol.kind}:${symbol.name}`,
          adapterRunId,
          indexRunId,
          sourcePath: file.relativePath,
          snippet: file.content,
          insertRelation,
          insertRelationEvidence,
          canonicalEntityIds,
          canonicalRelationIds,
          upsertAttributeDef,
          insertFact,
          memoryTxId
        });
        canonicalEntityIds.add(symbolId);
        symbolsIndexed++;
      }

      for (const imported of extractImports(file)) {
        const target = resolveImportPath(file.relativePath, imported, fileIdByPath);
        const targetEntityId = target ? fileEntityId(target) : externalEntityId(file.language, imported);
        if (!target) {
          upsertEntity.run(
            targetEntityId,
            repoId,
            'external_entity',
            null,
            null,
            file.language,
            imported,
            indexRunId,
            indexRunId
          );
          insertEntityVersion.run(targetEntityId, indexRunId, imported, JSON.stringify({ specifier: imported }), 'active');
          canonicalEntityIds.add(targetEntityId);
        }
        insertEdge.run(
          repoId,
          fileId,
          target ? fileIdByPath.get(target)! : null,
          'IMPORTS',
          target ?? imported,
          target ? 'proven' : 'heuristic',
          imported,
          indexRunId
        );
        insertCanonicalRelation({
          repoId,
          sourceEntityId: fileEntityId(file.relativePath),
          targetEntityId,
          kind: 'DEPENDS_ON',
          confidence: target ? 'proven' : 'heuristic',
          provenance: imported,
          adapterRunId,
          indexRunId,
          sourcePath: file.relativePath,
          snippet: file.content,
          insertRelation,
          insertRelationEvidence,
          canonicalEntityIds,
          canonicalRelationIds,
          upsertAttributeDef,
          insertFact,
          memoryTxId
        });
        edgesIndexed++;
      }

      if (isTestFile(file.relativePath)) {
        for (const sourcePath of inferTestTargets(file.relativePath, file.content, fileIdByPath)) {
          insertEdge.run(repoId, fileId, fileIdByPath.get(sourcePath)!, 'TESTS', sourcePath, 'inferred', 'test import/name', indexRunId);
          insertCanonicalRelation({
            repoId,
            sourceEntityId: fileEntityId(file.relativePath),
            targetEntityId: fileEntityId(sourcePath),
            kind: 'VERIFIES',
            confidence: 'inferred',
            provenance: 'test import/name',
            adapterRunId,
            indexRunId,
            sourcePath: file.relativePath,
            snippet: file.content,
            insertRelation,
            insertRelationEvidence,
            canonicalEntityIds,
            canonicalRelationIds,
            upsertAttributeDef,
            insertFact,
            memoryTxId
          });
          edgesIndexed++;
        }
      }

      if (file.relativePath.toLowerCase().endsWith('.md')) {
        for (const sourcePath of inferDocTargets(file.content, fileIdByPath)) {
          insertEdge.run(repoId, fileId, fileIdByPath.get(sourcePath)!, 'DOCUMENTS', sourcePath, 'heuristic', 'doc mention', indexRunId);
          insertCanonicalRelation({
            repoId,
            sourceEntityId: fileEntityId(file.relativePath),
            targetEntityId: fileEntityId(sourcePath),
            kind: 'DOCUMENTS',
            confidence: 'heuristic',
            provenance: 'doc mention',
            adapterRunId,
            indexRunId,
            sourcePath: file.relativePath,
            snippet: file.content,
            insertRelation,
            insertRelationEvidence,
            canonicalEntityIds,
            canonicalRelationIds,
            upsertAttributeDef,
            insertFact,
            memoryTxId
          });
          edgesIndexed++;
        }
      }

      if (isSystemOrContractLanguage(file.language)) {
        for (const sourcePath of inferTextTargets(file.relativePath, file.content, fileIdByPath)) {
          const relationKind = relationKindForSystemReference(file.language);
          insertEdge.run(repoId, fileId, fileIdByPath.get(sourcePath)!, relationKind, sourcePath, 'heuristic', 'system/config mention', indexRunId);
          insertCanonicalRelation({
            repoId,
            sourceEntityId: fileEntityId(file.relativePath),
            targetEntityId: fileEntityId(sourcePath),
            kind: relationKind,
            confidence: 'heuristic',
            provenance: 'system/config mention',
            adapterRunId,
            indexRunId,
            sourcePath: file.relativePath,
            snippet: file.content,
            insertRelation,
            insertRelationEvidence,
            canonicalEntityIds,
            canonicalRelationIds,
            upsertAttributeDef,
            insertFact,
            memoryTxId
          });
          edgesIndexed++;
        }
      }

      insertEvidence.run(
        evidenceId(file.relativePath, 'scan'),
        repoId,
        file.relativePath,
        'scan',
        redactSecrets(file.content),
        'proven',
        indexRunId
      );
    }

    db.prepare('UPDATE adapter_runs SET status = ?, finished_at = datetime(\'now\') WHERE id = ?').run('completed', adapterRunId);
    db.prepare('UPDATE index_runs SET status = ?, finished_at = datetime(\'now\') WHERE id = ?').run('completed', indexRunId);
    db.prepare('UPDATE branches SET head_tx_id = ? WHERE id = ?').run(memoryTxId, mainBranch.id);
    db.close();
    return {
      indexRunId,
      filesIndexed: files.length,
      symbolsIndexed,
      edgesIndexed,
      entitiesIndexed: canonicalEntityIds.size,
      relationsIndexed: canonicalRelationIds.size,
      adaptersUsed: [
        {
          id: adapterId,
          version: adapterVersion,
          languageIds
        }
      ],
      coverage: {
        indexedPaths: files.length,
        skippedPaths: scan.skipped.length,
        unsupportedLanguageIds: [],
        skipped: scan.skipped.map((file) => ({
          path: file.relativePath,
          ...(file.language ? { languageId: file.language } : {}),
          status: 'skipped',
          reason: file.reason
        }))
      }
    };
  } catch (error) {
    db.prepare('UPDATE adapter_runs SET status = ?, finished_at = datetime(\'now\'), error_summary = ? WHERE index_run_id = ?')
      .run('failed', error instanceof Error ? error.message : String(error), indexRunId);
    db.prepare('UPDATE index_runs SET status = ?, finished_at = datetime(\'now\') WHERE id = ?').run('failed', indexRunId);
    db.close();
    throw error;
  }
}

function scanFiles(repoRoot: string, maxFileBytes: number): ScanResult {
  const out: ScannedFile[] = [];
  const skipped: SkippedFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const absolutePath = path.join(dir, entry.name);
      const relativePath = toRelativePath(repoRoot, absolutePath);
      const language = languageForPath(relativePath);
      if (!language) continue;
      const size = statSync(absolutePath).size;
      if (size > maxFileBytes) {
        skipped.push({
          relativePath,
          language,
          reason: `file exceeds maxFileBytes (${size} > ${maxFileBytes})`
        });
        continue;
      }
      const content = readFileSync(absolutePath, 'utf8');
      out.push({
        absolutePath,
        relativePath,
        content,
        hash: createHash('sha256').update(content).digest('hex'),
        language
      });
    }
  };
  walk(repoRoot);
  return {
    files: out.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    skipped: skipped.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  };
}

function extractSymbols(file: ScannedFile): ExtractedSymbol[] {
  if (file.relativePath.endsWith('.md') || isSystemOrContractLanguage(file.language)) return [];
  const symbols: ExtractedSymbol[] = [];
  const addMatches = (pattern: RegExp, kindIndex: number, nameIndex: number, exportedIndex?: number) => {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(file.content))) {
      symbols.push({
        name: match[nameIndex]!,
        kind: match[kindIndex]!,
        exported: exportedIndex === undefined ? false : Boolean(match[exportedIndex])
      });
    }
  };
  const addFixedKindMatches = (pattern: RegExp, kind: string, nameIndex: number, exportedIndex?: number) => {
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

function resolveImportPath(sourcePath: string, specifier: string, fileIdByPath: Map<string, number>): string | undefined {
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
  return candidates.find((candidate) => fileIdByPath.has(candidate));
}

function isTestFile(relativePath: string): boolean {
  return /(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\.[cm]?[tj]sx?$/.test(relativePath);
}

function inferTestTargets(relativePath: string, content: string, fileIdByPath: Map<string, number>): string[] {
  const imported = extractImports({ absolutePath: '', relativePath, content, hash: '', language: 'ts' }).flatMap((specifier) => {
    const resolved = resolveImportPath(relativePath, specifier, fileIdByPath);
    return resolved ? [resolved] : [];
  });
  return [...new Set(imported)].sort();
}

function inferDocTargets(content: string, fileIdByPath: Map<string, number>): string[] {
  return inferTextTargets('', content, fileIdByPath);
}

function inferTextTargets(relativePath: string, content: string, fileIdByPath: Map<string, number>): string[] {
  const targets: string[] = [];
  const normalizedContent = content.toLowerCase();
  for (const file of fileIdByPath.keys()) {
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

function evidenceId(filePath: string, kind: string): string {
  return createHash('sha1').update(`${kind}:${filePath}`).digest('hex').slice(0, 16);
}

function fileEntity(relativePath: string, languageId: string): { id: string; kind: EntityKind } {
  return { id: fileEntityId(relativePath), kind: fileKind(relativePath, languageId) };
}

function fileEntityId(relativePath: string): string {
  return `file:${relativePath}`;
}

function fileKind(relativePath: string, languageId: string): EntityKind {
  if (isTestFile(relativePath)) return 'test';
  if (languageId === 'markdown') return 'doc';
  if (languageId === 'policy') return 'policy';
  if (languageId === 'yaml' && relativePath.startsWith('.github/workflows/')) return 'workflow';
  if (languageId === 'dockerfile' || languageId === 'terraform') return 'resource';
  if (languageId === 'yaml' || languageId === 'json' || languageId === 'toml' || languageId === 'shell' || languageId === 'makefile') return 'config';
  if (languageId === 'protobuf' || languageId === 'graphql') return 'contract';
  return 'file';
}

function languageForPath(relativePath: string): string | undefined {
  const basename = path.posix.basename(relativePath);
  const byName = languageByFileName.get(basename);
  if (byName) return byName;
  const ext = path.posix.extname(basename).toLowerCase();
  return languageByExtension.get(ext);
}

function isSystemOrContractLanguage(languageId: string): boolean {
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
  if (languageId === 'dockerfile' || languageId === 'terraform' || languageId === 'yaml' || languageId === 'json' || languageId === 'toml') {
    return 'CONFIGURES';
  }
  if (languageId === 'protobuf' || languageId === 'graphql') return 'IMPLEMENTS';
  if (languageId === 'shell' || languageId === 'makefile') return 'CALLS';
  return 'REFERENCES';
}

function symbolEntityId(relativePath: string, languageId: string, symbol: ExtractedSymbol): string {
  return `symbol:${languageId}:${relativePath}#${symbol.kind}:${symbol.name}`;
}

function externalEntityId(languageId: string, specifier: string): string {
  return `external:${languageId}:${specifier}`;
}

function relationId(kind: string, sourceEntityId: string, targetEntityId: string, provenance: string): string {
  return createHash('sha1')
    .update(`${kind}:${sourceEntityId}:${targetEntityId}:${provenance}`)
    .digest('hex')
    .slice(0, 20);
}

function relationEvidenceId(relationIdValue: string, sourcePath: string): string {
  return createHash('sha1').update(`${relationIdValue}:${sourcePath}`).digest('hex').slice(0, 20);
}

function insertCanonicalRelation(input: {
  repoId: number;
  sourceEntityId: string;
  targetEntityId: string;
  kind: string;
  confidence: string;
  provenance: string;
  adapterRunId: number;
  indexRunId: number;
  sourcePath: string;
  snippet: string;
  insertRelation: Statement;
  insertRelationEvidence: Statement;
  canonicalEntityIds: Set<string>;
  canonicalRelationIds: Set<string>;
  upsertAttributeDef: Statement;
  insertFact: Statement;
  memoryTxId: string;
}): void {
  const id = relationId(input.kind, input.sourceEntityId, input.targetEntityId, input.provenance);
  input.insertRelation.run(
    id,
    input.repoId,
    input.sourceEntityId,
    input.targetEntityId,
    input.kind,
    input.confidence,
    input.adapterRunId,
    input.indexRunId,
    input.provenance
  );
  input.insertRelationEvidence.run(
    relationEvidenceId(id, input.sourcePath),
    id,
    input.repoId,
    input.sourcePath,
    input.kind,
    redactSecrets(input.snippet),
    input.confidence,
    input.indexRunId
  );
  input.canonicalRelationIds.add(id);

  const attribute = relationKindToAttribute(input.kind);
  input.upsertAttributeDef.run(attribute);
  const valueBlob = JSON.stringify(input.targetEntityId);
  const factId = contentHash(input.sourceEntityId, attribute, valueBlob, 'assert');
  input.insertFact.run(factId, input.sourceEntityId, attribute, valueBlob, 'assert', input.memoryTxId, 0);
}

function relationKindToAttribute(kind: string): string {
  if (kind === 'DEPENDS_ON') return 'imports';
  return kind.toLowerCase();
}

function dedupeSymbols(symbols: ExtractedSymbol[]): ExtractedSymbol[] {
  return [...new Map(symbols.map((symbol) => [`${symbol.kind}:${symbol.name}`, symbol])).values()].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    return byName === 0 ? a.kind.localeCompare(b.kind) : byName;
  });
}
