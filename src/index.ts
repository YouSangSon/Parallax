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
  TraceEdge,
  TraceInput,
  TraceResult
} from './agent_memory.js';
export { analyzeDiff } from './analyzer.js';
export { analyzeContractDiff } from './contract_diff.js';
export type {
  AnalyzeContractDiffOptions,
  AnalyzeContractDiffResult,
  ContractDiffChange,
  ContractDiffChangeKind,
  ContractDiffClassification,
  ContractDiffContract,
  ContractDiffProvider,
  ImpactedContractConsumer
} from './contract_diff.js';
export { resolveCrossRepoContracts } from './cross_repo_resolver.js';
export type {
  CrossRepoContractLink,
  ResolveCrossRepoContractsOptions,
  ResolveCrossRepoContractsResult
} from './cross_repo_resolver.js';
export { exportImpactGraph } from './graph.js';
export { indexProject } from './indexer.js';
export { initProject } from './init.js';
export { doctorProject, hasDoctorErrors, redactDoctorReportForMcp, REQUIRED_SCHEMA_VERSION } from './doctor.js';
export type { DoctorFinding, DoctorOptions, DoctorReport } from './doctor.js';
export { importSession } from './session_import.js';
export type { SessionImportFormat, SessionImportOptions, SessionImportResult } from './session_import.js';
export { ingestTraces, parseTraceInput } from './trace_promotion.js';
export type { ObservedEdge, TraceIngestSummary } from './trace_promotion.js';
export {
  addWorkspaceRepo,
  initWorkspace,
  listWorkspaces,
  loadWorkspaceCatalog,
  syncWorkspaceCatalog,
  workspaceCatalogPath
} from './workspace.js';
export type {
  AddWorkspaceRepoOptions,
  InitWorkspaceOptions,
  InitWorkspaceResult,
  ListWorkspacesOptions,
  ListWorkspacesResult,
  SyncWorkspaceCatalogOptions,
  SyncWorkspaceCatalogResult,
  WorkspaceCatalog,
  WorkspaceCatalogRepo,
  WorkspaceRepoSummary,
  WorkspaceSummary,
  WorkspaceTrustPolicy
} from './workspace.js';
export { createMcpServer, serveMcp } from './mcp.js';
export { buildUiSnapshot, renderUiHtml, startUiServer } from './ui.js';
export type { UiContextPackSummary, UiCoverageSnapshot, UiGraphPreview, UiReportPreview, UiReportSummary, UiServerOptions, UiSnapshot } from './ui.js';
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
