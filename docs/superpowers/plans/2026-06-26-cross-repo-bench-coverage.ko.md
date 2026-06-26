# Cross-Repo Bench Coverage 구현 계획

[English](2026-06-26-cross-repo-bench-coverage.md) · **한국어** · [中文](2026-06-26-cross-repo-bench-coverage.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**목표:** W1 cross-repo contract break가 primary `analyzeDiff` report와 report-scoped graph export에 계속 나타나는지 deterministic `npm run bench`에서 검증한다.

**Architecture:** 기존 weighted `summary.score`는 그대로 두고 `ImpactBenchReport`에 required `crossRepoContracts` section을 추가한다. Two-repo workspace fixture를 production API로 만들고, `analyzeContractDiff`로 breaking link를 persist한 뒤 `analyzeDiff`와 `exportImpactGraph`를 점수화한다.

**Tech Stack:** TypeScript, Node.js `node:test`, SQLite `node:sqlite`, 기존 Parallax workspace/contract-diff/analyzer API, Markdown docs.

## Global Constraints

- `summary.score`는 기존 weighted deterministic relation/retrieval score를 유지한다.
- `crossRepoContracts.summary.passed`는 top-level `summary.passed`를 gate한다.
- Bench output에는 absolute temp path, local repo root, timing, random ID, machine-specific data를 넣지 않는다.
- Fixture는 `initProject`, `indexProject`, `initWorkspace`, `addWorkspaceRepo`, `resolveCrossRepoContracts`, `analyzeContractDiff`, `analyzeDiff`, `exportImpactGraph`를 사용한다.
- Network access는 없다.
- W2, W6, S4, 다른 D2 lane은 범위 밖이다.
- 영어/한국어/중국어 문서는 의미가 같아야 한다.
- Final acceptance에는 `npm run bench`, focused bench/report tests, `npm run lint`, `npm run verify`가 필요하다.

---

## File Structure

- Modify `bench/impact-bench.ts`: `CrossRepoContractBench`와 two-repo fixture runner 추가.
- Modify `tests/impact-bench.test.ts`: schema version, lane shape, matched consumer/evidence/graph edge, path safety 검증.
- Modify `bench/impact-bench-report.ts`: 새 section validation과 Markdown rendering.
- Modify `tests/impact-bench-report.test.ts`: Markdown summary와 baseline delta test 갱신.
- Modify `docs/verification*.md`, `IMPROVEMENT_OPPORTUNITIES.md`, `docs/roadmap*.md`: W1 bench guard 상태 문서화.

### Task 1: Cross-Repo Bench JSON Lane

**Files:**
- Modify: `bench/impact-bench.ts`
- Modify: `tests/impact-bench.test.ts`

**Interfaces:**
- Produces: `ImpactBenchReport.crossRepoContracts: CrossRepoContractBench`.

- [ ] **Step 1: 실패하는 report shape test 작성**

`tests/impact-bench.test.ts`의 deterministic report shape test에 다음 assertion을 추가한다:

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

기존 `schemaVersion` assertion은 `3`에서 `4`로 바꾼다.

- [ ] **Step 2: 실패 확인**

```bash
node --import tsx --test tests/impact-bench.test.ts --test-name-pattern "deterministic report shape"
```

Expected: `crossRepoContracts`가 없어 실패.

- [ ] **Step 3: `bench/impact-bench.ts`에 type/import 추가**

`../src/index.js` import에 다음을 포함한다:

```ts
  addWorkspaceRepo,
  analyzeContractDiff,
  exportImpactGraph,
  initWorkspace,
  resolveCrossRepoContracts
```

`schemaVersion`은 `4`로 올리고, `crossRepoContractFixtureId = 'cross-repo-contract-impact-v0'`를 추가한다. `ImpactBenchReport`에는 `crossRepoContracts: CrossRepoContractBench`를 추가한다.

- [ ] **Step 4: Fixture writer와 runner 구현**

`bench/impact-bench.ts`에 consumer/client writer, OpenAPI contract writer, `runCrossRepoContractBench()`를 추가한다. Runner는 provider/consumer repo를 만들고, workspace를 등록하고, `resolveCrossRepoContracts`, `analyzeContractDiff`, `analyzeDiff`, `exportImpactGraph` 순서로 production path를 검증한다.

Core scoring은 다음 의미를 가져야 한다:

```ts
const score = ratio(
  matchedConsumerPaths.length + matchedEvidenceKinds.length + Math.min(matchedGraphEdges, expectedGraphEdges),
  expectedConsumerPaths.length + expectedEvidenceKinds.length + expectedGraphEdges
);
```

`score === 1`일 때만 `crossRepoContracts.summary.passed`가 true다.

- [ ] **Step 5: `runImpactBench`에 pass gate 연결**

`const retrieval = await runRetrievalBench(fixtureRoot);` 다음에:

```ts
const crossRepoContracts = await runCrossRepoContractBench();
```

Top-level `passed` 조건에:

```ts
crossRepoContracts.summary.passed === true &&
```

Report object에:

```ts
crossRepoContracts,
```

- [ ] **Step 6: 검증 및 커밋**

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
- Consumes: Task 1의 `crossRepoContracts`.
- Produces: Markdown summary row와 report loader validation.

- [ ] **Step 1: report-summary test 갱신**

`tests/impact-bench-report.test.ts`의 `makeReport()`에 `schemaVersion: 4`와 `crossRepoContracts` fixture를 추가한다. Summary assertion에는 다음을 추가한다:

```ts
  assert.match(markdown, /\| Cross-repo contract impact \| 1\.0000 \| n\/a \|/);
  assert.match(markdown, /\| Cross-repo impacts \| 1\/1 \| n\/a \|/);
  assert.match(markdown, /\| Cross-repo graph edges \| 1\/1 \| n\/a \|/);
  assert.match(markdown, /### Missing cross-repo consumers\n\nNone\./);
```

- [ ] **Step 2: 실패 확인**

```bash
node --import tsx --test tests/impact-bench-report.test.ts
```

Expected: formatter/validator가 새 section을 몰라 실패.

- [ ] **Step 3: Markdown formatter 수정**

`bench/impact-bench-report.ts`의 metric rows에 `Cross-repo contract impact`를 추가하고, coverage rows에 `Cross-repo impacts`, `Cross-repo graph edges`를 추가한다. Missing section으로 `Missing cross-repo consumers`를 렌더링한다.

- [ ] **Step 4: Loader validation 수정**

`assertBenchReport`에서 `schemaVersion >= 4 || value.crossRepoContracts !== undefined`일 때 `crossRepoContracts.fixtureId`, `summary`, consumer path arrays, evidence kind arrays, `graphEdges`를 검증한다. Baseline은 v2/v3 파일도 읽을 수 있도록 optional chaining을 유지한다.

- [ ] **Step 5: 검증 및 커밋**

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
- Produces: public docs that W1 is bench-guarded and other D2 lanes remain open.

- [ ] **Step 1: verification docs 갱신**

`docs/verification*.md`에 `npm run bench`가 two-repo cross-repo contract-impact lane을 포함하며, `summary.score`를 reweight하지 않고 `crossRepoContracts.summary.passed`로 `summary.passed`를 gate한다고 설명한다.

- [ ] **Step 2: backlog/roadmap 갱신**

`IMPROVEMENT_OPPORTUNITIES.md`의 D2 row는 W1-focused cross-repo coverage를 shipped로 표시하고 co-change, trace-ingest, broader contract-diff trend metrics는 open으로 유지한다. `docs/roadmap*.md`의 deterministic bench 항목 아래에 cross-repo gate sub-bullet을 추가한다.

- [ ] **Step 3: 최종 검증**

```bash
npm run docs:lint
node --import tsx --test tests/impact-bench.test.ts tests/impact-bench-report.test.ts
npm run bench
npm run lint
npm run verify
```

Expected: 모두 PASS.

- [ ] **Step 4: 커밋**

```bash
git add docs/verification.md docs/verification.ko.md docs/verification.zh.md IMPROVEMENT_OPPORTUNITIES.md docs/roadmap.md docs/roadmap.ko.md docs/roadmap.zh.md
git commit -m "docs: document cross-repo bench coverage"
```

## Plan Self-Review

- Spec coverage: Task 1은 JSON bench lane, production fixture flow, path safety, pass gate를 구현한다. Task 2는 Markdown summary와 validation을 구현한다. Task 3은 docs/backlog와 final verification을 닫는다.
- Completeness scan: 미완성 marker나 열린 구현 요구사항 없음.
- Type consistency: `CrossRepoContractBench`, `crossRepoContracts`, `cross-repo-contract-impact-v0` 명칭을 일관되게 사용한다.
- Scope check: W2, W6, S4, co-change, trace-ingest, broader contract-diff trend metric은 범위 밖이다.
