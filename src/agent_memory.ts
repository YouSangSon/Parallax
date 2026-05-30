import { computeEmbedding, computeEmbeddingSync } from './embeddings.js';
import type { EmbeddingResult } from './embeddings.js';
import { envValue } from './branding.js';
import {
  assertCurrentSchema,
  contentHash,
  ensureVecTable,
  getRepoId,
  hasVecTable,
  isVectorExtensionLoaded,
  openDatabase,
  vecTableName
} from './store.js';
import type { Db } from './store.js';
import { normalizeRepoRoot, redactSecrets } from './security.js';
import type { Lifecycle } from './types.js';

export type RememberValue = string | number | boolean | null | RememberValue[] | { [key: string]: RememberValue };

export interface RememberInput {
  entity: string;
  attribute: string;
  value: RememberValue;
  evidenceFactIds?: string[];
  supersedesFactIds?: string[];
  branch?: string;
  agent?: string;
  op?: 'assert' | 'retract';
}

export interface RememberResult {
  factId: string;
  txId: string;
}

export interface RecallInput {
  query?: string;
  entity?: string;
  attribute?: string;
  branch?: string;
  k?: number;
  asOfTx?: string;
  currentOnly?: boolean;
  semantic?: boolean;
}

export interface RecalledFact {
  id: string;
  entityId: string;
  attribute: string;
  value: RememberValue | '[REDACTED]';
  op: 'assert' | 'retract';
  txId: string;
  ts: string;
}

export interface RecallResult {
  facts: RecalledFact[];
}

export interface BranchInput {
  name: string;
  from?: string;
}

export interface BranchResult {
  branchId: string;
  headTxId: string | null;
}

export interface MergeBranchInput {
  target: string;
  source: string;
  agent?: string;
}

export interface MergeBranchResult {
  mergeTxId: string;
  targetBranchId: string;
  sourceBranchId: string;
  previousTargetHead: string | null;
  sourceHead: string;
}

export interface TraceInput {
  factId: string;
  depth?: number;
}

export interface TraceEdge {
  factId: string;
  sourceFactId: string;
  kind: string;
}

export interface TraceResult {
  chain: RecalledFact[];
  edges: TraceEdge[];
}

const MAX_TRACE_DEPTH = 20;
const MAX_RECALL_K = 100;

interface BranchRow {
  id: string;
  name: string;
  head_tx_id: string | null;
}

interface FactRow {
  id: string;
  entity_id: string;
  attribute: string;
  value_blob: string;
  op: 'assert' | 'retract';
  tx_id: string;
  redacted: number;
  ts: string;
}

interface TraceSourceRow extends FactRow {
  edge_fact_id: string;
  edge_source_fact_id: string;
  edge_kind: string;
}

function loadBranch(db: Db, name: string): BranchRow {
  const row = db
    .prepare('SELECT id, name, head_tx_id FROM branches WHERE name = ?')
    .get(name) as BranchRow | undefined;
  if (!row) {
    throw new Error(`branch not found: ${name}`);
  }
  return row;
}

function ensureAttributeDef(db: Db, attribute: string): void {
  const existing = db.prepare('SELECT name FROM attribute_defs WHERE name = ?').get(attribute);
  if (existing) {
    return;
  }
  db.prepare(
    "INSERT INTO attribute_defs (name, value_type, is_code_relation, description) VALUES (?, 'json', 0, '')"
  ).run(attribute);
}

function uniqueFactIds(ids: string[] | undefined): string[] {
  return [...new Set((ids ?? []).filter((id) => id.length > 0))];
}

function assertFactsExist(db: Db, ids: string[]): void {
  const exists = db.prepare('SELECT id FROM facts WHERE id = ?');
  for (const id of ids) {
    if (!exists.get(id)) {
      throw new Error(`fact not found: ${id}`);
    }
  }
}

function notSupersededSql(factAlias: string, supersessionTxScopeSql: string): string {
  return `NOT EXISTS (
    SELECT 1
    FROM fact_provenance supersession_fp
    INNER JOIN facts superseding_fact ON superseding_fact.id = supersession_fp.fact_id
    INNER JOIN transactions supersession_tx ON supersession_fp.tx_id = supersession_tx.id
    WHERE supersession_fp.source_fact_id = ${factAlias}.id
      AND supersession_fp.kind = 'supersedes'
      AND superseding_fact.op = 'assert'
      AND supersession_tx.archived = 0
      AND ${supersessionTxScopeSql}
  )`;
}

function scopedFactVisibilitySql(
  factAlias: string,
  ownTxScopeSql: string,
  supersessionEdgeTxScopeSql: string
): string {
  return `((${ownTxScopeSql}) OR EXISTS (
    SELECT 1
    FROM fact_provenance visibility_fp
    INNER JOIN transactions visibility_tx ON visibility_fp.tx_id = visibility_tx.id
    WHERE visibility_fp.fact_id = ${factAlias}.id
      AND visibility_fp.kind = 'supersedes'
      AND visibility_tx.archived = 0
      AND ${supersessionEdgeTxScopeSql}
  ))`;
}

function scopedFactVisibleTsSql(
  factAlias: string,
  factTxAlias: string,
  ownTxScopeSql: string,
  supersessionEdgeTxScopeSql: string
): string {
  return `COALESCE(
    (
      SELECT MAX(visibility_tx.ts)
      FROM fact_provenance visibility_fp
      INNER JOIN transactions visibility_tx ON visibility_fp.tx_id = visibility_tx.id
      WHERE visibility_fp.fact_id = ${factAlias}.id
        AND visibility_fp.kind = 'supersedes'
        AND visibility_tx.archived = 0
        AND ${supersessionEdgeTxScopeSql}
    ),
    CASE WHEN ${ownTxScopeSql} THEN ${factTxAlias}.ts END
  )`;
}

function currentOnlyNotShadowedSql(
  factAlias: string,
  visibleTsSql: string,
  newerTxScopeSql: string
): string {
  return `NOT EXISTS (
    SELECT 1
    FROM facts newer_fact
    INNER JOIN transactions newer_tx ON newer_fact.tx_id = newer_tx.id
    WHERE newer_fact.entity_id = ${factAlias}.entity_id
      AND newer_fact.attribute = ${factAlias}.attribute
      AND newer_fact.value_blob = ${factAlias}.value_blob
      AND newer_tx.archived = 0
      AND (
        newer_tx.ts > (${visibleTsSql})
        OR (newer_tx.ts = (${visibleTsSql}) AND newer_fact.id < ${factAlias}.id)
      )
      AND ${newerTxScopeSql}
  )`;
}

function decodeValue(row: FactRow): RememberValue | '[REDACTED]' {
  if (row.redacted === 1) {
    return '[REDACTED]';
  }
  try {
    return JSON.parse(row.value_blob) as RememberValue;
  } catch {
    return row.value_blob;
  }
}

function rowToRecalledFact(row: FactRow): RecalledFact {
  return {
    id: row.id,
    entityId: row.entity_id,
    attribute: row.attribute,
    value: decodeValue(row),
    op: row.op,
    txId: row.tx_id,
    ts: row.ts
  };
}

export function remember(
  db: Db,
  input: RememberInput,
  providedEmbedding?: EmbeddingResult | null
): RememberResult {
  const branchName = input.branch ?? 'main';
  const agent = input.agent ?? 'mcp:remember';
  const evidenceFactIds = uniqueFactIds(input.evidenceFactIds);
  const supersedesFactIds = uniqueFactIds(input.supersedesFactIds);
  const op = input.op ?? 'assert';

  const overlap = evidenceFactIds.find((id) => supersedesFactIds.includes(id));
  if (overlap) {
    throw new Error(`fact cannot be both evidence and superseded source: ${overlap}`);
  }
  if (op === 'retract' && supersedesFactIds.length > 0) {
    throw new Error('retract facts cannot supersede other facts');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const branch = loadBranch(db, branchName);
    ensureAttributeDef(db, input.attribute);

    const valueStr = JSON.stringify(input.value);
    const redactedStr = redactSecrets(valueStr);
    const isRedacted = redactedStr !== valueStr;
    const finalValue = isRedacted ? '[REDACTED]' : valueStr;

    const ts = new Date().toISOString();
    const txId = contentHash(branch.head_tx_id ?? '', branch.id, ts, agent);
    db.prepare(
      'INSERT OR IGNORE INTO transactions (id, parent_tx_id, branch_id, ts, agent, index_run_id) VALUES (?, ?, ?, ?, ?, NULL)'
    ).run(txId, branch.head_tx_id, branch.id, ts, agent);
    if (branch.head_tx_id) {
      db.prepare(
        'INSERT OR IGNORE INTO transaction_parents (tx_id, parent_tx_id) VALUES (?, ?)'
      ).run(txId, branch.head_tx_id);
    }

    const factId = contentHash(input.entity, input.attribute, finalValue, op);
    if (supersedesFactIds.includes(factId)) {
      throw new Error(`fact cannot supersede itself: ${factId}`);
    }
    assertFactsExist(db, [...evidenceFactIds, ...supersedesFactIds]);

    db.prepare(
      'INSERT OR IGNORE INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(factId, input.entity, input.attribute, finalValue, op, txId, isRedacted ? 1 : 0);

    // Redact-then-embed gate: only non-redacted asserted facts get a vector.
    // Retracts have no semantic value to retrieve; redacted values would
    // leak secrets into embedding space even with [REDACTED] in value_blob.
    // Writes go to fact_embeddings (schema v6) so the model is recorded
    // alongside the vector and a fact can carry vectors from multiple models.
    //
    // providedEmbedding === undefined → legacy sync stub (tests, indexer)
    // providedEmbedding === null      → caller explicitly skips embedding
    // providedEmbedding object        → caller pre-computed (e.g. real model)
    if (!isRedacted && op === 'assert') {
      const embedding =
        providedEmbedding === undefined
          ? computeEmbeddingSync(`${input.entity}|${input.attribute}|${valueStr}`)
          : providedEmbedding;
      if (embedding) {
        db.prepare(
          "INSERT OR REPLACE INTO fact_embeddings (fact_id, model, vector, dim, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(factId, embedding.model, embedding.vector, embedding.dim);
        // Phase 4 P5 / D-018: dual-write to per-model vec0 table when
        // the extension is loaded. Silent skip otherwise — fact_embeddings
        // remains the canonical source of truth for the brute-force path.
        // vec_int8(?) is an explicit cast: a raw 768-byte buffer would
        // otherwise be auto-detected as float32 since 768 is divisible
        // by 4. Our embeddings are always int8-quantized (per D-007).
        // vec0 does not support INSERT OR REPLACE, so DELETE first to
        // make the upsert idempotent.
        if (ensureVecTable(db, embedding.model, embedding.dim)) {
          const tableName = vecTableName(embedding.model);
          db.prepare(`DELETE FROM ${tableName} WHERE fact_id = ?`).run(factId);
          db.prepare(
            `INSERT INTO ${tableName} (fact_id, embedding) VALUES (?, vec_int8(?))`
          ).run(factId, embedding.vector);
        }
      }
    }

    for (const sourceFactId of evidenceFactIds) {
      const provId = contentHash(factId, sourceFactId);
      db.prepare(
        "INSERT OR IGNORE INTO fact_provenance (id, fact_id, source_fact_id, kind, tx_id) VALUES (?, ?, ?, 'evidence', ?)"
      ).run(provId, factId, sourceFactId, txId);
    }

    for (const sourceFactId of supersedesFactIds) {
      const provId = contentHash(factId, sourceFactId, 'supersedes', txId);
      db.prepare(
        "INSERT OR IGNORE INTO fact_provenance (id, fact_id, source_fact_id, kind, tx_id) VALUES (?, ?, ?, 'supersedes', ?)"
      ).run(provId, factId, sourceFactId, txId);
    }

    db.prepare('UPDATE branches SET head_tx_id = ? WHERE id = ?').run(txId, branch.id);

    db.exec('COMMIT');
    return { factId, txId };
  } catch (error: unknown) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function recall(db: Db, input: RecallInput): RecallResult {
  const branchName = input.branch ?? 'main';
  const k = Math.min(input.k ?? 20, MAX_RECALL_K);
  const branch = loadBranch(db, branchName);

  const useAsOf = input.asOfTx !== undefined;
  const currentOnly = input.currentOnly === true;

  // Branch and asOfTx are alternative scopes:
  //   - without asOfTx: filter by branch (full branch history)
  //   - with asOfTx: DAG walk from that tx is the source of truth,
  //     branch filter is dropped so merge txs can surface facts from
  //     both parent branches.
  // Archived transactions (gc-branches sweep) are always excluded so
  // soft-deleted speculative branches stop surfacing facts via recall.
  const conditions: string[] = [];
  const whereParams: Array<string | number | null> = [];
  const visibleTsParams: Array<string | number | null> = [];
  let visibleTsSql: string;
  if (!useAsOf) {
    visibleTsSql = scopedFactVisibleTsSql(
      'f',
      't',
      't.archived = 0 AND t.branch_id = ?',
      'visibility_tx.branch_id = ?'
    );
    if (currentOnly) visibleTsParams.push(branch.id, branch.id);
    conditions.push(
      scopedFactVisibilitySql(
        'f',
        't.archived = 0 AND t.branch_id = ?',
        'visibility_tx.branch_id = ?'
      )
    );
    whereParams.push(branch.id, branch.id);
    conditions.push(notSupersededSql('f', 'supersession_tx.branch_id = ?'));
    whereParams.push(branch.id);
  } else {
    visibleTsSql = scopedFactVisibleTsSql(
      'f',
      't',
      't.archived = 0 AND t.id IN (SELECT id FROM ancestor_txs)',
      'visibility_tx.id IN (SELECT id FROM ancestor_txs)'
    );
    conditions.push(
      scopedFactVisibilitySql(
        'f',
        't.archived = 0 AND t.id IN (SELECT id FROM ancestor_txs)',
        'visibility_tx.id IN (SELECT id FROM ancestor_txs)'
      )
    );
    conditions.push(notSupersededSql('f', 'supersession_tx.id IN (SELECT id FROM ancestor_txs)'));
  }

  if (input.entity !== undefined) {
    conditions.push('f.entity_id = ?');
    whereParams.push(input.entity);
  }
  if (input.attribute !== undefined) {
    conditions.push('f.attribute = ?');
    whereParams.push(input.attribute);
  }

  const cteHeader = useAsOf
    ? `WITH RECURSIVE ancestor_txs(id) AS (
        SELECT ?
        UNION
        SELECT tp.parent_tx_id
        FROM transaction_parents tp, ancestor_txs a
        WHERE tp.tx_id = a.id
      )`
    : '';

  const baseSelect = `
    SELECT f.id, f.entity_id, f.attribute, f.value_blob, f.op, f.tx_id, f.redacted, t.ts
    FROM facts f
    INNER JOIN transactions t ON f.tx_id = t.id
    WHERE ${conditions.join(' AND ')}
  `;

  const sql = currentOnly
    ? `${cteHeader}${useAsOf ? ',' : 'WITH'} visible AS (
        SELECT f.id, f.entity_id, f.attribute, f.value_blob, f.op, f.tx_id, f.redacted, t.ts,
          ${visibleTsSql} AS visible_ts
        FROM facts f
        INNER JOIN transactions t ON f.tx_id = t.id
        WHERE ${conditions.join(' AND ')}
      ),
      ranked AS (
        SELECT id, entity_id, attribute, value_blob, op, tx_id, redacted, ts, visible_ts,
          ROW_NUMBER() OVER (PARTITION BY entity_id, attribute, value_blob ORDER BY visible_ts DESC, id ASC) AS rn
        FROM visible
      )
      SELECT id, entity_id, attribute, value_blob, op, tx_id, redacted, ts
      FROM ranked
      WHERE rn = 1 AND op = 'assert'
      ORDER BY visible_ts DESC, id ASC
      LIMIT ?`
    : `${cteHeader}${baseSelect} ORDER BY t.ts DESC, f.id ASC LIMIT ?`;

  const allParams: Array<string | number | null> = [];
  if (useAsOf) allParams.push(input.asOfTx as string);
  if (currentOnly) allParams.push(...visibleTsParams);
  allParams.push(...whereParams, k);

  const rows = db.prepare(sql).all(...allParams) as unknown as FactRow[];
  return { facts: rows.map(rowToRecalledFact) };
}

export function createBranch(db: Db, input: BranchInput): BranchResult {
  const fromName = input.from ?? 'main';

  db.exec('BEGIN IMMEDIATE');
  try {
    const fromBranch = loadBranch(db, fromName);

    const existing = db.prepare('SELECT id FROM branches WHERE name = ?').get(input.name);
    if (existing) {
      throw new Error(`branch already exists: ${input.name}`);
    }

    const createdAt = new Date().toISOString();
    const branchId = `br_${contentHash(input.name, fromBranch.id, createdAt).slice(0, 16)}`;

    db.prepare(
      'INSERT INTO branches (id, name, head_tx_id, parent_branch_id, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(branchId, input.name, fromBranch.head_tx_id, fromBranch.id, createdAt);

    db.exec('COMMIT');
    return { branchId, headTxId: fromBranch.head_tx_id };
  } catch (error: unknown) {
    db.exec('ROLLBACK');
    throw error;
  }
}

interface FactWithEmbeddingRow extends FactRow {
  vector: Buffer;
  dim: number;
}

function bufferToInt8(buf: Buffer): Int8Array {
  return new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function int8DotScore(a: Int8Array, b: Int8Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

/**
 * Sync semantic recall — caller pre-computes the query embedding async
 * (expensive part), then this scores all matching candidates inside one
 * SELECT and returns the top-k by int8 dot product (vectors are
 * L2-normalized then int8-quantized so dot ≈ cosine similarity ranking).
 *
 * Filters apply BEFORE ranking: a candidate must (1) carry an embedding
 * for the SAME model as the query, and (2) match any entity/attribute/
 * branch/asOf/currentOnly filters supplied.
 */
export function recallSemantic(
  db: Db,
  queryEmbedding: EmbeddingResult,
  input: RecallInput
): RecallResult {
  const k = Math.min(input.k ?? 20, MAX_RECALL_K);
  // Phase 4 P5 / D-018: try the sqlite-vec ANN path first; fall back
  // to brute-force int8 dot product when the extension is unavailable
  // or no vec table has been built for this model yet.
  if (isVectorExtensionLoaded(db) && hasVecTable(db, queryEmbedding.model)) {
    const result = recallSemanticAnn(db, queryEmbedding, input, k);
    if (result !== null) return result;
  }
  return recallSemanticBruteForce(db, queryEmbedding, input, k);
}

/**
 * ANN path: query the per-model vec0 table for top-K nearest fact_ids,
 * then JOIN to apply the same archived/entity/attribute/branch filters
 * recall has always applied. We over-fetch by `ANN_OVER_FETCH_FACTOR`
 * to compensate for rows dropped by the post-JOIN filters; if even
 * after over-fetch we get fewer than k results, that's still correct
 * (returns whatever is left). Returns null when the vec table is empty
 * or a SQL error surfaces — the caller will fall back to brute force.
 */
function recallSemanticAnn(
  db: Db,
  queryEmbedding: EmbeddingResult,
  input: RecallInput,
  k: number
): RecallResult | null {
  const tableName = vecTableName(queryEmbedding.model);
  const overFetch = Math.max(k * ANN_OVER_FETCH_FACTOR, ANN_OVER_FETCH_MIN);

  const useAsOf = input.asOfTx !== undefined;
  const conditions: string[] = ['f.op = \'assert\''];
  const filterParams: Array<string | number | null> = [];
  if (input.entity !== undefined) {
    conditions.push('f.entity_id = ?');
    filterParams.push(input.entity);
  }
  if (input.attribute !== undefined) {
    conditions.push('f.attribute = ?');
    filterParams.push(input.attribute);
  }

  let currentOnlyScopeSql = '1 = 1';
  let currentOnlyVisibleTsSql = '';
  if (useAsOf) {
    conditions.push(
      scopedFactVisibilitySql(
        'f',
        't.archived = 0 AND t.id IN (SELECT id FROM ancestor_txs)',
        'visibility_tx.id IN (SELECT id FROM ancestor_txs)'
      )
    );
    conditions.push(notSupersededSql('f', 'supersession_tx.id IN (SELECT id FROM ancestor_txs)'));
    currentOnlyScopeSql = 'newer_tx.id IN (SELECT id FROM ancestor_txs)';
    currentOnlyVisibleTsSql = scopedFactVisibleTsSql(
      'f',
      't',
      't.archived = 0 AND t.id IN (SELECT id FROM ancestor_txs)',
      'visibility_tx.id IN (SELECT id FROM ancestor_txs)'
    );
  } else {
    const branch = loadBranch(db, input.branch ?? 'main');
    conditions.push(
      scopedFactVisibilitySql(
        'f',
        't.archived = 0 AND t.branch_id = ?',
        'visibility_tx.branch_id = ?'
      )
    );
    filterParams.push(branch.id, branch.id);
    conditions.push(notSupersededSql('f', 'supersession_tx.branch_id = ?'));
    filterParams.push(branch.id);
    currentOnlyScopeSql = 'newer_tx.branch_id = ?';
    currentOnlyVisibleTsSql = scopedFactVisibleTsSql(
      'f',
      't',
      't.archived = 0 AND t.branch_id = ?',
      'visibility_tx.branch_id = ?'
    );
  }

  if (input.currentOnly === true) {
    conditions.push(currentOnlyNotShadowedSql('f', currentOnlyVisibleTsSql, currentOnlyScopeSql));
    if (!useAsOf) {
      const branch = loadBranch(db, input.branch ?? 'main');
      filterParams.push(branch.id, branch.id, branch.id, branch.id, branch.id);
    }
  }

  const cteHeader = useAsOf
    ? `WITH RECURSIVE ancestor_txs(id) AS (
        SELECT ?
        UNION
        SELECT tp.parent_tx_id
        FROM transaction_parents tp, ancestor_txs a
        WHERE tp.tx_id = a.id
      ),`
    : 'WITH';

  const sql = `
    ${cteHeader} ranked AS (
      SELECT fact_id, distance
      FROM ${tableName}
      WHERE embedding MATCH vec_int8(?) AND k = ?
    )
    SELECT f.id, f.entity_id, f.attribute, f.value_blob, f.op, f.tx_id, f.redacted, t.ts
    FROM ranked r
    INNER JOIN facts f ON f.id = r.fact_id
    INNER JOIN transactions t ON f.tx_id = t.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY r.distance ASC
    LIMIT ?
  `;
  try {
    const allParams: Array<string | number | null | Buffer> = [];
    if (useAsOf) allParams.push(input.asOfTx as string);
    allParams.push(queryEmbedding.vector, overFetch, ...filterParams, k);
    const rows = db
      .prepare(sql)
      .all(...allParams) as unknown as FactRow[];
    return { facts: rows.map(rowToRecalledFact) };
  } catch {
    return null;
  }
}

function recallSemanticBruteForce(
  db: Db,
  queryEmbedding: EmbeddingResult,
  input: RecallInput,
  k: number
): RecallResult {
  const useAsOf = input.asOfTx !== undefined;
  const conditions: string[] = ['fe.model = ?', 'f.op = \'assert\''];
  const params: Array<string | number | null> = [];
  if (useAsOf) params.push(input.asOfTx as string);
  params.push(queryEmbedding.model);

  if (input.entity !== undefined) {
    conditions.push('f.entity_id = ?');
    params.push(input.entity);
  }
  if (input.attribute !== undefined) {
    conditions.push('f.attribute = ?');
    params.push(input.attribute);
  }

  let currentOnlyScopeSql = '1 = 1';
  let currentOnlyVisibleTsSql = '';
  if (useAsOf) {
    conditions.push(
      scopedFactVisibilitySql(
        'f',
        't.archived = 0 AND t.id IN (SELECT id FROM ancestor_txs)',
        'visibility_tx.id IN (SELECT id FROM ancestor_txs)'
      )
    );
    conditions.push(notSupersededSql('f', 'supersession_tx.id IN (SELECT id FROM ancestor_txs)'));
    currentOnlyScopeSql = 'newer_tx.id IN (SELECT id FROM ancestor_txs)';
    currentOnlyVisibleTsSql = scopedFactVisibleTsSql(
      'f',
      't',
      't.archived = 0 AND t.id IN (SELECT id FROM ancestor_txs)',
      'visibility_tx.id IN (SELECT id FROM ancestor_txs)'
    );
  } else {
    const branch = loadBranch(db, input.branch ?? 'main');
    conditions.push(
      scopedFactVisibilitySql(
        'f',
        't.archived = 0 AND t.branch_id = ?',
        'visibility_tx.branch_id = ?'
      )
    );
    params.push(branch.id, branch.id);
    conditions.push(notSupersededSql('f', 'supersession_tx.branch_id = ?'));
    params.push(branch.id);
    currentOnlyScopeSql = 'newer_tx.branch_id = ?';
    currentOnlyVisibleTsSql = scopedFactVisibleTsSql(
      'f',
      't',
      't.archived = 0 AND t.branch_id = ?',
      'visibility_tx.branch_id = ?'
    );
  }

  if (input.currentOnly === true) {
    conditions.push(currentOnlyNotShadowedSql('f', currentOnlyVisibleTsSql, currentOnlyScopeSql));
    if (!useAsOf) {
      const branch = loadBranch(db, input.branch ?? 'main');
      params.push(branch.id, branch.id, branch.id, branch.id, branch.id);
    }
  }

  const cteHeader = useAsOf
    ? `WITH RECURSIVE ancestor_txs(id) AS (
        SELECT ?
        UNION
        SELECT tp.parent_tx_id
        FROM transaction_parents tp, ancestor_txs a
        WHERE tp.tx_id = a.id
      )`
    : '';

  const sql = `
    ${cteHeader}
    SELECT f.id, f.entity_id, f.attribute, f.value_blob, f.op, f.tx_id, f.redacted, t.ts,
           fe.vector, fe.dim
    FROM facts f
    INNER JOIN fact_embeddings fe ON f.id = fe.fact_id
    INNER JOIN transactions t ON f.tx_id = t.id
    WHERE ${conditions.join(' AND ')}
  `;

  const rows = db.prepare(sql).all(...params) as unknown as FactWithEmbeddingRow[];
  const queryVec = bufferToInt8(queryEmbedding.vector);
  const scored = rows
    .map((row) => ({ row, score: int8DotScore(queryVec, bufferToInt8(row.vector)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return { facts: scored.map((entry) => rowToRecalledFact(entry.row)) };
}

const ANN_OVER_FETCH_FACTOR = 5;
const ANN_OVER_FETCH_MIN = 20;

export interface ReindexVecOptions {
  model?: string;
}

export interface ReindexVecResult {
  extensionLoaded: boolean;
  models: Array<{ model: string; dim: number; written: number }>;
}

/**
 * Phase 4 P5 / D-018: backfill vec0 tables from the canonical
 * fact_embeddings rows. Useful after upgrading an existing repo
 * (which has int8 vectors in fact_embeddings but no vec0 tables yet)
 * or after a reembed run on a fresh model. Idempotent: each model is
 * fully rewritten (DELETE + INSERT).
 */
export function reindexVecOnRepo(
  repoRoot: string,
  options: ReindexVecOptions = {}
): ReindexVecResult {
  return withAgentMemoryDb(repoRoot, false, (db) => reindexVec(db, options));
}

export function reindexVec(db: Db, options: ReindexVecOptions = {}): ReindexVecResult {
  if (!isVectorExtensionLoaded(db)) {
    return { extensionLoaded: false, models: [] };
  }
  const filterParams: string[] = [];
  let modelFilter = '';
  if (options.model !== undefined) {
    modelFilter = ' WHERE model = ?';
    filterParams.push(options.model);
  }
  const groups = db
    .prepare(
      `SELECT model, dim, COUNT(*) AS n
       FROM fact_embeddings${modelFilter}
       GROUP BY model, dim`
    )
    .all(...filterParams) as Array<{ model: string; dim: number; n: number }>;

  const result: ReindexVecResult = { extensionLoaded: true, models: [] };
  for (const group of groups) {
    if (!ensureVecTable(db, group.model, group.dim)) continue;
    const tableName = vecTableName(group.model);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`DELETE FROM ${tableName}`);
      const insert = db.prepare(
        `INSERT INTO ${tableName} (fact_id, embedding) VALUES (?, vec_int8(?))`
      );
      const rows = db
        .prepare(
          'SELECT fact_id, vector FROM fact_embeddings WHERE model = ? AND dim = ?'
        )
        .all(group.model, group.dim) as Array<{ fact_id: string; vector: Buffer }>;
      let written = 0;
      for (const row of rows) {
        insert.run(row.fact_id, row.vector);
        written += 1;
      }
      db.exec('COMMIT');
      result.models.push({ model: group.model, dim: group.dim, written });
    } catch (error: unknown) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return result;
}

export interface ReembedOptions {
  model?: string;
  all?: boolean;
}

export interface ReembedResult {
  model: string;
  embedded: number;
  candidates: number;
}

interface ReembedCandidate {
  id: string;
  entity_id: string;
  attribute: string;
  value_blob: string;
}

const DEFAULT_REEMBED_MODEL = 'Xenova/multilingual-e5-base';

/**
 * Bulk re-embed pass for a model swap. Default behaviour: only embed
 * non-redacted asserted facts that *do not yet* have an embedding for
 * the target model. Use { all: true } to redo every eligible fact even
 * if a row already exists (overwritten via INSERT OR REPLACE).
 *
 * Target model resolution order: explicit options.model →
 * PARALLAX_EMBEDDING_MODEL env → default Xenova/multilingual-e5-base.
 *
 * Embeddings are computed sequentially (the in-process model is
 * single-threaded); large fact counts will take time proportional to
 * count × per-text inference latency. Writes happen in one short
 * transaction at the end.
 */
export async function reembedFacts(
  repoRoot: string,
  options: ReembedOptions = {}
): Promise<ReembedResult> {
  const targetModel =
    options.model ?? envValue('EMBEDDING_MODEL') ?? DEFAULT_REEMBED_MODEL;

  const candidates = withAgentMemoryDb(repoRoot, true, (db) => {
    const baseSql =
      "SELECT id, entity_id, attribute, value_blob FROM facts WHERE redacted = 0 AND op = 'assert'";
    if (options.all === true) {
      return db.prepare(baseSql).all() as unknown as ReembedCandidate[];
    }
    const sql = `${baseSql}
      AND NOT EXISTS (
        SELECT 1 FROM fact_embeddings fe
        WHERE fe.fact_id = facts.id AND fe.model = ?
      )`;
    return db.prepare(sql).all(targetModel) as unknown as ReembedCandidate[];
  });

  if (candidates.length === 0) {
    return { model: targetModel, embedded: 0, candidates: 0 };
  }

  // Force the requested model for this pass even if env points elsewhere.
  const previousEnv = envValue('EMBEDDING_MODEL');
  process.env.PARALLAX_EMBEDDING_MODEL = targetModel;

  const embeddings: Array<{ factId: string; result: EmbeddingResult }> = [];
  try {
    for (const candidate of candidates) {
      const text = `${candidate.entity_id}|${candidate.attribute}|${candidate.value_blob}`;
      const result = await computeEmbedding(text);
      embeddings.push({ factId: candidate.id, result });
    }
  } finally {
    if (previousEnv === undefined) {
      delete process.env.PARALLAX_EMBEDDING_MODEL;
    } else {
      process.env.PARALLAX_EMBEDDING_MODEL = previousEnv;
    }
  }

  const written = withAgentMemoryDb(repoRoot, false, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const stmt = db.prepare(
        "INSERT OR REPLACE INTO fact_embeddings (fact_id, model, vector, dim, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
      );
      // Phase 4 P5 / D-018: dual-write to vec0 if available. Prepare
      // per-model vec delete+insert pair lazily so we only pay the
      // CREATE/PREPARE cost once per distinct model in the batch.
      const vecStmtCachePair = new Map<
        string,
        { delete: ReturnType<typeof db.prepare>; insert: ReturnType<typeof db.prepare> } | null
      >();
      const vecStmtFor = (
        model: string,
        dim: number
      ): { delete: ReturnType<typeof db.prepare>; insert: ReturnType<typeof db.prepare> } | null => {
        const cached = vecStmtCachePair.get(model);
        if (cached !== undefined) return cached;
        const ready = ensureVecTable(db, model, dim);
        if (!ready) {
          vecStmtCachePair.set(model, null);
          return null;
        }
        const tableName = vecTableName(model);
        const pair = {
          delete: db.prepare(`DELETE FROM ${tableName} WHERE fact_id = ?`),
          insert: db.prepare(
            `INSERT INTO ${tableName} (fact_id, embedding) VALUES (?, vec_int8(?))`
          )
        };
        vecStmtCachePair.set(model, pair);
        return pair;
      };
      let count = 0;
      for (const { factId, result } of embeddings) {
        stmt.run(factId, result.model, result.vector, result.dim);
        const vecStmts = vecStmtFor(result.model, result.dim);
        if (vecStmts) {
          vecStmts.delete.run(factId);
          vecStmts.insert.run(factId, result.vector);
        }
        count += 1;
      }
      db.exec('COMMIT');
      return count;
    } catch (error: unknown) {
      db.exec('ROLLBACK');
      throw error;
    }
  });

  return { model: targetModel, embedded: written, candidates: candidates.length };
}

/**
 * Async wrapper for recall that activates semantic mode when both
 * `semantic: true` and `query` are set. Otherwise falls through to the
 * sync structured-filter recall.
 */
export async function recallOnRepo(
  repoRoot: string,
  input: RecallInput
): Promise<RecallResult> {
  if (input.semantic === true && input.query !== undefined) {
    const queryEmbedding = await computeEmbedding(`query: ${input.query}`);
    return withAgentMemoryDb(repoRoot, true, (db) => recallSemantic(db, queryEmbedding, input));
  }
  return withAgentMemoryDb(repoRoot, true, (db) => recall(db, input));
}

/**
 * Async wrapper that pre-computes the embedding outside the SQLite
 * transaction (slow async work — model inference can take 50–150ms),
 * then performs the sync remember() inside its own short transaction.
 * MCP / CLI handlers should prefer this over `remember()` so that
 * production traffic uses the configured real embedding model.
 */
export async function rememberOnRepo(
  repoRoot: string,
  input: RememberInput
): Promise<RememberResult> {
  let providedEmbedding: EmbeddingResult | null = null;
  const valueStr = JSON.stringify(input.value);
  const isRedacted = redactSecrets(valueStr) !== valueStr;
  const op = input.op ?? 'assert';
  if (!isRedacted && op === 'assert') {
    providedEmbedding = await computeEmbedding(
      `${input.entity}|${input.attribute}|${valueStr}`
    );
  }
  return withAgentMemoryDb(repoRoot, false, (db) =>
    remember(db, input, providedEmbedding)
  );
}

export function withAgentMemoryDb<T>(
  repoRoot: string,
  readOnly: boolean,
  callback: (db: Db) => T
): T {
  const root = normalizeRepoRoot(repoRoot);
  const db = openDatabase(root, { readOnly });
  try {
    getRepoId(db, root);
    if (readOnly) {
      assertCurrentSchema(db, 'agent memory read APIs');
    }
    return callback(db);
  } finally {
    db.close();
  }
}

export function mergeBranches(db: Db, input: MergeBranchInput): MergeBranchResult {
  if (input.target === input.source) {
    throw new Error('cannot merge a branch into itself');
  }
  const agent = input.agent ?? 'mcp:merge';

  db.exec('BEGIN IMMEDIATE');
  try {
    const target = loadBranch(db, input.target);
    const source = loadBranch(db, input.source);
    if (source.head_tx_id === null) {
      throw new Error(`source branch has no head: ${input.source}`);
    }

    const ts = new Date().toISOString();
    const mergeTxId = contentHash(
      target.head_tx_id ?? '',
      source.head_tx_id,
      target.id,
      source.id,
      ts,
      agent
    );

    db.prepare(
      'INSERT OR IGNORE INTO transactions (id, parent_tx_id, branch_id, ts, agent, index_run_id) VALUES (?, ?, ?, ?, ?, NULL)'
    ).run(mergeTxId, target.head_tx_id, target.id, ts, agent);

    if (target.head_tx_id) {
      db.prepare(
        'INSERT OR IGNORE INTO transaction_parents (tx_id, parent_tx_id) VALUES (?, ?)'
      ).run(mergeTxId, target.head_tx_id);
    }
    db.prepare(
      'INSERT OR IGNORE INTO transaction_parents (tx_id, parent_tx_id) VALUES (?, ?)'
    ).run(mergeTxId, source.head_tx_id);

    db.prepare('UPDATE branches SET head_tx_id = ? WHERE id = ?').run(mergeTxId, target.id);

    db.exec('COMMIT');
    return {
      mergeTxId,
      targetBranchId: target.id,
      sourceBranchId: source.id,
      previousTargetHead: target.head_tx_id,
      sourceHead: source.head_tx_id
    };
  } catch (error: unknown) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function trace(db: Db, input: TraceInput): TraceResult {
  assertCurrentSchema(db, 'parallax_trace');
  const depth = Math.min(input.depth ?? 5, MAX_TRACE_DEPTH);

  // Archived transactions (gc-branches sweep) are excluded so trace mirrors
  // recall behaviour after a soft-delete. Forensic walks across abandoned
  // branches require an explicit unarchive step (Phase 4).
  const startRow = db
    .prepare(
      `SELECT f.id, f.entity_id, f.attribute, f.value_blob, f.op, f.tx_id, f.redacted, t.ts
       FROM facts f
       INNER JOIN transactions t ON f.tx_id = t.id
       WHERE f.id = ?
         AND (
           t.archived = 0
           OR EXISTS (
             SELECT 1
             FROM fact_provenance visibility_fp
             INNER JOIN transactions visibility_tx ON visibility_fp.tx_id = visibility_tx.id
             WHERE visibility_fp.fact_id = f.id
               AND visibility_fp.kind = 'supersedes'
               AND visibility_tx.archived = 0
           )
         )`
    )
    .get(input.factId) as FactRow | undefined;
  if (!startRow) {
    throw new Error(`fact not found: ${input.factId}`);
  }

  const chain: RecalledFact[] = [rowToRecalledFact(startRow)];
  const edges: TraceEdge[] = [];
  const visited = new Set<string>([startRow.id]);
  const visitedEdges = new Set<string>();
  let frontier: string[] = [startRow.id];

  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const placeholders = frontier.map(() => '?').join(',');
    const sourceRows = db
      .prepare(
        `SELECT f.id, f.entity_id, f.attribute, f.value_blob, f.op, f.tx_id, f.redacted, t.ts,
                fp.fact_id AS edge_fact_id,
                fp.source_fact_id AS edge_source_fact_id,
                fp.kind AS edge_kind
         FROM fact_provenance fp
         INNER JOIN facts f ON fp.source_fact_id = f.id
         INNER JOIN transactions t ON f.tx_id = t.id
         INNER JOIN transactions edge_tx ON edge_tx.id = fp.tx_id
         WHERE fp.fact_id IN (${placeholders}) AND t.archived = 0 AND edge_tx.archived = 0`
      )
      .all(...frontier) as unknown as TraceSourceRow[];

    const next: string[] = [];
    for (const source of sourceRows) {
      const edgeKey = `${source.edge_fact_id}\0${source.edge_source_fact_id}\0${source.edge_kind}`;
      if (!visitedEdges.has(edgeKey)) {
        visitedEdges.add(edgeKey);
        edges.push({
          factId: source.edge_fact_id,
          sourceFactId: source.edge_source_fact_id,
          kind: source.edge_kind
        });
      }
      if (!visited.has(source.id)) {
        visited.add(source.id);
        chain.push(rowToRecalledFact(source));
        next.push(source.id);
      }
    }
    frontier = next;
  }

  return { chain, edges };
}

/**
 * Resolve the Lifecycle ('static' | 'dynamic') of a fact attribute by
 * consulting attribute_defs.is_code_relation. Indexer-emitted code
 * relations (imports, calls, depends_on, affects) are 'static' because
 * they are derived deterministically from repository state. Agent-
 * decision attributes (observed, verified, concern, reflection, ...)
 * default to 'dynamic' because they reflect mutable agent observations.
 *
 * Unknown attributes (not yet seen by ensureAttributeDef) default to
 * 'dynamic' since they originate from agent calls. This avoids
 * reporting an attribute as 'static' before it has been registered.
 */
export function factLifecycle(db: Db, attribute: string): Lifecycle {
  const row = db
    .prepare('SELECT is_code_relation FROM attribute_defs WHERE name = ?')
    .get(attribute) as { is_code_relation: number } | undefined;
  if (!row) {
    return 'dynamic';
  }
  return row.is_code_relation === 1 ? 'static' : 'dynamic';
}
