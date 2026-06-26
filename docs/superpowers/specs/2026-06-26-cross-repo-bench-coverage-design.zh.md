# Cross-Repo Bench Coverage 设计

[English](2026-06-26-cross-repo-bench-coverage-design.md) · [한국어](2026-06-26-cross-repo-bench-coverage-design.ko.md) · **中文**

**状态:** 设计已批准。实施计划将在 written spec review 后编写。

**Backlog item:** D2，cross-repo 和 contract-diff surfaces 的 bench coverage。

**目标:** 让已经 shipped 的 W1 cross-repo primary impact 路径出现在 deterministic `npm run bench` report 中。未来如果 provider contract break 不再通过 `analyzeDiff`、report evidence 或 graph export 呈现 expected consumer impact，稳定的 bench score 应该下降。

## 用户结果

用户和 agent 应该能相信 W1 的核心承诺不只由 unit tests 覆盖，也由同一个 deterministic quality report 跟踪。该 report 已经守护 relation recall、affected-file recall、evidence quality 和 retrieval quality。

Bench 要回答一个窄问题："一个已注册的 cross-repo contract break 是否仍能带着 expected consumer、evidence 和 graph edge 到达 primary impact report？"

## 当前状态

W1 已经 shipped。`analyzeDiff` 现在可以输出：

- optional `crossRepoImpacts`;
- `web:src/client.ts` 这样的 external affected consumer path;
- `BREAKS_COMPATIBILITY_WITH` relation evidence;
- 从 persisted report JSON 重建的 report-scoped graph edge。

Focused tests 已在 `tests/contract-diff.test.ts` 覆盖该行为，UI tests 覆盖 rendering。但 deterministic bench 还没有测量这条路径。`ImpactBenchReport` 仍然评分 static relation recall、affected-file recall、evidence/span coverage、adapter attribution、context-pack readiness 和 retrieval quality，却没有 cross-repo 或 contract-diff lane。

## 选择的方案

为 W1 cross-repo primary impact 添加一个紧凑的 D2 bench lane。

该 lane 在 bench temp workspace 内创建 deterministic two-repo fixture：

1. provider repo，包含带 `/api/users` 的 OpenAPI contract；
2. consumer repo，包含调用 `/api/users` 的 source file；
3. 注册两个 repos 的 workspace catalog；
4. indexed baseline 和 resolved `CONSUMES_HTTP_ENDPOINT` link；
5. 移除 `/api/users` 的 provider contract edit；
6. persist expected `BREAKS_COMPATIBILITY_WITH` link 的 contract-diff run；
7. 针对 provider contract 的 `analyzeDiff` run。

然后 bench 评分 primary report 是否包含 expected cross-repo consumer impact，以及 persisted report graph 是否包含 expected break edge。这样可以保持 lane 贴近真实用户 workflow，同时不引入 network access 或 nondeterministic timing。

## 考虑过的替代方案

### A. 将 W1 cross-repo lane 加入 `ImpactBenchReport`（选择）

这保护刚成为 user-visible path 的行为。它提供一个小但有意义的 trend signal，并让 D2 可以增量推进，而不是一次性处理所有新特性。

Tradeoff: bench report 会增加一个新 section，因此 report formatting 和 deterministic-output tests 需要谨慎更新。

### B. 继续只依赖 focused integration tests

现有 tests 有价值，应该保留。但它们不会进入 quality report 或 PR bench delta。维护者和 agents 用 benchmark summary 判断整体健康度时，regression 可能不可见。

Tradeoff: 没有 bench schema churn，但长期 signal 较弱。

### C. 一次性实现所有 D2 feature benches

更广的 D2 pass 可以同时包含 co-change、trace-ingest promotion、cross-repo 和 contract-diff metrics。它更完整，但会耦合多种 fixture type，使 review 更难。

Tradeoff: coverage 更广，slice 更慢且风险更高。

## Bench Report Shape

给 `ImpactBenchReport` 添加 `crossRepoContracts` section：

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

该 section 必须 deterministic 且 path-safe。不得包含 absolute temp paths、local repo roots、wall-clock timing、random IDs 或 machine-specific data。Fixture 可以使用 `web:src/client.ts` 这样的 service-qualified display paths。

Top-level `summary.score` 保持现有 weighted deterministic relation/retrieval score。新的 cross-repo lane 是 required pass gate：即使现有 weighted score 很高，只要 `crossRepoContracts.summary.passed` 为 false，top-level `summary.passed` 也必须为 false。这样不会改变历史 score 的解释，同时仍让 W1 regression 出现在 canonical bench status 中。

## Data Flow

Bench fixture 应该复用 production APIs，而不是手动插入 rows：

- `initProject` 和 `indexProject` 准备两个 repos。
- `initWorkspace` 和 `addWorkspaceRepo` 注册 workspace。
- `resolveCrossRepoContracts` 创建 consumer link。
- Contract edit 后，`analyzeContractDiff` persist breaking link。
- `analyzeDiff` 生成被测 primary report。
- `exportImpactGraph` 验证 report-scoped graph edge。

该 data flow 让 bench 与用户 workflow 保持一致，并避免 synthetic fixture 通过但 production wiring 已损坏的情况。

## Error Handling And Determinism

- Fixture setup failure 应该抛出清晰的 bench error，而不是静默评分为 0。
- 如果 `analyzeContractDiff` 无法把 edit 分类为 breaking，bench section 会因没有 matched impacts 而 fail。
- 如果 `analyzeDiff` 输出 malformed 或 path-leaking data，deterministic-output test 会 fail。
- Lane 执行后必须清理 temp repos。
- 除 fixture repos 内正常 repo-local `.parallax` state 外，lane 不得读写 temp workspace 之外的路径。

## Tests

实现必须新增或更新 focused tests：

1. 新 bench section 存在，并报告 passing cross-repo fixture。
2. Bench output 两次运行保持 deterministic。
3. Bench output 不包含 temp workspace roots、absolute provider repo paths、absolute consumer repo paths 或 escaped absolute path variants。
4. Markdown bench report 包含 cross-repo section，并在 section fail 时突出 missing impacts。
5. 现有 relation/retrieval/semantic bench assertions 继续通过。

## Documentation

更新：

- `docs/verification*.md`: 说明 `npm run bench` 现在包含 deterministic cross-repo contract-impact lane。
- `IMPROVEMENT_OPPORTUNITIES.md`: 将 D2 中 W1-focused 部分标记为 shipped 或 partially shipped，同时保留 co-change、trace-ingest 和更广 contract-diff trend metrics 为 open。
- `docs/roadmap*.md`: 如有需要，说明 cross-repo primary impact 现在已被 bench guarded。

触碰翻译页面时，English、Korean 和 Chinese 文档必须语义一致。

## Implementation Boundary

本设计不实现：

- W2 cross-repo link reconciliation 或 workspace verification；
- W6 cross-repo MCP tools；
- co-change、trace-ingest 或 broader contract-diff bench lanes；
- large-repo timing baselines 或 S4 peak-RSS work；
- 新 public report schema fields。

## Verification Gate

实现被接受前运行：

```bash
npm run bench
npm test -- --test-name-pattern "bench|cross-repo"
npm run lint
npm run verify
```

开发中可以先运行 scoped bench 和 test commands，但 final acceptance 需要 `npm run verify`。

## Spec Self-Review

- Completeness scan: 没有 unfinished markers、sample-only values 或开放式要求。
- Consistency check: chosen approach、data flow、tests 和 documentation 都指向同一个 W1 cross-repo bench lane。
- Scope check: 这是单个 D2 slice。W2、W6、S4 和其他 D2 lanes 明确 out of scope。
- Ambiguity check: top-level score semantics 已固定。Cross-repo lane 会 gate `summary.passed`，但不会 reweight `summary.score`。
