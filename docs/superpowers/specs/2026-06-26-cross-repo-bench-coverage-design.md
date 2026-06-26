# Cross-Repo Bench Coverage Design

**English** · [한국어](2026-06-26-cross-repo-bench-coverage-design.ko.md) · [中文](2026-06-26-cross-repo-bench-coverage-design.zh.md)

**Status:** Design approved. Implementation plan pending written-spec review.

**Backlog item:** D2, bench coverage for cross-repo and contract-diff surfaces.

**Goal:** Make the shipped W1 cross-repo primary impact path visible in the deterministic `npm run bench` report. A future regression should lower a stable bench score when a provider contract break no longer surfaces the expected consumer impact in `analyzeDiff`, report evidence, or graph export.

## User Outcome

Users and agents should be able to trust that the headline W1 promise is not only unit-tested but also tracked by the same deterministic quality report that guards relation recall, affected-file recall, evidence quality, and retrieval quality.

The bench should answer one narrow question: "Does a registered cross-repo contract break still reach the primary impact report with the expected consumer, evidence, and graph edge?"

## Current State

W1 is shipped. `analyzeDiff` can now emit:

- optional `crossRepoImpacts`;
- an external affected consumer path such as `web:src/client.ts`;
- `BREAKS_COMPATIBILITY_WITH` relation evidence;
- a report-scoped graph edge rebuilt from persisted report JSON.

Focused tests cover this behavior in `tests/contract-diff.test.ts`, and UI tests cover rendering. The deterministic bench, however, does not measure it. `ImpactBenchReport` still scores static relation recall, affected-file recall, evidence/span coverage, adapter attribution, context-pack readiness, and retrieval quality, but has no cross-repo or contract-diff lane.

## Chosen Approach

Add a compact D2 bench lane for W1 cross-repo primary impact.

The lane creates a deterministic two-repo fixture inside the bench temp workspace:

1. a provider repo with an OpenAPI contract containing `/api/users`;
2. a consumer repo with a source file that calls `/api/users`;
3. a workspace catalog registering both repos;
4. an indexed baseline and resolved `CONSUMES_HTTP_ENDPOINT` link;
5. a provider contract edit removing `/api/users`;
6. a contract-diff run that persists the expected `BREAKS_COMPATIBILITY_WITH` link;
7. an `analyzeDiff` run against the provider contract.

The bench then scores whether the primary report contains the expected cross-repo consumer impact and whether the persisted report graph contains the expected break edge. This keeps the lane realistic without introducing network access or nondeterministic timing.

## Alternatives Considered

### A. Add the W1 cross-repo lane to `ImpactBenchReport` (selected)

This protects the behavior that just became user-visible. It gives a small but meaningful trend signal and keeps D2 incremental rather than trying to bench every newer feature at once.

Tradeoff: the bench report grows a new section, so report formatting and deterministic-output tests need a careful update.

### B. Keep relying on focused integration tests

The current tests are valuable and should stay, but they do not contribute to the quality report or PR bench delta. A regression could pass unnoticed in the benchmark summary that agents and maintainers use to judge overall health.

Tradeoff: no bench schema churn, weaker long-term signal.

### C. Implement all D2 feature benches at once

A broad D2 pass could include co-change, trace-ingest promotion, cross-repo, and contract-diff metrics together. That is more complete, but it couples several fixture types and makes review harder.

Tradeoff: broader coverage, slower and riskier slice.

## Bench Report Shape

Add a `crossRepoContracts` section to `ImpactBenchReport`:

```ts
type CrossRepoContractBench = {
  fixtureId: 'cross-repo-contract-impact-v0';
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

The section is deterministic and path-safe. It must not include absolute temp paths, local repo roots, wall-clock timing, random IDs, or machine-specific data. The fixture can use service-qualified display paths such as `web:src/client.ts`.

The top-level `summary.score` stays on the existing weighted deterministic relation/retrieval score. The new cross-repo lane is a required pass gate: top-level `summary.passed` is false when `crossRepoContracts.summary.passed` is false, even if the existing weighted score is high. This avoids changing historic score interpretation while still making W1 regression visible in the canonical bench status.

## Data Flow

The bench fixture should reuse production APIs instead of inserting rows by hand:

- `initProject` and `indexProject` prepare both repos.
- `initWorkspace` and `addWorkspaceRepo` register the workspace.
- `resolveCrossRepoContracts` creates the consumer link.
- `analyzeContractDiff` persists the breaking link after the contract edit.
- `analyzeDiff` produces the primary report under test.
- `exportImpactGraph` verifies the report-scoped graph edge.

This data flow keeps the bench aligned with the user workflow and avoids a synthetic fixture that can pass while production wiring is broken.

## Error Handling And Determinism

- Fixture setup failures should throw with a clear bench error rather than being silently scored as zero.
- If `analyzeContractDiff` cannot classify the edit as breaking, the bench section fails with no matched impacts.
- If `analyzeDiff` emits malformed or path-leaking data, the deterministic-output test fails.
- The lane must clean its temp repos after execution.
- The lane must not read or write outside its temp workspace except for normal repo-local `.parallax` state inside the fixture repos.

## Tests

Implementation must add or update focused tests for:

1. The new bench section exists and reports a passing cross-repo fixture.
2. The bench output is deterministic across two runs.
3. The bench output does not contain temp workspace roots, absolute provider repo paths, absolute consumer repo paths, or escaped absolute path variants.
4. The Markdown bench report includes the cross-repo section and highlights missing impacts if the section fails.
5. Existing relation/retrieval/semantic bench assertions still pass.

## Documentation

Update:

- `docs/verification*.md`: describe that `npm run bench` now includes a deterministic cross-repo contract-impact lane.
- `IMPROVEMENT_OPPORTUNITIES.md`: mark the W1-focused part of D2 as shipped or partially shipped, while keeping the remaining co-change, trace-ingest, and broader contract-diff trend metrics open.
- `docs/roadmap*.md`: if needed, mention that cross-repo primary impact is now bench-guarded.

Keep English, Korean, and Chinese docs meaning-equivalent when touching translated pages.

## Implementation Boundary

This design does not implement:

- W2 cross-repo link reconciliation or workspace verification;
- W6 cross-repo MCP tools;
- co-change, trace-ingest, or broad contract-diff bench lanes;
- large-repo timing baselines or S4 peak-RSS work;
- new public report schema fields.

## Verification Gate

Before implementation is accepted, run:

```bash
npm run bench
npm test -- --test-name-pattern "bench|cross-repo"
npm run lint
npm run verify
```

Scoped bench and test commands may run during development, but final acceptance requires `npm run verify`.

## Spec Self-Review

- Completeness scan: no unfinished markers, sample-only values, or open-ended requirements remain.
- Consistency check: the chosen approach, data flow, tests, and documentation all target the same W1 cross-repo bench lane.
- Scope check: this is a single D2 slice; W2, W6, S4, and other D2 lanes are explicitly out of scope.
- Ambiguity check: top-level score semantics are fixed; the cross-repo lane gates `summary.passed` but does not reweight `summary.score`.
