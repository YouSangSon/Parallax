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
