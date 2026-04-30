import { withAgentMemoryDb } from './agent_memory.js';
import type { RecalledFact, RememberValue } from './agent_memory.js';
import type { Db } from './store.js';

export interface ProfileOptions {
  entity: string;
  branch?: string;
  k?: number;
  asOfTx?: string;
}

export interface ProfileResult {
  readonly entity: string;
  readonly branch: string;
  readonly staticFacts: ReadonlyArray<RecalledFact>;
  readonly dynamicFacts: ReadonlyArray<RecalledFact>;
  readonly summaryFacts: ReadonlyArray<RecalledFact>;
}

const DEFAULT_K_PER_PARTITION = 50;
const REFLECTION_ATTRIBUTE = 'reflection';

interface FactRow {
  id: string;
  entity_id: string;
  attribute: string;
  value_blob: string;
  op: 'assert' | 'retract';
  tx_id: string;
  redacted: number;
  ts: string;
  is_code_relation: number;
}

interface BranchRow {
  id: string;
  name: string;
}

/**
 * Aggregate the facts attached to one entity into a three-bucket profile
 * suitable for an agent's prompt context primer:
 *
 *   - staticFacts: indexer-emitted code relations (attribute_defs.is_code_relation=1)
 *   - dynamicFacts: agent-decision facts (is_code_relation=0, attribute != 'reflection')
 *   - summaryFacts: Phase 3 reflective consolidation outputs (attribute='reflection')
 *
 * Branch-scoped (default 'main'); archived transactions are excluded
 * via the existing recall invariant. asOfTx walks transaction_parents
 * the same way recall does so the profile can be time-travelled to
 * a specific point in history.
 *
 * The async-outside-tx pattern is followed even though no async work
 * happens here: the entire SQL pass is sync, and the wrapper isolates
 * the database lifecycle from any caller that might add async preludes
 * (e.g. an embedding-aware semantic profile in a future iteration).
 *
 * Decision rationale: D-014 (profile is built on top of recall, not
 * merged into it) and D-013 (lifecycle binary derives from is_code_relation;
 * no new column).
 */
export async function profileEntity(
  repoRoot: string,
  options: ProfileOptions
): Promise<ProfileResult> {
  if (!options.entity) {
    throw new Error('profileEntity requires options.entity');
  }
  const branchName = options.branch ?? 'main';
  const k = Math.max(1, Math.min(options.k ?? DEFAULT_K_PER_PARTITION, 200));

  return withAgentMemoryDb(repoRoot, true, (db) => {
    const branch = db
      .prepare('SELECT id, name FROM branches WHERE name = ?')
      .get(branchName) as BranchRow | undefined;
    if (!branch) {
      throw new Error(`branch not found: ${branchName}`);
    }
    return collectProfile(db, branch, options.entity, k, options.asOfTx);
  });
}

function collectProfile(
  db: Db,
  branch: BranchRow,
  entity: string,
  k: number,
  asOfTx: string | undefined
): ProfileResult {
  const useAsOf = asOfTx !== undefined;
  const conditions: string[] = ['t.archived = 0', 'f.entity_id = ?'];
  const params: Array<string | number> = [entity];

  if (useAsOf) {
    conditions.push('t.id IN (SELECT id FROM ancestor_txs)');
  } else {
    conditions.push('t.branch_id = ?');
    params.push(branch.id);
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
           COALESCE(ad.is_code_relation, 0) AS is_code_relation
    FROM facts f
    INNER JOIN transactions t ON f.tx_id = t.id
    LEFT JOIN attribute_defs ad ON ad.name = f.attribute
    WHERE ${conditions.join(' AND ')}
    ORDER BY t.ts DESC, f.id ASC
  `;

  const allParams: Array<string | number> = [];
  if (useAsOf) {
    allParams.push(asOfTx as string);
  }
  allParams.push(...params);

  const rows = db.prepare(sql).all(...allParams) as unknown as FactRow[];

  const staticFacts: RecalledFact[] = [];
  const dynamicFacts: RecalledFact[] = [];
  const summaryFacts: RecalledFact[] = [];
  for (const row of rows) {
    const recalled = rowToRecalledFact(row);
    if (row.attribute === REFLECTION_ATTRIBUTE) {
      if (summaryFacts.length < k) summaryFacts.push(recalled);
    } else if (row.is_code_relation === 1) {
      if (staticFacts.length < k) staticFacts.push(recalled);
    } else {
      if (dynamicFacts.length < k) dynamicFacts.push(recalled);
    }
  }

  return {
    entity,
    branch: branch.name,
    staticFacts,
    dynamicFacts,
    summaryFacts
  };
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
