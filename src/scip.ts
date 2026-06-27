import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { entityKindForPath, languageIdForPath } from './entity_classification.js';
import { contentHash, ensureRepo, latestCompletedIndexRun, openDatabase, type Db } from './store.js';
import { normalizeRepoRoot, redactSecrets, resolveInsideRoot } from './security.js';
import type { EntityKind } from './types.js';

const SCIP_IMPORT_ADAPTER_ID = 'scip-import';
const SCIP_IMPORT_ADAPTER_VERSION = '0.1.0';
const SCIP_DEFINITION_ROLE = 0x1;

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

type ScipDocument = {
  path: string;
  language: string;
  content: string;
  hash: string;
  occurrences: Record<string, unknown>[];
  symbols: Record<string, unknown>[];
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
  upsertFile: Statement;
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
  const parsed = parseScipJsonFile(inputPath);
  const documentsInput = arrayField(parsed, 'documents');
  const warnings: string[] = [];
  const documents = loadScipDocuments(repoRoot, documentsInput, warnings);
  const definitions = collectDefinitions(documents);
  const references = collectReferences(documents, definitions);
  const skippedReferences = references.skipped;

  const db = openDatabase(repoRoot);
  const repoId = ensureRepo(db, repoRoot);
  const indexRunId = latestCompletedIndexRun(db, repoId);
  const stmts = prepareScipStatements(db);
  let adapterRunId = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    adapterRunId = upsertScipAdapterRun(stmts, indexRunId, languageIdsForDocuments(documents));
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
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

function parseScipJsonFile(inputPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(inputPath, 'utf8')) as unknown;
    if (!isRecord(parsed)) throw new Error('root is not an object');
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`SCIP import expects JSON from 'scip print --json'; failed to parse ${inputPath}: ${detail}`);
  }
}

function loadScipDocuments(
  repoRoot: string,
  input: unknown[],
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
    let absolutePath: string;
    try {
      absolutePath = resolveInsideRoot(repoRoot, relativePath);
      if (!statSync(absolutePath).isFile()) {
        warnings.push(`SCIP document skipped: ${relativePath} is not a regular file`);
        continue;
      }
    } catch (error) {
      warnings.push(`SCIP document skipped: ${relativePath}: ${errorMessage(error)}`);
      continue;
    }

    const content = readFileSync(absolutePath, 'utf8');
    const language = firstNonEmpty(
      stringField(raw, 'language'),
      languageIdForPath(relativePath),
      'unknown'
    );
    documents.push({
      path: relativePath,
      language,
      content,
      hash: createHash('sha256').update(content).digest('hex'),
      occurrences: arrayField(raw, 'occurrences').filter(isRecord),
      symbols: arrayField(raw, 'symbols').filter(isRecord)
    });
  }
  return documents.sort((left, right) => left.path.localeCompare(right.path));
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
    upsertFile: db.prepare(`
      INSERT INTO files (repo_id, path, language, content_hash, index_run_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, path) DO UPDATE SET
        language = excluded.language,
        content_hash = excluded.content_hash,
        index_run_id = excluded.index_run_id
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
  input.stmts.upsertFile.run(input.repoId, document.path, document.language, document.hash, input.indexRunId);
  const fileRow = input.stmts.selectFile.get(input.repoId, document.path) as { id: number } | undefined;
  if (!fileRow) throw new Error(`SCIP import failed to persist file row: ${document.path}`);
  input.fileIds.set(document.path, fileRow.id);
  input.stmts.insertCoverage.run(input.indexRunId, SCIP_IMPORT_ADAPTER_ID, document.path, document.language);
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
  if (path.isAbsolute(rawPath)) throw new Error(`relativePath must not be absolute: ${rawPath}`);
  const normalized = rawPath.split(path.sep).join('/');
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
  const rootReal = normalizeRepoRoot(repoRoot);
  const candidate = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(rootReal, inputPath);
  const resolved = realpathSync(candidate);
  const relative = path.relative(rootReal, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error(`path resolves outside repo root: ${inputPath}`);
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
  return createHash('sha1')
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
