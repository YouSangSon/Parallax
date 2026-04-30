import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { reflectFacts, repairReflections } from '../src/reflection.js';
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

test('reflect caps per-entity facts and links exactly cap many provenance edges', async () => {
  // Phase 4 P1: a hot entity with 12 facts under a cap of 5 should still
  // produce one summary fact, but only 5 source_fact_ids should be linked
  // (the OLDEST 5 by ts ASC). totalCount-cap newer observations are
  // disclosed in the prompt footer; provenance and audit row record the
  // bounded count, not the total.
  const repoRoot = await makeRepo();
  const previousCap = process.env.IMPACT_TRACE_REFLECT_MAX_FACTS_PER_ENTITY;
  process.env.IMPACT_TRACE_REFLECT_MAX_FACTS_PER_ENTITY = '5';
  try {
    withAgentMemoryDb(repoRoot, false, (db) => {
      for (let i = 0; i < 12; i += 1) {
        remember(db, {
          entity: 'file:src/hot.ts',
          attribute: 'observed',
          value: `iteration ${i}`
        });
      }
      db.prepare("UPDATE transactions SET ts = '2020-01-01T00:00:00.000Z'").run();
    });

    const result = await reflectFacts(repoRoot, { olderThanDays: 1 });
    assert.equal(result.summarized, 1);
    const reflection = result.reflections[0]!;
    assert.equal(reflection.entity, 'file:src/hot.ts');
    assert.equal(
      reflection.sourceCount,
      5,
      'sourceCount must equal the cap, not the total'
    );

    withAgentMemoryDb(repoRoot, true, (db) => {
      const provenanceRows = db
        .prepare(
          `SELECT COUNT(*) AS n FROM fact_provenance WHERE fact_id = ? AND kind = 'summary'`
        )
        .get(reflection.summaryFactId) as { n: number };
      assert.equal(
        provenanceRows.n,
        5,
        'fact_provenance must record exactly cap many summary edges'
      );
      const audit = db
        .prepare('SELECT source_fact_count FROM reflections WHERE summary_fact_id = ?')
        .get(reflection.summaryFactId) as { source_fact_count: number };
      assert.equal(audit.source_fact_count, 5);
    });
  } finally {
    if (previousCap === undefined) {
      delete process.env.IMPACT_TRACE_REFLECT_MAX_FACTS_PER_ENTITY;
    } else {
      process.env.IMPACT_TRACE_REFLECT_MAX_FACTS_PER_ENTITY = previousCap;
    }
  }
});

test('reflect cap window keeps the OLDEST facts (ts ASC), not the newest', async () => {
  // F4: ORDER BY ts ASC contract — the kept window is the start-of-history
  // slice; recent activity stays raw. If the production query regressed to
  // ts DESC (or any other ordering), this test fails by checking which
  // specific iterations got linked into fact_provenance kind='summary'.
  const repoRoot = await makeRepo();
  const previousCap = process.env.IMPACT_TRACE_REFLECT_MAX_FACTS_PER_ENTITY;
  process.env.IMPACT_TRACE_REFLECT_MAX_FACTS_PER_ENTITY = '5';
  try {
    withAgentMemoryDb(repoRoot, false, (db) => {
      const stampTx = db.prepare(
        `UPDATE transactions SET ts = ?
         WHERE id = (SELECT tx_id FROM facts WHERE value_blob = ?)`
      );
      for (let i = 0; i < 12; i += 1) {
        remember(db, {
          entity: 'file:src/window.ts',
          attribute: 'observed',
          value: `iteration ${i}`
        });
        // Stamp this iteration's tx with a deterministic ts so ASC/DESC
        // ordering is observable. tx.id is a content-hash and not ordered
        // by iteration, so we look up by value_blob (JSON-encoded string).
        const isoStamp = new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString();
        stampTx.run(isoStamp, JSON.stringify(`iteration ${i}`));
      }
    });

    const result = await reflectFacts(repoRoot, { olderThanDays: 1 });
    const reflection = result.reflections[0]!;

    withAgentMemoryDb(repoRoot, true, (db) => {
      const linked = db
        .prepare(
          `SELECT f.value_blob
           FROM fact_provenance fp
           INNER JOIN facts f ON fp.source_fact_id = f.id
           WHERE fp.fact_id = ? AND fp.kind = 'summary'`
        )
        .all(reflection.summaryFactId) as Array<{ value_blob: string }>;
      const values = linked.map((r) => JSON.parse(r.value_blob) as string).sort();
      assert.deepEqual(
        values,
        ['iteration 0', 'iteration 1', 'iteration 2', 'iteration 3', 'iteration 4'],
        'kept window must be the OLDEST 5 facts (iteration 0..4), not the newest 5 (iteration 7..11)'
      );
    });
  } finally {
    if (previousCap === undefined) {
      delete process.env.IMPACT_TRACE_REFLECT_MAX_FACTS_PER_ENTITY;
    } else {
      process.env.IMPACT_TRACE_REFLECT_MAX_FACTS_PER_ENTITY = previousCap;
    }
  }
});

test('reflect cap env var falls back to default when invalid', async () => {
  const repoRoot = await makeRepo();
  const previous = process.env.IMPACT_TRACE_REFLECT_MAX_FACTS_PER_ENTITY;
  process.env.IMPACT_TRACE_REFLECT_MAX_FACTS_PER_ENTITY = 'not-a-number';
  try {
    withAgentMemoryDb(repoRoot, false, (db) => {
      remember(db, { entity: 'file:src/cap.ts', attribute: 'observed', value: 'a' });
      remember(db, { entity: 'file:src/cap.ts', attribute: 'observed', value: 'b' });
      db.prepare("UPDATE transactions SET ts = '2020-01-01T00:00:00.000Z'").run();
    });
    const result = await reflectFacts(repoRoot, { olderThanDays: 1 });
    assert.equal(result.summarized, 1);
    assert.equal(result.reflections[0]!.sourceCount, 2);
  } finally {
    if (previous === undefined) {
      delete process.env.IMPACT_TRACE_REFLECT_MAX_FACTS_PER_ENTITY;
    } else {
      process.env.IMPACT_TRACE_REFLECT_MAX_FACTS_PER_ENTITY = previous;
    }
  }
});

async function buildOrphanReflection(repoRoot: string): Promise<{ summaryFactId: string }> {
  withAgentMemoryDb(repoRoot, false, (db) => {
    remember(db, { entity: 'file:src/orphan.ts', attribute: 'observed', value: 'a' });
    remember(db, { entity: 'file:src/orphan.ts', attribute: 'observed', value: 'b' });
  });
  ageAllTransactionsToFar(repoRoot);
  const result = await reflectFacts(repoRoot, { olderThanDays: 1 });
  const summaryFactId = result.reflections[0]!.summaryFactId;
  // Simulate a mid-failure crash: the audit row never landed and the
  // provenance edges never flipped to kind='summary'. We undo both
  // with two surgical UPDATEs so the rest of the orphan looks real.
  withAgentMemoryDb(repoRoot, false, (db) => {
    db.prepare('DELETE FROM reflections WHERE summary_fact_id = ?').run(summaryFactId);
    db.prepare(
      "UPDATE fact_provenance SET kind = 'evidence' WHERE fact_id = ?"
    ).run(summaryFactId);
  });
  return { summaryFactId };
}

test('repair finds orphan summary fact and fixes provenance kind + audit row', async () => {
  const repoRoot = await makeRepo();
  const { summaryFactId } = await buildOrphanReflection(repoRoot);

  const result = await repairReflections(repoRoot);
  assert.equal(result.scanned, 1);
  assert.equal(result.repaired, 1);
  assert.equal(result.dryRun, false);
  assert.equal(result.orphans[0]!.summaryFactId, summaryFactId);

  withAgentMemoryDb(repoRoot, true, (db) => {
    const audit = db
      .prepare('SELECT model, source_fact_count FROM reflections WHERE summary_fact_id = ?')
      .get(summaryFactId) as { model: string; source_fact_count: number };
    assert.equal(audit.model, 'repair');
    assert.equal(audit.source_fact_count, 2);

    const kinds = db
      .prepare('SELECT kind FROM fact_provenance WHERE fact_id = ?')
      .all(summaryFactId) as Array<{ kind: string }>;
    assert.equal(kinds.length, 2);
    for (const row of kinds) {
      assert.equal(row.kind, 'summary');
    }
  });
});

test('repair --dry-run reports orphans without writing', async () => {
  const repoRoot = await makeRepo();
  const { summaryFactId } = await buildOrphanReflection(repoRoot);

  const result = await repairReflections(repoRoot, { dryRun: true });
  assert.equal(result.scanned, 1);
  assert.equal(result.repaired, 0);
  assert.equal(result.dryRun, true);

  withAgentMemoryDb(repoRoot, true, (db) => {
    const auditCount = (
      db
        .prepare('SELECT COUNT(*) AS n FROM reflections WHERE summary_fact_id = ?')
        .get(summaryFactId) as { n: number }
    ).n;
    assert.equal(auditCount, 0, 'dry-run must not have inserted an audit row');
    const kinds = db
      .prepare('SELECT kind FROM fact_provenance WHERE fact_id = ?')
      .all(summaryFactId) as Array<{ kind: string }>;
    for (const row of kinds) {
      assert.equal(row.kind, 'evidence', 'dry-run must not have promoted provenance kind');
    }
  });
});

test('repair on healthy reflections is a no-op', async () => {
  const repoRoot = await makeRepo();
  withAgentMemoryDb(repoRoot, false, (db) => {
    remember(db, { entity: 'file:src/healthy.ts', attribute: 'observed', value: 'a' });
    remember(db, { entity: 'file:src/healthy.ts', attribute: 'observed', value: 'b' });
  });
  ageAllTransactionsToFar(repoRoot);
  await reflectFacts(repoRoot, { olderThanDays: 1 });

  const result = await repairReflections(repoRoot);
  assert.equal(result.scanned, 0);
  assert.equal(result.repaired, 0);
  assert.equal(result.orphans.length, 0);
});

test('repair throws on unknown branch', async () => {
  const repoRoot = await makeRepo();
  await assert.rejects(
    () => repairReflections(repoRoot, { branch: 'never-existed' }),
    /branch not found/
  );
});
