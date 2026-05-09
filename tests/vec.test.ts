import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  abandonBranch,
  createBranch,
  ensureVecTable,
  gcBranches,
  hasVecTable,
  isVectorExtensionLoaded,
  recallSemantic,
  reembedFacts,
  reindexVecOnRepo,
  remember,
  vecTableName,
  withAgentMemoryDb
} from '../src/index.js';
import { computeEmbeddingSync, STUB_MODEL_NAME } from '../src/embeddings.js';
import { initProject } from '../src/init.js';

process.env.IMPACT_TRACE_EMBEDDING_MODEL = 'stub-sha256';

async function makeRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-vec-'));
  await initProject({ repoRoot });
  return repoRoot;
}

test('vec extension loads on db open and exposes per-model table after first write', async () => {
  // P5 D-018 D5: silent fallback if extension not loaded; D2 lazy create.
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    if (!isVectorExtensionLoaded(db)) {
      assert.equal(hasVecTable(db, STUB_MODEL_NAME), false);
      return;
    }
    assert.equal(hasVecTable(db, STUB_MODEL_NAME), false);
    remember(db, { entity: 'file:src/x.ts', attribute: 'observed', value: 'first' });
    assert.equal(hasVecTable(db, STUB_MODEL_NAME), true);
  });
});

test('vecTableName produces a SQL-safe identifier from a HF-style model id', () => {
  assert.equal(vecTableName('Xenova/multilingual-e5-base'), 'vec_facts_xenova_multilingual_e5_base');
  assert.equal(vecTableName('stub-sha256'), 'vec_facts_stub_sha256');
  // All non-alphanumeric characters collapse to underscores so an attacker
  // cannot smuggle SQL through a model identifier.
  assert.equal(vecTableName("'; DROP TABLE facts; --"), 'vec_facts____drop_table_facts____');
});

test('ANN path returns the same top-1 neighbor as brute-force on a tiny dataset', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    if (!isVectorExtensionLoaded(db)) return;
    remember(db, { entity: 'file:a.ts', attribute: 'observed', value: 'alpha-text' });
    remember(db, { entity: 'file:b.ts', attribute: 'observed', value: 'beta-text' });
    remember(db, { entity: 'file:c.ts', attribute: 'observed', value: 'gamma-text' });
  });

  withAgentMemoryDb(repoRoot, true, (db) => {
    if (!isVectorExtensionLoaded(db)) return;
    // The stub embedding is content-addressable: hashing the same text
    // twice yields the same vector. Querying with the alpha-text vector
    // should rank file:a.ts as the top neighbor.
    const queryEmbedding = computeEmbeddingSync(`file:a.ts|observed|"alpha-text"`);
    const result = recallSemantic(db, queryEmbedding, { k: 1 });
    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0]!.entityId, 'file:a.ts');
  });
});

test('ANN path applies the archived filter (D-011) — no archived facts surface', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    if (!isVectorExtensionLoaded(db)) return;
    createBranch(db, { name: 'speculative' });
    remember(db, {
      branch: 'speculative',
      entity: 'file:gone.ts',
      attribute: 'observed',
      value: 'will-be-archived'
    });
    remember(db, { entity: 'file:kept.ts', attribute: 'observed', value: 'kept' });
    abandonBranch(db, { name: 'speculative' });
    gcBranches(db);
  });

  withAgentMemoryDb(repoRoot, true, (db) => {
    if (!isVectorExtensionLoaded(db)) return;
    const queryEmbedding = computeEmbeddingSync('file:gone.ts|observed|"will-be-archived"');
    const result = recallSemantic(db, queryEmbedding, { k: 5 });
    for (const fact of result.facts) {
      assert.notEqual(fact.entityId, 'file:gone.ts', 'archived facts must not surface in ANN path');
    }
  });
});

test('ANN path applies the branch filter (per-branch isolation)', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    if (!isVectorExtensionLoaded(db)) return;
    createBranch(db, { name: 'experiment-a' });
    remember(db, { entity: 'file:m.ts', attribute: 'observed', value: 'main-fact' });
    remember(db, {
      branch: 'experiment-a',
      entity: 'file:m.ts',
      attribute: 'observed',
      value: 'experiment-fact'
    });
  });

  withAgentMemoryDb(repoRoot, true, (db) => {
    if (!isVectorExtensionLoaded(db)) return;
    const queryEmbedding = computeEmbeddingSync('file:m.ts|observed|"experiment-fact"');
    const result = recallSemantic(db, queryEmbedding, { branch: 'main', k: 5 });
    const values = result.facts.map((f) => f.value);
    assert.ok(values.includes('main-fact'));
    assert.ok(!values.includes('experiment-fact'), 'branch filter must hide other branches');
  });
});

test('reindexVec rebuilds vec0 from fact_embeddings (manual backfill path)', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    if (!isVectorExtensionLoaded(db)) return;
    remember(db, { entity: 'file:r.ts', attribute: 'observed', value: 'r-fact' });
    // Drop the auto-created vec table to simulate a pre-P5 install.
    db.exec(`DROP TABLE ${vecTableName(STUB_MODEL_NAME)}`);
    assert.equal(hasVecTable(db, STUB_MODEL_NAME), false);
  });

  const result = reindexVecOnRepo(repoRoot);
  if (!result.extensionLoaded) return; // skip when env has no extension
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0]!.model, STUB_MODEL_NAME);
  assert.ok(result.models[0]!.written >= 1);

  withAgentMemoryDb(repoRoot, true, (db) => {
    assert.equal(hasVecTable(db, STUB_MODEL_NAME), true);
    const queryEmbedding = computeEmbeddingSync('file:r.ts|observed|"r-fact"');
    const recall = recallSemantic(db, queryEmbedding, { k: 1 });
    assert.equal(recall.facts[0]!.entityId, 'file:r.ts');
  });
});

test('reembed populates the vec0 table for the target model', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    if (!isVectorExtensionLoaded(db)) return;
    remember(db, { entity: 'file:re.ts', attribute: 'observed', value: 'value' });
    db.exec(`DELETE FROM ${vecTableName(STUB_MODEL_NAME)}`);
  });
  await reembedFacts(repoRoot, { model: STUB_MODEL_NAME, all: true });
  withAgentMemoryDb(repoRoot, true, (db) => {
    if (!isVectorExtensionLoaded(db)) return;
    const tableName = vecTableName(STUB_MODEL_NAME);
    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM ${tableName}`).get() as { n: number }
    ).n;
    assert.ok(count >= 1, 'reembed must repopulate the vec table');
  });
});

test('ensureVecTable rejects invalid identifiers and dim values', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    if (!isVectorExtensionLoaded(db)) return;
    assert.equal(ensureVecTable(db, '', 768), false, 'empty model name rejected');
    assert.equal(ensureVecTable(db, '!!!', 0), false, 'dim=0 rejected');
    assert.equal(ensureVecTable(db, 'fine-model', 99999), false, 'absurd dim rejected');
    assert.equal(ensureVecTable(db, 'fine-model', 1.5), false, 'non-integer dim rejected');
  });
});
