# Cross-Repo Link Verification And Agent Query Design

[English](2026-06-26-cross-repo-link-verification-agent-query-design.md) · [한국어](2026-06-26-cross-repo-link-verification-agent-query-design.ko.md) · **中文**

**状态:** 已批准实施。Implementation plan：`docs/superpowers/plans/2026-06-26-cross-repo-link-verification-agent-query.md`。

**Backlog 项:** W2，bidirectional cross-repo link consistency；W6，cross-repo resolve 与 reverse-consumer MCP tools。

**目标:** 让 workspace cross-repo graph 可信并且可直接查询。用户应该能验证已持久化的 provider/consumer link 是否仍然有效；agent 应该能在不修改 source file 的前提下询问“谁消费 provider X？”或 preview cross-repo resolution。

## 用户结果

在已注册 workspace 中工作的用户应该直接得到三个问题的答案：

- 存储的 cross-repo link graph 内部是否一致？
- 哪些 consumer 依赖这个 provider contract 或 endpoint？
- 这个 consumer file 或 service 依赖哪些 provider？

Agent 也应该通过 MCP 拿到同样答案，并带 compact resource links。如果 provider contract 变化且 W1 显示 cross-repo impact，stale 或 orphan workspace link 应该可诊断，而不是让 impact report 静默地看起来不完整。

## 当前状态

Parallax 已经有 storage 和第一版 workflow：

- `resolveCrossRepoContracts` 扫描已注册 local workspace repo，并在 `cross_repo_links` 中持久化 `CONSUMES_HTTP_ENDPOINT` row。
- `analyzeContractDiff` 为 breaking provider contract change 影响到的 consumer 持久化 `BREAKS_COMPATIBILITY_WITH` row。
- `parallax://workspaces/{name}/cross-repo-links` 暴露已持久化 link。
- W1 已将持久化的 `BREAKS_COMPATIBILITY_WITH` row 暴露到 primary `analyzeDiff` report、graph export、MCP payload 和 UI。
- D2-W1 现在在 `npm run bench` 中 guard 该 W1 path。

缺口是 consistency 与 queryability。Link 以 consumer 到 provider 的方向性 row 存储。现在没有 shared read model 能把 `BREAKS_COMPATIBILITY_WITH` row 与父级 `CONSUMES_HTTP_ENDPOINT` row reconcile，flag 指向已离开 workspace catalog 的 repo 的 link，或为 provider-to-consumer 问题提供 stable reverse index。

## 选择方案

添加 shared cross-repo link read model，以及 read-only verification/query surface。

Read model 应该放在类似 `src/cross_repo_links.ts` 的 focused module 中。它读取 `cross_repo_links`、parse provenance、join workspace membership，并返回 normalized records 与 diagnostics。现有 producer 继续写 canonical directional rows。新 layer 让这些 row 可双向遍历，但不存储冗余 inverse row。

这个定义很重要：“Bidirectional consistency” 指一个 canonical link 能通过 helper 被 provider-to-consumer 与 consumer-to-provider 双向查询。它不是指写入重复 inverse row。重复 inverse storage 会制造第二个 staleness 问题，让 repair 更难。

## 备选方案

### A. 带 verification 与 reverse indexes 的 shared read model（选择）

这让 write 保持简单，减少 SQL/provenance duplication，并让 CLI、MCP、UI 与 future analyzer 使用同一个答案。它也符合 local-first SQLite model，不需要 schema migration。

Tradeoff：implementation 必须仔细建模 malformed legacy provenance 与 stale membership rows，而不能依赖当前会隐藏坏 link 的 inner join。

### B. 写入显式 inverse rows

这会让 reverse lookup 在 query 时看起来简单，但它复制了 truth。每个 resolver、diff、repair 和 future migration 都要同步两条 row。

Tradeoff：read 更简单，但 correctness 与 cleanup risk 更高。

### C. 只在现有 SQL 上添加 MCP tools

这能满足狭窄的 agent query surface，但 CLI 与 UI 仍然缺少可靠 consistency check，未来代码也很可能再次复制 parsing logic。

Tradeoff：slice 更小，foundation 更弱。

## Read Model

引入接近如下形状的 shared API：

```ts
type CrossRepoLinkKind = 'CONSUMES_HTTP_ENDPOINT' | 'BREAKS_COMPATIBILITY_WITH';

type CrossRepoLinkRecord = {
  id: string;
  workspace: string;
  kind: CrossRepoLinkKind;
  confidence: Confidence;
  source: {
    serviceName?: string;
    repoPath?: string;
    path?: string;
    inWorkspace: boolean;
  };
  target: {
    serviceName?: string;
    repoPath?: string;
    contractPath?: string;
    inWorkspace: boolean;
  };
  endpoint?: {
    method: string;
    path: string;
  };
  provenance: unknown;
};

type CrossRepoLinkDiagnostics = {
  malformedLinks: CrossRepoDiagnostic[];
  staleWorkspaceLinks: CrossRepoDiagnostic[];
  orphanBreakingLinks: CrossRepoDiagnostic[];
};
```

精确 type 名可以在实现中调整，但 boundary 应保持稳定：

- 一个 loader 为一个 workspace normalize rows；
- 一个 verifier 返回 diagnostics 和 counts；
- `consumersOf(...)` 按 provider service、contract、endpoint 或 route 返回 consumers；
- `providersFor(...)` 按 consumer service、file 或 endpoint evidence 返回 providers。

该 module 在 integrity verification 中必须使用 `LEFT JOIN`，这样 stale link 才会可见。只想展示当前 joined links 的 resource reader 可以继续使用更严格的 join，但 verification 不能隐藏 broken references。

## Consistency Rules

Verification 应 deterministic 地分类这些情况：

- **Malformed link:** provenance 不是 valid JSON，或缺少该 kind 所需的 provider、consumer、endpoint、change、evidence fields。
- **Stale workspace link:** `source_repo_id` 或 `target_repo_id` 不再映射到 link workspace 的当前 `workspace_repos` row，或 provenance repo path 与当前 catalog member path 冲突。
- **Orphan breaking link:** 同一 workspace 内存在 `BREAKS_COMPATIBILITY_WITH` row，但没有同 consumer repo/path、provider repo/contract、method/path 的父级 `CONSUMES_HTTP_ENDPOINT`。

Contract baseline freshness 不在本 slice 范围内。Provider contract 可能已变化但尚未重新运行 `workspace resolve-contracts` 或 `workspace contract-diff`。Verifier 应报告 graph consistency，而不是证明每个 repo 都拥有最新可能分析。

## CLI Surface

添加 read-only workspace commands：

```bash
parallax workspace verify [--name <name>] [--json]
parallax workspace consumers --provider <service> [--contract <path>] [--method <method>] [--path <route>] [--name <name>] [--json]
parallax workspace providers --consumer <service> [--file <path>] [--name <name>] [--json]
```

`workspace verify` 打印 compact human summary；如果发现 malformed、stale 或 orphan links，则 non-zero 退出。JSON output 为 machine use 返回相同 counts、diagnostic rows 与 `resources` object。

`workspace consumers` 与 `workspace providers` 使用同一个 read model。它们不运行 resolution 或 contract diff。如果没有 matching rows，则返回 empty result，并附带 warning 表示 persisted links 可能需要 refresh。

## MCP Surface

添加 read-only agent query tools：

- `parallax_cross_repo_consumers`
- `parallax_cross_repo_providers`
- `parallax_resolve_cross_repo_contracts`

`parallax_cross_repo_consumers` 和 `parallax_cross_repo_providers` 查询已持久化 links，并设置 `readOnlyHint: true`。

`parallax_resolve_cross_repo_contracts` 应该是 preview tool，而不是与 CLI 相同的 write path。Refactor `resolveCrossRepoContracts`，使其接受 `persist?: boolean` option。现有 CLI 以 default write mode 调用，保持当前 persisted behavior。MCP preview 以 `persist: false` 调用，返回 proposed links 与 warnings，并且不得 clear 或 insert `cross_repo_links` rows。

这符合 invariant I-8。标记为 read-only 的 MCP tools 不修改 source file 或 workspace link tables，除了 `docs/mcp.md` 已记录的 local telemetry rows。如果未来需要持久化 cross-repo resolution 的 MCP write tool，它必须使用单独名称、标注 `readOnlyHint: false`，并作为显式 write surface 文档化。

## Error Handling

- Missing workspace：返回与现有 workspace commands 一致的 typed error。
- Empty workspace：verify 以 zero links 和 warning 成功。
- Malformed provenance：bulk verification 不 throw；纳入 deterministic diagnostics。
- Query filters 无 match：返回 empty list 和 resource links，而不是 error。
- Route filters 必须 normalize method case，但保留 route path text。
- Absolute local paths 如果已存在于 workspace catalog，可以出现在 local CLI JSON 中；但 MCP compact results 应优先使用 service names、contract paths、consumer paths 与 `parallax://` resources。

## Tests

Implementation 必须添加 focused coverage：

1. `workspace verify` 对含 matching `CONSUMES_HTTP_ENDPOINT` 与 `BREAKS_COMPATIBILITY_WITH` rows 的 workspace 报告 success。
2. Parent consume link 被删除后，`workspace verify` flag orphan `BREAKS_COMPATIBILITY_WITH` rows。
3. `workspace verify` flag 指向不再属于 workspace catalog 的 repo 的 stale links。
4. Malformed provenance 被计数且 verifier 不 crash。
5. `consumersOf` 按 provider service、contract、method、route filter 返回 consumers。
6. `providersFor` 按 consumer service 与 file path filter 返回 providers。
7. MCP tools 以 `readOnlyHint: true` 和 resource links 暴露 query results。
8. MCP resolution preview 返回 computed links 且不 mutate `cross_repo_links`。
9. 现有 `workspace resolve-contracts`、`workspace contract-diff`、W1 primary cross-repo impact 与 bench coverage 继续通过。

## Documentation

更新：

- `docs/cli-reference*.md`：记录 `workspace verify`、`workspace consumers`、`workspace providers`。
- `docs/mcp*.md`：记录新的 cross-repo MCP tools 与 read-only preview boundary。
- `docs/roadmap*.md`：implementation 落地后勾选 link consistency 项。
- `IMPROVEMENT_OPPORTUNITIES.md`：将 W2 和 W6 标为 shipped 或 partially shipped，并记录 remaining follow-ons。
- `docs/verification*.md`：如果 final implementation 把新 verification command 加入 `npm run verify`，提到 focused verifier tests。

修改 translated pages 时，英文、韩文、中文文档必须 meaning-equivalent。

## Implementation Boundary

本设计不实现：

- stale link 自动删除或 repair；
- `cross_repo_links` 中的 duplicate inverse rows；
- `analyzeDiff` 内 automatic contract diff execution；
- remote repository discovery 或 network cloning；
- monorepo sub-package cataloging；
- 用于持久化 cross-repo resolution 的 permissioned MCP write tool。

第一版 implementation 应诊断并查询。若用户需要自动 cleanup，后续 repair slice 可添加显式 `workspace repair-links --dry-run/--apply` workflow。

## Verification Gate

Implementation 被接受前运行：

```bash
npm run lint
npm test -- --test-name-pattern "workspace|cross-repo|MCP"
npm run test:mcp
npm run bench
npm run verify
```

开发中可以先运行 scoped tests，但 final acceptance 需要 `npm run verify`。

## Spec Self-Review

- Completeness scan：没有 unfinished markers、placeholders 或 open-ended tool names。
- Consistency check：CLI、MCP 与 future UI behavior 都读取同一个 normalized link model。
- Scope check：这是一个聚焦 verification 与 queryability 的 W2+W6 slice；repair、monorepo cataloging、automatic diff refresh 均 out of scope。
- Ambiguity check：read-only MCP resolution 明确是 non-persisting preview，现有 CLI resolution 仍保持 persisted workflow。
