import { createHash } from 'node:crypto';
import path from 'node:path';

import type { Confidence, RelationKind, ScannedFile } from '../types.js';
import { originalLineRange } from './text-evidence.js';
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
export const CONFIG_INFRA_SEMANTIC_ADAPTER_VERSION = '3';

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

type DockerfileOperand = IgnoredRange & { value: string };

const capabilities: readonly AdapterCapability[] = ['references'];
type ConfigInput = Pick<ScannedFile, 'relativePath' | 'language' | 'content'>;
// Raw evidence stays process-local; persistence must retain the publisher's redaction boundary.
const eventMemo = new Map<string, string>();
const memoPayloadLimit = 1_048_576;
const memoEntryLimit = 256;
let memoPayloadBytes = 0;

export class ConfigInfraSemanticAdapter implements SemanticAdapter {
  readonly id = CONFIG_INFRA_SEMANTIC_ADAPTER_ID;
  readonly version = CONFIG_INFRA_SEMANTIC_ADAPTER_VERSION;
  readonly capabilities = capabilities;
  readonly confidence = 'heuristic';
  readonly fileContentScope = 'target-only';
  readonly outputOwnership = 'processed-file';
  readonly knownGaps = [
    'path-reference inference does not fully evaluate workflow, Dockerfile, or Terraform execution semantics',
    'computed paths, templated variables, and generated config are only partially visible'
  ];

  supports(file: ScannedFile): boolean {
    return isWorkflowFile(file) || file.language === 'dockerfile' || file.language === 'terraform';
  }

  start(ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun {
    const filePathSet = new Set(ctx.indexedFiles.map((file) => file.relativePath));
    const normalizedPaths = new Map([...filePathSet].map((filePath) => [filePath, filePath.toLowerCase()]));
    const tokenPaths = new Set([...normalizedPaths.values()].filter((filePath) => /^[a-z0-9._/@-]+$/.test(filePath)));
    const contextKey = createHash('sha256').update(JSON.stringify([ctx.repoRoot, [...filePathSet]])).digest('hex');
    return {
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        const input: ConfigInput = { relativePath: file.relativePath, language: file.language, content: file.content };
        const key = createHash('sha256').update(contextKey).update(JSON.stringify(input)).digest('hex');
        const cached = eventMemo.get(key);
        if (cached !== undefined) {
          eventMemo.delete(key);
          eventMemo.set(key, cached);
          yield* JSON.parse(cached) as IndexEvent[];
          return;
        }
        let serialized: string[] | undefined = [];
        let bytes = 2 * (key.length + 2);
        for (const event of extractConfigInfraEvents(input, filePathSet, normalizedPaths, tokenPaths)) {
          const json = JSON.stringify(event);
          if (serialized) {
            bytes += 2 * (json.length + (serialized.length > 0 ? 1 : 0));
            if (bytes <= memoPayloadLimit) serialized.push(json);
            else serialized = undefined;
          }
          // Keep yielded mutations out of the generator's shared descriptors and memo.
          yield JSON.parse(json) as IndexEvent;
        }
        if (serialized && !eventMemo.has(key)) {
          while (eventMemo.size >= memoEntryLimit || memoPayloadBytes + bytes > memoPayloadLimit) {
            const [oldKey, oldJson] = eventMemo.entries().next().value!;
            eventMemo.delete(oldKey);
            memoPayloadBytes -= 2 * (oldKey.length + oldJson.length);
          }
          eventMemo.set(key, `[${serialized.join(',')}]`);
          memoPayloadBytes += bytes;
        }
      }
    };
  }
}

function* extractConfigInfraEvents(
  file: ConfigInput,
  filePathSet: ReadonlySet<string>,
  normalizedPaths: ReadonlyMap<string, string>,
  tokenPaths: ReadonlySet<string>
): Iterable<IndexEvent> {
  const fileDescriptor = configInfraFileDescriptor(file);
  const ignoredTextRanges = file.language === 'dockerfile' ? dockerfileDeferredSearchRanges(file) : [];
  const configuredTargets = inferExplicitTextTargetsWithEvidence(
    file.relativePath,
    file.content,
    normalizedPaths,
    tokenPaths,
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

function configInfraFileDescriptor(file: ConfigInput): EntityDescriptor {
  return {
    kind: isWorkflowFile(file) ? 'workflow' : 'resource',
    path: file.relativePath,
    languageId: file.language,
    displayName: file.relativePath
  };
}

function configInfraProvenance(file: ConfigInput): string {
  if (isWorkflowFile(file)) return 'github-actions path reference';
  if (file.language === 'dockerfile') return 'dockerfile path reference';
  if (file.language === 'terraform') return 'terraform path reference';
  return 'config path reference';
}

function isWorkflowFile(file: ConfigInput): boolean {
  return file.language === 'yaml' && file.relativePath.startsWith('.github/workflows/');
}

function dockerfileCopyTargets(
  file: ConfigInput,
  filePathSet: ReadonlySet<string>
): TextTarget[] {
  const targets = new Map<string, TextTarget>();
  for (const match of file.content.matchAll(/(.*?)(?:\r?\n|$)/gs)) {
    const line = match[1]!;
    const copyMatch = /^\s*(?:COPY|ADD)\s+(.+)$/i.exec(line);
    if (!copyMatch) continue;
    const args = copyMatch[1]!;
    const operands = dockerfileCopyOperands(args);
    if (operands.from) continue;
    for (const operand of operands.sources) {
      const source = dockerfileLocalSource(operand.value);
      if (!source) continue;
      const targetPath = resolveConfigPath(file.relativePath, source, filePathSet);
      if (targetPath && !targets.has(targetPath)) {
        targets.set(targetPath, {
          path: targetPath,
          evidence: evidenceLineAt(file.content, match.index + line.length - args.length + operand.start)
        });
      }
    }
  }
  return [...targets.values()];
}

function dockerfileDeferredSearchRanges(file: ConfigInput): IgnoredRange[] {
  const ranges: IgnoredRange[] = [];
  let searchOffset = 0;
  for (const match of file.content.matchAll(/(.*?)(?:\r?\n|$)/gs)) {
    const line = match[1]!;
    const ascii = !/[^\x00-\x7f]/.test(line);
    const copyMatch = /^\s*(?:COPY|ADD)\s+(.+)$/i.exec(line);
    if (copyMatch) {
      const args = copyMatch[1]!;
      const operands = dockerfileCopyOperands(args);
      if (operands.from) {
        for (const operand of [operands.from, ...operands.sources]) {
          const start = line.length - args.length + operand.start;
          const end = line.length - args.length + operand.end;
          ranges.push({
            start: searchOffset + (ascii ? start : line.slice(0, start).toLowerCase().length),
            end: searchOffset + (ascii ? end : line.slice(0, end).toLowerCase().length)
          });
        }
      }
    }
    // Compose lengths only; matching retains whole-string contextual casing.
    searchOffset += (ascii ? line.length : line.toLowerCase().length) + match[0].length - line.length;
  }
  return ranges;
}

function dockerfileCopyOperands(copyArgs: string): { from: IgnoredRange | undefined; sources: DockerfileOperand[] } {
  const tokens = [...copyArgs.matchAll(/\S+/g)];
  let from: IgnoredRange | undefined;
  let index = 0;
  while (index < tokens.length && tokens[index]![0].startsWith('--')) {
    const token = tokens[index]!;
    const last = dockerfileFlagConsumesValue(token[0]) ? tokens[index + 1] ?? token : token;
    const lowerToken = token[0].toLowerCase();
    if (lowerToken === '--from' || lowerToken.startsWith('--from=')) {
      from = { start: token.index, end: last.index + last[0].length };
    }
    index += last === token ? 1 : 2;
  }
  const first = tokens[index];
  if (!first) return { from, sources: [] };
  const payload = copyArgs.slice(first.index);
  let operands: DockerfileOperand[];
  if (payload.startsWith('[')) {
    const values = parseDockerfileJsonStringArray(payload);
    if (values.length < 2) return { from, sources: [] };
    const strings = [...payload.matchAll(/"(?:\\.|[^"\\])*"/g)];
    operands = values.map((value, ordinal) => {
      const token = strings[ordinal]!;
      return { value, start: first.index + token.index, end: first.index + token.index + token[0].length };
    });
  } else {
    // shortcut: shell quoting and continuations retain the existing whitespace-token grammar; extend with parser fixtures.
    operands = tokens.slice(index).map((token) => ({
      value: token[0].replace(/^["']|["']$/g, ''), start: token.index, end: token.index + token[0].length
    }));
  }
  return { from, sources: operands.slice(0, -1) };
}

function dockerfileFlagConsumesValue(token: string): boolean {
  if (token.includes('=')) return false;
  const flagName = token.slice(2).toLowerCase();
  return ['from', 'chown', 'chmod', 'checksum', 'exclude'].includes(flagName);
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

function dockerfileLocalSource(source: string): string | undefined {
  if (!source || source.includes('*') || /^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return undefined;
  return source;
}

function inferExplicitTextTargetsWithEvidence(
  relativePath: string,
  content: string,
  normalizedPaths: ReadonlyMap<string, string>,
  tokenPaths: ReadonlySet<string>,
  ignoredRanges: readonly IgnoredRange[] = []
): TextTarget[] {
  const targets: TextTarget[] = [];
  const normalizedContent = content.toLowerCase();
  const tokenIndices = new Map<string, number>();
  // Maximal tokens use the same continuation characters as the boundary check.
  for (const match of normalizedContent.matchAll(/[a-z0-9._/@-]+/g)) {
    const token = match[0];
    if (tokenPaths.has(token) && !tokenIndices.has(token) &&
        !overlapsIgnoredRange(match.index, token.length, ignoredRanges)) {
      tokenIndices.set(token, match.index);
    }
  }
  for (const [candidatePath, normalizedPath] of normalizedPaths) {
    if (candidatePath === relativePath) continue;
    const pathIndex = tokenPaths.has(normalizedPath)
      ? tokenIndices.get(normalizedPath) ?? -1
      : findExplicitPathIndex(normalizedContent, normalizedPath, 0, ignoredRanges);
    if (pathIndex < 0) continue;
    const { start, end } = originalLineRange(content, normalizedContent, pathIndex);
    targets.push({
      path: candidatePath,
      evidence: evidenceSpanFromRange(content, firstNonWhitespaceIndex(content, start), end)
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
  const candidates = [
    referencedPath,
    path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), referencedPath))
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
