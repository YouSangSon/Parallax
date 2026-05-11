import path from 'node:path';

import type { EntityKind } from './types.js';

export type MarkdownArtifactKind =
  | 'doc'
  | 'policy'
  | 'proposal'
  | 'prd'
  | 'requirement'
  | 'decision';

export type MarkdownArtifactMetadata = {
  title?: string;
  owner?: string;
  status?: string;
  updatedAt?: string;
  source?: 'frontmatter' | 'heading';
};

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

export function markdownArtifactMetadataFromContent(content: string): MarkdownArtifactMetadata {
  const frontmatter = parseSimpleFrontmatter(content);
  const title = firstNonEmpty(frontmatter.get('title'), firstMarkdownHeading(content));
  const owner = firstNonEmpty(
    frontmatter.get('owner'),
    frontmatter.get('owners'),
    frontmatter.get('team'),
    frontmatter.get('reviewer')
  );
  const status = firstNonEmpty(frontmatter.get('status'), frontmatter.get('state'));
  const updatedAt = normalizeDateLike(firstNonEmpty(
    frontmatter.get('updated'),
    frontmatter.get('updated_at'),
    frontmatter.get('last_reviewed'),
    frontmatter.get('reviewed_at')
  ));

  const metadata: MarkdownArtifactMetadata = {};
  if (title) metadata.title = title;
  if (owner) metadata.owner = owner;
  if (status) metadata.status = status;
  if (updatedAt) metadata.updatedAt = updatedAt;
  if (frontmatter.size > 0) {
    metadata.source = 'frontmatter';
  } else if (title) {
    metadata.source = 'heading';
  }
  return metadata;
}

function hasSegment(segments: readonly string[], candidates: readonly string[]): boolean {
  return segments.some((segment) => candidates.includes(segment));
}

function containsWord(value: string, words: readonly string[]): boolean {
  const parts = value.split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => parts.includes(word));
}

function parseSimpleFrontmatter(content: string): Map<string, string> {
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  if (lines[0]?.trim() !== '---') return new Map();
  const out = new Map<string, string>();
  const limit = Math.min(lines.length, 80);
  for (let index = 1; index < limit; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed === '---' || trimmed === '...') return out;
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase().replaceAll('-', '_');
    const value = normalizeScalar(match[2] ?? '');
    if (value) out.set(key, value);
  }
  return new Map();
}

function firstMarkdownHeading(content: string): string | undefined {
  for (const line of content.replaceAll('\r\n', '\n').split('\n')) {
    if (!line.trim()) continue;
    const match = /^#\s+(.+?)\s*$/.exec(line);
    return match?.[1]?.trim() || undefined;
  }
  return undefined;
}

function normalizeScalar(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1)
      .split(',')
      .map((item) => normalizeScalar(item) ?? '')
      .filter(Boolean)
      .join(', ');
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim() || undefined;
  }
  return trimmed.replace(/\s+#.*$/, '').trim() || undefined;
}

function normalizeDateLike(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1] ?? value;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}
