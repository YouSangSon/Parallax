// Pure panel renderers for the top of the impact workbench: the impact summary
// panel, analysis-trust summary, impact-triage strip, and the row/lane helpers
// they share. Each takes a snapshot/report plus UiMessages and returns an HTML
// string. Functions here depend only on Node, the shared UI vocabulary
// (./shared.js), the impact-map builder (./impact_map.js), and ui.ts types
// (type-only import — erased at compile time, so no runtime import cycle).
// Moved verbatim from ui.ts.

import { PACKAGE_NAME } from '../branding.js';
import type { ImpactAction } from '../types.js';
import type {
  ImpactLane,
  UiEvidencePreview,
  UiMessages,
  UiReportPreview,
  UiSnapshot,
  UiWorkArtifactImpact
} from '../ui.js';
import { buildImpactMap } from './impact_map.js';
import {
  actionByTargetPath,
  actionCommandText,
  classifyImpactLane,
  compareAffectedFilesForUi,
  entityLabel,
  escapeHtml,
  impactEvidenceMatchesPath,
  shortenMiddle,
  sourceHref,
  topAffectedFilesForSummary
} from './shared.js';
export function renderImpactSummaryPanel(snapshot: UiSnapshot, m: UiMessages): string {
  const report = snapshot.selectedReport;
  if (!report) {
    return `
      <section class="panel impact-summary-panel">
        <h2>${escapeHtml(m.impactSummary)}</h2>
        <div class="empty">${escapeHtml(m.emptyRunAnalyzeBlast)}</div>
      </section>
    `;
  }

  const affectedFiles = topAffectedFilesForSummary(report).slice(0, 4);
  const primaryChange = report.changed[0] ? entityLabel(report.changed[0]) : report.changedFiles[0] ?? 'unknown change';
  const blast = blastRadiusLabel(report.affectedCount);
  const displayedPathCount = buildImpactMap(snapshot.graph, report).edges.length;
  const impactLanes = buildImpactLanes(report, snapshot.workArtifacts);
  const trustSummary = renderAnalysisTrustSummary(snapshot, report, m);
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
      <h2>${escapeHtml(m.impactSummary)}</h2>
      <div class="blast-card">
        <span>${escapeHtml(m.blastRadius)}</span>
        <strong>${escapeHtml(blast)}</strong>
        <small>${escapeHtml(primaryChange)} touches ${report.affectedCount} targets through ${displayedPathCount} displayed paths.</small>
      </div>
      ${trustSummary}
      <div class="confidence-strip" aria-label="${escapeHtml(m.ariaAffectedByConfidence)}">${confidenceRows}</div>
      <ul class="impact-lanes filterable" aria-label="${escapeHtml(m.ariaAffectedByLane)}">${laneRows}</ul>
      <div class="summary-columns">
        <div class="summary-section summary-section-top-impact">
          <h3>${escapeHtml(m.topImpact)}</h3>
          <ul class="summary-list filterable">${affectedPreview || `<li class="empty">${escapeHtml(m.emptyNoAffectedTargets)}</li>`}</ul>
        </div>
        <div class="summary-section summary-section-changed">
          <h3>${escapeHtml(m.changed)}</h3>
          <ul class="summary-list">${changedPreview || `<li class="empty">${escapeHtml(m.emptyNoChangedEntities)}</li>`}</ul>
        </div>
      </div>
    </section>
  `;
}

export function renderAnalysisTrustSummary(snapshot: UiSnapshot, report: UiReportPreview, m: UiMessages): string {
  const coverage = snapshot.doctor.index.coverage;
  const fallbackCoverageRows = snapshot.coverage?.coverage ?? [];
  const indexedPaths = coverage?.indexedPaths ?? fallbackCoverageRows.filter((item) => item.status === 'indexed').length;
  const skippedPaths = coverage?.skippedPaths ?? fallbackCoverageRows.filter((item) => item.status === 'skipped').length;
  const totalRows = coverage?.totalRows ?? indexedPaths + skippedPaths;
  const adapterInsights = report.adapterInsights ?? [];
  const adapterCount = adapterInsights.length || snapshot.doctor.index.adapterRuns.length;
  const knownGaps = uniqueSortedStrings(adapterInsights.flatMap((adapter) => adapter.knownGaps));
  const weakAdapterCount = adapterInsights.filter((adapter) => adapter.confidence === 'heuristic' || adapter.confidence === 'unknown').length;
  const failedAdapterCount = adapterInsights.filter((adapter) => adapter.status !== 'completed').length;
  const coverageTone = skippedPaths > 0 ? 'amber' : totalRows > 0 ? 'green' : 'blue';
  const adapterTone = failedAdapterCount > 0 ? 'red' : weakAdapterCount > 0 ? 'amber' : adapterCount > 0 ? 'green' : 'blue';
  const gapTone = knownGaps.length > 0 ? 'amber' : 'green';
  const stateTone = skippedPaths > 0 || failedAdapterCount > 0 ? 'red' : knownGaps.length > 0 || weakAdapterCount > 0 ? 'amber' : 'green';
  const stateLabel = stateTone === 'red' ? m.reviewGaps : stateTone === 'amber' ? m.useWithGaps : m.readyToUse;
  const gapPreview = knownGaps.slice(0, 2).map((gap) => `<li title="${escapeHtml(gap)}">${escapeHtml(shortenMiddle(gap, 88))}</li>`).join('');

  return `
    <section class="analysis-trust" aria-label="${escapeHtml(m.ariaTrustSignals)}">
      <div class="analysis-trust-heading">
        <h3>${escapeHtml(m.analysisTrust)}</h3>
        <span class="trust-state-${escapeHtml(stateTone)}">${escapeHtml(stateLabel)}</span>
      </div>
      <ul class="trust-signals">
        <li class="trust-signal trust-signal-${escapeHtml(coverageTone)}">
          <span>${escapeHtml(m.coverage)}</span>
          <strong>${escapeHtml(String(indexedPaths))}/${escapeHtml(String(totalRows))}</strong>
          <small>${escapeHtml(skippedPaths > 0 ? `${skippedPaths} skipped path${skippedPaths === 1 ? '' : 's'}` : m.noSkippedPaths)}</small>
        </li>
        <li class="trust-signal trust-signal-${escapeHtml(adapterTone)}">
          <span>${escapeHtml(m.adapters)}</span>
          <strong>${escapeHtml(String(adapterCount))}</strong>
          <small>${escapeHtml(failedAdapterCount > 0 ? `${failedAdapterCount} incomplete` : weakAdapterCount > 0 ? `${weakAdapterCount} heuristic/unknown` : m.confidenceMetadataPresent)}</small>
        </li>
        <li class="trust-signal trust-signal-${escapeHtml(gapTone)}">
          <span>${escapeHtml(m.knownGaps)}</span>
          <strong>${escapeHtml(String(knownGaps.length))}</strong>
          <small>${escapeHtml(knownGaps.length > 0 ? m.openLimitations : m.noneReported)}</small>
        </li>
      </ul>
      ${gapPreview ? `<ul class="trust-gap-preview" aria-label="${escapeHtml(m.ariaKnownGapPreview)}">${gapPreview}</ul>` : ''}
    </section>
  `;
}

export function renderImpactTriageStrip(snapshot: UiSnapshot, m: UiMessages): string {
  const report = snapshot.selectedReport;
  if (!report) {
    return `
      <section class="impact-triage impact-triage-empty" aria-label="${escapeHtml(m.ariaImpactTriage)}">
        <div class="triage-head">
          <h2>${escapeHtml(m.impactTriage)}</h2>
          <p>${escapeHtml(m.noSelectedReport)}</p>
        </div>
        <ol class="triage-flow">
          <li class="triage-step"><span>${escapeHtml(m.changedRoot)}</span><strong>${escapeHtml(m.none)}</strong><small>${escapeHtml(`Run ${PACKAGE_NAME} analyze.`)}</small></li>
          <li class="triage-step"><span>${escapeHtml(m.affectedTargets)}</span><strong>${escapeHtml(m.noTargets)}</strong><small>${escapeHtml(m.noDisplayedPaths)}</small></li>
          <li class="triage-step"><span>${escapeHtml(m.nextVerification)}</span><strong>${escapeHtml(m.none)}</strong><small>${escapeHtml(m.noVerificationActionShort)}</small></li>
        </ol>
      </section>
    `;
  }

  const map = buildImpactMap(snapshot.graph, report);
  const affectedFiles = [...report.affectedFiles].sort(compareAffectedFilesForUi);
  const primaryChange = report.changed[0] ? entityLabel(report.changed[0]) : report.changedFiles[0] ?? 'unknown change';
  const topTargetPath = affectedFiles[0]?.path;
  const topTarget = topTargetPath ?? m.noAffectedTargetInline;
  const actionsByPath = actionByTargetPath(report.actions);
  const actionableTarget = affectedFiles.find((item) => actionsByPath.has(item.path));
  const nextAction = (actionableTarget ? actionsByPath.get(actionableTarget.path) : undefined) ?? report.actions[0];
  const nextActionPath = nextAction?.target.path;
  const nextActionLabel = nextAction
    ? nextActionPath ?? nextAction.target.displayName ?? nextAction.target.symbol ?? nextAction.target.id
    : m.noVerificationTarget;
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
    <section class="impact-triage impact-triage-${escapeHtml(blast)}" aria-label="${escapeHtml(m.ariaImpactTriage)}">
      <div class="triage-head">
        <h2>${escapeHtml(m.impactTriage)}</h2>
        <strong>${escapeHtml(blast)}</strong>
        <p>${escapeHtml(riskDetail)}</p>
      </div>
      <ol class="triage-flow">
        <li class="triage-step triage-step-changed">
          <span>${escapeHtml(m.changedRoot)}</span>
          <strong title="${escapeHtml(primaryChange)}">${escapeHtml(shortenMiddle(primaryChange, 44))}</strong>
          <small>${escapeHtml(String(report.changedCount))} changed input</small>
        </li>
        <li class="triage-step triage-step-affected${topTargetPath ? ' selectable-impact' : ''}"${topTargetAttrs}>
          <span>${escapeHtml(m.affectedTargets)}</span>
          <strong>${escapeHtml(String(report.affectedCount))} targets</strong>
          <small title="${escapeHtml(topTarget)}">${escapeHtml(shortenMiddle(topTarget, 58))}</small>
        </li>
        <li class="triage-step triage-step-action${nextActionPath ? ' selectable-impact' : ''}"${nextActionAttrs}>
          <span>${escapeHtml(m.nextVerification)}</span>
          <strong title="${escapeHtml(nextActionLabel)}">${escapeHtml(shortenMiddle(nextActionLabel, 44))}</strong>
          <small title="${escapeHtml(nextCommand ?? '')}">${escapeHtml(nextCommand ? shortenMiddle(nextCommand, 64) : m.noVerificationActionShort)}</small>
        </li>
      </ol>
    </section>
  `;
}

export function buildImpactLanes(report: UiReportPreview, workArtifacts: readonly UiWorkArtifactImpact[]): ImpactLane[] {
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

export function uniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort((a, b) => a.localeCompare(b));
}

export function blastRadiusLabel(count: number): string {
  if (count === 0) return 'clear';
  if (count <= 3) return 'contained';
  if (count <= 12) return 'expanding';
  return 'wide';
}

export function actionKindLabel(kind: ImpactAction['kind'], m: UiMessages): string {
  return kind === 'verify' ? m.verify : m.review;
}

export function renderActionRow(item: ImpactAction, m: UiMessages): string {
  const command = actionCommandText(item);
  const targetPath = item.target.path && !item.target.path.includes('\0') ? item.target.path : undefined;
  const targetLabel = targetPath ?? item.target.displayName ?? item.target.symbol ?? item.target.id;
  const kindLabel = actionKindLabel(item.kind, m);
  const heading = item.kind === 'verify' && targetLabel ? `${m.verify} ${targetLabel}` : item.display;
  const meta = [
    item.runnerId ? `runner ${item.runnerId}` : undefined,
    targetLabel ? `target ${targetLabel}` : undefined,
    `${item.confidence} confidence`
  ].filter((value): value is string => Boolean(value)).join(' · ');
  const sourceLink = targetPath
    ? `<a class="source-link" href="${escapeHtml(sourceHref(targetPath, 1))}" target="_blank" rel="noreferrer">${escapeHtml(m.target)}</a>`
    : '';

  return `
    <li class="action-row" data-filter-text="${escapeHtml(`${item.kind} ${heading} ${item.display} ${command ?? ''} ${targetLabel} ${item.confidence}`)}">
      <span class="kind">${escapeHtml(kindLabel)}</span>
      <div class="action-main">
        <strong>${escapeHtml(heading)}</strong>
        <span>${escapeHtml(meta)}</span>
        ${command ? `<code>${escapeHtml(command)}</code>` : `<span>${escapeHtml(item.display)}</span>`}
      </div>
      <div class="action-controls">
        ${command ? `<button class="copy-command" type="button" data-command="${escapeHtml(command)}" aria-label="${escapeHtml(`${m.ariaCopyConfigPrefix} ${kindLabel} ${m.ariaCopyCommandSuffix}`)}">${escapeHtml(m.copy)}</button>` : ''}
        ${sourceLink}
      </div>
    </li>
  `;
}

export function renderImpactPathRow(
  item: UiReportPreview['affectedFiles'][number],
  evidenceCount: number,
  action: ImpactAction | undefined,
  m: UiMessages
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
        <div class="relation-trail" aria-label="${escapeHtml(m.ariaRelationTrail)}">${trail}</div>
      </div>
      <div class="impact-path-meta">
        <span class="badge confidence-${escapeHtml(item.confidence)}">${escapeHtml(item.confidence)}</span>
        <span class="evidence-pill">${escapeHtml(String(evidenceCount))} ${escapeHtml(m.evidence)}</span>
        <a class="source-link" href="${escapeHtml(sourceHref(item.path, 1))}" target="_blank" rel="noreferrer">${escapeHtml(m.source)}</a>
        ${actionCommand ? `<button class="copy-command" type="button" data-command="${escapeHtml(actionCommand)}" aria-label="${escapeHtml(`${m.ariaCopyVerifyForPrefix} ${item.path}`)}">${escapeHtml(m.copyVerify)}</button>` : ''}
      </div>
    </li>
  `;
}

export function impactTrailParts(item: UiReportPreview['affectedFiles'][number]): string[] {
  const parts = item.relationPath && item.relationPath.length > 0 ? item.relationPath : [item.reason];
  return parts.slice(0, 4);
}

export function evidenceCountByImpactPath(
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
