import type { Db } from './store.js';

export interface AbandonBranchInput {
  name: string;
}

export interface AbandonBranchResult {
  branchId: string;
  name: string;
  state: 'abandoned';
  alreadyAbandoned: boolean;
}

export interface GcBranchesOptions {
  dryRun?: boolean;
  /**
   * When set, the gc pass first auto-abandons every active non-main
   * branch whose most recent activity is older than `maxAgeDays` days.
   * "Most recent activity" is `transactions.ts` of `branches.head_tx_id`,
   * falling back to `branches.created_at` for branches that never
   * received a commit. Required to be a non-negative integer when
   * provided; no default — auto-abandon is opt-in per ADR D-017.
   */
  maxAgeDays?: number;
}

export interface RestoreBranchInput {
  name: string;
}

export interface RestoreBranchResult {
  branchId: string;
  name: string;
  state: 'active';
  unarchivedTransactions: number;
  alreadyActive: boolean;
}

export interface GcBranchSummary {
  name: string;
  branchId: string;
  archivedTransactions: number;
  /**
   * True when this branch was auto-abandoned by the same gc pass
   * (active → abandoned because of `maxAgeDays`). False when the
   * branch was already abandoned before the pass started.
   */
  autoAbandoned: boolean;
}

export interface GcBranchesResult {
  scanned: number;
  archivedTransactions: number;
  /**
   * Count of branches that were auto-abandoned in this pass.
   * Always 0 when `maxAgeDays` was not provided.
   */
  autoAbandoned: number;
  branches: GcBranchSummary[];
  dryRun: boolean;
}

interface BranchRow {
  id: string;
  name: string;
  state: string;
}

const PROTECTED_BRANCH = 'main';

/**
 * Mark a branch as abandoned. The branch's transactions stay queryable
 * via trace() and as_of_tx walks, but a subsequent gc-branches pass
 * will set transactions.archived = 1 so recall() / recallSemantic()
 * stop surfacing facts whose only path is through this branch.
 *
 * The 'main' branch is protected — the user must rename their primary
 * line of work before abandoning it. Idempotent: re-abandoning an
 * already-abandoned branch returns alreadyAbandoned=true and does not
 * touch the row.
 */
export function abandonBranch(db: Db, input: AbandonBranchInput): AbandonBranchResult {
  if (input.name === PROTECTED_BRANCH) {
    throw new Error(`cannot abandon protected branch: ${PROTECTED_BRANCH}`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const branch = db
      .prepare('SELECT id, name, state FROM branches WHERE name = ?')
      .get(input.name) as BranchRow | undefined;
    if (!branch) {
      throw new Error(`branch not found: ${input.name}`);
    }
    if (branch.state === 'abandoned') {
      db.exec('COMMIT');
      return {
        branchId: branch.id,
        name: branch.name,
        state: 'abandoned',
        alreadyAbandoned: true
      };
    }
    db.prepare("UPDATE branches SET state = 'abandoned' WHERE id = ?").run(branch.id);
    db.exec('COMMIT');
    return {
      branchId: branch.id,
      name: branch.name,
      state: 'abandoned',
      alreadyAbandoned: false
    };
  } catch (error: unknown) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Sweep abandoned branches. For each branch with state='abandoned' and
 * name != 'main', mark all of that branch's transactions as archived.
 * Facts are NEVER deleted — they are content-addressable and may be
 * referenced by other (active) branches. Setting transactions.archived
 * to 1 is what hides them from recall().
 *
 * Phase 4 P4: when `maxAgeDays` is provided, the pass first
 * auto-abandons every active non-main branch whose most-recent activity
 * timestamp (head_tx_id's transactions.ts, or branches.created_at when
 * head_tx_id is NULL) is older than the cutoff `now - maxAgeDays days`.
 * Auto-abandoned branches then participate in the same archive sweep,
 * so a single call atomically performs `active → abandoned → archived`
 * for the qualifying branches. The original behaviour without
 * `maxAgeDays` is unchanged (backward compatible).
 *
 * dryRun reports what would be auto-abandoned and archived without
 * writing. Useful for estimating impact before committing.
 *
 * Decision rationale: D-017 (auto-abandon piggybacks on gc; explicit
 * `maxAgeDays` flag with no default; main is always protected;
 * non-active non-abandoned branches are silently skipped).
 */
export function gcBranches(db: Db, options: GcBranchesOptions = {}): GcBranchesResult {
  const dryRun = options.dryRun === true;
  const { maxAgeDays } = options;
  if (maxAgeDays !== undefined && (!Number.isInteger(maxAgeDays) || maxAgeDays < 0)) {
    throw new Error(
      `gcBranches: maxAgeDays must be a non-negative integer; got ${String(maxAgeDays)}`
    );
  }

  const autoAbandonedIds = new Set<string>();
  let autoAbandonCandidates: BranchRow[] = [];
  if (maxAgeDays !== undefined) {
    const cutoff = new Date(Date.now() - maxAgeDays * MS_PER_DAY).toISOString();
    autoAbandonCandidates = db
      .prepare(
        `SELECT b.id, b.name, b.state
         FROM branches b
         LEFT JOIN transactions t ON b.head_tx_id = t.id
         WHERE b.state = 'active'
           AND b.name != ?
           AND COALESCE(t.ts, b.created_at) < ?`
      )
      .all(PROTECTED_BRANCH, cutoff) as unknown as BranchRow[];
    for (const candidate of autoAbandonCandidates) {
      autoAbandonedIds.add(candidate.id);
    }
  }

  const realAbandoned = db
    .prepare("SELECT id, name, state FROM branches WHERE state = 'abandoned' AND name != ?")
    .all(PROTECTED_BRANCH) as unknown as BranchRow[];

  const branchById = new Map<string, BranchRow>();
  for (const branch of realAbandoned) branchById.set(branch.id, branch);
  for (const candidate of autoAbandonCandidates) branchById.set(candidate.id, candidate);
  const branches = Array.from(branchById.values());

  const result: GcBranchesResult = {
    scanned: branches.length,
    archivedTransactions: 0,
    autoAbandoned: autoAbandonCandidates.length,
    branches: [],
    dryRun
  };
  if (branches.length === 0) {
    return result;
  }

  if (!dryRun) {
    db.exec('BEGIN IMMEDIATE');
  }
  try {
    if (!dryRun && autoAbandonCandidates.length > 0) {
      const promote = db.prepare("UPDATE branches SET state = 'abandoned' WHERE id = ?");
      for (const candidate of autoAbandonCandidates) {
        promote.run(candidate.id);
      }
    }

    const countStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM transactions WHERE branch_id = ? AND archived = 0'
    );
    const archiveStmt = db.prepare(
      'UPDATE transactions SET archived = 1 WHERE branch_id = ? AND archived = 0'
    );
    for (const branch of branches) {
      const row = countStmt.get(branch.id) as { n: number };
      const archivedTransactions = row.n;
      if (!dryRun && archivedTransactions > 0) {
        archiveStmt.run(branch.id);
      }
      result.archivedTransactions += archivedTransactions;
      result.branches.push({
        name: branch.name,
        branchId: branch.id,
        archivedTransactions,
        autoAbandoned: autoAbandonedIds.has(branch.id)
      });
    }
    if (!dryRun) {
      db.exec('COMMIT');
    }
  } catch (error: unknown) {
    if (!dryRun) {
      db.exec('ROLLBACK');
    }
    throw error;
  }
  return result;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Restore an abandoned branch. The reverse path of `abandonBranch` +
 * `gcBranches`: the branch state moves from 'abandoned' back to
 * 'active', and any transactions previously archived by gcBranches are
 * un-archived (transactions.archived = 0). Recall, recallSemantic,
 * and trace will then surface the branch's facts again automatically
 * because their archived = 0 filter starts matching once more.
 *
 * Idempotent: calling restore on an already-active branch returns
 * alreadyActive=true with unarchivedTransactions=0 and writes nothing.
 *
 * Decision rationale: D-016 (i) was rejected because mental model
 * "I restored the branch but I still cannot see the facts" violates
 * least-surprise; (iii) was rejected because two-step restoration
 * doubles user error surface. (ii) — state plus tx unarchive in a
 * single call — is what this function implements.
 */
export function restoreBranch(db: Db, input: RestoreBranchInput): RestoreBranchResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const branch = db
      .prepare('SELECT id, name, state FROM branches WHERE name = ?')
      .get(input.name) as BranchRow | undefined;
    if (!branch) {
      throw new Error(`branch not found: ${input.name}`);
    }
    if (branch.state === 'active') {
      db.exec('COMMIT');
      return {
        branchId: branch.id,
        name: branch.name,
        state: 'active',
        unarchivedTransactions: 0,
        alreadyActive: true
      };
    }
    if (branch.state !== 'abandoned') {
      // Future-proof: only 'active' (no-op) and 'abandoned' (restore)
      // are valid restore inputs. Any other state — currently only
      // reachable if a future change introduces e.g. 'merged' — must
      // surface an explicit error rather than have RestoreBranchResult
      // lie that state is now 'active'.
      throw new Error(
        `cannot restore branch '${input.name}' from state '${branch.state}' — only 'abandoned' or already-'active' branches are restorable`
      );
    }

    db.prepare("UPDATE branches SET state = 'active' WHERE id = ?").run(branch.id);
    const unarchiveStmt = db.prepare(
      'UPDATE transactions SET archived = 0 WHERE branch_id = ? AND archived = 1'
    );
    const archivedCount = (
      db
        .prepare('SELECT COUNT(*) AS n FROM transactions WHERE branch_id = ? AND archived = 1')
        .get(branch.id) as { n: number }
    ).n;
    if (archivedCount > 0) {
      unarchiveStmt.run(branch.id);
    }
    db.exec('COMMIT');
    return {
      branchId: branch.id,
      name: branch.name,
      state: 'active',
      unarchivedTransactions: archivedCount,
      alreadyActive: false
    };
  } catch (error: unknown) {
    db.exec('ROLLBACK');
    throw error;
  }
}
