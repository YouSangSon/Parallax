import path from 'node:path';

import type { EntityKind } from './types.js';

export type MarkdownArtifactKind =
  | 'doc'
  | 'policy'
  | 'proposal'
  | 'prd'
  | 'requirement'
  | 'decision';

const policyBasenames = new Set([
  'security.md',
  'security-policy.md',
  'compliance.md',
  'privacy.md'
]);

export function markdownEntityKindForPath(relativePath: string): MarkdownArtifactKind {
  const normalized = relativePath.toLowerCase().replaceAll('\\', '/');
  const segments = normalized.split('/').filter(Boolean);
  const basename = path.posix.basename(normalized);
  const stem = basename.replace(/\.mdx?$/, '');

  if (
    hasSegment(segments, ['decision', 'decisions', 'adr', 'adrs']) ||
    /^adr[-_0-9]/.test(stem) ||
    containsWord(stem, ['decision'])
  ) {
    return 'decision';
  }
  if (
    hasSegment(segments, ['proposal', 'proposals', 'rfc', 'rfcs']) ||
    /^rfc[-_0-9]/.test(stem) ||
    containsWord(stem, ['proposal'])
  ) {
    return 'proposal';
  }
  if (
    hasSegment(segments, ['prd', 'prds']) ||
    containsWord(stem, ['prd'])
  ) {
    return 'prd';
  }
  if (
    hasSegment(segments, ['requirement', 'requirements']) ||
    containsWord(stem, ['requirement', 'requirements'])
  ) {
    return 'requirement';
  }
  if (
    policyBasenames.has(basename) ||
    hasSegment(segments, ['policy', 'policies']) ||
    containsWord(stem, ['policy'])
  ) {
    return 'policy';
  }
  return 'doc';
}

export function entityKindForMarkdownPath(relativePath: string): EntityKind {
  return markdownEntityKindForPath(relativePath);
}

function hasSegment(segments: readonly string[], candidates: readonly string[]): boolean {
  return segments.some((segment) => candidates.includes(segment));
}

function containsWord(value: string, words: readonly string[]): boolean {
  const parts = value.split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => parts.includes(word));
}
