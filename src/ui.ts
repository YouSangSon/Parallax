import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import type { MarkdownArtifactMetadata } from './artifacts.js';
import { PACKAGE_NAME } from './branding.js';
import { doctorProject, type DoctorReport } from './doctor.js';
import { exportImpactGraph } from './graph.js';
import { GraphPaginationInputError, paginateGraph } from './graph_pagination.js';
import { databasePath, getRepoId, impactDir, openDatabase } from './store.js';
import { normalizeRepoRoot, resolveInsideRoot } from './security.js';
import type { GraphExport, ImpactAction, ImpactReport } from './types.js';
import { UI_CLIENT_JS } from './ui/client.js';
import { renderImpactMapPanel } from './ui/impact_map.js';
import {
  buildImpactLanes,
  evidenceCountByImpactPath,
  renderActionRow,
  renderImpactPathRow,
  renderImpactSummaryPanel,
  renderImpactTriageStrip
} from './ui/panels.js';
import {
  comparisonBucket,
  defaultReportDeltaPolicy,
  policyNumberAt,
  renderReportDeltaPanel,
  reportDeltaPolicyPresets,
  reportDeltaPolicyReason,
  reportDeltaSummary,
  reportReviewLoad
} from './ui/report_delta.js';
import {
  graphPreview,
  readContextPack,
  readContextPacks,
  readLatestCoverage,
  readReport,
  readWorkspace,
  readWorkspaceSnapshots,
  reportPreviewFromRow,
  reportSummaryFromRow,
  workArtifactMetadataText,
  workArtifactsFromReportRow
} from './ui/data.js';
import {
  actionByTargetPath,
  errorMessage,
  escapeHtml,
  evidenceSourceLocation,
  objectAt
} from './ui/shared.js';
import { UI_STYLES_MAIN, UI_STYLES_SOURCE_VIEWER } from './ui/styles.js';

export type UiOptions = {
  repoRoot: string;
  reportId?: string;
};

export type UiServerOptions = UiOptions & {
  host?: string;
  port?: number;
};

export type ImpactLaneId = 'code' | 'tests' | 'knowledge' | 'contracts' | 'config' | 'crossRepo';
export type ImpactLaneTone = 'green' | 'amber' | 'teal' | 'blue' | 'red';
type ReportDeltaSummary = 'wider' | 'narrower' | 'unchanged';

export type UiSnapshot = {
  version: 0;
  generatedAt: string;
  repoRoot: string;
  selectedReportId: string | null;
  doctor: DoctorReport;
  errors: UiError[];
  reports: UiReportSummary[];
  selectedReport: UiReportPreview | null;
  graph: UiGraphPreview | null;
  coverage: UiCoverageSnapshot | null;
  contextPacks: UiContextPackSummary[];
  workArtifacts: UiWorkArtifactImpact[];
  workspaces: UiWorkspaceSnapshot[];
  comparison: UiReportComparison | null;
};

export type UiError = {
  code: string;
  message: string;
  fix?: string;
};

export type UiReportSummary = {
  id: string;
  indexRunId: number;
  createdAt: string;
  changedFiles: string[];
  changedCount: number;
  affectedCount: number;
  evidenceCount: number;
  actionCount: number;
};

export type UiReportPreview = UiReportSummary & {
  changed: ImpactReport['changed'];
  affectedFiles: ImpactReport['affectedFiles'];
  evidence: UiEvidencePreview[];
  crossRepoImpacts: NonNullable<ImpactReport['crossRepoImpacts']>;
  adapterInsights: NonNullable<ImpactReport['adapterInsights']>;
  actions: ImpactAction[];
  warnings: string[];
};

export type UiReportComparison = {
  baseReportId: string;
  baseCreatedAt: string;
  summary: ReportDeltaSummary;
  reviewLoadCurrent: number;
  reviewLoadPrevious: number;
  reviewLoadDelta: number;
  policy: UiReportDeltaPolicy;
  policyReason: string;
  policyPresets: UiReportDeltaPolicyPreset[];
  changedDelta: number;
  affectedDelta: number;
  evidenceDelta: number;
  actionDelta: number;
  addedAffectedPaths: string[];
  removedAffectedPaths: string[];
  addedAffectedFiles: UiReportComparisonAffectedFile[];
  removedAffectedFiles: UiReportComparisonAffectedFile[];
  addedActionTargets: string[];
  removedActionTargets: string[];
  confidenceDeltas: UiReportComparisonBucket[];
  laneDeltas: UiReportComparisonLane[];
};

export type UiReportComparisonAffectedFile = UiReportPreview['affectedFiles'][number];

export type UiReportComparisonBucket = {
  label: string;
  current: number;
  previous: number;
  delta: number;
};

export type UiReportComparisonLane = {
  id: ImpactLaneId;
  label: string;
  tone: ImpactLaneTone;
  current: number;
  previous: number;
  delta: number;
  topPath?: string;
};

export type UiReportDeltaPolicy = {
  source: 'default' | 'config';
  widenThreshold: number;
  narrowThreshold: number;
  weights: {
    affected: number;
    actions: number;
    evidence: number;
  };
};

export type UiReportDeltaPolicyPreset = {
  id: string;
  label: string;
  summary: ReportDeltaSummary;
  reviewLoadDelta: number;
  widenThreshold: number;
  narrowThreshold: number;
  weights: UiReportDeltaPolicy['weights'];
};

export type UiEvidencePreview = ImpactReport['evidence'][number] & {
  snippetOmitted?: boolean;
  omittedReason?: string;
  resourceUri?: string;
};

export type UiGraphPreview = {
  nodes: GraphExport['nodes'];
  edges: GraphExport['edges'];
  totalNodes: number;
  totalEdges: number;
};

export type UiContextPackSummary = {
  id: string;
  budget: string;
  indexRunId: number;
  returnedBytes: number;
  hitCount: number;
  createdAt: string;
  lastAccessedAt: string;
};

export type UiCoverageSnapshot = {
  indexRunId: number;
  coverage: Array<{
    path: string;
    languageId: string | null;
    status: string;
    reason: string;
    adapterId: string;
  }>;
  limit: number;
  truncated: boolean;
};

export type UiWorkArtifactImpact = {
  kind: string;
  path: string;
  displayName: string;
  reason: string;
  confidence: string;
  relations: string[];
  resourceUri: string;
  depth?: number;
  metadata?: MarkdownArtifactMetadata;
  freshness: UiWorkArtifactFreshness;
};

export type UiWorkArtifactFreshness = {
  state: 'current' | 'stale' | 'unknown';
  label: string;
  thresholdDays: number;
  ageDays?: number;
};

export type UiWorkspaceSnapshot = {
  name: string;
  repoCount: number;
  contracts: UiWorkspaceContract[];
  links: UiWorkspaceLink[];
  warnings: string[];
  resources: {
    workspace: string;
    contracts: string;
    crossRepoLinks: string;
  };
  limits: {
    contracts: number;
    links: number;
    contractsTruncated: boolean;
    linksTruncated: boolean;
  };
};

export type UiWorkspaceContract = {
  id: string;
  serviceName: string;
  repoPath: string;
  path: string;
  kind: string;
  indexRunId: number;
  endpointCount: number;
  schemaVersion?: string;
};

export type UiWorkspaceLink = {
  id: string;
  kind: string;
  confidence: string;
  sourceService: string;
  targetService: string;
  routeLabel?: string;
  consumerPath?: string;
  providerContractPath?: string;
  eventTopology?: {
    providerAction: string;
    counterpartyRole: 'consumer' | 'producer' | 'unknown';
    pattern: string;
  };
};

export type ReportRow = {
  id: string;
  index_run_id: number;
  json: string;
  created_at: string;
};

class UiClientInputError extends Error {
  readonly code = 'invalid_request';

  constructor(message: string) {
    super(message);
    this.name = 'UiClientInputError';
  }
}

type SourceLocation = {
  href: string;
  label: string;
  line: number;
};

export type ImpactMapNode = {
  id: string;
  label: string;
  kind: string;
  group: 'changed' | 'affected' | 'context';
  confidence?: string;
  laneLabel?: string;
  laneTone?: ImpactLaneTone;
  path?: string;
};

export type ImpactMapEdge = {
  from: string;
  to: string;
  label: string;
  confidence: string;
  targetPath?: string;
};

export type ImpactLane = {
  id: ImpactLaneId;
  label: string;
  count: number;
  summary: string;
  tone: ImpactLaneTone;
  topPath?: string;
};

export async function buildUiSnapshot(options: UiOptions): Promise<UiSnapshot> {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const doctor = doctorProject({ repoRoot });
  const generatedAt = new Date().toISOString();
  if (!doctor.database.exists || !existsSync(databasePath(repoRoot))) {
    return {
      version: 0,
      generatedAt,
      repoRoot,
      selectedReportId: null,
      doctor,
      errors: [{
        code: 'database_missing',
        message: 'Impact database not found for this repository.',
        fix: `Run ${PACKAGE_NAME} init and ${PACKAGE_NAME} index before opening the UI.`
      }],
      reports: [],
      selectedReport: null,
      graph: null,
      coverage: null,
      contextPacks: [],
      workArtifacts: [],
      workspaces: [],
      comparison: null
    };
  }

  const db = openDatabase(repoRoot, { readOnly: true });
  try {
    const repoId = getRepoId(db, repoRoot);
    const reportRows = db
      .prepare('SELECT id, index_run_id, json, created_at FROM reports WHERE repo_id = ? ORDER BY created_at DESC, id DESC LIMIT 20')
      .all(repoId) as ReportRow[];
    const requestedReport = options.reportId
      ? reportRows.find((row) => row.id === options.reportId)
        ?? db
          .prepare('SELECT id, index_run_id, json, created_at FROM reports WHERE repo_id = ? AND id = ?')
          .get(repoId, options.reportId) as ReportRow | undefined
        ?? null
      : undefined;
    const selectorRows =
      requestedReport && !reportRows.some((row) => row.id === requestedReport.id)
        ? [requestedReport, ...reportRows.slice(0, 19)]
        : reportRows;
    const reports = selectorRows.map(reportSummaryFromRow);
    const errors: UiError[] = [];
    if (options.reportId && !requestedReport) {
      errors.push({
        code: 'report_not_found',
        message: `Impact report not found: ${options.reportId}`,
        fix: `Choose a report from the selector or run ${PACKAGE_NAME} analyze to create a current report.`
      });
    } else if (!options.reportId && reportRows.length === 0) {
      errors.push({
        code: 'report_missing',
        message: 'No persisted impact reports were found.',
        fix: `Run ${PACKAGE_NAME} analyze --changed <path> to create a report.`
      });
    }
    const selectedRow = requestedReport ?? (options.reportId ? null : reportRows[0] ?? null);
    const selectedReport = selectedRow ? reportPreviewFromRow(selectedRow) : null;
    const graph = selectedRow ? await graphPreview(repoRoot, selectedRow.id) : null;
    const reportDeltaPolicy = readReportDeltaPolicy(repoRoot);
    const comparison = selectedRow ? readReportComparison(db, repoId, selectedRow, reportDeltaPolicy) : null;
    return {
      version: 0,
      generatedAt,
      repoRoot,
      selectedReportId: selectedRow?.id ?? null,
      doctor,
      errors,
      reports,
      selectedReport,
      graph,
      coverage: readLatestCoverage(db, repoId),
      contextPacks: readContextPacks(db, repoId),
      workArtifacts: selectedRow ? workArtifactsFromReportRow(selectedRow) : [],
      workspaces: readWorkspaceSnapshots(db),
      comparison
    };
  } finally {
    db.close();
  }
}

function readReportDeltaPolicy(repoRoot: string): UiReportDeltaPolicy {
  const fallback = defaultReportDeltaPolicy();
  const configPath = path.join(impactDir(repoRoot), 'config.json');
  if (!existsSync(configPath)) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch {
    return fallback;
  }
  const rawPolicy = objectAt(objectAt(parsed, 'ui'), 'reportDeltaPolicy');
  if (!rawPolicy) return fallback;
  const rawWeights = objectAt(rawPolicy, 'weights');
  return {
    source: 'config',
    widenThreshold: policyNumberAt(rawPolicy, 'widenThreshold', 1, 1_000) ?? fallback.widenThreshold,
    narrowThreshold: policyNumberAt(rawPolicy, 'narrowThreshold', 1, 1_000) ?? fallback.narrowThreshold,
    weights: {
      affected: rawWeights ? policyNumberAt(rawWeights, 'affected', 0, 1_000) ?? fallback.weights.affected : fallback.weights.affected,
      actions: rawWeights ? policyNumberAt(rawWeights, 'actions', 0, 1_000) ?? fallback.weights.actions : fallback.weights.actions,
      evidence: rawWeights ? policyNumberAt(rawWeights, 'evidence', 0, 1_000) ?? fallback.weights.evidence : fallback.weights.evidence
    }
  };
}

function readReportComparison(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  selectedRow: ReportRow,
  policy: UiReportDeltaPolicy
): UiReportComparison | null {
  const previousRow = db
    .prepare(`
      SELECT id, index_run_id, json, created_at
      FROM reports
      WHERE repo_id = ?
        AND (created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `)
    .get(repoId, selectedRow.created_at, selectedRow.created_at, selectedRow.id) as ReportRow | undefined;
  return previousRow ? reportComparisonFromRows(selectedRow, previousRow, policy) : null;
}

function reportComparisonFromRows(
  currentRow: ReportRow,
  previousRow: ReportRow,
  policy: UiReportDeltaPolicy
): UiReportComparison {
  const current = reportPreviewFromRow(currentRow);
  const previous = reportPreviewFromRow(previousRow);
  const currentAffectedPaths = new Set(current.affectedFiles.map((item) => item.path));
  const previousAffectedPaths = new Set(previous.affectedFiles.map((item) => item.path));
  const addedAffectedFiles = sortedAffectedFileDifference(current.affectedFiles, previousAffectedPaths);
  const removedAffectedFiles = sortedAffectedFileDifference(previous.affectedFiles, currentAffectedPaths);
  const currentActionTargets = actionTargetLabels(current.actions);
  const previousActionTargets = actionTargetLabels(previous.actions);
  const currentLoad = reportReviewLoad(current, policy);
  const previousLoad = reportReviewLoad(previous, policy);
  const reviewLoadDelta = currentLoad - previousLoad;
  const summary = reportDeltaSummary(reviewLoadDelta, policy);
  const currentLanes = buildImpactLanes(current, workArtifactsFromReportRow(currentRow));
  const previousLanesById = new Map(
    buildImpactLanes(previous, workArtifactsFromReportRow(previousRow)).map((lane) => [lane.id, lane])
  );

  return {
    baseReportId: previous.id,
    baseCreatedAt: previous.createdAt,
    summary,
    reviewLoadCurrent: currentLoad,
    reviewLoadPrevious: previousLoad,
    reviewLoadDelta,
    policy,
    policyReason: reportDeltaPolicyReason(summary, reviewLoadDelta, policy),
    policyPresets: reportDeltaPolicyPresets(current, previous, policy),
    changedDelta: current.changedCount - previous.changedCount,
    affectedDelta: current.affectedCount - previous.affectedCount,
    evidenceDelta: current.evidenceCount - previous.evidenceCount,
    actionDelta: current.actionCount - previous.actionCount,
    addedAffectedPaths: addedAffectedFiles.map((item) => item.path),
    removedAffectedPaths: removedAffectedFiles.map((item) => item.path),
    addedAffectedFiles,
    removedAffectedFiles,
    addedActionTargets: sortedSetDifference(currentActionTargets, previousActionTargets),
    removedActionTargets: sortedSetDifference(previousActionTargets, currentActionTargets),
    confidenceDeltas: ['proven', 'inferred', 'heuristic', 'unknown'].map((label) =>
      comparisonBucket(
        label,
        current.affectedFiles.filter((item) => item.confidence === label).length,
        previous.affectedFiles.filter((item) => item.confidence === label).length
      )
    ),
    laneDeltas: currentLanes.map((lane) => {
      const previousLane = previousLanesById.get(lane.id);
      return {
        id: lane.id,
        label: lane.label,
        tone: lane.tone,
        current: lane.count,
        previous: previousLane?.count ?? 0,
        delta: lane.count - (previousLane?.count ?? 0),
        ...(lane.topPath ? { topPath: lane.topPath } : {})
      };
    })
  };
}

function actionTargetLabels(actions: readonly ImpactAction[]): Set<string> {
  return new Set(actions.map((action) =>
    action.target.path ?? action.target.displayName ?? action.target.symbol ?? action.target.id
  ));
}

function sortedSetDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((item) => !right.has(item)).sort((a, b) => a.localeCompare(b));
}

function sortedAffectedFileDifference(
  affectedFiles: readonly UiReportPreview['affectedFiles'][number][],
  excludedPaths: ReadonlySet<string>
): UiReportComparisonAffectedFile[] {
  return affectedFiles
    .filter((item) => !excludedPaths.has(item.path))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export type UiLanguage = 'en' | 'ko' | 'zh';

const UI_LANGUAGES: readonly UiLanguage[] = ['en', 'ko', 'zh'];
const UI_LANGUAGE_LABELS: Record<UiLanguage, string> = { en: 'English', ko: '한국어', zh: '中文' };

type UiMessageKey =
  | 'eyebrow' | 'workbench' | 'controls' | 'reportSelector' | 'noReports' | 'selectReport'
  | 'filterPlaceholder' | 'filterRows' | 'metrics' | 'indexStatus' | 'changed' | 'affected'
  | 'evidence' | 'actions' | 'coverageGapsMetric' | 'workArtifactsMetric' | 'workspacesMetric'
  | 'changeSet' | 'verificationQueue' | 'impactPaths' | 'evidencePanel' | 'workArtifacts'
  | 'doctorFindings' | 'contextPacks' | 'adapterConfidence' | 'workspaceContracts'
  | 'workspaceResources' | 'coverageGaps' | 'resourceContract' | 'language'
  // Sub-headings and section titles
  | 'impactSummary' | 'topImpact' | 'analysisTrust' | 'coverage' | 'adapters' | 'knownGaps'
  | 'impactTriage' | 'reportDelta' | 'addedImpact' | 'removedImpact' | 'policyPresets'
  | 'impactMap' | 'topRoutes' | 'primaryImpactFlow' | 'impactInspector' | 'confidence'
  | 'relationPath' | 'evidenceHits' | 'topEvidence'
  // Inline labels
  | 'blastRadius' | 'changedRoot' | 'affectedTargets' | 'nextVerification' | 'affectedTargetEmpty'
  | 'contextNode' | 'source' | 'target' | 'affectedTargetRole' | 'changedInput'
  | 'targets' | 'totalAffected' | 'totalTargets' | 'mappedPaths' | 'confidenceInline'
  | 'runtimeCode' | 'testsToVerify' | 'docsPolicy' | 'contractsLane' | 'crossRepoLane' | 'configInfra'
  | 'noSourceFilesAffected' | 'noTestTargetDetected' | 'noKnowledgeArtifactAffected'
  | 'noApiContractAffected' | 'noCrossRepoImpact' | 'noConfigSurfaceAffected' | 'moreAffected'
  | 'impactVerdict' | 'readyToVerify' | 'evidenceReady' | 'reviewBeforeChange'
  | 'needsEvidence' | 'commandReady' | 'noCommandShort'
  | 'backToWorkbench' | 'lineLabel'
  // Buttons / actions
  | 'copy' | 'copyConfig' | 'copyVerify' | 'copyCopied' | 'copyFailed' | 'verify' | 'review'
  // Trust state labels
  | 'reviewGaps' | 'useWithGaps' | 'readyToUse'
  | 'noSkippedPaths' | 'confidenceMetadataPresent' | 'openLimitations' | 'noneReported'
  // Impact triage empty / labels
  | 'noSelectedReport' | 'none' | 'noTargets' | 'noDisplayedPaths' | 'noVerificationActionShort'
  | 'noVerificationTarget' | 'noAffectedTargetInline'
  // Report delta headlines
  | 'impactWidened' | 'impactNarrowed' | 'impactUnchanged'
  | 'reviewLoad' | 'affectedPaths' | 'delta' | 'savedReportComparison'
  | 'stableConfidence' | 'affectedWeight' | 'actionWeight' | 'evidenceWeight'
  | 'inspectImpact' | 'noLongerAffected' | 'vsPrevious'
  // Empty states
  | 'emptyRunAnalyzeBlast' | 'emptyNoAffectedTargets' | 'emptyNoChangedEntities'
  | 'emptyNoGraphNodes' | 'emptyNoVisiblePaths' | 'emptyRunAnalyzeReport'
  | 'emptyNoActionsQueued' | 'emptyNoImpactPaths' | 'emptyNoEvidence'
  | 'emptyNoWorkArtifacts' | 'emptyNoDoctorFindings' | 'emptyNoContextPacks'
  | 'emptyNoAdapterConfidence' | 'emptyNoWorkspaceContracts' | 'emptyNoWorkspaceResources'
  | 'emptyNoCoverageRows'
  // Inspector empty / placeholders
  | 'noAffectedTargetSelected' | 'selectAffectedTarget' | 'noVerificationActionRecorded'
  | 'noCommandRecorded' | 'noSourceSpanRecorded' | 'noMatchingEvidence'
  | 'directOrNotRecorded'
  // Map roles / labels
  | 'impactPathLabel' | 'changedRootLabel'
  // aria-labels
  | 'ariaImpactSummary' | 'ariaAffectedByConfidence' | 'ariaAffectedByLane' | 'ariaTrustSignals'
  | 'ariaKnownGapPreview' | 'ariaImpactTriage' | 'ariaSavedReportComparison'
  | 'ariaConfidenceDelta' | 'ariaPolicyWeights' | 'ariaPresetComparison' | 'ariaDeltaMetricsList'
  | 'ariaImpactMap' | 'ariaImpactMapLegend' | 'ariaImpactMapSymbols' | 'ariaVisibleRoutes'
  | 'ariaRankedRoutes' | 'ariaPrimaryImpactFlow' | 'ariaNextVerificationCommand'
  | 'ariaCopyMapCommand' | 'ariaImpactInspector' | 'ariaCopyInspectorCommand'
  | 'ariaImpactVerdict'
  | 'ariaRelationTrail' | 'ariaMapSvg' | 'ariaInspectImpactPath' | 'ariaOpenSourceLabel'
  | 'ariaCopyConfigPrefix' | 'ariaCopyCommandSuffix' | 'ariaCopyVerifyForPrefix'
  | 'ariaImpactOverview' | 'ariaImpactWorkbench';

export type UiMessages = Record<UiMessageKey, string>;

const UI_MESSAGES: Record<UiLanguage, UiMessages> = {
  en: {
    eyebrow: 'Parallax local impact intelligence', workbench: 'Impact Workbench',
    controls: 'Workbench controls', reportSelector: 'Report selector', noReports: 'No reports',
    selectReport: 'Select a report', filterPlaceholder: 'Filter paths, evidence, actions',
    filterRows: 'Filter workbench rows', metrics: 'Repository and report metrics',
    indexStatus: 'Index status', changed: 'Changed', affected: 'Affected', evidence: 'Evidence',
    actions: 'Actions', coverageGapsMetric: 'Coverage gaps', workArtifactsMetric: 'Work artifacts',
    workspacesMetric: 'Workspaces', changeSet: 'Change Set', verificationQueue: 'Verification Queue',
    impactPaths: 'Impact Paths', evidencePanel: 'Evidence', workArtifacts: 'Work Artifacts',
    doctorFindings: 'Doctor Findings', contextPacks: 'Context Packs',
    adapterConfidence: 'Adapter Confidence', workspaceContracts: 'Workspace Contracts',
    workspaceResources: 'Workspace Resources', coverageGaps: 'Coverage Gaps',
    resourceContract: 'Resource Contract', language: 'Language',
    impactSummary: 'Impact Summary', topImpact: 'Top Impact', analysisTrust: 'Analysis Trust',
    coverage: 'Coverage', adapters: 'Adapters', knownGaps: 'Known gaps',
    impactTriage: 'Impact Triage', reportDelta: 'Report Delta', addedImpact: 'Added impact',
    removedImpact: 'Removed impact', policyPresets: 'Policy presets', impactMap: 'Impact Map',
    topRoutes: 'Top routes', primaryImpactFlow: 'Primary impact flow',
    impactInspector: 'Impact Inspector', confidence: 'Confidence', relationPath: 'Relation path',
    evidenceHits: 'Evidence hits', topEvidence: 'Top evidence',
    blastRadius: 'Blast radius', changedRoot: 'Changed root', affectedTargets: 'Affected targets',
    nextVerification: 'Next verification', affectedTargetEmpty: 'No affected target',
    contextNode: 'Context node', source: 'Source', target: 'Target',
    affectedTargetRole: 'Affected target', changedInput: 'Changed input',
    targets: 'targets', totalAffected: 'total affected', totalTargets: 'total targets',
    mappedPaths: 'mapped paths', confidenceInline: 'confidence',
    runtimeCode: 'Runtime code', testsToVerify: 'Tests to verify',
    docsPolicy: 'Docs & policy', contractsLane: 'Contracts', crossRepoLane: 'Cross-repo consumers', configInfra: 'Config & infra',
    noSourceFilesAffected: 'No source files affected', noTestTargetDetected: 'No test target detected',
    noKnowledgeArtifactAffected: 'No knowledge artifact affected',
    noApiContractAffected: 'No API contract affected', noCrossRepoImpact: 'No cross-repo consumer impact', noConfigSurfaceAffected: 'No config surface affected',
    moreAffected: 'more', impactVerdict: 'Impact verdict', readyToVerify: 'Ready to verify',
    evidenceReady: 'Evidence ready', reviewBeforeChange: 'Review before change',
    needsEvidence: 'Needs evidence', commandReady: 'command ready', noCommandShort: 'no command',
    backToWorkbench: 'Back to Impact Workbench', lineLabel: 'Line',
    copy: 'Copy', copyConfig: 'Copy config', copyVerify: 'Copy verify',
    copyCopied: 'Copied', copyFailed: 'Copy failed',
    verify: 'Verify', review: 'Review',
    reviewGaps: 'Review gaps', useWithGaps: 'Use with gaps', readyToUse: 'Ready to use',
    noSkippedPaths: 'No skipped paths', confidenceMetadataPresent: 'Confidence metadata present',
    openLimitations: 'Open limitations', noneReported: 'None reported',
    noSelectedReport: 'No selected report.', none: 'None', noTargets: '0 targets',
    noDisplayedPaths: 'No displayed paths.', noVerificationActionShort: 'No verification action recorded.',
    noVerificationTarget: 'No verification target', noAffectedTargetInline: 'No affected target',
    impactWidened: 'Impact widened', impactNarrowed: 'Impact narrowed', impactUnchanged: 'Impact unchanged',
    reviewLoad: 'Review load', affectedPaths: 'Affected paths', delta: 'delta',
    savedReportComparison: 'Saved report comparison', stableConfidence: 'stable confidence',
    affectedWeight: 'Affected weight', actionWeight: 'Action weight', evidenceWeight: 'Evidence weight',
    inspectImpact: 'Inspect impact', noLongerAffected: 'No longer affected', vsPrevious: 'vs previous report',
    emptyRunAnalyzeBlast: `Run ${PACKAGE_NAME} analyze to see the current blast radius.`,
    emptyNoAffectedTargets: 'No affected targets.', emptyNoChangedEntities: 'No changed entities.',
    emptyNoGraphNodes: 'No graph nodes available.', emptyNoVisiblePaths: 'No visible impact paths.',
    emptyRunAnalyzeReport: `Run ${PACKAGE_NAME} analyze to create a report.`,
    emptyNoActionsQueued: 'No actions queued.', emptyNoImpactPaths: 'No impact paths in this report.',
    emptyNoEvidence: 'No evidence in the selected report.',
    emptyNoWorkArtifacts: 'No linked work artifacts in this report.',
    emptyNoDoctorFindings: 'No doctor findings.', emptyNoContextPacks: 'No reusable context packs yet.',
    emptyNoAdapterConfidence: 'No adapter confidence metadata in the selected report.',
    emptyNoWorkspaceContracts: 'No workspace contract links available.',
    emptyNoWorkspaceResources: 'No workspace resources available.',
    emptyNoCoverageRows: 'No coverage rows available.',
    noAffectedTargetSelected: 'No affected target selected',
    selectAffectedTarget: 'Select an affected target in the map or impact list.',
    noVerificationActionRecorded: 'No verification action recorded.',
    noCommandRecorded: 'No command recorded for this action.',
    noSourceSpanRecorded: 'No source span recorded', noMatchingEvidence: 'No matching evidence recorded.',
    directOrNotRecorded: 'direct or not recorded',
    impactPathLabel: 'Impact path', changedRootLabel: 'Changed root',
    ariaImpactSummary: 'Impact summary', ariaAffectedByConfidence: 'Affected files by confidence',
    ariaAffectedByLane: 'Affected targets by product lane', ariaTrustSignals: 'Analysis trust signals',
    ariaKnownGapPreview: 'Known gap preview', ariaImpactTriage: 'Impact triage',
    ariaSavedReportComparison: 'Saved report comparison', ariaConfidenceDelta: 'Confidence delta',
    ariaPolicyWeights: 'Report delta policy weights', ariaPresetComparison: 'Report delta policy preset comparison',
    ariaDeltaMetricsList: 'Report delta metrics', ariaImpactMap: 'Impact map',
    ariaImpactMapLegend: 'Impact map legend', ariaImpactMapSymbols: 'Impact map symbols',
    ariaVisibleRoutes: 'Visible impact routes', ariaRankedRoutes: 'Ranked impact route summary',
    ariaPrimaryImpactFlow: 'Primary impact flow', ariaNextVerificationCommand: 'Next verification command',
    ariaCopyMapCommand: 'Copy map verification command', ariaImpactInspector: 'Impact inspector',
    ariaCopyInspectorCommand: 'Copy inspector verification command',
    ariaImpactVerdict: 'Selected impact verdict', ariaRelationTrail: 'Relation trail',
    ariaMapSvg: 'Changed entities connected to affected targets', ariaInspectImpactPath: 'Inspect impact path',
    ariaOpenSourceLabel: 'Open source', ariaCopyConfigPrefix: 'Copy', ariaCopyCommandSuffix: 'command',
    ariaCopyVerifyForPrefix: 'Copy verification command for',
    ariaImpactOverview: 'Impact overview', ariaImpactWorkbench: 'Impact report workbench',
  },
  ko: {
    eyebrow: 'Parallax 로컬 임팩트 인텔리전스', workbench: 'Impact Workbench',
    controls: '워크벤치 컨트롤', reportSelector: '리포트 선택기', noReports: '리포트 없음',
    selectReport: '리포트 선택', filterPlaceholder: '경로·증거·액션 필터',
    filterRows: '워크벤치 행 필터', metrics: '저장소 및 리포트 지표',
    indexStatus: '인덱스 상태', changed: '변경됨', affected: '영향받음', evidence: '증거',
    actions: '액션', coverageGapsMetric: '커버리지 갭', workArtifactsMetric: '작업 산출물',
    workspacesMetric: '워크스페이스', changeSet: '변경 세트', verificationQueue: '검증 큐',
    impactPaths: '영향 경로', evidencePanel: '증거', workArtifacts: '작업 산출물',
    doctorFindings: 'Doctor 점검 결과', contextPacks: 'Context Pack',
    adapterConfidence: 'Adapter 신뢰도', workspaceContracts: '워크스페이스 계약',
    workspaceResources: '워크스페이스 리소스', coverageGaps: '커버리지 갭',
    resourceContract: '리소스 계약', language: '언어',
    impactSummary: '영향 요약', topImpact: '주요 영향', analysisTrust: '분석 신뢰도',
    coverage: '커버리지', adapters: 'Adapter', knownGaps: '알려진 갭',
    impactTriage: '영향 분류', reportDelta: '리포트 델타', addedImpact: '추가된 영향',
    removedImpact: '제거된 영향', policyPresets: '정책 프리셋', impactMap: '영향 맵',
    topRoutes: '주요 경로', primaryImpactFlow: '주요 영향 흐름',
    impactInspector: '영향 인스펙터', confidence: '신뢰도', relationPath: '관계 경로',
    evidenceHits: '증거 적중', topEvidence: '주요 증거',
    blastRadius: '영향 범위', changedRoot: '변경 루트', affectedTargets: '영향받은 대상',
    nextVerification: '다음 검증', affectedTargetEmpty: '영향받은 대상 없음',
    contextNode: '컨텍스트 노드', source: '소스', target: '대상',
    affectedTargetRole: '영향받은 대상', changedInput: '변경 입력',
    targets: '대상', totalAffected: '전체 영향', totalTargets: '전체 대상',
    mappedPaths: '표시 경로', confidenceInline: '신뢰도',
    runtimeCode: '런타임 코드', testsToVerify: '검증할 테스트',
    docsPolicy: '문서 및 정책', contractsLane: '계약', crossRepoLane: '교차 저장소 소비자', configInfra: '설정 및 인프라',
    noSourceFilesAffected: '영향받은 소스 파일 없음', noTestTargetDetected: '감지된 테스트 대상 없음',
    noKnowledgeArtifactAffected: '영향받은 지식 산출물 없음',
    noApiContractAffected: '영향받은 API 계약 없음', noCrossRepoImpact: '교차 저장소 소비자 영향 없음', noConfigSurfaceAffected: '영향받은 설정 표면 없음',
    moreAffected: '추가', impactVerdict: '영향 판정', readyToVerify: '검증 준비됨',
    evidenceReady: '증거 준비됨', reviewBeforeChange: '변경 전 검토 필요',
    needsEvidence: '증거 필요', commandReady: '명령 준비됨', noCommandShort: '명령 없음',
    backToWorkbench: 'Impact Workbench로 돌아가기', lineLabel: '줄',
    copy: '복사', copyConfig: '설정 복사', copyVerify: '검증 복사',
    copyCopied: '복사됨', copyFailed: '복사 실패',
    verify: '검증', review: '검토',
    reviewGaps: '갭 검토', useWithGaps: '갭 있음', readyToUse: '사용 가능',
    noSkippedPaths: '건너뛴 경로 없음', confidenceMetadataPresent: '신뢰도 메타데이터 존재',
    openLimitations: '미해결 제한', noneReported: '보고 없음',
    noSelectedReport: '선택된 리포트 없음.', none: '없음', noTargets: '대상 0개',
    noDisplayedPaths: '표시된 경로 없음.', noVerificationActionShort: '기록된 검증 액션 없음.',
    noVerificationTarget: '검증 대상 없음', noAffectedTargetInline: '영향받은 대상 없음',
    impactWidened: '영향 확대', impactNarrowed: '영향 축소', impactUnchanged: '영향 변동 없음',
    reviewLoad: '검토 부하', affectedPaths: '영향 경로', delta: '델타',
    savedReportComparison: '저장된 리포트 비교', stableConfidence: '신뢰도 안정',
    affectedWeight: '영향 가중치', actionWeight: '액션 가중치', evidenceWeight: '증거 가중치',
    inspectImpact: '영향 점검', noLongerAffected: '더 이상 영향 없음', vsPrevious: '이전 리포트 대비',
    emptyRunAnalyzeBlast: `${PACKAGE_NAME} analyze를 실행해 현재 영향 범위를 확인하세요.`,
    emptyNoAffectedTargets: '영향받은 대상 없음.', emptyNoChangedEntities: '변경된 엔티티 없음.',
    emptyNoGraphNodes: '사용 가능한 그래프 노드 없음.', emptyNoVisiblePaths: '표시된 영향 경로 없음.',
    emptyRunAnalyzeReport: `${PACKAGE_NAME} analyze를 실행해 리포트를 생성하세요.`,
    emptyNoActionsQueued: '대기 중인 액션 없음.', emptyNoImpactPaths: '이 리포트에 영향 경로 없음.',
    emptyNoEvidence: '선택한 리포트에 증거 없음.',
    emptyNoWorkArtifacts: '이 리포트에 연결된 작업 산출물 없음.',
    emptyNoDoctorFindings: 'Doctor 점검 결과 없음.', emptyNoContextPacks: '재사용 가능한 Context Pack 없음.',
    emptyNoAdapterConfidence: '선택한 리포트에 Adapter 신뢰도 메타데이터 없음.',
    emptyNoWorkspaceContracts: '사용 가능한 워크스페이스 계약 링크 없음.',
    emptyNoWorkspaceResources: '사용 가능한 워크스페이스 리소스 없음.',
    emptyNoCoverageRows: '사용 가능한 커버리지 행 없음.',
    noAffectedTargetSelected: '선택된 영향 대상 없음',
    selectAffectedTarget: '맵 또는 영향 목록에서 영향받은 대상을 선택하세요.',
    noVerificationActionRecorded: '기록된 검증 액션 없음.',
    noCommandRecorded: '이 액션에 기록된 명령 없음.',
    noSourceSpanRecorded: '기록된 소스 범위 없음', noMatchingEvidence: '일치하는 증거 기록 없음.',
    directOrNotRecorded: '직접 또는 미기록',
    impactPathLabel: '영향 경로', changedRootLabel: '변경 루트',
    ariaImpactSummary: '영향 요약', ariaAffectedByConfidence: '신뢰도별 영향 파일',
    ariaAffectedByLane: '제품 레인별 영향 대상', ariaTrustSignals: '분석 신뢰도 시그널',
    ariaKnownGapPreview: '알려진 갭 미리보기', ariaImpactTriage: '영향 분류',
    ariaSavedReportComparison: '저장된 리포트 비교', ariaConfidenceDelta: '신뢰도 델타',
    ariaPolicyWeights: '리포트 델타 정책 가중치', ariaPresetComparison: '리포트 델타 정책 프리셋 비교',
    ariaDeltaMetricsList: '리포트 델타 지표', ariaImpactMap: '영향 맵',
    ariaImpactMapLegend: '영향 맵 범례', ariaImpactMapSymbols: '영향 맵 기호',
    ariaVisibleRoutes: '표시된 영향 경로', ariaRankedRoutes: '순위별 영향 경로 요약',
    ariaPrimaryImpactFlow: '주요 영향 흐름', ariaNextVerificationCommand: '다음 검증 명령',
    ariaCopyMapCommand: '맵 검증 명령 복사', ariaImpactInspector: '영향 인스펙터',
    ariaCopyInspectorCommand: '인스펙터 검증 명령 복사',
    ariaImpactVerdict: '선택한 영향 판정', ariaRelationTrail: '관계 경로',
    ariaMapSvg: '변경 엔티티와 영향받은 대상 연결', ariaInspectImpactPath: '영향 경로 점검',
    ariaOpenSourceLabel: '소스 열기', ariaCopyConfigPrefix: '복사', ariaCopyCommandSuffix: '명령',
    ariaCopyVerifyForPrefix: '검증 명령 복사 대상',
    ariaImpactOverview: '영향 개요', ariaImpactWorkbench: 'Impact 리포트 워크벤치',
  },
  zh: {
    eyebrow: 'Parallax 本地影响力情报', workbench: 'Impact Workbench',
    controls: '工作台控件', reportSelector: '报告选择器', noReports: '暂无报告',
    selectReport: '选择一个报告', filterPlaceholder: '筛选路径、证据、操作',
    filterRows: '筛选工作台行', metrics: '仓库与报告指标',
    indexStatus: '索引状态', changed: '已变更', affected: '受影响', evidence: '证据',
    actions: '操作', coverageGapsMetric: '覆盖缺口', workArtifactsMetric: '工作产物',
    workspacesMetric: '工作区', changeSet: '变更集', verificationQueue: '验证队列',
    impactPaths: '影响路径', evidencePanel: '证据', workArtifacts: '工作产物',
    doctorFindings: 'Doctor 检查结果', contextPacks: 'Context Pack',
    adapterConfidence: 'Adapter 置信度', workspaceContracts: '工作区契约',
    workspaceResources: '工作区资源', coverageGaps: '覆盖缺口',
    resourceContract: '资源契约', language: '语言',
    impactSummary: '影响摘要', topImpact: '主要影响', analysisTrust: '分析可信度',
    coverage: '覆盖率', adapters: 'Adapter', knownGaps: '已知缺口',
    impactTriage: '影响分类', reportDelta: '报告差异', addedImpact: '新增影响',
    removedImpact: '移除影响', policyPresets: '策略预设', impactMap: '影响图',
    topRoutes: '主要路径', primaryImpactFlow: '主要影响流',
    impactInspector: '影响检查器', confidence: '置信度', relationPath: '关系路径',
    evidenceHits: '证据命中', topEvidence: '主要证据',
    blastRadius: '影响范围', changedRoot: '变更根', affectedTargets: '受影响目标',
    nextVerification: '下一步验证', affectedTargetEmpty: '无受影响目标',
    contextNode: '上下文节点', source: '源', target: '目标',
    affectedTargetRole: '受影响目标', changedInput: '变更输入',
    targets: '目标', totalAffected: '总受影响', totalTargets: '总目标',
    mappedPaths: '已绘制路径', confidenceInline: '置信度',
    runtimeCode: '运行时代码', testsToVerify: '需验证测试',
    docsPolicy: '文档与策略', contractsLane: '契约', crossRepoLane: '跨仓库消费者', configInfra: '配置与基础设施',
    noSourceFilesAffected: '无受影响源文件', noTestTargetDetected: '未检测到测试目标',
    noKnowledgeArtifactAffected: '无受影响知识产物',
    noApiContractAffected: '无受影响 API 契约', noCrossRepoImpact: '无跨仓库消费者影响', noConfigSurfaceAffected: '无受影响配置表面',
    moreAffected: '更多', impactVerdict: '影响判定', readyToVerify: '可验证',
    evidenceReady: '证据就绪', reviewBeforeChange: '变更前需审查',
    needsEvidence: '需要证据', commandReady: '命令就绪', noCommandShort: '无命令',
    backToWorkbench: '返回 Impact Workbench', lineLabel: '行',
    copy: '复制', copyConfig: '复制配置', copyVerify: '复制验证',
    copyCopied: '已复制', copyFailed: '复制失败',
    verify: '验证', review: '审查',
    reviewGaps: '审查缺口', useWithGaps: '存在缺口', readyToUse: '可使用',
    noSkippedPaths: '无跳过路径', confidenceMetadataPresent: '存在置信度元数据',
    openLimitations: '未解决限制', noneReported: '无报告',
    noSelectedReport: '未选择报告。', none: '无', noTargets: '0 个目标',
    noDisplayedPaths: '无显示路径。', noVerificationActionShort: '无记录的验证操作。',
    noVerificationTarget: '无验证目标', noAffectedTargetInline: '无受影响目标',
    impactWidened: '影响扩大', impactNarrowed: '影响缩小', impactUnchanged: '影响无变化',
    reviewLoad: '审查负载', affectedPaths: '影响路径', delta: '差异',
    savedReportComparison: '已保存报告对比', stableConfidence: '置信度稳定',
    affectedWeight: '影响权重', actionWeight: '操作权重', evidenceWeight: '证据权重',
    inspectImpact: '检查影响', noLongerAffected: '不再受影响', vsPrevious: '对比上一个报告',
    emptyRunAnalyzeBlast: `运行 ${PACKAGE_NAME} analyze 查看当前影响范围。`,
    emptyNoAffectedTargets: '无受影响目标。', emptyNoChangedEntities: '无变更实体。',
    emptyNoGraphNodes: '无可用图节点。', emptyNoVisiblePaths: '无可见影响路径。',
    emptyRunAnalyzeReport: `运行 ${PACKAGE_NAME} analyze 创建报告。`,
    emptyNoActionsQueued: '无排队操作。', emptyNoImpactPaths: '本报告中无影响路径。',
    emptyNoEvidence: '所选报告中无证据。',
    emptyNoWorkArtifacts: '本报告中无关联工作产物。',
    emptyNoDoctorFindings: '无 Doctor 检查结果。', emptyNoContextPacks: '暂无可复用的 Context Pack。',
    emptyNoAdapterConfidence: '所选报告中无 Adapter 置信度元数据。',
    emptyNoWorkspaceContracts: '无可用工作区契约链接。',
    emptyNoWorkspaceResources: '无可用工作区资源。',
    emptyNoCoverageRows: '无可用覆盖率行。',
    noAffectedTargetSelected: '未选择受影响目标',
    selectAffectedTarget: '在图或影响列表中选择受影响目标。',
    noVerificationActionRecorded: '无记录的验证操作。',
    noCommandRecorded: '此操作无记录命令。',
    noSourceSpanRecorded: '无记录的源范围', noMatchingEvidence: '无匹配的证据记录。',
    directOrNotRecorded: '直接或未记录',
    impactPathLabel: '影响路径', changedRootLabel: '变更根',
    ariaImpactSummary: '影响摘要', ariaAffectedByConfidence: '按置信度划分的影响文件',
    ariaAffectedByLane: '按产品通道划分的影响目标', ariaTrustSignals: '分析可信度信号',
    ariaKnownGapPreview: '已知缺口预览', ariaImpactTriage: '影响分类',
    ariaSavedReportComparison: '已保存报告对比', ariaConfidenceDelta: '置信度差异',
    ariaPolicyWeights: '报告差异策略权重', ariaPresetComparison: '报告差异策略预设对比',
    ariaDeltaMetricsList: '报告差异指标', ariaImpactMap: '影响图',
    ariaImpactMapLegend: '影响图图例', ariaImpactMapSymbols: '影响图符号',
    ariaVisibleRoutes: '可见影响路径', ariaRankedRoutes: '排序影响路径摘要',
    ariaPrimaryImpactFlow: '主要影响流', ariaNextVerificationCommand: '下一步验证命令',
    ariaCopyMapCommand: '复制图验证命令', ariaImpactInspector: '影响检查器',
    ariaCopyInspectorCommand: '复制检查器验证命令',
    ariaImpactVerdict: '所选影响判定', ariaRelationTrail: '关系路径',
    ariaMapSvg: '变更实体连接到受影响目标', ariaInspectImpactPath: '检查影响路径',
    ariaOpenSourceLabel: '打开源', ariaCopyConfigPrefix: '复制', ariaCopyCommandSuffix: '命令',
    ariaCopyVerifyForPrefix: '复制验证命令，目标',
    ariaImpactOverview: '影响概览', ariaImpactWorkbench: 'Impact 报告工作台',
  },
};

export function normalizeUiLanguage(value: string | null | undefined): UiLanguage {
  return UI_LANGUAGES.includes(value as UiLanguage) ? (value as UiLanguage) : 'en';
}

function uiHomeHref(params: Record<string, string | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const search = query.toString();
  return search ? `/?${search}` : '/';
}

function renderLanguageSwitcher(active: UiLanguage, reportId: string | null): string {
  const links = UI_LANGUAGES.map((lang) => {
    const current = lang === active ? ' aria-current="true"' : '';
    const href = uiHomeHref({ report: reportId, lang });
    return `<a class="lang-link${lang === active ? ' active' : ''}" data-lang="${lang}" href="${escapeHtml(href)}"${current}>${escapeHtml(UI_LANGUAGE_LABELS[lang])}</a>`;
  }).join('');
  return `<nav class="lang-switcher" aria-label="${escapeHtml(UI_MESSAGES[active].language)}">${links}</nav>`;
}

export function renderUiHtml(snapshot: UiSnapshot, language: UiLanguage = 'en'): string {
  const lang = normalizeUiLanguage(language);
  const m = UI_MESSAGES[lang];
  const report = snapshot.selectedReport;
  const doctor = snapshot.doctor;
  const title = report ? `Impact Workbench - ${report.id}` : 'Impact Workbench';
  const sourceContext = { reportId: snapshot.selectedReportId, language: lang };
  const missingReportOption = snapshot.selectedReportId === null && snapshot.reports.length > 0
    ? `<option value="" selected>${escapeHtml(m.selectReport)}</option>`
    : '';
  const reportOptions = missingReportOption + snapshot.reports.map((item) =>
    `<option value="${escapeHtml(item.id)}"${item.id === snapshot.selectedReportId ? ' selected' : ''}>${escapeHtml(item.id)}</option>`
  ).join('');
  const findings = doctor.findings.map((finding) => `
    <li class="finding finding-${escapeHtml(finding.severity)}">
      <strong>${escapeHtml(finding.code)}</strong>
      <span>${escapeHtml(finding.message)}</span>
    </li>
  `).join('');
  const errors = snapshot.errors.map((error) => `
    <li class="finding finding-error">
      <strong>${escapeHtml(error.code)}</strong>
      <span>${escapeHtml(error.message)}</span>
      ${error.fix ? `<small>${escapeHtml(error.fix)}</small>` : ''}
    </li>
  `).join('');
  const changedRows = (report?.changed ?? []).map((entity) => `
    <li class="entity-row">
      <span class="kind">${escapeHtml(entity.kind)}</span>
      <span>${escapeHtml(entity.displayName ?? entity.path ?? entity.id)}</span>
    </li>
  `).join('');
  const evidenceCountsByPath = evidenceCountByImpactPath(report?.affectedFiles ?? [], report?.evidence ?? []);
  const actionByPath = actionByTargetPath(report?.actions ?? []);
  const affectedRows = (report?.affectedFiles ?? []).slice(0, 40).map((item) =>
    renderImpactPathRow(item, evidenceCountsByPath.get(item.path) ?? 0, actionByPath.get(item.path), m, sourceContext)
  ).join('');
  const evidenceRows = (report?.evidence ?? []).slice(0, 30).map((item) => {
    const source = evidenceSourceLocation(item, sourceContext);
    return `
    <li class="evidence-row" data-impact-path="${escapeHtml(item.file)}" data-source-href="${escapeHtml(source?.href ?? '')}" data-source-label="${escapeHtml(source?.label ?? '')}" data-filter-text="${escapeHtml(`${item.file} ${item.kind} ${item.snippet}`)}">
      <div class="evidence-meta">
        <strong>${escapeHtml(item.file)}</strong>
        <span>${escapeHtml(item.kind)} · ${escapeHtml(item.confidence)}</span>
        ${source ? `<a class="source-link" href="${escapeHtml(source.href)}" target="_blank" rel="noreferrer">${escapeHtml(`${m.ariaOpenSourceLabel} ${source.label}`)}</a>` : ''}
        ${item.resourceUri ? `<small>${escapeHtml(item.resourceUri)}</small>` : ''}
      </div>
      <pre>${escapeHtml(item.snippet)}</pre>
    </li>
  `;
  }).join('');
  const actionRows = (report?.actions ?? []).slice(0, 20).map((item) => renderActionRow(item, m, sourceContext)).join('');
  const adapterInsightRows = (report?.adapterInsights ?? []).map((adapter) => `
    <li class="pack-row" data-filter-text="${escapeHtml(`${adapter.id} ${adapter.status} ${adapter.confidence} ${adapter.languageIds.join(' ')} ${adapter.knownGaps.join(' ')}`)}">
      <strong>${escapeHtml(adapter.id)}</strong>
      <span>${escapeHtml(adapter.status)} · ${escapeHtml(adapter.confidence)} · ${escapeHtml(adapter.languageIds.join(', ') || 'no files')}</span>
      ${adapter.knownGaps.length > 0 ? `<small>${escapeHtml(adapter.knownGaps.join(' | '))}</small>` : ''}
    </li>
  `).join('');
  const contextPackRows = snapshot.contextPacks.map((pack) => `
    <li class="pack-row">
      <strong>${escapeHtml(pack.id)}</strong>
      <span>${escapeHtml(pack.budget)} · hits ${pack.hitCount} · ${pack.returnedBytes} bytes</span>
    </li>
  `).join('');
  const coverageRows = (snapshot.coverage?.coverage ?? []).slice(0, 30).map((item) => `
    <li class="coverage-row">
      <strong>${escapeHtml(item.path)}</strong>
      <span>${escapeHtml(item.status)} · ${escapeHtml(item.adapterId)} · ${escapeHtml(item.reason)}</span>
    </li>
  `).join('');
  const workArtifactRows = snapshot.workArtifacts.slice(0, 30).map((item) => {
    const metadataText = workArtifactMetadataText(item.metadata);
    const freshnessText = `${item.freshness.state} ${item.freshness.label}`;
    return `
    <li class="work-artifact-row" data-filter-text="${escapeHtml(`${item.kind} ${item.path} ${item.reason} ${item.relations.join(' ')} ${metadataText} ${freshnessText}`)}">
      <div>
        <strong>${escapeHtml(item.displayName)} <span class="badge freshness-${escapeHtml(item.freshness.state)}">${escapeHtml(item.freshness.label)}</span></strong>
        <span>${escapeHtml(item.kind)} · ${escapeHtml(item.reason)} · ${escapeHtml(item.confidence)}</span>
        ${metadataText ? `<small>${escapeHtml(metadataText)}</small>` : ''}
        <small>${escapeHtml(item.resourceUri)}</small>
      </div>
    </li>
  `;
  }).join('');
  const workspaceRows = snapshot.workspaces.flatMap((workspace) => [
    `
      <li class="workspace-row" data-filter-text="${escapeHtml(`${workspace.name} ${workspace.repoCount}`)}">
        <div>
          <strong>${escapeHtml(workspace.name)}</strong>
          <span>${workspace.repoCount} repos · ${workspace.contracts.length} contracts · ${workspace.links.length} links</span>
        </div>
      </li>
    `,
    ...workspace.links.slice(0, 24).map((link) => `
      <li class="workspace-link-row" data-filter-text="${escapeHtml(`${workspace.name} ${link.kind} ${link.sourceService} ${link.targetService} ${link.routeLabel ?? ''} ${link.eventTopology?.pattern ?? ''}`)}">
        <div>
          <strong>${escapeHtml(link.sourceService)} → ${escapeHtml(link.targetService)}</strong>
          <span>${escapeHtml(link.kind)}${link.routeLabel ? ` · ${escapeHtml(link.routeLabel)}` : ''}${link.eventTopology ? ` · ${escapeHtml(link.eventTopology.pattern)}` : ''}</span>
          ${link.consumerPath ? `<small>${escapeHtml(link.consumerPath)}</small>` : ''}
        </div>
        ${link.eventTopology ? `<span class="badge">${escapeHtml(link.eventTopology.providerAction)} → ${escapeHtml(link.eventTopology.counterpartyRole)}</span>` : `<span class="badge confidence-${escapeHtml(link.confidence)}">${escapeHtml(link.confidence)}</span>`}
      </li>
    `),
    ...workspace.contracts.slice(0, 12).map((contract) => `
      <li class="workspace-contract-row" data-filter-text="${escapeHtml(`${workspace.name} ${contract.serviceName} ${contract.path} ${contract.kind}`)}">
        <div>
          <strong>${escapeHtml(contract.serviceName)} · ${escapeHtml(contract.path)}</strong>
          <span>${escapeHtml(contract.kind)} · endpoints ${contract.endpointCount} · index ${contract.indexRunId}</span>
        </div>
      </li>
    `)
  ]).join('');
  const impactSummaryPanel = renderImpactSummaryPanel(snapshot, m);
  const impactTriageStrip = renderImpactTriageStrip(snapshot, m);
  const impactMapPanel = renderImpactMapPanel(snapshot.graph, report, m, sourceContext);
  const reportDeltaPanel = renderReportDeltaPanel(snapshot.comparison, m, sourceContext);
  const dataJson = JSON.stringify(snapshot).replaceAll('<', '\\u003c');
  const messagesJson = JSON.stringify(m).replaceAll('<', '\\u003c');

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
${UI_STYLES_MAIN}
  </style>
</head>
<body>
  <header class="topbar">
    <div class="title">
      <span class="eyebrow">${escapeHtml(m.eyebrow)}</span>
      <h1>${escapeHtml(m.workbench)}</h1>
      <p>${escapeHtml(snapshot.repoRoot)} · schema ${escapeHtml(String(doctor.database.schemaVersion ?? 'missing'))} · generated ${escapeHtml(snapshot.generatedAt)}</p>
    </div>
    <div class="toolbar" aria-label="${escapeHtml(m.controls)}">
      ${renderLanguageSwitcher(lang, snapshot.selectedReportId)}
      <select id="reportSelect" aria-label="${escapeHtml(m.reportSelector)}">${reportOptions || `<option value="">${escapeHtml(m.noReports)}</option>`}</select>
      <input id="filterInput" type="search" placeholder="${escapeHtml(m.filterPlaceholder)}" aria-label="${escapeHtml(m.filterRows)}">
    </div>
  </header>
  <main class="shell">
    <section class="metrics" aria-label="${escapeHtml(m.metrics)}">
      <div class="metric"><span>${escapeHtml(m.indexStatus)}</span><strong>${escapeHtml(doctor.index.latestCompletedRun?.status ?? 'missing')}</strong></div>
      <div class="metric"><span>${escapeHtml(m.changed)}</span><strong>${escapeHtml(String(report?.changedCount ?? 0))}</strong></div>
      <div class="metric"><span>${escapeHtml(m.affected)}</span><strong>${escapeHtml(String(report?.affectedCount ?? 0))}</strong></div>
      <div class="metric"><span>${escapeHtml(m.evidence)}</span><strong>${escapeHtml(String(report?.evidenceCount ?? 0))}</strong></div>
      <div class="metric"><span>${escapeHtml(m.actions)}</span><strong>${escapeHtml(String(report?.actionCount ?? 0))}</strong></div>
      <div class="metric"><span>${escapeHtml(m.coverageGapsMetric)}</span><strong>${escapeHtml(String(doctor.index.coverage?.skippedPaths ?? 0))}</strong></div>
      <div class="metric"><span>${escapeHtml(m.workArtifactsMetric)}</span><strong>${escapeHtml(String(snapshot.workArtifacts.length))}</strong></div>
      <div class="metric"><span>${escapeHtml(m.workspacesMetric)}</span><strong>${escapeHtml(String(snapshot.workspaces.length))}</strong></div>
    </section>
    ${impactTriageStrip}
    <section class="impact-overview" aria-label="${escapeHtml(m.ariaImpactOverview)}">
      ${impactMapPanel}
      ${impactSummaryPanel}
    </section>
    ${reportDeltaPanel}
    <section class="workbench" aria-label="${escapeHtml(m.ariaImpactWorkbench)}">
      <div class="stacked-pane">
        <section class="panel">
          <h2>${escapeHtml(m.changeSet)}</h2>
          <ul class="list filterable">${changedRows || `<li class="empty">${escapeHtml(m.emptyRunAnalyzeReport)}</li>`}</ul>
        </section>
        <section class="panel">
          <h2>${escapeHtml(m.verificationQueue)}</h2>
          <ul class="list filterable">${actionRows || `<li class="empty">${escapeHtml(m.emptyNoActionsQueued)}</li>`}</ul>
        </section>
      </div>
      <div class="stacked-pane">
        <section class="panel">
          <h2>${escapeHtml(m.impactPaths)}</h2>
          <ul class="list filterable">${affectedRows || `<li class="empty">${escapeHtml(m.emptyNoImpactPaths)}</li>`}</ul>
        </section>
      </div>
      <section class="panel evidence-panel">
        <h2>${escapeHtml(m.evidencePanel)}</h2>
        <ul class="list filterable">${evidenceRows || `<li class="empty">${escapeHtml(m.emptyNoEvidence)}</li>`}</ul>
      </section>
    </section>
    <section class="panel wide-panel">
      <h2>${escapeHtml(m.workArtifacts)}</h2>
      <ul class="list filterable">${workArtifactRows || `<li class="empty">${escapeHtml(m.emptyNoWorkArtifacts)}</li>`}</ul>
    </section>
    <section class="bottom">
      <section class="panel">
        <h2>${escapeHtml(m.doctorFindings)}</h2>
        <ul class="list">${errors}${findings || (!errors ? `<li class="empty">${escapeHtml(m.emptyNoDoctorFindings)}</li>` : '')}</ul>
      </section>
      <section class="panel">
        <h2>${escapeHtml(m.contextPacks)}</h2>
        <ul class="list">${contextPackRows || `<li class="empty">${escapeHtml(m.emptyNoContextPacks)}</li>`}</ul>
      </section>
    </section>
    <section class="panel wide-panel">
      <h2>${escapeHtml(m.adapterConfidence)}</h2>
      <ul class="list filterable">${adapterInsightRows || `<li class="empty">${escapeHtml(m.emptyNoAdapterConfidence)}</li>`}</ul>
    </section>
    <section class="bottom">
      <section class="panel">
        <h2>${escapeHtml(m.workspaceContracts)}</h2>
        <ul class="list filterable">${workspaceRows || `<li class="empty">${escapeHtml(m.emptyNoWorkspaceContracts)}</li>`}</ul>
      </section>
      <section class="panel">
        <h2>${escapeHtml(m.workspaceResources)}</h2>
        <ul class="list">
          ${snapshot.workspaces.map((workspace) => `
            <li class="pack-row">
              <strong>${escapeHtml(workspace.name)}</strong>
              <span>${escapeHtml(workspace.resources.workspace)} · ${escapeHtml(workspace.resources.contracts)} · ${escapeHtml(workspace.resources.crossRepoLinks)}</span>
            </li>
          `).join('') || `<li class="empty">${escapeHtml(m.emptyNoWorkspaceResources)}</li>`}
        </ul>
      </section>
    </section>
    <section class="bottom">
      <section class="panel">
        <h2>${escapeHtml(m.coverageGaps)}</h2>
        <ul class="list">${coverageRows || `<li class="empty">${escapeHtml(m.emptyNoCoverageRows)}</li>`}</ul>
      </section>
      <section class="panel">
        <h2>${escapeHtml(m.resourceContract)}</h2>
        <ul class="list">
          <li class="pack-row"><strong>/api/bootstrap</strong><span>DoctorReport, reports, selected report, graph, coverage, context packs</span></li>
          <li class="pack-row"><strong>/api/reports/{id}</strong><span>Persisted ImpactReport JSON shape</span></li>
          <li class="pack-row"><strong>/api/reports/{id}/graph/json</strong><span>GraphExport JSON shape with limit/cursor pagination</span></li>
          <li class="pack-row"><strong>/api/coverage/latest</strong><span>Coverage resource shape</span></li>
          <li class="pack-row"><strong>/api/context-packs/{id}</strong><span>Persisted context pack resource shape</span></li>
          <li class="pack-row"><strong>bootstrap.comparison</strong><span>Selected report versus previous saved report deltas</span></li>
          <li class="pack-row"><strong>bootstrap.workArtifacts</strong><span>Policy, decision, PRD, requirement, and proposal impact preview shape</span></li>
          <li class="pack-row"><strong>/api/workspaces/{name}</strong><span>Workspace contracts and cross-repo link preview shape</span></li>
        </ul>
      </section>
    </section>
  </main>
  <script id="impact-data" type="application/json">${dataJson}</script>
  <script id="ui-messages" type="application/json">${messagesJson}</script>
  <script>
${UI_CLIENT_JS}
  </script>
</body>
</html>`;
}

async function renderSourceViewerHtml(repoRootInput: string, url: URL): Promise<string> {
  const repoRoot = normalizeRepoRoot(repoRootInput);
  const lang = normalizeUiLanguage(url.searchParams.get('lang'));
  const m = UI_MESSAGES[lang];
  const backHref = uiHomeHref({ report: url.searchParams.get('report'), lang });
  const requestedPath = url.searchParams.get('path') ?? '';
  const requestedLine = parseSourceLine(url.searchParams.get('line'));
  const absolutePath = resolveInsideRoot(repoRoot, requestedPath);
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error('source path must be a file');
  if (info.size > 1_000_000) throw new Error('source file is too large for the UI preview');

  const content = await readFile(absolutePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const targetLine = Math.min(requestedLine, Math.max(1, lines.length));
  const startLine = Math.max(1, targetLine - 12);
  const endLine = Math.min(lines.length, targetLine + 12);
  const sourceRows = lines.slice(startLine - 1, endLine).map((line, index) => {
    const lineNumber = startLine + index;
    return `<li id="L${lineNumber}" class="${lineNumber === targetLine ? 'source-line-active' : ''}"><code>${escapeHtml(line || ' ')}</code></li>`;
  }).join('');

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(requestedPath)}:${targetLine}</title>
  <style>
${UI_STYLES_SOURCE_VIEWER}
  </style>
</head>
<body>
  <header>
    <a href="${escapeHtml(backHref)}">${escapeHtml(m.backToWorkbench)}</a>
    <h1>${escapeHtml(requestedPath)}</h1>
    <span>${escapeHtml(m.lineLabel)} ${targetLine} · ${escapeHtml(repoRoot)}</span>
  </header>
  <main>
    <section class="source-card">
      <div><span>${escapeHtml(requestedPath)}</span><span>L${startLine}-L${endLine}</span></div>
      <ol start="${startLine}">${sourceRows}</ol>
    </section>
  </main>
</body>
</html>`;
}

function parseSourceLine(value: string | null): number {
  if (value === null || value === '') return 1;
  const line = Number(value);
  if (!Number.isInteger(line) || line < 1) throw new Error('source line must be a positive integer');
  return line;
}

export async function startUiServer(options: UiServerOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const host = options.host ?? '127.0.0.1';
  const preferredPort = options.port ?? 3717;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (url.pathname === '/healthz') {
        response.writeHead(200, jsonHeaders());
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === '/favicon.ico') {
        response.writeHead(204, {
          'cache-control': 'public, max-age=86400',
          'x-content-type-options': 'nosniff'
        });
        response.end();
        return;
      }
      if (url.pathname === '/source') {
        try {
          const html = await renderSourceViewerHtml(options.repoRoot, url);
          response.writeHead(200, htmlHeaders());
          response.end(html);
        } catch (error) {
          response.writeHead(400, textHeaders());
          response.end(errorMessage(error));
        }
        return;
      }
      const reportId = url.searchParams.get('report') ?? options.reportId;
      const snapshot = await buildUiSnapshot({ repoRoot: options.repoRoot, ...(reportId ? { reportId } : {}) });
      if (url.pathname === '/data.json' || url.pathname === '/api/bootstrap') {
        response.writeHead(200, jsonHeaders());
        response.end(JSON.stringify(snapshot));
        return;
      }
      const apiResponse = await uiApiResponse(options.repoRoot, url);
      if (apiResponse !== null) {
        response.writeHead(200, jsonHeaders());
        response.end(JSON.stringify(apiResponse));
        return;
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        response.writeHead(200, htmlHeaders());
        response.end(renderUiHtml(snapshot, normalizeUiLanguage(url.searchParams.get('lang'))));
        return;
      }
      response.writeHead(404, textHeaders());
      response.end('not found');
    } catch (error) {
      if (error instanceof GraphPaginationInputError) {
        response.writeHead(400, jsonHeaders());
        response.end(JSON.stringify({ error: { code: 'invalid_request', message: error.message } }));
        return;
      }
      if (error instanceof UiClientInputError) {
        response.writeHead(400, jsonHeaders());
        response.end(JSON.stringify({ error: { code: error.code, message: error.message } }));
        return;
      }
      response.writeHead(500, jsonHeaders());
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  const port = await listen(server, host, preferredPort, options.port === undefined);
  return {
    server,
    url: `http://${host}:${port}/`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

async function uiApiResponse(repoRootInput: string, url: URL): Promise<unknown | null> {
  const repoRoot = normalizeRepoRoot(repoRootInput);
  if (!existsSync(databasePath(repoRoot))) return null;
  const reportMatch = /^\/api\/reports\/([^/]+)$/.exec(url.pathname);
  if (reportMatch) {
    return readReport(repoRoot, decodeURIComponent(reportMatch[1]!));
  }
  const graphMatch = /^\/api\/reports\/([^/]+)\/graph\/json$/.exec(url.pathname);
  if (graphMatch) {
    const graph = await exportImpactGraph({
      repoRoot,
      reportId: decodeURIComponent(graphMatch[1]!),
      format: 'json'
    });
    return paginateGraph(graph, {
      limit: url.searchParams.get('limit'),
      cursor: url.searchParams.get('cursor'),
      requirePagination: true
    });
  }
  if (url.pathname === '/api/coverage/latest') {
    const db = openDatabase(repoRoot, { readOnly: true });
    try {
      return readLatestCoverage(db, getRepoId(db, repoRoot));
    } finally {
      db.close();
    }
  }
  const packMatch = /^\/api\/context-packs\/([^/]+)$/.exec(url.pathname);
  if (packMatch) {
    return readContextPack(repoRoot, decodeURIComponent(packMatch[1]!));
  }
  const workspaceMatch = /^\/api\/workspaces\/([^/]+)$/.exec(url.pathname);
  if (workspaceMatch) {
    return readWorkspace(repoRoot, decodeURIComponent(workspaceMatch[1]!));
  }
  return null;
}

function jsonHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  };
}

function htmlHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
  };
}

function textHeaders(): Record<string, string> {
  return {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  };
}

function listen(server: Server, host: string, port: number, allowFallback: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (allowFallback && error.code === 'EADDRINUSE' && port !== 0) {
        server.listen(0, host);
        server.once('listening', onListening);
        server.once('error', reject);
        return;
      }
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address() as AddressInfo;
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}
