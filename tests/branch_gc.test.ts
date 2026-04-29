import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { abandonBranch, gcBranches } from '../src/branch_gc.js';
import { createBranch, recall, remember, trace, withAgentMemoryDb } from '../src/agent_memory.js';
import { initProject } from '../src/init.js';

process.env.IMPACT_TRACE_EMBEDDING_MODEL = 'stub-sha256';

async function makeRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-branchgc-'));
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
