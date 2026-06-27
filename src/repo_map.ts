import { analyzeDiff } from './analyzer.js';
import { buildContextPack, selectCoChangePartners } from './context_pack.js';
import { searchContext } from './mcp_search.js';
import { normalizeRepoRoot } from './security.js';
import type {
  Confidence,
  ContextPack,
  ContextPackItem,
  ImpactAction,
  RepoMap,
  RepoMapEvidenceRef,
  RepoMapOptions,
  RepoMapPathItem,
  RepoMapQueryMatch
} from './types.js';

const defaultRepoMapBudgetTokens = 2_000;
const minRepoMapBudgetTokens = 200;

export async function buildRepoMap(options: RepoMapOptions): Promise<RepoMap> {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const budgetTokens = normalizeRepoMapBudget(options.budgetTokens);
  const report = await analyzeDiff({
    repoRoot,
    changedFiles: options.changedFiles,
    persistReport: false,
    readOnly: true,
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    ...(options.maxFanout === undefined ? {} : { maxFanout: options.maxFanout })
  });
  const pack = buildContextPack(
    report,
    'deep',
    new Date().toISOString(),
    selectCoChangePartners(repoRoot, report.changedFiles)
  );
  const queryResult = options.query ? repoMapQueryMatches(repoRoot, options.query) : { matches: [], omitted: 0 };
  const map = repoMapFromContextPack(pack, {
    changedFiles: report.changedFiles,
    query: options.query,
    queryMatches: queryResult.matches,
    omittedQueryMatches: queryResult.omitted,
    budgetTokens
  });
  return fitRepoMapToBudget(map, budgetTokens);
}

export function estimateRepoMapTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function repoMapFromContextPack(
  pack: ContextPack,
  input: {
    changedFiles: string[];
    query: string | undefined;
    queryMatches: RepoMapQueryMatch[];
    omittedQueryMatches: number;
    budgetTokens: number;
  }
): RepoMap {
  const tests = pack.context.filter((item) => isTestPath(item.path)).map(repoMapPathItem);
  const docs = pack.context.filter((item) => isDocPath(item.path)).map(repoMapPathItem);
  const config = pack.context.filter((item) => isConfigPath(item.path)).map(repoMapPathItem);
  const specialPaths = new Set([...tests, ...docs, ...config].map((item) => item.path));
  const affectedFiles = pack.context
    .filter((item) => !specialPaths.has(item.path))
    .map(repoMapPathItem);
  const adapterGaps = (pack.adapterInsights ?? []).flatMap((insight) =>
    insight.knownGaps.map((gap) => `${insight.id}: ${gap}`)
  );
  const provenance = [
    `impact index run ${pack.indexRunId}`,
    'affected files, evidence, actions, work artifacts, and resources come from buildContextPack',
    ...(input.query ? ['query matches come from searchContext over the existing index'] : []),
    ...(pack.coChanges && pack.coChanges.length > 0 ? ['co-change entries are heuristic git-history signals'] : [])
  ];
  const evidenceRefs = pack.evidence.map((item): RepoMapEvidenceRef => ({
    id: item.id,
    file: item.file,
    kind: item.kind,
    confidence: item.confidence,
    snippet: item.snippet,
    ...(item.resourceUri === undefined ? {} : { resourceUri: item.resourceUri }),
    ...(item.startLine === undefined ? {} : { startLine: item.startLine }),
    ...(item.endLine === undefined ? {} : { endLine: item.endLine })
  }));
  const resources = {
    coverage: pack.resources.coverage,
    entities: pack.resources.entities,
    evidence: pack.resources.evidence
  };
  return withTokenEstimate({
    version: 0,
    kind: 'repo_map',
    budget: {
      requestedTokens: input.budgetTokens,
      estimatedTokens: 0,
      estimator: 'Math.ceil(text.length / 4)',
      truncated: false
    },
    indexRunId: pack.indexRunId,
    changedFiles: input.changedFiles,
    changedRoots: changedRoots(input.changedFiles),
    summary: [
      `${input.changedFiles.length} changed file(s) mapped against index run ${pack.indexRunId}.`,
      `${pack.context.length} affected file(s), ${pack.workArtifacts.length} work artifact(s), ${evidenceRefs.length} evidence ref(s), and ${pack.actions.length} verification action(s) were eligible before token trimming.`,
      `Token use is estimated with Math.ceil(text.length / 4), so counts are approximate.`
    ],
    affectedFiles,
    tests,
    docs,
    config,
    workArtifacts: pack.workArtifacts,
    evidenceRefs,
    verificationActions: pack.actions,
    resources,
    ...(input.query === undefined ? {} : { query: input.query, queryMatches: input.queryMatches }),
    confidence: {
      overall: overallConfidence([
        ...pack.context.map((item) => item.confidence),
        ...pack.evidence.map((item) => item.confidence),
        ...pack.actions.map((item) => item.confidence)
      ]),
      provenance,
      knownGaps: adapterGaps
    },
    omittedCounts: {
      affectedFiles: pack.omittedCounts.affected,
      tests: 0,
      docs: 0,
      config: 0,
      workArtifacts: pack.omittedCounts.workArtifacts,
      evidenceRefs: pack.omittedCounts.evidence,
      verificationActions: pack.omittedCounts.actions,
      queryMatches: input.omittedQueryMatches,
      coChanges: pack.omittedCounts.coChanges,
      budgetItems: 0
    },
    knownGaps: [
      ...adapterGaps,
      'Repo map is a compact planning card; fetch parallax:// resources for full entity or evidence bodies.',
      ...(pack.coChanges && pack.coChanges.length > 0 ? ['Git co-change partners are historical correlation, not proof of runtime dependency.'] : [])
    ],
    ...(pack.warnings === undefined ? {} : { warnings: pack.warnings })
  });
}

function fitRepoMapToBudget(map: RepoMap, requestedTokens: number): RepoMap {
  let current = withTokenEstimate(map);
  if (current.budget.estimatedTokens <= requestedTokens) return current;

  const trimmed: RepoMap = {
    ...current,
    summary: current.summary.slice(0, 2),
    resources: {
      coverage: current.resources.coverage,
      entities: current.resources.entities.slice(0, 30),
      evidence: current.resources.evidence.slice(0, 20)
    },
    confidence: {
      ...current.confidence,
      provenance: current.confidence.provenance.slice(0, 4),
      knownGaps: current.confidence.knownGaps.slice(0, 5)
    },
    knownGaps: current.knownGaps.slice(0, 5),
    budget: {
      ...current.budget,
      truncated: true
    }
  };

  const trimOrder: Array<keyof Pick<
    RepoMap,
    'queryMatches' | 'evidenceRefs' | 'verificationActions' | 'workArtifacts' | 'config' | 'docs' | 'tests' | 'affectedFiles'
  >> = [
    'queryMatches',
    'evidenceRefs',
    'verificationActions',
    'workArtifacts',
    'config',
    'docs',
    'tests',
    'affectedFiles'
  ];

  current = withTokenEstimate(trimmed);
  for (const key of trimOrder) {
    while (current.budget.estimatedTokens > requestedTokens && arrayLength(current[key]) > minimumKept(key)) {
      removeLast(current, key);
      current.omittedCounts[omittedKeyForSection(key)] += 1;
      current.omittedCounts.budgetItems += 1;
      current = withTokenEstimate(current);
    }
  }
  return current.budget.estimatedTokens > requestedTokens ? withTokenEstimate({
    ...current,
    budget: { ...current.budget, truncated: true }
  }) : current;
}

function repoMapQueryMatches(repoRoot: string, query: string): { matches: RepoMapQueryMatch[]; omitted: number } {
  const result = searchContext({ repoRoot }, {
    query,
    k: 8,
    includeEvidence: true,
    budget: 'brief',
    disabledStreams: new Set(),
    semanticEmbedding: null
  }) as {
    results?: Array<RepoMapQueryMatch & { score?: number }>;
    omittedCounts?: { entities?: number; evidence?: number };
  };
  const matches = (result.results ?? []).map((item) => ({
    entity: item.entity,
    ...(item.score === undefined ? {} : { score: item.score }),
    ...(item.reasons === undefined ? {} : { reasons: item.reasons }),
    resourceUri: item.resourceUri,
    ...(item.evidence === undefined ? {} : { evidence: item.evidence })
  }));
  return {
    matches,
    omitted: result.omittedCounts?.entities ?? 0
  };
}

function repoMapPathItem(item: ContextPackItem): RepoMapPathItem {
  return {
    path: item.path,
    reason: item.reason,
    confidence: item.confidence,
    resourceUri: item.resourceUri,
    ...(item.depth === undefined ? {} : { depth: item.depth }),
    relations: item.relations
  };
}

function changedRoots(paths: string[]): string[] {
  return [...new Set(paths.map((filePath) => {
    const parts = filePath.split('/').filter(Boolean);
    if (parts.length <= 1) return filePath;
    if (parts[0] === '.github') return parts.slice(0, 2).join('/');
    return parts.slice(0, Math.min(2, parts.length)).join('/');
  }))].sort();
}

function withTokenEstimate<T extends RepoMap>(map: T): T {
  const withoutEstimate = {
    ...map,
    budget: { ...map.budget, estimatedTokens: 0 }
  };
  const estimatedTokens = estimateRepoMapTokens(withoutEstimate);
  return {
    ...map,
    budget: {
      ...map.budget,
      estimatedTokens,
      truncated: map.budget.truncated || estimatedTokens > map.budget.requestedTokens
    }
  };
}

function normalizeRepoMapBudget(value: number | undefined): number {
  if (value === undefined) return defaultRepoMapBudgetTokens;
  if (!Number.isInteger(value) || value < minRepoMapBudgetTokens) {
    throw new Error(`repo map --budget must be an integer >= ${minRepoMapBudgetTokens}; got ${value}`);
  }
  return value;
}

function overallConfidence(values: Confidence[]): Confidence {
  if (values.includes('unknown')) return 'unknown';
  if (values.includes('heuristic')) return 'heuristic';
  if (values.includes('inferred')) return 'inferred';
  return values.length > 0 ? 'proven' : 'unknown';
}

function isTestPath(filePath: string): boolean {
  return /(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\.[^.]+$/.test(filePath);
}

function isDocPath(filePath: string): boolean {
  return filePath.startsWith('docs/') || /\.(md|mdx|rst|adoc)$/.test(filePath);
}

function isConfigPath(filePath: string): boolean {
  return filePath.startsWith('.github/workflows/') || /\.(json|ya?ml|toml|ini|env|config\.[^.]+)$/.test(filePath);
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function removeLast(
  map: RepoMap,
  key: keyof Pick<
    RepoMap,
    'queryMatches' | 'evidenceRefs' | 'verificationActions' | 'workArtifacts' | 'config' | 'docs' | 'tests' | 'affectedFiles'
  >
): void {
  const value = map[key];
  if (Array.isArray(value)) value.pop();
}

function minimumKept(key: keyof Pick<
  RepoMap,
  'queryMatches' | 'evidenceRefs' | 'verificationActions' | 'workArtifacts' | 'config' | 'docs' | 'tests' | 'affectedFiles'
>): number {
  if (key === 'affectedFiles') return 1;
  return 0;
}

function omittedKeyForSection(
  key: keyof Pick<
    RepoMap,
    'queryMatches' | 'evidenceRefs' | 'verificationActions' | 'workArtifacts' | 'config' | 'docs' | 'tests' | 'affectedFiles'
  >
): keyof RepoMap['omittedCounts'] {
  if (key === 'verificationActions') return 'verificationActions';
  if (key === 'evidenceRefs') return 'evidenceRefs';
  if (key === 'workArtifacts') return 'workArtifacts';
  if (key === 'queryMatches') return 'queryMatches';
  return key;
}
