export type InitOptions = {
  repoRoot: string;
};

export type InitResult = {
  created: boolean;
  configPath: string;
  databasePath: string;
};

export type IndexOptions = {
  repoRoot: string;
  maxFileBytes?: number;
};

export type IndexResult = {
  indexRunId: number;
  // 'incremental' when the prior completed run's graph rows for unchanged files
  // were carried forward (only changed files re-extracted); 'full' otherwise.
  mode: 'full' | 'incremental';
  filesIndexed: number;
  symbolsIndexed: number;
  edgesIndexed: number;
  entitiesIndexed?: number;
  relationsIndexed?: number;
  adaptersUsed?: AdapterUsage[];
  coverage?: IndexCoverage;
};

export type AnalyzeOptions = {
  repoRoot: string;
  changedFiles: string[];
  writeReport?: boolean;
  persistReport?: boolean;
  readOnly?: boolean;
  maxDepth?: number;
  maxFanout?: number;
};

export type GraphExportFormat = 'json' | 'mermaid' | 'dot';

export type GraphExportOptions = {
  repoRoot: string;
  reportId: string;
  format: GraphExportFormat;
};

export type Confidence = 'proven' | 'inferred' | 'heuristic' | 'unknown';

export type Evidence = {
  id: string;
  file: string;
  kind: string;
  snippet: string;
  confidence: Confidence;
  startLine?: number;
  endLine?: number;
  startCol?: number;
  endCol?: number;
  subject?: EntityRef;
  target?: EntityRef;
  relationKind?: string;
  relationConfidence?: Confidence;
  extractorId?: string;
};

export type AffectedFile = {
  path: string;
  reason: string;
  confidence: Confidence;
  depth?: number;
  relationPath?: string[];
};

export type EntityKind =
  | 'file'
  | 'symbol'
  | 'module'
  | 'package'
  | 'test'
  | 'doc'
  | 'config'
  | 'policy'
  | 'proposal'
  | 'prd'
  | 'workflow'
  | 'resource'
  | 'endpoint'
  | 'contract'
  | 'event'
  | 'business_plan'
  | 'requirement'
  | 'decision'
  | 'meeting_note'
  | 'metric'
  | 'customer_artifact'
  | 'task'
  | 'external_entity';

export type RelationKind =
  | 'DEPENDS_ON'
  | 'CALLS'
  | 'IMPORTS'
  | 'EXPORTS'
  | 'IMPLEMENTS'
  | 'EXTENDS'
  | 'READS'
  | 'WRITES'
  | 'RAISES'
  | 'HANDLES'
  | 'OWNS'
  | 'TESTS'
  | 'DOCUMENTS'
  | 'CONFIGURES'
  | 'BREAKS_COMPATIBILITY_WITH'
  | 'REFERENCES'
  | 'DECLARES'
  | 'VERIFIES'
  | 'GOVERNS'
  | 'PROPOSES'
  | 'REQUIRES'
  | 'CO_CHANGES';

export type ScannedFile = {
  absolutePath: string;
  relativePath: string;
  content: string;
  hash: string;
  language: string;
};

export type EntityRef = {
  id: string;
  kind: EntityKind;
  path?: string;
  symbol?: string;
  languageId?: string;
  displayName?: string;
};

export type ImpactTarget = {
  target: EntityRef;
  relations: string[];
  confidence: Confidence;
};

export type ImpactAction = {
  kind: 'verify' | 'review';
  runnerId?: string;
  target: EntityRef;
  command?: string;
  args?: string[];
  display: string;
  confidence: Confidence;
};

export type AdapterUsage = {
  id: string;
  version: string;
  languageIds: string[];
  confidence: Confidence;
  knownGaps: string[];
};

export type AdapterRunInsight = AdapterUsage & {
  status: string;
  errorSummary?: string;
};

export type IndexCoverage = {
  indexedPaths: number;
  skippedPaths: number;
  unsupportedLanguageIds: string[];
  skipped?: IndexCoverageItem[];
};

export type IndexCoverageItem = {
  path: string;
  languageId?: string;
  status: 'indexed' | 'skipped';
  reason: string;
};

export type ImpactReport = {
  id: string;
  indexRunId: number;
  changedFiles: string[];
  affectedFiles: AffectedFile[];
  changed: EntityRef[];
  affected: ImpactTarget[];
  actions: ImpactAction[];
  /**
   * @deprecated Use actions. Kept during the MVP transition for older callers.
   */
  testCommands: ImpactAction[];
  evidence: Evidence[];
  adapterInsights?: AdapterRunInsight[];
  warnings?: string[];
  reportPath?: string;
};

export type ContextBudget = 'brief' | 'standard' | 'deep';
export type ContextPackReusePolicy = 'auto' | 'full' | 'reference';

export type ContextForChangeOptions = {
  repoRoot: string;
  changedFiles: string[];
  budget?: ContextBudget;
  maxDepth?: number;
  maxFanout?: number;
};

export type ContextPackChangedEntity = {
  entity: EntityRef;
  resourceUri: string;
};

export type ContextPackItem = {
  target: EntityRef;
  path: string;
  reason: string;
  confidence: Confidence;
  depth?: number;
  relations: string[];
  resourceUri: string;
};

export type ContextPackCoChange = {
  changedFile: string;
  partner: string;
  coChangeCount: number;
  couplingScore: number;
  confidence: Confidence;
  resourceUri: string;
};

export type ContextPackEvidence = {
  id: string;
  file: string;
  kind: string;
  snippet: string;
  confidence: Confidence;
  resourceUri?: string;
  startLine?: number;
  endLine?: number;
  startCol?: number;
  endCol?: number;
  subject?: EntityRef;
  target?: EntityRef;
  relationKind?: string;
};

export type ContextPackWorkArtifactMetadata = {
  title?: string;
  owner?: string;
  status?: string;
  updatedAt?: string;
  source?: 'frontmatter' | 'heading';
};

export type ContextPackWorkArtifactFreshness = {
  state: 'current' | 'stale' | 'unknown';
  label: string;
  thresholdDays: number;
  ageDays?: number;
};

export type ContextPackWorkArtifact = {
  kind: string;
  path: string;
  displayName: string;
  reason: string;
  confidence: Confidence;
  relations: string[];
  resourceUri: string;
  metadata?: ContextPackWorkArtifactMetadata;
  freshness: ContextPackWorkArtifactFreshness;
};

export type ContextPack = {
  version: 0;
  contextPackId?: string;
  resourceUri?: string;
  contentHash?: string;
  reused?: boolean;
  budget: ContextBudget;
  indexRunId: number;
  summary: string[];
  changed: ContextPackChangedEntity[];
  context: ContextPackItem[];
  coChanges?: ContextPackCoChange[];
  workArtifacts: ContextPackWorkArtifact[];
  adapterInsights?: AdapterRunInsight[];
  actions: ImpactAction[];
  evidence: ContextPackEvidence[];
  resources: {
    contextPack?: string;
    coverage: 'parallax://coverage/latest';
    entities: string[];
    evidence: string[];
  };
  omittedCounts: {
    affected: number;
    workArtifacts: number;
    evidence: number;
    actions: number;
    coChanges: number;
  };
  limits: {
    affectedLimit: number;
    workArtifactLimit: number;
    evidenceLimit: number;
    snippetChars: number;
    affectedTruncated: boolean;
    evidenceTruncated: boolean;
    coChangeLimit: number;
    coChangeTruncated: boolean;
  };
  warnings?: string[];
};

export type GraphNode = {
  id: string;
  label: string;
  kind: EntityKind;
  path?: string;
  group: 'changed' | 'affected' | 'context';
  confidence?: Confidence;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: string;
  confidence: Confidence;
  label: string;
};

export type GraphExport = {
  reportId: string;
  indexRunId: number;
  format: GraphExportFormat;
  nodes: GraphNode[];
  edges: GraphEdge[];
  rendered: string;
};

export type AttributeValueType = 'text' | 'entity_ref' | 'json' | 'int' | 'float';

/**
 * Lifecycle of a fact derived from its attribute. Static facts come from
 * the indexer (code relations like imports, calls, depends_on, affects)
 * and persist as long as the underlying code does. Dynamic facts come
 * from agent activity (observed, verified, concern, ...) and may be
 * superseded, retracted, or summarised over time.
 *
 * The split is recorded in attribute_defs.is_code_relation; this type
 * is the symbolic surface for that binary so downstream code (Profile
 * API, CLI output) can group facts without re-deriving the rule. See
 * docs/invariants.md for the principle that lifecycle is derived, not stored.
 */
export type Lifecycle = 'static' | 'dynamic';

export interface AttributeDef {
  name: string;
  valueType: AttributeValueType;
  isCodeRelation: boolean;
  description: string;
}

export interface Branch {
  id: string;
  name: string;
  headTxId: string | null;
  parentBranchId: string | null;
  createdAt: string;
}

export interface Transaction {
  id: string;
  parentTxId: string | null;
  branchId: string;
  ts: string;
  agent: string;
  indexRunId: number | null;
}

export type FactOp = 'assert' | 'retract';

export interface Fact {
  id: string;
  entityId: string;
  attribute: string;
  valueBlob: string;
  op: FactOp;
  txId: string;
  redacted: boolean;
}

export interface FactProvenance {
  id: string;
  factId: string;
  sourceFactId: string;
}
