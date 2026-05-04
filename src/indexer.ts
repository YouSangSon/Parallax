import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

import { AdapterRegistry } from './adapters/registry.js';
import { MultiLanguageRegexAdapter, isTestFile } from './adapters/multi-language-regex.js';
import type {
  EntityDescriptor,
  ExtractCtx,
  IndexEvent,
  PendingEntity,
  PendingRelation,
  SemanticAdapter
} from './adapters/types.js';
import { contentHash, ensureRepo, openDatabase, type Db } from './store.js';
import { normalizeRepoRoot, redactSecrets, toRelativePath } from './security.js';
import type {
  Confidence,
  EntityKind,
  IndexOptions,
  IndexResult,
  RelationKind,
  ScannedFile
} from './types.js';

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
const defaultMaxFileBytes = 1_000_000;
const skippedFileContentSampleBytes = 4_096;
const unsupportedAdapterId = 'unsupported';

type SkippedFile = {
  relativePath: string;
  language?: string;
  reason: string;
  contentSample?: string;
  contentSampleHash?: string;
};

type ScanResult = {
  files: ScannedFile[];
  skipped: SkippedFile[];
};

type Statement = ReturnType<Db['prepare']>;

interface PreparedStatements {
  upsertAttributeDef: Statement;
  upsertTextAttribute: Statement;
  insertFact: Statement;
  insertFactProvenance: Statement;
  upsertFile: Statement;
  selectFile: Statement;
  upsertEntity: Statement;
  insertEntityVersion: Statement;
  insertCoverage: Statement;
  insertRelation: Statement;
  insertRelationEvidence: Statement;
  insertSymbol: Statement;
  insertEdge: Statement;
  insertEvidence: Statement;
  appendAdapterRunErrorSummary: Statement;
}

interface PersistContext {
  stmts: PreparedStatements;
  repoId: number;
  indexRunId: number;
  adapterRunId: number;
  adapterId: string;
  memoryTxId: string;
  fileIdByPath: Map<string, number>;
  fileContentHashByPath: Map<string, string>;
  canonicalEntityIds: Set<string>;
  canonicalRelationIds: Set<string>;
  counters: { symbolsIndexed: number; edgesIndexed: number };
}

type RelationEvidenceInput = {
  file: string;
  snippet: string;
  confidence: Confidence;
  startLine?: number;
  endLine?: number;
  startCol?: number;
  endCol?: number;
};

type AdapterGroup = {
  adapter: SemanticAdapter;
  files: ScannedFile[];
  languageIds: string[];
};

type AdapterRunStatus = 'completed' | 'failed' | 'skipped';

export async function indexProject(options: IndexOptions): Promise<IndexResult> {
  return indexProjectInternal(options, createDefaultRegistry());
}

export async function indexProjectWithRegistryForTest(
  options: IndexOptions,
  registry: AdapterRegistry
): Promise<IndexResult> {
  return indexProjectInternal(options, registry);
}

async function indexProjectInternal(
  options: IndexOptions,
  registry: AdapterRegistry
): Promise<IndexResult> {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const db = openDatabase(repoRoot);
  const repoId = ensureRepo(db, repoRoot);

  const registeredAdapters = registry.list();
  if (registeredAdapters.length === 0) {
    db.close();
    throw new Error('no adapter registered');
  }

  const scan = scanFiles(repoRoot, options.maxFileBytes ?? defaultMaxFileBytes);
  const files = scan.files;
  const classified = registry.classify(files);
  const skippedCoverage = scan.skipped.map((file) => ({
    file,
    adapterId: adapterIdForSkippedFile(registry, repoRoot, file)
  }));
  const adapterGroups = adapterGroupsInRegistryOrder(
    registeredAdapters,
    classified,
    skippedCoverage
  );
  const fileAdapterByPath = new Map<string, SemanticAdapter>();
  for (const group of adapterGroups) {
    for (const file of group.files) {
      fileAdapterByPath.set(file.relativePath, group.adapter);
    }
  }
  const indexedFiles = files.filter((file) => fileAdapterByPath.has(file.relativePath));
  const unsupportedFiles = files.filter((file) => !fileAdapterByPath.has(file.relativePath));
  const unsupportedLanguageIds = languageIdsForSkippedAndUnsupported(
    skippedCoverage,
    unsupportedFiles
  );

  const indexRunResult = db
    .prepare(
      "INSERT INTO index_runs (repo_id, status, started_at, extractor_version) VALUES (?, ?, datetime('now'), ?)"
    )
    .run(repoId, 'running', extractorVersionFor(registeredAdapters));
  const indexRunId = Number(indexRunResult.lastInsertRowid);

  try {
    const adapterRunIds = new Map<SemanticAdapter, number>();
    const insertAdapterRun = db.prepare(`
        INSERT INTO adapter_runs (index_run_id, adapter_id, adapter_version, language_ids, status, started_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `);
    for (const group of adapterGroups) {
      const adapterRunInsert = insertAdapterRun.run(
        indexRunId,
        group.adapter.id,
        group.adapter.version,
        JSON.stringify(group.languageIds),
        'running'
      );
      adapterRunIds.set(group.adapter, Number(adapterRunInsert.lastInsertRowid));
    }

    const mainBranch = db
      .prepare("SELECT id, head_tx_id FROM branches WHERE name = 'main'")
      .get() as { id: string; head_tx_id: string | null } | undefined;
    if (!mainBranch) {
      throw new Error('main branch missing from agent memory schema (schema v4 not applied)');
    }
    const memoryTs = new Date().toISOString();
    const memoryTxId = contentHash(
      mainBranch.head_tx_id ?? '',
      mainBranch.id,
      memoryTs,
      'indexer'
    );
    db.prepare(
      'INSERT OR IGNORE INTO transactions (id, parent_tx_id, branch_id, ts, agent, index_run_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(memoryTxId, mainBranch.head_tx_id, mainBranch.id, memoryTs, 'indexer', indexRunId);
    if (mainBranch.head_tx_id) {
      db.prepare(
        'INSERT OR IGNORE INTO transaction_parents (tx_id, parent_tx_id) VALUES (?, ?)'
      ).run(memoryTxId, mainBranch.head_tx_id);
    }

    const stmts = prepareStatements(db);
    const persistCtx: Omit<PersistContext, 'adapterRunId' | 'adapterId'> = {
      stmts,
      repoId,
      indexRunId,
      memoryTxId,
      fileIdByPath: new Map<string, number>(),
      fileContentHashByPath: new Map(indexedFiles.map((file) => [file.relativePath, file.hash])),
      canonicalEntityIds: new Set<string>(),
      canonicalRelationIds: new Set<string>(),
      counters: { symbolsIndexed: 0, edgesIndexed: 0 }
    };

    for (const { file: skipped, adapterId } of skippedCoverage) {
      stmts.insertCoverage.run(
        indexRunId,
        adapterId,
        skipped.relativePath,
        skipped.language ?? null,
        'skipped',
        skipped.reason
      );
    }

    for (const file of unsupportedFiles) {
      stmts.insertCoverage.run(
        indexRunId,
        unsupportedAdapterId,
        file.relativePath,
        file.language,
        'skipped',
        'no registered adapter supports language'
      );
    }

    for (const file of indexedFiles) {
      const adapter = fileAdapterByPath.get(file.relativePath);
      if (!adapter) continue;
      stmts.upsertFile.run(repoId, file.relativePath, file.language, file.hash, indexRunId);
      const row = stmts.selectFile.get(repoId, file.relativePath) as { id: number };
      persistCtx.fileIdByPath.set(file.relativePath, row.id);
      const fileEntId = fileEntityId(file.relativePath);
      stmts.upsertEntity.run(
        fileEntId,
        repoId,
        fileKind(file.relativePath, file.language),
        file.relativePath,
        null,
        file.language,
        file.relativePath,
        indexRunId,
        indexRunId
      );
      stmts.insertEntityVersion.run(
        fileEntId,
        indexRunId,
        file.hash,
        JSON.stringify({ path: file.relativePath }),
        'active'
      );
      stmts.insertCoverage.run(
        indexRunId,
        adapter.id,
        file.relativePath,
        file.language,
        'indexed',
        'matched source extension'
      );
      persistCtx.canonicalEntityIds.add(fileEntId);
    }

    for (let groupIndex = 0; groupIndex < adapterGroups.length; groupIndex++) {
      const { adapter, files: adapterFiles } = adapterGroups[groupIndex]!;
      const adapterRunId = adapterRunIds.get(adapter);
      if (adapterRunId === undefined) {
        throw new Error(`adapter run missing for ${adapter.id}`);
      }
      if (adapterFiles.length === 0) {
        updateAdapterRun(db, adapterRunId, 'skipped');
        continue;
      }
      const ctx: ExtractCtx = { repoRoot, indexRunId, adapterRunId };
      const adapterPersistCtx: PersistContext = {
        ...persistCtx,
        adapterRunId,
        adapterId: adapter.id
      };
      try {
        const run = await adapter.start(ctx, adapterFiles);
        try {
          for (const file of adapterFiles) {
            for await (const event of run.process(file)) {
              handleEvent(event, file, adapterPersistCtx);
            }
            stmts.insertEvidence.run(
              evidenceId(file.relativePath, 'scan'),
              repoId,
              file.relativePath,
              'scan',
              redactSecrets(file.content),
              'proven',
              indexRunId
            );
          }
        } finally {
          if (run.dispose) {
            await run.dispose();
          }
        }
        updateAdapterRun(db, adapterRunId, 'completed');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateAdapterRun(db, adapterRunId, 'failed', message);
        markUnstartedAdapterRunsSkipped(
          db,
          adapterGroups.slice(groupIndex + 1),
          adapterRunIds,
          adapter.id
        );
        throw error;
      }
    }

    db.prepare("UPDATE index_runs SET status = ?, finished_at = datetime('now') WHERE id = ?").run(
      'completed',
      indexRunId
    );
    db.prepare('UPDATE branches SET head_tx_id = ? WHERE id = ?').run(memoryTxId, mainBranch.id);
    db.close();

    return {
      indexRunId,
      filesIndexed: indexedFiles.length,
      symbolsIndexed: persistCtx.counters.symbolsIndexed,
      edgesIndexed: persistCtx.counters.edgesIndexed,
      entitiesIndexed: persistCtx.canonicalEntityIds.size,
      relationsIndexed: persistCtx.canonicalRelationIds.size,
      adaptersUsed: adapterGroups.map((group) => ({
        id: group.adapter.id,
        version: group.adapter.version,
        languageIds: group.languageIds
      })),
      coverage: {
        indexedPaths: indexedFiles.length,
        skippedPaths: scan.skipped.length + unsupportedFiles.length,
        unsupportedLanguageIds,
        skipped: [
          ...scan.skipped.map((file) => ({
            path: file.relativePath,
            ...(file.language ? { languageId: file.language } : {}),
            status: 'skipped',
            reason: file.reason
          }) as const),
          ...unsupportedFiles.map((file) => ({
            path: file.relativePath,
            languageId: file.language,
            status: 'skipped',
            reason: 'no registered adapter supports language'
          }) as const)
        ]
      }
    };
  } catch (error) {
    failRunningAdapterRuns(db, indexRunId, error instanceof Error ? error.message : String(error));
    db.prepare("UPDATE index_runs SET status = ?, finished_at = datetime('now') WHERE id = ?").run(
      'failed',
      indexRunId
    );
    db.close();
    throw error;
  }
}

function createDefaultRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new MultiLanguageRegexAdapter());
  return registry;
}

function updateAdapterRun(
  db: Db,
  adapterRunId: number,
  status: AdapterRunStatus,
  errorSummary?: string | null
): void {
  if (errorSummary === undefined) {
    db.prepare(
      "UPDATE adapter_runs SET status = ?, finished_at = datetime('now') WHERE id = ?"
    ).run(status, adapterRunId);
    return;
  }
  if (status === 'failed' && errorSummary !== null) {
    db.prepare(
      `UPDATE adapter_runs
       SET status = ?,
           finished_at = datetime('now'),
           error_summary = CASE
             WHEN error_summary IS NULL OR error_summary = '' THEN ?
             ELSE error_summary || char(10) || ?
           END
       WHERE id = ?`
    ).run(status, errorSummary, errorSummary, adapterRunId);
    return;
  }
  db.prepare(
    "UPDATE adapter_runs SET status = ?, finished_at = datetime('now'), error_summary = ? WHERE id = ?"
  ).run(status, errorSummary, adapterRunId);
}

function markUnstartedAdapterRunsSkipped(
  db: Db,
  groups: readonly AdapterGroup[],
  adapterRunIds: ReadonlyMap<SemanticAdapter, number>,
  failedAdapterId: string
): void {
  for (const group of groups) {
    const adapterRunId = adapterRunIds.get(group.adapter);
    if (adapterRunId !== undefined) {
      updateAdapterRun(db, adapterRunId, 'skipped', `not run because ${failedAdapterId} failed`);
    }
  }
}

function failRunningAdapterRuns(db: Db, indexRunId: number, errorSummary: string): void {
  db.prepare(
    `UPDATE adapter_runs
     SET status = ?, finished_at = datetime('now'), error_summary = ?
     WHERE index_run_id = ? AND status = ?`
  ).run('failed', errorSummary, indexRunId, 'running');
}

function adapterGroupsInRegistryOrder(
  adapters: readonly SemanticAdapter[],
  classified: ReadonlyMap<SemanticAdapter, ScannedFile[]>,
  skippedCoverage: ReadonlyArray<{ file: SkippedFile; adapterId: string }> = []
): AdapterGroup[] {
  const skippedLanguageIdsByAdapter = new Map<string, Set<string>>();
  for (const { file, adapterId } of skippedCoverage) {
    if (adapterId === unsupportedAdapterId || !file.language) {
      continue;
    }
    let languageIds = skippedLanguageIdsByAdapter.get(adapterId);
    if (!languageIds) {
      languageIds = new Set<string>();
      skippedLanguageIdsByAdapter.set(adapterId, languageIds);
    }
    languageIds.add(file.language);
  }

  return adapters.flatMap((adapter) => {
    const files = classified.get(adapter) ?? [];
    const languageIds = new Set(languageIdsForFiles(files));
    for (const languageId of skippedLanguageIdsByAdapter.get(adapter.id) ?? []) {
      languageIds.add(languageId);
    }
    if (files.length === 0 && languageIds.size === 0) {
      return [];
    }
    return [
      {
        adapter,
        files,
        languageIds: [...languageIds].sort()
      }
    ];
  });
}

function languageIdsForFiles(files: readonly ScannedFile[]): string[] {
  return [...new Set(files.map((file) => file.language))].sort();
}

function adapterIdForSkippedFile(
  registry: AdapterRegistry,
  repoRoot: string,
  file: SkippedFile
): string {
  if (!file.language) {
    return unsupportedAdapterId;
  }
  const absolutePath = path.join(repoRoot, file.relativePath);
  const content = file.contentSample ?? '';
  const adapter = registry.pickAdapter({
    absolutePath,
    relativePath: file.relativePath,
    content,
    hash: file.contentSampleHash ?? createHash('sha256').update(content).digest('hex'),
    language: file.language
  });
  return adapter?.id ?? unsupportedAdapterId;
}

function languageIdsForSkippedAndUnsupported(
  skippedCoverage: ReadonlyArray<{ file: SkippedFile; adapterId: string }>,
  unsupportedFiles: readonly ScannedFile[]
): string[] {
  return [
    ...new Set([
      ...unsupportedFiles.map((file) => file.language),
      ...skippedCoverage.flatMap(({ file, adapterId }) =>
        adapterId === unsupportedAdapterId && file.language ? [file.language] : []
      )
    ])
  ].sort();
}

function extractorVersionFor(adapters: readonly SemanticAdapter[]): string {
  if (adapters.length === 1) {
    const adapter = adapters[0]!;
    return `${adapter.id}-${adapter.version}`;
  }
  return adapters.map((adapter) => `${adapter.id}-${adapter.version}`).join(',');
}

function prepareStatements(db: Db): PreparedStatements {
  return {
    upsertAttributeDef: db.prepare(
      `INSERT INTO attribute_defs (name, value_type, is_code_relation, description)
       VALUES (?, 'entity_ref', 1, '')
       ON CONFLICT(name) DO UPDATE SET
         value_type = 'entity_ref',
         is_code_relation = 1`
    ),
    upsertTextAttribute: db.prepare(
      "INSERT OR IGNORE INTO attribute_defs (name, value_type, is_code_relation, description) VALUES (?, 'text', 0, '')"
    ),
    insertFact: db.prepare(
      'INSERT OR IGNORE INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ),
    insertFactProvenance: db.prepare(
      'INSERT OR IGNORE INTO fact_provenance (id, fact_id, source_fact_id) VALUES (?, ?, ?)'
    ),
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
      VALUES (?, ?, ?, ?, ?)
    `),
    insertCoverage: db.prepare(`
      INSERT OR REPLACE INTO index_coverage (index_run_id, adapter_id, path, language_id, status, reason)
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
        id, relation_id, repo_id, file_path, kind, snippet, confidence, index_run_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertSymbol: db.prepare(`
      INSERT OR REPLACE INTO symbols (file_id, name, kind, exported, semantic_id, index_run_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    insertEdge: db.prepare(`
      INSERT OR REPLACE INTO edges (repo_id, source_file_id, target_file_id, kind, target_path, confidence, provenance, index_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertEvidence: db.prepare(`
      INSERT OR REPLACE INTO evidence (id, repo_id, file_path, kind, snippet, confidence, index_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    appendAdapterRunErrorSummary: db.prepare(`
      UPDATE adapter_runs
      SET error_summary = CASE
        WHEN error_summary IS NULL OR error_summary = '' THEN ?
        ELSE error_summary || char(10) || ?
      END
      WHERE id = ?
    `)
  };
}

function handleEvent(event: IndexEvent, file: ScannedFile, ctx: PersistContext): void {
  if (event.kind === 'entity') {
    persistEntity(event.entity, ctx);
  } else if (event.kind === 'relation') {
    persistRelation(event.relation, file, ctx);
  } else {
    persistDiagnostic(event, file, ctx);
  }
}

function persistDiagnostic(
  event: Extract<IndexEvent, { kind: 'diagnostic' }>,
  file: ScannedFile,
  ctx: PersistContext
): void {
  const reason = diagnosticReason(event.level, event.message);
  if (event.file) {
    ctx.stmts.insertCoverage.run(
      ctx.indexRunId,
      ctx.adapterId,
      diagnosticCoveragePath(event.file, event.level, reason),
      diagnosticLanguageId(event.file, file),
      'skipped',
      reason
    );
    return;
  }
  ctx.stmts.appendAdapterRunErrorSummary.run(reason, reason, ctx.adapterRunId);
}

function diagnosticReason(level: 'warn' | 'error', message: string): string {
  const label = level === 'warn' ? 'warning' : 'error';
  return `diagnostic ${label}: ${redactSecrets(message)}`;
}

function diagnosticCoveragePath(
  filePath: string,
  level: 'warn' | 'error',
  reason: string
): string {
  return `${filePath}#diagnostic:${level}:${contentHash(level, reason).slice(0, 12)}`;
}

function diagnosticLanguageId(filePath: string, currentFile: ScannedFile): string | null {
  if (filePath === currentFile.relativePath) {
    return currentFile.language;
  }
  return languageForPath(filePath) ?? null;
}

function persistEntity(entity: PendingEntity, ctx: PersistContext): void {
  if (entity.kind === 'symbol') {
    const symbolId = entityIdFromDescriptor(entity);
    const meta = entity.metadata as { exported?: boolean } | undefined;
    const containingFileContentHash = entity.path
      ? ctx.fileContentHashByPath.get(entity.path) ?? ''
      : '';
    ctx.stmts.upsertEntity.run(
      symbolId,
      ctx.repoId,
      'symbol',
      entity.path ?? null,
      entity.symbol ?? null,
      entity.languageId ?? null,
      entity.displayName ?? null,
      ctx.indexRunId,
      ctx.indexRunId
    );
    ctx.stmts.insertEntityVersion.run(
      symbolId,
      ctx.indexRunId,
      symbolEntityVersionContentHash(entity, containingFileContentHash),
      JSON.stringify({
        path: entity.path,
        symbol: entity.symbol,
        kind: entity.symbolKind ?? ''
      }),
      'active'
    );
    if (entity.path) {
      const fileId = ctx.fileIdByPath.get(entity.path);
      if (fileId !== undefined) {
        ctx.stmts.insertSymbol.run(
          fileId,
          entity.symbol ?? '',
          entity.symbolKind ?? '',
          meta?.exported ? 1 : 0,
          `${entity.path}#${entity.symbolKind ?? ''}:${entity.symbol ?? ''}`,
          ctx.indexRunId
        );
      }
    }
    ctx.canonicalEntityIds.add(symbolId);
    ctx.counters.symbolsIndexed++;
    return;
  }
  if (entity.kind === 'external_entity') {
    const externalId = entityIdFromDescriptor(entity);
    const meta = entity.metadata as { specifier?: string } | undefined;
    const specifier = meta?.specifier ?? entity.displayName ?? '';
    ctx.stmts.upsertEntity.run(
      externalId,
      ctx.repoId,
      'external_entity',
      null,
      null,
      entity.languageId ?? null,
      entity.displayName ?? null,
      ctx.indexRunId,
      ctx.indexRunId
    );
    ctx.stmts.insertEntityVersion.run(
      externalId,
      ctx.indexRunId,
      specifier,
      JSON.stringify({ specifier }),
      'active'
    );
    ctx.canonicalEntityIds.add(externalId);
  }
}

function symbolEntityVersionContentHash(
  entity: PendingEntity,
  containingFileContentHash: string
): string {
  return contentHash(
    entity.path ?? '',
    entity.symbolKind ?? '',
    entity.symbol ?? '',
    containingFileContentHash
  );
}

function persistRelation(
  relation: PendingRelation,
  file: ScannedFile,
  ctx: PersistContext
): void {
  const sourceId = entityIdFromDescriptor(relation.source);
  const targetId = entityIdFromDescriptor(relation.target);
  const meta = relation.metadata as
    | { provenance?: string; confidence?: Confidence }
    | undefined;
  const provenance = meta?.provenance ?? '';
  const confidence: Confidence =
    meta?.confidence ?? relation.evidence?.[0]?.confidence ?? 'heuristic';

  if (
    relation.source.kind !== 'symbol' &&
    relation.target.kind !== 'symbol' &&
    relation.source.path
  ) {
    const sourceFileId = ctx.fileIdByPath.get(relation.source.path);
    if (sourceFileId !== undefined) {
      const targetFileId =
        relation.target.kind === 'file' && relation.target.path
          ? ctx.fileIdByPath.get(relation.target.path) ?? null
          : null;
      const targetPath =
        relation.target.kind === 'file' && relation.target.path
          ? relation.target.path
          : relation.target.displayName ?? '';
      ctx.stmts.insertEdge.run(
        ctx.repoId,
        sourceFileId,
        targetFileId,
        legacyEdgeKindFor(relation.kind),
        targetPath,
        confidence,
        provenance,
        ctx.indexRunId
      );
      ctx.counters.edgesIndexed++;
    }
  }

  insertCanonicalRelation({
    repoId: ctx.repoId,
    sourceEntityId: sourceId,
    targetEntityId: targetId,
    kind: relation.kind,
    confidence,
    provenance,
    adapterRunId: ctx.adapterRunId,
    indexRunId: ctx.indexRunId,
    evidence: relationEvidenceForPersistence(relation, file, confidence),
    insertRelation: ctx.stmts.insertRelation,
    insertRelationEvidence: ctx.stmts.insertRelationEvidence,
    canonicalRelationIds: ctx.canonicalRelationIds,
    upsertAttributeDef: ctx.stmts.upsertAttributeDef,
    insertFact: ctx.stmts.insertFact,
    memoryTxId: ctx.memoryTxId,
    upsertTextAttribute: ctx.stmts.upsertTextAttribute,
    insertFactProvenance: ctx.stmts.insertFactProvenance
  });
}

function relationEvidenceForPersistence(
  relation: PendingRelation,
  file: ScannedFile,
  fallbackConfidence: Confidence
): RelationEvidenceInput[] {
  if (relation.evidence && relation.evidence.length > 0) {
    return relation.evidence.map((evidence) => ({
      file: evidence.file,
      snippet: evidence.snippet ?? '',
      confidence: evidence.confidence,
      ...(evidence.startLine !== undefined ? { startLine: evidence.startLine } : {}),
      ...(evidence.endLine !== undefined ? { endLine: evidence.endLine } : {}),
      ...(evidence.startCol !== undefined ? { startCol: evidence.startCol } : {}),
      ...(evidence.endCol !== undefined ? { endCol: evidence.endCol } : {})
    }));
  }
  return [
    {
      file: file.relativePath,
      snippet: file.content,
      confidence: fallbackConfidence
    }
  ];
}

function entityIdFromDescriptor(d: EntityDescriptor): string {
  if (d.kind === 'symbol') {
    return `symbol:${d.languageId ?? ''}:${d.path ?? ''}#${d.symbolKind ?? ''}:${d.symbol ?? ''}`;
  }
  if (d.kind === 'external_entity') {
    return `external:${d.languageId ?? ''}:${d.displayName ?? ''}`;
  }
  return fileEntityId(d.path ?? '');
}

function legacyEdgeKindFor(canonical: RelationKind): string {
  if (canonical === 'DEPENDS_ON') return 'IMPORTS';
  if (canonical === 'VERIFIES') return 'TESTS';
  return canonical;
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
        const contentSample = readContentSample(absolutePath, size);
        skipped.push({
          relativePath,
          language,
          reason: `file exceeds maxFileBytes (${size} > ${maxFileBytes})`,
          ...(contentSample
            ? {
                contentSample: contentSample.content,
                contentSampleHash: contentSample.hash
              }
            : {})
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

function readContentSample(
  absolutePath: string,
  fileSize: number
): { content: string; hash: string } | undefined {
  const length = Math.min(fileSize, skippedFileContentSampleBytes);
  const buffer = Buffer.allocUnsafe(length);
  let fd: number | undefined;
  try {
    fd = openSync(absolutePath, 'r');
    const bytesRead = readSync(fd, buffer, 0, length, 0);
    const content = buffer.subarray(0, bytesRead).toString('utf8');
    return {
      content,
      hash: createHash('sha256').update(content).digest('hex')
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function evidenceId(filePath: string, kind: string): string {
  return createHash('sha1').update(`${kind}:${filePath}`).digest('hex').slice(0, 16);
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
  if (
    languageId === 'yaml' ||
    languageId === 'json' ||
    languageId === 'toml' ||
    languageId === 'shell' ||
    languageId === 'makefile'
  ) {
    return 'config';
  }
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

function relationId(
  kind: string,
  sourceEntityId: string,
  targetEntityId: string,
  provenance: string
): string {
  return createHash('sha1')
    .update(`${kind}:${sourceEntityId}:${targetEntityId}:${provenance}`)
    .digest('hex')
    .slice(0, 20);
}

function relationEvidenceId(
  relationIdValue: string,
  evidence: RelationEvidenceInput,
  snippet: string,
): string {
  const identity: unknown[] = [relationIdValue, evidence.file, snippet, evidence.confidence];
  if (hasEvidenceSpan(evidence)) {
    identity.push({
      startLine: evidence.startLine ?? null,
      endLine: evidence.endLine ?? null,
      startCol: evidence.startCol ?? null,
      endCol: evidence.endCol ?? null
    });
  }
  return createHash('sha1')
    .update(JSON.stringify(identity))
    .digest('hex')
    .slice(0, 20);
}

function hasEvidenceSpan(evidence: RelationEvidenceInput): boolean {
  return (
    evidence.startLine !== undefined ||
    evidence.endLine !== undefined ||
    evidence.startCol !== undefined ||
    evidence.endCol !== undefined
  );
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
  evidence: readonly RelationEvidenceInput[];
  insertRelation: Statement;
  insertRelationEvidence: Statement;
  canonicalRelationIds: Set<string>;
  upsertAttributeDef: Statement;
  insertFact: Statement;
  memoryTxId: string;
  upsertTextAttribute: Statement;
  insertFactProvenance: Statement;
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
  input.canonicalRelationIds.add(id);

  const attribute = relationKindToAttribute(input.kind);
  input.upsertAttributeDef.run(attribute);
  const valueBlob = JSON.stringify(input.targetEntityId);
  const factId = contentHash(input.sourceEntityId, attribute, valueBlob, 'assert');
  input.insertFact.run(
    factId,
    input.sourceEntityId,
    attribute,
    valueBlob,
    'assert',
    input.memoryTxId,
    0
  );

  input.upsertTextAttribute.run('evidence_snippet');
  input.evidence.forEach((evidence) => {
    const redactedSnippet = redactSecrets(evidence.snippet);
    const isSnippetRedacted = redactedSnippet !== evidence.snippet;
    input.insertRelationEvidence.run(
      relationEvidenceId(id, evidence, redactedSnippet),
      id,
      input.repoId,
      evidence.file,
      input.kind,
      redactedSnippet,
      evidence.confidence,
      input.indexRunId
    );

    const evidenceEntity = `file:${evidence.file}`;
    const evidenceValueBlob = JSON.stringify(redactedSnippet);
    const evidenceFactId = contentHash(
      evidenceEntity,
      'evidence_snippet',
      evidenceValueBlob,
      'assert'
    );
    input.insertFact.run(
      evidenceFactId,
      evidenceEntity,
      'evidence_snippet',
      evidenceValueBlob,
      'assert',
      input.memoryTxId,
      isSnippetRedacted ? 1 : 0
    );
    const provenanceId = contentHash(factId, evidenceFactId);
    input.insertFactProvenance.run(provenanceId, factId, evidenceFactId);
  });
}

const relationAttributeByKind: Record<RelationKind, string> = {
  DEPENDS_ON: 'imports',
  CALLS: 'calls',
  IMPORTS: 'imports',
  EXPORTS: 'exports',
  IMPLEMENTS: 'implements',
  EXTENDS: 'extends',
  READS: 'reads',
  WRITES: 'writes',
  RAISES: 'raises',
  HANDLES: 'handles',
  OWNS: 'owns',
  TESTS: 'tests',
  VERIFIES: 'tests',
  DOCUMENTS: 'documents',
  CONFIGURES: 'configures',
  BREAKS_COMPATIBILITY_WITH: 'breaks_compat',
  REFERENCES: 'references',
  DECLARES: 'declares',
  GOVERNS: 'governs'
};

function relationKindToAttribute(kind: string): string {
  return relationAttributeByKind[kind as RelationKind] ?? kind.toLowerCase();
}
