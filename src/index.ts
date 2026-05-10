export { createBranch, factLifecycle, mergeBranches, recall, recallOnRepo, recallSemantic, reembedFacts, reindexVec, reindexVecOnRepo, remember, rememberOnRepo, trace, withAgentMemoryDb } from './agent_memory.js';
export type { ReindexVecOptions, ReindexVecResult } from './agent_memory.js';
export type {
  BranchInput,
  BranchResult,
  MergeBranchInput,
  MergeBranchResult,
  RecallInput,
  RecallResult,
  RecalledFact,
  ReembedOptions,
  ReembedResult,
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
export { doctorProject, hasDoctorErrors, redactDoctorReportForMcp, REQUIRED_SCHEMA_VERSION } from './doctor.js';
export type { DoctorFinding, DoctorOptions, DoctorReport } from './doctor.js';
export { importSession } from './session_import.js';
export type { SessionImportFormat, SessionImportOptions, SessionImportResult } from './session_import.js';
export { createMcpServer, serveMcp } from './mcp.js';
export { computeEmbedding, computeEmbeddingSync, STUB_MODEL_NAME } from './embeddings.js';
export type { EmbeddingResult } from './embeddings.js';
export { summarize, STUB_LLM_MODEL } from './llm.js';
export type { ReflectionResult, SummarizeInput } from './llm.js';
export { reflectFacts, repairReflections } from './reflection.js';
export type {
  ReflectOptions,
  ReflectResult,
  ReflectedEntity,
  RepairOptions,
  RepairResult,
  OrphanReflection
} from './reflection.js';
export { abandonBranch, gcBranches, restoreBranch } from './branch_gc.js';
export { profileEntity } from './profile.js';
export type { ProfileOptions, ProfileResult } from './profile.js';
export type {
  AbandonBranchInput,
  AbandonBranchResult,
  GcBranchesOptions,
  GcBranchesResult,
  GcBranchSummary,
  RestoreBranchInput,
  RestoreBranchResult
} from './branch_gc.js';
export { redactSecrets, resolveInsideRoot } from './security.js';
export {
  ensureVecTable,
  hasVecTable,
  isVectorExtensionLoaded,
  loadVectorExtension,
  vecTableName
} from './store.js';
export type {
  AffectedFile,
  AdapterUsage,
  AnalyzeOptions,
  ContextBudget,
  ContextForChangeOptions,
  ContextPack,
  ContextPackChangedEntity,
  ContextPackEvidence,
  ContextPackItem,
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
  InitResult,
  Lifecycle
} from './types.js';
export type { McpContext } from './mcp.js';
