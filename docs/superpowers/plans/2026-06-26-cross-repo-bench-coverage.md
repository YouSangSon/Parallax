# Cross-Repo Bench Coverage Implementation Plan

**English** · [한국어](2026-06-26-cross-repo-bench-coverage.ko.md) · [中文](2026-06-26-cross-repo-bench-coverage.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic `npm run bench` lane that proves W1 cross-repo contract breaks still surface in the primary `analyzeDiff` report and report-scoped graph export.

**Architecture:** Extend the existing `ImpactBenchReport` with a required `crossRepoContracts` section while leaving the existing weighted `summary.score` unchanged. Build the lane through production APIs: create a two-repo workspace fixture, resolve contract consumers, persist a breaking link through `analyzeContractDiff`, then score `analyzeDiff` and `exportImpactGraph`.

**Tech Stack:** TypeScript, Node.js `node:test`, SQLite via `node:sqlite`, existing Parallax workspace/contract-diff/analyzer APIs, Markdown docs.

## Global Constraints

- `summary.score` stays on the existing weighted deterministic relation/retrieval score.
- `crossRepoContracts.summary.passed` gates top-level `summary.passed`; do not reweight `summary.score`.
- Bench output must not include absolute temp paths, local repo roots, wall-clock timing, random IDs, or machine-specific data.
- The cross-repo fixture must use production APIs: `initProject`, `indexProject`, `initWorkspace`, `addWorkspaceRepo`, `resolveCrossRepoContracts`, `analyzeContractDiff`, `analyzeDiff`, and `exportImpactGraph`.
- The lane must remain deterministic and must not use network access.
- W2 cross-repo link reconciliation, W6 MCP tools, S4 perf/RSS work, and other D2 lanes are out of scope.
- Keep English, Korean, and Chinese docs meaning-equivalent when touching translated pages.
- Final acceptance requires `npm run bench`, focused bench/report tests, `npm run lint`, and `npm run verify`.

---

## File Structure

- Modify `bench/impact-bench.ts`: add `CrossRepoContractBench`, create the two-repo fixture, score W1 report/graph behavior, and include the new section in the saved JSON report.
- Modify `tests/impact-bench.test.ts`: assert schema version, cross-repo lane shape, pass gate, matched consumer path, evidence kind, graph edge count, and path safety.
- Modify `bench/impact-bench-report.ts`: validate the new section and render it in the Markdown summary.
- Modify `tests/impact-bench-report.test.ts`: add cross-repo section fixtures, failed-lane rendering, and baseline delta assertions.
- Modify `docs/verification.md`, `docs/verification.ko.md`, and `docs/verification.zh.md`: document the deterministic cross-repo lane.
- Modify `IMPROVEMENT_OPPORTUNITIES.md`: mark the W1-focused D2 bench coverage as shipped while leaving other D2 metrics open.
- Modify `docs/roadmap.md`, `docs/roadmap.ko.md`, and `docs/roadmap.zh.md`: mention cross-repo primary impact is bench-guarded.

### Task 1: Cross-Repo Bench JSON Lane

**Files:**
- Modify: `bench/impact-bench.ts`
- Modify: `tests/impact-bench.test.ts`

**Interfaces:**
- Consumes: existing production exports from `src/index.ts`.
- Produces: `ImpactBenchReport.crossRepoContracts: CrossRepoContractBench`.

- [ ] **Step 1: Write the failing bench report shape test**

In `tests/impact-bench.test.ts`, extend the existing `ImpactBench runner writes deterministic report shape` test after the semantic model assertions:

```ts
    assert.equal(report.schemaVersion, 4);
    assert.equal(report.crossRepoContracts.fixtureId, 'cross-repo-contract-impact-v0');
    assert.equal(report.crossRepoContracts.summary.passed, true);
    assert.equal(report.crossRepoContracts.summary.score, 1);
    assert.equal(report.crossRepoContracts.summary.expectedImpacts, 1);
    assert.equal(report.crossRepoContracts.summary.matchedImpacts, 1);
    assert.equal(report.crossRepoContracts.summary.expectedGraphEdges, 1);
    assert.equal(report.crossRepoContracts.summary.matchedGraphEdges, 1);
    assert.deepEqual(report.crossRepoContracts.expectedConsumerPaths, ['web:src/client.ts']);
    assert.deepEqual(report.crossRepoContracts.matchedConsumerPaths, ['web:src/client.ts']);
    assert.deepEqual(report.crossRepoContracts.missingConsumerPaths, []);
    assert.deepEqual(report.crossRepoContracts.expectedEvidenceKinds, ['BREAKS_COMPATIBILITY_WITH']);
    assert.deepEqual(report.crossRepoContracts.matchedEvidenceKinds, ['BREAKS_COMPATIBILITY_WITH']);
    assert.deepEqual(report.crossRepoContracts.graphEdges, { expected: 1, matched: 1 });
```

Also change the existing schema assertion from:

```ts
    assert.equal(report.schemaVersion, 3);
```

to:

```ts
    assert.equal(report.schemaVersion, 4);
```

Add this path-safety assertion next to the existing `impact-bench-fixture-` assertion:

```ts
    assert.equal(serializedReport.includes('impact-bench-cross-repo-'), false);
```

- [ ] **Step 2: Run the focused failing test**

Run:

```bash
node --import tsx --test tests/impact-bench.test.ts --test-name-pattern "deterministic report shape"
```

Expected: FAIL with a TypeScript or assertion error because `crossRepoContracts` does not exist and `schemaVersion` is still `3`.

- [ ] **Step 3: Add imports and report types**

In `bench/impact-bench.ts`, replace the existing source API import:

```ts
import { analyzeDiff, indexProject, initProject } from '../src/index.js';
```

with:

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

Change:

```ts
const schemaVersion = 3;
```

to:

```ts
const schemaVersion = 4;
const crossRepoContractFixtureId = 'cross-repo-contract-impact-v0';
```

Change the report type header from:

```ts
export type ImpactBenchReport = {
  schemaVersion: 2 | 3;
```

to:

```ts
export type ImpactBenchReport = {
  schemaVersion: 2 | 3 | 4;
```

Add this property before `retrieval`:

```ts
  crossRepoContracts: CrossRepoContractBench;
```

Add this type after `SearchContextBenchResult`:

```ts
type CrossRepoContractBench = {
  fixtureId: typeof crossRepoContractFixtureId;
  summary: {
    passed: boolean;
    score: number;
    expectedImpacts: number;
    matchedImpacts: number;
    expectedGraphEdges: number;
    matchedGraphEdges: number;
  };
  expectedConsumerPaths: string[];
  matchedConsumerPaths: string[];
  missingConsumerPaths: string[];
  expectedEvidenceKinds: string[];
  matchedEvidenceKinds: string[];
  graphEdges: {
    expected: number;
    matched: number;
  };
};
```

- [ ] **Step 4: Add fixture writers**

In `bench/impact-bench.ts`, add these helpers immediately before `runRetrievalBench`:

```ts
async function writeCrossRepoBenchConsumer(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'src/client.ts'),
    [
      'export async function loadUsers() {',
      '  return fetch("https://users.example.test/api/users");',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );
}

async function writeCrossRepoBenchOpenApiContract(repoRoot: string, routes: string[]): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  const routeLines = routes.flatMap((route) => [
    `  ${route}:`,
    '    get:',
    `      operationId: ${route.replace(/[^a-z0-9]/gi, '') || 'root'}`,
    '      responses:',
    "        '200':",
    '          description: ok'
  ]);
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'info:',
      '  title: Users API',
      '  version: 1.0.0',
      'paths:',
      ...routeLines,
      ''
    ].join('\n'),
    'utf8'
  );
}
```

- [ ] **Step 5: Add the cross-repo bench runner**

In `bench/impact-bench.ts`, add this helper after the fixture writers:

```ts
async function runCrossRepoContractBench(): Promise<CrossRepoContractBench> {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'impact-bench-cross-repo-'));
  try {
    const providerRoot = path.join(fixtureRoot, 'provider');
    const consumerRoot = path.join(fixtureRoot, 'consumer');
    await mkdir(providerRoot, { recursive: true });
    await mkdir(consumerRoot, { recursive: true });
    await writeFile(path.join(providerRoot, 'README.md'), 'provider\n', 'utf8');
    await writeFile(path.join(consumerRoot, 'README.md'), 'consumer\n', 'utf8');
    await writeCrossRepoBenchConsumer(consumerRoot);
    await writeCrossRepoBenchOpenApiContract(providerRoot, ['/api/users', '/api/status']);

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
    if (resolved.links.length !== 1) {
      throw new Error(`cross-repo bench expected 1 resolved link, got ${resolved.links.length}`);
    }

    await writeCrossRepoBenchOpenApiContract(providerRoot, ['/api/status']);
    analyzeContractDiff({
      repoRoot: providerRoot,
      workspaceName: 'platform',
      providerServiceName: 'users-api',
      contractPath: 'contracts/openapi.yaml'
    });

    const report = await analyzeDiff({
      repoRoot: providerRoot,
      changedFiles: ['contracts/openapi.yaml'],
      writeReport: true
    });
    const graph = await exportImpactGraph({ repoRoot: providerRoot, reportId: report.id, format: 'json' });
    const graphJson = JSON.parse(graph.rendered) as {
      edges: Array<{ source: string; target: string; kind: string; confidence: string }>;
    };

    const expectedConsumerPaths = ['web:src/client.ts'];
    const matchedConsumerPaths = expectedConsumerPaths.filter((consumerPath) =>
      report.crossRepoImpacts?.some((impact) =>
        impact.consumer.serviceName === 'web'
        && impact.consumer.path === 'src/client.ts'
        && impact.provider.serviceName === 'users-api'
        && impact.provider.contractPath === 'contracts/openapi.yaml'
      ) === true
      && report.affectedFiles.some((file) => file.path === consumerPath)
    );
    const expectedEvidenceKinds = ['BREAKS_COMPATIBILITY_WITH'];
    const matchedEvidenceKinds = expectedEvidenceKinds.filter((kind) =>
      report.evidence.some((evidence) =>
        evidence.extractorId === 'cross-repo-contract-impact'
        && evidence.kind === kind
        && evidence.relationKind === kind
        && evidence.subject?.path === 'web:src/client.ts'
        && evidence.target?.path === 'contracts/openapi.yaml'
      )
    );
    const matchedGraphEdges = graphJson.edges.filter((edge) =>
      edge.kind === 'BREAKS_COMPATIBILITY_WITH'
      && edge.confidence === 'heuristic'
      && edge.source.includes('cross-repo')
      && edge.target.includes('openapi')
    ).length;
    const expectedGraphEdges = 1;
    const score = ratio(
      matchedConsumerPaths.length + matchedEvidenceKinds.length + Math.min(matchedGraphEdges, expectedGraphEdges),
      expectedConsumerPaths.length + expectedEvidenceKinds.length + expectedGraphEdges
    );

    return {
      fixtureId: crossRepoContractFixtureId,
      summary: {
        passed: score === 1,
        score,
        expectedImpacts: expectedConsumerPaths.length,
        matchedImpacts: matchedConsumerPaths.length,
        expectedGraphEdges,
        matchedGraphEdges
      },
      expectedConsumerPaths,
      matchedConsumerPaths,
      missingConsumerPaths: expectedConsumerPaths.filter((path) => !matchedConsumerPaths.includes(path)),
      expectedEvidenceKinds,
      matchedEvidenceKinds,
      graphEdges: {
        expected: expectedGraphEdges,
        matched: matchedGraphEdges
      }
    };
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}
```

- [ ] **Step 6: Wire the lane into `runImpactBench`**

In `runImpactBench`, after:

```ts
    const retrieval = await runRetrievalBench(fixtureRoot);
```

add:

```ts
    const crossRepoContracts = await runCrossRepoContractBench();
```

In the `passed` expression, add this required gate:

```ts
      crossRepoContracts.summary.passed === true &&
```

Place it before `score >= 0.9`.

In the report object, add `crossRepoContracts` after `analyzeDiff`:

```ts
      crossRepoContracts,
```

- [ ] **Step 7: Run focused bench tests**

Run:

```bash
node --import tsx --test tests/impact-bench.test.ts --test-name-pattern "deterministic report shape"
```

Expected: PASS.

Run:

```bash
npm run bench
```

Expected: command exits 0 and `.parallax/bench/impact-bench-report.json` includes `"fixtureId": "cross-repo-contract-impact-v0"` under `crossRepoContracts`.

- [ ] **Step 8: Commit Task 1**

```bash
git add bench/impact-bench.ts tests/impact-bench.test.ts
git commit -m "feat(bench): track cross-repo contract impact"
```

### Task 2: Bench Markdown Summary And Validation

**Files:**
- Modify: `bench/impact-bench-report.ts`
- Modify: `tests/impact-bench-report.test.ts`

**Interfaces:**
- Consumes: `ImpactBenchReport.crossRepoContracts` from Task 1.
- Produces: Markdown summary rows and loader validation for `crossRepoContracts`.

- [ ] **Step 1: Write failing report-summary tests**

In `tests/impact-bench-report.test.ts`, change `makeReport()` default `schemaVersion` to `4` and add this property before `retrieval`:

```ts
    crossRepoContracts: {
      fixtureId: 'cross-repo-contract-impact-v0',
      summary: {
        passed: true,
        score: 1,
        expectedImpacts: 1,
        matchedImpacts: 1,
        expectedGraphEdges: 1,
        matchedGraphEdges: 1
      },
      expectedConsumerPaths: ['web:src/client.ts'],
      matchedConsumerPaths: ['web:src/client.ts'],
      missingConsumerPaths: [],
      expectedEvidenceKinds: ['BREAKS_COMPATIBILITY_WITH'],
      matchedEvidenceKinds: ['BREAKS_COMPATIBILITY_WITH'],
      graphEdges: {
        expected: 1,
        matched: 1
      }
    },
```

In `bench report summary renders current metrics without a baseline`, add:

```ts
  assert.match(markdown, /\| Cross-repo contract impact \| 1\.0000 \| n\/a \|/);
  assert.match(markdown, /\| Cross-repo impacts \| 1\/1 \| n\/a \|/);
  assert.match(markdown, /\| Cross-repo graph edges \| 1\/1 \| n\/a \|/);
  assert.match(markdown, /### Missing cross-repo consumers\n\nNone\./);
```

In `bench report summary renders metric and count deltas against a baseline`, add this baseline override:

```ts
    crossRepoContracts: {
      ...makeReport().crossRepoContracts,
      summary: {
        passed: false,
        score: 0,
        expectedImpacts: 1,
        matchedImpacts: 0,
        expectedGraphEdges: 1,
        matchedGraphEdges: 0
      },
      matchedConsumerPaths: [],
      missingConsumerPaths: ['web:src/client.ts'],
      matchedEvidenceKinds: [],
      graphEdges: {
        expected: 1,
        matched: 0
      }
    },
```

Then add assertions:

```ts
  assert.match(markdown, /\| Cross-repo contract impact \| 1\.0000 \| \+1\.0000 \|/);
  assert.match(markdown, /\| Cross-repo impacts \| 1\/1 \| \+1 \|/);
  assert.match(markdown, /\| Cross-repo graph edges \| 1\/1 \| \+1 \|/);
```

- [ ] **Step 2: Run the failing report tests**

Run:

```bash
node --import tsx --test tests/impact-bench-report.test.ts
```

Expected: FAIL because the formatter and validator do not read `crossRepoContracts`.

- [ ] **Step 3: Render the cross-repo section in Markdown**

In `bench/impact-bench-report.ts`, add these rows to `metricRows` after `Context-pack readiness`:

```ts
    metricRow(
      'Cross-repo contract impact',
      report.crossRepoContracts.summary.score,
      baseline?.crossRepoContracts?.summary.score
    ),
```

Add these coverage rows after `Matched affected files`:

```ts
    countRow(
      'Cross-repo impacts',
      `${report.crossRepoContracts.summary.matchedImpacts}/${report.crossRepoContracts.summary.expectedImpacts}`,
      report.crossRepoContracts.summary.matchedImpacts,
      baseline?.crossRepoContracts?.summary.matchedImpacts
    ),
    countRow(
      'Cross-repo graph edges',
      `${report.crossRepoContracts.summary.matchedGraphEdges}/${report.crossRepoContracts.summary.expectedGraphEdges}`,
      report.crossRepoContracts.summary.matchedGraphEdges,
      baseline?.crossRepoContracts?.summary.matchedGraphEdges
    ),
```

Add this list section before `Missing relations`:

```ts
    listSection('Missing cross-repo consumers', report.crossRepoContracts.missingConsumerPaths),
    '',
```

- [ ] **Step 4: Validate the new report shape**

In `assertBenchReport`, after `assertRecord(value.analyzeDiff, label, 'analyzeDiff');` and its string-array assertions, add:

```ts
  assertRecord(value.crossRepoContracts, label, 'crossRepoContracts');
  assertString(value.crossRepoContracts.fixtureId, label, 'crossRepoContracts.fixtureId');
  assertRecord(value.crossRepoContracts.summary, label, 'crossRepoContracts.summary');
  assertBoolean(value.crossRepoContracts.summary.passed, label, 'crossRepoContracts.summary.passed');
  for (const key of [
    'score',
    'expectedImpacts',
    'matchedImpacts',
    'expectedGraphEdges',
    'matchedGraphEdges'
  ]) {
    assertNumber(value.crossRepoContracts.summary[key], label, `crossRepoContracts.summary.${key}`);
  }
  assertStringArray(value.crossRepoContracts.expectedConsumerPaths, label, 'crossRepoContracts.expectedConsumerPaths');
  assertStringArray(value.crossRepoContracts.matchedConsumerPaths, label, 'crossRepoContracts.matchedConsumerPaths');
  assertStringArray(value.crossRepoContracts.missingConsumerPaths, label, 'crossRepoContracts.missingConsumerPaths');
  assertStringArray(value.crossRepoContracts.expectedEvidenceKinds, label, 'crossRepoContracts.expectedEvidenceKinds');
  assertStringArray(value.crossRepoContracts.matchedEvidenceKinds, label, 'crossRepoContracts.matchedEvidenceKinds');
  assertRecord(value.crossRepoContracts.graphEdges, label, 'crossRepoContracts.graphEdges');
  assertNumber(value.crossRepoContracts.graphEdges.expected, label, 'crossRepoContracts.graphEdges.expected');
  assertNumber(value.crossRepoContracts.graphEdges.matched, label, 'crossRepoContracts.graphEdges.matched');
```

- [ ] **Step 5: Preserve legacy baseline loading**

In `assertBenchReport`, wrap the new validation in this compatibility guard so existing schema v2/v3 baseline reports still load:

```ts
  if (value.schemaVersion >= 4 || value.crossRepoContracts !== undefined) {
    // crossRepoContracts validation block from Step 4
  }
```

When the guard is used, all references in `formatBenchSummaryMarkdown` must tolerate missing baseline cross-repo data through optional chaining as shown in Step 3.

- [ ] **Step 6: Run report tests**

Run:

```bash
node --import tsx --test tests/impact-bench-report.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add bench/impact-bench-report.ts tests/impact-bench-report.test.ts
git commit -m "feat(bench): report cross-repo contract coverage"
```

### Task 3: Documentation And Final Verification

**Files:**
- Modify: `docs/verification.md`
- Modify: `docs/verification.ko.md`
- Modify: `docs/verification.zh.md`
- Modify: `IMPROVEMENT_OPPORTUNITIES.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/roadmap.ko.md`
- Modify: `docs/roadmap.zh.md`

**Interfaces:**
- Consumes: JSON and Markdown bench behavior from Tasks 1-2.
- Produces: public documentation that says W1 is now bench-guarded while the rest of D2 remains open.

- [ ] **Step 1: Update verification docs**

In `docs/verification.md`, after the paragraph that starts with `` `npm run bench` runs `bench/impact-bench.ts` directly``, add:

```md
The deterministic bench also includes a cross-repo contract-impact lane. It builds a two-repo workspace fixture, persists a breaking contract link through `analyzeContractDiff`, then checks that `analyzeDiff` and report-scoped graph export still expose the expected `web:src/client.ts` consumer impact. This lane gates `summary.passed` through `crossRepoContracts.summary.passed` without reweighting the historical `summary.score`.
```

In `docs/verification.ko.md`, add the meaning-equivalent Korean paragraph:

```md
Deterministic bench에는 cross-repo contract-impact lane도 포함된다. 이 lane은 two-repo workspace fixture를 만들고 `analyzeContractDiff`로 breaking contract link를 persist한 뒤, `analyzeDiff`와 report-scoped graph export가 expected `web:src/client.ts` consumer impact를 계속 노출하는지 확인한다. 이 lane은 기존 `summary.score`를 reweight하지 않고 `crossRepoContracts.summary.passed`로 `summary.passed`를 gate한다.
```

In `docs/verification.zh.md`, add:

```md
Deterministic bench 也包含 cross-repo contract-impact lane。该 lane 构建 two-repo workspace fixture，通过 `analyzeContractDiff` persist breaking contract link，然后检查 `analyzeDiff` 与 report-scoped graph export 是否仍暴露 expected `web:src/client.ts` consumer impact。该 lane 不会 reweight 历史 `summary.score`，而是通过 `crossRepoContracts.summary.passed` gate `summary.passed`。
```

- [ ] **Step 2: Update the D2 backlog row**

In `IMPROVEMENT_OPPORTUNITIES.md`, replace the D2 row with:

```md
| D2 | **Bench coverage for co-change / traces / cross-repo / contract-diff** — W1-focused cross-repo coverage is ✅ **shipped**: `npm run bench` now includes a deterministic two-repo contract-impact lane that gates `summary.passed` when primary `analyzeDiff` or report graph export loses the expected consumer break. Still open: trend metrics for co-change, trace-ingest promotion, and broader paired v1/v2 contract-diff quality. | M | HIGH |
```

- [ ] **Step 3: Update roadmap measurement wording**

In `docs/roadmap.md`, under "Retrospective and measurement", add this sub-bullet under the deterministic bench harness item:

```md
  - Current cross-repo gate: the bench includes a two-repo contract-impact fixture that verifies W1 primary cross-repo consumer impact and report graph edges remain visible.
```

In `docs/roadmap.ko.md`, add:

```md
  - 현재 cross-repo gate: bench에는 W1 primary cross-repo consumer impact와 report graph edge가 계속 보이는지 확인하는 two-repo contract-impact fixture가 포함된다.
```

In `docs/roadmap.zh.md`, add:

```md
  - 当前 cross-repo gate：bench 包含 two-repo contract-impact fixture，用来验证 W1 primary cross-repo consumer impact 与 report graph edge 仍然可见。
```

- [ ] **Step 4: Run documentation checks**

Run:

```bash
npm run docs:lint
```

Expected: PASS.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
node --import tsx --test tests/impact-bench.test.ts tests/impact-bench-report.test.ts
npm run bench
npm run lint
npm run verify
```

Expected:
- focused bench tests pass;
- `npm run bench` exits 0 and emits `crossRepoContracts.summary.passed: true`;
- `npm run lint` passes;
- `npm run verify` passes.

- [ ] **Step 6: Commit Task 3**

```bash
git add docs/verification.md docs/verification.ko.md docs/verification.zh.md IMPROVEMENT_OPPORTUNITIES.md docs/roadmap.md docs/roadmap.ko.md docs/roadmap.zh.md
git commit -m "docs: document cross-repo bench coverage"
```

## Plan Self-Review

- Spec coverage: Task 1 implements `crossRepoContracts`, production API fixture flow, path safety, deterministic output, and pass gating. Task 2 implements Markdown summary and loader validation. Task 3 implements verification docs, roadmap/backlog status, and final verification.
- Completeness scan: no unfinished markers or sample-only implementation gaps remain.
- Type consistency: `CrossRepoContractBench`, `crossRepoContracts`, `cross-repo-contract-impact-v0`, and pass-gate semantics are named consistently across tasks.
- Scope check: W2, W6, S4, co-change, trace-ingest, and broad contract-diff trend metrics remain out of scope.
