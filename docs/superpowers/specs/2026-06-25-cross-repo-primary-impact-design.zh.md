# Cross-Repo Primary Impact 设计

[English](2026-06-25-cross-repo-primary-impact-design.md) · [한국어](2026-06-25-cross-repo-primary-impact-design.ko.md) · **中文**

**状态:** 已批准写设计。实现仍需要先审阅这份 written spec。

**Backlog item:** W1，`analyzeDiff` 中的 cross-repo contract impact。

**目标:** 当变更的 contract 会破坏已注册 workspace 的 consumer 时，primary impact report 必须直接显示这些 consumer service 和 file。Cross-repo impact 不应只留在 `parallax workspace contract-diff` 输出或 `parallax://workspaces/{name}/cross-repo-links` resource 中。

## 用户结果

修改 provider contract 的用户必须立刻看到：

- 哪个 consumer service 有风险；
- 哪个 consumer file 匹配了被破坏的 endpoint 或 event；
- 哪个 provider contract 和 breaking change 造成了风险；
- 支撑该结果的 confidence 和 evidence；
- 继续通过 MCP/UI resource link 调查的路径。

首屏 report 和 UI 必须回答 "如果发布这个 contract change，谁会坏掉？"，而不要求用户或 agent 先知道 workspace side lane 的存在。

## 当前状态

Parallax 已经有实现该功能所需的 raw data：

- `contracts` 和 `contract_versions` 标识 indexed provider contracts。
- `cross_repo_links` 存储 `analyzeContractDiff` 写入的 `BREAKS_COMPATIBILITY_WITH` links。
- link provenance 带有 `consumer`、`provider`、`change`、`evidence` 对象。
- MCP resources 可以暴露 workspace contracts 和 cross-repo links。

缺口在集成。`analyzeDiff` 只遍历 local entity graph 和 legacy file edges。它不读取 workspace breaking links，所以 `parallax analyze`、MCP `parallax_analyze_diff`、persisted reports、graph exports 和 UI 都会在 primary path 中漏掉 cross-repo consumers。

## 选择的方案

在 `analyzeDiff` 内加入一个聚焦的 cross-repo lane。

该 lane 只在 changed file 匹配 latest completed run 中 indexed contract path 时运行。对这些 contracts，它读取 provenance 指向同一个 provider repo 与 contract path 的 workspace `BREAKS_COMPATIBILITY_WITH` links。每个有效 link 生成：

- 一个 `crossRepoImpacts` item；
- 一个 consumer file 的 `affectedFiles` item，使用 cross-repo path label；
- 一个 consumer file 的 `external_entity` `affected` target；
- 一个带 relation metadata 的 evidence item，供 graph export 和 UI 渲染 edge。

该 lane 有意保持 read-only。它不会 resolve contracts、重新计算 breaking changes，也不会修改 workspace links。它只把已经 persisted 的 workspace evidence 显示到 main report。

## 考虑过的替代方案

### A. 在 `analyzeDiff` 中显示已有 breaking links（选择）

这是每个 slice 用户可见价值最高的方案。它复用现有 resolver 和 contract-diff output，保持 deterministic behavior，并且不需要新 workflow 就能让 primary report 有用。

Tradeoff: report 只显示已经 resolve 并 persist 的 links。如果 workspace stale，report 发出 warning，而不是静默重新计算。

### B. 在 `analyzeDiff` 中自动运行 contract-diff

这会让 report 更新鲜，但会把更多 write behavior 和更昂贵的 analysis 带进一个目前基于 latest index 做 impact mapping 的 command。由于 `parallax_analyze_diff` 在某些 mode 下已经会 persist reports/telemetry，这也会模糊 read-only-first MCP 边界。

Tradeoff: freshness 更好，可预测性和耦合度更差。

### C. 只添加新的 MCP tool/resource

这能保持 primary report 不变，schema risk 较低，但不能解决用户问题。Agents 和用户仍必须发现并调用 side lane 才能理解 cross-repo breakage。

Tradeoff: schema risk 低，product impact 也低。

## Report Shape

给 `ImpactReport` 添加 optional field：

```ts
type CrossRepoImpact = {
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

该 field 是 optional 且 additive，因此 report schema 做 minor version bump。已有 reports 必须继续能通过新 schema。实现时也必须修正仍写着旧 schema version 的 report-schema 文档。

出于隐私，若 `repoPath` 会暴露 absolute local path，则必须从 public JSON 中省略。Primary identity 是 `serviceName`、`contractPath`、`consumer.path`。Resource URI 可以指向 workspace resource，而不泄漏 local paths。

## Affected Targets And Evidence

Cross-repo impact 必须进入现有 report surfaces：

- `affectedFiles.path`: 使用 `web:src/client.ts` 这样的 stable display label，而不是 absolute repo path。
- `affectedFiles.reason`: `breaks cross-repo consumer web via contracts/openapi.yaml`。
- `affectedFiles.confidence`: 使用 `cross_repo_links.confidence`，通过 `asConfidence` normalize。
- `affectedFiles.depth`: `1`。
- `affectedFiles.relationPath`: 包含人类可读的 contract break step。
- `affected.target.kind`: `external_entity`。
- `evidence.kind`: `BREAKS_COMPATIBILITY_WITH`。
- `evidence.subject`: consumer target。
- `evidence.target`: provider contract entity。
- `evidence.relationKind`: `BREAKS_COMPATIBILITY_WITH`。
- `evidence.extractorId`: `cross-repo-contract-impact`。

这样 saved report graph export 可以只靠 persisted JSON evidence 重建 cross-repo edge，不依赖 canonical rows，符合 invariant I-11。

## Matching Rules

只有以下条件全部成立时，lane 才发出 cross-repo impact：

- changed file path 等于当前 repo 的 indexed contract path；
- local DB 中存在 workspace row；
- `BREAKS_COMPATIBILITY_WITH` link 属于该 workspace；
- parsed provenance provider `contractPath` 等于 changed contract path；
- 如果有可用 repo identity，parsed provenance provider repo 与当前 repo 匹配；
- parsed provenance 包含 consumer file path 和 evidence snippet。

Invalid 或 legacy provenance 不得 throw。对应 link 被 skip，并用一个 report warning 说明忽略了多少 malformed cross-repo links。

## UI, MCP, Graph 行为

该 slice 不需要新 command。

Primary surfaces 通过 report 接收新数据：

- CLI `analyze --json` 包含 `crossRepoImpacts`。
- MCP `parallax_analyze_diff` 返回同一个 report field。
- persisted report resource 包含该 field。
- graph export 从 report evidence 渲染 cross-repo `BREAKS_COMPATIBILITY_WITH` edges。
- UI 在现有 affected/inspector flow 中显示 cross-repo impacts，并带一个 `cross-repo` 这样的小 lane label。

如果 UI 需要 display label mapping helper，将它限制在 UI data preparation 中。不要创建会和 report JSON drift 的独立 data source。

## Error Handling

- 没有 workspace: 没有 cross-repo impacts，没有 warning。
- 有 workspace 但没有 matching breaking links: 没有 cross-repo impacts，没有 warning。
- Malformed provenance: skip malformed links，并添加一个 deterministic warning。
- Stale workspace links: 显示已有 link confidence 和 evidence，不重新计算。Stale/orphan detection 属于未来 W2 verification command。
- Absolute paths: 不把 local machine paths 写进 docs 或 public-facing report display labels。

## Tests

实现前添加 focused coverage：

1. 当 changed file 是 provider contract 时，`analyzeDiff` 显示 persisted `BREAKS_COMPATIBILITY_WITH` link。
2. 输出 report 包含 consumer file 对应的 `crossRepoImpacts`、`affectedFiles`、`affected` 和 relation-bearing evidence。
3. 从 persisted report 构建的 report graph export 包含 cross-repo `BREAKS_COMPATIBILITY_WITH` edge，并且不查询 cross-repo rows 也保持稳定。
4. Non-contract changed files 和没有 matching breaking links 的 contracts 保持现有 report output 不变。
5. Malformed breaking-link provenance 被 skip，并带一个 deterministic warning。
6. 添加 optional field 和 schema version bump 后，report schema drift guard 通过。

## Documentation

实现 slice 中更新这些 public docs：

- `docs/cli-reference*.md`: 说明当 workspace links 存在时，`analyze` 可以包含 cross-repo consumer impact。
- `docs/mcp*.md`: 说明 `parallax_analyze_diff` 返回相同 cross-repo section。
- `docs/report-schema*.md`: bump documented current version，并描述 `crossRepoImpacts`。
- `docs/roadmap*.md`: 实现后将 W1 标记为 shipped。
- `IMPROVEMENT_OPPORTUNITIES.md`: 将 W1 移到 shipped 并更新 sequencing。

英文、韩文、中文文档必须语义一致。

## Implementation Boundary

本设计不实现：

- 在 `analyzeDiff` 内自动运行 contract diff；
- 属于 W2 的 cross-repo link reconciliation 或 bidirectional repair；
- 属于 W3 的 monorepo sub-package cataloging；
- 新 MCP write surface；
- network access 或 remote repository discovery。

## Verification Gate

Merge 前实现必须通过：

```bash
npm run schemas:build
npm run lint
npm test
npm run test:mcp
npm run test:ui
npm run verify
```

开发过程中可以先跑 scoped tests，但 final acceptance 需要 `npm run verify`。

## Open Implementation Notes

- 如果 SQL/provenance parsing 超过 compact function，优先使用 `src/analyzer.ts` 内的小 helper 或 dedicated module `loadCrossRepoImpactsForChangedContract(...)`。
- 只有在不会造成 layering cycle 时才复用 `src/mcp_resources.ts` 的 `workspaceResources(...)`。如果会造成 cycle，就把 URI construction 移到 shared helper。
- Warning text 必须 deterministic，并和现有 warnings 一起排序。
- `CrossRepoImpact` 保持 additive/optional，确保旧 persisted reports 仍可读取。
