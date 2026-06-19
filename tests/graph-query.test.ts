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

test('rejects write clauses and unsupported syntax', () => {
  assert.throws(() => parseGraphQuery("CREATE (a) RETURN a"), /unsupported|read-only|MATCH/i);
  assert.throws(() => parseGraphQuery("MATCH (a) DELETE a"), /unsupported|read-only|DELETE/i);
  assert.throws(() => parseGraphQuery("MATCH (a)<-[r]-(b) RETURN a"), /direction|unsupported/i);
  assert.throws(() => parseGraphQuery("MATCH (a) RETURN"), /RETURN/i);
});
