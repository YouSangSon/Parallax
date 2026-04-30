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
}

export interface GcBranchesResult {
  scanned: number;
  archivedTransactions: number;
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
 * dryRun reports what would be archived without writing. Useful for
 * estimating impact before committing.
 */
export function gcBranches(db: Db, options: GcBranchesOptions = {}): GcBranchesResult {
  const dryRun = options.dryRun === true;
  const branches = db
    .prepare(
      "SELECT id, name, state FROM branches WHERE state = 'abandoned' AND name != ?"
    )
    .all(PROTECTED_BRANCH) as unknown as BranchRow[];

  const result: GcBranchesResult = {
    scanned: branches.length,
    archivedTransactions: 0,
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
        archivedTransactions
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
    if (branch.state !== 'abandoned') {
      db.exec('COMMIT');
      return {
        branchId: branch.id,
        name: branch.name,
        state: 'active',
        unarchivedTransactions: 0,
        alreadyActive: true
      };
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
