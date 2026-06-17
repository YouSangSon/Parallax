import { markdownArtifactMetadataFromContent, type MarkdownArtifactMetadata } from './artifacts.js';
import type { Confidence, EntityRef, Evidence, ImpactReport } from './types.js';

export type WorkArtifactFreshnessState = 'current' | 'stale' | 'unknown';

export type WorkArtifactFreshness = {
  state: WorkArtifactFreshnessState;
  label: string;
  thresholdDays: number;
  ageDays?: number;
};

export type WorkArtifactProjection = {
  kind: string;
  path: string;
  displayName: string;
  reason: string;
  confidence: Confidence;
  relations: string[];
  resourceUri: string;
  depth?: number;
  metadata?: MarkdownArtifactMetadata;
  freshness: WorkArtifactFreshness;
};

const workArtifactKinds = new Set<string>([
  'policy',
  'proposal',
  'prd',
  'decision',
  'business_plan',
  'requirement',
  'meeting_note',
  'customer_artifact'
]);

type WorkArtifactProjectionOptions = {
  asOfIso: string;
  includeDepth?: boolean;
};

export function hasArtifactMetadata(metadata: MarkdownArtifactMetadata): boolean {
  return Boolean(metadata.title || metadata.owner || metadata.status || metadata.updatedAt);
}

export function isWorkArtifactKind(kind: string): boolean {
  return workArtifactKinds.has(kind);
}

export function workArtifactPathSet(report: ImpactReport): Set<string> {
  return new Set(
    report.affected
      .map((item) => item.target)
      .filter((target) => target.path && isWorkArtifactKind(target.kind))
      .map((target) => target.path!)
  );
}

export function workArtifactEvidencePath(
  evidence: Evidence,
  workArtifactPaths: ReadonlySet<string>
): string | undefined {
  if (evidence.subject?.path && workArtifactPaths.has(evidence.subject.path)) {
    return evidence.subject.path;
  }
  if (workArtifactPaths.has(evidence.file)) return evidence.file;
  return undefined;
}

export function isWorkArtifactEvidence(evidence: Evidence, workArtifactPaths: ReadonlySet<string>): boolean {
  return Boolean(
    (evidence.subject && isWorkArtifactKind(evidence.subject.kind)) ||
    (evidence.subject?.path && workArtifactPaths.has(evidence.subject.path)) ||
    workArtifactPaths.has(evidence.file)
  );
}

export function workArtifactEvidenceResourceUri(
  evidence: Evidence,
  workArtifactPaths: ReadonlySet<string>
): string | undefined {
  if (evidence.subject && isWorkArtifactKind(evidence.subject.kind)) {
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

export function workArtifactsFromImpactReport(
  report: ImpactReport,
  options: WorkArtifactProjectionOptions
): WorkArtifactProjection[] {
  const affectedByPath = new Map(report.affectedFiles.map((item) => [item.path, item]));
  const metadataByPath = workArtifactMetadataByPath(report);
  const byKey = new Map<string, WorkArtifactProjection>();
  for (const item of report.affected) {
    const targetPath = item.target.path;
    if (!targetPath || !isWorkArtifactKind(item.target.kind)) continue;
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
      ...(options.includeDepth && affectedFile?.depth !== undefined ? { depth: affectedFile.depth } : {}),
      ...(metadata && hasArtifactMetadata(metadata) ? { metadata } : {}),
      freshness: workArtifactFreshness(item.target.kind, metadata, options.asOfIso)
    });
  }
  return [...byKey.values()].sort((left, right) => compareWorkArtifactProjections(left, right, options.includeDepth === true));
}

export function workArtifactFreshness(
  kind: string,
  metadata: MarkdownArtifactMetadata | undefined,
  asOfIso: string
): WorkArtifactFreshness {
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

export function workArtifactFreshnessThresholdDays(kind: string): number {
  if (kind === 'proposal') return 60;
  if (kind === 'prd' || kind === 'requirement') return 120;
  if (kind === 'decision') return 180;
  return 90;
}

export function parseDateOnly(value: string | undefined): Date | undefined {
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

export function workArtifactFreshnessRank(state: WorkArtifactFreshnessState): number {
  if (state === 'stale') return 0;
  if (state === 'unknown') return 1;
  return 2;
}

export function workArtifactKindRank(kind: string): number {
  if (kind === 'policy') return 0;
  if (kind === 'decision') return 1;
  if (kind === 'prd' || kind === 'requirement') return 2;
  if (kind === 'proposal') return 3;
  return 4;
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

function compareWorkArtifactProjections(
  left: WorkArtifactProjection,
  right: WorkArtifactProjection,
  includeDepth: boolean
): number {
  return workArtifactFreshnessRank(left.freshness.state) - workArtifactFreshnessRank(right.freshness.state)
    || workArtifactKindRank(left.kind) - workArtifactKindRank(right.kind)
    || (includeDepth ? (left.depth ?? 99) - (right.depth ?? 99) : 0)
    || left.path.localeCompare(right.path);
}

function entityResourceUri(entity: Pick<EntityRef, 'id'>): string {
  return `parallax://entities/${encodeURIComponent(entity.id)}`;
}
