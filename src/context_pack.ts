import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { queryCoChanges } from './co_change_query.js';
import { resolveInsideRoot } from './security.js';
import {
  isWorkArtifactEvidence,
  workArtifactPathSet,
  workArtifactsFromImpactReport
} from './work_artifacts.js';
import type {
  Confidence,
  ContextBudget,
  ContextPack,
  ContextPackCoChange,
  ContextPackEvidence,
  ContextPackItem,
  ContextPackReusePolicy,
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
  coChangeLimit: number;
};

const contextBudgetPresets: Record<ContextBudget, ContextBudgetPreset> = {
  brief: {
    maxDepth: 1,
    maxFanout: 50,
    affectedLimit: 5,
    workArtifactLimit: 5,
    evidenceLimit: 5,
    snippetChars: 300,
    coChangeLimit: 3
  },
  standard: {
    maxDepth: 2,
    maxFanout: 200,
    affectedLimit: 15,
    workArtifactLimit: 12,
    evidenceLimit: 12,
    snippetChars: 800,
    coChangeLimit: 5
  },
  deep: {
    maxDepth: 3,
    maxFanout: 500,
    affectedLimit: 50,
    workArtifactLimit: 30,
    evidenceLimit: 30,
    snippetChars: 1_500,
    coChangeLimit: 10
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

function normalizeCoChangeConfidence(value: string): Confidence {
  return value === 'proven' || value === 'inferred' || value === 'unknown' ? value : 'heuristic';
}

/**
 * Git co-change partners of the changed files, ranked by coupling strength
 * (strongest first). Advisory + honest: these couple via shared history, not
 * structure, so they carry heuristic confidence. Returns the full candidate set
 * — `buildContextPack` applies the budget cap and discloses what it truncates,
 * matching every other bounded dimension. Never throws: an unindexed or non-git
 * repo just yields an empty list, so the context pack degrades gracefully.
 */
export function selectCoChangePartners(
  repoRoot: string,
  changedFiles: string[]
): ContextPackCoChange[] {
  const changedSet = new Set(changedFiles);
  const strongest = new Map<string, ContextPackCoChange>();
  for (const changedFile of changedFiles) {
    let partners;
    try {
      partners = queryCoChanges(repoRoot, changedFile).partners;
    } catch {
      continue;
    }
    for (const partner of partners) {
      if (changedSet.has(partner.path)) continue;
      const entry: ContextPackCoChange = {
        changedFile,
        partner: partner.path,
        coChangeCount: partner.coChangeCount,
        couplingScore: partner.couplingScore,
        confidence: normalizeCoChangeConfidence(partner.confidence),
        resourceUri: entityResourceUri(entityForContextPath(partner.path))
      };
      const existing = strongest.get(partner.path);
      if (!existing || entry.couplingScore > existing.couplingScore) {
        strongest.set(partner.path, entry);
      }
    }
  }
  return [...strongest.values()].sort(
    (a, b) =>
      b.couplingScore - a.couplingScore ||
      b.coChangeCount - a.coChangeCount ||
      a.partner.localeCompare(b.partner)
  );
}

export function buildContextPack(
  report: ImpactReport,
  budget: ContextBudget,
  asOfIso: string,
  coChanges: ContextPackCoChange[] = []
): ContextPack {
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
  const allWorkArtifacts = workArtifactsFromImpactReport(report, { asOfIso });
  const selectedWorkArtifacts = allWorkArtifacts.slice(0, preset.workArtifactLimit);
  const selectedEvidence = dedupeEvidenceForContext(report.evidence)
    .sort((a, b) => compareEvidence(a, b, selectedPaths))
    .slice(0, preset.evidenceLimit)
    .map((evidence) => compactEvidence(evidence, preset.snippetChars, workArtifactPaths));
  const selectedActionPaths = new Set(selectedAffected.map((file) => file.path));
  const actions = report.actions.filter((action) =>
    action.target.path ? selectedActionPaths.has(action.target.path) : false
  );
  const selectedCoChanges = coChanges.slice(0, preset.coChangeLimit);
  const entityLinks = [
    ...report.changed.map(entityResourceUri),
    ...contextItems.map((item) => item.resourceUri),
    ...selectedWorkArtifacts.map((item) => item.resourceUri),
    ...selectedCoChanges.map((entry) => entry.resourceUri)
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
    ...(selectedCoChanges.length > 0 ? { coChanges: selectedCoChanges } : {}),
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
      actions: Math.max(report.actions.length - actions.length, 0),
      coChanges: Math.max(coChanges.length - selectedCoChanges.length, 0)
    },
    limits: {
      affectedLimit: preset.affectedLimit,
      workArtifactLimit: preset.workArtifactLimit,
      evidenceLimit: preset.evidenceLimit,
      snippetChars: preset.snippetChars,
      affectedTruncated: report.affectedFiles.length > preset.affectedLimit,
      evidenceTruncated: dedupeEvidenceForContext(report.evidence).length > preset.evidenceLimit,
      coChangeLimit: preset.coChangeLimit,
      coChangeTruncated: coChanges.length > preset.coChangeLimit
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

const omittedWorkArtifactEvidenceSnippet = 'Work artifact evidence omitted from context pack. Fetch the entity or evidence resource for document details.';

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
    ...(evidence.target !== undefined ? { target: evidence.target } : {}),
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
