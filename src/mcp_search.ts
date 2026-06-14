import { numericCompare, entityResourceUri } from './context_pack.js';
import { computeEmbedding, selectedEmbeddingModel } from './embeddings.js';
import type { EmbeddingResult } from './embeddings.js';
import { normalizeRepoRoot } from './security.js';
import {
  assertCurrentSchema,
  hasVecTable,
  isVectorExtensionLoaded,
  latestCompletedIndexRun,
  openDatabase,
  vecTableName
} from './store.js';
import type { ContextBudget, EntityRef } from './types.js';
import type { McpContext } from './mcp.js';
import {
  byteLength,
  compactEvidenceResource,
  evidenceSpanColumnSelect,
  mcpHasTable,
  withReadOnlyDb
} from './mcp_shared.js';
import type { CompactEvidenceResource, ExplainEvidenceRow } from './mcp_shared.js';

type SearchContextOptions = {
  query: string;
  k: number;
  includeEvidence: boolean;
  budget: ContextBudget | null;
  disabledStreams: ReadonlySet<SearchContextDisabledStream>;
  semanticEmbedding: EmbeddingResult | null;
};

type SearchContextDisabledStream = 'evidenceFts' | 'factsFts';

export type SearchContextForRepoOptions = {
  repoRoot: string;
  query: string;
  k?: number;
  includeEvidence?: boolean;
  budget?: ContextBudget | null;
  disabledStreams?: SearchContextDisabledStream[];
};

type SearchEntityRow = {
  entity_id: string;
  entity_kind: string;
  entity_path: string | null;
  entity_symbol: string | null;
  entity_language_id: string | null;
  entity_display_name: string;
  relation_kind_bucket: string | null;
  id_match: number;
  display_match: number;
  path_match: number;
  symbol_match: number;
  relation_match_count: number;
  evidence_match_count: number;
  fact_match_count: number;
};

type SearchEvidenceRow = ExplainEvidenceRow & {
  query_match: number;
};

type SearchRankSignals = {
  algorithm: 'rrf';
  keywordRank: number | null;
  relationRank: number | null;
  evidenceRank: number | null;
  semanticRank: number | null;
  graphProximityRank: number | null;
  rrfScore: number;
};

type RankedSearchEntity = {
  row: SearchEntityRow;
  score: number;
  rawScore: number;
  reasons: string[];
  rankSignals: SearchRankSignals;
};

type SearchRanking = {
  rankedRows: RankedSearchEntity[];
  matchedEntitiesLowerBound: number;
  truncated: boolean;
};

type SearchCandidate = {
  row: SearchEntityRow;
  keywordRank: number | null;
  relationRank: number | null;
  evidenceRank: number | null;
  semanticRank: number | null;
  graphProximityRank: number | null;
};

const searchContextEvidencePerEntity = 2;
const searchContextSnippetChars = 240;
const searchContextRrfK = 60;
const searchContextStreamLimit = 500;
const searchContextGraphSeedLimit = 25;
const searchContextSemanticOverFetchFactor = 5;
const searchContextSemanticOverFetchMin = 100;

type SearchContextBudgetPreset = {
  returnedBytesLimit: number;
  estimatedTokensLimit: number;
};

const searchContextBudgetPresets: Record<ContextBudget, SearchContextBudgetPreset> = {
  brief: { returnedBytesLimit: 5_000, estimatedTokensLimit: 1_250 },
  standard: { returnedBytesLimit: 12_000, estimatedTokensLimit: 3_000 },
  deep: { returnedBytesLimit: 30_000, estimatedTokensLimit: 7_500 }
};

export async function searchContextSemanticEmbedding(context: McpContext, query: string): Promise<EmbeddingResult | null> {
  const model = selectedEmbeddingModel();
  const hasEmbeddings = withReadOnlyDb(context, (db, repoId) => {
    assertCurrentSchema(db, 'parallax_search_context');
    if (!mcpHasTable(db, 'fact_embeddings')) return false;
    const row = db
      .prepare(`
        SELECT 1 AS one
        FROM fact_embeddings fe
        INNER JOIN facts f ON f.id = fe.fact_id
        INNER JOIN transactions t ON t.id = f.tx_id
        INNER JOIN entities e ON e.id = f.entity_id
        WHERE fe.model = ?
          AND (
            (
              t.archived = 0
              AND t.branch_id = (SELECT id FROM branches WHERE name = 'main')
            )
            OR EXISTS (
              SELECT 1
              FROM fact_provenance visibility_fp
              INNER JOIN transactions visibility_tx
                ON visibility_tx.id = visibility_fp.tx_id
              WHERE visibility_fp.fact_id = f.id
                AND visibility_fp.kind = 'supersedes'
                AND visibility_tx.archived = 0
                AND visibility_tx.branch_id = (SELECT id FROM branches WHERE name = 'main')
            )
          )
          AND f.op = 'assert'
          AND f.redacted = 0
          AND e.repo_id = ?
        LIMIT 1
      `)
      .get(model, repoId) as { one: number } | undefined;
    return row !== undefined;
  });
  if (!hasEmbeddings) return null;
  try {
    return await computeEmbedding(query);
  } catch {
    return null;
  }
}

export async function searchContextForRepo(options: SearchContextForRepoOptions): Promise<unknown> {
  const context = { repoRoot: normalizeRepoRoot(options.repoRoot) };
  const semanticEmbedding = await searchContextSemanticEmbedding(context, options.query);
  return searchContext(context, {
    query: options.query,
    k: options.k ?? 10,
    includeEvidence: options.includeEvidence ?? true,
    budget: options.budget ?? null,
    disabledStreams: new Set(options.disabledStreams ?? []),
    semanticEmbedding
  });
}

export function searchContext(context: McpContext, options: SearchContextOptions): unknown {
  const query = options.query.trim();
  if (!query) throw new Error('search query must not be empty');

  return withReadOnlyDb(context, (db, repoId) => {
    assertCurrentSchema(db, 'parallax_search_context');
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const likeQuery = `%${escapeLike(query)}%`;
    const ranking = searchRankedEntities(
      db,
      repoId,
      indexRunId,
      query,
      likeQuery,
      options.k,
      options.semanticEmbedding,
      options.disabledStreams
    );
    const selected = diversifyRankedRows(ranking.rankedRows, options.k).slice(0, options.k);
    const evidenceByEntity = new Map<string, CompactEvidenceResource[]>();
    const evidenceUris: string[] = [];

    if (options.includeEvidence) {
      for (const item of selected) {
        const evidenceRows = searchEvidenceRows(
          db,
          repoId,
          indexRunId,
          item.row.entity_id,
          likeQuery,
          searchContextEvidencePerEntity
        );
        const evidence = evidenceRows.map((row) => compactEvidenceResource(row, searchContextSnippetChars));
        evidenceByEntity.set(item.row.entity_id, evidence);
        evidenceUris.push(...evidence.map((row) => row.resourceUri));
      }
    }

    const unbudgetedResults = selected.map((item) => {
      const entity = entityFromSearchRow(item.row);
      return {
        entity,
        score: item.score,
        reasons: item.reasons,
        rankSignals: item.rankSignals,
        resourceUri: entityResourceUri(entity),
        evidence: evidenceByEntity.get(item.row.entity_id) ?? []
      };
    });
    const budgeted = applySearchContextBudget({
      query,
      indexRunId,
      results: unbudgetedResults,
      budget: options.budget,
      k: options.k,
      includeEvidence: options.includeEvidence,
      ranking,
      evidenceUris
    });

    return budgeted;
  });
}

function applySearchContextBudget(input: {
  query: string;
  indexRunId: number;
  results: Array<{
    entity: EntityRef;
    score: number;
    reasons: string[];
    rankSignals: SearchRankSignals;
    resourceUri: string;
    evidence: CompactEvidenceResource[];
  }>;
  budget: ContextBudget | null;
  k: number;
  includeEvidence: boolean;
  ranking: SearchRanking;
  evidenceUris: string[];
}): unknown {
  const preset = input.budget ? searchContextBudgetPresets[input.budget] : null;
  let results = input.results;
  let evidenceUris = input.evidenceUris;
  let omittedEntities = Math.max(input.ranking.matchedEntitiesLowerBound - results.length, 0);
  let omittedEvidence = 0;

  const build = (currentResults: typeof results, currentEvidenceUris: string[]) => ({
    query: input.query,
    indexRunId: input.indexRunId,
    results: currentResults,
    resources: {
      entities: currentResults.map((item) => item.resourceUri).sort(),
      evidence: [...new Set(currentEvidenceUris)].sort()
    },
    limits: {
      k: input.k,
      includeEvidence: input.includeEvidence,
      evidencePerEntity: searchContextEvidencePerEntity,
      snippetChars: searchContextSnippetChars,
      truncated: input.ranking.truncated || omittedEntities > 0,
      budget: input.budget,
      returnedBytes: 0,
      returnedBytesLimit: preset?.returnedBytesLimit ?? null,
      estimatedTokens: 0,
      estimatedTokensLimit: preset?.estimatedTokensLimit ?? null,
      budgetExceeded: false
    },
    counts: {
      returnedEntities: currentResults.length,
      matchedEntitiesLowerBound: input.ranking.matchedEntitiesLowerBound,
      evidence: new Set(currentEvidenceUris).size
    },
    omittedCounts: {
      entities: omittedEntities,
      evidence: omittedEvidence
    }
  });

  if (preset) {
    let current = build(results, evidenceUris);
    stabilizeSearchContextSize(current);
    let returnedBytes = current.limits.returnedBytes;
    while (returnedBytes > preset.returnedBytesLimit && results.some((item) => item.evidence.length > 0)) {
      for (let index = results.length - 1; index >= 0; index -= 1) {
        const item = results[index]!;
        if (item.evidence.length === 0) continue;
        omittedEvidence += item.evidence.length;
        results = results.map((result, resultIndex) =>
          resultIndex === index ? { ...result, evidence: [] } : result
        );
        break;
      }
      const keptEvidenceIds = new Set(results.flatMap((item) => item.evidence.map((evidence) => evidence.resourceUri)));
      evidenceUris = evidenceUris.filter((uri) => keptEvidenceIds.has(uri));
      current = build(results, evidenceUris);
      stabilizeSearchContextSize(current);
      returnedBytes = current.limits.returnedBytes;
    }
    while (returnedBytes > preset.returnedBytesLimit && results.length > 1) {
      const removed = results[results.length - 1]!;
      omittedEntities += 1;
      omittedEvidence += removed.evidence.length;
      results = results.slice(0, -1);
      const keptEvidenceIds = new Set(results.flatMap((item) => item.evidence.map((evidence) => evidence.resourceUri)));
      evidenceUris = evidenceUris.filter((uri) => keptEvidenceIds.has(uri));
      current = build(results, evidenceUris);
      stabilizeSearchContextSize(current);
      returnedBytes = current.limits.returnedBytes;
    }
  }

  const finalResult = build(results, evidenceUris);
  finalizeSearchContextSize(finalResult, preset);
  return finalResult;
}

function stabilizeSearchContextSize(result: { limits: { returnedBytes: number; estimatedTokens: number } }): void {
  for (let index = 0; index < 8; index += 1) {
    const returnedBytes = byteLength(JSON.stringify(result));
    const estimatedTokens = Math.ceil(returnedBytes / 4);
    if (result.limits.returnedBytes === returnedBytes && result.limits.estimatedTokens === estimatedTokens) {
      return;
    }
    result.limits.returnedBytes = returnedBytes;
    result.limits.estimatedTokens = estimatedTokens;
  }
}

function finalizeSearchContextSize(
  result: { limits: { returnedBytes: number; returnedBytesLimit: number | null; estimatedTokens: number; budgetExceeded: boolean } },
  preset: { returnedBytesLimit: number } | null
): void {
  stabilizeSearchContextSize(result);
  if (!preset) return;

  const withinBudgetRepresentationFits = result.limits.returnedBytes <= preset.returnedBytesLimit;
  if (withinBudgetRepresentationFits) return;

  result.limits.budgetExceeded = true;
  stabilizeSearchContextSize(result);
}

function diversifyRankedRows(rows: RankedSearchEntity[], k: number): RankedSearchEntity[] {
  if (k < 3 || rows.length <= 1) return rows;
  const buckets = new Map<string, RankedSearchEntity[]>();
  for (const row of rows) {
    const key = searchDiversityBucket(row.row);
    const bucket = buckets.get(key) ?? [];
    bucket.push(row);
    buckets.set(key, bucket);
  }
  if (buckets.size <= 1) return rows;

  const diversified: RankedSearchEntity[] = [];
  const queues = [...buckets.values()];
  while (diversified.length < rows.length) {
    let moved = false;
    for (const queue of queues) {
      const next = queue.shift();
      if (!next) continue;
      diversified.push(next);
      moved = true;
    }
    if (!moved) break;
  }
  return diversified;
}

function searchDiversityBucket(row: SearchEntityRow): string {
  return [
    pathPrefixBucket(row.entity_path),
    row.entity_kind,
    row.relation_kind_bucket ?? 'no-relation'
  ].join('|');
}

function pathPrefixBucket(filePath: string | null): string {
  if (!filePath) return '[no-path]';
  return filePath.split('/')[0] || filePath;
}

function searchRankedEntities(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  query: string,
  likeQuery: string,
  k: number,
  semanticEmbedding: EmbeddingResult | null,
  disabledStreams: ReadonlySet<SearchContextDisabledStream>
): SearchRanking {
  const keywordRows = searchKeywordEntityRows(db, repoId, indexRunId, query, likeQuery);
  const relationRows = searchRelationEntityRows(db, repoId, indexRunId, likeQuery);
  const evidenceRows = searchEvidenceEntityRows(db, repoId, indexRunId, query, likeQuery, disabledStreams);
  const factRows = searchFactEntityRows(db, repoId, indexRunId, query, disabledStreams);
  const contextEvidenceRows = [...evidenceRows, ...factRows];
  const semanticRows = semanticEmbedding
    ? searchSemanticEntityRows(db, repoId, indexRunId, semanticEmbedding)
    : [];
  const graphRows = searchGraphProximityEntityRows(
    db,
    repoId,
    indexRunId,
    [...keywordRows, ...relationRows, ...contextEvidenceRows, ...semanticRows],
    k
  );
  const candidates = new Map<string, SearchCandidate>();

  mergeSearchStream(candidates, keywordRows, 'keywordRank');
  mergeSearchStream(candidates, relationRows, 'relationRank');
  mergeSearchStream(candidates, contextEvidenceRows, 'evidenceRank');
  mergeSearchStream(candidates, semanticRows, 'semanticRank');
  mergeSearchStream(candidates, graphRows, 'graphProximityRank');

  const rankedRows = [...candidates.values()]
    .map((candidate) => {
      const rawScore = searchRawRrfScore(candidate);
      const rankSignals = searchRankSignals(candidate, rawScore);
      return {
        row: candidate.row,
        score: rankSignals.rrfScore,
        rawScore,
        reasons: searchEntityReasons(candidate),
        rankSignals
      };
    })
    .sort((left, right) =>
      numericCompare(right.rawScore, left.rawScore)
      || left.row.entity_display_name.localeCompare(right.row.entity_display_name)
      || left.row.entity_id.localeCompare(right.row.entity_id)
    );

  return {
    rankedRows,
    matchedEntitiesLowerBound: candidates.size,
    truncated: candidates.size > k
  };
}

function mergeSearchStream(
  candidates: Map<string, SearchCandidate>,
  rows: SearchEntityRow[],
  rankField: 'keywordRank' | 'relationRank' | 'evidenceRank' | 'semanticRank' | 'graphProximityRank'
): void {
  rows.forEach((row, index) => {
    const existing = candidates.get(row.entity_id);
    const candidate = existing ?? {
      row: { ...row },
      keywordRank: null,
      relationRank: null,
      evidenceRank: null,
      semanticRank: null,
      graphProximityRank: null
    };
    candidate.row.id_match = Math.max(candidate.row.id_match, row.id_match);
    candidate.row.display_match = Math.max(candidate.row.display_match, row.display_match);
    candidate.row.path_match = Math.max(candidate.row.path_match, row.path_match);
    candidate.row.symbol_match = Math.max(candidate.row.symbol_match, row.symbol_match);
    candidate.row.relation_match_count = Math.max(candidate.row.relation_match_count, row.relation_match_count);
    candidate.row.evidence_match_count = Math.max(candidate.row.evidence_match_count, row.evidence_match_count);
    candidate.row.fact_match_count = Math.max(candidate.row.fact_match_count, row.fact_match_count);
    candidate.row.relation_kind_bucket = candidate.row.relation_kind_bucket ?? row.relation_kind_bucket;
    candidate[rankField] = candidate[rankField] === null ? index + 1 : Math.min(candidate[rankField], index + 1);
    candidates.set(row.entity_id, candidate);
  });
}

function searchRawRrfScore(candidate: SearchCandidate): number {
  return reciprocalRank(candidate.keywordRank)
    + reciprocalRank(candidate.relationRank)
    + reciprocalRank(candidate.evidenceRank)
    + reciprocalRank(candidate.semanticRank)
    + reciprocalRank(candidate.graphProximityRank);
}

function searchRankSignals(candidate: SearchCandidate, rawScore: number): SearchRankSignals {
  return {
    algorithm: 'rrf',
    keywordRank: candidate.keywordRank,
    relationRank: candidate.relationRank,
    evidenceRank: candidate.evidenceRank,
    semanticRank: candidate.semanticRank,
    graphProximityRank: candidate.graphProximityRank,
    rrfScore: Number(rawScore.toFixed(8))
  };
}

function reciprocalRank(rank: number | null): number {
  return rank === null ? 0 : 1 / (searchContextRrfK + rank);
}

function searchKeywordEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  query: string,
  likeQuery: string
): SearchEntityRow[] {
  const ftsRows = searchFtsKeywordEntityRows(db, repoId, indexRunId, query, likeQuery);
  if (ftsRows.length > 0) return ftsRows;
  return searchLikeKeywordEntityRows(db, repoId, indexRunId, likeQuery);
}

function searchFtsKeywordEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  query: string,
  likeQuery: string
): SearchEntityRow[] {
  if (!mcpHasTable(db, 'search_entities_fts')) return [];
  const ftsQuery = ftsMatchExpression(query);
  if (!ftsQuery) return [];
  try {
    return db
      .prepare(`
        SELECT
          entities.id AS entity_id,
          entities.kind AS entity_kind,
          entities.path AS entity_path,
          entities.symbol AS entity_symbol,
          entities.language_id AS entity_language_id,
          entities.display_name AS entity_display_name,
          NULL AS relation_kind_bucket,
          CASE WHEN entities.id LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS id_match,
          CASE WHEN entities.display_name LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS display_match,
          CASE WHEN COALESCE(entities.path, '') LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS path_match,
          CASE WHEN COALESCE(entities.symbol, '') LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS symbol_match,
          0 AS relation_match_count,
          0 AS evidence_match_count,
          0 AS fact_match_count
        FROM search_entities_fts fts
        INNER JOIN entities
          ON entities.id = fts.entity_id
         AND entities.repo_id = ?
         AND entities.updated_index_run_id = ?
        WHERE search_entities_fts MATCH ?
        ORDER BY bm25(search_entities_fts), entities.display_name, entities.id
        LIMIT ?
      `)
      .all(
        likeQuery,
        likeQuery,
        likeQuery,
        likeQuery,
        repoId,
        indexRunId,
        ftsQuery,
        searchContextStreamLimit
      ) as SearchEntityRow[];
  } catch {
    return [];
  }
}

function searchLikeKeywordEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  likeQuery: string
): SearchEntityRow[] {
  return db
    .prepare(`
      SELECT
        entities.id AS entity_id,
        entities.kind AS entity_kind,
        entities.path AS entity_path,
        entities.symbol AS entity_symbol,
        entities.language_id AS entity_language_id,
        entities.display_name AS entity_display_name,
        NULL AS relation_kind_bucket,
        CASE WHEN entities.id LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS id_match,
        CASE WHEN entities.display_name LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS display_match,
        CASE WHEN COALESCE(entities.path, '') LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS path_match,
        CASE WHEN COALESCE(entities.symbol, '') LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS symbol_match,
        0 AS relation_match_count,
        0 AS evidence_match_count,
        0 AS fact_match_count
      FROM entities
      WHERE entities.repo_id = ?
        AND entities.updated_index_run_id = ?
        AND (
          entities.id LIKE ? ESCAPE '\\'
          OR entities.display_name LIKE ? ESCAPE '\\'
          OR COALESCE(entities.path, '') LIKE ? ESCAPE '\\'
          OR COALESCE(entities.symbol, '') LIKE ? ESCAPE '\\'
        )
      ORDER BY
        id_match DESC,
        path_match DESC,
        display_match DESC,
        symbol_match DESC,
        relation_match_count DESC,
        evidence_match_count DESC,
        CASE WHEN entities.kind = 'file' THEN 1 ELSE 0 END DESC,
        entities.display_name,
        entities.id
      LIMIT ?
    `)
    .all(
      likeQuery,
      likeQuery,
      likeQuery,
      likeQuery,
      repoId,
      indexRunId,
      likeQuery,
      likeQuery,
      likeQuery,
      likeQuery,
      searchContextStreamLimit
    ) as SearchEntityRow[];
}

function ftsMatchExpression(query: string): string | null {
  if (/[\\%_./:]/.test(query)) return null;
  const terms = query
    .toLocaleLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((term) => term.length > 0)
    .slice(0, 8);
  if (!terms || terms.length === 0) return null;
  return terms.map((term) => `${term}*`).join(' AND ');
}

function searchRelationEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  likeQuery: string
): SearchEntityRow[] {
  return db
    .prepare(`
      SELECT
        entities.id AS entity_id,
        entities.kind AS entity_kind,
        entities.path AS entity_path,
        entities.symbol AS entity_symbol,
        entities.language_id AS entity_language_id,
        entities.display_name AS entity_display_name,
        min(relations.kind) AS relation_kind_bucket,
        0 AS id_match,
        0 AS display_match,
        0 AS path_match,
        0 AS symbol_match,
        count(relations.id) AS relation_match_count,
        0 AS evidence_match_count,
        0 AS fact_match_count
      FROM entities
      INNER JOIN relations
        ON relations.repo_id = entities.repo_id
       AND relations.index_run_id = entities.updated_index_run_id
       AND (relations.source_entity_id = entities.id OR relations.target_entity_id = entities.id)
       AND (relations.kind LIKE ? ESCAPE '\\' OR relations.provenance LIKE ? ESCAPE '\\')
      WHERE entities.repo_id = ?
        AND entities.updated_index_run_id = ?
      GROUP BY entities.id
      ORDER BY relation_match_count DESC, entities.display_name, entities.id
      LIMIT ?
    `)
    .all(likeQuery, likeQuery, repoId, indexRunId, searchContextStreamLimit) as SearchEntityRow[];
}

function searchEvidenceEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  query: string,
  likeQuery: string,
  disabledStreams: ReadonlySet<SearchContextDisabledStream>
): SearchEntityRow[] {
  const ftsRows = disabledStreams.has('evidenceFts')
    ? []
    : searchEvidenceFtsEntityRows(db, repoId, indexRunId, query);
  if (ftsRows.length > 0) return ftsRows;
  return searchEvidenceLikeEntityRows(db, repoId, indexRunId, likeQuery);
}

function searchEvidenceFtsEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  query: string
): SearchEntityRow[] {
  if (!mcpHasTable(db, 'search_relation_evidence_fts')) return [];
  const ftsQuery = ftsMatchExpression(query);
  if (!ftsQuery) return [];
  try {
    return db
      .prepare(`
        WITH matches AS (
          SELECT evidence_id
          FROM search_relation_evidence_fts
          WHERE search_relation_evidence_fts MATCH ?
        )
        SELECT
          entities.id AS entity_id,
          entities.kind AS entity_kind,
          entities.path AS entity_path,
          entities.symbol AS entity_symbol,
          entities.language_id AS entity_language_id,
          entities.display_name AS entity_display_name,
          min(relations.kind) AS relation_kind_bucket,
          0 AS id_match,
          0 AS display_match,
          0 AS path_match,
          0 AS symbol_match,
          0 AS relation_match_count,
          count(DISTINCT evidence.id) AS evidence_match_count,
          0 AS fact_match_count
        FROM matches
        INNER JOIN relation_evidence evidence
          ON evidence.id = matches.evidence_id
        INNER JOIN relations
          ON relations.id = evidence.relation_id
         AND relations.repo_id = evidence.repo_id
         AND relations.index_run_id = evidence.index_run_id
        INNER JOIN entities
          ON entities.repo_id = relations.repo_id
         AND entities.updated_index_run_id = relations.index_run_id
         AND (entities.id = relations.source_entity_id OR entities.id = relations.target_entity_id)
        WHERE evidence.repo_id = ?
          AND evidence.index_run_id = ?
        GROUP BY entities.id
        ORDER BY evidence_match_count DESC, entities.display_name, entities.id
        LIMIT ?
      `)
      .all(ftsQuery, repoId, indexRunId, searchContextStreamLimit) as SearchEntityRow[];
  } catch {
    return [];
  }
}

function searchEvidenceLikeEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  likeQuery: string
): SearchEntityRow[] {
  return db
    .prepare(`
      SELECT
        entities.id AS entity_id,
        entities.kind AS entity_kind,
        entities.path AS entity_path,
        entities.symbol AS entity_symbol,
        entities.language_id AS entity_language_id,
        entities.display_name AS entity_display_name,
        min(relations.kind) AS relation_kind_bucket,
        0 AS id_match,
        0 AS display_match,
        0 AS path_match,
        0 AS symbol_match,
        0 AS relation_match_count,
        count(evidence.id) AS evidence_match_count,
        0 AS fact_match_count
      FROM entities
      INNER JOIN relations
        ON relations.repo_id = entities.repo_id
       AND relations.index_run_id = entities.updated_index_run_id
       AND (relations.source_entity_id = entities.id OR relations.target_entity_id = entities.id)
      INNER JOIN relation_evidence evidence
        ON evidence.relation_id = relations.id
       AND evidence.repo_id = relations.repo_id
       AND evidence.index_run_id = relations.index_run_id
       AND (
         evidence.file_path LIKE ? ESCAPE '\\'
         OR evidence.kind LIKE ? ESCAPE '\\'
         OR evidence.snippet LIKE ? ESCAPE '\\'
       )
      WHERE entities.repo_id = ?
        AND entities.updated_index_run_id = ?
      GROUP BY entities.id
      ORDER BY evidence_match_count DESC, entities.display_name, entities.id
      LIMIT ?
    `)
    .all(likeQuery, likeQuery, likeQuery, repoId, indexRunId, searchContextStreamLimit) as SearchEntityRow[];
}

function searchFactEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  query: string,
  disabledStreams: ReadonlySet<SearchContextDisabledStream>
): SearchEntityRow[] {
  if (disabledStreams.has('factsFts')) return [];
  if (!mcpHasTable(db, 'search_facts_fts')) return [];
  const ftsQuery = ftsMatchExpression(query);
  if (!ftsQuery) return [];
  try {
    return db
      .prepare(`
        WITH matches AS (
          SELECT fact_id
          FROM search_facts_fts
          WHERE search_facts_fts MATCH ?
        )
        SELECT
          entities.id AS entity_id,
          entities.kind AS entity_kind,
          entities.path AS entity_path,
          entities.symbol AS entity_symbol,
          entities.language_id AS entity_language_id,
          entities.display_name AS entity_display_name,
          NULL AS relation_kind_bucket,
          0 AS id_match,
          0 AS display_match,
          0 AS path_match,
          0 AS symbol_match,
          0 AS relation_match_count,
          0 AS evidence_match_count,
          count(DISTINCT facts.id) AS fact_match_count
        FROM matches
        INNER JOIN facts
          ON facts.id = matches.fact_id
        INNER JOIN transactions
          ON transactions.id = facts.tx_id
        INNER JOIN entities
          ON entities.id = facts.entity_id
         AND entities.repo_id = ?
         AND entities.updated_index_run_id = ?
        WHERE facts.op = 'assert'
          AND facts.redacted = 0
          AND (
            (
              transactions.archived = 0
              AND transactions.branch_id = (SELECT id FROM branches WHERE name = 'main')
            )
            OR EXISTS (
              SELECT 1
              FROM fact_provenance visibility_fp
              INNER JOIN transactions visibility_tx
                ON visibility_tx.id = visibility_fp.tx_id
              WHERE visibility_fp.fact_id = facts.id
                AND visibility_fp.kind = 'supersedes'
                AND visibility_tx.archived = 0
                AND visibility_tx.branch_id = (SELECT id FROM branches WHERE name = 'main')
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM fact_provenance supersession_fp
            INNER JOIN facts superseding_fact
              ON superseding_fact.id = supersession_fp.fact_id
            INNER JOIN transactions supersession_tx
              ON supersession_tx.id = supersession_fp.tx_id
            WHERE supersession_fp.source_fact_id = facts.id
              AND supersession_fp.kind = 'supersedes'
              AND superseding_fact.op = 'assert'
              AND supersession_tx.archived = 0
              AND supersession_tx.branch_id = (SELECT id FROM branches WHERE name = 'main')
          )
        GROUP BY entities.id
        ORDER BY fact_match_count DESC, entities.display_name, entities.id
        LIMIT ?
      `)
      .all(ftsQuery, repoId, indexRunId, searchContextStreamLimit) as SearchEntityRow[];
  } catch {
    return [];
  }
}

function searchSemanticEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  queryEmbedding: EmbeddingResult
): SearchEntityRow[] {
  const annRows = searchSemanticEntityRowsAnn(db, repoId, indexRunId, queryEmbedding);
  if (annRows !== null && annRows.length > 0) return annRows;
  return searchSemanticEntityRowsBruteForce(db, repoId, indexRunId, queryEmbedding);
}

function searchSemanticEntityRowsAnn(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  queryEmbedding: EmbeddingResult
): SearchEntityRow[] | null {
  if (!isVectorExtensionLoaded(db) || !hasVecTable(db, queryEmbedding.model)) return null;
  const tableName = vecTableName(queryEmbedding.model);
  const overFetch = Math.max(
    searchContextStreamLimit * searchContextSemanticOverFetchFactor,
    searchContextSemanticOverFetchMin
  );
  try {
    const rows = db
      .prepare(`
        WITH ranked AS (
          SELECT fact_id, distance
          FROM ${tableName}
          WHERE embedding MATCH vec_int8(?) AND k = ?
        )
        SELECT
          entities.id AS entity_id,
          entities.kind AS entity_kind,
          entities.path AS entity_path,
          entities.symbol AS entity_symbol,
          entities.language_id AS entity_language_id,
          entities.display_name AS entity_display_name,
          NULL AS relation_kind_bucket,
          min(ranked.distance) AS distance
        FROM ranked
        INNER JOIN facts
          ON facts.id = ranked.fact_id
        INNER JOIN transactions
          ON transactions.id = facts.tx_id
        INNER JOIN entities
          ON entities.id = facts.entity_id
         AND entities.repo_id = ?
         AND entities.updated_index_run_id = ?
        WHERE facts.op = 'assert'
          AND facts.redacted = 0
          AND (
            (
              transactions.archived = 0
              AND transactions.branch_id = (SELECT id FROM branches WHERE name = 'main')
            )
            OR EXISTS (
              SELECT 1
              FROM fact_provenance visibility_fp
              INNER JOIN transactions visibility_tx
                ON visibility_tx.id = visibility_fp.tx_id
              WHERE visibility_fp.fact_id = facts.id
                AND visibility_fp.kind = 'supersedes'
                AND visibility_tx.archived = 0
                AND visibility_tx.branch_id = (SELECT id FROM branches WHERE name = 'main')
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM fact_provenance supersession_fp
            INNER JOIN facts superseding_fact
              ON superseding_fact.id = supersession_fp.fact_id
            INNER JOIN transactions supersession_tx
              ON supersession_tx.id = supersession_fp.tx_id
            WHERE supersession_fp.source_fact_id = facts.id
              AND supersession_fp.kind = 'supersedes'
              AND superseding_fact.op = 'assert'
              AND supersession_tx.archived = 0
              AND supersession_tx.branch_id = (SELECT id FROM branches WHERE name = 'main')
          )
        GROUP BY entities.id
        ORDER BY distance ASC, entities.display_name, entities.id
        LIMIT ?
      `)
      .all(queryEmbedding.vector, overFetch, repoId, indexRunId, searchContextStreamLimit) as Array<
        SearchEntityRow & { distance: number }
      >;
    return rows.map((row) => ({
      entity_id: row.entity_id,
      entity_kind: row.entity_kind,
      entity_path: row.entity_path,
      entity_symbol: row.entity_symbol,
      entity_language_id: row.entity_language_id,
      entity_display_name: row.entity_display_name,
      relation_kind_bucket: null,
      id_match: 0,
      display_match: 0,
      path_match: 0,
      symbol_match: 0,
      relation_match_count: 0,
      evidence_match_count: 0,
      fact_match_count: 0
    }));
  } catch {
    return null;
  }
}

function searchSemanticEntityRowsBruteForce(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  queryEmbedding: EmbeddingResult
): SearchEntityRow[] {
  if (!mcpHasTable(db, 'fact_embeddings')) return [];
  const rows = db
    .prepare(`
      SELECT
        entities.id AS entity_id,
        entities.kind AS entity_kind,
        entities.path AS entity_path,
        entities.symbol AS entity_symbol,
        entities.language_id AS entity_language_id,
        entities.display_name AS entity_display_name,
        NULL AS relation_kind_bucket,
        fact_embeddings.vector AS vector
      FROM fact_embeddings
      INNER JOIN facts
        ON facts.id = fact_embeddings.fact_id
      INNER JOIN transactions
        ON transactions.id = facts.tx_id
      INNER JOIN entities
        ON entities.id = facts.entity_id
       AND entities.repo_id = ?
       AND entities.updated_index_run_id = ?
      WHERE fact_embeddings.model = ?
        AND fact_embeddings.dim = ?
        AND facts.op = 'assert'
        AND facts.redacted = 0
        AND (
          (
            transactions.archived = 0
            AND transactions.branch_id = (SELECT id FROM branches WHERE name = 'main')
          )
          OR EXISTS (
            SELECT 1
            FROM fact_provenance visibility_fp
            INNER JOIN transactions visibility_tx
              ON visibility_tx.id = visibility_fp.tx_id
            WHERE visibility_fp.fact_id = facts.id
              AND visibility_fp.kind = 'supersedes'
              AND visibility_tx.archived = 0
              AND visibility_tx.branch_id = (SELECT id FROM branches WHERE name = 'main')
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM fact_provenance supersession_fp
          INNER JOIN facts superseding_fact
            ON superseding_fact.id = supersession_fp.fact_id
          INNER JOIN transactions supersession_tx
            ON supersession_tx.id = supersession_fp.tx_id
          WHERE supersession_fp.source_fact_id = facts.id
            AND supersession_fp.kind = 'supersedes'
            AND superseding_fact.op = 'assert'
            AND supersession_tx.archived = 0
            AND supersession_tx.branch_id = (SELECT id FROM branches WHERE name = 'main')
        )
    `)
    .all(repoId, indexRunId, queryEmbedding.model, queryEmbedding.dim) as Array<
      SearchEntityRow & { vector: Buffer }
    >;

  const queryVector = int8Vector(queryEmbedding.vector);
  const bestByEntity = new Map<string, { row: SearchEntityRow; score: number }>();
  for (const row of rows) {
    const score = int8DotScore(queryVector, int8Vector(row.vector));
    const existing = bestByEntity.get(row.entity_id);
    if (!existing || score > existing.score) {
      bestByEntity.set(row.entity_id, {
        row: {
          entity_id: row.entity_id,
          entity_kind: row.entity_kind,
          entity_path: row.entity_path,
          entity_symbol: row.entity_symbol,
          entity_language_id: row.entity_language_id,
          entity_display_name: row.entity_display_name,
          relation_kind_bucket: null,
          id_match: 0,
          display_match: 0,
          path_match: 0,
          symbol_match: 0,
          relation_match_count: 0,
          evidence_match_count: 0,
          fact_match_count: 0
        },
        score
      });
    }
  }

  return [...bestByEntity.values()]
    .sort((left, right) =>
      numericCompare(right.score, left.score)
      || left.row.entity_display_name.localeCompare(right.row.entity_display_name)
      || left.row.entity_id.localeCompare(right.row.entity_id)
    )
    .slice(0, searchContextStreamLimit)
    .map((entry) => entry.row);
}

function searchGraphProximityEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  seedRows: SearchEntityRow[],
  k: number
): SearchEntityRow[] {
  const seedIds = [...new Set(seedRows.map((row) => row.entity_id))].slice(0, searchContextGraphSeedLimit);
  if (seedIds.length === 0) return [];

  const best = new Map<string, { row: SearchEntityRow; seedRank: number; relationCount: number }>();
  const neighborRows = db
    .prepare(`
      SELECT
        relations.source_entity_id AS source_id,
        relations.target_entity_id AS target_id,
        neighbor.id AS entity_id,
        neighbor.kind AS entity_kind,
        neighbor.path AS entity_path,
        neighbor.symbol AS entity_symbol,
        neighbor.language_id AS entity_language_id,
        neighbor.display_name AS entity_display_name,
        min(relations.kind) AS relation_kind_bucket,
        count(relations.id) AS relation_match_count,
        0 AS evidence_match_count,
        0 AS fact_match_count
      FROM relations
      INNER JOIN entities seed
        ON seed.repo_id = relations.repo_id
       AND seed.updated_index_run_id = relations.index_run_id
       AND (seed.id = relations.source_entity_id OR seed.id = relations.target_entity_id)
      INNER JOIN entities neighbor
        ON neighbor.repo_id = relations.repo_id
       AND neighbor.updated_index_run_id = relations.index_run_id
       AND neighbor.id = CASE
         WHEN seed.id = relations.source_entity_id THEN relations.target_entity_id
         ELSE relations.source_entity_id
       END
      WHERE relations.repo_id = ?
        AND relations.index_run_id = ?
        AND seed.id = ?
        AND neighbor.id <> seed.id
      GROUP BY neighbor.id
      ORDER BY relation_match_count DESC, neighbor.display_name, neighbor.id
      LIMIT ?
    `);

  seedIds.forEach((seedId, index) => {
    const rows = neighborRows.all(repoId, indexRunId, seedId, Math.max(k * 3, 10)) as Array<SearchEntityRow>;
    for (const row of rows) {
      if (seedIds.includes(row.entity_id)) continue;
      const existing = best.get(row.entity_id);
      const relationCount = row.relation_match_count;
      if (
        !existing
        || index < existing.seedRank
        || (index === existing.seedRank && relationCount > existing.relationCount)
      ) {
        best.set(row.entity_id, {
          row: {
            ...row,
            id_match: 0,
            display_match: 0,
            path_match: 0,
            symbol_match: 0,
            evidence_match_count: 0,
            fact_match_count: 0
          },
          seedRank: index,
          relationCount
        });
      }
    }
  });

  return [...best.values()]
    .sort((left, right) =>
      numericCompare(left.seedRank, right.seedRank)
      || numericCompare(right.relationCount, left.relationCount)
      || left.row.entity_display_name.localeCompare(right.row.entity_display_name)
      || left.row.entity_id.localeCompare(right.row.entity_id)
    )
    .slice(0, searchContextStreamLimit)
    .map((entry) => entry.row);
}

function int8Vector(value: Buffer): Int8Array {
  return new Int8Array(value.buffer, value.byteOffset, value.byteLength);
}

function int8DotScore(left: Int8Array, right: Int8Array): number {
  const len = Math.min(left.length, right.length);
  let total = 0;
  for (let index = 0; index < len; index += 1) {
    total += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return total;
}

function searchEvidenceRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  entityId: string,
  likeQuery: string,
  limit: number
): SearchEvidenceRow[] {
  if (limit <= 0) return [];
  const spanColumns = evidenceSpanColumnSelect(db, 'evidence');
  return db
    .prepare(`
      SELECT
        evidence.id AS evidence_id,
        evidence.relation_id AS relation_id,
        evidence.file_path AS evidence_file_path,
        evidence.kind AS evidence_kind,
        evidence.snippet AS evidence_snippet,
        evidence.confidence AS evidence_confidence,
        ${spanColumns},
        CASE
          WHEN evidence.file_path LIKE ? ESCAPE '\\'
            OR evidence.kind LIKE ? ESCAPE '\\'
            OR evidence.snippet LIKE ? ESCAPE '\\'
          THEN 1 ELSE 0
        END AS query_match
      FROM relation_evidence evidence
      INNER JOIN relations
        ON relations.id = evidence.relation_id
       AND relations.repo_id = evidence.repo_id
       AND relations.index_run_id = evidence.index_run_id
      WHERE evidence.repo_id = ?
        AND evidence.index_run_id = ?
        AND (relations.source_entity_id = ? OR relations.target_entity_id = ?)
      ORDER BY query_match DESC, evidence.file_path, evidence.kind, evidence.id
      LIMIT ?
    `)
    .all(likeQuery, likeQuery, likeQuery, repoId, indexRunId, entityId, entityId, limit) as SearchEvidenceRow[];
}

function searchEntityReasons(candidate: SearchCandidate): string[] {
  const row = candidate.row;
  const reasons: string[] = [];
  if (candidate.keywordRank !== null) reasons.push('keyword');
  if (row.id_match > 0) reasons.push('entity-id');
  if (row.path_match > 0) reasons.push('path');
  if (row.display_match > 0) reasons.push('display-name');
  if (row.symbol_match > 0) reasons.push('symbol');
  if (row.relation_match_count > 0) reasons.push(`relations:${row.relation_match_count}`);
  if (row.evidence_match_count > 0) reasons.push(`evidence:${row.evidence_match_count}`);
  if (row.fact_match_count > 0) reasons.push(`facts:${row.fact_match_count}`);
  if (candidate.semanticRank !== null) reasons.push('semantic');
  if (candidate.graphProximityRank !== null) reasons.push('graph-proximity');
  return reasons;
}

function entityFromSearchRow(row: SearchEntityRow): EntityRef {
  return {
    id: row.entity_id,
    kind: row.entity_kind as EntityRef['kind'],
    ...(row.entity_path !== null ? { path: row.entity_path } : {}),
    ...(row.entity_symbol !== null ? { symbol: row.entity_symbol } : {}),
    ...(row.entity_language_id !== null ? { languageId: row.entity_language_id } : {}),
    displayName: row.entity_display_name
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

