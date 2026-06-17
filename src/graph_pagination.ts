import type { GraphEdge, GraphExport, GraphNode } from './types.js';

export type GraphPagePayload = {
  reportId: GraphExport['reportId'];
  indexRunId: GraphExport['indexRunId'];
  format: GraphExport['format'];
  nodes: GraphNode[];
  edges: GraphEdge[];
  page: {
    cursor: string | null;
    nextCursor: string | null;
    limit: number;
    totalNodes: number;
    totalEdges: number;
    returnedNodes: number;
    returnedEdges: number;
  };
};

export type GraphPaginationOptions = {
  limit?: string | null;
  cursor?: string | null;
  requirePagination?: boolean;
};

type GraphPageCursor = {
  nodeOffset: number;
  edgeOffset: number;
};

export class GraphPaginationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphPaginationInputError';
  }
}

export function paginateGraph(graph: GraphExport): GraphExport;
export function paginateGraph(graph: GraphExport, options: GraphPaginationOptions & { requirePagination: true }): GraphPagePayload;
export function paginateGraph(graph: GraphExport, options: GraphPaginationOptions): GraphPagePayload | GraphExport;
export function paginateGraph(graph: GraphExport, options?: GraphPaginationOptions): GraphPagePayload | GraphExport {
  const limitRaw = options?.limit ?? null;
  const cursorRaw = options?.cursor ?? null;
  const shouldPaginate = options?.requirePagination === true || limitRaw !== null || cursorRaw !== null;
  if (!shouldPaginate) return graph;

  const limit = parseGraphPageLimit(limitRaw);
  const cursor = parseGraphPageCursor(cursorRaw);
  validateGraphPageCursor(cursor, graph);

  const nodes = graph.nodes.slice(cursor.nodeOffset, cursor.nodeOffset + limit);
  const edges = graph.edges.slice(cursor.edgeOffset, cursor.edgeOffset + limit);
  const nextNodeOffset = cursor.nodeOffset + nodes.length;
  const nextEdgeOffset = cursor.edgeOffset + edges.length;
  const nextCursor =
    nextNodeOffset < graph.nodes.length || nextEdgeOffset < graph.edges.length
      ? `${nextNodeOffset}:${nextEdgeOffset}`
      : null;

  return {
    reportId: graph.reportId,
    indexRunId: graph.indexRunId,
    format: graph.format,
    nodes,
    edges,
    page: {
      cursor: cursorRaw,
      nextCursor,
      limit,
      totalNodes: graph.nodes.length,
      totalEdges: graph.edges.length,
      returnedNodes: nodes.length,
      returnedEdges: edges.length
    }
  };
}

function parseGraphPageLimit(value: string | null): number {
  if (value === null) return 100;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new GraphPaginationInputError('graph page limit must be an integer between 1 and 500');
  }
  return limit;
}

function parseGraphPageCursor(value: string | null): GraphPageCursor {
  if (value === null) return { nodeOffset: 0, edgeOffset: 0 };
  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) {
    throw new GraphPaginationInputError('graph page cursor must be returned by a previous graph JSON page');
  }
  return {
    nodeOffset: parseGraphCursorOffset(match[1]!, 'node'),
    edgeOffset: parseGraphCursorOffset(match[2]!, 'edge')
  };
}

function parseGraphCursorOffset(value: string, label: 'node' | 'edge'): number {
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new GraphPaginationInputError(`graph page cursor ${label} offset must be a safe non-negative integer`);
  }
  return offset;
}

function validateGraphPageCursor(cursor: GraphPageCursor, graph: GraphExport): void {
  if (cursor.nodeOffset > graph.nodes.length || cursor.edgeOffset > graph.edges.length) {
    throw new GraphPaginationInputError('graph page cursor is outside the current graph bounds');
  }
}
