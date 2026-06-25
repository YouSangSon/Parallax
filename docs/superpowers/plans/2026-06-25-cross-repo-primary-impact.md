# Cross-Repo Primary Impact Implementation Plan

**English** · [한국어](2026-06-25-cross-repo-primary-impact.ko.md) · [中文](2026-06-25-cross-repo-primary-impact.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface persisted workspace breaking-contract consumers directly in primary `analyzeDiff` reports, graph exports, MCP report payloads, and the UI workbench.

**Architecture:** Add an additive `crossRepoImpacts` report field and a focused read-only analyzer lane that converts existing `BREAKS_COMPATIBILITY_WITH` workspace links into affected targets and relation-bearing evidence. Keep contract-diff resolution separate: `analyzeDiff` reads already-persisted links, warns on malformed provenance, and relies on persisted report JSON for graph/UI surfaces.

**Tech Stack:** TypeScript, Node.js `node:test`, SQLite via `node:sqlite`, zod report schema, existing Parallax workspace/contract-diff resolver, trilingual Markdown docs.

## Global Constraints

- Read-only analyzer lane only: do not run `analyzeContractDiff`, `resolveCrossRepoContracts`, or any workspace mutation from `analyzeDiff`.
- Emit cross-repo impact only for changed files that match an indexed provider contract path in the current repo's latest completed index run.
- Use only persisted `BREAKS_COMPATIBILITY_WITH` links whose provenance references the same provider repo and contract path.
- Invalid or legacy provenance must be skipped without throwing; emit one deterministic report warning with the skipped count.
- Do not expose absolute local repo paths in public report fields, UI labels, docs examples, or screenshots.
- `crossRepoImpacts` is optional and additive; existing persisted reports remain readable.
- Cross-repo evidence must include `subject`, `target`, `relationKind`, `relationConfidence`, and `extractorId: 'cross-repo-contract-impact'` so graph export can rebuild edges from report JSON.
- No new command or MCP write surface is part of this slice.
- Keep English, Korean, and Chinese docs meaning-equivalent.
- Final acceptance requires `npm run schemas:build`, `npm run lint`, `npm test`, `npm run test:mcp`, `npm run test:ui`, and `npm run verify`.

---

## File Structure

- Create `src/workspace_resources.ts`: shared `parallax://workspaces/{name}` URI helpers used by MCP, UI, and the new analyzer lane. This prevents importing `src/mcp_resources.ts` into analyzer code.
- Create `src/cross_repo_impact.ts`: read-only SQL/provenance loader that maps persisted breaking links to `CrossRepoImpactCandidate` objects.
- Modify `src/types.ts`: add `CrossRepoImpact`, add optional `ImpactReport.crossRepoImpacts`, and export the type through `src/index.ts`.
- Modify `src/report_schema.ts` and `schemas/impact-report.schema.json`: bump the report schema to `1.3.0` and describe `crossRepoImpacts`.
- Modify `src/analyzer.ts`: call the new loader once per changed contract file and merge candidates into `affectedFiles`, `affected`, `evidence`, warnings, and the report payload.
- Modify `src/mcp_resources.ts` and `src/ui/data.ts`: import shared workspace URI helpers instead of duplicating them.
- Modify `src/ui.ts`, `src/ui/shared.ts`, `src/ui/panels.ts`, and `src/ui/client.ts`: include `crossRepoImpacts` in report previews, add a cross-repo lane label, and suppress local `/source` links for external consumer evidence.
- Modify `tests/report-schema.test.ts`, `tests/contract-diff.test.ts`, and `tests/ui.test.ts`: add schema, analyzer/graph, malformed provenance, and UI regression coverage.
- Modify `docs/cli-reference*.md`, `docs/mcp*.md`, `docs/report-schema*.md`, `docs/roadmap*.md`, and `IMPROVEMENT_OPPORTUNITIES.md`: document the shipped W1 behavior after implementation.

### Task 1: Report Contract And Shared Workspace Resources

**Files:**
- Create: `src/workspace_resources.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Modify: `src/report_schema.ts`
- Modify: `schemas/impact-report.schema.json`
- Modify: `src/mcp_resources.ts`
- Modify: `src/ui/data.ts`
- Test: `tests/report-schema.test.ts`

**Interfaces:**
- Produces: `CrossRepoImpact`, optional `ImpactReport.crossRepoImpacts`, `workspaceResourceUri(workspaceName)`, `workspaceResources(workspaceName)`.
- Consumes: Existing `Confidence`, `ImpactReport`, zod report schema, MCP/UI workspace resource display.

- [ ] **Step 1: Add the public report type**

In `src/types.ts`, add this type immediately before `export type ImpactReport`:

```ts
export type CrossRepoImpact = {
  workspace: string;
  provider: {
    serviceName: string;
    repoPath?: string;
    contractPath: string;
  };
  consumer: {
    serviceName: string;
    repoPath?: string;
    path: string;
  };
  change: {
    kind: string;
    method?: string;
    path?: string;
    previousEndpointId?: string;
  };
  confidence: Confidence;
  evidence: {
    filePath: string;
    snippet: string;
  };
  resources?: {
    workspace?: string;
    crossRepoLinks?: string;
  };
};
```

Then add the optional field inside `ImpactReport` after `evidence`:

```ts
  crossRepoImpacts?: CrossRepoImpact[];
```

In `src/index.ts`, add `CrossRepoImpact` to the exported type list near `AffectedFile` and `ContextBudget`.

- [ ] **Step 2: Create shared workspace resource helpers**

Create `src/workspace_resources.ts` with exactly this implementation:

```ts
export type WorkspaceResourceUris = {
  workspace: string;
  contracts: string;
  crossRepoLinks: string;
};

export function workspaceResourceUri(workspaceName: string): string {
  return `parallax://workspaces/${encodeURIComponent(workspaceName)}`;
}

export function workspaceContractsResourceUri(workspaceName: string): string {
  return `${workspaceResourceUri(workspaceName)}/contracts`;
}

export function workspaceCrossRepoLinksResourceUri(workspaceName: string): string {
  return `${workspaceResourceUri(workspaceName)}/cross-repo-links`;
}

export function workspaceResources(workspaceName: string): WorkspaceResourceUris {
  return {
    workspace: workspaceResourceUri(workspaceName),
    contracts: workspaceContractsResourceUri(workspaceName),
    crossRepoLinks: workspaceCrossRepoLinksResourceUri(workspaceName)
  };
}
```

- [ ] **Step 3: Replace duplicated workspace URI helpers**

In `src/mcp_resources.ts`, add:

```ts
import {
  workspaceContractsResourceUri,
  workspaceCrossRepoLinksResourceUri,
  workspaceResourceUri,
  workspaceResources
} from './workspace_resources.js';
```

Delete the local `workspaceResourceUri`, `workspaceContractsResourceUri`, `workspaceCrossRepoLinksResourceUri`, and `workspaceResources` functions from `src/mcp_resources.ts`.

In `src/ui/data.ts`, add:

```ts
import { workspaceResourceUri, workspaceResources } from '../workspace_resources.js';
```

Delete the local `workspaceResourceUri` and `workspaceResources` functions from `src/ui/data.ts`. Keep `entityResourceUri`, `parsedProvenance`, `routeLabelFromProvenance`, and `eventTopologyFromProvenance` local.

- [ ] **Step 4: Extend the zod report schema**

In `src/report_schema.ts`, change:

```ts
export const IMPACT_REPORT_SCHEMA_VERSION = '1.2.0';
```

to:

```ts
export const IMPACT_REPORT_SCHEMA_VERSION = '1.3.0';
```

Add this schema after `adapterRunInsightSchema`:

```ts
const crossRepoImpactSchema = z.object({
  workspace: z.string(),
  provider: z.object({
    serviceName: z.string(),
    repoPath: z.string().optional(),
    contractPath: z.string()
  }),
  consumer: z.object({
    serviceName: z.string(),
    repoPath: z.string().optional(),
    path: z.string()
  }),
  change: z.object({
    kind: z.string(),
    method: z.string().optional(),
    path: z.string().optional(),
    previousEndpointId: z.string().optional()
  }),
  confidence: confidenceSchema,
  evidence: z.object({
    filePath: z.string(),
    snippet: z.string()
  }),
  resources: z.object({
    workspace: z.string().optional(),
    crossRepoLinks: z.string().optional()
  }).optional()
});
```

Add this optional field to `impactReportSchema` after `evidence`:

```ts
  crossRepoImpacts: z.array(crossRepoImpactSchema).optional(),
```

- [ ] **Step 5: Add a schema regression fixture**

In `tests/report-schema.test.ts`, add a test after the real-payload validation test:

```ts
test('the zod schema accepts optional cross-repo impact payloads', () => {
  const report: ImpactReport = {
    id: 'cross-repo-report',
    indexRunId: 1,
    changedFiles: ['contracts/openapi.yaml'],
    affectedFiles: [{
      path: 'web:src/client.ts',
      reason: 'breaks cross-repo consumer web via contracts/openapi.yaml',
      confidence: 'heuristic',
      depth: 1,
      relationPath: ['web:src/client.ts BREAKS_COMPATIBILITY_WITH users-api:contracts/openapi.yaml']
    }],
    changed: [{
      id: 'file:contracts/openapi.yaml',
      kind: 'file',
      path: 'contracts/openapi.yaml',
      displayName: 'contracts/openapi.yaml'
    }],
    affected: [{
      target: {
        id: 'external:cross-repo:web:src/client.ts',
        kind: 'external_entity',
        path: 'web:src/client.ts',
        displayName: 'web:src/client.ts'
      },
      relations: ['web:src/client.ts BREAKS_COMPATIBILITY_WITH users-api:contracts/openapi.yaml'],
      confidence: 'heuristic'
    }],
    actions: [],
    testCommands: [],
    evidence: [{
      id: 'cross-repo:fixture',
      file: 'web:src/client.ts',
      kind: 'BREAKS_COMPATIBILITY_WITH',
      snippet: 'return fetch("https://users.example.test/api/users");',
      confidence: 'heuristic',
      subject: {
        id: 'external:cross-repo:web:src/client.ts',
        kind: 'external_entity',
        path: 'web:src/client.ts',
        displayName: 'web:src/client.ts'
      },
      target: {
        id: 'contract:openapi:users-api:contracts/openapi.yaml',
        kind: 'contract',
        path: 'contracts/openapi.yaml',
        displayName: 'users-api:contracts/openapi.yaml'
      },
      relationKind: 'BREAKS_COMPATIBILITY_WITH',
      relationConfidence: 'heuristic',
      extractorId: 'cross-repo-contract-impact'
    }],
    crossRepoImpacts: [{
      workspace: 'platform',
      provider: {
        serviceName: 'users-api',
        contractPath: 'contracts/openapi.yaml'
      },
      consumer: {
        serviceName: 'web',
        path: 'src/client.ts'
      },
      change: {
        kind: 'removed_endpoint',
        method: 'GET',
        path: '/api/users',
        previousEndpointId: 'endpoint:yaml:GET /api/users'
      },
      confidence: 'heuristic',
      evidence: {
        filePath: 'src/client.ts',
        snippet: 'return fetch("https://users.example.test/api/users");'
      },
      resources: {
        workspace: 'parallax://workspaces/platform',
        crossRepoLinks: 'parallax://workspaces/platform/cross-repo-links'
      }
    }]
  };

  const emitted = JSON.parse(JSON.stringify(report)) as unknown;
  const parsed = impactReportSchema.safeParse(emitted);
  assert.ok(parsed.success, `expected cross-repo report to validate; got ${JSON.stringify(parsed.error?.issues)}`);
});
```

- [ ] **Step 6: Regenerate and verify schema artifacts**

Run:

```bash
npm run schemas:build
node --import tsx --test tests/report-schema.test.ts
npm run schemas:check
npm run check
```

Expected: all commands pass, and `schemas/impact-report.schema.json` changes only because version `1.3.0` and `crossRepoImpacts` were added.

- [ ] **Step 7: Commit Task 1**

Run:

```bash
git add src/workspace_resources.ts src/types.ts src/index.ts src/report_schema.ts schemas/impact-report.schema.json src/mcp_resources.ts src/ui/data.ts tests/report-schema.test.ts
git commit -m "feat(report): add cross-repo impact schema"
```

### Task 2: Analyzer Cross-Repo Lane

**Files:**
- Create: `src/cross_repo_impact.ts`
- Modify: `src/analyzer.ts`
- Modify: `tests/contract-diff.test.ts`

**Interfaces:**
- Consumes: Task 1 `CrossRepoImpact`, `workspaceResources`, existing workspace tables, existing `BREAKS_COMPATIBILITY_WITH` provenance shape.
- Produces: `loadCrossRepoImpactsForChangedContract(options): CrossRepoImpactLoadResult`, analyzer report entries, malformed-link warnings.

- [ ] **Step 1: Extend contract-diff test imports**

In `tests/contract-diff.test.ts`, change the import from `../src/index.js` to include `analyzeDiff` and `exportImpactGraph`:

```ts
import {
  addWorkspaceRepo,
  analyzeContractDiff,
  analyzeDiff,
  exportImpactGraph,
  indexProject,
  initProject,
  initWorkspace,
  resolveCrossRepoContracts
} from '../src/index.js';
```

- [ ] **Step 2: Add a provider-owned workspace fixture**

Add this helper after `setupWorkspaceWithResolvedContract`:

```ts
async function setupProviderOwnedWorkspaceWithBreakingOpenApiLink(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-primary-impact-consumer-');
  const providerRoot = await makeRepo('parallax-primary-impact-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiContract(providerRoot, ['/api/users', '/api/status']);

  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });

  initWorkspace({ repoRoot: providerRoot, name: 'platform', serviceName: 'users-api' });
  addWorkspaceRepo({
    repoRoot: providerRoot,
    workspaceName: 'platform',
    localPath: consumerRoot,
    serviceName: 'web'
  });
  const resolved = resolveCrossRepoContracts({ repoRoot: providerRoot, workspaceName: 'platform' });
  assert.equal(resolved.links.length, 1);

  await writeOpenApiContract(providerRoot, ['/api/status']);
  const diff = analyzeContractDiff({
    repoRoot: providerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });
  assert.equal(diff.summary.classification, 'breaking');
  assert.equal(diff.summary.impactedConsumerCount, 1);

  return { consumerRoot, providerRoot };
}
```

- [ ] **Step 3: Write the failing primary-impact analyzer test**

Add this test near the existing `BREAKS_COMPATIBILITY_WITH` persistence tests:

```ts
test('analyzeDiff surfaces persisted cross-repo breaking consumers for changed provider contracts', async () => {
  const { consumerRoot, providerRoot } = await setupProviderOwnedWorkspaceWithBreakingOpenApiLink();
  try {
    const report = await analyzeDiff({
      repoRoot: providerRoot,
      changedFiles: ['contracts/openapi.yaml'],
      writeReport: true
    });

    assert.equal(report.crossRepoImpacts?.length, 1);
    const impact = report.crossRepoImpacts?.[0];
    assert.equal(impact?.workspace, 'platform');
    assert.equal(impact?.provider.serviceName, 'users-api');
    assert.equal(impact?.provider.contractPath, 'contracts/openapi.yaml');
    assert.equal(impact?.provider.repoPath, undefined);
    assert.equal(impact?.consumer.serviceName, 'web');
    assert.equal(impact?.consumer.path, 'src/client.ts');
    assert.equal(impact?.consumer.repoPath, undefined);
    assert.deepEqual(impact?.change, {
      kind: 'removed_endpoint',
      method: 'GET',
      path: '/api/users',
      previousEndpointId: 'endpoint:yaml:GET /api/users'
    });
    assert.equal(impact?.resources?.workspace, 'parallax://workspaces/platform');
    assert.equal(impact?.resources?.crossRepoLinks, 'parallax://workspaces/platform/cross-repo-links');

    const affected = report.affectedFiles.find((item) => item.path === 'web:src/client.ts');
    assert.ok(affected);
    assert.equal(affected.reason, 'breaks cross-repo consumer web via contracts/openapi.yaml');
    assert.equal(affected.confidence, 'heuristic');
    assert.equal(affected.depth, 1);
    assert.deepEqual(affected.relationPath, [
      'web:src/client.ts BREAKS_COMPATIBILITY_WITH users-api:contracts/openapi.yaml'
    ]);

    const target = report.affected.find((item) => item.target.path === 'web:src/client.ts');
    assert.equal(target?.target.kind, 'external_entity');
    assert.equal(target?.confidence, 'heuristic');

    const evidence = report.evidence.find((item) => item.extractorId === 'cross-repo-contract-impact');
    assert.ok(evidence);
    assert.equal(evidence.file, 'web:src/client.ts');
    assert.equal(evidence.kind, 'BREAKS_COMPATIBILITY_WITH');
    assert.equal(evidence.confidence, 'heuristic');
    assert.equal(evidence.relationKind, 'BREAKS_COMPATIBILITY_WITH');
    assert.equal(evidence.relationConfidence, 'heuristic');
    assert.equal(evidence.subject?.kind, 'external_entity');
    assert.equal(evidence.subject?.path, 'web:src/client.ts');
    assert.equal(evidence.target?.kind, 'contract');
    assert.equal(evidence.target?.path, 'contracts/openapi.yaml');
    assert.match(evidence.snippet, /users\.example\.test\/api\/users/);

    const graph = await exportImpactGraph({ repoRoot: providerRoot, reportId: report.id, format: 'json' });
    const parsed = JSON.parse(graph.rendered) as {
      edges: Array<{ source: string; target: string; kind: string; confidence: string }>;
    };
    assert.ok(parsed.edges.some((edge) =>
      edge.kind === 'BREAKS_COMPATIBILITY_WITH'
      && edge.confidence === 'heuristic'
      && edge.source.includes('cross-repo')
      && edge.target.includes('openapi')
    ));
  } finally {
    await unlink(path.join(consumerRoot, '.parallax', 'workspace.json')).catch(() => undefined);
  }
});
```

Run:

```bash
node --import tsx --test tests/contract-diff.test.ts --test-name-pattern "analyzeDiff surfaces persisted cross-repo"
```

Expected before implementation: FAIL because `report.crossRepoImpacts` is `undefined`.

- [ ] **Step 4: Add malformed and non-contract regression tests**

Add these tests after the primary-impact test:

```ts
test('analyzeDiff skips malformed cross-repo breaking provenance with one warning', async () => {
  const { providerRoot } = await setupProviderOwnedWorkspaceWithBreakingOpenApiLink();
  const db = new DatabaseSync(databasePath(providerRoot));
  try {
    db.prepare("UPDATE cross_repo_links SET provenance = '{not-json' WHERE kind = 'BREAKS_COMPATIBILITY_WITH'").run();
  } finally {
    db.close();
  }

  const report = await analyzeDiff({
    repoRoot: providerRoot,
    changedFiles: ['contracts/openapi.yaml']
  });

  assert.equal(report.crossRepoImpacts, undefined);
  assert.deepEqual(
    report.warnings?.filter((warning) => warning.includes('malformed BREAKS_COMPATIBILITY_WITH')),
    ['cross-repo impact: skipped 1 malformed BREAKS_COMPATIBILITY_WITH link']
  );
});

test('analyzeDiff leaves non-contract changed files on the existing local path', async () => {
  const { providerRoot } = await setupProviderOwnedWorkspaceWithBreakingOpenApiLink();
  const report = await analyzeDiff({
    repoRoot: providerRoot,
    changedFiles: ['README.md']
  });

  assert.equal(report.crossRepoImpacts, undefined);
  assert.ok(report.affectedFiles.every((item) => !item.path.startsWith('web:')));
  assert.ok((report.warnings ?? []).every((warning) => !warning.includes('cross-repo impact')));
});
```

Run:

```bash
node --import tsx --test tests/contract-diff.test.ts --test-name-pattern "malformed cross-repo|non-contract changed"
```

Expected before implementation: malformed test fails because no warning exists; non-contract test should pass and guards against accidental broad reads.

- [ ] **Step 5: Implement `src/cross_repo_impact.ts`**

Create `src/cross_repo_impact.ts` with this exported surface:

```ts
export type CrossRepoImpactCandidate = {
  impact: CrossRepoImpact;
  affectedFile: AffectedFile;
  affectedTarget: ImpactTarget;
  evidence: Evidence;
};

export type CrossRepoImpactLoadOptions = {
  db: ReturnType<typeof openDatabase>;
  repoRoot: string;
  repoId: number;
  indexRunId: number;
  changedFile: string;
};

export type CrossRepoImpactLoadResult = {
  candidates: CrossRepoImpactCandidate[];
  malformedLinkCount: number;
};

export function loadCrossRepoImpactsForChangedContract(
  options: CrossRepoImpactLoadOptions
): CrossRepoImpactLoadResult;
```

The implementation must:

- check `contracts`, `contract_versions`, and `cross_repo_links` tables exist before querying;
- read a contract row where `contracts.repo_id = repoId`, `contracts.path = changedFile`, and `contract_versions.index_run_id = indexRunId`;
- read `cross_repo_links.kind = 'BREAKS_COMPATIBILITY_WITH'` rows where `target_repo_id = repoId`;
- parse provenance with `parseJsonObject`;
- require provider `contractPath`, consumer path, evidence snippet, and change kind;
- compare provider `repoPath` to `repoRoot` when provenance includes a repo path;
- omit absolute `repoPath` values from the returned public `CrossRepoImpact`;
- create display path `${consumerServiceName}:${consumerPath}`;
- create `external_entity` subject and `contract` target;
- emit evidence with `relationKind: 'BREAKS_COMPATIBILITY_WITH'`, `relationConfidence`, and `extractorId: 'cross-repo-contract-impact'`;
- sort and dedupe candidates by display path, relation kind, and provider contract target.

- [ ] **Step 6: Integrate the lane into `analyzeDiff`**

In `src/analyzer.ts`, add:

```ts
import { loadCrossRepoImpactsForChangedContract } from './cross_repo_impact.js';
```

Create `const crossRepoImpacts: CrossRepoImpact[] = [];` beside the existing `evidence` and `warnings` arrays. Import `CrossRepoImpact` as a type from `./types.js`.

Inside the `for (const changedFile of changedFiles)` loop, after local graph rows have been merged and before the changed-file evidence is pushed, add:

```ts
    const crossRepo = loadCrossRepoImpactsForChangedContract({
      db,
      repoRoot,
      repoId,
      indexRunId,
      changedFile
    });
    for (const candidate of crossRepo.candidates) {
      const current = affected.get(candidate.affectedFile.path);
      const next = {
        path: candidate.affectedFile.path,
        reason: candidate.affectedFile.reason,
        confidence: candidate.affectedFile.confidence,
        target: candidate.affectedTarget.target,
        depth: candidate.affectedFile.depth ?? 1,
        relationPath: candidate.affectedFile.relationPath ?? candidate.affectedTarget.relations
      };
      if (!current || isBetterImpact(next, current)) {
        affected.set(candidate.affectedFile.path, next);
      }
      evidence.push(candidate.evidence);
      crossRepoImpacts.push(candidate.impact);
    }
    if (crossRepo.malformedLinkCount > 0) {
      warnings.push(
        `cross-repo impact: skipped ${crossRepo.malformedLinkCount} malformed BREAKS_COMPATIBILITY_WITH link`
        + `${crossRepo.malformedLinkCount === 1 ? '' : 's'}`
      );
    }
```

Add the report field near `evidence`:

```ts
    ...(crossRepoImpacts.length > 0 ? { crossRepoImpacts } : {}),
```

- [ ] **Step 7: Run focused analyzer and graph tests**

Run:

```bash
node --import tsx --test tests/contract-diff.test.ts --test-name-pattern "analyzeDiff surfaces persisted cross-repo|malformed cross-repo|non-contract changed"
npm run check
```

Expected: all focused tests pass and TypeScript accepts the new module.

- [ ] **Step 8: Commit Task 2**

Run:

```bash
git add src/cross_repo_impact.ts src/analyzer.ts tests/contract-diff.test.ts
git commit -m "feat(analyze): surface cross-repo contract impact"
```

### Task 3: UI Preview, Lane Label, And External Evidence Links

**Files:**
- Modify: `src/ui.ts`
- Modify: `src/ui/data.ts`
- Modify: `src/ui/shared.ts`
- Modify: `src/ui/panels.ts`
- Modify: `src/ui/client.ts`
- Test: `tests/ui.test.ts`

**Interfaces:**
- Consumes: Task 2 report JSON with `crossRepoImpacts` and `cross-repo-contract-impact` evidence.
- Produces: UI bootstrap/report previews that include cross-repo impact data, a cross-repo lane, and no local source links for external consumer files.

- [ ] **Step 1: Add UI preview fields**

In `src/ui.ts`, add `crossRepoImpacts` to `UiReportPreview`:

```ts
  crossRepoImpacts: NonNullable<ImpactReport['crossRepoImpacts']>;
```

In `src/ui/data.ts`, add it in `reportPreviewFromRow`:

```ts
    crossRepoImpacts: report.crossRepoImpacts ?? [],
```

- [ ] **Step 2: Add shared cross-repo UI classifiers**

In `src/ui/shared.ts`, add these functions after `impactEvidenceMatchesPath`:

```ts
export function isCrossRepoEvidence(item: UiEvidencePreview): boolean {
  return item.extractorId === 'cross-repo-contract-impact';
}

export function isCrossRepoImpactPath(item: UiReportPreview['affectedFiles'][number]): boolean {
  return /\bcross-repo\b/i.test(item.reason)
    || item.relationPath?.some((part) => part.includes('BREAKS_COMPATIBILITY_WITH')) === true;
}
```

Modify `evidenceSourceLocation` so the first line is:

```ts
  if (isCrossRepoEvidence(item)) return undefined;
```

Modify `classifyImpactLane` so the first rule is:

```ts
  if (/\bcross-repo\b/i.test(reasonLower) || reasonLower.includes('breaks_compatibility_with')) return 'crossRepo';
```

- [ ] **Step 3: Add the cross-repo lane to server-rendered panels**

In `src/ui.ts`, change:

```ts
export type ImpactLaneId = 'code' | 'tests' | 'knowledge' | 'contracts' | 'config';
```

to:

```ts
export type ImpactLaneId = 'code' | 'tests' | 'knowledge' | 'contracts' | 'config' | 'crossRepo';
```

Add `crossRepoLane` and `noCrossRepoImpact` to `UiMessageKey` next to `contractsLane` and `noApiContractAffected`. Add translations:

```ts
crossRepoLane: 'Cross-repo consumers'
noCrossRepoImpact: 'No cross-repo consumer impact'
```

```ts
crossRepoLane: '교차 저장소 소비자'
noCrossRepoImpact: '교차 저장소 소비자 영향 없음'
```

```ts
crossRepoLane: '跨仓库消费者'
noCrossRepoImpact: '无跨仓库消费者影响'
```

In `src/ui/panels.ts`, add the lane before `contracts`:

```ts
    { id: 'crossRepo', label: m?.crossRepoLane ?? 'Cross-repo consumers', count: 0, summary: m?.noCrossRepoImpact ?? 'No cross-repo consumer impact', tone: 'red' },
```

In `renderImpactPathRow`, import `isCrossRepoImpactPath` from `./shared.js` and replace the inline source link with:

```ts
  const sourceLink = isCrossRepoImpactPath(item)
    ? ''
    : `<a class="source-link" href="${escapeHtml(sourceHref(item.path, 1, sourceContext))}" target="_blank" rel="noreferrer">${escapeHtml(m.source)}</a>`;
```

Then render `${sourceLink}` where the source anchor currently appears.

- [ ] **Step 4: Update client-side inspector behavior**

In `src/ui/client.ts`, add these helpers inside `UI_CLIENT_JS` after `evidenceSourceLabel`:

```js
    function isCrossRepoEvidence(evidence) {
      return evidence?.extractorId === 'cross-repo-contract-impact';
    }
    function evidenceHasLocalSource(evidence) {
      return !isCrossRepoEvidence(evidence) && typeof evidence?.file === 'string' && !evidence.file.includes('\\0');
    }
```

In `renderInspectorEvidence`, create the source link only when `evidenceHasLocalSource(item)` is true. When false, append only `file`, `meta`, and `snippet`.

In `laneLabelForImpact`, add this first rule after `reasonLower` is computed:

```js
      if (/\\bcross-repo\\b/i.test(reasonLower) || reasonLower.includes('breaks_compatibility_with')) {
        return uiMessage('crossRepoLane', 'Cross-repo consumers');
      }
```

- [ ] **Step 5: Seed a UI report regression**

In `tests/ui.test.ts`, add a focused report-seeding test that:

- starts from `makeUiRepo()`;
- inserts a saved report containing one `crossRepoImpacts` entry, one `web:src/client.ts` affected file, and one `cross-repo-contract-impact` evidence item;
- calls `buildUiSnapshot({ repoRoot, reportId: crossRepoReportId })`;
- asserts `snapshot.selectedReport?.crossRepoImpacts.length === 1`;
- asserts `renderUiHtml(snapshot)` contains `Cross-repo consumers`, `web:src/client.ts`, and `parallax://workspaces/platform/cross-repo-links`;
- asserts the HTML does not contain `/source?path=web%3Asrc%2Fclient.ts`;
- asserts Korean and Chinese renders contain `교차 저장소 소비자` and `跨仓库消费者`.

- [ ] **Step 6: Run UI focused tests**

Run:

```bash
node --import tsx --test tests/ui.test.ts --test-name-pattern "cross-repo consumer impacts|list-first report workbench"
```

Expected: both focused UI tests pass.

- [ ] **Step 7: Commit Task 3**

Run:

```bash
git add src/ui.ts src/ui/data.ts src/ui/shared.ts src/ui/panels.ts src/ui/client.ts tests/ui.test.ts
git commit -m "feat(ui): show cross-repo consumer impact"
```

### Task 4: Public Docs, Verification, Review, Push

**Files:**
- Modify: `docs/cli-reference.md`
- Modify: `docs/cli-reference.ko.md`
- Modify: `docs/cli-reference.zh.md`
- Modify: `docs/mcp.md`
- Modify: `docs/mcp.ko.md`
- Modify: `docs/mcp.zh.md`
- Modify: `docs/report-schema.md`
- Modify: `docs/report-schema.ko.md`
- Modify: `docs/report-schema.zh.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/roadmap.ko.md`
- Modify: `docs/roadmap.zh.md`
- Modify: `IMPROVEMENT_OPPORTUNITIES.md`

**Interfaces:**
- Consumes: Implemented W1 behavior from Tasks 1-3.
- Produces: Shipped public documentation and a verified pushed `main`.

- [ ] **Step 1: Update CLI docs**

In `docs/cli-reference.md`, add to the `analyze` section:

```markdown
When the changed file is an indexed provider contract and the workspace already contains persisted `BREAKS_COMPATIBILITY_WITH` links, `analyze` also includes `crossRepoImpacts`. These entries identify the consumer service, consumer file, provider contract, breaking change, confidence, evidence snippet, and workspace resource URIs. `analyze` does not run contract diff automatically; refresh links first with `parallax workspace contract-diff` when the workspace is stale.
```

Add meaning-equivalent Korean and Chinese text in `docs/cli-reference.ko.md` and `docs/cli-reference.zh.md`.

- [ ] **Step 2: Update MCP docs**

In `docs/mcp.md`, add to `parallax_analyze_diff`:

```markdown
`parallax_analyze_diff` returns the same `crossRepoImpacts` section as `parallax analyze` when matching workspace breaking links already exist. The MCP tool remains read-only with respect to workspace resolution; it surfaces persisted evidence and does not create new cross-repo links.
```

Add meaning-equivalent Korean and Chinese text in `docs/mcp.ko.md` and `docs/mcp.zh.md`.

- [ ] **Step 3: Update report schema docs**

In `docs/report-schema.md`, change the documented current version to `1.3.0` and add:

```markdown
### `crossRepoImpacts`

Optional. Present when a changed provider contract matches persisted workspace `BREAKS_COMPATIBILITY_WITH` links. Each item includes `workspace`, `provider.serviceName`, `provider.contractPath`, `consumer.serviceName`, `consumer.path`, `change`, `confidence`, `evidence`, and `resources`. Absolute local repo paths are omitted from public report JSON.
```

Add meaning-equivalent Korean and Chinese text in `docs/report-schema.ko.md` and `docs/report-schema.zh.md`.

- [ ] **Step 4: Mark W1 shipped**

In all `docs/roadmap*.md`, mark W1 cross-repo primary impact as shipped with this behavior:

```markdown
- [x] Surface persisted cross-repo breaking contract links in primary analyze reports, graph exports, MCP payloads, and the UI workbench
```

In `IMPROVEMENT_OPPORTUNITIES.md`, move W1 from planned/open to shipped and mention:

```markdown
W1 shipped: primary `analyzeDiff` reports now include persisted workspace `BREAKS_COMPATIBILITY_WITH` consumers as `crossRepoImpacts`, affected external entities, relation-bearing evidence, graph edges, and UI cross-repo lane entries.
```

Translate roadmap entries meaningfully in Korean and Chinese.

- [ ] **Step 5: Run focused verification**

Run:

```bash
npm run schemas:build
npm run schemas:check
npm run docs:lint
node --import tsx --test tests/report-schema.test.ts
node --import tsx --test tests/contract-diff.test.ts --test-name-pattern "analyzeDiff surfaces persisted cross-repo|malformed cross-repo|non-contract changed"
node --import tsx --test tests/ui.test.ts --test-name-pattern "cross-repo consumer impacts|list-first report workbench"
git diff --check
```

Expected: all commands pass.

- [ ] **Step 6: Run full verification**

Run:

```bash
npm run lint
npm test
npm run test:mcp
npm run test:ui
npm run verify
```

Expected: all commands pass. Record test counts, bench score, and audit result in `.superpowers/sdd/progress.md` and `.superpowers/sdd/CLAUDE_HANDOFF.md`.

- [ ] **Step 7: Commit docs**

Run:

```bash
git add docs/cli-reference.md docs/cli-reference.ko.md docs/cli-reference.zh.md docs/mcp.md docs/mcp.ko.md docs/mcp.zh.md docs/report-schema.md docs/report-schema.ko.md docs/report-schema.zh.md docs/roadmap.md docs/roadmap.ko.md docs/roadmap.zh.md IMPROVEMENT_OPPORTUNITIES.md
git commit -m "docs: document cross-repo primary impact"
```

- [ ] **Step 8: Final review and push**

Create the final review package from the branch base to `HEAD`, run a read-only review, fix Critical/Important findings, rerun the covering tests, and push:

```bash
git log --oneline --decorate -8
git status --short --branch
git push origin main
```

## Self-Review

- Spec coverage: The plan covers report shape, privacy, matching rules, malformed provenance, graph evidence, UI lane/source behavior, MCP/CLI docs, schema bump, and final verification from the approved W1 design.
- Placeholder scan: No `TBD`, `TODO`, vague edge-case instruction, or undefined function remains in task steps. New exported function names and report fields are defined before use.
- Type consistency: `CrossRepoImpact`, `CrossRepoImpactCandidate`, `loadCrossRepoImpactsForChangedContract`, `workspaceResources`, and `crossRepoImpacts` names are consistent across schema, analyzer, UI, tests, and docs tasks.
