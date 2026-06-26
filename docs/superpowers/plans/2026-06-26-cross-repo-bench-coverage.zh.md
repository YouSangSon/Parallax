# Cross-Repo Bench Coverage 实施计划

[English](2026-06-26-cross-repo-bench-coverage.md) · [한국어](2026-06-26-cross-repo-bench-coverage.ko.md) · **中文**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标:** 在 deterministic `npm run bench` 中验证 W1 cross-repo contract break 是否仍出现在 primary `analyzeDiff` report 与 report-scoped graph export 中。

**Architecture:** 保持现有 weighted `summary.score` 不变，在 `ImpactBenchReport` 中新增 required `crossRepoContracts` section。通过 production APIs 创建 two-repo workspace fixture，使用 `analyzeContractDiff` persist breaking link，然后评分 `analyzeDiff` 与 `exportImpactGraph`。

**Tech Stack:** TypeScript, Node.js `node:test`, SQLite `node:sqlite`, existing Parallax workspace/contract-diff/analyzer APIs, Markdown docs.

## Global Constraints

- `summary.score` 保持现有 weighted deterministic relation/retrieval score。
- `crossRepoContracts.summary.passed` gate top-level `summary.passed`。
- Bench output 不得包含 absolute temp paths、local repo roots、timing、random IDs 或 machine-specific data。
- Fixture 使用 `initProject`, `indexProject`, `initWorkspace`, `addWorkspaceRepo`, `resolveCrossRepoContracts`, `analyzeContractDiff`, `analyzeDiff`, `exportImpactGraph`。
- 不使用 network access。
- W2、W6、S4、其他 D2 lanes 不在范围内。
- 英文、韩文、中文 docs 语义保持一致。
- Final acceptance 需要 `npm run bench`、focused bench/report tests、`npm run lint`、`npm run verify`。

---

## File Structure

- Modify `bench/impact-bench.ts`: add `CrossRepoContractBench` and two-repo fixture runner.
- Modify `tests/impact-bench.test.ts`: assert schema version, lane shape, matched consumer/evidence/graph edge, and path safety.
- Modify `bench/impact-bench-report.ts`: validate and render the new section.
- Modify `tests/impact-bench-report.test.ts`: update Markdown summary and baseline delta tests.
- Modify `docs/verification*.md`, `IMPROVEMENT_OPPORTUNITIES.md`, `docs/roadmap*.md`: document that W1 is bench-guarded.

### Task 1: Cross-Repo Bench JSON Lane

**Files:**
- Modify: `bench/impact-bench.ts`
- Modify: `tests/impact-bench.test.ts`

**Interfaces:**
- Produces: `ImpactBenchReport.crossRepoContracts: CrossRepoContractBench`.

- [ ] **Step 1: Write the failing report shape test**

Add assertions to `tests/impact-bench.test.ts`:

```ts
    assert.equal(report.schemaVersion, 4);
    assert.equal(report.crossRepoContracts.fixtureId, 'cross-repo-contract-impact-v0');
    assert.equal(report.crossRepoContracts.summary.passed, true);
    assert.equal(report.crossRepoContracts.summary.score, 1);
    assert.deepEqual(report.crossRepoContracts.expectedConsumerPaths, ['web:src/client.ts']);
    assert.deepEqual(report.crossRepoContracts.matchedConsumerPaths, ['web:src/client.ts']);
    assert.deepEqual(report.crossRepoContracts.expectedEvidenceKinds, ['BREAKS_COMPATIBILITY_WITH']);
    assert.deepEqual(report.crossRepoContracts.matchedEvidenceKinds, ['BREAKS_COMPATIBILITY_WITH']);
    assert.deepEqual(report.crossRepoContracts.graphEdges, { expected: 1, matched: 1 });
    assert.equal(serializedReport.includes('impact-bench-cross-repo-'), false);
```

Change the existing schema assertion from `3` to `4`.

- [ ] **Step 2: Verify failure**

```bash
node --import tsx --test tests/impact-bench.test.ts --test-name-pattern "deterministic report shape"
```

Expected: FAIL because `crossRepoContracts` does not exist.

- [ ] **Step 3: Add type/imports in `bench/impact-bench.ts`**

Include these exports from `../src/index.js`:

```ts
  addWorkspaceRepo,
  analyzeContractDiff,
  exportImpactGraph,
  initWorkspace,
  resolveCrossRepoContracts
```

Bump `schemaVersion` to `4`, add `crossRepoContractFixtureId = 'cross-repo-contract-impact-v0'`, and add `crossRepoContracts: CrossRepoContractBench` to `ImpactBenchReport`.

- [ ] **Step 4: Implement fixture writers and runner**

Add a consumer client writer, an OpenAPI contract writer, and `runCrossRepoContractBench()`. The runner creates provider/consumer repos, registers the workspace, then runs `resolveCrossRepoContracts`, `analyzeContractDiff`, `analyzeDiff`, and `exportImpactGraph` through production APIs.

Core score:

```ts
const score = ratio(
  matchedConsumerPaths.length + matchedEvidenceKinds.length + Math.min(matchedGraphEdges, expectedGraphEdges),
  expectedConsumerPaths.length + expectedEvidenceKinds.length + expectedGraphEdges
);
```

`crossRepoContracts.summary.passed` is true only when `score === 1`.

- [ ] **Step 5: Wire the pass gate**

After `const retrieval = await runRetrievalBench(fixtureRoot);`, add:

```ts
const crossRepoContracts = await runCrossRepoContractBench();
```

Top-level `passed` includes:

```ts
crossRepoContracts.summary.passed === true &&
```

The report object includes:

```ts
crossRepoContracts,
```

- [ ] **Step 6: Verify and commit**

```bash
node --import tsx --test tests/impact-bench.test.ts --test-name-pattern "deterministic report shape"
npm run bench
git add bench/impact-bench.ts tests/impact-bench.test.ts
git commit -m "feat(bench): track cross-repo contract impact"
```

### Task 2: Bench Markdown Summary And Validation

**Files:**
- Modify: `bench/impact-bench-report.ts`
- Modify: `tests/impact-bench-report.test.ts`

**Interfaces:**
- Consumes: Task 1 `crossRepoContracts`.
- Produces: Markdown summary rows and loader validation.

- [ ] **Step 1: Update report-summary tests**

In `tests/impact-bench-report.test.ts`, set `makeReport()` `schemaVersion` to `4` and add a passing `crossRepoContracts` fixture. Add assertions:

```ts
  assert.match(markdown, /\| Cross-repo contract impact \| 1\.0000 \| n\/a \|/);
  assert.match(markdown, /\| Cross-repo impacts \| 1\/1 \| n\/a \|/);
  assert.match(markdown, /\| Cross-repo graph edges \| 1\/1 \| n\/a \|/);
  assert.match(markdown, /### Missing cross-repo consumers\n\nNone\./);
```

- [ ] **Step 2: Verify failure**

```bash
node --import tsx --test tests/impact-bench-report.test.ts
```

Expected: FAIL because formatter/validator does not know the new section.

- [ ] **Step 3: Update formatter**

In `bench/impact-bench-report.ts`, add the metric row `Cross-repo contract impact`, coverage rows `Cross-repo impacts` and `Cross-repo graph edges`, and a `Missing cross-repo consumers` list section.

- [ ] **Step 4: Update loader validation**

In `assertBenchReport`, validate `crossRepoContracts` when `schemaVersion >= 4 || value.crossRepoContracts !== undefined`. Keep v2/v3 baseline compatibility through optional chaining.

- [ ] **Step 5: Verify and commit**

```bash
node --import tsx --test tests/impact-bench-report.test.ts
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
- Consumes: Task 1-2 behavior.
- Produces: public docs saying W1 is bench-guarded and other D2 lanes remain open.

- [ ] **Step 1: Update verification docs**

Explain in `docs/verification*.md` that `npm run bench` includes a two-repo cross-repo contract-impact lane and gates `summary.passed` through `crossRepoContracts.summary.passed` without reweighting `summary.score`.

- [ ] **Step 2: Update backlog and roadmap**

Mark the W1-focused part of D2 as shipped in `IMPROVEMENT_OPPORTUNITIES.md`, leaving co-change, trace-ingest, and broader contract-diff trend metrics open. Add a cross-repo gate sub-bullet under the deterministic bench item in `docs/roadmap*.md`.

- [ ] **Step 3: Final verification**

```bash
npm run docs:lint
node --import tsx --test tests/impact-bench.test.ts tests/impact-bench-report.test.ts
npm run bench
npm run lint
npm run verify
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/verification.md docs/verification.ko.md docs/verification.zh.md IMPROVEMENT_OPPORTUNITIES.md docs/roadmap.md docs/roadmap.ko.md docs/roadmap.zh.md
git commit -m "docs: document cross-repo bench coverage"
```

## Plan Self-Review

- Spec coverage: Task 1 implements JSON bench lane, production fixture flow, path safety, and pass gate. Task 2 implements Markdown summary and validation. Task 3 updates docs/backlog and runs final verification.
- Completeness scan: no unfinished markers or open implementation requirements remain.
- Type consistency: `CrossRepoContractBench`, `crossRepoContracts`, and `cross-repo-contract-impact-v0` are consistent.
- Scope check: W2, W6, S4, co-change, trace-ingest, and broad contract-diff trend metrics are out of scope.
