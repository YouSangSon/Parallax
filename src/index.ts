export { createBranch, mergeBranches, recall, remember, trace, withAgentMemoryDb } from './agent_memory.js';
export type {
  BranchInput,
  BranchResult,
  MergeBranchInput,
  MergeBranchResult,
  RecallInput,
  RecallResult,
  RecalledFact,
  RememberInput,
  RememberResult,
  RememberValue,
  TraceInput,
  TraceResult
} from './agent_memory.js';
export { analyzeDiff } from './analyzer.js';
export { exportImpactGraph } from './graph.js';
export { indexProject } from './indexer.js';
export { initProject } from './init.js';
export { createMcpServer, serveMcp } from './mcp.js';
export { computeEmbedding } from './embeddings.js';
export type { EmbeddingResult } from './embeddings.js';
export { redactSecrets, resolveInsideRoot } from './security.js';
export { loadVectorExtension } from './store.js';
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
