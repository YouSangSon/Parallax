export { analyzeDiff } from './analyzer.js';
export { indexProject } from './indexer.js';
export { initProject } from './init.js';
export { handleMcpRequest } from './mcp.js';
export { redactSecrets, resolveInsideRoot } from './security.js';
export type {
  AffectedFile,
  AnalyzeOptions,
  Evidence,
  ImpactReport,
  IndexOptions,
  IndexResult,
  InitOptions,
  InitResult,
  JsonRpcRequest,
  JsonRpcResponse
} from './types.js';

