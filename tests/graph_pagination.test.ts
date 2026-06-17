import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GraphExport } from '../src/types.js';
import { GraphPaginationInputError, paginateGraph } from '../src/graph_pagination.js';

function makeGraph(): GraphExport {
  return {
    reportId: 'report-1',
    indexRunId: 7,
    format: 'json',
    rendered: '{"full":true}',
    nodes: [
      { id: 'node-1', label: 'node 1', kind: 'file', group: 'changed' },
      { id: 'node-2', label: 'node 2', kind: 'file', group: 'affected' }
    ],
    edges: [
      { id: 'edge-1', source: 'node-1', target: 'node-2', kind: 'DEPENDS_ON', confidence: 'proven', label: 'DEPENDS_ON' },
      { id: 'edge-2', source: 'node-2', target: 'node-1', kind: 'REFERENCES', confidence: 'inferred', label: 'REFERENCES' }
    ]
  };
}

test('paginateGraph returns the original graph when pagination is not required and no params are provided', () => {
  const graph = makeGraph();
  assert.equal(paginateGraph(graph), graph);
});

test('paginateGraph returns the first page with stable metadata', () => {
  const page = paginateGraph(makeGraph(), { limit: '1', requirePagination: true });
  assert.deepEqual(page.nodes.map((node) => node.id), ['node-1']);
  assert.deepEqual(page.edges.map((edge) => edge.label), ['DEPENDS_ON']);
  assert.deepEqual(page.page, {
    cursor: null,
    nextCursor: '1:1',
    limit: 1,
    totalNodes: 2,
    totalEdges: 2,
    returnedNodes: 1,
    returnedEdges: 1
  });
});

test('paginateGraph accepts a returned cursor for the next page', () => {
  const page = paginateGraph(makeGraph(), { limit: '1', cursor: '1:1', requirePagination: true });
  assert.deepEqual(page.nodes.map((node) => node.id), ['node-2']);
  assert.deepEqual(page.edges.map((edge) => edge.label), ['REFERENCES']);
  assert.equal(page.page.cursor, '1:1');
  assert.equal(page.page.nextCursor, null);
});

test('paginateGraph rejects invalid limits and cursors with transport-neutral input errors', () => {
  const cases = [
    { options: { limit: 'abc' }, message: /limit/ },
    { options: { cursor: 'bad' }, message: /cursor/ },
    { options: { cursor: '9007199254740992:0' }, message: /safe non-negative integer/ },
    { options: { cursor: '999:0' }, message: /outside/ }
  ];

  for (const item of cases) {
    assert.throws(
      () => paginateGraph(makeGraph(), { ...item.options, requirePagination: true }),
      (error: unknown) => {
        assert.ok(error instanceof GraphPaginationInputError);
        assert.match(error.message, item.message);
        return true;
      }
    );
  }
});
