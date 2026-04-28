export { analyzeDiff } from './analyzer.js';
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
  ImpactAction,
  ImpactTarget,
  ImpactReport,
  IndexCoverage,
  IndexOptions,
  IndexResult,
  InitOptions,
  InitResult
} from './types.js';
export type { McpContext } from './mcp.js';
