import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { reflectFacts } from '../src/reflection.js';
import { remember, withAgentMemoryDb } from '../src/agent_memory.js';
import { initProject } from '../src/init.js';

// Force deterministic stubs so tests stay offline and fast.
process.env.IMPACT_TRACE_REFLECTION_MODEL = 'stub';
process.env.IMPACT_TRACE_EMBEDDING_MODEL = 'stub-sha256';

async function makeRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-reflect-'));
  await initProject({ repoRoot });
  return repoRoot;
}

function ageAllTransactionsToFar(repoRoot: string): void {
  withAgentMemoryDb(repoRoot, false, (db) => {
    db.exec("UPDATE transactions SET ts = '2020-01-01T00:00:00.000Z'");
  });
}

test('reflect creates summary fact with kind=summary provenance edges', async () => {
  const repoRoot = await makeRepo();

  withAgentMemoryDb(repoRoot, false, (db) => {
    remember(db, { entity: 'file:src/foo.ts', attribute: 'observed', value: 'compiled' });
    remember(db, { entity: 'file:src/foo.ts', attribute: 'verified', value: 'tests pass' });
  });
  ageAllTransactionsToFar(repoRoot);

  const result = await reflectFacts(repoRoot, { olderThanDays: 1 });

  assert.equal(result.summarized, 1);
  assert.equal(result.reflections.length, 1);
  const reflection = result.reflections[0]!;
  assert.equal(reflection.entity, 'file:src/foo.ts');
  assert.equal(reflection.sourceCount, 2);

  withAgentMemoryDb(repoRoot, true, (db) => {
    const summary = db
      .prepare("SELECT id, value_blob FROM facts WHERE attribute = 'reflection' AND entity_id = ?")
      .get('file:src/foo.ts') as { id: string; value_blob: string };
    assert.ok(summary, 'expected a reflection fact to exist');
    assert.equal(summary.id, reflection.summaryFactId);

    const provenance = db
      .prepare(
        "SELECT kind FROM fact_provenance WHERE fact_id = ?"
      )
      .all(summary.id) as Array<{ kind: string }>;
    assert.equal(provenance.length, 2);
    for (const row of provenance) {
      assert.equal(row.kind, 'summary');
    }

    const audit = db
      .prepare("SELECT model, source_fact_count FROM reflections WHERE summary_fact_id = ?")
      .get(summary.id) as { model: string; source_fact_count: number };
    assert.equal(audit.model, 'stub');
    assert.equal(audit.source_fact_count, 2);
  });
});

test('reflect skips entities with fewer than two facts', async () => {
  const repoRoot = await makeRepo();

  withAgentMemoryDb(repoRoot, false, (db) => {
    remember(db, { entity: 'file:src/lonely.ts', attribute: 'observed', value: 'compiled' });
  });
  ageAllTransactionsToFar(repoRoot);

  const result = await reflectFacts(repoRoot, { olderThanDays: 1 });
  assert.equal(result.summarized, 0);
  assert.equal(result.skippedEntities, 1);
});

test('reflect dry-run does not write facts or reflection rows', async () => {
  const repoRoot = await makeRepo();

  withAgentMemoryDb(repoRoot, false, (db) => {
    remember(db, { entity: 'file:src/dry.ts', attribute: 'observed', value: 'a' });
    remember(db, { entity: 'file:src/dry.ts', attribute: 'observed', value: 'b' });
  });
  ageAllTransactionsToFar(repoRoot);

  const before = withAgentMemoryDb(repoRoot, true, (db) => ({
    facts: (
      db.prepare("SELECT COUNT(*) AS n FROM facts WHERE attribute = 'reflection'").get() as {
        n: number;
      }
    ).n,
    reflections: (db.prepare('SELECT COUNT(*) AS n FROM reflections').get() as { n: number }).n
  }));

  const result = await reflectFacts(repoRoot, { olderThanDays: 1, dryRun: true });
  assert.equal(result.summarized, 1);
  assert.equal(result.reflections[0]?.summaryFactId, '<dry-run>');

  const after = withAgentMemoryDb(repoRoot, true, (db) => ({
    facts: (
      db.prepare("SELECT COUNT(*) AS n FROM facts WHERE attribute = 'reflection'").get() as {
        n: number;
      }
    ).n,
    reflections: (db.prepare('SELECT COUNT(*) AS n FROM reflections').get() as { n: number }).n
  }));
  assert.deepEqual(after, before);
});

test('reflect excludes redacted facts from the summary input set', async () => {
  const repoRoot = await makeRepo();

  withAgentMemoryDb(repoRoot, false, (db) => {
    remember(db, {
      entity: 'file:src/secrets.ts',
      attribute: 'observed',
      value: 'sk-1234567890ABCDEFGHIJKLMNOPQ'
    });
    remember(db, {
      entity: 'file:src/secrets.ts',
      attribute: 'observed',
      value: 'public ok'
    });
    remember(db, {
      entity: 'file:src/secrets.ts',
      attribute: 'verified',
      value: 'tests pass'
    });
  });
  ageAllTransactionsToFar(repoRoot);

  const result = await reflectFacts(repoRoot, { olderThanDays: 1 });
  assert.equal(result.summarized, 1);

  withAgentMemoryDb(repoRoot, true, (db) => {
    const provenance = db
      .prepare(
        `SELECT fp.source_fact_id, f.redacted
         FROM fact_provenance fp
         INNER JOIN facts f ON fp.source_fact_id = f.id
         WHERE fp.fact_id = ?`
      )
      .all(result.reflections[0]!.summaryFactId) as Array<{
      source_fact_id: string;
      redacted: number;
    }>;
    for (const row of provenance) {
      assert.equal(row.redacted, 0, 'redacted facts must not be linked as provenance');
    }
  });
});

test('reflect with no candidates returns zero summarized', async () => {
  const repoRoot = await makeRepo();
  const result = await reflectFacts(repoRoot, { olderThanDays: 1 });
  assert.equal(result.summarized, 0);
  assert.equal(result.reflections.length, 0);
});

test('reflect propagates LLM error with entity name in the message', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    remember(db, { entity: 'file:src/err.ts', attribute: 'observed', value: 'a' });
    remember(db, { entity: 'file:src/err.ts', attribute: 'observed', value: 'b' });
    db.prepare("UPDATE transactions SET ts = '2020-01-01T00:00:00.000Z'").run();
  });
  const previous = process.env.IMPACT_TRACE_REFLECTION_MODEL;
  process.env.IMPACT_TRACE_REFLECTION_MODEL = 'martianbrand:wat';
  try {
    await assert.rejects(
      () => reflectFacts(repoRoot, { olderThanDays: 1 }),
      /summarize failed for file:src\/err\.ts/
    );
  } finally {
    process.env.IMPACT_TRACE_REFLECTION_MODEL = previous;
  }
});

test('reflect throws on unknown branch', async () => {
  const repoRoot = await makeRepo();
  await assert.rejects(
    () => reflectFacts(repoRoot, { branch: 'nonexistent', olderThanDays: 1 }),
    /branch not found/
  );
});
