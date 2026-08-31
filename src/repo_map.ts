import { existsSync } from 'node:fs';
import path from 'node:path';

import { analyzeDiff } from './analyzer.js';
import { buildContextPack, selectCoChangePartners } from './context_pack.js';
import { isTestPath } from './entity_classification.js';
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
  RepoMapQueryMatch,
  RepoMapVerificationPlan,
  RepoMapVerificationPlanGroup
} from './types.js';

const defaultRepoMapBudgetTokens = 2_000;
const minRepoMapBudgetTokens = 200;
const maxVerificationPlanGroups = 8;
const maxVerificationPlanTargets = 12;

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
    repoRoot,
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
    repoRoot: string;
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
  const verificationPlan = buildVerificationPlan(input.repoRoot, {
    changedFiles: input.changedFiles,
    affectedFiles,
    tests,
    docs,
    config,
    workArtifacts: pack.workArtifacts,
    actions: pack.actions
  });
  const adapterGaps = (pack.adapterInsights ?? []).flatMap((insight) =>
    insight.knownGaps.map((gap) => `${insight.id}: ${gap}`)
  );
  const provenance = [
    `impact index run ${pack.indexRunId}`,
    'affected files, evidence, actions, work artifacts, and resources come from buildContextPack',
    'verification plan groups ImpactReport.actions by nearest package.json root without invoking external build tools',
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
      `${verificationPlan.groups.length} verification plan group(s) were ranked from existing action recommendations.`,
      `Token use is estimated with Math.ceil(text.length / 4), so counts are approximate.`
    ],
    affectedFiles,
    tests,
    docs,
    config,
    workArtifacts: pack.workArtifacts,
    evidenceRefs,
    verificationActions: pack.actions,
    verificationPlan,
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
      'Verification plan package roots are inferred from nearest package.json only; Nx/Bazel target discovery is not executed.',
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
  while (current.budget.estimatedTokens > requestedTokens && current.verificationPlan.groups.length > 0) {
    const removed = current.verificationPlan.groups.pop();
    if (removed) {
      current.verificationPlan.omittedCounts.groups += 1;
      current.verificationPlan.omittedCounts.targetPaths += removed.targetPaths.length + removed.coveredAffectedFiles.length;
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

type VerificationPathCandidate = {
  path: string;
  confidence: Confidence;
  reason: string;
  packageRoot: string;
};

type VerificationActionBucket = {
  packageRoot: string;
  runnerId?: string;
  command?: string;
  argsPrefix: string[];
  actions: ImpactAction[];
  targetPaths: Set<string>;
};

function buildVerificationPlan(
  repoRoot: string,
  input: {
    changedFiles: string[];
    affectedFiles: RepoMapPathItem[];
    tests: RepoMapPathItem[];
    docs: RepoMapPathItem[];
    config: RepoMapPathItem[];
    workArtifacts: RepoMap['workArtifacts'];
    actions: ImpactAction[];
  }
): RepoMapVerificationPlan {
  const rootForPath = packageRootResolver(repoRoot);
  const candidates: VerificationPathCandidate[] = [
    ...input.changedFiles.map((filePath) => ({
      path: filePath,
      confidence: 'proven' as Confidence,
      reason: 'changed root',
      packageRoot: rootForPath(filePath)
    })),
    ...[
      ...input.affectedFiles,
      ...input.tests,
      ...input.docs,
      ...input.config,
      ...input.workArtifacts
    ].map((item) => ({
      path: item.path,
      confidence: item.confidence,
      reason: item.reason,
      packageRoot: rootForPath(item.path)
    }))
  ];
  const buckets = new Map<string, VerificationActionBucket>();
  for (const action of input.actions) {
    const targetPath = action.target.path;
    if (!targetPath) continue;
    const normalized = normalizeVerificationAction(action, targetPath);
    const packageRoot = rootForPath(targetPath);
    const key = [
      packageRoot,
      action.runnerId ?? '',
      action.command ?? '',
      normalized.argsPrefix.join('\0'),
      normalized.groupSuffix
    ].join('\0');
    const bucket = buckets.get(key) ?? {
      packageRoot,
      ...(action.runnerId === undefined ? {} : { runnerId: action.runnerId }),
      ...(action.command === undefined ? {} : { command: action.command }),
      argsPrefix: normalized.argsPrefix,
      actions: [],
      targetPaths: new Set<string>()
    };
    bucket.actions.push(action);
    bucket.targetPaths.add(targetPath);
    buckets.set(key, bucket);
  }

  const allGroups = [...buckets.values()]
    .map((bucket): Omit<RepoMapVerificationPlanGroup, 'rank'> => {
      const fullTargetPaths = [...bucket.targetPaths].sort();
      const targetPaths = fullTargetPaths.slice(0, maxVerificationPlanTargets);
      const targetSet = new Set(targetPaths);
      const actions = bucket.actions
        .filter((action) => action.target.path ? targetSet.has(action.target.path) : false)
        .sort((a, b) => (a.target.path ?? '').localeCompare(b.target.path ?? '') || a.display.localeCompare(b.display));
      const firstAction = actions[0] ?? bucket.actions[0]!;
      const args = combinedNpmTestArgs(bucket, targetPaths) ?? firstAction.args;
      const display = bucket.command && args ? displayCommand(bucket.command, args) : firstAction.display;
      const packageCandidates = candidates
        .filter((item) => item.packageRoot === bucket.packageRoot)
        .sort(compareVerificationCandidate);
      const coveredChangedFiles = input.changedFiles
        .filter((filePath) => rootForPath(filePath) === bucket.packageRoot)
        .sort();
      const coveredAffectedFiles = packageCandidates
        .map((item) => item.path)
        .filter((filePath) => !coveredChangedFiles.includes(filePath))
        .filter((filePath, index, values) => values.indexOf(filePath) === index);
      const reasons = uniqueStrings([
        ...actions.map((action) => action.target.path ? `verify ${action.target.path}` : 'verify affected target'),
        ...packageCandidates.map((item) => item.reason)
      ]).slice(0, 6);
      return {
        id: `verification:${bucket.packageRoot}:${bucket.command ?? firstAction.runnerId ?? 'action'}:${targetPaths.join(',')}`,
        strategy: 'direct-test-command',
        packageRoot: bucket.packageRoot,
        ...(bucket.runnerId === undefined ? {} : { runnerId: bucket.runnerId }),
        ...(bucket.command === undefined ? {} : { command: bucket.command }),
        ...(args === undefined ? {} : { args }),
        display,
        confidence: overallConfidence(actions.map((action) => action.confidence)),
        targetPaths,
        coveredChangedFiles,
        coveredAffectedFiles: coveredAffectedFiles.slice(0, maxVerificationPlanTargets),
        reasons,
        sourceActions: uniqueStrings(actions.map((action) => action.display)).slice(0, maxVerificationPlanTargets),
        omittedTargetCount: Math.max(fullTargetPaths.length - targetPaths.length, 0)
          + Math.max(coveredAffectedFiles.length - maxVerificationPlanTargets, 0)
      };
    })
    .sort(compareVerificationPlanGroup);

  const selectedGroups = allGroups.slice(0, maxVerificationPlanGroups).map((group, index) => ({
    ...group,
    rank: index + 1
  }));
  const omittedGroupTargets = allGroups.slice(maxVerificationPlanGroups)
    .reduce((sum, group) => sum + group.targetPaths.length + group.coveredAffectedFiles.length, 0);
  return {
    generatedFrom: [
      'ImpactReport.actions',
      'RepoMap affected/test/doc/config/work artifact sections',
      'nearest package.json package roots'
    ],
    groups: selectedGroups,
    omittedCounts: {
      groups: Math.max(allGroups.length - selectedGroups.length, 0),
      targetPaths: selectedGroups.reduce((sum, group) => sum + group.omittedTargetCount, 0) + omittedGroupTargets
    }
  };
}

function packageRootResolver(repoRoot: string): (relativePath: string) => string {
  const cache = new Map<string, string>();
  return (relativePath: string): string => {
    const normalized = relativePath.split('\\').join('/');
    const cached = cache.get(normalized);
    if (cached !== undefined) return cached;
    const resolved = nearestPackageRoot(repoRoot, normalized);
    cache.set(normalized, resolved);
    return resolved;
  };
}

function nearestPackageRoot(repoRoot: string, relativePath: string): string {
  const normalized = path.posix.normalize(relativePath.split('\\').join('/'));
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return '.';
  const dirname = normalized.endsWith('/package.json')
    ? path.posix.dirname(normalized)
    : path.posix.dirname(normalized);
  const parts = dirname === '.' ? [] : dirname.split('/').filter(Boolean);
  for (let length = parts.length; length >= 0; length -= 1) {
    const packageRoot = parts.slice(0, length).join('/') || '.';
    const manifestPath = safeRepoRelativePath(repoRoot, packageRoot === '.' ? 'package.json' : `${packageRoot}/package.json`);
    if (manifestPath && existsSync(manifestPath)) return packageRoot;
  }
  return '.';
}

function safeRepoRelativePath(repoRoot: string, relativePath: string): string | undefined {
  const absolute = path.resolve(repoRoot, ...relativePath.split('/'));
  const relative = path.relative(repoRoot, absolute);
  if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) return undefined;
  return absolute;
}

function normalizeVerificationAction(action: ImpactAction, targetPath: string): { argsPrefix: string[]; groupSuffix: string } {
  if (action.command === 'npm' && action.args?.[0] === 'test' && action.args[1] === '--' && action.args[2] === targetPath) {
    return { argsPrefix: ['test', '--'], groupSuffix: 'targeted-test-paths' };
  }
  return {
    argsPrefix: action.args ?? [],
    groupSuffix: action.display
  };
}

function combinedNpmTestArgs(bucket: VerificationActionBucket, targetPaths: string[]): string[] | undefined {
  if (bucket.command !== 'npm') return undefined;
  if (bucket.argsPrefix.length !== 2 || bucket.argsPrefix[0] !== 'test' || bucket.argsPrefix[1] !== '--') return undefined;
  return ['test', '--', ...targetPaths];
}

function displayCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
  if (value === '--') return value;
  const displayValue = value
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  if (/^[A-Za-z0-9_./:-]+$/.test(displayValue) && !displayValue.startsWith('-')) return displayValue;
  return `'${displayValue.replace(/'/g, `'\\''`)}'`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function compareVerificationCandidate(a: VerificationPathCandidate, b: VerificationPathCandidate): number {
  const byConfidence = confidenceRank(b.confidence) - confidenceRank(a.confidence);
  if (byConfidence !== 0) return byConfidence;
  return a.path.localeCompare(b.path);
}

function compareVerificationPlanGroup(
  a: Omit<RepoMapVerificationPlanGroup, 'rank'>,
  b: Omit<RepoMapVerificationPlanGroup, 'rank'>
): number {
  const byConfidence = confidenceRank(b.confidence) - confidenceRank(a.confidence);
  if (byConfidence !== 0) return byConfidence;
  const byCoverage = b.coveredAffectedFiles.length - a.coveredAffectedFiles.length;
  if (byCoverage !== 0) return byCoverage;
  const byTargets = b.targetPaths.length - a.targetPaths.length;
  if (byTargets !== 0) return byTargets;
  return a.display.localeCompare(b.display);
}

function confidenceRank(value: Confidence): number {
  if (value === 'proven') return 3;
  if (value === 'inferred') return 2;
  if (value === 'heuristic') return 1;
  return 0;
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
