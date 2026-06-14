import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { markdownArtifactMetadataFromContent } from './artifacts.js';
import type { MarkdownArtifactMetadata } from './artifacts.js';
import { resolveInsideRoot } from './security.js';
import type {
  Confidence,
  ContextBudget,
  ContextPack,
  ContextPackEvidence,
  ContextPackItem,
  ContextPackReusePolicy,
  ContextPackWorkArtifact,
  ContextPackWorkArtifactFreshness,
  EntityRef,
  Evidence,
  ImpactReport
} from './types.js';

type ContextBudgetPreset = {
  maxDepth: number;
  maxFanout: number;
  affectedLimit: number;
  workArtifactLimit: number;
  evidenceLimit: number;
  snippetChars: number;
};

const contextBudgetPresets: Record<ContextBudget, ContextBudgetPreset> = {
  brief: {
    maxDepth: 1,
    maxFanout: 50,
    affectedLimit: 5,
    workArtifactLimit: 5,
    evidenceLimit: 5,
    snippetChars: 300
  },
  standard: {
    maxDepth: 2,
    maxFanout: 200,
    affectedLimit: 15,
    workArtifactLimit: 12,
    evidenceLimit: 12,
    snippetChars: 800
  },
  deep: {
    maxDepth: 3,
    maxFanout: 500,
    affectedLimit: 50,
    workArtifactLimit: 30,
    evidenceLimit: 30,
    snippetChars: 1_500
  }
};

export function normalizeContextBudget(value: unknown): ContextBudget {
  return value === 'brief' || value === 'standard' || value === 'deep' ? value : 'standard';
}

export function normalizeContextPackReusePolicy(value: unknown): ContextPackReusePolicy {
  return value === 'full' || value === 'reference' || value === 'auto' ? value : 'auto';
}

export function contextBudgetPreset(budget: ContextBudget): ContextBudgetPreset {
  return contextBudgetPresets[budget];
}

export function buildContextPack(report: ImpactReport, budget: ContextBudget, asOfIso: string): ContextPack {
  const preset = contextBudgetPreset(budget);
  const affectedTargetsByPath = new Map(
    report.affected
      .filter((target) => target.target.path)
      .map((target) => [target.target.path!, target])
  );
  const rankedAffected = [...report.affectedFiles].sort(compareAffectedFiles);
  const selectedAffected = rankedAffected.slice(0, preset.affectedLimit);
  const selectedPaths = new Set([
    ...report.changedFiles,
    ...selectedAffected.map((file) => file.path)
  ]);
  const contextItems: ContextPackItem[] = selectedAffected.map((file) => {
    const affectedTarget = affectedTargetsByPath.get(file.path);
    const target = affectedTarget?.target ?? entityForContextPath(file.path);
    return {
      target,
      path: file.path,
      reason: file.reason,
      confidence: file.confidence,
      ...(file.depth !== undefined ? { depth: file.depth } : {}),
      relations: affectedTarget?.relations ?? file.relationPath ?? [file.reason],
      resourceUri: entityResourceUri(target)
    };
  });
  const workArtifactPaths = workArtifactPathSet(report);
  const allWorkArtifacts = workArtifactsForContextPack(report, asOfIso);
  const selectedWorkArtifacts = allWorkArtifacts.slice(0, preset.workArtifactLimit);
  const selectedEvidence = dedupeEvidenceForContext(report.evidence)
    .sort((a, b) => compareEvidence(a, b, selectedPaths))
    .slice(0, preset.evidenceLimit)
    .map((evidence) => compactEvidence(evidence, preset.snippetChars, workArtifactPaths));
  const selectedActionPaths = new Set(selectedAffected.map((file) => file.path));
  const actions = report.actions.filter((action) =>
    action.target.path ? selectedActionPaths.has(action.target.path) : false
  );
  const entityLinks = [
    ...report.changed.map(entityResourceUri),
    ...contextItems.map((item) => item.resourceUri),
    ...selectedWorkArtifacts.map((item) => item.resourceUri)
  ];
  const evidenceLinks = selectedEvidence.flatMap((item) => item.resourceUri ? [item.resourceUri] : []);
  return {
    version: 0,
    budget,
    indexRunId: report.indexRunId,
    summary: contextSummary(report, selectedAffected.length, selectedWorkArtifacts.length, selectedEvidence.length),
    changed: report.changed.map((entity) => ({
      entity,
      resourceUri: entityResourceUri(entity)
    })),
    context: contextItems,
    workArtifacts: selectedWorkArtifacts,
    ...(report.adapterInsights && report.adapterInsights.length > 0 ? { adapterInsights: report.adapterInsights } : {}),
    actions,
    evidence: selectedEvidence,
    resources: {
      coverage: 'parallax://coverage/latest',
      entities: [...new Set(entityLinks)].sort(),
      evidence: [...new Set(evidenceLinks)].sort()
    },
    omittedCounts: {
      affected: Math.max(report.affectedFiles.length - selectedAffected.length, 0),
      workArtifacts: Math.max(allWorkArtifacts.length - selectedWorkArtifacts.length, 0),
      evidence: Math.max(dedupeEvidenceForContext(report.evidence).length - selectedEvidence.length, 0),
      actions: Math.max(report.actions.length - actions.length, 0)
    },
    limits: {
      affectedLimit: preset.affectedLimit,
      workArtifactLimit: preset.workArtifactLimit,
      evidenceLimit: preset.evidenceLimit,
      snippetChars: preset.snippetChars,
      affectedTruncated: report.affectedFiles.length > preset.affectedLimit,
      evidenceTruncated: dedupeEvidenceForContext(report.evidence).length > preset.evidenceLimit
    },
    ...(report.warnings && report.warnings.length > 0 ? { warnings: report.warnings } : {})
  };
}

export type PersistedContextPack = ContextPack & {
  contextPackId: string;
  resourceUri: string;
  contentHash: string;
  reused: false;
  resources: ContextPack['resources'] & { contextPack: string };
};

type ContextPackReference = {
  version: 0;
  kind: 'context_pack_reference';
  contextPackId: string;
  resourceUri: string;
  contentHash: string;
  reused: true;
  budget: ContextBudget;
  indexRunId: number;
  summary: string[];
  changedFiles: string[];
  resources: {
    contextPack: string;
  };
  omittedCounts: {
    contextItems: number;
    workArtifacts: number;
    evidence: number;
    actions: number;
    fullContextPackBytes: number;
  };
};

export function changedFileContentHash(repoRoot: string, filePath: string): string {
  const absolutePath = resolveInsideRoot(repoRoot, filePath);
  if (!existsSync(absolutePath)) return 'missing';
  const hash = createHash('sha256');
  hash.update(readFileSync(absolutePath));
  return hash.digest('hex');
}

export function contextPackReference(
  pack: PersistedContextPack,
  changedFiles: string[],
  fullBytes: number
): ContextPackReference {
  return {
    version: 0,
    kind: 'context_pack_reference',
    contextPackId: pack.contextPackId,
    resourceUri: pack.resourceUri,
    contentHash: pack.contentHash,
    reused: true,
    budget: pack.budget,
    indexRunId: pack.indexRunId,
    summary: [
      `Reusing persisted context pack ${pack.contextPackId}.`,
      `Fetch ${pack.resourceUri} only if the full compact context is needed.`,
      `${pack.context.length} context item(s), ${pack.workArtifacts.length} work artifact(s), ${pack.evidence.length} evidence item(s), and ${pack.actions.length} action(s) are stored in the resource.`
    ],
    changedFiles,
    resources: {
      contextPack: pack.resourceUri
    },
    omittedCounts: {
      contextItems: pack.context.length,
      workArtifacts: pack.workArtifacts.length,
      evidence: pack.evidence.length,
      actions: pack.actions.length,
      fullContextPackBytes: fullBytes
    }
  };
}

function contextSummary(
  report: ImpactReport,
  selectedAffectedCount: number,
  selectedWorkArtifactCount: number,
  selectedEvidenceCount: number
): string[] {
  return [
    `${report.changedFiles.length} changed file(s) analyzed against index run ${report.indexRunId}.`,
    `${report.affectedFiles.length} affected file(s) found; ${selectedAffectedCount} included in this context pack.`,
    `${selectedWorkArtifactCount} work artifact(s) included without document bodies.`,
    `${selectedEvidenceCount} evidence item(s) included; fetch entity resources for more detail.`,
    `${report.adapterInsights?.length ?? 0} adapter confidence profile(s) available from the latest index.`,
    `${report.actions.length} recommended action(s) available from the full impact analysis.`
  ];
}

function compareAffectedFiles(
  left: ImpactReport['affectedFiles'][number],
  right: ImpactReport['affectedFiles'][number]
): number {
  return numericCompare(left.depth ?? 99, right.depth ?? 99)
    || numericCompare(confidenceRank(right.confidence), confidenceRank(left.confidence))
    || numericCompare(pathPriority(left.path), pathPriority(right.path))
    || left.path.localeCompare(right.path);
}

function dedupeEvidenceForContext(evidence: readonly Evidence[]): Evidence[] {
  const byKey = new Map<string, Evidence>();
  for (const item of evidence) {
    const key = item.id || `${item.file}:${item.kind}:${item.snippet}`;
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()];
}

const contextWorkArtifactKinds = new Set(['policy', 'proposal', 'prd', 'decision', 'business_plan', 'requirement', 'meeting_note', 'customer_artifact']);
const omittedWorkArtifactEvidenceSnippet = 'Work artifact evidence omitted from context pack. Fetch the entity or evidence resource for document details.';

function workArtifactsForContextPack(report: ImpactReport, asOfIso: string): ContextPackWorkArtifact[] {
  const affectedByPath = new Map(report.affectedFiles.map((item) => [item.path, item]));
  const metadataByPath = workArtifactMetadataByPath(report);
  const byKey = new Map<string, ContextPackWorkArtifact>();
  for (const item of report.affected) {
    const targetPath = item.target.path;
    if (!targetPath || !contextWorkArtifactKinds.has(item.target.kind)) continue;
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
      ...(metadata && hasArtifactMetadata(metadata) ? { metadata } : {}),
      freshness: workArtifactFreshness(item.target.kind, metadata, asOfIso)
    });
  }
  return [...byKey.values()].sort(compareContextWorkArtifacts);
}

function workArtifactPathSet(report: ImpactReport): Set<string> {
  return new Set(
    report.affected
      .map((item) => item.target)
      .filter((target) => target.path && contextWorkArtifactKinds.has(target.kind))
      .map((target) => target.path!)
  );
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
  evidence: Evidence,
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

function isWorkArtifactEvidence(evidence: Evidence, workArtifactPaths: ReadonlySet<string>): boolean {
  return Boolean(
    (evidence.subject && contextWorkArtifactKinds.has(evidence.subject.kind)) ||
    (evidence.subject?.path && workArtifactPaths.has(evidence.subject.path)) ||
    workArtifactPaths.has(evidence.file)
  );
}

function workArtifactFreshness(
  kind: string,
  metadata: MarkdownArtifactMetadata | undefined,
  asOfIso: string
): ContextPackWorkArtifactFreshness {
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

function compareContextWorkArtifacts(left: ContextPackWorkArtifact, right: ContextPackWorkArtifact): number {
  return workArtifactFreshnessRank(left.freshness.state) - workArtifactFreshnessRank(right.freshness.state)
    || workArtifactKindRank(left.kind) - workArtifactKindRank(right.kind)
    || left.path.localeCompare(right.path);
}

function workArtifactFreshnessRank(state: ContextPackWorkArtifactFreshness['state']): number {
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

function compareEvidence(
  left: Evidence,
  right: Evidence,
  selectedPaths: ReadonlySet<string>
): number {
  return numericCompare(evidencePathRank(left, selectedPaths), evidencePathRank(right, selectedPaths))
    || numericCompare(confidenceRank(right.confidence), confidenceRank(left.confidence))
    || numericCompare(hasSpan(right), hasSpan(left))
    || numericCompare(left.snippet.length, right.snippet.length)
    || left.file.localeCompare(right.file)
    || left.kind.localeCompare(right.kind);
}

function compactEvidence(
  evidence: Evidence,
  snippetChars: number,
  workArtifactPaths: ReadonlySet<string>
): ContextPackEvidence {
  const resourceUri = persistedEvidenceResourceUri(evidence);
  return {
    id: evidence.id,
    file: evidence.file,
    kind: evidence.kind,
    snippet: isWorkArtifactEvidence(evidence, workArtifactPaths)
      ? omittedWorkArtifactEvidenceSnippet
      : truncateSnippet(evidence.snippet, snippetChars),
    confidence: evidence.confidence,
    ...(resourceUri ? { resourceUri } : {}),
    ...(evidence.startLine !== undefined ? { startLine: evidence.startLine } : {}),
    ...(evidence.endLine !== undefined ? { endLine: evidence.endLine } : {}),
    ...(evidence.startCol !== undefined ? { startCol: evidence.startCol } : {}),
    ...(evidence.endCol !== undefined ? { endCol: evidence.endCol } : {}),
    ...(evidence.subject !== undefined ? { subject: evidence.subject } : {}),
    ...(evidence.relationKind !== undefined ? { relationKind: evidence.relationKind } : {})
  };
}

export function truncateSnippet(snippet: string, limit: number): string {
  if (snippet.length <= limit) return snippet;
  return `${snippet.slice(0, Math.max(limit - 3, 0))}...`;
}

function evidencePathRank(evidence: Evidence, selectedPaths: ReadonlySet<string>): number {
  if (selectedPaths.has(evidence.file)) return 0;
  if (evidence.subject?.path && selectedPaths.has(evidence.subject.path)) return 1;
  return 2;
}

function hasSpan(evidence: Evidence): number {
  return evidence.startLine !== undefined ? 1 : 0;
}

function confidenceRank(confidence: Confidence): number {
  if (confidence === 'proven') return 4;
  if (confidence === 'inferred') return 3;
  if (confidence === 'heuristic') return 2;
  return 1;
}

function pathPriority(filePath: string): number {
  if (/(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\./.test(filePath)) return 0;
  if (filePath.endsWith('.md') || filePath.startsWith('docs/')) return 1;
  if (filePath.startsWith('.github/workflows/') || /\.(ya?ml|json|toml)$/.test(filePath)) return 2;
  return 3;
}

function entityForContextPath(filePath: string): EntityRef {
  return {
    id: `file:${filePath}`,
    kind: 'file',
    path: filePath,
    displayName: filePath
  };
}

export function entityResourceUri(entity: EntityRef): string {
  return `parallax://entities/${encodeURIComponent(entity.id)}`;
}

export function evidenceResourceUri(evidenceId: string): string {
  return `parallax://evidence/${encodeURIComponent(evidenceId)}`;
}

export function contextPackResourceUri(contextPackId: string): string {
  return `parallax://context-packs/${encodeURIComponent(contextPackId)}`;
}

function persistedEvidenceResourceUri(evidence: Evidence): string | undefined {
  // Relation evidence IDs are produced by indexer relationEvidenceId().
  // Synthetic changed-file and legacy fallback evidence use shorter IDs and
  // are not individually readable through the relation_evidence resource.
  if (
    evidence.extractorId === 'canonical-entity-graph' &&
    evidence.relationKind &&
    /^[0-9a-f]{20}$/.test(evidence.id)
  ) {
    return evidenceResourceUri(evidence.id);
  }
  return undefined;
}

export function numericCompare(left: number, right: number): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
