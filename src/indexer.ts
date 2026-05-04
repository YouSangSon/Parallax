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
  insertEntityIfMissing: Statement;
  updateEntityFreshness: Statement;
  insertEntityVersion: Statement;
  insertEntityVersionIfMissing: Statement;
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
  currentStateSnapshot: CurrentStateSnapshot;
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

type FileSnapshotRow = {
  id: number;
  repo_id: number;
  path: string;
  language: string;
  content_hash: string;
  index_run_id: number;
};

type EntitySnapshotRow = {
  id: string;
  repo_id: number;
  kind: string;
  path: string | null;
  symbol: string | null;
  language_id: string | null;
  display_name: string;
  created_index_run_id: number;
  updated_index_run_id: number;
};

type RelationSnapshotRow = {
  id: string;
  repo_id: number;
  source_entity_id: string;
  target_entity_id: string;
  kind: string;
  confidence: string;
  adapter_run_id: number | null;
  index_run_id: number;
  provenance: string;
};

type RelationEvidenceSnapshotRow = {
  id: string;
  relation_id: string;
  repo_id: number;
  file_path: string;
  kind: string;
  snippet: string;
  confidence: string;
  index_run_id: number;
};

type SymbolSnapshotRow = {
  id: number;
  file_id: number;
  name: string;
  kind: string;
  exported: number;
  semantic_id: string;
  index_run_id: number;
};

type EdgeSnapshotRow = {
  id: number;
  repo_id: number;
  source_file_id: number;
  target_file_id: number | null;
  kind: string;
  target_path: string;
  confidence: string;
  provenance: string;
  index_run_id: number;
};

type EvidenceSnapshotRow = {
  id: string;
  repo_id: number;
  file_path: string;
  kind: string;
  snippet: string;
  confidence: string;
  index_run_id: number;
};

type SymbolSnapshotEntry = {
  fileId: number;
  semanticId: string;
  row: SymbolSnapshotRow | null;
};

type EdgeSnapshotEntry = {
  repoId: number;
  sourceFileId: number;
  kind: string;
  targetPath: string;
  row: EdgeSnapshotRow | null;
};

class CurrentStateSnapshot {
  private readonly files = new Map<string, FileSnapshotRow | null>();
  private readonly entities = new Map<string, EntitySnapshotRow | null>();
  private readonly relations = new Map<string, RelationSnapshotRow | null>();
  private readonly relationEvidence = new Map<string, RelationEvidenceSnapshotRow | null>();
  private readonly symbols = new Map<string, SymbolSnapshotEntry>();
  private readonly edges = new Map<string, EdgeSnapshotEntry>();
  private readonly evidence = new Map<string, EvidenceSnapshotRow | null>();

  private readonly selectFile: Statement;
  private readonly selectEntity: Statement;
  private readonly selectRelation: Statement;
  private readonly selectRelationEvidence: Statement;
  private readonly selectSymbol: Statement;
  private readonly selectEdge: Statement;
  private readonly selectEvidence: Statement;

  constructor(
    private readonly db: Db,
    private readonly repoId: number,
    private readonly indexRunId: number,
    private readonly deleteNewRows: boolean
  ) {
    this.selectFile = db.prepare('SELECT * FROM files WHERE repo_id = ? AND path = ?');
    this.selectEntity = db.prepare('SELECT * FROM entities WHERE id = ?');
    this.selectRelation = db.prepare('SELECT * FROM relations WHERE id = ?');
    this.selectRelationEvidence = db.prepare('SELECT * FROM relation_evidence WHERE id = ?');
    this.selectSymbol = db.prepare('SELECT * FROM symbols WHERE file_id = ? AND semantic_id = ?');
    this.selectEdge = db.prepare(
      'SELECT * FROM edges WHERE repo_id = ? AND source_file_id = ? AND kind = ? AND target_path = ?'
    );
    this.selectEvidence = db.prepare('SELECT * FROM evidence WHERE id = ?');
  }

  captureFile(pathValue: string): void {
    if (this.files.has(pathValue)) return;
    this.files.set(
      pathValue,
      (this.selectFile.get(this.repoId, pathValue) as FileSnapshotRow | undefined) ?? null
    );
  }

  captureEntity(id: string): void {
    if (this.entities.has(id)) return;
    this.entities.set(id, (this.selectEntity.get(id) as EntitySnapshotRow | undefined) ?? null);
  }

  captureRelation(id: string): void {
    if (this.relations.has(id)) return;
    this.relations.set(id, (this.selectRelation.get(id) as RelationSnapshotRow | undefined) ?? null);
  }

  captureRelationEvidence(id: string): void {
    if (this.relationEvidence.has(id)) return;
    this.relationEvidence.set(
      id,
      (this.selectRelationEvidence.get(id) as RelationEvidenceSnapshotRow | undefined) ?? null
    );
  }

  captureSymbol(fileId: number, semanticId: string): void {
    const key = `${fileId}\0${semanticId}`;
    if (this.symbols.has(key)) return;
    this.symbols.set(key, {
      fileId,
      semanticId,
      row: (this.selectSymbol.get(fileId, semanticId) as SymbolSnapshotRow | undefined) ?? null
    });
  }

  captureEdge(repoId: number, sourceFileId: number, kind: string, targetPath: string): void {
    const key = `${repoId}\0${sourceFileId}\0${kind}\0${targetPath}`;
    if (this.edges.has(key)) return;
    this.edges.set(key, {
      repoId,
      sourceFileId,
      kind,
      targetPath,
      row:
        (this.selectEdge.get(repoId, sourceFileId, kind, targetPath) as
          | EdgeSnapshotRow
          | undefined) ?? null
    });
  }

  captureEvidence(id: string): void {
    if (this.evidence.has(id)) return;
    this.evidence.set(id, (this.selectEvidence.get(id) as EvidenceSnapshotRow | undefined) ?? null);
  }

  restore(): void {
    if (this.isEmpty()) return;

    const deleteRelationEvidence = this.db.prepare(
      'DELETE FROM relation_evidence WHERE id = ? AND index_run_id = ?'
    );
    const deleteSymbol = this.db.prepare(
      'DELETE FROM symbols WHERE file_id = ? AND semantic_id = ? AND index_run_id = ?'
    );
    const deleteEdge = this.db.prepare(
      'DELETE FROM edges WHERE repo_id = ? AND source_file_id = ? AND kind = ? AND target_path = ? AND index_run_id = ?'
    );
    const deleteEvidence = this.db.prepare('DELETE FROM evidence WHERE id = ? AND index_run_id = ?');
    const deleteRelation = this.db.prepare(
      'DELETE FROM relations WHERE id = ? AND index_run_id = ?'
    );
    const deleteFile = this.db.prepare(
      'DELETE FROM files WHERE repo_id = ? AND path = ? AND index_run_id = ?'
    );
    const deleteFailedEntityVersions = this.db.prepare(
      'DELETE FROM entity_versions WHERE entity_id = ? AND index_run_id = ?'
    );
    const deleteEntity = this.db.prepare(
      'DELETE FROM entities WHERE id = ? AND updated_index_run_id = ?'
    );

    const restoreFile = this.db.prepare(`
      INSERT INTO files (id, repo_id, path, language, content_hash, index_run_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, path) DO UPDATE SET
        language = excluded.language,
        content_hash = excluded.content_hash,
        index_run_id = excluded.index_run_id
    `);
    const restoreEntity = this.db.prepare(`
      INSERT INTO entities (
        id, repo_id, kind, path, symbol, language_id, display_name, created_index_run_id, updated_index_run_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        repo_id = excluded.repo_id,
        kind = excluded.kind,
        path = excluded.path,
        symbol = excluded.symbol,
        language_id = excluded.language_id,
        display_name = excluded.display_name,
        created_index_run_id = excluded.created_index_run_id,
        updated_index_run_id = excluded.updated_index_run_id
    `);
    const restoreRelation = this.db.prepare(`
      INSERT INTO relations (
        id, repo_id, source_entity_id, target_entity_id, kind, confidence, adapter_run_id, index_run_id, provenance
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const restoreRelationEvidence = this.db.prepare(`
      INSERT INTO relation_evidence (
        id, relation_id, repo_id, file_path, kind, snippet, confidence, index_run_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const restoreSymbol = this.db.prepare(`
      INSERT INTO symbols (id, file_id, name, kind, exported, semantic_id, index_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const restoreEdge = this.db.prepare(`
      INSERT INTO edges (
        id, repo_id, source_file_id, target_file_id, kind, target_path, confidence, provenance, index_run_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const restoreEvidence = this.db.prepare(`
      INSERT INTO evidence (id, repo_id, file_path, kind, snippet, confidence, index_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.db.exec('SAVEPOINT restore_failed_index_current_state');
    try {
      for (const [id, row] of this.relationEvidence) {
        if (row || this.deleteNewRows) {
          deleteRelationEvidence.run(id, this.indexRunId);
        }
      }
      for (const entry of this.symbols.values()) {
        if (entry.row || this.deleteNewRows) {
          deleteSymbol.run(entry.fileId, entry.semanticId, this.indexRunId);
        }
      }
      for (const entry of this.edges.values()) {
        if (entry.row || this.deleteNewRows) {
          deleteEdge.run(
            entry.repoId,
            entry.sourceFileId,
            entry.kind,
            entry.targetPath,
            this.indexRunId
          );
        }
      }
      for (const [id, row] of this.evidence) {
        if (row || this.deleteNewRows) {
          deleteEvidence.run(id, this.indexRunId);
        }
      }
      for (const [id, row] of this.relations) {
        if (row || this.deleteNewRows) {
          deleteRelation.run(id, this.indexRunId);
        }
      }

      for (const [pathValue, row] of this.files) {
        if (row) {
          restoreFile.run(
            row.id,
            row.repo_id,
            row.path,
            row.language,
            row.content_hash,
            row.index_run_id
          );
        } else if (this.deleteNewRows) {
          deleteFile.run(this.repoId, pathValue, this.indexRunId);
        }
      }

      for (const [id, row] of this.entities) {
        if (row) {
          restoreEntity.run(
            row.id,
            row.repo_id,
            row.kind,
            row.path,
            row.symbol,
            row.language_id,
            row.display_name,
            row.created_index_run_id,
            row.updated_index_run_id
          );
        } else if (this.deleteNewRows) {
          deleteFailedEntityVersions.run(id, this.indexRunId);
          deleteEntity.run(id, this.indexRunId);
        }
      }

      for (const row of this.relations.values()) {
        if (!row) continue;
        restoreRelation.run(
          row.id,
          row.repo_id,
          row.source_entity_id,
          row.target_entity_id,
          row.kind,
          row.confidence,
          row.adapter_run_id,
          row.index_run_id,
          row.provenance
        );
      }
      for (const row of this.relationEvidence.values()) {
        if (!row) continue;
        restoreRelationEvidence.run(
          row.id,
          row.relation_id,
          row.repo_id,
          row.file_path,
          row.kind,
          row.snippet,
          row.confidence,
          row.index_run_id
        );
      }
      for (const entry of this.symbols.values()) {
        const { row } = entry;
        if (!row) continue;
        restoreSymbol.run(
          row.id,
          row.file_id,
          row.name,
          row.kind,
          row.exported,
          row.semantic_id,
          row.index_run_id
        );
      }
      for (const entry of this.edges.values()) {
        const { row } = entry;
        if (!row) continue;
        restoreEdge.run(
          row.id,
          row.repo_id,
          row.source_file_id,
          row.target_file_id,
          row.kind,
          row.target_path,
          row.confidence,
          row.provenance,
          row.index_run_id
        );
      }
      for (const row of this.evidence.values()) {
        if (!row) continue;
        restoreEvidence.run(
          row.id,
          row.repo_id,
          row.file_path,
          row.kind,
          row.snippet,
          row.confidence,
          row.index_run_id
        );
      }

      this.db.exec('RELEASE SAVEPOINT restore_failed_index_current_state');
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT restore_failed_index_current_state');
      this.db.exec('RELEASE SAVEPOINT restore_failed_index_current_state');
      throw error;
    }
  }

  private isEmpty(): boolean {
    return (
      this.files.size === 0 &&
      this.entities.size === 0 &&
      this.relations.size === 0 &&
      this.relationEvidence.size === 0 &&
      this.symbols.size === 0 &&
      this.edges.size === 0 &&
      this.evidence.size === 0
    );
  }
}

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

  const indexRunResult = db
    .prepare(
      "INSERT INTO index_runs (repo_id, status, started_at, extractor_version) VALUES (?, ?, datetime('now'), ?)"
    )
    .run(repoId, 'running', extractorVersionFor(registeredAdapters));
  const indexRunId = Number(indexRunResult.lastInsertRowid);
  const hasCompletedSnapshot = db
    .prepare('SELECT 1 AS one FROM index_runs WHERE repo_id = ? AND status = ? LIMIT 1')
    .get(repoId, 'completed') as { one: number } | undefined;
  const currentStateSnapshot = new CurrentStateSnapshot(
    db,
    repoId,
    indexRunId,
    hasCompletedSnapshot !== undefined
  );

  try {
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
      counters: { symbolsIndexed: 0, edgesIndexed: 0 },
      currentStateSnapshot
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
      currentStateSnapshot.captureFile(file.relativePath);
      stmts.upsertFile.run(repoId, file.relativePath, file.language, file.hash, indexRunId);
      const row = stmts.selectFile.get(repoId, file.relativePath) as { id: number };
      persistCtx.fileIdByPath.set(file.relativePath, row.id);
      const fileEntId = fileEntityId(file.relativePath);
      currentStateSnapshot.captureEntity(fileEntId);
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
      const ctx: ExtractCtx = {
        repoRoot,
        indexRunId,
        adapterRunId,
        indexedFiles: immutableIndexedFilesSnapshot(indexedFiles)
      };
      const adapterPersistCtx: PersistContext = {
        ...persistCtx,
        adapterRunId,
        adapterId: adapter.id
      };
      const completedFilePaths = new Set<string>();
      try {
        const run = await adapter.start(ctx, adapterFiles);
        try {
          for (const file of adapterFiles) {
            for await (const event of run.process(file)) {
              handleEvent(event, file, adapterPersistCtx);
            }
            const scanEvidenceId = evidenceId(file.relativePath, 'scan');
            currentStateSnapshot.captureEvidence(scanEvidenceId);
            stmts.insertEvidence.run(
              scanEvidenceId,
              repoId,
              file.relativePath,
              'scan',
              redactSecrets(file.content),
              'proven',
              indexRunId
            );
            completedFilePaths.add(file.relativePath);
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
        markAdapterCoverageSkipped(
          stmts.insertCoverage,
          indexRunId,
          adapter,
          adapterFiles.filter((file) => !completedFilePaths.has(file.relativePath)),
          `adapter failed: ${redactSecrets(message)}`
        );
        markUnstartedAdapterRunsSkipped(
          db,
          stmts.insertCoverage,
          indexRunId,
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
    currentStateSnapshot.restore();
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

function immutableIndexedFilesSnapshot(
  files: readonly ScannedFile[]
): readonly Readonly<ScannedFile>[] {
  const snapshot = files.map((file) => Object.freeze({ ...file }));
  return Object.freeze(snapshot);
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
  const storedErrorSummary = redactAdapterErrorSummary(errorSummary);
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
    ).run(status, storedErrorSummary, storedErrorSummary, adapterRunId);
    return;
  }
  db.prepare(
    "UPDATE adapter_runs SET status = ?, finished_at = datetime('now'), error_summary = ? WHERE id = ?"
  ).run(status, storedErrorSummary, adapterRunId);
}

function redactAdapterErrorSummary(errorSummary: string | null): string | null {
  return errorSummary === null ? null : redactSecrets(errorSummary);
}

function markUnstartedAdapterRunsSkipped(
  db: Db,
  insertCoverage: Statement,
  indexRunId: number,
  groups: readonly AdapterGroup[],
  adapterRunIds: ReadonlyMap<SemanticAdapter, number>,
  failedAdapterId: string
): void {
  const reason = `not run because ${failedAdapterId} failed`;
  for (const group of groups) {
    const adapterRunId = adapterRunIds.get(group.adapter);
    if (adapterRunId !== undefined) {
      updateAdapterRun(db, adapterRunId, 'skipped', reason);
    }
    markAdapterCoverageSkipped(insertCoverage, indexRunId, group.adapter, group.files, reason);
  }
}

function markAdapterCoverageSkipped(
  insertCoverage: Statement,
  indexRunId: number,
  adapter: SemanticAdapter,
  files: readonly ScannedFile[],
  reason: string
): void {
  for (const file of files) {
    insertCoverage.run(indexRunId, adapter.id, file.relativePath, file.language, 'skipped', reason);
  }
}

function failRunningAdapterRuns(db: Db, indexRunId: number, errorSummary: string): void {
  db.prepare(
    `UPDATE adapter_runs
     SET status = ?, finished_at = datetime('now'), error_summary = ?
     WHERE index_run_id = ? AND status = ?`
  ).run('failed', redactSecrets(errorSummary), indexRunId, 'running');
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
    insertEntityIfMissing: db.prepare(`
      INSERT OR IGNORE INTO entities (
        id, repo_id, kind, path, symbol, language_id, display_name, created_index_run_id, updated_index_run_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateEntityFreshness: db.prepare(`
      UPDATE entities
      SET updated_index_run_id = ?
      WHERE id = ?
    `),
    insertEntityVersion: db.prepare(`
      INSERT OR REPLACE INTO entity_versions (entity_id, index_run_id, content_hash, location_json, state)
      VALUES (?, ?, ?, ?, ?)
    `),
    insertEntityVersionIfMissing: db.prepare(`
      INSERT OR IGNORE INTO entity_versions (entity_id, index_run_id, content_hash, location_json, state)
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
  const entityId = persistEntityDescriptor(entity, ctx, 'explicit');
  if (entity.kind === 'symbol') {
    const meta = entity.metadata as { exported?: boolean } | undefined;
    if (entity.path) {
      const fileId = ctx.fileIdByPath.get(entity.path);
      if (fileId !== undefined) {
        const semanticId = `${entity.path}#${entity.symbolKind ?? ''}:${entity.symbol ?? ''}`;
        ctx.currentStateSnapshot.captureSymbol(fileId, semanticId);
        ctx.stmts.insertSymbol.run(
          fileId,
          entity.symbol ?? '',
          entity.symbolKind ?? '',
          meta?.exported ? 1 : 0,
          semanticId,
          ctx.indexRunId
        );
      }
    }
    ctx.counters.symbolsIndexed++;
  }
  ctx.canonicalEntityIds.add(entityId);
}

function persistEntityDescriptor(
  entity: EntityDescriptor | PendingEntity,
  ctx: PersistContext,
  mode: 'explicit' | 'placeholder'
): string {
  const metadata = 'metadata' in entity ? entity.metadata : undefined;
  const entityId = entityIdFromDescriptor(entity, metadata);
  const displayName = displayNameForEntityDescriptor(entity, entityId, metadata);
  const contentHashValue = entityVersionContentHash(entity, ctx, metadata);
  const locationJson = entityLocationJson(entity, metadata);

  ctx.currentStateSnapshot.captureEntity(entityId);
  const entityValues = [
    entityId,
    ctx.repoId,
    entity.kind,
    entity.path ?? null,
    entity.symbol ?? null,
    entity.languageId ?? null,
    displayName,
    ctx.indexRunId,
    ctx.indexRunId
  ] as const;
  const versionValues = [
    entityId,
    ctx.indexRunId,
    contentHashValue,
    locationJson,
    'active'
  ] as const;

  if (mode === 'placeholder') {
    ctx.stmts.insertEntityIfMissing.run(...entityValues);
    ctx.stmts.updateEntityFreshness.run(ctx.indexRunId, entityId);
    ctx.stmts.insertEntityVersionIfMissing.run(...versionValues);
  } else {
    ctx.stmts.upsertEntity.run(...entityValues);
    ctx.stmts.insertEntityVersion.run(...versionValues);
  }
  return entityId;
}

function entityVersionContentHash(
  entity: EntityDescriptor,
  ctx: PersistContext,
  metadata?: Readonly<Record<string, unknown>>
): string {
  const containingFileContentHash = entity.path
    ? ctx.fileContentHashByPath.get(entity.path) ?? ''
    : '';
  if (entity.kind === 'symbol') {
    return symbolEntityVersionContentHash(entity, containingFileContentHash);
  }
  return contentHash(
    entity.kind,
    entity.languageId ?? '',
    entity.path ?? '',
    entity.symbolKind ?? '',
    entity.symbol ?? '',
    entity.displayName ?? '',
    stableJson(metadata ?? {}),
    containingFileContentHash
  );
}

function symbolEntityVersionContentHash(
  entity: EntityDescriptor,
  containingFileContentHash: string
): string {
  return contentHash(
    entity.path ?? '',
    entity.symbolKind ?? '',
    entity.symbol ?? '',
    containingFileContentHash
  );
}

function entityLocationJson(
  entity: EntityDescriptor,
  metadata?: Readonly<Record<string, unknown>>
): string {
  return stableJson({
    kind: entity.kind,
    path: entity.path ?? null,
    symbol: entity.symbol ?? null,
    symbolKind: entity.symbolKind ?? null,
    languageId: entity.languageId ?? null,
    displayName: entity.displayName ?? null,
    metadata: metadata ?? {}
  });
}

function persistRelation(
  relation: PendingRelation,
  file: ScannedFile,
  ctx: PersistContext
): void {
  const sourceId = ensureRelationEndpointEntity(relation.source, ctx);
  const targetId = ensureRelationEndpointEntity(relation.target, ctx);
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
      const edgeKind = legacyEdgeKindFor(relation.kind);
      ctx.currentStateSnapshot.captureEdge(ctx.repoId, sourceFileId, edgeKind, targetPath);
      ctx.stmts.insertEdge.run(
        ctx.repoId,
        sourceFileId,
        targetFileId,
        edgeKind,
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
    insertFactProvenance: ctx.stmts.insertFactProvenance,
    currentStateSnapshot: ctx.currentStateSnapshot
  });
}

function ensureRelationEndpointEntity(entity: EntityDescriptor, ctx: PersistContext): string {
  const entityId = persistEntityDescriptor(entity, ctx, 'placeholder');
  ctx.canonicalEntityIds.add(entityId);
  return entityId;
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

const fileEntityIdKinds = new Set<EntityKind>([
  'file',
  'test',
  'doc',
  'config',
  'policy',
  'workflow',
  'resource',
  'contract'
]);

function entityIdFromDescriptor(
  d: EntityDescriptor,
  metadata?: Readonly<Record<string, unknown>>
): string {
  if (d.kind === 'symbol') {
    return `symbol:${d.languageId ?? ''}:${d.path ?? ''}#${d.symbolKind ?? ''}:${d.symbol ?? ''}`;
  }
  if (d.kind === 'external_entity') {
    return `external:${d.languageId ?? ''}:${descriptorIdentity(d, metadata)}`;
  }
  if (fileEntityIdKinds.has(d.kind)) {
    return fileEntityId(d.path ?? descriptorIdentity(d, metadata));
  }
  return `${d.kind}:${d.languageId ?? ''}:${descriptorIdentity(d, metadata)}`;
}

function displayNameForEntityDescriptor(
  d: EntityDescriptor,
  entityId: string = entityIdFromDescriptor(d),
  metadata?: Readonly<Record<string, unknown>>
): string {
  return firstNonEmpty(
    d.displayName,
    d.symbol,
    d.path,
    externalSpecifier(metadata),
    entityId
  );
}

function descriptorIdentity(
  d: EntityDescriptor,
  metadata?: Readonly<Record<string, unknown>>
): string {
  return firstNonEmpty(
    d.displayName,
    d.path,
    d.symbol,
    externalSpecifier(metadata),
    d.kind
  );
}

function externalSpecifier(metadata?: Readonly<Record<string, unknown>>): string | undefined {
  const specifier = metadata?.specifier;
  return typeof specifier === 'string' ? specifier : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }
  return '';
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortJsonValue(nestedValue)])
    );
  }
  return value;
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
  snippet: string
): string {
  const identity: unknown[] = [relationIdValue, evidence.file, snippet, evidence.confidence];
  if (snippet !== evidence.snippet) {
    identity.push({ rawSnippetHash: contentHash(evidence.snippet).slice(0, 20) });
  }
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
  currentStateSnapshot: CurrentStateSnapshot;
}): void {
  const id = relationId(input.kind, input.sourceEntityId, input.targetEntityId, input.provenance);

  input.currentStateSnapshot.captureRelation(id);
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
    const relationEvidenceIdValue = relationEvidenceId(id, evidence, redactedSnippet);
    input.currentStateSnapshot.captureRelationEvidence(relationEvidenceIdValue);
    input.insertRelationEvidence.run(
      relationEvidenceIdValue,
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
