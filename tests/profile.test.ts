import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { profileEntity } from '../src/profile.js';
import {
  abandonBranch,
  factLifecycle,
  gcBranches,
  createBranch,
  remember,
  withAgentMemoryDb
} from '../src/index.js';
import { initProject } from '../src/init.js';

process.env.IMPACT_TRACE_EMBEDDING_MODEL = 'stub-sha256';

async function makeRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-profile-'));
  await initProject({ repoRoot });
  return repoRoot;
}

test('profile partitions facts by lifecycle (static vs dynamic) using is_code_relation', async () => {
  const repoRoot = await makeRepo();

  withAgentMemoryDb(repoRoot, false, (db) => {
    // 'imports' is seeded with is_code_relation=1 in store.ts migrate v4
    remember(db, {
      entity: 'file:src/foo.ts',
      attribute: 'imports',
      value: 'file:src/bar.ts'
    });
    // 'observed' is auto-registered by ensureAttributeDef with is_code_relation=0
    remember(db, {
      entity: 'file:src/foo.ts',
      attribute: 'observed',
      value: 'compiled'
    });
    remember(db, {
      entity: 'file:src/foo.ts',
      attribute: 'verified',
      value: 'tests pass'
    });
  });

  const result = await profileEntity(repoRoot, { entity: 'file:src/foo.ts' });

  assert.equal(result.entity, 'file:src/foo.ts');
  assert.equal(result.branch, 'main');
  assert.equal(result.staticFacts.length, 1);
  assert.equal(result.staticFacts[0]!.attribute, 'imports');
  assert.equal(result.dynamicFacts.length, 2);
  for (const fact of result.dynamicFacts) {
    assert.match(fact.attribute, /^(observed|verified)$/);
  }
  assert.equal(result.summaryFacts.length, 0);
});

test('profile is branch-scoped — different branch sees different facts', async () => {
  const repoRoot = await makeRepo();

  withAgentMemoryDb(repoRoot, false, (db) => {
    createBranch(db, { name: 'experiment-a' });
    remember(db, {
      branch: 'main',
      entity: 'file:src/foo.ts',
      attribute: 'observed',
      value: 'main-fact'
    });
    remember(db, {
      branch: 'experiment-a',
      entity: 'file:src/foo.ts',
      attribute: 'observed',
      value: 'experiment-fact'
    });
  });

  const mainProfile = await profileEntity(repoRoot, { entity: 'file:src/foo.ts' });
  const expProfile = await profileEntity(repoRoot, {
    entity: 'file:src/foo.ts',
    branch: 'experiment-a'
  });

  assert.equal(mainProfile.dynamicFacts.length, 1);
  assert.equal(mainProfile.dynamicFacts[0]!.value, 'main-fact');
  assert.equal(expProfile.dynamicFacts.length, 1);
  assert.equal(expProfile.dynamicFacts[0]!.value, 'experiment-fact');
});

test('profile excludes archived transactions after gc-branches', async () => {
  const repoRoot = await makeRepo();

  withAgentMemoryDb(repoRoot, false, (db) => {
    createBranch(db, { name: 'speculative' });
    remember(db, {
      branch: 'speculative',
      entity: 'file:src/foo.ts',
      attribute: 'observed',
      value: 'speculative-only'
    });
    abandonBranch(db, { name: 'speculative' });
    gcBranches(db);
  });

  const result = await profileEntity(repoRoot, {
    entity: 'file:src/foo.ts',
    branch: 'speculative'
  });
  assert.equal(result.dynamicFacts.length, 0);
});

test('profile surfaces redacted facts as [REDACTED] (privacy parity with recall)', async () => {
  const repoRoot = await makeRepo();

  withAgentMemoryDb(repoRoot, false, (db) => {
    remember(db, {
      entity: 'file:src/secrets.ts',
      attribute: 'observed',
      value: 'sk-1234567890ABCDEFGHIJKLMNOPQ'
    });
  });

  const result = await profileEntity(repoRoot, { entity: 'file:src/secrets.ts' });
  assert.equal(result.dynamicFacts.length, 1);
  assert.equal(result.dynamicFacts[0]!.value, '[REDACTED]');
});

test('profile surfaces reflection summary facts in summaryFacts bucket', async () => {
  const repoRoot = await makeRepo();

  withAgentMemoryDb(repoRoot, false, (db) => {
    // Manually craft a 'reflection' fact via remember; the real reflectFacts
    // does this through the LLM path but for the bucket test we only need
    // a fact whose attribute is 'reflection'.
    remember(db, {
      entity: 'file:src/foo.ts',
      attribute: 'observed',
      value: 'compiled'
    });
    remember(db, {
      entity: 'file:src/foo.ts',
      attribute: 'reflection',
      value: 'manually-crafted summary',
      agent: 'reflect:test'
    });
  });

  const result = await profileEntity(repoRoot, { entity: 'file:src/foo.ts' });
  assert.equal(result.summaryFacts.length, 1);
  assert.equal(result.summaryFacts[0]!.attribute, 'reflection');
  // Reflection fact should NOT also appear in dynamicFacts (mutually exclusive buckets)
  for (const fact of result.dynamicFacts) {
    assert.notEqual(fact.attribute, 'reflection');
  }
});

test('profile throws on missing entity', async () => {
  const repoRoot = await makeRepo();
  await assert.rejects(
    () => profileEntity(repoRoot, { entity: '' }),
    /requires options\.entity/
  );
});

test('profile throws on unknown branch', async () => {
  const repoRoot = await makeRepo();
  await assert.rejects(
    () => profileEntity(repoRoot, { entity: 'file:x', branch: 'never-existed' }),
    /branch not found/
  );
});

test('factLifecycle returns static for code relations and dynamic for agent attributes', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    // 'imports' is seeded as is_code_relation=1
    assert.equal(factLifecycle(db, 'imports'), 'static');
    assert.equal(factLifecycle(db, 'calls'), 'static');
    assert.equal(factLifecycle(db, 'depends_on'), 'static');
    assert.equal(factLifecycle(db, 'affects'), 'static');
    // Auto-registered dynamic attributes
    remember(db, { entity: 'file:x', attribute: 'observed', value: 'a' });
    assert.equal(factLifecycle(db, 'observed'), 'dynamic');
    // Unknown attribute defaults to dynamic (safer assumption)
    assert.equal(factLifecycle(db, 'totally-unknown-attr'), 'dynamic');
    // Reflection attribute is registered with is_code_relation=0 (added in v7)
    assert.equal(factLifecycle(db, 'reflection'), 'dynamic');
  });
});

test('profile k cap bounds each bucket independently', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    for (let i = 0; i < 10; i += 1) {
      remember(db, {
        entity: 'file:src/foo.ts',
        attribute: 'observed',
        value: `iter-${i}`
      });
    }
  });

  const result = await profileEntity(repoRoot, {
    entity: 'file:src/foo.ts',
    k: 5
  });
  assert.equal(result.dynamicFacts.length, 5);
});
