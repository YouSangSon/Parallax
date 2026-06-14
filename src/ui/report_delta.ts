// Report-delta-policy presentation cluster extracted from ui.ts. Renders the
// saved-report comparison panel and computes the review-load policy presets.
// Functions moved verbatim. Type-only imports from ui.ts are erased at compile
// time, so there is no runtime import cycle; runtime helpers come from shared.ts.

import { escapeHtml, sourceHref } from './shared.js';
import type {
  UiMessages,
  UiReportComparison,
  UiReportComparisonBucket,
  UiReportDeltaPolicy,
  UiReportDeltaPolicyPreset,
  UiReportPreview
} from '../ui.js';

type ReportDeltaSummary = 'wider' | 'narrower' | 'unchanged';

export function renderReportDeltaPanel(comparison: UiReportComparison | null, m: UiMessages): string {
  if (!comparison) return '';
  const headline = comparison.summary === 'wider'
    ? m.impactWidened
    : comparison.summary === 'narrower'
      ? m.impactNarrowed
      : m.impactUnchanged;
  const headlineDetail = comparison.policyReason;
  const metricRows = [
    { label: m.reviewLoad, value: String(comparison.reviewLoadCurrent), meta: formatSignedDelta(comparison.reviewLoadDelta), delta: comparison.reviewLoadDelta },
    { label: m.affectedPaths, value: formatSignedDelta(comparison.affectedDelta), meta: m.delta, delta: comparison.affectedDelta },
    { label: m.evidence, value: formatSignedDelta(comparison.evidenceDelta), meta: m.delta, delta: comparison.evidenceDelta },
    { label: m.actions, value: formatSignedDelta(comparison.actionDelta), meta: m.delta, delta: comparison.actionDelta }
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
  const addedRows = renderDeltaPathRows(comparison.addedAffectedPaths, 'added', m);
  const removedRows = renderDeltaPathRows(comparison.removedAffectedPaths, 'removed', m);
  const presetRows = comparison.policyPresets.map((preset) => `
    <li class="delta-preset delta-preset-${escapeHtml(preset.summary)}">
      <strong>${escapeHtml(preset.label)}</strong>
      <span>${escapeHtml(preset.summary)}</span>
      <b>${escapeHtml(formatSignedDelta(preset.reviewLoadDelta))}</b>
      <small>+${escapeHtml(String(preset.widenThreshold))}/-${escapeHtml(String(preset.narrowThreshold))} · ${escapeHtml(policyWeightsLabel(preset.weights))}</small>
      <button class="copy-command" type="button" ${copyCommandAttribute(reportDeltaPolicyConfigPatch(preset))} aria-label="${escapeHtml(`${m.ariaCopyConfigPrefix} ${preset.label}`)}">${escapeHtml(m.copyConfig)}</button>
    </li>
  `).join('');

  return `
    <section class="panel report-delta-panel" aria-label="${escapeHtml(m.ariaSavedReportComparison)}">
      <div class="panel-heading">
        <h2>${escapeHtml(m.reportDelta)}</h2>
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
          <span>${escapeHtml(m.savedReportComparison)}</span>
          <strong>${escapeHtml(headline)}</strong>
          <small>${escapeHtml(headlineDetail)}</small>
        </div>
        <ul class="delta-metrics" aria-label="${escapeHtml(m.ariaDeltaMetricsList)}">${metricRows}</ul>
        <div class="delta-detail">
          <div class="delta-confidence" aria-label="${escapeHtml(m.ariaConfidenceDelta)}">${confidenceRows || `<span><b>0</b>${escapeHtml(m.stableConfidence)}</span>`}</div>
          <ul class="delta-lanes">${laneRows}</ul>
          <div class="delta-policy" aria-label="${escapeHtml(m.ariaPolicyWeights)}">
            <span>${escapeHtml(m.affectedWeight)} ${escapeHtml(String(comparison.policy.weights.affected))}</span>
            <span>${escapeHtml(m.actionWeight)} ${escapeHtml(String(comparison.policy.weights.actions))}</span>
            <span>${escapeHtml(m.evidenceWeight)} ${escapeHtml(String(comparison.policy.weights.evidence))}</span>
          </div>
          <ul class="delta-presets" aria-label="${escapeHtml(m.ariaPresetComparison)}">${presetRows}</ul>
          <div class="delta-paths">
            <section>
              <h3>${escapeHtml(m.addedImpact)}</h3>
              <ul>${addedRows || `<li>${escapeHtml(m.none)}</li>`}</ul>
            </section>
            <section>
              <h3>${escapeHtml(m.removedImpact)}</h3>
              <ul>${removedRows || `<li>${escapeHtml(m.none)}</li>`}</ul>
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

function renderDeltaPathRows(paths: readonly string[], mode: 'added' | 'removed', m: UiMessages): string {
  return paths.slice(0, 4).map((pathValue) => {
    const sourceLink = `<a class="source-link" href="${escapeHtml(sourceHref(pathValue, 1))}" target="_blank" rel="noreferrer">${escapeHtml(m.source)}</a>`;
    if (mode === 'added') {
      return `
        <li class="delta-path-row selectable-impact" tabindex="0" role="button" data-impact-path="${escapeHtml(pathValue)}" data-filter-text="${escapeHtml(`added impact ${pathValue}`)}">
          <span>${escapeHtml(pathValue)}</span>
          <small>${escapeHtml(m.inspectImpact)}</small>
          ${sourceLink}
        </li>
      `;
    }
    return `
      <li class="delta-path-row" data-filter-text="${escapeHtml(`removed impact ${pathValue}`)}">
        <span>${escapeHtml(pathValue)}</span>
        <small>${escapeHtml(m.noLongerAffected)}</small>
        ${sourceLink}
      </li>
    `;
  }).join('');
}

export function formatSignedDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

export function defaultReportDeltaPolicy(): UiReportDeltaPolicy {
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

export function policyNumberAt(
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

export function reportDeltaPolicyPresets(
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

export function reportReviewLoad(report: UiReportPreview, policy: UiReportDeltaPolicy): number {
  return report.affectedCount * policy.weights.affected
    + report.actionCount * policy.weights.actions
    + report.evidenceCount * policy.weights.evidence;
}

export function reportDeltaSummary(delta: number, policy: UiReportDeltaPolicy): ReportDeltaSummary {
  if (delta >= policy.widenThreshold) return 'wider';
  if (delta <= -policy.narrowThreshold) return 'narrower';
  return 'unchanged';
}

export function reportDeltaPolicyReason(
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

export function comparisonBucket(label: string, current: number, previous: number): UiReportComparisonBucket {
  return { label, current, previous, delta: current - previous };
}
