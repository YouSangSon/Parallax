import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { indexProject, initProject } from '../src/index.js';
import { executeGraphQuery } from '../src/graph_query.js';

// End-to-end: the read-only Cypher subset runs over a real indexed graph.
// alpha.ts imports beta.ts, which produces a DEPENDS_ON relation.

async function buildRepo(): Promise<string> {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'parallax-query-'));
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'src/beta.ts'), 'export const beta = 1;\n');
  writeFileSync(
    path.join(repoRoot, 'src/alpha.ts'),
    "import { beta } from './beta.js';\nexport const alpha = beta;\n"
  );
  await initProject({ repoRoot });
  await indexProject({ repoRoot });
  return repoRoot;
}

test('executeGraphQuery returns a node projection with WHERE CONTAINS', async () => {
  const repoRoot = await buildRepo();
  try {
    const result = executeGraphQuery(
      repoRoot,
      "MATCH (a) WHERE a.path CONTAINS 'src/alpha.ts' RETURN a.path"
    );
    assert.deepEqual(result.columns, ['a.path']);
    assert.ok(
      result.rows.some((row) => row['a.path'] === 'src/alpha.ts'),
      `expected src/alpha.ts in ${JSON.stringify(result.rows)}`
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('executeGraphQuery traverses a typed relationship hop', async () => {
  const repoRoot = await buildRepo();
  try {
    const result = executeGraphQuery(
      repoRoot,
      'MATCH (a)-[r:DEPENDS_ON]->(b) RETURN a.path, b.path, r.kind'
    );
    assert.deepEqual(result.columns, ['a.path', 'b.path', 'r.kind']);
    const edge = result.rows.find(
      (row) => row['a.path'] === 'src/alpha.ts' && row['b.path'] === 'src/beta.ts'
    );
    assert.ok(edge, `expected alpha->beta DEPENDS_ON in ${JSON.stringify(result.rows)}`);
    assert.equal(edge['r.kind'], 'DEPENDS_ON');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('executeGraphQuery answers "what depends on X" via a reverse hop', async () => {
  const repoRoot = await buildRepo();
  try {
    // alpha imports beta; "who depends on beta?" = (beta)<-[r:DEPENDS_ON]-(dependent).
    const result = executeGraphQuery(
      repoRoot,
      "MATCH (b)<-[r:DEPENDS_ON]-(a) WHERE b.path CONTAINS 'beta' RETURN a.path"
    );
    assert.deepEqual(result.columns, ['a.path']);
    assert.ok(
      result.rows.some((row) => row['a.path'] === 'src/alpha.ts'),
      `expected src/alpha.ts as a dependent of beta in ${JSON.stringify(result.rows)}`
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('executeGraphQuery traverses a variable-length path transitively', async () => {
  // Chain: cee imports bee imports ay -> DEPENDS_ON cee->bee->ay.
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'parallax-query-chain-'));
  try {
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'src/ay.ts'), 'export const ay = 1;\n');
    writeFileSync(path.join(repoRoot, 'src/bee.ts'), "import { ay } from './ay.js';\nexport const bee = ay;\n");
    writeFileSync(path.join(repoRoot, 'src/cee.ts'), "import { bee } from './bee.js';\nexport const cee = bee;\n");
    await initProject({ repoRoot });
    await indexProject({ repoRoot });

    // From cee, a 1..3 hop DEPENDS_ON path reaches both bee (1 hop) and ay (2 hops).
    const result = executeGraphQuery(
      repoRoot,
      "MATCH (c)-[:DEPENDS_ON*1..3]->(dep) WHERE c.path CONTAINS 'cee' RETURN dep.path"
    );
    const reached = new Set(result.rows.map((row) => row['dep.path']));
    assert.ok(reached.has('src/bee.ts'), `expected bee reachable in ${JSON.stringify([...reached])}`);
    assert.ok(reached.has('src/ay.ts'), `expected ay transitively reachable in ${JSON.stringify([...reached])}`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('executeGraphQuery rejects write queries before touching the database', async () => {
  const repoRoot = await buildRepo();
  try {
    assert.throws(
      () => executeGraphQuery(repoRoot, "MATCH (a) SET a.path = 'x' RETURN a"),
      /unsupported|read-only/i
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('executeGraphQuery counts dependents per file via COUNT + implicit grouping', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'parallax-count-'));
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  // shared.ts has two dependents (alpha, beta); solo.ts has one (gamma).
  writeFileSync(path.join(repoRoot, 'src/shared.ts'), 'export const shared = 1;\n');
  writeFileSync(path.join(repoRoot, 'src/solo.ts'), 'export const solo = 1;\n');
  writeFileSync(path.join(repoRoot, 'src/alpha.ts'), "import { shared } from './shared.js';\nexport const a = shared;\n");
  writeFileSync(path.join(repoRoot, 'src/beta.ts'), "import { shared } from './shared.js';\nexport const b = shared;\n");
  writeFileSync(path.join(repoRoot, 'src/gamma.ts'), "import { solo } from './solo.js';\nexport const g = solo;\n");
  await initProject({ repoRoot });
  await indexProject({ repoRoot });
  try {
    const result = executeGraphQuery(
      repoRoot,
      'MATCH (a)-[r:DEPENDS_ON]->(b) RETURN b.path, COUNT(a) ORDER BY COUNT(a) DESC, b.path'
    );
    assert.deepEqual(result.columns, ['b.path', 'COUNT(a)']);
    const shared = result.rows.find((row) => row['b.path'] === 'src/shared.ts');
    const solo = result.rows.find((row) => row['b.path'] === 'src/solo.ts');
    assert.ok(shared && solo, `expected shared+solo rows in ${JSON.stringify(result.rows)}`);
    assert.equal(Number(shared['COUNT(a)']), 2);
    assert.equal(Number(solo['COUNT(a)']), 1);
    // ORDER BY COUNT(a) DESC: the 2-dependent file ranks before the 1-dependent.
    const sharedIdx = result.rows.findIndex((row) => row['b.path'] === 'src/shared.ts');
    const soloIdx = result.rows.findIndex((row) => row['b.path'] === 'src/solo.ts');
    assert.ok(sharedIdx < soloIdx, 'higher dependent count must sort first');
    // Aggregated rows carry no navigable entity ids.
    assert.deepEqual(result.resources.entities, []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('executeGraphQuery honors a user ORDER BY DESC over the default ordering', async () => {
  const repoRoot = await buildRepo();
  try {
    const ascending = executeGraphQuery(
      repoRoot,
      "MATCH (a) WHERE a.path CONTAINS 'src/' RETURN a.path"
    );
    const descending = executeGraphQuery(
      repoRoot,
      "MATCH (a) WHERE a.path CONTAINS 'src/' RETURN a.path ORDER BY a.path DESC"
    );
    const ascPaths = ascending.rows.map((row) => row['a.path'] as string);
    const descPaths = descending.rows.map((row) => row['a.path'] as string);
    assert.ok(ascPaths.length >= 2, `need >=2 src files, got ${JSON.stringify(ascPaths)}`);
    assert.deepEqual(descPaths, [...ascPaths].reverse(), 'DESC must reverse the default ascending path order');
    assert.deepEqual(descPaths, [...descPaths].sort().reverse(), 'rows must be in descending path order');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('executeGraphQuery surfaces the index run and navigable entity resources for id projections', async () => {
  const repoRoot = await buildRepo();
  try {
    const result = executeGraphQuery(
      repoRoot,
      "MATCH (a) WHERE a.path CONTAINS 'src/alpha.ts' RETURN a.id"
    );
    assert.equal(typeof result.indexRunId, 'number');
    assert.ok(result.indexRunId! > 0, `expected a positive index run id, got ${result.indexRunId}`);
    assert.ok(Array.isArray(result.resources.entities), 'resources.entities must be an array');
    assert.ok(
      result.resources.entities.some((id) => id.includes('alpha')),
      `expected an alpha entity resource id in ${JSON.stringify(result.resources.entities)}`
    );
    // Distinct, navigable ids only — no duplicates.
    assert.equal(
      result.resources.entities.length,
      new Set(result.resources.entities).size,
      'resources.entities must be deduplicated'
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('executeGraphQuery yields no entity resources when no id is projected', async () => {
  const repoRoot = await buildRepo();
  try {
    const result = executeGraphQuery(
      repoRoot,
      "MATCH (a) WHERE a.path CONTAINS 'src/alpha.ts' RETURN a.path"
    );
    // Honest navigation: you can only navigate ids you actually returned.
    assert.deepEqual(result.resources.entities, []);
    assert.equal(typeof result.indexRunId, 'number');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
