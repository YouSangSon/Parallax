import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { entityKindForPath, languageIdForPath } from './entity_classification.js';
import { contentHash, ensureRepo, getRepoId, latestCompletedIndexRun, openDatabase, type Db } from './store.js';
import { normalizeRepoRoot, redactSecrets } from './security.js';
import type { EntityKind } from './types.js';

const SCIP_IMPORT_ADAPTER_ID = 'scip-import';
const SCIP_IMPORT_ADAPTER_VERSION = '0.1.0';
const SCIP_EXPORT_TOOL_VERSION = '0.1.0';
const SCIP_DEFINITION_ROLE = 0x1;
const SCIP_READ_ACCESS_ROLE = 0x8;

type Statement = ReturnType<Db['prepare']>;

export type ScipImportOptions = {
  repoRoot: string;
  file: string;
};

export type ScipImportResult = {
  indexRunId: number;
  adapterRunId: number;
  file: string;
  documentsImported: number;
  definitionsImported: number;
  referencesSeen: number;
  relationsImported: number;
  skippedReferences: number;
  warnings: string[];
};

export type ScipExportOptions = {
  repoRoot: string;
};

export type ScipExportResult = {
  indexRunId: number;
  documentsExported: number;
  symbolsExported: number;
  occurrencesExported: number;
  index: ScipIndexJson;
};

type ScipIndexJson = {
  metadata: {
    version: 'UnspecifiedProtocolVersion';
    toolInfo: {
      name: 'parallax';
      version: string;
      arguments: string[];
    };
    projectRoot: string;
    textDocumentEncoding: 'UTF8';
  };
  documents: ScipExportDocument[];
};

type ScipExportDocument = {
  relativePath: string;
  language: string;
  positionEncoding: 'UTF8CodeUnitOffsetFromLineStart';
  symbols: ScipExportSymbol[];
  occurrences: ScipExportOccurrence[];
};

type ScipExportSymbol = {
  symbol: string;
  displayName: string;
  kind?: string;
};

type ScipExportOccurrence = {
  symbol: string;
  symbolRoles: number;
  range?: [number, number, number] | [number, number, number, number];
};

type ExportDocumentBucket = {
  path: string;
  language: string;
  symbols: Map<string, ScipExportSymbol>;
  occurrences: ScipExportOccurrence[];
};

type ScipDocument = {
  path: string;
  language: string;
  content?: string;
  hash: string;
  existingFileId?: number;
  occurrences: Record<string, unknown>[];
  symbols: Record<string, unknown>[];
};

type ScipImportSnapshot = {
  commitSha?: string;
  files: Map<string, { id: number; language: string; hash: string }>;
};

type ScipDefinition = {
  symbol: string;
  path: string;
  language: string;
  displayName: string;
  symbolKind: string;
};

type ScipReference = {
  sourcePath: string;
  targetPath: string;
  symbol: string;
  snippet: string;
  startLine?: number;
  endLine?: number;
  startCol?: number;
  endCol?: number;
};

type PreparedScipStatements = {
  selectAdapterRun: Statement;
  insertAdapterRun: Statement;
  updateAdapterRun: Statement;
  deletePriorEvidence: Statement;
  deletePriorRelations: Statement;
  deletePriorCoverage: Statement;
  deletePriorSymbols: Statement;
  insertFile: Statement;
  selectFile: Statement;
  upsertEntity: Statement;
  insertEntityVersion: Statement;
  insertCoverage: Statement;
  insertSymbol: Statement;
  insertRelation: Statement;
  insertRelationEvidence: Statement;
};

export function importScipJson(options: ScipImportOptions): ScipImportResult {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const inputPath = resolveScipInputPath(repoRoot, options.file);
  const parsed = parseScipInputFile(inputPath);
  const documentsInput = arrayField(parsed, 'documents');
  const db = openDatabase(repoRoot);
  let transactionStarted = false;
  try {
    // ponytail: serialize the snapshot read and augmentation with index writers;
    // revalidate/retry instead if long imports measurably block indexing.
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const repoId = ensureRepo(db, repoRoot);
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const warnings: string[] = [];
    const documents = loadScipDocuments(
      repoRoot,
      documentsInput,
      loadScipImportSnapshot(db, repoId, indexRunId),
      warnings
    );
    const definitions = collectDefinitions(documents);
    const references = collectReferences(documents, definitions);
    const skippedReferences = references.skipped;
    const stmts = prepareScipStatements(db);

    const adapterRunId = upsertScipAdapterRun(stmts, indexRunId, languageIdsForDocuments(documents));
    cleanupPriorScipImport(stmts, indexRunId, adapterRunId);

    const fileIds = new Map<string, number>();
    for (const document of documents) {
      persistScipFile(document, {
        stmts,
        repoId,
        indexRunId,
        fileIds
      });
    }

    for (const definition of definitions.values()) {
      persistScipSymbol(definition, {
        stmts,
        indexRunId,
        fileIds
      });
    }

    const relationIds = new Set<string>();
    for (const reference of references.items) {
      persistScipReference(reference, {
        stmts,
        repoId,
        indexRunId,
        adapterRunId,
        relationIds
      });
    }

    db.exec('COMMIT');
    transactionStarted = false;
    return {
      indexRunId,
      adapterRunId,
      file: path.relative(repoRoot, inputPath).split(path.sep).join('/'),
      documentsImported: documents.length,
      definitionsImported: definitions.size,
      referencesSeen: references.items.length + skippedReferences,
      relationsImported: relationIds.size,
      skippedReferences,
      warnings: [...new Set(warnings)].sort()
    };
  } catch (error) {
    if (transactionStarted) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

export function exportScipJson(options: ScipExportOptions): ScipExportResult {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const db = openDatabase(repoRoot, { readOnly: true });
  try {
    const repoId = getRepoId(db, repoRoot);
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const documents = loadScipExportDocuments(db, repoId, indexRunId);
    addExportedSymbols(db, repoId, indexRunId, documents);
    addExportedRelationOccurrences(db, repoId, indexRunId, documents);

    const exportedDocuments = [...documents.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((document) => ({
        relativePath: document.path,
        language: document.language,
        positionEncoding: 'UTF8CodeUnitOffsetFromLineStart' as const,
        symbols: [...document.symbols.values()].sort((left, right) => left.symbol.localeCompare(right.symbol)),
        occurrences: document.occurrences.sort((left, right) =>
          left.symbol.localeCompare(right.symbol) || JSON.stringify(left.range ?? []).localeCompare(JSON.stringify(right.range ?? []))
        )
      }));

    return {
      indexRunId,
      documentsExported: exportedDocuments.length,
      symbolsExported: exportedDocuments.reduce((sum, document) => sum + document.symbols.length, 0),
      occurrencesExported: exportedDocuments.reduce((sum, document) => sum + document.occurrences.length, 0),
      index: {
        metadata: {
          version: 'UnspecifiedProtocolVersion',
          toolInfo: {
            name: 'parallax',
            version: SCIP_EXPORT_TOOL_VERSION,
            arguments: ['parallax', 'scip', 'export']
          },
          projectRoot: pathToFileURL(repoRoot.endsWith(path.sep) ? repoRoot : `${repoRoot}${path.sep}`).href,
          textDocumentEncoding: 'UTF8'
        },
        documents: exportedDocuments
      }
    };
  } finally {
    db.close();
  }
}

function parseScipInputFile(inputPath: string): Record<string, unknown> {
  const rawInput = readFileSync(inputPath, 'utf8');
  const parsedInput = parseScipJsonText(rawInput);
  if (parsedInput.ok) return parsedInput.value;

  if (inputPath.endsWith('.json')) {
    throw new Error(
      `SCIP import expects JSON from 'scip print --json'; failed to parse ${inputPath}: ${parsedInput.error}`
    );
  }

  const printed = printScipBinaryAsJson(inputPath, parsedInput.error);
  const parsedPrinted = parseScipJsonText(printed);
  if (parsedPrinted.ok) return parsedPrinted.value;

  throw new Error(
    `SCIP import could not parse JSON emitted by 'scip print --json ${inputPath}': ${parsedPrinted.error}`
  );
}

function parseScipJsonText(input: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!isRecord(parsed)) throw new Error('root is not an object');
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function printScipBinaryAsJson(inputPath: string, parseError: string): string {
  try {
    return execFileSync('scip', ['print', '--json', inputPath], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      maxBuffer: 128 * 1024 * 1024
    });
  } catch (error) {
    const stderr = isRecord(error) && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    const detail = stderr || errorMessage(error);
    throw new Error(
      `SCIP import could not parse ${inputPath} as JSON (${parseError}) and could not run ` +
        `'scip print --json ${inputPath}' for binary import: ${detail}. ` +
        `Install the official scip CLI, or run 'scip print --json ${inputPath} > index.scip.json' and import that JSON file.`
    );
  }
}

function loadScipExportDocuments(db: Db, repoId: number, indexRunId: number): Map<string, ExportDocumentBucket> {
  const rows = db.prepare(`
    SELECT path, language
    FROM files
    WHERE repo_id = ? AND index_run_id = ?
    ORDER BY path
  `).all(repoId, indexRunId) as Array<{ path: string; language: string }>;
  const documents = new Map<string, ExportDocumentBucket>();
  for (const row of rows) {
    const relativePath = normalizeScipRelativePath(row.path);
    const language = firstNonEmpty(row.language, languageIdForPath(relativePath), 'unknown');
    const symbols = new Map<string, ScipExportSymbol>();
    const fileSymbol = scipFileSymbol(relativePath);
    symbols.set(fileSymbol, {
      symbol: fileSymbol,
      displayName: relativePath,
      kind: 'File'
    });
    documents.set(relativePath, {
      path: relativePath,
      language,
      symbols,
      occurrences: []
    });
  }
  return documents;
}

function addExportedSymbols(
  db: Db,
  repoId: number,
  indexRunId: number,
  documents: Map<string, ExportDocumentBucket>
): void {
  const rows = db.prepare(`
    SELECT files.path, symbols.name, symbols.kind
    FROM symbols
    INNER JOIN files ON files.id = symbols.file_id
    WHERE files.repo_id = ?
      AND symbols.index_run_id = ?
    ORDER BY files.path, symbols.name, symbols.kind
  `).all(repoId, indexRunId) as Array<{ path: string; name: string; kind: string }>;
  for (const row of rows) {
    const document = documents.get(row.path);
    if (!document) continue;
    addScipExportSymbol(document, scipCodeSymbol(row.path, row.name, row.kind), row.name, row.kind);
  }
}

function addExportedRelationOccurrences(
  db: Db,
  repoId: number,
  indexRunId: number,
  documents: Map<string, ExportDocumentBucket>
): void {
  const rows = db.prepare(`
    SELECT
      target.path AS target_path,
      target.id AS target_id,
      target.kind AS target_kind,
      target.symbol AS target_symbol,
      target.display_name AS target_display_name,
      evidence.file_path,
      evidence.start_line,
      evidence.end_line,
      evidence.start_col,
      evidence.end_col
    FROM relations relation
    INNER JOIN entities target ON target.id = relation.target_entity_id
    LEFT JOIN relation_evidence evidence ON evidence.relation_id = relation.id
    WHERE relation.repo_id = ?
      AND relation.index_run_id = ?
      AND relation.kind IN ('DEPENDS_ON', 'CALLS', 'REFERENCES', 'IMPLEMENTS')
      AND target.path IS NOT NULL
    ORDER BY evidence.file_path, relation.id, evidence.id
  `).all(repoId, indexRunId) as Array<{
    target_path: string;
    target_id: string;
    target_kind: string;
    target_symbol: string | null;
    target_display_name: string;
    file_path: string | null;
    start_line: number | null;
    end_line: number | null;
    start_col: number | null;
    end_col: number | null;
  }>;

  for (const row of rows) {
    if (!row.file_path) continue;
    const sourceDocument = documents.get(row.file_path);
    const targetDocument = documents.get(row.target_path);
    if (!sourceDocument || !targetDocument) continue;
    const targetSymbol = scipSymbolForRelationTarget(row);
    addScipExportSymbol(
      targetDocument,
      targetSymbol,
      firstNonEmpty(row.target_symbol ?? undefined, row.target_display_name, row.target_path),
      row.target_kind
    );
    sourceDocument.occurrences.push({
      symbol: targetSymbol,
      symbolRoles: SCIP_READ_ACCESS_ROLE,
      ...scipRangeFromEvidence(row)
    });
  }
}

function addScipExportSymbol(
  document: ExportDocumentBucket,
  symbol: string,
  displayName: string,
  kind: string
): void {
  if (document.symbols.has(symbol)) return;
  const scipKind = scipKindFor(kind);
  document.symbols.set(symbol, {
    symbol,
    displayName,
    ...(scipKind ? { kind: scipKind } : {})
  });
}

function scipSymbolForRelationTarget(row: {
  target_path: string;
  target_id: string;
  target_kind: string;
  target_symbol: string | null;
  target_display_name: string;
}): string {
  if (row.target_kind === 'symbol') {
    return scipCodeSymbol(
      row.target_path,
      firstNonEmpty(row.target_symbol ?? undefined, row.target_display_name),
      firstNonEmpty(symbolKindFromEntityId(row.target_id), row.target_kind)
    );
  }
  return scipFileSymbol(row.target_path);
}

function scipRangeFromEvidence(row: {
  start_line: number | null;
  end_line: number | null;
  start_col: number | null;
  end_col: number | null;
}): { range?: [number, number, number] | [number, number, number, number] } {
  if (
    row.start_line === null ||
    row.start_col === null ||
    row.end_col === null
  ) {
    return {};
  }
  const startLine = Math.max(0, row.start_line - 1);
  const startCol = Math.max(0, row.start_col - 1);
  const endCol = Math.max(startCol, row.end_col - 1);
  if (row.end_line === null || row.end_line === row.start_line) {
    return { range: [startLine, startCol, endCol] };
  }
  return {
    range: [
      startLine,
      startCol,
      Math.max(startLine, row.end_line - 1),
      endCol
    ]
  };
}

function scipFileSymbol(relativePath: string): string {
  return `parallax npm . . ${scipIdentifier(relativePath)}/`;
}

function scipCodeSymbol(relativePath: string, name: string, kind: string): string {
  const suffix = scipDescriptorSuffix(kind);
  return `${scipFileSymbol(relativePath)}${scipIdentifier(name)}${suffix}`;
}

function scipDescriptorSuffix(kind: string): string {
  const normalized = kind.toLowerCase();
  if (normalized.includes('class') || normalized.includes('interface') || normalized.includes('type')) return '#';
  if (normalized.includes('method') || normalized.includes('function') || normalized.includes('constructor')) return '().';
  return '.';
}

function symbolKindFromEntityId(entityId: string): string | undefined {
  return /^symbol:[^:]*:.*#([^:]+):/.exec(entityId)?.[1];
}

function scipIdentifier(value: string): string {
  return /^[A-Za-z0-9_$+-]+$/.test(value) ? value : `\`${value.replace(/`/g, '``')}\``;
}

function scipKindFor(kind: string): string | undefined {
  const normalized = kind.toLowerCase();
  if (normalized.includes('file')) return 'File';
  if (normalized.includes('class')) return 'Class';
  if (normalized.includes('interface')) return 'Interface';
  if (normalized.includes('method')) return 'Method';
  if (normalized.includes('function')) return 'Function';
  if (normalized.includes('constructor')) return 'Constructor';
  if (normalized.includes('property')) return 'Property';
  if (normalized.includes('constant')) return 'Constant';
  if (normalized.includes('variable')) return 'Variable';
  if (normalized.includes('module')) return 'Module';
  if (normalized.includes('type')) return 'Type';
  return undefined;
}

function loadScipImportSnapshot(
  db: Db,
  repoId: number,
  indexRunId: number
): ScipImportSnapshot {
  const run = db.prepare(`
    SELECT git_commit_sha, git_is_dirty
    FROM index_runs
    WHERE id = ? AND repo_id = ?
  `).get(indexRunId, repoId) as { git_commit_sha: string | null; git_is_dirty: number };
  const rows = db.prepare(`
    SELECT id, path, language, content_hash
    FROM files
    WHERE repo_id = ? AND index_run_id = ?
  `).all(repoId, indexRunId) as Array<{
    id: number;
    path: string;
    language: string;
    content_hash: string;
  }>;
  const commitSha = run.git_is_dirty === 0 && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(run.git_commit_sha ?? '')
    ? run.git_commit_sha!
    : undefined;
  return {
    ...(commitSha ? { commitSha } : {}),
    files: new Map(rows.map((row) => [row.path, {
      id: row.id,
      language: row.language,
      hash: row.content_hash
    }]))
  };
}

function loadScipDocuments(
  repoRoot: string,
  input: unknown[],
  snapshot: ScipImportSnapshot,
  warnings: string[]
): ScipDocument[] {
  const documents: ScipDocument[] = [];
  for (const [index, raw] of input.entries()) {
    if (!isRecord(raw)) {
      warnings.push(`SCIP document skipped at index ${index}: expected object`);
      continue;
    }
    const rawPath = stringField(raw, 'relativePath', 'relative_path');
    if (!rawPath) {
      warnings.push(`SCIP document skipped at index ${index}: missing relativePath`);
      continue;
    }
    let relativePath: string;
    try {
      relativePath = normalizeScipRelativePath(rawPath);
    } catch (error) {
      warnings.push(`SCIP document skipped at index ${index}: ${errorMessage(error)}`);
      continue;
    }
    const indexed = snapshot.files.get(relativePath);
    const hasText = Object.prototype.hasOwnProperty.call(raw, 'text');
    let content: string | undefined;
    if (hasText) {
      if (typeof raw.text !== 'string') {
        warnings.push(`SCIP document skipped: ${relativePath}: text must be a string`);
        continue;
      }
      content = raw.text;
    } else if (!indexed && snapshot.commitSha) {
      content = readScipGitBlob(repoRoot, snapshot.commitSha, relativePath);
      if (content === undefined) {
        warnings.push(`SCIP document skipped: ${relativePath}: content unavailable at indexed Git commit`);
        continue;
      }
    } else if (!indexed) {
      warnings.push(`SCIP document skipped: ${relativePath}: content unavailable without embedded text or clean indexed Git commit`);
      continue;
    }
    const hash = content === undefined
      ? indexed!.hash
      : createHash('sha256').update(content).digest('hex');
    if (indexed && hash !== indexed.hash) {
      warnings.push(`SCIP document skipped: ${relativePath}: embedded text hash mismatch with indexed file`);
      continue;
    }
    const language = firstNonEmpty(
      stringField(raw, 'language'),
      indexed?.language,
      languageIdForPath(relativePath),
      'unknown'
    );
    documents.push({
      path: relativePath,
      language,
      ...(content !== undefined ? { content } : {}),
      hash,
      ...(indexed ? { existingFileId: indexed.id } : {}),
      occurrences: arrayField(raw, 'occurrences').filter(isRecord),
      symbols: arrayField(raw, 'symbols').filter(isRecord)
    });
  }
  return documents.sort((left, right) => left.path.localeCompare(right.path));
}

function readScipGitBlob(repoRoot: string, commitSha: string, relativePath: string): string | undefined {
  // ponytail: one git process per textless unindexed document; batch cat-file if import throughput matters.
  try {
    return execFileSync(
      'git',
      ['--no-replace-objects', 'cat-file', 'blob', `${commitSha}:${relativePath}`],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 128 * 1024 * 1024
      }
    );
  } catch {
    return undefined;
  }
}

function collectDefinitions(documents: readonly ScipDocument[]): Map<string, ScipDefinition> {
  const definitions = new Map<string, ScipDefinition>();
  for (const document of documents) {
    for (const info of document.symbols) {
      const symbol = stringField(info, 'symbol');
      if (!symbol) continue;
      definitions.set(symbol, {
        symbol,
        path: document.path,
        language: document.language,
        displayName: firstNonEmpty(stringField(info, 'displayName', 'display_name'), displayNameForSymbol(symbol)),
        symbolKind: firstNonEmpty(stringField(info, 'kind'), 'scip')
      });
    }
    for (const occurrence of document.occurrences) {
      const symbol = stringField(occurrence, 'symbol');
      if (!symbol || !isDefinitionOccurrence(occurrence) || definitions.has(symbol)) continue;
      definitions.set(symbol, {
        symbol,
        path: document.path,
        language: document.language,
        displayName: displayNameForSymbol(symbol),
        symbolKind: 'scip'
      });
    }
  }
  return definitions;
}

function collectReferences(
  documents: readonly ScipDocument[],
  definitions: ReadonlyMap<string, ScipDefinition>
): { items: ScipReference[]; skipped: number } {
  const items: ScipReference[] = [];
  let skipped = 0;
  const documentByPath = new Map(documents.map((document) => [document.path, document]));
  for (const document of documents) {
    for (const occurrence of document.occurrences) {
      const symbol = stringField(occurrence, 'symbol');
      if (!symbol || isDefinitionOccurrence(occurrence)) continue;
      const target = definitions.get(symbol);
      if (!target) {
        skipped++;
        continue;
      }
      if (target.path === document.path) continue;
      const range = occurrenceRange(occurrence);
      items.push({
        sourcePath: document.path,
        targetPath: target.path,
        symbol,
        snippet: snippetForRange(documentByPath.get(document.path)?.content ?? '', range, symbol),
        ...(range
          ? {
              startLine: range.startLine + 1,
              endLine: range.endLine + 1,
              startCol: range.startChar + 1,
              endCol: range.endChar + 1
            }
          : {})
      });
    }
  }
  return { items, skipped };
}

function prepareScipStatements(db: Db): PreparedScipStatements {
  return {
    selectAdapterRun: db.prepare('SELECT id FROM adapter_runs WHERE index_run_id = ? AND adapter_id = ?'),
    insertAdapterRun: db.prepare(`
      INSERT INTO adapter_runs (
        index_run_id, adapter_id, adapter_version, language_ids, confidence, known_gaps_json,
        status, started_at, finished_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'completed', datetime('now'), datetime('now'))
    `),
    updateAdapterRun: db.prepare(`
      UPDATE adapter_runs
      SET adapter_version = ?,
          language_ids = ?,
          confidence = ?,
          known_gaps_json = ?,
          status = 'completed',
          finished_at = datetime('now'),
          error_summary = NULL
      WHERE id = ?
    `),
    deletePriorEvidence: db.prepare(`
      DELETE FROM relation_evidence
      WHERE relation_id IN (SELECT id FROM relations WHERE adapter_run_id = ?)
    `),
    deletePriorRelations: db.prepare('DELETE FROM relations WHERE adapter_run_id = ?'),
    deletePriorCoverage: db.prepare('DELETE FROM index_coverage WHERE index_run_id = ? AND adapter_id = ?'),
    deletePriorSymbols: db.prepare("DELETE FROM symbols WHERE index_run_id = ? AND semantic_id LIKE '%#scip:%'"),
    insertFile: db.prepare(`
      INSERT INTO files (repo_id, path, language, content_hash, index_run_id)
      VALUES (?, ?, ?, ?, ?)
    `),
    selectFile: db.prepare('SELECT id FROM files WHERE repo_id = ? AND path = ?'),
    upsertEntity: db.prepare(`
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
    `),
    insertEntityVersion: db.prepare(`
      INSERT OR REPLACE INTO entity_versions (entity_id, index_run_id, content_hash, location_json, state)
      VALUES (?, ?, ?, ?, 'active')
    `),
    insertCoverage: db.prepare(`
      INSERT OR REPLACE INTO index_coverage (index_run_id, adapter_id, path, language_id, status, reason)
      VALUES (?, ?, ?, ?, 'indexed', 'SCIP import document')
    `),
    insertSymbol: db.prepare(`
      INSERT OR REPLACE INTO symbols (file_id, name, kind, exported, semantic_id, index_run_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    insertRelation: db.prepare(`
      INSERT OR REPLACE INTO relations (
        id, repo_id, source_entity_id, target_entity_id, kind, confidence, adapter_run_id, index_run_id, provenance
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertRelationEvidence: db.prepare(`
      INSERT OR REPLACE INTO relation_evidence (
        id, relation_id, repo_id, file_path, kind, snippet, confidence, index_run_id,
        start_line, end_line, start_col, end_col
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
  };
}

function upsertScipAdapterRun(
  stmts: PreparedScipStatements,
  indexRunId: number,
  languageIds: readonly string[]
): number {
  const existing = stmts.selectAdapterRun.get(indexRunId, SCIP_IMPORT_ADAPTER_ID) as { id: number } | undefined;
  const languageJson = JSON.stringify(languageIds);
  if (existing) {
    stmts.updateAdapterRun.run(
      SCIP_IMPORT_ADAPTER_VERSION,
      languageJson,
      'proven',
      JSON.stringify([]),
      existing.id
    );
    return existing.id;
  }
  const inserted = stmts.insertAdapterRun.run(
    indexRunId,
    SCIP_IMPORT_ADAPTER_ID,
    SCIP_IMPORT_ADAPTER_VERSION,
    languageJson,
    'proven',
    JSON.stringify([])
  );
  return Number(inserted.lastInsertRowid);
}

function cleanupPriorScipImport(
  stmts: PreparedScipStatements,
  indexRunId: number,
  adapterRunId: number
): void {
  stmts.deletePriorEvidence.run(adapterRunId);
  stmts.deletePriorRelations.run(adapterRunId);
  stmts.deletePriorCoverage.run(indexRunId, SCIP_IMPORT_ADAPTER_ID);
  stmts.deletePriorSymbols.run(indexRunId);
}

function persistScipFile(
  document: ScipDocument,
  input: {
    stmts: PreparedScipStatements;
    repoId: number;
    indexRunId: number;
    fileIds: Map<string, number>;
  }
): void {
  let fileId = document.existingFileId;
  if (fileId === undefined) {
    input.stmts.insertFile.run(input.repoId, document.path, document.language, document.hash, input.indexRunId);
    const fileRow = input.stmts.selectFile.get(input.repoId, document.path) as { id: number } | undefined;
    if (!fileRow) throw new Error(`SCIP import failed to persist file row: ${document.path}`);
    fileId = fileRow.id;
    persistEntity({
      id: fileEntityId(document.path),
      repoId: input.repoId,
      kind: entityKindForPath(document.path) ?? 'file',
      path: document.path,
      symbol: null,
      language: document.language,
      displayName: document.path,
      contentHash: contentHash('file', document.path, document.language, document.hash),
      location: { kind: 'file', path: document.path, languageId: document.language }
    }, input);
  }
  input.fileIds.set(document.path, fileId);
  input.stmts.insertCoverage.run(input.indexRunId, SCIP_IMPORT_ADAPTER_ID, document.path, document.language);
}

function persistScipSymbol(
  definition: ScipDefinition,
  input: {
    stmts: PreparedScipStatements;
    indexRunId: number;
    fileIds: Map<string, number>;
  }
): void {
  const fileId = input.fileIds.get(definition.path);
  if (fileId === undefined) return;
  input.stmts.insertSymbol.run(
    fileId,
    definition.displayName,
    definition.symbolKind,
    definition.symbol.startsWith('local ') ? 0 : 1,
    scipSemanticId(definition),
    input.indexRunId
  );
}

function persistScipReference(
  reference: ScipReference,
  input: {
    stmts: PreparedScipStatements;
    repoId: number;
    indexRunId: number;
    adapterRunId: number;
    relationIds: Set<string>;
  }
): void {
  const sourceEntityId = fileEntityId(reference.sourcePath);
  const targetEntityId = fileEntityId(reference.targetPath);
  const provenance = `scip:${reference.symbol}`;
  const relationIdValue = relationId('REFERENCES', sourceEntityId, targetEntityId, provenance);
  const redactedSnippet = redactSecrets(reference.snippet);
  const evidenceIdValue = relationEvidenceId(relationIdValue, reference, redactedSnippet);
  input.stmts.insertRelation.run(
    relationIdValue,
    input.repoId,
    sourceEntityId,
    targetEntityId,
    'REFERENCES',
    'proven',
    input.adapterRunId,
    input.indexRunId,
    provenance
  );
  input.stmts.insertRelationEvidence.run(
    evidenceIdValue,
    relationIdValue,
    input.repoId,
    reference.sourcePath,
    'REFERENCES',
    redactedSnippet,
    'proven',
    input.indexRunId,
    reference.startLine ?? null,
    reference.endLine ?? null,
    reference.startCol ?? null,
    reference.endCol ?? null
  );
  input.relationIds.add(relationIdValue);
}

function persistEntity(
  entity: {
    id: string;
    repoId: number;
    kind: EntityKind;
    path: string | null;
    symbol: string | null;
    language: string | null;
    displayName: string;
    contentHash: string;
    location: Record<string, unknown>;
  },
  input: {
    stmts: PreparedScipStatements;
    indexRunId: number;
  }
): void {
  input.stmts.upsertEntity.run(
    entity.id,
    entity.repoId,
    entity.kind,
    entity.path,
    entity.symbol,
    entity.language,
    entity.displayName,
    input.indexRunId,
    input.indexRunId
  );
  input.stmts.insertEntityVersion.run(
    entity.id,
    input.indexRunId,
    entity.contentHash,
    stableJson(entity.location)
  );
}

function normalizeScipRelativePath(rawPath: string): string {
  if (!rawPath || rawPath.includes('\0')) throw new Error('invalid relativePath');
  if (/[\\\r\n]/.test(rawPath)) throw new Error(`relativePath must be canonical: ${rawPath}`);
  if (path.isAbsolute(rawPath)) throw new Error(`relativePath must not be absolute: ${rawPath}`);
  const normalized = rawPath;
  const parts = normalized.split('/');
  if (
    normalized !== path.posix.normalize(normalized)
    || parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`relativePath must be canonical: ${rawPath}`);
  }
  return normalized;
}

function resolveScipInputPath(repoRoot: string, inputPath: string): string {
  if (!inputPath || inputPath.includes('\0')) throw new Error('invalid path');
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(repoRoot, inputPath);
}

function occurrenceRange(occurrence: Record<string, unknown>): {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
} | undefined {
  const singleLine = recordField(occurrence, 'singleLineRange', 'single_line_range');
  if (singleLine) {
    const line = integerField(singleLine, 'line');
    const startChar = integerField(singleLine, 'startCharacter', 'start_character');
    const endChar = integerField(singleLine, 'endCharacter', 'end_character');
    if (line !== undefined && startChar !== undefined && endChar !== undefined) {
      return { startLine: line, startChar, endLine: line, endChar };
    }
  }

  const multiLine = recordField(occurrence, 'multiLineRange', 'multi_line_range');
  if (multiLine) {
    const startLine = integerField(multiLine, 'startLine', 'start_line');
    const startChar = integerField(multiLine, 'startCharacter', 'start_character');
    const endLine = integerField(multiLine, 'endLine', 'end_line');
    const endChar = integerField(multiLine, 'endCharacter', 'end_character');
    if (
      startLine !== undefined &&
      startChar !== undefined &&
      endLine !== undefined &&
      endChar !== undefined
    ) {
      return { startLine, startChar, endLine, endChar };
    }
  }

  const range = arrayField(occurrence, 'range').map((item) =>
    typeof item === 'number' && Number.isInteger(item) ? item : undefined
  );
  if (range.length === 3 && range.every((item) => item !== undefined)) {
    return {
      startLine: range[0]!,
      startChar: range[1]!,
      endLine: range[0]!,
      endChar: range[2]!
    };
  }
  if (range.length === 4 && range.every((item) => item !== undefined)) {
    return {
      startLine: range[0]!,
      startChar: range[1]!,
      endLine: range[2]!,
      endChar: range[3]!
    };
  }
  return undefined;
}

function snippetForRange(
  content: string,
  range: ReturnType<typeof occurrenceRange>,
  fallback: string
): string {
  if (!range) return fallback;
  const lines = content.split(/\r?\n/);
  const line = lines[range.startLine];
  if (line === undefined) return fallback;
  return line.trim() || fallback;
}

function isDefinitionOccurrence(occurrence: Record<string, unknown>): boolean {
  const role = fieldValue(occurrence, 'symbolRoles', 'symbol_roles');
  if (typeof role === 'number') return (role & SCIP_DEFINITION_ROLE) > 0;
  if (typeof role === 'string') return role === 'Definition' || role.includes('Definition');
  if (Array.isArray(role)) return role.some((item) => item === 'Definition');
  return false;
}

function languageIdsForDocuments(documents: readonly ScipDocument[]): string[] {
  return [...new Set(documents.map((document) => document.language))].sort();
}

function relationId(kind: string, sourceEntityId: string, targetEntityId: string, provenance: string): string {
  return createHash('sha1')
    .update(`${kind}:${sourceEntityId}:${targetEntityId}:${provenance}`)
    .digest('hex')
    .slice(0, 20);
}

function relationEvidenceId(
  relationIdValue: string,
  reference: ScipReference,
  snippet: string
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      relationIdValue,
      reference.sourcePath,
      snippet,
      reference.startLine ?? null,
      reference.endLine ?? null,
      reference.startCol ?? null,
      reference.endCol ?? null
    ]))
    .digest('hex')
    .slice(0, 20);
}

function fileEntityId(relativePath: string): string {
  return `file:${relativePath}`;
}

function scipSemanticId(definition: ScipDefinition): string {
  return `${definition.path}#scip:${definition.symbol}`;
}

function displayNameForSymbol(symbol: string): string {
  const stripped = symbol.replace(/^local\s+/, '').trim();
  const match = /([A-Za-z0-9_$+-]+)(?:[#.(/:]|\(\)\.)?$/.exec(stripped);
  return match?.[1] ?? (stripped.slice(-80) || symbol);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJsonValue(nested)])
    );
  }
  return value;
}

function arrayField(record: Record<string, unknown>, ...names: string[]): unknown[] {
  const value = fieldValue(record, ...names);
  return Array.isArray(value) ? value : [];
}

function recordField(record: Record<string, unknown>, ...names: string[]): Record<string, unknown> | undefined {
  const value = fieldValue(record, ...names);
  return isRecord(value) ? value : undefined;
}

function stringField(record: Record<string, unknown>, ...names: string[]): string | undefined {
  const value = fieldValue(record, ...names);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function integerField(record: Record<string, unknown>, ...names: string[]): number | undefined {
  const value = fieldValue(record, ...names);
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function fieldValue(record: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value !== undefined && value.length > 0) return value;
  }
  return '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
