import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { markdownArtifactMetadataFromContent, type MarkdownArtifactMetadata } from './artifacts.js';
import { PACKAGE_NAME } from './branding.js';
import { doctorProject, type DoctorReport } from './doctor.js';
import { exportImpactGraph } from './graph.js';
import { databasePath, getRepoId, impactDir, latestCompletedIndexRun, openDatabase } from './store.js';
import { normalizeRepoRoot, resolveInsideRoot } from './security.js';
import type { GraphExport, ImpactAction, ImpactReport } from './types.js';

export type UiOptions = {
  repoRoot: string;
  reportId?: string;
};

export type UiServerOptions = UiOptions & {
  host?: string;
  port?: number;
};

type ImpactLaneId = 'code' | 'tests' | 'knowledge' | 'contracts' | 'config';
type ImpactLaneTone = 'green' | 'amber' | 'teal' | 'blue' | 'red';
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
  addedActionTargets: string[];
  removedActionTargets: string[];
  confidenceDeltas: UiReportComparisonBucket[];
  laneDeltas: UiReportComparisonLane[];
};

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

type ReportRow = {
  id: string;
  index_run_id: number;
  json: string;
  created_at: string;
};

type ContextPackRow = {
  id: string;
  budget: string;
  index_run_id: number;
  returned_bytes: number;
  hit_count: number;
  created_at: string;
  last_accessed_at: string;
};

type GraphPageCursor = {
  nodeOffset: number;
  edgeOffset: number;
};

type SourceLocation = {
  href: string;
  label: string;
  line: number;
};

type WorkspaceRow = {
  id: number;
  name: string;
};

type WorkspaceRepoRow = {
  local_path: string;
  service_name: string | null;
};

type WorkspaceContractRow = {
  id: string;
  kind: string;
  service_name: string | null;
  path: string | null;
  schema_version: string | null;
  endpoint_count: number;
};

type WorkspaceLinkRow = {
  id: string;
  kind: string;
  confidence: string;
  provenance: string;
  source_path: string;
  source_service: string | null;
  target_path: string;
  target_service: string | null;
};

type ImpactMapNode = {
  id: string;
  label: string;
  kind: string;
  group: 'changed' | 'affected' | 'context';
  confidence?: string;
  path?: string;
};

type ImpactMapEdge = {
  from: string;
  to: string;
  label: string;
  confidence: string;
};

type ImpactLane = {
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

function renderImpactSummaryPanel(snapshot: UiSnapshot): string {
  const report = snapshot.selectedReport;
  if (!report) {
    return `
      <section class="panel impact-summary-panel">
        <h2>Impact Summary</h2>
        <div class="empty">Run ${PACKAGE_NAME} analyze to see the current blast radius.</div>
      </section>
    `;
  }

  const affectedFiles = [...report.affectedFiles].sort(compareAffectedFilesForUi).slice(0, 4);
  const primaryChange = report.changed[0] ? entityLabel(report.changed[0]) : report.changedFiles[0] ?? 'unknown change';
  const blast = blastRadiusLabel(report.affectedCount);
  const displayedPathCount = buildImpactMap(snapshot.graph, report).edges.length;
  const impactLanes = buildImpactLanes(report, snapshot.workArtifacts);
  const confidenceRows = ['proven', 'inferred', 'heuristic', 'unknown'].map((confidence) => {
    const count = report.affectedFiles.filter((item) => item.confidence === confidence).length;
    return `<span class="confidence-meter confidence-${escapeHtml(confidence)}"><b>${count}</b>${escapeHtml(confidence)}</span>`;
  }).join('');
  const laneRows = impactLanes.map((lane) => {
    const selectableAttrs = lane.topPath
      ? ` tabindex="0" role="button" data-impact-path="${escapeHtml(lane.topPath)}" data-filter-text="${escapeHtml(`${lane.label} ${lane.summary} ${lane.topPath}`)}"`
      : ` data-filter-text="${escapeHtml(`${lane.label} ${lane.summary}`)}"`;
    return `
      <li class="impact-lane impact-lane-${escapeHtml(lane.tone)}${lane.topPath ? ' selectable-impact' : ''}"${selectableAttrs}>
        <span>${escapeHtml(lane.label)}</span>
        <b>${escapeHtml(String(lane.count))}</b>
        <small>${escapeHtml(lane.summary)}</small>
      </li>
    `;
  }).join('');
  const changedPreview = report.changed.slice(0, 4).map((entity) => `
    <li>
      <span class="node-dot changed"></span>
      <strong>${escapeHtml(entityLabel(entity))}</strong>
      <small>${escapeHtml(entity.kind)}</small>
    </li>
  `).join('');
  const affectedPreview = affectedFiles.map((item, index) => `
    <li class="priority-row selectable-impact" tabindex="0" role="button" data-impact-path="${escapeHtml(item.path)}" data-filter-text="${escapeHtml(`${item.path} ${item.reason} ${item.confidence}`)}">
      <b>${index + 1}</b>
      <span>
        <strong>${escapeHtml(item.path)}</strong>
        <small>${escapeHtml(item.reason)}</small>
      </span>
      <em class="badge confidence-${escapeHtml(item.confidence)}">${escapeHtml(item.confidence)}</em>
    </li>
  `).join('');

  return `
    <section class="panel impact-summary-panel">
      <h2>Impact Summary</h2>
      <div class="blast-card">
        <span>Blast radius</span>
        <strong>${escapeHtml(blast)}</strong>
        <small>${escapeHtml(primaryChange)} touches ${report.affectedCount} targets through ${displayedPathCount} displayed paths.</small>
      </div>
      <div class="confidence-strip" aria-label="Affected files by confidence">${confidenceRows}</div>
      <ul class="impact-lanes filterable" aria-label="Affected targets by product lane">${laneRows}</ul>
      <div class="summary-columns">
        <div>
          <h3>Changed</h3>
          <ul class="summary-list">${changedPreview || '<li class="empty">No changed entities.</li>'}</ul>
        </div>
        <div>
          <h3>Top Impact</h3>
          <ul class="summary-list filterable">${affectedPreview || '<li class="empty">No affected targets.</li>'}</ul>
        </div>
      </div>
    </section>
  `;
}

function renderImpactTriageStrip(snapshot: UiSnapshot): string {
  const report = snapshot.selectedReport;
  if (!report) {
    return `
      <section class="impact-triage impact-triage-empty" aria-label="Impact triage">
        <div class="triage-head">
          <h2>Impact Triage</h2>
          <p>No selected report.</p>
        </div>
        <ol class="triage-flow">
          <li class="triage-step"><span>Changed root</span><strong>None</strong><small>Run ${PACKAGE_NAME} analyze.</small></li>
          <li class="triage-step"><span>Affected targets</span><strong>0 targets</strong><small>No displayed paths.</small></li>
          <li class="triage-step"><span>Next verification</span><strong>None</strong><small>No verification action recorded.</small></li>
        </ol>
      </section>
    `;
  }

  const map = buildImpactMap(snapshot.graph, report);
  const affectedFiles = [...report.affectedFiles].sort(compareAffectedFilesForUi);
  const primaryChange = report.changed[0] ? entityLabel(report.changed[0]) : report.changedFiles[0] ?? 'unknown change';
  const topTargetPath = affectedFiles[0]?.path;
  const topTarget = topTargetPath ?? 'No affected target';
  const actionsByPath = actionByTargetPath(report.actions);
  const actionableTarget = affectedFiles.find((item) => actionsByPath.has(item.path));
  const nextAction = (actionableTarget ? actionsByPath.get(actionableTarget.path) : undefined) ?? report.actions[0];
  const nextActionPath = nextAction?.target.path;
  const nextActionLabel = nextAction
    ? nextActionPath ?? nextAction.target.displayName ?? nextAction.target.symbol ?? nextAction.target.id
    : 'No verification target';
  const nextCommand = nextAction ? actionCommandText(nextAction) : undefined;
  const topTargetAttrs = topTargetPath
    ? ` tabindex="0" role="button" data-impact-path="${escapeHtml(topTargetPath)}" data-filter-text="${escapeHtml(`${topTargetPath} ${affectedFiles[0]?.reason ?? ''}`)}"`
    : '';
  const nextActionAttrs = nextActionPath
    ? ` tabindex="0" role="button" data-impact-path="${escapeHtml(nextActionPath)}" data-filter-text="${escapeHtml(`${nextActionPath} ${nextCommand ?? ''}`)}"`
    : '';
  const blast = blastRadiusLabel(report.affectedCount);
  const provenCount = report.affectedFiles.filter((item) => item.confidence === 'proven').length;
  const heuristicCount = report.affectedFiles.filter((item) => item.confidence === 'heuristic').length;
  const riskDetail = [
    `${report.affectedCount} affected`,
    `${map.edges.length} displayed paths`,
    `${provenCount} proven`,
    heuristicCount > 0 ? `${heuristicCount} heuristic` : undefined
  ].filter((item): item is string => Boolean(item)).join(' · ');

  return `
    <section class="impact-triage impact-triage-${escapeHtml(blast)}" aria-label="Impact triage">
      <div class="triage-head">
        <h2>Impact Triage</h2>
        <strong>${escapeHtml(blast)}</strong>
        <p>${escapeHtml(riskDetail)}</p>
      </div>
      <ol class="triage-flow">
        <li class="triage-step triage-step-changed">
          <span>Changed root</span>
          <strong title="${escapeHtml(primaryChange)}">${escapeHtml(shortenMiddle(primaryChange, 44))}</strong>
          <small>${escapeHtml(String(report.changedCount))} changed input</small>
        </li>
        <li class="triage-step triage-step-affected${topTargetPath ? ' selectable-impact' : ''}"${topTargetAttrs}>
          <span>Affected targets</span>
          <strong>${escapeHtml(String(report.affectedCount))} targets</strong>
          <small title="${escapeHtml(topTarget)}">${escapeHtml(shortenMiddle(topTarget, 58))}</small>
        </li>
        <li class="triage-step triage-step-action${nextActionPath ? ' selectable-impact' : ''}"${nextActionAttrs}>
          <span>Next verification</span>
          <strong title="${escapeHtml(nextActionLabel)}">${escapeHtml(shortenMiddle(nextActionLabel, 44))}</strong>
          <small title="${escapeHtml(nextCommand ?? '')}">${escapeHtml(nextCommand ? shortenMiddle(nextCommand, 64) : 'No verification action recorded.')}</small>
        </li>
      </ol>
    </section>
  `;
}

function renderReportDeltaPanel(comparison: UiReportComparison | null): string {
  if (!comparison) return '';
  const headline = comparison.summary === 'wider'
    ? 'Impact widened'
    : comparison.summary === 'narrower'
      ? 'Impact narrowed'
      : 'Impact unchanged';
  const headlineDetail = comparison.policyReason;
  const metricRows = [
    { label: 'Review load', value: String(comparison.reviewLoadCurrent), meta: formatSignedDelta(comparison.reviewLoadDelta), delta: comparison.reviewLoadDelta },
    { label: 'Affected paths', value: formatSignedDelta(comparison.affectedDelta), meta: 'delta', delta: comparison.affectedDelta },
    { label: 'Evidence', value: formatSignedDelta(comparison.evidenceDelta), meta: 'delta', delta: comparison.evidenceDelta },
    { label: 'Actions', value: formatSignedDelta(comparison.actionDelta), meta: 'delta', delta: comparison.actionDelta }
  ].map((item) => `
    <li class="${escapeHtml(deltaClass(item.delta))}">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.value)}</strong>
      <em>${escapeHtml(item.meta)}</em>
    </li>
  `).join('');
  const laneRows = comparison.laneDeltas.map((lane) => {
    const detail = lane.delta === 0 ? `${lane.current} current` : lane.topPath ?? `${lane.current} current`;
    return `
      <li class="delta-lane delta-lane-${escapeHtml(lane.tone)} ${escapeHtml(deltaClass(lane.delta))}">
        <span>${escapeHtml(lane.label)}</span>
        <b>${escapeHtml(formatSignedDelta(lane.delta))}</b>
        <small>${escapeHtml(detail)}</small>
      </li>
    `;
  }).join('');
  const confidenceRows = comparison.confidenceDeltas
    .filter((item) => item.current > 0 || item.previous > 0 || item.delta !== 0)
    .map((item) => `
      <span class="${escapeHtml(deltaClass(item.delta))}">
        <b>${escapeHtml(formatSignedDelta(item.delta))}</b>${escapeHtml(item.label)}
      </span>
    `).join('');
  const addedRows = renderDeltaPathRows(comparison.addedAffectedPaths, 'added');
  const removedRows = renderDeltaPathRows(comparison.removedAffectedPaths, 'removed');
  const presetRows = comparison.policyPresets.map((preset) => `
    <li class="delta-preset delta-preset-${escapeHtml(preset.summary)}">
      <strong>${escapeHtml(preset.label)}</strong>
      <span>${escapeHtml(preset.summary)}</span>
      <b>${escapeHtml(formatSignedDelta(preset.reviewLoadDelta))}</b>
      <small>+${escapeHtml(String(preset.widenThreshold))}/-${escapeHtml(String(preset.narrowThreshold))} · ${escapeHtml(policyWeightsLabel(preset.weights))}</small>
      <button class="copy-command" type="button" ${copyCommandAttribute(reportDeltaPolicyConfigPatch(preset))} aria-label="Copy ${escapeHtml(preset.label)} report delta policy config">Copy config</button>
    </li>
  `).join('');

  return `
    <section class="panel report-delta-panel" aria-label="Saved report comparison">
      <div class="panel-heading">
        <h2>Report Delta</h2>
        <div class="panel-chips">
          <span>vs ${escapeHtml(comparison.baseReportId)}</span>
          <span>policy ${escapeHtml(comparison.policy.source)}</span>
          <span>widen +${escapeHtml(String(comparison.policy.widenThreshold))}</span>
          <span>narrow -${escapeHtml(String(comparison.policy.narrowThreshold))}</span>
          <span>${escapeHtml(comparison.baseCreatedAt)}</span>
        </div>
      </div>
      <div class="delta-content">
        <div class="delta-hero delta-hero-${escapeHtml(comparison.summary)}">
          <span>Saved report comparison</span>
          <strong>${escapeHtml(headline)}</strong>
          <small>${escapeHtml(headlineDetail)}</small>
        </div>
        <ul class="delta-metrics">${metricRows}</ul>
        <div class="delta-detail">
          <div class="delta-confidence" aria-label="Confidence delta">${confidenceRows || '<span><b>0</b>stable confidence</span>'}</div>
          <ul class="delta-lanes">${laneRows}</ul>
          <div class="delta-policy" aria-label="Report delta policy weights">
            <span>Affected weight ${escapeHtml(String(comparison.policy.weights.affected))}</span>
            <span>Action weight ${escapeHtml(String(comparison.policy.weights.actions))}</span>
            <span>Evidence weight ${escapeHtml(String(comparison.policy.weights.evidence))}</span>
          </div>
          <ul class="delta-presets" aria-label="Report delta policy preset comparison">${presetRows}</ul>
          <div class="delta-paths">
            <section>
              <h3>Added impact</h3>
              <ul>${addedRows || '<li>None</li>'}</ul>
            </section>
            <section>
              <h3>Removed impact</h3>
              <ul>${removedRows || '<li>None</li>'}</ul>
            </section>
          </div>
        </div>
      </div>
    </section>
  `;
}

function deltaClass(delta: number): string {
  if (delta > 0) return 'delta-positive';
  if (delta < 0) return 'delta-negative';
  return 'delta-neutral';
}

function policyWeightsLabel(weights: UiReportDeltaPolicy['weights']): string {
  return `aff${weights.affected}/act${weights.actions}/ev${weights.evidence}`;
}

function reportDeltaPolicyConfigPatch(policy: Pick<UiReportDeltaPolicyPreset, 'widenThreshold' | 'narrowThreshold' | 'weights'>): string {
  return JSON.stringify(
    {
      ui: {
        reportDeltaPolicy: {
          widenThreshold: policy.widenThreshold,
          narrowThreshold: policy.narrowThreshold,
          weights: policy.weights
        }
      }
    },
    null,
    2
  );
}

function copyCommandAttribute(value: string): string {
  return `data-command="${escapeHtml(value).replaceAll('\n', '&#10;')}"`;
}

function renderDeltaPathRows(paths: readonly string[], mode: 'added' | 'removed'): string {
  return paths.slice(0, 4).map((pathValue) => {
    const sourceLink = `<a class="source-link" href="${escapeHtml(sourceHref(pathValue, 1))}" target="_blank" rel="noreferrer">Source</a>`;
    if (mode === 'added') {
      return `
        <li class="delta-path-row selectable-impact" tabindex="0" role="button" data-impact-path="${escapeHtml(pathValue)}" data-filter-text="${escapeHtml(`added impact ${pathValue}`)}">
          <span>${escapeHtml(pathValue)}</span>
          <small>Inspect impact</small>
          ${sourceLink}
        </li>
      `;
    }
    return `
      <li class="delta-path-row" data-filter-text="${escapeHtml(`removed impact ${pathValue}`)}">
        <span>${escapeHtml(pathValue)}</span>
        <small>No longer affected</small>
        ${sourceLink}
      </li>
    `;
  }).join('');
}

function formatSignedDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

function buildImpactLanes(report: UiReportPreview, workArtifacts: readonly UiWorkArtifactImpact[]): ImpactLane[] {
  const lanes: ImpactLane[] = [
    { id: 'code', label: 'Runtime code', count: 0, summary: 'No source files affected', tone: 'green' },
    { id: 'tests', label: 'Tests to verify', count: 0, summary: 'No test target detected', tone: 'amber' },
    { id: 'knowledge', label: 'Docs & policy', count: 0, summary: 'No knowledge artifact affected', tone: 'teal' },
    { id: 'contracts', label: 'Contracts', count: 0, summary: 'No API contract affected', tone: 'red' },
    { id: 'config', label: 'Config & infra', count: 0, summary: 'No config surface affected', tone: 'blue' }
  ];
  const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
  const pathsByLane = new Map<ImpactLane['id'], UiReportPreview['affectedFiles']>();
  for (const lane of lanes) pathsByLane.set(lane.id, []);

  const actionTargets = new Set(report.actions.map((action) => action.target.path).filter((value): value is string => Boolean(value)));
  for (const item of report.affectedFiles) {
    pathsByLane.get(classifyImpactLane(item.path, item.reason, actionTargets))?.push(item);
  }

  for (const lane of lanes) {
    const items = [...(pathsByLane.get(lane.id) ?? [])].sort(compareAffectedFilesForUi);
    lane.count = items.length;
    const topPath = items[0]?.path;
    if (topPath) lane.topPath = topPath;
    if (lane.count > 0) {
      lane.summary = lane.topPath
        ? `${lane.topPath}${lane.count > 1 ? ` +${lane.count - 1} more` : ''}`
        : `${lane.count} affected target${lane.count === 1 ? '' : 's'}`;
    }
  }

  const knowledgeLane = laneById.get('knowledge');
  if (knowledgeLane && workArtifacts.length > 0) {
    const affectedKnowledgePaths = new Set((pathsByLane.get('knowledge') ?? []).map((item) => item.path));
    const extraArtifactCount = workArtifacts.filter((item) => !affectedKnowledgePaths.has(item.path)).length;
    knowledgeLane.count += extraArtifactCount;
    if (!knowledgeLane.topPath) {
      knowledgeLane.summary = `${workArtifacts[0]?.displayName ?? workArtifacts[0]?.path}${knowledgeLane.count > 1 ? ` +${knowledgeLane.count - 1} more` : ''}`;
    } else if (extraArtifactCount > 0) {
      knowledgeLane.summary = `${knowledgeLane.topPath} +${knowledgeLane.count - 1} more`;
    }
  }

  return lanes;
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

function defaultReportDeltaPolicy(): UiReportDeltaPolicy {
  return {
    source: 'default',
    widenThreshold: 1,
    narrowThreshold: 1,
    weights: {
      affected: 3,
      actions: 5,
      evidence: 1
    }
  };
}

function policyNumberAt(
  value: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): number | undefined {
  const candidate = value[key];
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return undefined;
  if (candidate < min || candidate > max) return undefined;
  return candidate;
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
    addedAffectedPaths: sortedSetDifference(currentAffectedPaths, previousAffectedPaths),
    removedAffectedPaths: sortedSetDifference(previousAffectedPaths, currentAffectedPaths),
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

function reportDeltaPolicyPresets(
  current: UiReportPreview,
  previous: UiReportPreview,
  activePolicy: UiReportDeltaPolicy
): UiReportDeltaPolicyPreset[] {
  const presets: Array<{ id: string; label: string; policy: UiReportDeltaPolicy }> = [
    { id: 'active', label: 'Active', policy: activePolicy },
    { id: 'strict', label: 'Strict', policy: strictReportDeltaPolicy() },
    { id: 'relaxed', label: 'Relaxed', policy: relaxedReportDeltaPolicy() },
    { id: 'action-heavy', label: 'Action-heavy', policy: actionHeavyReportDeltaPolicy() }
  ];
  return presets.map((item) => {
    const currentLoad = reportReviewLoad(current, item.policy);
    const previousLoad = reportReviewLoad(previous, item.policy);
    const reviewLoadDelta = currentLoad - previousLoad;
    return {
      id: item.id,
      label: item.label,
      summary: reportDeltaSummary(reviewLoadDelta, item.policy),
      reviewLoadDelta,
      widenThreshold: item.policy.widenThreshold,
      narrowThreshold: item.policy.narrowThreshold,
      weights: item.policy.weights
    };
  });
}

function strictReportDeltaPolicy(): UiReportDeltaPolicy {
  return {
    source: 'default',
    widenThreshold: 6,
    narrowThreshold: 6,
    weights: {
      affected: 4,
      actions: 7,
      evidence: 1
    }
  };
}

function relaxedReportDeltaPolicy(): UiReportDeltaPolicy {
  return {
    source: 'default',
    widenThreshold: 24,
    narrowThreshold: 12,
    weights: {
      affected: 2,
      actions: 3,
      evidence: 1
    }
  };
}

function actionHeavyReportDeltaPolicy(): UiReportDeltaPolicy {
  return {
    source: 'default',
    widenThreshold: 10,
    narrowThreshold: 8,
    weights: {
      affected: 2,
      actions: 8,
      evidence: 1
    }
  };
}

function reportReviewLoad(report: UiReportPreview, policy: UiReportDeltaPolicy): number {
  return report.affectedCount * policy.weights.affected
    + report.actionCount * policy.weights.actions
    + report.evidenceCount * policy.weights.evidence;
}

function reportDeltaSummary(delta: number, policy: UiReportDeltaPolicy): ReportDeltaSummary {
  if (delta >= policy.widenThreshold) return 'wider';
  if (delta <= -policy.narrowThreshold) return 'narrower';
  return 'unchanged';
}

function reportDeltaPolicyReason(
  summary: ReportDeltaSummary,
  delta: number,
  policy: UiReportDeltaPolicy
): string {
  const formattedDelta = formatSignedDelta(delta);
  if (summary === 'wider') {
    return `Review load changed by ${formattedDelta}; ${policy.source} policy marks wider at +${policy.widenThreshold}.`;
  }
  if (summary === 'narrower') {
    return `Review load changed by ${formattedDelta}; ${policy.source} policy marks narrower at -${policy.narrowThreshold}.`;
  }
  return `Review load changed by ${formattedDelta}; ${policy.source} policy keeps it inside +${policy.widenThreshold}/-${policy.narrowThreshold}.`;
}

function actionTargetLabels(actions: readonly ImpactAction[]): Set<string> {
  return new Set(actions.map((action) =>
    action.target.path ?? action.target.displayName ?? action.target.symbol ?? action.target.id
  ));
}

function sortedSetDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((item) => !right.has(item)).sort((a, b) => a.localeCompare(b));
}

function comparisonBucket(label: string, current: number, previous: number): UiReportComparisonBucket {
  return { label, current, previous, delta: current - previous };
}

function classifyImpactLane(pathValue: string, reason: string, actionTargets: ReadonlySet<string>): ImpactLane['id'] {
  const pathLower = pathValue.toLowerCase();
  const reasonLower = reason.toLowerCase();
  if (actionTargets.has(pathValue) || isUiTestPath(pathLower)) return 'tests';
  if (isUiKnowledgePath(pathLower) || /\b(governs|documents|requires|proposes)\b/.test(reasonLower)) return 'knowledge';
  if (isUiContractPath(pathLower) || /\bcontract|endpoint|asyncapi|openapi|graphql|protobuf\b/.test(reasonLower)) return 'contracts';
  if (isUiConfigPath(pathLower) || /\bconfigures|workflow|infra\b/.test(reasonLower)) return 'config';
  return 'code';
}

function isUiTestPath(pathLower: string): boolean {
  return /(^|\/)(tests?|__tests__)\/|(^|\/)src\/test\//.test(pathLower)
    || /(\.|-)(test|spec)\.[cm]?[tj]sx?$/.test(pathLower);
}

function isUiKnowledgePath(pathLower: string): boolean {
  return pathLower.endsWith('.md')
    || /(^|\/)(docs|doc|policies|policy|proposals|prd|requirements|decisions|adr)\//.test(pathLower);
}

function isUiContractPath(pathLower: string): boolean {
  return /(^|\/)(contracts?|apis?)\//.test(pathLower)
    || /(^|[-_.])(openapi|asyncapi)([-_.]|$)/.test(pathLower)
    || /\.(proto|graphql|gql|avsc)$/.test(pathLower);
}

function isUiConfigPath(pathLower: string): boolean {
  return /(^|\/)(\.github\/workflows|terraform|infra|deploy|k8s|helm)\//.test(pathLower)
    || /(^|\/)(dockerfile|makefile|compose\.ya?ml)$/.test(pathLower)
    || /\.(ya?ml|toml|json|jsonc|env|tf|tfvars|hcl|ini)$/.test(pathLower)
    || /(^|\/)(package\.json|pom\.xml|build\.gradle(?:\.kts)?|go\.mod|cargo\.toml|pyproject\.toml)$/.test(pathLower);
}

function renderImpactMapPanel(graph: UiGraphPreview | null, report: UiReportPreview | null): string {
  const map = buildImpactMap(graph, report);
  const firstImpact = [...(report?.affectedFiles ?? [])].sort(compareAffectedFilesForUi)[0];
  const displayedPathCount = map.edges.length;
  const chips = `
    <span>${map.changedNodes.length} changed</span>
    <span>${map.affectedNodes.length} affected</span>
    <span>${displayedPathCount} displayed paths</span>
  `;
  if (map.changedNodes.length === 0 && map.affectedNodes.length === 0) {
    return `
      <section class="panel map-panel">
        <div class="panel-heading">
          <h2>Impact Map</h2>
          <div class="panel-chips">${chips}</div>
        </div>
        <div class="empty">No graph nodes available.</div>
      </section>
    `;
  }

  const svg = renderImpactMapSvg(map);
  const insight = renderImpactMapInsight(map, displayedPathCount);
  const edgeRows = map.edges.slice(0, 6).map((edge) => {
    const from = map.nodeById.get(edge.from);
    const to = map.nodeById.get(edge.to);
    return `
      <li>
        <strong>${escapeHtml(from?.label ?? edge.from)}</strong>
        <span>${escapeHtml(edge.label)}</span>
        <strong>${escapeHtml(to?.label ?? edge.to)}</strong>
      </li>
    `;
  }).join('');

  return `
    <section class="panel map-panel">
      <div class="panel-heading">
        <h2>Impact Map</h2>
        <div class="panel-chips">${chips}</div>
      </div>
      <div class="map-content">
        <div class="map-frame">
          ${insight}
          ${svg}
        </div>
        <aside class="map-legend" aria-label="Impact map legend">
          <div><span class="legend-swatch changed"></span>Changed root</div>
          <div><span class="legend-swatch affected"></span>Affected target</div>
          <div><span class="legend-swatch context"></span>Context node</div>
          <ol>${edgeRows || '<li>No visible impact paths.</li>'}</ol>
          ${renderImpactInspector(firstImpact, report)}
        </aside>
      </div>
    </section>
  `;
}

function renderImpactMapInsight(map: ReturnType<typeof buildImpactMap>, displayedPathCount: number): string {
  const primaryChange = map.changedNodes[0]?.label ?? 'Changed root';
  const primaryTarget = map.affectedNodes[0];
  const primaryTargetLabel = primaryTarget?.label ?? 'No affected target';
  const primaryEdge = map.edges.find((edge) => edge.from === map.changedNodes[0]?.id && edge.to === primaryTarget?.id) ?? map.edges[0];
  const relation = primaryEdge?.label ?? 'IMPACTS';
  const confidence = primaryTarget?.confidence ?? primaryEdge?.confidence ?? 'unknown';
  return `
    <div class="map-insight" aria-label="Primary impact flow">
      <span>Primary impact flow</span>
      <strong>${escapeHtml(shortenMiddle(primaryChange, 34))} <em>&rarr;</em> ${escapeHtml(shortenMiddle(primaryTargetLabel, 34))}</strong>
      <small>${escapeHtml(relation)} · ${escapeHtml(String(map.affectedNodes.length))} targets · ${escapeHtml(String(displayedPathCount))} displayed paths · ${escapeHtml(confidence)} confidence</small>
    </div>
  `;
}

function buildImpactMap(
  graph: UiGraphPreview | null,
  report: UiReportPreview | null
): {
  changedNodes: ImpactMapNode[];
  affectedNodes: ImpactMapNode[];
  edges: ImpactMapEdge[];
  nodeById: Map<string, ImpactMapNode>;
} {
  const changedNodes = uniqueImpactMapNodes([
    ...(report?.changed ?? []).map((entity): ImpactMapNode => ({
      id: entity.id,
      label: entityLabel(entity),
      kind: entity.kind,
      group: 'changed'
    })),
    ...(graph?.nodes ?? []).filter((node) => node.group === 'changed').map(graphNodeForImpactMap)
  ]).slice(0, 5);
  const affectedNodes = uniqueImpactMapNodes([
    ...[...(report?.affectedFiles ?? [])].sort(compareAffectedFilesForUi).map((item): ImpactMapNode => ({
      id: `file:${item.path}`,
      label: item.path,
      kind: 'file',
      group: 'affected',
      confidence: item.confidence,
      path: item.path
    })),
    ...(graph?.nodes ?? []).filter((node) => node.group !== 'changed').map(graphNodeForImpactMap)
  ]).slice(0, 8);
  const nodeById = new Map([...changedNodes, ...affectedNodes].map((node) => [node.id, node]));
  const changedIds = new Set(changedNodes.map((node) => node.id));
  const affectedIds = new Set(affectedNodes.map((node) => node.id));
  const affectedFilesByNodeId = new Map((report?.affectedFiles ?? []).map((item) => [`file:${item.path}`, item]));
  const edges: ImpactMapEdge[] = [];
  const seenEdges = new Set<string>();
  for (const edge of graph?.edges ?? []) {
    const oriented = orientImpactEdge(edge, changedIds, affectedIds);
    if (!oriented) continue;
    const key = `${oriented.from}:${oriented.to}:${oriented.label}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push(oriented);
  }
  if (changedNodes[0]) {
    for (const node of affectedNodes) {
      if (edges.some((edge) => edge.to === node.id)) continue;
      const affectedFile = affectedFilesByNodeId.get(node.id);
      edges.push({
        from: changedNodes[0].id,
        to: node.id,
        label: affectedFile ? impactPathLabel(affectedFile) : 'IMPACTS',
        confidence: node.confidence ?? affectedFile?.confidence ?? 'unknown'
      });
    }
  }
  return { changedNodes, affectedNodes, edges: edges.slice(0, 12), nodeById };
}

function renderImpactMapSvg(map: ReturnType<typeof buildImpactMap>): string {
  const width = 760;
  const leftX = 38;
  const rightX = 462;
  const nodeWidth = 238;
  const nodeHeight = 54;
  const rowCount = Math.max(map.changedNodes.length, map.affectedNodes.length, 1);
  const height = Math.max(420, 150 + rowCount * 70);
  const changedPositions = impactNodePositions(map.changedNodes, height);
  const affectedPositions = impactNodePositions(map.affectedNodes, height);
  const yByNode = new Map<string, number>([
    ...map.changedNodes.map((node, index): [string, number] => [node.id, changedPositions[index] ?? 92]),
    ...map.affectedNodes.map((node, index): [string, number] => [node.id, affectedPositions[index] ?? 92])
  ]);
  const edges = map.edges.map((edge) => {
    const fromY = yByNode.get(edge.from);
    const toY = yByNode.get(edge.to);
    if (fromY === undefined || toY === undefined) return '';
    const startX = leftX + nodeWidth;
    const endX = rightX;
    const controlX = (startX + endX) / 2;
    const labelY = Math.min(height - 32, Math.max(78, (fromY + toY) / 2 - 8));
    return `
      <path class="map-edge confidence-${escapeHtml(edge.confidence)}" d="M ${startX} ${fromY} C ${controlX} ${fromY}, ${controlX} ${toY}, ${endX} ${toY}" marker-end="url(#impactArrow)" />
      <text class="map-edge-label" x="${controlX}" y="${labelY}" text-anchor="middle">${escapeHtml(shortenMiddle(edge.label, 18))}</text>
    `;
  }).join('');
  const changedNodes = map.changedNodes.map((node, index) =>
    renderImpactMapNode(node, leftX, (changedPositions[index] ?? 92) - nodeHeight / 2, nodeWidth, nodeHeight)
  ).join('');
  const affectedNodes = map.affectedNodes.map((node, index) =>
    renderImpactMapNode(node, rightX, (affectedPositions[index] ?? 92) - nodeHeight / 2, nodeWidth, nodeHeight)
  ).join('');

  return `
    <svg class="impact-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMin meet" role="img" aria-label="Changed entities connected to affected targets">
      <defs>
        <marker id="impactArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
          <path class="map-arrow" d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      <rect class="map-stage map-stage-changed" x="24" y="58" width="290" height="${height - 86}" rx="16" />
      <rect class="map-stage map-stage-affected" x="438" y="58" width="290" height="${height - 86}" rx="16" />
      <text class="map-column-label" x="${leftX}" y="36">Changed root</text>
      <text class="map-route-label" x="${(leftX + nodeWidth + rightX) / 2}" y="36" text-anchor="middle">Impact path</text>
      <text class="map-column-label" x="${rightX}" y="36">Affected targets</text>
      <g>${edges}</g>
      <g>${changedNodes}</g>
      <g>${affectedNodes}</g>
    </svg>
  `;
}

function renderImpactMapNode(node: ImpactMapNode, x: number, y: number, width: number, height: number): string {
  const label = compactMapLabel(node.label, 42);
  const impactAttrs = node.group === 'affected' && node.path
    ? ` data-impact-path="${escapeHtml(node.path)}" tabindex="0" role="button" aria-label="Inspect ${escapeHtml(node.path)}"`
    : '';
  const selectableClass = impactAttrs ? ' selectable-impact' : '';
  return `
    <g class="map-node${selectableClass} map-node-${escapeHtml(node.group)} confidence-node-${escapeHtml(node.confidence ?? 'unknown')}" transform="translate(${x} ${y})"${impactAttrs}>
      <title>${escapeHtml(node.label)}</title>
      <rect width="${width}" height="${height}" rx="8" />
      <circle cx="20" cy="24" r="5" />
      <text class="map-node-label" x="36" y="23">${escapeHtml(label)}</text>
      <text class="map-node-kind" x="36" y="41">${escapeHtml(node.kind)}</text>
    </g>
  `;
}

function impactNodePositions(nodes: ImpactMapNode[], height: number): number[] {
  if (nodes.length === 0) return [];
  const top = 110;
  const bottom = height - 64;
  if (nodes.length === 1) return [(top + bottom) / 2];
  const step = (bottom - top) / (nodes.length - 1);
  return nodes.map((_, index) => top + step * index);
}

function graphNodeForImpactMap(node: UiGraphPreview['nodes'][number]): ImpactMapNode {
  return {
    id: node.id,
    label: node.label,
    kind: node.kind,
    group: node.group,
    ...(node.path ? { path: node.path } : {}),
    ...(node.confidence ? { confidence: node.confidence } : {})
  };
}

function orientImpactEdge(
  edge: UiGraphPreview['edges'][number],
  changedIds: ReadonlySet<string>,
  affectedIds: ReadonlySet<string>
): ImpactMapEdge | null {
  if (changedIds.has(edge.source) && affectedIds.has(edge.target)) {
    return { from: edge.source, to: edge.target, label: edge.label, confidence: edge.confidence };
  }
  if (changedIds.has(edge.target) && affectedIds.has(edge.source)) {
    return { from: edge.target, to: edge.source, label: edge.label, confidence: edge.confidence };
  }
  return null;
}

function uniqueImpactMapNodes(nodes: ImpactMapNode[]): ImpactMapNode[] {
  const byId = new Map<string, ImpactMapNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) continue;
    byId.set(node.id, node);
  }
  return [...byId.values()];
}

function compareAffectedFilesForUi(left: UiReportPreview['affectedFiles'][number], right: UiReportPreview['affectedFiles'][number]): number {
  return confidenceSortRank(left.confidence) - confidenceSortRank(right.confidence)
    || (left.depth ?? 99) - (right.depth ?? 99)
    || left.path.localeCompare(right.path);
}

function confidenceSortRank(confidence: string): number {
  if (confidence === 'proven') return 0;
  if (confidence === 'inferred') return 1;
  if (confidence === 'heuristic') return 2;
  return 3;
}

function blastRadiusLabel(count: number): string {
  if (count === 0) return 'clear';
  if (count <= 3) return 'contained';
  if (count <= 12) return 'expanding';
  return 'wide';
}

function impactPathLabel(item: UiReportPreview['affectedFiles'][number]): string {
  const relationCount = item.relationPath?.length ?? 0;
  if (relationCount > 1) return `${relationCount} hops`;
  return item.reason.split(' ')[0]?.toUpperCase() ?? 'IMPACTS';
}

function entityLabel(entity: ImpactReport['changed'][number]): string {
  return entity.displayName ?? entity.path ?? entity.symbol ?? entity.id;
}

function renderImpactInspector(
  item: UiReportPreview['affectedFiles'][number] | undefined,
  report: UiReportPreview | null
): string {
  const evidence = item && report ? impactEvidenceForPath(report.evidence, item.path) : [];
  const action = item && report ? actionByTargetPath(report.actions).get(item.path) : undefined;
  return `
    <section class="impact-inspector" aria-live="polite">
      <h3>Impact Inspector</h3>
      <strong id="inspectorPath">${escapeHtml(item?.path ?? 'No affected target selected')}</strong>
      <span id="inspectorReason">${escapeHtml(item?.reason ?? 'Select an affected target in the map or impact list.')}</span>
      <dl>
        <div>
          <dt>Confidence</dt>
          <dd id="inspectorConfidence">${escapeHtml(item?.confidence ?? 'unknown')}</dd>
        </div>
        <div>
          <dt>Relation path</dt>
          <dd id="inspectorRelation">${escapeHtml(item?.relationPath?.join(' -> ') ?? 'direct or not recorded')}</dd>
        </div>
        <div>
          <dt>Evidence hits</dt>
          <dd id="inspectorEvidence">0</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd id="inspectorSource">Select evidence to open a local source view</dd>
        </div>
      </dl>
      <section class="inspector-action">
        <h4>Next verification</h4>
        <div id="inspectorAction">${renderInspectorAction(action)}</div>
      </section>
      <section class="inspector-evidence">
        <h4>Top evidence</h4>
        <ul id="inspectorEvidenceList">${renderInspectorEvidenceList(evidence)}</ul>
      </section>
    </section>
  `;
}

function renderInspectorAction(action: ImpactAction | undefined): string {
  if (!action) return '<span class="inspector-empty">No verification action recorded.</span>';
  const command = actionCommandText(action);
  if (!command) return '<span class="inspector-empty">No command recorded for this action.</span>';
  return `
    <code>${escapeHtml(command)}</code>
    <button class="copy-command" type="button" data-command="${escapeHtml(command)}" aria-label="Copy inspector verification command">Copy</button>
  `;
}

function renderInspectorEvidenceList(evidence: readonly UiEvidencePreview[]): string {
  if (evidence.length === 0) return '<li class="inspector-empty">No matching evidence recorded.</li>';
  return evidence.slice(0, 3).map((item) => {
    const source = evidenceSourceLocation(item);
    return `
      <li>
        <strong>${escapeHtml(item.file)}</strong>
        <span>${escapeHtml(item.kind)} · ${escapeHtml(item.confidence)}</span>
        ${source ? `<a class="source-link" href="${escapeHtml(source.href)}" target="_blank" rel="noreferrer">${escapeHtml(source.label)}</a>` : ''}
        <pre>${escapeHtml(shortenMiddle(item.snippet, 120))}</pre>
      </li>
    `;
  }).join('');
}

function impactEvidenceForPath(evidence: readonly UiEvidencePreview[], pathValue: string): UiEvidencePreview[] {
  return evidence.filter((item) => impactEvidenceMatchesPath(item, pathValue));
}

function impactEvidenceMatchesPath(item: UiEvidencePreview, pathValue: string): boolean {
  return item.file === pathValue || item.subject?.path === pathValue || item.snippet.includes(pathValue);
}

function evidenceSourceLocation(item: UiEvidencePreview): SourceLocation | undefined {
  if (!item.file || item.file.includes('\0')) return undefined;
  const line = item.startLine ?? 1;
  if (!Number.isInteger(line) || line < 1) return undefined;
  const endLine = item.endLine && item.endLine > line ? item.endLine : undefined;
  return {
    href: sourceHref(item.file, line),
    label: endLine ? `L${line}-L${endLine}` : `L${line}`,
    line
  };
}

function renderActionRow(item: ImpactAction): string {
  const command = actionCommandText(item);
  const targetPath = item.target.path && !item.target.path.includes('\0') ? item.target.path : undefined;
  const targetLabel = targetPath ?? item.target.displayName ?? item.target.symbol ?? item.target.id;
  const heading = item.kind === 'verify' && targetLabel ? `Verify ${targetLabel}` : item.display;
  const meta = [
    item.runnerId ? `runner ${item.runnerId}` : undefined,
    targetLabel ? `target ${targetLabel}` : undefined,
    `${item.confidence} confidence`
  ].filter((value): value is string => Boolean(value)).join(' · ');
  const sourceLink = targetPath
    ? `<a class="source-link" href="${escapeHtml(sourceHref(targetPath, 1))}" target="_blank" rel="noreferrer">Target</a>`
    : '';

  return `
    <li class="action-row" data-filter-text="${escapeHtml(`${item.kind} ${heading} ${item.display} ${command ?? ''} ${targetLabel} ${item.confidence}`)}">
      <span class="kind">${escapeHtml(item.kind)}</span>
      <div class="action-main">
        <strong>${escapeHtml(heading)}</strong>
        <span>${escapeHtml(meta)}</span>
        ${command ? `<code>${escapeHtml(command)}</code>` : `<span>${escapeHtml(item.display)}</span>`}
      </div>
      <div class="action-controls">
        ${command ? `<button class="copy-command" type="button" data-command="${escapeHtml(command)}" aria-label="Copy ${escapeHtml(item.kind)} command">Copy</button>` : ''}
        ${sourceLink}
      </div>
    </li>
  `;
}

function actionCommandText(item: ImpactAction): string | undefined {
  if (!item.command) return undefined;
  return [item.command, ...(item.args ?? [])].map(shellQuoteForUi).join(' ');
}

function shellQuoteForUi(value: string): string {
  const displayValue = value
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  if (displayValue === '--') return displayValue;
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(displayValue) && !displayValue.startsWith('-')) return displayValue;
  return `'${displayValue.replaceAll("'", `'\\''`)}'`;
}

function sourceHref(file: string, line: number): string {
  return `/source?path=${encodeURIComponent(file)}&line=${line}`;
}

function renderImpactPathRow(
  item: UiReportPreview['affectedFiles'][number],
  evidenceCount: number,
  action: ImpactAction | undefined
): string {
  const trail = impactTrailParts(item).map((part) => `<span>${escapeHtml(part)}</span>`).join('');
  const actionCommand = action ? actionCommandText(action) : undefined;
  const filterText = [
    item.path,
    item.reason,
    item.confidence,
    item.relationPath?.join(' '),
    evidenceCount ? `${evidenceCount} evidence` : '',
    actionCommand ?? ''
  ].filter(Boolean).join(' ');

  return `
    <li class="impact-row impact-path-row selectable-impact" tabindex="0" role="button" data-impact-path="${escapeHtml(item.path)}" data-filter-text="${escapeHtml(filterText)}">
      <div class="impact-path-main">
        <strong>${escapeHtml(item.path)}</strong>
        <span>${escapeHtml(item.reason)}</span>
        <div class="relation-trail" aria-label="Relation trail">${trail}</div>
      </div>
      <div class="impact-path-meta">
        <span class="badge confidence-${escapeHtml(item.confidence)}">${escapeHtml(item.confidence)}</span>
        <span class="evidence-pill">${escapeHtml(String(evidenceCount))} evidence</span>
        <a class="source-link" href="${escapeHtml(sourceHref(item.path, 1))}" target="_blank" rel="noreferrer">Source</a>
        ${actionCommand ? `<button class="copy-command" type="button" data-command="${escapeHtml(actionCommand)}" aria-label="Copy verification command for ${escapeHtml(item.path)}">Copy verify</button>` : ''}
      </div>
    </li>
  `;
}

function impactTrailParts(item: UiReportPreview['affectedFiles'][number]): string[] {
  const parts = item.relationPath && item.relationPath.length > 0 ? item.relationPath : [item.reason];
  return parts.slice(0, 4);
}

function evidenceCountByImpactPath(
  affectedFiles: readonly UiReportPreview['affectedFiles'][number][],
  evidence: readonly UiEvidencePreview[]
): Map<string, number> {
  const paths = new Set(affectedFiles.map((item) => item.path));
  const counts = new Map<string, number>();
  for (const pathValue of paths) counts.set(pathValue, 0);
  for (const item of evidence) {
    for (const pathValue of paths) {
      if (impactEvidenceMatchesPath(item, pathValue)) {
        counts.set(pathValue, (counts.get(pathValue) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function actionByTargetPath(actions: readonly ImpactAction[]): Map<string, ImpactAction> {
  const byPath = new Map<string, ImpactAction>();
  for (const action of actions) {
    const targetPath = action.target.path;
    if (!targetPath || byPath.has(targetPath)) continue;
    byPath.set(targetPath, action);
  }
  return byPath;
}

function compactMapLabel(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const pathParts = value.split('/').filter(Boolean);
  if (pathParts.length > 2) {
    const tail = pathParts.slice(-2).join('/');
    if (tail.length <= maxLength) return tail;
  }
  return shortenMiddle(value, maxLength);
}

function shortenMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 5) return value.slice(0, maxLength);
  const prefixLength = Math.ceil((maxLength - 1) / 2);
  const suffixLength = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, prefixLength)}…${value.slice(value.length - suffixLength)}`;
}

export function renderUiHtml(snapshot: UiSnapshot): string {
  const report = snapshot.selectedReport;
  const doctor = snapshot.doctor;
  const title = report ? `Impact Workbench - ${report.id}` : 'Impact Workbench';
  const missingReportOption = snapshot.selectedReportId === null && snapshot.reports.length > 0
    ? '<option value="" selected>Select a report</option>'
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
    renderImpactPathRow(item, evidenceCountsByPath.get(item.path) ?? 0, actionByPath.get(item.path))
  ).join('');
  const evidenceRows = (report?.evidence ?? []).slice(0, 30).map((item) => {
    const source = evidenceSourceLocation(item);
    return `
    <li class="evidence-row" data-impact-path="${escapeHtml(item.file)}" data-source-href="${escapeHtml(source?.href ?? '')}" data-source-label="${escapeHtml(source?.label ?? '')}" data-filter-text="${escapeHtml(`${item.file} ${item.kind} ${item.snippet}`)}">
      <div class="evidence-meta">
        <strong>${escapeHtml(item.file)}</strong>
        <span>${escapeHtml(item.kind)} · ${escapeHtml(item.confidence)}</span>
        ${source ? `<a class="source-link" href="${escapeHtml(source.href)}" target="_blank" rel="noreferrer">Open source ${escapeHtml(source.label)}</a>` : ''}
        ${item.resourceUri ? `<small>${escapeHtml(item.resourceUri)}</small>` : ''}
      </div>
      <pre>${escapeHtml(item.snippet)}</pre>
    </li>
  `;
  }).join('');
  const actionRows = (report?.actions ?? []).slice(0, 20).map(renderActionRow).join('');
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
  const impactSummaryPanel = renderImpactSummaryPanel(snapshot);
  const impactTriageStrip = renderImpactTriageStrip(snapshot);
  const impactMapPanel = renderImpactMapPanel(snapshot.graph, report);
  const reportDeltaPanel = renderReportDeltaPanel(snapshot.comparison);
  const dataJson = JSON.stringify(snapshot).replaceAll('<', '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f2f4f1;
      --surface: #fffefa;
      --surface-subtle: #f7f5ee;
      --surface-strong: #20251f;
      --ink: #172019;
      --ink-inverse: #f8f4e8;
      --muted: #667067;
      --muted-inverse: #bcc8bd;
      --line: #d8d4c8;
      --line-strong: #b8b2a3;
      --green: #18735f;
      --amber: #a56312;
      --red: #b5423f;
      --teal: #1f6f78;
      --blue: #365f86;
      --graph: #263d32;
      --shadow: 0 18px 45px rgba(23, 32, 25, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      background:
        linear-gradient(180deg, #f7f8f4 0, var(--bg) 280px),
        var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    button, input, select { font: inherit; letter-spacing: 0; }
    .topbar {
      min-height: 78px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      align-items: center;
      padding: 14px 20px;
      border-bottom: 3px solid var(--green);
      background: var(--surface-strong);
      color: var(--ink-inverse);
      box-shadow: 0 10px 30px rgba(23, 32, 25, 0.16);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    .title { min-width: 0; }
    .eyebrow {
      display: block;
      margin-bottom: 4px;
      color: #9ed3c4;
      font-size: 12px;
      font-weight: 700;
    }
    .title h1 { margin: 0; font-size: 22px; line-height: 1.15; }
    .title p { margin: 6px 0 0; color: var(--muted-inverse); font-size: 13px; overflow-wrap: anywhere; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .toolbar input, .toolbar select {
      min-height: 38px;
      border: 1px solid #566158;
      border-radius: 6px;
      background: #fbfaf5;
      color: var(--ink);
      padding: 0 12px;
      max-width: min(360px, 100%);
    }
    .toolbar input:focus, .toolbar select:focus {
      outline: 2px solid #9ed3c4;
      outline-offset: 2px;
    }
    .shell { width: min(1500px, 100%); margin: 0 auto; padding: 18px; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(8, minmax(112px, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }
    .metric, .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .metric {
      min-height: 64px;
      padding: 10px 12px;
      border-top: 4px solid var(--blue);
      box-shadow: 0 8px 24px rgba(23, 32, 25, 0.05);
    }
    .metric:nth-child(2), .metric:nth-child(3) { border-top-color: var(--green); }
    .metric:nth-child(4) { border-top-color: var(--teal); }
    .metric:nth-child(5) { border-top-color: var(--amber); }
    .metric:nth-child(6) { border-top-color: var(--red); }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .metric strong {
      display: block;
      margin-top: 7px;
      font-size: 22px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .impact-triage {
      display: grid;
      grid-template-columns: minmax(220px, 0.42fr) minmax(0, 1fr);
      margin: 0 0 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .triage-head {
      display: grid;
      align-content: center;
      gap: 6px;
      min-width: 0;
      padding: 14px 16px;
      border-right: 1px solid rgba(248, 244, 232, 0.14);
      background: #18211b;
      color: var(--ink-inverse);
    }
    .triage-head h2 {
      margin: 0;
      color: #9ed3c4;
      font-size: 12px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .triage-head strong {
      font-size: 25px;
      line-height: 1;
      text-transform: capitalize;
    }
    .triage-head p {
      margin: 0;
      color: #bfd1c6;
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .triage-flow {
      list-style: none;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin: 0;
      padding: 12px;
      background: #fbfaf5;
    }
    .triage-step {
      position: relative;
      min-width: 0;
      min-height: 78px;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      gap: 5px;
      border: 1px solid var(--line);
      border-left: 4px solid var(--line-strong);
      border-radius: 8px;
      padding: 10px 12px;
      background: #fffefa;
    }
    .triage-step:not(:last-child)::after {
      content: "→";
      position: absolute;
      right: -12px;
      top: 50%;
      z-index: 1;
      width: 18px;
      height: 18px;
      display: grid;
      place-items: center;
      transform: translateY(-50%);
      border: 1px solid #d7d2c4;
      border-radius: 999px;
      background: #fbfaf5;
      color: var(--muted);
      font-size: 12px;
      font-weight: 900;
    }
    .triage-step span {
      color: var(--muted);
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .triage-step strong {
      color: var(--ink);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 15px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .triage-step small {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .triage-step-changed { border-left-color: var(--green); }
    .triage-step-affected { border-left-color: var(--teal); }
    .triage-step-action { border-left-color: var(--amber); }
    .triage-step.selectable-impact:hover {
      background: #f4fbf7;
      box-shadow: inset 0 0 0 1px #9fcdbd;
    }
    .impact-triage-wide .triage-head { box-shadow: inset 4px 0 0 var(--red); }
    .impact-triage-expanding .triage-head { box-shadow: inset 4px 0 0 var(--amber); }
    .impact-triage-contained .triage-head, .impact-triage-clear .triage-head { box-shadow: inset 4px 0 0 var(--green); }
    .report-delta-panel {
      margin: 0 0 14px;
    }
    .delta-content {
      display: grid;
      grid-template-columns: minmax(220px, 0.58fr) minmax(320px, 0.9fr) minmax(460px, 1.35fr);
      min-height: 150px;
    }
    .delta-hero {
      display: grid;
      align-content: center;
      gap: 6px;
      padding: 16px;
      border-right: 1px solid var(--line);
      background: #18211b;
      color: var(--ink-inverse);
    }
    .delta-hero span, .delta-hero small {
      color: #bfd1c6;
      font-size: 12px;
      line-height: 1.4;
    }
    .delta-hero strong {
      font-size: 27px;
      line-height: 1.05;
    }
    .delta-hero-wider { box-shadow: inset 4px 0 0 var(--amber); }
    .delta-hero-narrower { box-shadow: inset 4px 0 0 var(--green); }
    .delta-hero-unchanged { box-shadow: inset 4px 0 0 var(--teal); }
    .delta-metrics {
      list-style: none;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin: 0;
      padding: 14px;
      border-right: 1px solid var(--line);
      background: #fffefa;
    }
    .delta-metrics li {
      display: grid;
      gap: 4px;
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px;
      background: #fbfaf5;
    }
    .delta-metrics span, .delta-lane span, .delta-paths h3 {
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .delta-metrics strong {
      color: var(--ink);
      font-size: 22px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .delta-metrics em {
      font-size: 11px;
      font-style: normal;
      font-weight: 800;
    }
    .delta-detail {
      display: grid;
      gap: 10px;
      padding: 14px;
      background: #fbfaf5;
      min-width: 0;
    }
    .delta-confidence {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .delta-confidence span {
      width: fit-content;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 3px 7px;
      background: #f5f3eb;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .delta-confidence b {
      margin-right: 4px;
      color: var(--ink);
      font-variant-numeric: tabular-nums;
    }
    .delta-policy {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .delta-policy span {
      width: fit-content;
      border: 1px solid #d9ded5;
      border-radius: 6px;
      padding: 3px 7px;
      background: #f3f7f4;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
    }
    .delta-presets {
      list-style: none;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 7px;
      margin: 0;
      padding: 0;
    }
    .delta-preset {
      min-width: 0;
      display: grid;
      gap: 3px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      background: #fffefa;
    }
    .delta-preset strong {
      color: var(--ink);
      overflow-wrap: anywhere;
      font-size: 12px;
    }
    .delta-preset span {
      width: fit-content;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 2px 6px;
      color: var(--muted);
      background: #f5f3eb;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .delta-preset b {
      color: var(--ink);
      font-size: 17px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .delta-preset small {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .delta-preset .copy-command {
      justify-self: start;
      margin-top: 2px;
      min-height: 24px;
      padding: 2px 7px;
      font-size: 11px;
    }
    .delta-preset-wider { border-color: #d7b477; box-shadow: inset 3px 0 0 var(--amber); }
    .delta-preset-narrower { border-color: #89b6a5; box-shadow: inset 3px 0 0 var(--green); }
    .delta-preset-unchanged { border-color: #8bb8bc; box-shadow: inset 3px 0 0 var(--teal); }
    .delta-lanes {
      list-style: none;
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 7px;
      margin: 0;
      padding: 0;
    }
    .delta-lane {
      display: grid;
      gap: 4px;
      min-width: 0;
      min-height: 68px;
      border: 1px solid var(--line);
      border-left: 4px solid var(--line-strong);
      border-radius: 8px;
      padding: 8px;
      background: #fffefa;
    }
    .delta-lane b {
      color: var(--ink);
      font-size: 17px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .delta-lane small {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .delta-lane-green { border-left-color: var(--green); }
    .delta-lane-amber { border-left-color: var(--amber); }
    .delta-lane-teal { border-left-color: var(--teal); }
    .delta-lane-blue { border-left-color: var(--blue); }
    .delta-lane-red { border-left-color: var(--red); }
    .delta-paths {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .delta-paths section {
      min-width: 0;
    }
    .delta-paths h3 {
      margin: 0 0 6px;
    }
    .delta-paths ul {
      list-style: none;
      display: grid;
      gap: 4px;
      margin: 0;
      padding: 0;
    }
    .delta-paths li {
      min-width: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 5px 8px;
      align-items: center;
      overflow-wrap: anywhere;
      color: var(--ink);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }
    .delta-paths li > span {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .delta-paths li > small {
      grid-column: 1;
      color: var(--muted);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 11px;
      line-height: 1.25;
    }
    .delta-paths li > .source-link {
      grid-column: 2;
      grid-row: 1 / span 2;
      align-self: center;
    }
    .delta-positive strong, .delta-positive b, .delta-positive em { color: var(--amber); }
    .delta-negative strong, .delta-negative b, .delta-negative em { color: var(--green); }
    .delta-neutral strong, .delta-neutral b, .delta-neutral em { color: var(--teal); }
    .impact-overview {
      display: grid;
      grid-template-columns: minmax(680px, 1.65fr) minmax(320px, 0.72fr);
      gap: 14px;
      align-items: stretch;
      margin-bottom: 14px;
    }
    .workbench {
      display: grid;
      grid-template-columns: minmax(250px, 0.78fr) minmax(360px, 1.05fr) minmax(460px, 1.32fr);
      gap: 14px;
      align-items: start;
    }
    .stacked-pane {
      display: grid;
      gap: 14px;
      min-width: 0;
    }
    .panel {
      min-width: 0;
      overflow: hidden;
      box-shadow: var(--shadow);
    }
    .panel > h2, .panel-heading {
      margin: 0;
      padding: 13px 14px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, #fffefa 0, var(--surface-subtle) 100%);
      color: #243126;
    }
    .panel > h2, .panel-heading h2 {
      font-size: 13px;
      font-weight: 800;
    }
    .panel-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .panel-heading h2 { margin: 0; }
    .panel-chips {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
    }
    .panel-chips span {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 3px 7px;
      background: #f5f3eb;
    }
    .list { list-style: none; margin: 0; padding: 0; max-height: 540px; overflow: auto; }
    .evidence-panel .list { max-height: 680px; }
    .entity-row, .impact-row, .evidence-row, .action-row, .pack-row, .coverage-row, .work-artifact-row, .workspace-row, .workspace-link-row, .workspace-contract-row, .finding {
      padding: 11px 14px;
      border-bottom: 1px solid var(--line);
      min-width: 0;
    }
    .entity-row:hover, .impact-row:hover, .evidence-row:hover, .action-row:hover, .pack-row:hover, .coverage-row:hover, .work-artifact-row:hover, .workspace-row:hover, .workspace-link-row:hover, .workspace-contract-row:hover {
      background: #f8fbf7;
    }
    .entity-row { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; align-items: center; }
    .action-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 10px;
      align-items: start;
      background: #fffefa;
    }
    .action-main {
      min-width: 0;
      display: grid;
      gap: 5px;
    }
    .action-main strong {
      display: block;
      overflow-wrap: anywhere;
      font-size: 13px;
    }
    .action-main span {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .action-main code {
      width: fit-content;
      max-width: 100%;
      display: block;
      border: 1px solid #d9ded5;
      border-radius: 6px;
      padding: 5px 7px;
      background: #f3f7f4;
      color: #263d32;
      white-space: pre-wrap;
    }
    .action-controls {
      grid-column: 2;
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-start;
      gap: 6px;
    }
    .copy-command {
      min-height: 26px;
      border: 1px solid #89b6a5;
      border-radius: 6px;
      padding: 3px 8px;
      background: #eef8f3;
      color: var(--green);
      cursor: pointer;
      font-size: 12px;
      font-weight: 800;
    }
    .copy-command:hover {
      border-color: var(--green);
      background: #e2f2eb;
    }
    .copy-command:focus-visible {
      outline: 2px solid #73c2ac;
      outline-offset: 2px;
    }
    .copy-command[data-state="copied"] {
      border-color: #8bb8bc;
      background: #eef7f8;
      color: var(--teal);
    }
    .copy-command[data-state="failed"] {
      border-color: #d9a0a0;
      background: #fff1f0;
      color: var(--red);
    }
    .impact-row, .workspace-link-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
    .impact-path-row {
      align-items: start;
      background: #fffefa;
    }
    .impact-path-main {
      min-width: 0;
      display: grid;
      gap: 5px;
    }
    .impact-path-meta {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
      max-width: 220px;
    }
    .relation-trail {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 5px;
    }
    .relation-trail span {
      width: fit-content;
      max-width: 100%;
      border: 1px solid #d7b477;
      border-radius: 6px;
      padding: 2px 6px;
      background: #fff6e7;
      color: var(--amber);
      font-size: 11px;
      font-weight: 800;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .evidence-pill {
      width: fit-content;
      border: 1px solid #d9ded5;
      border-radius: 6px;
      padding: 3px 8px;
      background: #f3f7f4;
      color: var(--graph);
      font-size: 12px;
      font-weight: 800;
      white-space: nowrap;
    }
    .impact-row strong, .pack-row strong, .coverage-row strong, .work-artifact-row strong, .workspace-row strong, .workspace-link-row strong, .workspace-contract-row strong { display: block; overflow-wrap: anywhere; }
    .impact-row strong, .evidence-meta strong, .coverage-row strong, .workspace-link-row strong {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
    }
    .impact-row span, .pack-row span, .coverage-row span, .work-artifact-row span, .work-artifact-row small, .workspace-row span, .workspace-link-row span, .workspace-link-row small, .workspace-contract-row span, .evidence-meta span {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .kind, .badge {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 12px;
      white-space: nowrap;
      background: #f3f1e8;
      font-weight: 700;
    }
    .confidence-proven { color: var(--green); border-color: #89b6a5; background: #eef8f3; }
    .confidence-inferred { color: var(--teal); border-color: #8bb8bc; background: #eef7f8; }
    .confidence-heuristic { color: var(--amber); border-color: #d7b477; background: #fff6e7; }
    .confidence-low { color: var(--red); border-color: #d9a0a0; background: #fff1f0; }
    .freshness-current { color: var(--green); border-color: #89b6a5; background: #eef8f3; }
    .freshness-stale { color: var(--red); border-color: #d9a0a0; background: #fff1f0; }
    .freshness-unknown { color: var(--amber); border-color: #d7b477; background: #fff6e7; }
    .evidence-row { background: #fffefa; }
    .evidence-meta {
      display: grid;
      gap: 3px;
    }
    .source-link {
      width: fit-content;
      border: 1px solid #8bb8bc;
      border-radius: 6px;
      padding: 3px 8px;
      color: var(--teal);
      background: #eef7f8;
      font-size: 12px;
      font-weight: 800;
      text-decoration: none;
    }
    .source-link:hover {
      background: #e2f2f4;
      border-color: var(--teal);
    }
    .source-link:focus-visible {
      outline: 2px solid #73c2ac;
      outline-offset: 2px;
    }
    pre {
      margin: 9px 0 0;
      padding: 10px;
      border: 1px solid #d9ded5;
      border-radius: 6px;
      background: #f3f7f4;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
      line-height: 1.45;
      color: #243126;
    }
    code { font-size: 12px; overflow-wrap: anywhere; color: var(--graph); }
    .impact-summary-panel {
      display: grid;
      grid-template-rows: auto auto auto auto minmax(0, 1fr);
    }
    .blast-card {
      margin: 14px;
      padding: 16px;
      border-radius: 8px;
      background: #18211b;
      color: var(--ink-inverse);
      box-shadow: inset 0 0 0 1px rgba(158, 211, 196, 0.24);
    }
    .blast-card span, .blast-card small {
      display: block;
      color: #bfd1c6;
      font-size: 12px;
      line-height: 1.45;
    }
    .blast-card strong {
      display: block;
      margin: 7px 0 5px;
      font-size: 31px;
      line-height: 1;
      text-transform: capitalize;
    }
    .confidence-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      padding: 0 14px 14px;
    }
    .confidence-meter {
      display: grid;
      gap: 3px;
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      background: #fbfaf5;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .confidence-meter b {
      color: var(--ink);
      font-size: 18px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .impact-lanes {
      list-style: none;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin: 0;
      padding: 0 14px 14px;
    }
    .impact-lane {
      min-width: 0;
      min-height: 76px;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      gap: 4px;
      border: 1px solid var(--line);
      border-left: 4px solid var(--line-strong);
      border-radius: 8px;
      padding: 9px 10px;
      background: #fbfaf5;
    }
    .impact-lane:hover {
      background: #f8fbf7;
    }
    .impact-lane span {
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .impact-lane b {
      color: var(--ink);
      font-size: 21px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .impact-lane small {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .impact-lane-green { border-left-color: var(--green); }
    .impact-lane-amber { border-left-color: var(--amber); }
    .impact-lane-teal { border-left-color: var(--teal); }
    .impact-lane-blue { border-left-color: var(--blue); }
    .impact-lane-red { border-left-color: var(--red); }
    .summary-columns {
      display: grid;
      grid-template-columns: 1fr;
      min-height: 0;
      border-top: 1px solid var(--line);
    }
    .summary-columns > div:first-child { border-bottom: 1px solid var(--line); }
    .summary-columns h3 {
      margin: 0;
      padding: 10px 14px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .summary-list { list-style: none; margin: 0; padding: 0; }
    .summary-list li {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 10px 14px;
      border-top: 1px solid var(--line);
      min-width: 0;
    }
    .summary-list strong { display: block; overflow-wrap: anywhere; font-size: 13px; }
    .summary-list small { color: var(--muted); font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; }
    .summary-list .empty { display: block; }
    .priority-row b {
      width: 24px;
      height: 24px;
      display: grid;
      place-items: center;
      border-radius: 6px;
      background: #edf5ef;
      color: var(--green);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .priority-row em { font-style: normal; }
    .selectable-impact {
      cursor: pointer;
      transition: background-color 120ms ease-out, box-shadow 120ms ease-out;
    }
    .selectable-impact:focus-visible {
      outline: 2px solid #73c2ac;
      outline-offset: -2px;
    }
    .selected-impact {
      background: #eef8f3 !important;
      box-shadow: inset 0 0 0 2px #73b29e;
    }
    .related-evidence {
      background: #f4fbf7 !important;
      box-shadow: inset 3px 0 0 #73b29e;
    }
    .map-panel {
      min-height: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      height: 100%;
    }
    .map-content {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(260px, 0.34fr);
      height: 100%;
      min-height: 560px;
      align-items: stretch;
    }
    .map-frame {
      min-width: 0;
      min-height: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      align-content: start;
      align-items: start;
      gap: 12px;
      padding: 14px;
      background:
        linear-gradient(180deg, rgba(24, 33, 27, 0.97), rgba(24, 33, 27, 0.94)),
        #18211b;
    }
    .map-insight {
      display: grid;
      gap: 3px;
      max-width: 760px;
      padding: 10px 12px;
      border: 1px solid rgba(168, 202, 186, 0.26);
      border-radius: 8px;
      background: rgba(15, 29, 22, 0.82);
      color: #e8f2eb;
    }
    .map-insight span {
      color: #a8caba;
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .map-insight strong {
      min-width: 0;
      color: #fffdf4;
      font-size: 17px;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
    .map-insight em {
      color: #73c2ac;
      font-style: normal;
    }
    .map-insight small {
      color: #c9d8cf;
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .impact-svg {
      display: block;
      width: 100%;
      height: 470px;
      filter: drop-shadow(0 16px 30px rgba(0, 0, 0, 0.18));
    }
    .map-stage {
      fill: rgba(255, 253, 244, 0.035);
      stroke: rgba(168, 202, 186, 0.16);
      stroke-width: 1;
    }
    .map-stage-affected {
      fill: rgba(255, 246, 231, 0.045);
      stroke: rgba(215, 180, 119, 0.22);
    }
    .map-column-label {
      fill: #a8caba;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .map-route-label {
      fill: #d2e1d7;
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .map-edge {
      fill: none;
      stroke: #73c2ac;
      stroke-width: 3;
      opacity: 0.88;
    }
    .map-arrow {
      fill: #73c2ac;
    }
    .map-edge.confidence-heuristic {
      stroke: #d59a45;
      stroke-dasharray: 8 6;
    }
    .map-edge.confidence-inferred { stroke: #69b9c0; }
    .map-edge.confidence-unknown { stroke: #a7b3aa; stroke-dasharray: 4 5; }
    .map-edge-label {
      fill: #142017;
      paint-order: stroke;
      stroke: #f6f2e8;
      stroke-width: 8px;
      stroke-linejoin: round;
      font-size: 11px;
      font-weight: 800;
    }
    .map-node rect {
      fill: #fbfaf5;
      stroke: #d6ded4;
      stroke-width: 1.2;
    }
    .map-node circle { fill: var(--blue); }
    .map-node-changed rect {
      fill: #eef8f3;
      stroke: #73b29e;
    }
    .map-node-changed circle { fill: var(--green); }
    .map-node-affected rect {
      fill: #fff7e8;
      stroke: #d7b477;
    }
    .map-node-affected circle { fill: var(--amber); }
    .confidence-node-proven rect {
      fill: #eef8f3;
      stroke: #73b29e;
    }
    .confidence-node-proven circle { fill: var(--green); }
    .confidence-node-inferred rect {
      fill: #edf9fa;
      stroke: #81bbc0;
    }
    .confidence-node-inferred circle { fill: var(--teal); }
    .map-node-label {
      fill: #142017;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      font-weight: 800;
    }
    .map-node-kind {
      fill: #64706a;
      font-size: 11px;
      font-weight: 700;
    }
    .map-node.selectable-impact rect {
      transition: fill 120ms ease-out, stroke 120ms ease-out, stroke-width 120ms ease-out;
    }
    .map-node.selected-impact rect {
      fill: #e0f4ea;
      stroke: #73c2ac;
      stroke-width: 2.5;
    }
    .map-legend {
      display: grid;
      align-content: start;
      gap: 10px;
      padding: 14px;
      border-left: 1px solid var(--line);
      background: #fbfaf5;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
      overflow: auto;
    }
    .map-legend div {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 800;
      color: #27312a;
    }
    .legend-swatch {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--blue);
    }
    .legend-swatch.changed { background: var(--green); }
    .legend-swatch.affected { background: var(--amber); }
    .legend-swatch.context { background: var(--teal); }
    .map-legend ol {
      display: grid;
      gap: 8px;
      margin: 8px 0 0;
      padding: 10px 0 0 18px;
      border-top: 1px solid var(--line);
    }
    .map-legend li strong {
      display: block;
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    .map-legend li span {
      display: inline-block;
      margin: 3px 0;
      padding: 2px 6px;
      border: 1px solid #d7b477;
      border-radius: 6px;
      color: var(--amber);
      background: #fff6e7;
      font-size: 11px;
      font-weight: 800;
    }
    .impact-inspector {
      display: grid;
      gap: 8px;
      margin-top: 2px;
      padding-top: 12px;
      border-top: 1px solid var(--line);
    }
    .impact-inspector h3 {
      margin: 0;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .impact-inspector > strong {
      color: var(--ink);
      overflow-wrap: anywhere;
      font-size: 13px;
    }
    .impact-inspector > span {
      color: var(--muted);
      overflow-wrap: anywhere;
      font-size: 12px;
    }
    .impact-inspector dl {
      display: grid;
      gap: 8px;
      margin: 0;
    }
    .impact-inspector dl div {
      display: grid;
      gap: 3px;
    }
    .impact-inspector dt {
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .impact-inspector dd {
      margin: 0;
      color: var(--ink);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .inspector-action, .inspector-evidence {
      display: grid;
      gap: 6px;
      padding-top: 10px;
      border-top: 1px solid var(--line);
    }
    .inspector-action h4, .inspector-evidence h4 {
      margin: 0;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    #inspectorAction {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    #inspectorAction code {
      max-width: 100%;
      border: 1px solid #d9ded5;
      border-radius: 6px;
      padding: 4px 6px;
      background: #f3f7f4;
      white-space: pre-wrap;
    }
    .inspector-evidence ul, #inspectorEvidenceList {
      list-style: none;
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
    }
    #inspectorEvidenceList li {
      display: grid;
      gap: 4px;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fffefa;
    }
    #inspectorEvidenceList strong {
      color: var(--ink);
      overflow-wrap: anywhere;
      font-size: 12px;
    }
    #inspectorEvidenceList span {
      color: var(--muted);
      font-size: 11px;
    }
    #inspectorEvidenceList pre {
      margin: 0;
      padding: 7px;
      font-size: 11px;
      line-height: 1.35;
    }
    .inspector-empty {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .bottom {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(280px, 0.8fr);
      gap: 14px;
      margin-top: 14px;
    }
    .wide-panel { margin-top: 14px; }
    .node-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; background: var(--blue); }
    .node-dot.changed { background: var(--green); }
    .node-dot.affected { background: var(--amber); }
    .finding { display: grid; gap: 4px; }
    .finding-error strong { color: var(--red); }
    .finding-warn strong { color: var(--amber); }
    .finding-info strong { color: var(--teal); }
    .empty { padding: 18px; color: var(--muted); }
    .hidden { display: none !important; }
    @media (max-width: 980px) {
      .topbar { grid-template-columns: 1fr; }
      .toolbar { justify-content: stretch; }
      .toolbar input, .toolbar select { width: 100%; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .impact-triage, .triage-flow { grid-template-columns: 1fr; }
      .triage-head { border-right: 0; border-bottom: 1px solid var(--line); }
      .triage-step::after { display: none !important; }
      .delta-content, .delta-paths { grid-template-columns: 1fr; }
      .delta-hero, .delta-metrics { border-right: 0; border-bottom: 1px solid var(--line); }
      .delta-lanes, .delta-presets { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .impact-overview, .workbench, .bottom, .map-content, .summary-columns { grid-template-columns: 1fr; }
      .summary-columns > div:first-child, .map-legend { border-right: 0; border-left: 0; }
      .map-content { height: auto; }
      .impact-svg { height: 380px; }
    }
    @media (max-width: 560px) {
      .shell { padding: 10px; }
      .metrics {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .metric {
        min-height: 58px;
        padding: 8px 10px;
      }
      .metric strong { font-size: 20px; }
      .impact-row, .workspace-link-row, .action-row { grid-template-columns: 1fr; }
      .action-controls { grid-column: auto; justify-content: flex-start; }
      .impact-path-meta { justify-content: flex-start; max-width: none; }
      .confidence-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .delta-metrics, .delta-lanes, .delta-presets { grid-template-columns: 1fr; }
      .panel-heading { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="title">
      <span class="eyebrow">Parallax local impact intelligence</span>
      <h1>Impact Workbench</h1>
      <p>${escapeHtml(snapshot.repoRoot)} · schema ${escapeHtml(String(doctor.database.schemaVersion ?? 'missing'))} · generated ${escapeHtml(snapshot.generatedAt)}</p>
    </div>
    <div class="toolbar" aria-label="Workbench controls">
      <select id="reportSelect" aria-label="Report selector">${reportOptions || '<option value="">No reports</option>'}</select>
      <input id="filterInput" type="search" placeholder="Filter paths, evidence, actions" aria-label="Filter workbench rows">
    </div>
  </header>
  <main class="shell">
    <section class="metrics" aria-label="Repository and report metrics">
      <div class="metric"><span>Index status</span><strong>${escapeHtml(doctor.index.latestCompletedRun?.status ?? 'missing')}</strong></div>
      <div class="metric"><span>Changed</span><strong>${escapeHtml(String(report?.changedCount ?? 0))}</strong></div>
      <div class="metric"><span>Affected</span><strong>${escapeHtml(String(report?.affectedCount ?? 0))}</strong></div>
      <div class="metric"><span>Evidence</span><strong>${escapeHtml(String(report?.evidenceCount ?? 0))}</strong></div>
      <div class="metric"><span>Actions</span><strong>${escapeHtml(String(report?.actionCount ?? 0))}</strong></div>
      <div class="metric"><span>Coverage gaps</span><strong>${escapeHtml(String(doctor.index.coverage?.skippedPaths ?? 0))}</strong></div>
      <div class="metric"><span>Work artifacts</span><strong>${escapeHtml(String(snapshot.workArtifacts.length))}</strong></div>
      <div class="metric"><span>Workspaces</span><strong>${escapeHtml(String(snapshot.workspaces.length))}</strong></div>
    </section>
    ${impactTriageStrip}
    <section class="impact-overview" aria-label="Impact overview">
      ${impactMapPanel}
      ${impactSummaryPanel}
    </section>
    ${reportDeltaPanel}
    <section class="workbench" aria-label="Impact report workbench">
      <div class="stacked-pane">
        <section class="panel">
          <h2>Change Set</h2>
          <ul class="list filterable">${changedRows || `<li class="empty">Run ${PACKAGE_NAME} analyze to create a report.</li>`}</ul>
        </section>
        <section class="panel">
          <h2>Verification Queue</h2>
          <ul class="list filterable">${actionRows || '<li class="empty">No recommended actions in this report.</li>'}</ul>
        </section>
      </div>
      <div class="stacked-pane">
        <section class="panel">
          <h2>Impact Paths</h2>
          <ul class="list filterable">${affectedRows || '<li class="empty">No affected paths in the selected report.</li>'}</ul>
        </section>
      </div>
      <section class="panel evidence-panel">
        <h2>Evidence</h2>
        <ul class="list filterable">${evidenceRows || '<li class="empty">No evidence in the selected report.</li>'}</ul>
      </section>
    </section>
    <section class="panel wide-panel">
      <h2>Work Artifacts</h2>
      <ul class="list filterable">${workArtifactRows || '<li class="empty">No policy, decision, PRD, requirement, or proposal impact in the selected report.</li>'}</ul>
    </section>
    <section class="bottom">
      <section class="panel">
        <h2>Doctor Findings</h2>
        <ul class="list">${errors}${findings || (!errors ? '<li class="empty">No doctor findings.</li>' : '')}</ul>
      </section>
      <section class="panel">
        <h2>Context Packs</h2>
        <ul class="list">${contextPackRows || '<li class="empty">No reusable context packs yet.</li>'}</ul>
      </section>
    </section>
    <section class="panel wide-panel">
      <h2>Adapter Confidence</h2>
      <ul class="list filterable">${adapterInsightRows || '<li class="empty">No adapter confidence metadata in the selected report.</li>'}</ul>
    </section>
    <section class="bottom">
      <section class="panel">
        <h2>Workspace Contracts</h2>
        <ul class="list filterable">${workspaceRows || '<li class="empty">No workspace contract links available.</li>'}</ul>
      </section>
      <section class="panel">
        <h2>Workspace Resources</h2>
        <ul class="list">
          ${snapshot.workspaces.map((workspace) => `
            <li class="pack-row">
              <strong>${escapeHtml(workspace.name)}</strong>
              <span>${escapeHtml(workspace.resources.workspace)} · ${escapeHtml(workspace.resources.contracts)} · ${escapeHtml(workspace.resources.crossRepoLinks)}</span>
            </li>
          `).join('') || '<li class="empty">No workspace resources available.</li>'}
        </ul>
      </section>
    </section>
    <section class="bottom">
      <section class="panel">
        <h2>Coverage Gaps</h2>
        <ul class="list">${coverageRows || '<li class="empty">No coverage rows available.</li>'}</ul>
      </section>
      <section class="panel">
        <h2>Resource Contract</h2>
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
  <script>
    const snapshot = JSON.parse(document.getElementById('impact-data')?.textContent || '{}');
    const affectedFiles = snapshot.selectedReport?.affectedFiles || [];
    const evidenceItems = snapshot.selectedReport?.evidence || [];
    const actionItems = snapshot.selectedReport?.actions || [];
    const input = document.getElementById('filterInput');
    function evidenceMatchesPath(evidence, path) {
      return evidence.file === path || evidence.subject?.path === path || (evidence.snippet || '').includes(path);
    }
    function evidenceForPath(path) {
      return evidenceItems.filter((item) => evidenceMatchesPath(item, path));
    }
    function evidenceHitCount(path) {
      return evidenceForPath(path).length;
    }
    function setText(id, value) {
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    }
    function sourceHrefFor(file, line) {
      return '/source?path=' + encodeURIComponent(file) + '&line=' + line;
    }
    function evidenceSourceLabel(evidence) {
      const line = Number.isInteger(evidence.startLine) && evidence.startLine > 0 ? evidence.startLine : 1;
      const endLine = Number.isInteger(evidence.endLine) && evidence.endLine > line ? evidence.endLine : undefined;
      return endLine ? 'L' + line + '-L' + endLine : 'L' + line;
    }
    function actionCommandText(action) {
      if (!action?.command) return '';
      return [action.command, ...(action.args || [])].map(shellQuoteForUi).join(' ');
    }
    function shellQuoteForUi(value) {
      const displayValue = String(value)
        .replace(/\\n/g, '\\\\n')
        .replace(/\\r/g, '\\\\r')
        .replace(/\\t/g, '\\\\t');
      if (displayValue === '--') return displayValue;
      if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(displayValue) && !displayValue.startsWith('-')) return displayValue;
      return "'" + displayValue.replaceAll("'", "'\\\\''") + "'";
    }
    function renderInspectorAction(path) {
      const target = document.getElementById('inspectorAction');
      if (!target) return;
      target.replaceChildren();
      const action = actionItems.find((candidate) => candidate.target?.path === path);
      const command = actionCommandText(action);
      if (!action || !command) {
        const empty = document.createElement('span');
        empty.className = 'inspector-empty';
        empty.textContent = 'No verification action recorded.';
        target.append(empty);
        return;
      }
      const code = document.createElement('code');
      code.textContent = command;
      const button = document.createElement('button');
      button.className = 'copy-command';
      button.type = 'button';
      button.dataset.command = command;
      button.setAttribute('aria-label', 'Copy inspector verification command');
      button.textContent = 'Copy';
      target.append(code, button);
      wireCopyButton(button);
    }
    function renderInspectorEvidence(evidence) {
      const target = document.getElementById('inspectorEvidenceList');
      if (!target) return;
      target.replaceChildren();
      if (evidence.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'inspector-empty';
        empty.textContent = 'No matching evidence recorded.';
        target.append(empty);
        return;
      }
      for (const item of evidence.slice(0, 3)) {
        const row = document.createElement('li');
        const file = document.createElement('strong');
        file.textContent = item.file;
        const meta = document.createElement('span');
        meta.textContent = item.kind + ' · ' + item.confidence;
        const line = Number.isInteger(item.startLine) && item.startLine > 0 ? item.startLine : 1;
        const link = document.createElement('a');
        link.className = 'source-link';
        link.href = sourceHrefFor(item.file, line);
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = evidenceSourceLabel(item);
        const snippet = document.createElement('pre');
        snippet.textContent = String(item.snippet || '').length > 120
          ? String(item.snippet || '').slice(0, 117) + '...'
          : String(item.snippet || '');
        row.append(file, meta, link, snippet);
        target.append(row);
      }
    }
    function confidenceRank(confidence) {
      if (confidence === 'proven') return 0;
      if (confidence === 'inferred') return 1;
      if (confidence === 'heuristic') return 2;
      return 3;
    }
    function compareImpactForUi(left, right) {
      return confidenceRank(left.confidence) - confidenceRank(right.confidence)
        || (left.depth ?? 99) - (right.depth ?? 99)
        || String(left.path).localeCompare(String(right.path));
    }
    function initialImpactPath() {
      const actionTargets = new Set(actionItems.map((action) => action.target?.path).filter(Boolean));
      const actionable = affectedFiles.filter((item) => actionTargets.has(item.path)).sort(compareImpactForUi);
      if (actionable[0]) return actionable[0].path;
      return [...affectedFiles].sort(compareImpactForUi)[0]?.path;
    }
    function selectImpact(path, options = {}) {
      const item = affectedFiles.find((candidate) => candidate.path === path);
      if (!item) return;
      const matchingEvidence = evidenceForPath(path);
      document.body.dataset.selectedImpactPath = path;
      setText('inspectorPath', item.path);
      setText('inspectorReason', item.reason);
      setText('inspectorConfidence', item.confidence);
      setText('inspectorRelation', item.relationPath?.join(' -> ') || 'direct or not recorded');
      setText('inspectorEvidence', String(matchingEvidence.length));
      renderInspectorAction(path);
      renderInspectorEvidence(matchingEvidence);
      const firstEvidence = Array.from(document.querySelectorAll('.evidence-row'))
        .find((row) => row.getAttribute('data-impact-path') === path);
      const sourceHref = firstEvidence?.getAttribute('data-source-href') || '';
      const sourceLabel = firstEvidence?.getAttribute('data-source-label') || '';
      const sourceTarget = document.getElementById('inspectorSource');
      if (sourceTarget) {
        sourceTarget.replaceChildren();
        if (sourceHref) {
          const link = document.createElement('a');
          link.className = 'source-link';
          link.href = sourceHref;
          link.target = '_blank';
          link.rel = 'noreferrer';
          link.textContent = 'Open source ' + sourceLabel;
          sourceTarget.append(link);
        } else {
          sourceTarget.textContent = 'No source span recorded';
        }
      }
      for (const row of document.querySelectorAll('[data-impact-path]')) {
        const rowPath = row.getAttribute('data-impact-path');
        const isSelected = rowPath === path;
        const isRelatedEvidence = row.classList.contains('evidence-row') && rowPath === path;
        row.classList.toggle('selected-impact', isSelected && !row.classList.contains('evidence-row'));
        row.classList.toggle('related-evidence', isRelatedEvidence);
      }
      if (options.scroll) {
        document.querySelector('.evidence-row.related-evidence, .impact-row.selected-impact')?.scrollIntoView({
          block: 'nearest',
          behavior: 'smooth'
        });
      }
    }
    for (const element of document.querySelectorAll('.selectable-impact[data-impact-path]')) {
      element.addEventListener('click', () => selectImpact(element.getAttribute('data-impact-path'), { scroll: true }));
      element.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        selectImpact(element.getAttribute('data-impact-path'), { scroll: true });
      });
    }
    for (const element of document.querySelectorAll('.selectable-impact a, .selectable-impact button')) {
      element.addEventListener('click', (event) => event.stopPropagation());
    }
    input?.addEventListener('input', () => {
      const query = input.value.trim().toLowerCase();
      for (const row of document.querySelectorAll('.filterable > li')) {
        const text = (row.getAttribute('data-filter-text') || row.textContent || '').toLowerCase();
        row.classList.toggle('hidden', query.length > 0 && !text.includes(query));
      }
    });
    document.getElementById('reportSelect')?.addEventListener('change', (event) => {
      const value = event.target.value;
      if (value) window.location.href = '/?report=' + encodeURIComponent(value);
    });
    async function copyText(value) {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
      }
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.append(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } finally {
        textarea.remove();
      }
    }
    function wireCopyButton(button) {
      if (!button || button.dataset.copyWired === 'true') return;
      button.dataset.copyWired = 'true';
      button.addEventListener('click', async () => {
        const command = button.getAttribute('data-command') || '';
        const original = button.textContent || 'Copy';
        button.disabled = true;
        try {
          await copyText(command);
          button.textContent = 'Copied';
          button.dataset.state = 'copied';
        } catch {
          button.textContent = 'Copy failed';
          button.dataset.state = 'failed';
        }
        window.setTimeout(() => {
          button.textContent = original;
          delete button.dataset.state;
          button.disabled = false;
        }, 1200);
      });
    }
    for (const button of document.querySelectorAll('.copy-command[data-command]')) {
      wireCopyButton(button);
    }
    const firstImpactPath = initialImpactPath();
    if (firstImpactPath) selectImpact(firstImpactPath);
  </script>
</body>
</html>`;
}

async function renderSourceViewerHtml(repoRootInput: string, url: URL): Promise<string> {
  const repoRoot = normalizeRepoRoot(repoRootInput);
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
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(requestedPath)}:${targetLine}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f2f4f1;
      --surface: #fffefa;
      --ink: #172019;
      --muted: #667067;
      --line: #d8d4c8;
      --green: #18735f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    header {
      display: grid;
      gap: 5px;
      padding: 16px 18px;
      border-bottom: 3px solid var(--green);
      background: #20251f;
      color: #f8f4e8;
    }
    header a {
      width: fit-content;
      color: #9ed3c4;
      font-size: 13px;
      font-weight: 800;
      text-decoration: none;
    }
    h1 {
      margin: 0;
      overflow-wrap: anywhere;
      font-size: 19px;
      line-height: 1.25;
    }
    header span {
      color: #bcc8bd;
      font-size: 13px;
    }
    main {
      width: min(1180px, 100%);
      margin: 0 auto;
      padding: 18px;
    }
    .source-card {
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: 0 18px 45px rgba(23, 32, 25, 0.08);
    }
    .source-card > div {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
    }
    ol {
      margin: 0;
      padding: 12px 0 12px 58px;
      background: #f9fbf7;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.55;
    }
    li {
      padding: 0 14px 0 8px;
      color: #8b948b;
    }
    li code {
      color: #18211b;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .source-line-active {
      background: #e0f4ea;
      box-shadow: inset 4px 0 0 #18735f;
    }
  </style>
</head>
<body>
  <header>
    <a href="/">Back to Impact Workbench</a>
    <h1>${escapeHtml(requestedPath)}</h1>
    <span>Line ${targetLine} · ${escapeHtml(repoRoot)}</span>
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
        response.end(renderUiHtml(snapshot));
        return;
      }
      response.writeHead(404, textHeaders());
      response.end('not found');
    } catch (error) {
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
    const limit = parseGraphPageLimit(url.searchParams.get('limit'));
    const cursorRaw = url.searchParams.get('cursor');
    const cursor = parseGraphPageCursor(cursorRaw);
    validateGraphPageCursor(cursor, graph);
    const nodes = graph.nodes.slice(cursor.nodeOffset, cursor.nodeOffset + limit);
    const edges = graph.edges.slice(cursor.edgeOffset, cursor.edgeOffset + limit);
    const nextNodeOffset = cursor.nodeOffset + nodes.length;
    const nextEdgeOffset = cursor.edgeOffset + edges.length;
    const nextCursor =
      nextNodeOffset < graph.nodes.length || nextEdgeOffset < graph.edges.length
        ? `${nextNodeOffset}:${nextEdgeOffset}`
        : null;
    return {
      reportId: graph.reportId,
      indexRunId: graph.indexRunId,
      format: graph.format,
      nodes,
      edges,
      page: {
        cursor: cursorRaw,
        nextCursor,
        limit,
        totalNodes: graph.nodes.length,
        totalEdges: graph.edges.length,
        returnedNodes: nodes.length,
        returnedEdges: edges.length
      }
    };
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

function reportSummaryFromRow(row: ReportRow): UiReportSummary {
  const report = JSON.parse(row.json) as ImpactReport;
  return {
    id: row.id,
    indexRunId: row.index_run_id,
    createdAt: row.created_at,
    changedFiles: report.changedFiles,
    changedCount: report.changed.length,
    affectedCount: report.affectedFiles.length,
    evidenceCount: report.evidence.length,
    actionCount: report.actions.length
  };
}

function reportPreviewFromRow(row: ReportRow): UiReportPreview {
  const report = JSON.parse(row.json) as ImpactReport;
  return {
    ...reportSummaryFromRow(row),
    changed: report.changed,
    affectedFiles: report.affectedFiles,
    evidence: evidencePreviewFromReport(report),
    adapterInsights: report.adapterInsights ?? [],
    actions: report.actions,
    warnings: report.warnings ?? []
  };
}

const workArtifactKinds = new Set(['policy', 'proposal', 'prd', 'decision', 'business_plan', 'requirement', 'meeting_note', 'customer_artifact']);
const omittedWorkArtifactEvidenceSnippet = 'Work artifact evidence omitted from UI bootstrap. Open the entity resource for document details.';

function evidencePreviewFromReport(report: ImpactReport): UiEvidencePreview[] {
  const workArtifactPaths = workArtifactPathSet(report);
  return report.evidence.map((item) => {
    const resourceUri = workArtifactEvidenceResourceUri(item, workArtifactPaths);
    if (!resourceUri) return item;
    return {
      ...item,
      snippet: omittedWorkArtifactEvidenceSnippet,
      snippetOmitted: true,
      omittedReason: 'work-artifact-resource-on-demand',
      resourceUri
    };
  });
}

function workArtifactsFromReportRow(row: ReportRow): UiWorkArtifactImpact[] {
  const report = JSON.parse(row.json) as ImpactReport;
  const affectedByPath = new Map(report.affectedFiles.map((item) => [item.path, item]));
  const metadataByPath = workArtifactMetadataByPath(report);
  const byKey = new Map<string, UiWorkArtifactImpact>();
  for (const item of report.affected) {
    const targetPath = item.target.path;
    if (!targetPath || !workArtifactKinds.has(item.target.kind)) continue;
    const affectedFile = affectedByPath.get(targetPath);
    const metadata = metadataByPath.get(targetPath);
    const key = `${item.target.kind}:${targetPath}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      kind: item.target.kind,
      path: targetPath,
      displayName: metadata?.title ?? item.target.displayName ?? targetPath,
      reason: affectedFile?.reason ?? item.relations.join(' -> '),
      confidence: affectedFile?.confidence ?? item.confidence,
      relations: item.relations,
      resourceUri: entityResourceUri(item.target),
      ...(affectedFile?.depth !== undefined ? { depth: affectedFile.depth } : {}),
      ...(metadata && hasArtifactMetadata(metadata) ? { metadata } : {}),
      freshness: workArtifactFreshness(item.target.kind, metadata, row.created_at)
    });
  }
  return [...byKey.values()].sort(compareWorkArtifacts);
}

function workArtifactPathSet(report: ImpactReport): Set<string> {
  return new Set(
    report.affected
      .map((item) => item.target)
      .filter((target) => target.path && workArtifactKinds.has(target.kind))
      .map((target) => target.path!)
  );
}

function workArtifactEvidenceResourceUri(
  evidence: ImpactReport['evidence'][number],
  workArtifactPaths: ReadonlySet<string>
): string | undefined {
  if (evidence.subject && workArtifactKinds.has(evidence.subject.kind)) {
    return entityResourceUri(evidence.subject);
  }
  if (evidence.subject?.path && workArtifactPaths.has(evidence.subject.path)) {
    return entityResourceUri(evidence.subject);
  }
  if (workArtifactPaths.has(evidence.file)) {
    return `parallax://entities/${encodeURIComponent(`file:${evidence.file}`)}`;
  }
  return undefined;
}

function workArtifactMetadataByPath(report: ImpactReport): Map<string, MarkdownArtifactMetadata> {
  const workArtifactPaths = workArtifactPathSet(report);
  const out = new Map<string, MarkdownArtifactMetadata>();
  for (const evidence of report.evidence) {
    const path = workArtifactEvidencePath(evidence, workArtifactPaths);
    if (!path || out.has(path)) continue;
    const metadata = markdownArtifactMetadataFromContent(evidence.snippet);
    if (hasArtifactMetadata(metadata)) out.set(path, metadata);
  }
  return out;
}

function workArtifactEvidencePath(
  evidence: ImpactReport['evidence'][number],
  workArtifactPaths: ReadonlySet<string>
): string | undefined {
  if (evidence.subject?.path && workArtifactPaths.has(evidence.subject.path)) {
    return evidence.subject.path;
  }
  if (workArtifactPaths.has(evidence.file)) return evidence.file;
  return undefined;
}

function hasArtifactMetadata(metadata: MarkdownArtifactMetadata): boolean {
  return Boolean(metadata.title || metadata.owner || metadata.status || metadata.updatedAt);
}

function workArtifactMetadataText(metadata: MarkdownArtifactMetadata | undefined): string {
  if (!metadata) return '';
  return [
    metadata.owner ? `owner ${metadata.owner}` : undefined,
    metadata.status ? `status ${metadata.status}` : undefined,
    metadata.updatedAt ? `updated ${metadata.updatedAt}` : undefined
  ].filter((item): item is string => Boolean(item)).join(' · ');
}

function workArtifactFreshness(
  kind: string,
  metadata: MarkdownArtifactMetadata | undefined,
  asOfIso: string
): UiWorkArtifactFreshness {
  const thresholdDays = workArtifactFreshnessThresholdDays(kind);
  const updatedAt = parseDateOnly(metadata?.updatedAt);
  const asOf = parseDateOnly(asOfIso);
  if (!updatedAt || !asOf) {
    return {
      state: 'unknown',
      label: 'review date unknown',
      thresholdDays
    };
  }
  const ageDays = Math.max(0, Math.floor((asOf.getTime() - updatedAt.getTime()) / 86_400_000));
  if (ageDays > thresholdDays) {
    return {
      state: 'stale',
      label: `stale ${ageDays}d`,
      thresholdDays,
      ageDays
    };
  }
  return {
    state: 'current',
    label: `current ${ageDays}d`,
    thresholdDays,
    ageDays
  };
}

function workArtifactFreshnessThresholdDays(kind: string): number {
  if (kind === 'proposal') return 60;
  if (kind === 'prd' || kind === 'requirement') return 120;
  if (kind === 'decision') return 180;
  return 90;
}

function parseDateOnly(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date;
}

function compareWorkArtifacts(left: UiWorkArtifactImpact, right: UiWorkArtifactImpact): number {
  return workArtifactFreshnessRank(left.freshness.state) - workArtifactFreshnessRank(right.freshness.state)
    || workArtifactKindRank(left.kind) - workArtifactKindRank(right.kind)
    || (left.depth ?? 99) - (right.depth ?? 99)
    || left.path.localeCompare(right.path);
}

function workArtifactFreshnessRank(state: UiWorkArtifactFreshness['state']): number {
  if (state === 'stale') return 0;
  if (state === 'unknown') return 1;
  return 2;
}

function workArtifactKindRank(kind: string): number {
  if (kind === 'policy') return 0;
  if (kind === 'decision') return 1;
  if (kind === 'prd' || kind === 'requirement') return 2;
  if (kind === 'proposal') return 3;
  return 4;
}

async function graphPreview(repoRoot: string, reportId: string): Promise<UiGraphPreview | null> {
  try {
    const graph = await exportImpactGraph({ repoRoot, reportId, format: 'json' });
    return {
      nodes: graph.nodes.slice(0, 80),
      edges: graph.edges.slice(0, 80),
      totalNodes: graph.nodes.length,
      totalEdges: graph.edges.length
    };
  } catch {
    return null;
  }
}

function readContextPacks(db: ReturnType<typeof openDatabase>, repoId: number): UiContextPackSummary[] {
  if (!tableExists(db, 'context_packs')) return [];
  const rows = db
    .prepare(`
      SELECT id, budget, index_run_id, returned_bytes, hit_count, created_at, last_accessed_at
      FROM context_packs
      WHERE repo_id = ?
      ORDER BY last_accessed_at DESC, created_at DESC
      LIMIT 20
    `)
    .all(repoId) as ContextPackRow[];
  return rows.map((row) => ({
    id: row.id,
    budget: row.budget,
    indexRunId: row.index_run_id,
    returnedBytes: row.returned_bytes,
    hitCount: row.hit_count,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at
  }));
}

function readReport(repoRoot: string, reportId: string): unknown {
  const db = openDatabase(repoRoot, { readOnly: true });
  try {
    const repoId = getRepoId(db, repoRoot);
    const row = db
      .prepare('SELECT json FROM reports WHERE repo_id = ? AND id = ?')
      .get(repoId, reportId) as { json: string } | undefined;
    if (!row) return { error: { code: 'report_not_found', message: `Impact report not found: ${reportId}` } };
    return JSON.parse(row.json) as unknown;
  } finally {
    db.close();
  }
}

function readContextPack(repoRoot: string, contextPackId: string): unknown {
  const db = openDatabase(repoRoot, { readOnly: true });
  try {
    const repoId = getRepoId(db, repoRoot);
    const row = tableExists(db, 'context_packs')
      ? db
          .prepare('SELECT pack_json FROM context_packs WHERE repo_id = ? AND id = ?')
          .get(repoId, contextPackId) as { pack_json: string } | undefined
      : undefined;
    if (!row) return { error: { code: 'context_pack_not_found', message: `Context pack not found: ${contextPackId}` } };
    return JSON.parse(row.pack_json) as unknown;
  } finally {
    db.close();
  }
}

function readLatestCoverage(db: ReturnType<typeof openDatabase>, repoId: number): UiCoverageSnapshot | null {
  const run = db
    .prepare("SELECT id FROM index_runs WHERE repo_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1")
    .get(repoId) as { id: number } | undefined;
  if (!run || !tableExists(db, 'index_coverage')) return null;
  const limit = 80;
  const rows = db
    .prepare(`
      SELECT path, language_id, status, reason, adapter_id
      FROM index_coverage
      WHERE index_run_id = ?
      ORDER BY status DESC, path
      LIMIT ?
    `)
    .all(run.id, limit + 1) as Array<{
      path: string;
      language_id: string | null;
      status: string;
      reason: string;
      adapter_id: string;
    }>;
  return {
    indexRunId: run.id,
    coverage: rows.slice(0, limit).map((row) => ({
      path: row.path,
      languageId: row.language_id,
      status: row.status,
      reason: row.reason,
      adapterId: row.adapter_id
    })),
    limit,
    truncated: rows.length > limit
  };
}

function readWorkspace(repoRoot: string, workspaceName: string): unknown {
  const db = openDatabase(repoRoot, { readOnly: true });
  try {
    const workspace = readWorkspaceSnapshots(db).find((item) => item.name === workspaceName);
    if (!workspace) {
      return { error: { code: 'workspace_not_found', message: `Workspace not found: ${workspaceName}` } };
    }
    return workspace;
  } finally {
    db.close();
  }
}

function readWorkspaceSnapshots(db: ReturnType<typeof openDatabase>): UiWorkspaceSnapshot[] {
  if (!tableExists(db, 'workspaces') || !tableExists(db, 'workspace_repos')) return [];
  const rows = db
    .prepare('SELECT id, name FROM workspaces ORDER BY name')
    .all() as WorkspaceRow[];
  return rows.map((workspace) => {
    const warnings: string[] = [];
    const repos = readWorkspaceReposForUi(db, workspace.id);
    const contractResult = readWorkspaceContractsForUi(workspace.name, repos, warnings);
    const linkResult = readWorkspaceLinksForUi(db, workspace.id);
    return {
      name: workspace.name,
      repoCount: repos.length,
      contracts: contractResult.contracts,
      links: linkResult.links,
      warnings,
      resources: workspaceResources(workspace.name),
      limits: {
        contracts: contractResult.limit,
        links: linkResult.limit,
        contractsTruncated: contractResult.truncated,
        linksTruncated: linkResult.truncated
      }
    };
  });
}

function readWorkspaceReposForUi(db: ReturnType<typeof openDatabase>, workspaceId: number): WorkspaceRepoRow[] {
  return db
    .prepare(`
      SELECT local_path, service_name
      FROM workspace_repos
      WHERE workspace_id = ?
      ORDER BY local_path
    `)
    .all(workspaceId) as WorkspaceRepoRow[];
}

function readWorkspaceContractsForUi(
  workspaceName: string,
  repos: WorkspaceRepoRow[],
  warnings: string[]
): { contracts: UiWorkspaceContract[]; limit: number; truncated: boolean } {
  const limit = 80;
  const contracts: UiWorkspaceContract[] = [];
  let truncated = false;
  for (const repo of repos) {
    if (contracts.length >= limit) {
      truncated = true;
      break;
    }
    let repoDb: ReturnType<typeof openDatabase> | undefined;
    try {
      repoDb = openDatabase(repo.local_path, { readOnly: true });
      const repoId = getRepoId(repoDb, repo.local_path);
      const indexRunId = latestCompletedIndexRun(repoDb, repoId);
      const remaining = limit - contracts.length;
      const rows = repoDb
        .prepare(`
          SELECT
            c.id,
            c.kind,
            c.service_name,
            c.path,
            v.schema_version,
            (
              SELECT count(*)
              FROM relations r
              INNER JOIN entities target
                 ON target.id = r.target_entity_id
                AND target.repo_id = r.repo_id
              WHERE r.repo_id = c.repo_id
                AND r.index_run_id = ?
                AND r.source_entity_id = c.id
                AND r.kind = 'DECLARES'
                AND target.kind = 'endpoint'
            ) AS endpoint_count
          FROM contracts c
          INNER JOIN contract_versions v
             ON v.contract_id = c.id
            AND v.index_run_id = ?
          WHERE c.repo_id = ?
          ORDER BY COALESCE(c.service_name, ''), c.path, c.id
          LIMIT ?
        `)
        .all(indexRunId, indexRunId, repoId, remaining + 1) as WorkspaceContractRow[];
      if (rows.length > remaining) truncated = true;
      contracts.push(...rows.slice(0, remaining).map((row) => ({
        id: row.id,
        serviceName: row.service_name ?? repo.service_name ?? repo.local_path,
        repoPath: repo.local_path,
        path: row.path ?? row.id,
        kind: row.kind,
        indexRunId,
        endpointCount: row.endpoint_count,
        ...(row.schema_version !== null ? { schemaVersion: row.schema_version } : {})
      })));
    } catch (error) {
      warnings.push(`workspace contract repo skipped: ${workspaceName}:${repo.local_path}: ${errorMessage(error)}`);
    } finally {
      repoDb?.close();
    }
  }
  return { contracts, limit, truncated };
}

function readWorkspaceLinksForUi(
  db: ReturnType<typeof openDatabase>,
  workspaceId: number
): { links: UiWorkspaceLink[]; limit: number; truncated: boolean } {
  const limit = 120;
  if (!tableExists(db, 'cross_repo_links')) return { links: [], limit, truncated: false };
  const rows = db
    .prepare(`
      SELECT
        link.id,
        link.kind,
        link.confidence,
        link.provenance,
        source_member.local_path AS source_path,
        source_member.service_name AS source_service,
        target_member.local_path AS target_path,
        target_member.service_name AS target_service
      FROM cross_repo_links link
      INNER JOIN workspace_repos source_member
         ON source_member.workspace_id = link.workspace_id
        AND source_member.repo_id = link.source_repo_id
      INNER JOIN workspace_repos target_member
         ON target_member.workspace_id = link.workspace_id
        AND target_member.repo_id = link.target_repo_id
      WHERE link.workspace_id = ?
      ORDER BY link.kind, source_member.service_name, target_member.service_name, link.id
      LIMIT ?
    `)
    .all(workspaceId, limit + 1) as WorkspaceLinkRow[];
  return {
    links: rows.slice(0, limit).map((row) => {
      const provenance = parsedProvenance(row.provenance);
      const routeLabel = routeLabelFromProvenance(provenance);
      const consumerPath =
        stringAt(objectAt(provenance, 'consumer'), 'path')
        ?? stringAt(objectAt(provenance, 'evidence'), 'filePath');
      const providerContractPath = stringAt(objectAt(provenance, 'provider'), 'contractPath');
      const eventTopology = eventTopologyFromProvenance(provenance);
      return {
        id: row.id,
        kind: row.kind,
        confidence: row.confidence,
        sourceService: row.source_service ?? row.source_path,
        targetService: row.target_service ?? row.target_path,
        ...(routeLabel !== undefined ? { routeLabel } : {}),
        ...(consumerPath !== undefined ? { consumerPath } : {}),
        ...(providerContractPath !== undefined ? { providerContractPath } : {}),
        ...(eventTopology !== undefined ? { eventTopology } : {})
      };
    }),
    limit,
    truncated: rows.length > limit
  };
}

function workspaceResourceUri(workspaceName: string): string {
  return `parallax://workspaces/${encodeURIComponent(workspaceName)}`;
}

function entityResourceUri(entity: ImpactReport['changed'][number]): string {
  return `parallax://entities/${encodeURIComponent(entity.id)}`;
}

function workspaceResources(workspaceName: string): UiWorkspaceSnapshot['resources'] {
  const workspace = workspaceResourceUri(workspaceName);
  return {
    workspace,
    contracts: `${workspace}/contracts`,
    crossRepoLinks: `${workspace}/cross-repo-links`
  };
}

function parsedProvenance(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function routeLabelFromProvenance(provenance: unknown): string | undefined {
  const http = objectAt(provenance, 'http');
  const method = stringAt(http, 'method');
  const routePath = stringAt(http, 'path');
  if (method && routePath) return `${method} ${routePath}`;

  const change = objectAt(provenance, 'change');
  const changeMethod = stringAt(change, 'method');
  const changePath = stringAt(change, 'path');
  if (changeMethod && changePath) return `${changeMethod} ${changePath}`;
  return routePath ?? changePath;
}

function eventTopologyFromProvenance(provenance: unknown): UiWorkspaceLink['eventTopology'] | undefined {
  const topology = objectAt(provenance, 'eventTopology');
  const providerAction = stringAt(topology, 'providerAction');
  const counterpartyRole = stringAt(topology, 'counterpartyRole');
  const pattern = stringAt(topology, 'pattern');
  if (!providerAction || !pattern) return undefined;
  if (counterpartyRole !== 'consumer' && counterpartyRole !== 'producer' && counterpartyRole !== 'unknown') {
    return undefined;
  }
  return { providerAction, counterpartyRole, pattern };
}

function objectAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return typeof child === 'string' && child.length > 0 ? child : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

function tableExists(db: ReturnType<typeof openDatabase>, name: string): boolean {
  return db
    .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;
}

function parseGraphPageLimit(value: string | null): number {
  if (value === null) return 100;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('graph page limit must be an integer between 1 and 500');
  }
  return limit;
}

function parseGraphPageCursor(value: string | null): GraphPageCursor {
  if (value === null) return { nodeOffset: 0, edgeOffset: 0 };
  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) throw new Error('graph page cursor must be returned by a previous graph JSON page');
  return {
    nodeOffset: parseGraphCursorOffset(match[1]!, 'node'),
    edgeOffset: parseGraphCursorOffset(match[2]!, 'edge')
  };
}

function parseGraphCursorOffset(value: string, label: 'node' | 'edge'): number {
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`graph page cursor ${label} offset must be a safe non-negative integer`);
  }
  return offset;
}

function validateGraphPageCursor(cursor: GraphPageCursor, graph: GraphExport): void {
  if (cursor.nodeOffset > graph.nodes.length || cursor.edgeOffset > graph.edges.length) {
    throw new Error('graph page cursor is outside the current graph bounds');
  }
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

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
