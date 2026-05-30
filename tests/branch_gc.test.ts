import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { abandonBranch, gcBranches, restoreBranch } from '../src/branch_gc.js';
import { createBranch, recall, remember, trace, withAgentMemoryDb } from '../src/agent_memory.js';
import { initProject } from '../src/init.js';

process.env.PARALLAX_EMBEDDING_MODEL = 'stub-sha256';

async function makeRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-branchgc-'));
  await initProject({ repoRoot });
  return repoRoot;
}

test('abandon main branch is rejected', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    assert.throws(() => abandonBranch(db, { name: 'main' }), /cannot abandon protected branch/);
  });
});

test('abandon is idempotent — second call returns alreadyAbandoned=true', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    createBranch(db, { name: 'doomed' });
    const first = abandonBranch(db, { name: 'doomed' });
    assert.equal(first.alreadyAbandoned, false);
    assert.equal(first.state, 'abandoned');
    const second = abandonBranch(db, { name: 'doomed' });
    assert.equal(second.alreadyAbandoned, true);
  });
});

test('gc archives only abandoned branches and leaves active ones intact', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    createBranch(db, { name: 'gc-test' });
    createBranch(db, { name: 'keep-active' });
    remember(db, {
      branch: 'gc-test',
      entity: 'file:gc.ts',
      attribute: 'observed',
      value: 'gc-fact'
    });
    remember(db, {
      branch: 'keep-active',
      entity: 'file:keep.ts',
      attribute: 'observed',
      value: 'keep-fact'
    });
    abandonBranch(db, { name: 'gc-test' });
  });

  const sweep = withAgentMemoryDb(repoRoot, false, (db) => gcBranches(db));
  assert.equal(sweep.scanned, 1);
  assert.equal(sweep.archivedTransactions, 1);
  assert.equal(sweep.dryRun, false);

  withAgentMemoryDb(repoRoot, true, (db) => {
    const archived = db
      .prepare(
        `SELECT t.archived FROM transactions t
         INNER JOIN branches b ON t.branch_id = b.id
         WHERE b.name = ?`
      )
      .all('gc-test') as Array<{ archived: number }>;
    for (const row of archived) {
      assert.equal(row.archived, 1);
    }
    const kept = db
      .prepare(
        `SELECT t.archived FROM transactions t
         INNER JOIN branches b ON t.branch_id = b.id
         WHERE b.name = ?`
      )
      .all('keep-active') as Array<{ archived: number }>;
    for (const row of kept) {
      assert.equal(row.archived, 0);
    }
  });
});

test('gc dry-run reports archive counts without writing', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    createBranch(db, { name: 'dry' });
    remember(db, { branch: 'dry', entity: 'file:dry.ts', attribute: 'observed', value: 'dry-fact' });
    abandonBranch(db, { name: 'dry' });
  });
  const dryResult = withAgentMemoryDb(repoRoot, false, (db) => gcBranches(db, { dryRun: true }));
  assert.equal(dryResult.dryRun, true);
  assert.equal(dryResult.archivedTransactions, 1);

  withAgentMemoryDb(repoRoot, true, (db) => {
    const row = db
      .prepare(
        `SELECT t.archived FROM transactions t
         INNER JOIN branches b ON t.branch_id = b.id
         WHERE b.name = ?`
      )
      .get('dry') as { archived: number };
    assert.equal(row.archived, 0, 'dry-run must not have written archived=1');
  });
});

test('recall hides facts whose only path is via archived transactions', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    createBranch(db, { name: 'speculative' });
    remember(db, {
      branch: 'speculative',
      entity: 'file:spec.ts',
      attribute: 'observed',
      value: 'speculative-only'
    });
    abandonBranch(db, { name: 'speculative' });
    gcBranches(db);
  });

  withAgentMemoryDb(repoRoot, true, (db) => {
    const result = recall(db, { branch: 'speculative', entity: 'file:spec.ts' });
    assert.equal(result.facts.length, 0, 'archived branch facts must not surface in recall');
  });
});

test('trace mirrors recall after gc — archived chain is hidden', async () => {
  // Architect review found that an earlier draft let trace() leak abandoned
  // branch facts after gcBranches archived their transactions. The corrected
  // design filters t.archived = 0 in trace's start and source-row queries
  // so trace and recall agree on visibility. Forensic traversal across
  // abandoned branches will require an explicit unarchive flag (Phase 4).
  const repoRoot = await makeRepo();
  let archivedTargetId = '';

  withAgentMemoryDb(repoRoot, false, (db) => {
    createBranch(db, { name: 'archived-trace' });
    const evidence = remember(db, {
      branch: 'archived-trace',
      entity: 'file:src/dep.ts',
      attribute: 'observed',
      value: 'parsed'
    });
    const target = remember(db, {
      branch: 'archived-trace',
      entity: 'file:src/main.ts',
      attribute: 'verified',
      value: 'imports dep',
      evidenceFactIds: [evidence.factId]
    });
    archivedTargetId = target.factId;
    abandonBranch(db, { name: 'archived-trace' });
    gcBranches(db);
  });

  withAgentMemoryDb(repoRoot, true, (db) => {
    assert.throws(
      () => trace(db, { factId: archivedTargetId, depth: 5 }),
      /fact not found/,
      'trace must not surface a fact whose only transaction is archived'
    );
  });
});

test('trace still walks evidence on active branches', async () => {
  const repoRoot = await makeRepo();
  let activeTargetId = '';

  withAgentMemoryDb(repoRoot, false, (db) => {
    const evidence = remember(db, {
      entity: 'file:src/dep.ts',
      attribute: 'observed',
      value: 'parsed'
    });
    const target = remember(db, {
      entity: 'file:src/main.ts',
      attribute: 'verified',
      value: 'imports dep',
      evidenceFactIds: [evidence.factId]
    });
    activeTargetId = target.factId;
  });

  withAgentMemoryDb(repoRoot, true, (db) => {
    const traced = trace(db, { factId: activeTargetId, depth: 5 });
    assert.ok(traced.chain.length >= 2, 'trace must walk active branch evidence');
  });
});

test('abandon throws on non-existent branch', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    assert.throws(() => abandonBranch(db, { name: 'never-existed' }), /branch not found/);
  });
});

test('gc with zero abandoned branches returns scanned=0', async () => {
  const repoRoot = await makeRepo();
  const result = withAgentMemoryDb(repoRoot, false, (db) => gcBranches(db));
  assert.equal(result.scanned, 0);
  assert.equal(result.archivedTransactions, 0);
  assert.equal(result.dryRun, false);
  assert.equal(result.branches.length, 0);
});

test('restore moves abandoned branch back to active and unarchives txs', async () => {
  // The abandon → gc → restore cycle. After restore, recall surfaces
  // the branch's facts again because transactions.archived = 0 once
  // more. This exercises the full Phase 4 P3 reverse path.
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    createBranch(db, { name: 'revivable' });
    remember(db, {
      branch: 'revivable',
      entity: 'file:revive.ts',
      attribute: 'observed',
      value: 'pre-abandon-fact'
    });
    abandonBranch(db, { name: 'revivable' });
    gcBranches(db);
  });

  const restored = withAgentMemoryDb(repoRoot, false, (db) =>
    restoreBranch(db, { name: 'revivable' })
  );
  assert.equal(restored.alreadyActive, false);
  assert.equal(restored.state, 'active');
  assert.equal(restored.unarchivedTransactions, 1);

  withAgentMemoryDb(repoRoot, true, (db) => {
    const branchRow = db
      .prepare("SELECT state FROM branches WHERE name = 'revivable'")
      .get() as { state: string };
    assert.equal(branchRow.state, 'active');
    const txArchived = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM transactions t INNER JOIN branches b ON t.branch_id = b.id
           WHERE b.name = ? AND t.archived = 1`
        )
        .get('revivable') as { n: number }
    ).n;
    assert.equal(txArchived, 0, 'all archived txs must be un-archived');
    const recallResult = recall(db, { branch: 'revivable', entity: 'file:revive.ts' });
    assert.equal(
      recallResult.facts.length,
      1,
      'recall must surface the restored branch facts again'
    );
  });
});

test('restore is idempotent on an already-active branch', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    createBranch(db, { name: 'already-active' });
  });
  const result = withAgentMemoryDb(repoRoot, false, (db) =>
    restoreBranch(db, { name: 'already-active' })
  );
  assert.equal(result.alreadyActive, true);
  assert.equal(result.unarchivedTransactions, 0);
  assert.equal(result.state, 'active');
});

test('restore throws on non-existent branch', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    assert.throws(() => restoreBranch(db, { name: 'never-existed' }), /branch not found/);
  });
});

// Phase 4 P4 — auto-abandon by maxAgeDays (ADR D-017)

test('gc --max-age auto-abandons active non-main branches with stale head_tx_id', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    createBranch(db, { name: 'stale' });
    createBranch(db, { name: 'fresh' });
    remember(db, { branch: 'stale', entity: 'file:s.ts', attribute: 'observed', value: 'old' });
    remember(db, { branch: 'fresh', entity: 'file:f.ts', attribute: 'observed', value: 'new' });
    db.prepare(
      `UPDATE transactions SET ts = '2020-01-01T00:00:00.000Z'
       WHERE branch_id = (SELECT id FROM branches WHERE name = 'stale')`
    ).run();
  });

  const result = withAgentMemoryDb(repoRoot, false, (db) =>
    gcBranches(db, { maxAgeDays: 1 })
  );
  assert.equal(result.autoAbandoned, 1, 'exactly one branch must be auto-abandoned');
  assert.equal(result.scanned, 1);
  const stale = result.branches.find((b) => b.name === 'stale');
  assert.ok(stale, 'stale branch must appear in result');
  assert.equal(stale!.autoAbandoned, true);
  assert.equal(stale!.archivedTransactions, 1);

  withAgentMemoryDb(repoRoot, true, (db) => {
    const states = db
      .prepare("SELECT name, state FROM branches WHERE name IN ('stale', 'fresh', 'main')")
      .all() as Array<{ name: string; state: string }>;
    const byName = new Map(states.map((s) => [s.name, s.state]));
    assert.equal(byName.get('stale'), 'abandoned', 'stale must be flipped to abandoned');
    assert.equal(byName.get('fresh'), 'active', 'fresh must remain active');
    assert.equal(byName.get('main'), 'active', 'main must never be auto-abandoned');
  });
});

test('gc --max-age never auto-abandons main even when main is older than the cutoff', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    remember(db, { entity: 'file:m.ts', attribute: 'observed', value: 'main-fact' });
    db.prepare("UPDATE transactions SET ts = '2020-01-01T00:00:00.000Z'").run();
  });
  const result = withAgentMemoryDb(repoRoot, false, (db) =>
    gcBranches(db, { maxAgeDays: 1 })
  );
  assert.equal(result.autoAbandoned, 0);
  assert.equal(result.scanned, 0);
  withAgentMemoryDb(repoRoot, true, (db) => {
    const main = db.prepare("SELECT state FROM branches WHERE name = 'main'").get() as {
      state: string;
    };
    assert.equal(main.state, 'active');
  });
});

test('gc --max-age dry-run reports candidates without writing', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    createBranch(db, { name: 'stale' });
    remember(db, { branch: 'stale', entity: 'file:s.ts', attribute: 'observed', value: 'old' });
    db.prepare(
      `UPDATE transactions SET ts = '2020-01-01T00:00:00.000Z'
       WHERE branch_id = (SELECT id FROM branches WHERE name = 'stale')`
    ).run();
  });

  const result = withAgentMemoryDb(repoRoot, false, (db) =>
    gcBranches(db, { maxAgeDays: 1, dryRun: true })
  );
  assert.equal(result.dryRun, true);
  assert.equal(result.autoAbandoned, 1);
  assert.equal(result.scanned, 1);

  withAgentMemoryDb(repoRoot, true, (db) => {
    const branch = db
      .prepare("SELECT state FROM branches WHERE name = 'stale'")
      .get() as { state: string };
    assert.equal(branch.state, 'active', 'dry-run must not flip state');
    const archivedCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM transactions
           WHERE branch_id = (SELECT id FROM branches WHERE name = 'stale')
             AND archived = 1`
        )
        .get() as { n: number }
    ).n;
    assert.equal(archivedCount, 0, 'dry-run must not archive transactions');
  });
});

test('gc --max-age covers a branch that never received any commits via created_at fallback', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    createBranch(db, { name: 'empty' });
    db.prepare(
      `UPDATE branches SET created_at = '2020-01-01T00:00:00.000Z' WHERE name = 'empty'`
    ).run();
  });
  const result = withAgentMemoryDb(repoRoot, false, (db) =>
    gcBranches(db, { maxAgeDays: 1 })
  );
  assert.equal(result.autoAbandoned, 1);
  const empty = result.branches.find((b) => b.name === 'empty');
  assert.ok(empty);
  assert.equal(empty!.autoAbandoned, true);
  assert.equal(empty!.archivedTransactions, 0, 'empty branch has no txs to archive');
});

test('gc --max-age skips already-abandoned branches as auto-abandon candidates', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    createBranch(db, { name: 'pre-abandoned' });
    remember(db, {
      branch: 'pre-abandoned',
      entity: 'file:p.ts',
      attribute: 'observed',
      value: 'old'
    });
    abandonBranch(db, { name: 'pre-abandoned' });
    db.prepare(
      `UPDATE transactions SET ts = '2020-01-01T00:00:00.000Z'
       WHERE branch_id = (SELECT id FROM branches WHERE name = 'pre-abandoned')`
    ).run();
  });
  const result = withAgentMemoryDb(repoRoot, false, (db) =>
    gcBranches(db, { maxAgeDays: 1 })
  );
  assert.equal(result.autoAbandoned, 0, 'already-abandoned must not count as auto-abandoned');
  assert.equal(result.scanned, 1, 'still archive-swept though');
  const entry = result.branches[0]!;
  assert.equal(entry.name, 'pre-abandoned');
  assert.equal(entry.autoAbandoned, false);
});

test('gc without maxAgeDays preserves backward-compat behaviour', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    createBranch(db, { name: 'stale' });
    remember(db, { branch: 'stale', entity: 'file:s.ts', attribute: 'observed', value: 'x' });
    db.prepare(
      `UPDATE transactions SET ts = '2020-01-01T00:00:00.000Z'
       WHERE branch_id = (SELECT id FROM branches WHERE name = 'stale')`
    ).run();
  });
  const result = withAgentMemoryDb(repoRoot, false, (db) => gcBranches(db));
  assert.equal(result.autoAbandoned, 0, 'no auto-abandon without maxAgeDays');
  assert.equal(result.scanned, 0, 'stale is still active so nothing to archive');
});

test('gc --max-age rejects non-integer or negative input', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    assert.throws(
      () => gcBranches(db, { maxAgeDays: -1 }),
      /maxAgeDays must be a non-negative integer/
    );
    assert.throws(
      () => gcBranches(db, { maxAgeDays: 1.5 }),
      /maxAgeDays must be a non-negative integer/
    );
  });
});
