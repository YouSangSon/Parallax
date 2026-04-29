import { computeEmbedding, computeEmbeddingSync } from './embeddings.js';
import type { EmbeddingResult } from './embeddings.js';
import { contentHash, getRepoId, openDatabase } from './store.js';
import type { Db } from './store.js';
import { normalizeRepoRoot, redactSecrets } from './security.js';

export type RememberValue = string | number | boolean | null | RememberValue[] | { [key: string]: RememberValue };

export interface RememberInput {
  entity: string;
  attribute: string;
  value: RememberValue;
  evidenceFactIds?: string[];
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

export interface TraceResult {
  chain: RecalledFact[];
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
  const evidenceFactIds = input.evidenceFactIds ?? [];
  const op = input.op ?? 'assert';

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
      }
    }

    for (const sourceFactId of evidenceFactIds) {
      const provId = contentHash(factId, sourceFactId);
      db.prepare(
        'INSERT OR IGNORE INTO fact_provenance (id, fact_id, source_fact_id) VALUES (?, ?, ?)'
      ).run(provId, factId, sourceFactId);
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
  const conditions: string[] = [];
  const whereParams: Array<string | number | null> = [];
  if (!useAsOf) {
    conditions.push('t.branch_id = ?');
    whereParams.push(branch.id);
  } else {
    conditions.push('t.id IN (SELECT id FROM ancestor_txs)');
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
    ? `${cteHeader}${useAsOf ? ',' : 'WITH'} ranked AS (
        SELECT f.id, f.entity_id, f.attribute, f.value_blob, f.op, f.tx_id, f.redacted, t.ts,
          ROW_NUMBER() OVER (PARTITION BY f.entity_id, f.attribute, f.value_blob ORDER BY t.ts DESC, f.id ASC) AS rn
        FROM facts f
        INNER JOIN transactions t ON f.tx_id = t.id
        WHERE ${conditions.join(' AND ')}
      )
      SELECT id, entity_id, attribute, value_blob, op, tx_id, redacted, ts
      FROM ranked
      WHERE rn = 1 AND op = 'assert'
      ORDER BY ts DESC, id ASC
      LIMIT ?`
    : `${cteHeader}${baseSelect} ORDER BY t.ts DESC, f.id ASC LIMIT ?`;

  const allParams: Array<string | number | null> = [];
  if (useAsOf) allParams.push(input.asOfTx as string);
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
 * branch filters supplied. asOfTx and currentOnly are not yet combined
 * with semantic mode.
 */
export function recallSemantic(
  db: Db,
  queryEmbedding: EmbeddingResult,
  input: RecallInput
): RecallResult {
  const k = Math.min(input.k ?? 20, MAX_RECALL_K);
  const conditions: string[] = ['fe.model = ?'];
  const params: Array<string | number | null> = [queryEmbedding.model];

  if (input.entity !== undefined) {
    conditions.push('f.entity_id = ?');
    params.push(input.entity);
  }
  if (input.attribute !== undefined) {
    conditions.push('f.attribute = ?');
    params.push(input.attribute);
  }
  if (input.branch !== undefined) {
    const branch = loadBranch(db, input.branch);
    conditions.push('t.branch_id = ?');
    params.push(branch.id);
  }

  const sql = `
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
  const depth = Math.min(input.depth ?? 5, MAX_TRACE_DEPTH);

  const startRow = db
    .prepare(
      `SELECT f.id, f.entity_id, f.attribute, f.value_blob, f.op, f.tx_id, f.redacted, t.ts
       FROM facts f
       INNER JOIN transactions t ON f.tx_id = t.id
       WHERE f.id = ?`
    )
    .get(input.factId) as FactRow | undefined;
  if (!startRow) {
    throw new Error(`fact not found: ${input.factId}`);
  }

  const chain: RecalledFact[] = [rowToRecalledFact(startRow)];
  const visited = new Set<string>([startRow.id]);
  let frontier: string[] = [startRow.id];

  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const placeholders = frontier.map(() => '?').join(',');
    const sourceRows = db
      .prepare(
        `SELECT f.id, f.entity_id, f.attribute, f.value_blob, f.op, f.tx_id, f.redacted, t.ts
         FROM fact_provenance fp
         INNER JOIN facts f ON fp.source_fact_id = f.id
         INNER JOIN transactions t ON f.tx_id = t.id
         WHERE fp.fact_id IN (${placeholders})`
      )
      .all(...frontier) as unknown as FactRow[];

    const next: string[] = [];
    for (const source of sourceRows) {
      if (!visited.has(source.id)) {
        visited.add(source.id);
        chain.push(rowToRecalledFact(source));
        next.push(source.id);
      }
    }
    frontier = next;
  }

  return { chain };
}
