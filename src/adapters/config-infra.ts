import path from 'node:path';

import type { Confidence, RelationKind, ScannedFile } from '../types.js';
import type {
  AdapterCapability,
  AdapterRun,
  EntityDescriptor,
  ExtractCtx,
  IndexEvent,
  PendingEvidence,
  PendingRelation,
  SemanticAdapter
} from './types.js';

export const CONFIG_INFRA_SEMANTIC_ADAPTER_ID = 'config-infra-semantic-v0';
export const CONFIG_INFRA_SEMANTIC_ADAPTER_VERSION = '1';

type EvidenceSpan = {
  snippet: string;
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
};

type TextTarget = {
  path: string;
  evidence: EvidenceSpan;
};

type IgnoredRange = {
  start: number;
  end: number;
};

const capabilities: readonly AdapterCapability[] = ['references'];

export class ConfigInfraSemanticAdapter implements SemanticAdapter {
  readonly id = CONFIG_INFRA_SEMANTIC_ADAPTER_ID;
  readonly version = CONFIG_INFRA_SEMANTIC_ADAPTER_VERSION;
  readonly capabilities = capabilities;

  supports(file: ScannedFile): boolean {
    return isWorkflowFile(file) || file.language === 'dockerfile' || file.language === 'terraform';
  }

  start(ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun {
    const filePathSet = new Set(ctx.indexedFiles.map((file) => file.relativePath));
    return {
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        yield* extractConfigInfraEvents(file, filePathSet);
      }
    };
  }
}

function* extractConfigInfraEvents(
  file: ScannedFile,
  filePathSet: ReadonlySet<string>
): Iterable<IndexEvent> {
  const fileDescriptor = configInfraFileDescriptor(file);
  const ignoredTextRanges = file.language === 'dockerfile' ? dockerfileDeferredSourceRanges(file) : [];
  const configuredTargets = inferExplicitTextTargetsWithEvidence(
    file.relativePath,
    file.content,
    filePathSet,
    ignoredTextRanges
  );

  if (file.language === 'dockerfile') {
    for (const target of dockerfileCopyTargets(file, filePathSet)) {
      yield {
        kind: 'relation',
        relation: makeRelation({
          source: fileDescriptor,
          target: { kind: 'file', path: target.path },
          kind: 'DEPENDS_ON',
          confidence: 'proven',
          provenance: 'dockerfile copy source',
          evidenceFile: file.relativePath,
          evidence: target.evidence
        })
      };
    }
  }

  for (const target of configuredTargets) {
    yield {
      kind: 'relation',
      relation: makeRelation({
        source: fileDescriptor,
        target: { kind: 'file', path: target.path },
        kind: 'CONFIGURES',
        confidence: 'heuristic',
        provenance: configInfraProvenance(file),
        evidenceFile: file.relativePath,
        evidence: target.evidence
      })
    };
  }
}

function configInfraFileDescriptor(file: ScannedFile): EntityDescriptor {
  return {
    kind: isWorkflowFile(file) ? 'workflow' : 'resource',
    path: file.relativePath,
    languageId: file.language,
    displayName: file.relativePath
  };
}

function configInfraProvenance(file: ScannedFile): string {
  if (isWorkflowFile(file)) return 'github-actions path reference';
  if (file.language === 'dockerfile') return 'dockerfile path reference';
  if (file.language === 'terraform') return 'terraform path reference';
  return 'config path reference';
}

function isWorkflowFile(file: ScannedFile): boolean {
  return file.language === 'yaml' && file.relativePath.startsWith('.github/workflows/');
}

function dockerfileCopyTargets(
  file: ScannedFile,
  filePathSet: ReadonlySet<string>
): TextTarget[] {
  const targets = new Map<string, TextTarget>();
  let offset = 0;
  for (const line of file.content.split(/\r?\n/)) {
    const copyMatch = /^\s*(?:COPY|ADD)\s+(.+)$/i.exec(line);
    if (!copyMatch) {
      offset += line.length + 1;
      continue;
    }
    for (const source of dockerfileCopySources(copyMatch[1]!)) {
      const targetPath = resolveConfigPath(file.relativePath, source, filePathSet);
      if (targetPath && !targets.has(targetPath)) {
        targets.set(targetPath, {
          path: targetPath,
          evidence: evidenceLineAt(file.content, offset + line.indexOf(source))
        });
      }
    }
    offset += line.length + 1;
  }
  return [...targets.values()];
}

function dockerfileCopySources(copyArgs: string): string[] {
  if (hasDockerfileFromFlag(copyArgs)) return [];
  return dockerfileSources(copyArgs);
}

function dockerfileDeferredSourceRanges(file: ScannedFile): IgnoredRange[] {
  const ranges: IgnoredRange[] = [];
  let offset = 0;
  for (const line of file.content.split(/\r?\n/)) {
    const copyMatch = /^\s*(?:COPY|ADD)\s+(.+)$/i.exec(line);
    if (!copyMatch) {
      offset += line.length + 1;
      continue;
    }
    for (const source of dockerfileMultistageCopySources(copyMatch[1]!)) {
      const sourceIndex = line.indexOf(source);
      if (sourceIndex >= 0) {
        ranges.push({
          start: offset + sourceIndex,
          end: offset + sourceIndex + source.length
        });
      }
    }
    offset += line.length + 1;
  }
  return ranges;
}

function dockerfileMultistageCopySources(copyArgs: string): string[] {
  if (!hasDockerfileFromFlag(copyArgs)) return [];
  return dockerfileSources(copyArgs);
}

function dockerfileSources(copyArgs: string): string[] {
  const tokens = dockerfilePayloadTokens(copyArgs);
  const payload = tokens.join(' ').trim();
  if (payload.startsWith('[')) {
    return dockerfileJsonArraySources(payload);
  }
  if (tokens.length < 2) return [];
  return tokens.slice(0, -1).flatMap((token) => {
    const source = normalizeDockerfileSource(token);
    return source ? [source] : [];
  });
}

function dockerfilePayloadTokens(copyArgs: string): string[] {
  const tokens = copyArgs.trim().split(/\s+/).filter((token) => token.length > 0);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const lowerToken = token.toLowerCase();
    if (lowerToken === '--from') {
      index += 1;
      continue;
    }
    if (token.startsWith('--')) {
      if (dockerfileFlagConsumesValue(token)) index += 1;
      continue;
    }
    return tokens.slice(index);
  }
  return [];
}

function dockerfileFlagConsumesValue(token: string): boolean {
  if (token.includes('=')) return false;
  const flagName = token.slice(2).toLowerCase();
  return ['from', 'chown', 'chmod', 'checksum', 'exclude'].includes(flagName);
}

function dockerfileJsonArraySources(payload: string): string[] {
  const values = parseDockerfileJsonStringArray(payload);
  return values.slice(0, -1).flatMap((value) => {
    const source = normalizeDockerfileSource(value);
    return source ? [source] : [];
  });
}

function parseDockerfileJsonStringArray(payload: string): string[] {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return Array.isArray(parsed) && parsed.every((value): value is string => typeof value === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function hasDockerfileFromFlag(copyArgs: string): boolean {
  return copyArgs
    .trim()
    .split(/\s+/)
    .some((token) => {
      const lowerToken = token.toLowerCase();
      return lowerToken === '--from' || lowerToken.startsWith('--from=');
    });
}

function normalizeDockerfileSource(source: string | undefined): string | undefined {
  const normalized = source?.replace(/^["']|["']$/g, '');
  if (!normalized || normalized.includes('*') || /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function inferExplicitTextTargetsWithEvidence(
  relativePath: string,
  content: string,
  filePathSet: ReadonlySet<string>,
  ignoredRanges: readonly IgnoredRange[] = []
): TextTarget[] {
  const targets: TextTarget[] = [];
  const normalizedContent = content.toLowerCase();
  for (const candidatePath of filePathSet) {
    if (candidatePath === relativePath) continue;
    const normalizedPath = candidatePath.toLowerCase();
    const pathIndex = findExplicitPathIndex(normalizedContent, normalizedPath, 0, ignoredRanges);
    if (pathIndex < 0) continue;
    targets.push({
      path: candidatePath,
      evidence: evidenceLineAt(content, pathIndex)
    });
  }
  return targets.sort((left, right) => left.path.localeCompare(right.path));
}

function findExplicitPathIndex(
  normalizedContent: string,
  normalizedPath: string,
  startIndex: number,
  ignoredRanges: readonly IgnoredRange[]
): number {
  let pathIndex = normalizedContent.indexOf(normalizedPath, startIndex);
  while (pathIndex >= 0) {
    if (
      hasExplicitPathBoundaries(normalizedContent, pathIndex, normalizedPath.length) &&
      !overlapsIgnoredRange(pathIndex, normalizedPath.length, ignoredRanges)
    ) {
      return pathIndex;
    }
    pathIndex = normalizedContent.indexOf(normalizedPath, pathIndex + normalizedPath.length);
  }
  return -1;
}

function hasExplicitPathBoundaries(content: string, index: number, length: number): boolean {
  const previous = index > 0 ? content[index - 1] : undefined;
  const next = content[index + length];
  return !isPathContinuationChar(previous) && !isPathContinuationChar(next);
}

function isPathContinuationChar(char: string | undefined): boolean {
  return char !== undefined && /[a-z0-9._/@-]/i.test(char);
}

function overlapsIgnoredRange(index: number, length: number, ignoredRanges: readonly IgnoredRange[]): boolean {
  const end = index + length;
  return ignoredRanges.some((range) => index < range.end && end > range.start);
}

function resolveConfigPath(
  sourcePath: string,
  referencedPath: string,
  filePathSet: ReadonlySet<string>
): string | undefined {
  const normalizedReference = referencedPath.replace(/^["']|["']$/g, '');
  const candidates = [
    normalizedReference,
    path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), normalizedReference))
  ];
  return candidates.find((candidate) =>
    !candidate.startsWith('../') &&
    !path.posix.isAbsolute(candidate) &&
    filePathSet.has(candidate)
  );
}

function makeRelation(input: {
  source: EntityDescriptor;
  target: EntityDescriptor;
  kind: RelationKind;
  confidence: Confidence;
  provenance: string;
  evidenceFile: string;
  evidence: EvidenceSpan;
}): PendingRelation {
  const evidence: PendingEvidence = {
    file: input.evidenceFile,
    snippet: input.evidence.snippet,
    confidence: input.confidence,
    startLine: input.evidence.startLine,
    endLine: input.evidence.endLine,
    startCol: input.evidence.startCol,
    endCol: input.evidence.endCol
  };
  return {
    source: input.source,
    target: input.target,
    kind: input.kind,
    metadata: { provenance: input.provenance, confidence: input.confidence },
    evidence: [evidence]
  };
}

function evidenceLineAt(content: string, index: number): EvidenceSpan {
  const start = content.lastIndexOf('\n', Math.max(0, index)) + 1;
  return evidenceSpanFromRange(content, firstNonWhitespaceIndex(content, start), lineEndIndex(content, index));
}

function evidenceSpanFromRange(content: string, start: number, end: number): EvidenceSpan {
  const safeStart = Math.max(0, Math.min(start, content.length));
  const safeEnd = Math.max(safeStart, Math.min(end, content.length));
  const beforeStart = content.slice(0, safeStart);
  const beforeEnd = content.slice(0, safeEnd);
  const startLine = beforeStart.split(/\r?\n/).length;
  const endLine = beforeEnd.split(/\r?\n/).length;
  const startCol = safeStart - (beforeStart.lastIndexOf('\n') + 1) + 1;
  const endCol = safeEnd - (beforeEnd.lastIndexOf('\n') + 1) + 1;
  return {
    snippet: content.slice(safeStart, safeEnd),
    startLine,
    endLine,
    startCol,
    endCol
  };
}

function firstNonWhitespaceIndex(content: string, lineStart: number): number {
  let index = lineStart;
  while (index < content.length && /[ \t]/.test(content[index]!)) index += 1;
  return index;
}

function lineEndIndex(content: string, index: number): number {
  const newline = content.indexOf('\n', index);
  return newline === -1 ? content.length : newline;
}
