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
  subject?: EntityRef;
  relationKind?: string;
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
  warnings?: string[];
  reportPath?: string;
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
