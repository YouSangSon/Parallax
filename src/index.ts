export { analyzeDiff } from './analyzer.js';
export { exportImpactGraph } from './graph.js';
export { indexProject } from './indexer.js';
export { initProject } from './init.js';
export { createMcpServer, serveMcp } from './mcp.js';
export { redactSecrets, resolveInsideRoot } from './security.js';
export type {
  AffectedFile,
  AdapterUsage,
  AnalyzeOptions,
  EntityKind,
  EntityRef,
  Evidence,
  GraphEdge,
  GraphExport,
  GraphExportFormat,
  GraphExportOptions,
  GraphNode,
  ImpactAction,
  ImpactTarget,
  ImpactReport,
  IndexCoverage,
  IndexCoverageItem,
  IndexOptions,
  IndexResult,
  InitOptions,
  InitResult
} from './types.js';
export type { McpContext } from './mcp.js';
