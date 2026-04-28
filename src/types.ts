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
};

export type IndexResult = {
  indexRunId: number;
  filesIndexed: number;
  symbolsIndexed: number;
  edgesIndexed: number;
};

export type AnalyzeOptions = {
  repoRoot: string;
  changedFiles: string[];
  writeReport?: boolean;
};

export type Confidence = 'proven' | 'inferred' | 'heuristic' | 'unknown';

export type Evidence = {
  id: string;
  file: string;
  kind: string;
  snippet: string;
  confidence: Confidence;
};

export type AffectedFile = {
  path: string;
  reason: string;
  confidence: Confidence;
};

export type ImpactReport = {
  id: string;
  indexRunId: number;
  changedFiles: string[];
  affectedFiles: AffectedFile[];
  testCommands: string[];
  evidence: Evidence[];
  reportPath?: string;
};
