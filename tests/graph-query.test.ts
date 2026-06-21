import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseGraphQuery } from '../src/graph_query.js';

// parseGraphQuery accepts a deliberately small, read-only Cypher subset and
// rejects everything else with a clear error. Pure, so parsing is testable
// without a database.

test('parses a single-hop MATCH ... RETURN', () => {
  const q = parseGraphQuery('MATCH (a)-[r]->(b) RETURN a, b');
  assert.equal(q.source.variable, 'a');
  assert.equal(q.target?.variable, 'b');
  assert.equal(q.relationship?.variable, 'r');
  assert.deepEqual(q.returns, [
    { variable: 'a' },
    { variable: 'b' }
  ]);
});

test('parses labels, relationship type, WHERE equality, property return and LIMIT', () => {
  const q = parseGraphQuery(
    "MATCH (a:File)-[r:DEPENDS_ON]->(b:File) WHERE a.path = 'src/x.ts' RETURN b.path LIMIT 5"
  );
  assert.equal(q.source.label, 'File');
  assert.equal(q.relationship?.type, 'DEPENDS_ON');
  assert.equal(q.target?.label, 'File');
  assert.deepEqual(q.where, [{ variable: 'a', property: 'path', op: '=', value: 'src/x.ts' }]);
  assert.deepEqual(q.returns, [{ variable: 'b', property: 'path' }]);
  assert.equal(q.limit, 5);
});

test('parses CONTAINS and multiple AND conditions', () => {
  const q = parseGraphQuery(
    "MATCH (a)-[r]->(b) WHERE a.path CONTAINS 'store' AND r.kind = 'CALLS' RETURN a.path, r.kind"
  );
  assert.deepEqual(q.where, [
    { variable: 'a', property: 'path', op: 'CONTAINS', value: 'store' },
    { variable: 'r', property: 'kind', op: '=', value: 'CALLS' }
  ]);
});

test('parses a node-only MATCH with no relationship', () => {
  const q = parseGraphQuery("MATCH (a:File) WHERE a.path CONTAINS 'cli' RETURN a.path");
  assert.equal(q.relationship, undefined);
  assert.equal(q.target, undefined);
});

test('parses a reverse-direction hop by normalizing to the true source/target', () => {
  // (x)<-[r]-(d) means d -> x; normalize so source=d, target=x.
  const q = parseGraphQuery("MATCH (x)<-[r:DEPENDS_ON]-(d) WHERE x.path = 'src/store.ts' RETURN d.path");
  assert.equal(q.source.variable, 'd');
  assert.equal(q.target?.variable, 'x');
  assert.equal(q.relationship?.type, 'DEPENDS_ON');
  assert.deepEqual(q.where, [{ variable: 'x', property: 'path', op: '=', value: 'src/store.ts' }]);
  assert.deepEqual(q.returns, [{ variable: 'd', property: 'path' }]);
});

test('parses variable-length relationship paths', () => {
  const range = parseGraphQuery('MATCH (a)-[r:DEPENDS_ON*1..3]->(b) RETURN a.path, b.path');
  assert.deepEqual(range.relationship?.pathLength, { min: 1, max: 3 });

  const star = parseGraphQuery('MATCH (a)-[:DEPENDS_ON*]->(b) RETURN b.path');
  assert.deepEqual(star.relationship?.pathLength, { min: 1, max: 8 });

  const exact = parseGraphQuery('MATCH (a)-[:CALLS*2]->(b) RETURN b.path');
  assert.deepEqual(exact.relationship?.pathLength, { min: 2, max: 2 });

  // max is capped at MAX_HOPS (8).
  const capped = parseGraphQuery('MATCH (a)-[:CALLS*1..50]->(b) RETURN b.path');
  assert.equal(capped.relationship?.pathLength?.max, 8);
});

test('rejects projecting the relationship variable of a variable-length path', () => {
  // A *N..M path has no single edge binding, so r.kind is unknown.
  assert.throws(
    () => parseGraphQuery('MATCH (a)-[r:DEPENDS_ON*1..3]->(b) RETURN r.kind'),
    /unknown variable in RETURN: r/i
  );
});

test('parses ORDER BY with direction, before LIMIT', () => {
  const q = parseGraphQuery('MATCH (a) RETURN a.path ORDER BY a.path DESC LIMIT 5');
  assert.deepEqual(q.returns, [{ variable: 'a', property: 'path' }]);
  assert.deepEqual(q.orderBy, [{ column: 'a.path', direction: 'DESC' }]);
  assert.equal(q.limit, 5);
});

test('parses multi-key ORDER BY defaulting to ASC', () => {
  const q = parseGraphQuery('MATCH (a)-[r:DEPENDS_ON]->(b) RETURN a.path, b.path ORDER BY b.path, a.path DESC');
  assert.deepEqual(q.orderBy, [
    { column: 'b.path', direction: 'ASC' },
    { column: 'a.path', direction: 'DESC' }
  ]);
});

test('rejects ORDER BY on a column that is not projected', () => {
  assert.throws(
    () => parseGraphQuery('MATCH (a) RETURN a.path ORDER BY a.kind'),
    /ORDER BY/i
  );
});

test('rejects write clauses and unsupported syntax', () => {
  assert.throws(() => parseGraphQuery("CREATE (a) RETURN a"), /unsupported|read-only|MATCH/i);
  assert.throws(() => parseGraphQuery("MATCH (a) DELETE a"), /unsupported|read-only|DELETE/i);
  assert.throws(() => parseGraphQuery("MATCH (a)<-[r]->(b) RETURN a"), /bidirectional|unsupported/i);
  assert.throws(() => parseGraphQuery("MATCH (a) RETURN"), /RETURN/i);
});
