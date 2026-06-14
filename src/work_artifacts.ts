import type { MarkdownArtifactMetadata } from './artifacts.js';

export type WorkArtifactFreshnessState = 'current' | 'stale' | 'unknown';

export type WorkArtifactFreshness = {
  state: WorkArtifactFreshnessState;
  label: string;
  thresholdDays: number;
  ageDays?: number;
};

export function hasArtifactMetadata(metadata: MarkdownArtifactMetadata): boolean {
  return Boolean(metadata.title || metadata.owner || metadata.status || metadata.updatedAt);
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
