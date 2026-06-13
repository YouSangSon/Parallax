# Parallax — MCP 参考

[English](mcp.md) · [한국어](mcp.ko.md) · **中文**

Parallax 提供一个 MCP（Model Context Protocol）**stdio** 服务器，让 Claude Code、Codex 等编码代理能够读取由同一 SQLite 存储驱动（CLI 与 UI 也用它）的 impact graph、agent memory 和分析 surface。本页说明如何运行该服务器，以及它注册的每一个 tool 和 resource。

## 运行服务器

```bash
parallax mcp serve
```

该服务器通过 stdio 讲 MCP（`StdioServerTransport`）。它针对当前工作目录中的 repo 运行——其 `repoRoot` 即启动它的目录，所有读写都进入该 repo 的 `<repo>/.parallax/impact.db`。请至少对 repo 索引一次（`parallax index`），以便 tool 有一个完成的 index run 可读。

## 在 MCP 客户端中注册

将 Parallax 作为 stdio 服务器注册到任何 MCP 客户端。概念上，客户端把 `parallax mcp serve` 作为子进程启动并通过 stdio 通信。在 Claude Code 或 Codex 中，让客户端从你要分析的 repo 指向该命令。由于服务器从工作目录解析 repo，请以目标 repo 为当前目录来启动它。

## read-only-first 不变量

Parallax 遵循不变量 **I-8**（见 [invariants.zh.md](invariants.zh.md)）：agent surface 先稳定一个安全的 read-only 分析层，写权限只在单独的模型与评审之后才加入。每个 tool 都声明一个 MCP `readOnlyHint` 注解。五个 tool 被标注为 `readOnlyHint: true`——`parallax_recall`、`parallax_profile`、`parallax_context_telemetry`、`parallax_doctor`、`parallax_trace`——它们是纯读取。其余 tool 标注为 `readOnlyHint: false`；这包括分析 tool，因为它们在应答时会作为副作用持久化 context-pack 与 telemetry 行，也包括显式的内存写入与 branch 管理 tool。它们之中没有任何一个会修改你的源码树——action 只是建议（不变量 **I-9**）。

## Tool

全部 18 个 tool 都以 `parallax_` 前缀注册。*read-only* 列反映 tool 的 MCP `readOnlyHint` 注解。

| Tool | 角色 | read-only |
| :--- | :--- | :--- |
| `parallax_analyze_diff` | 将变更文件对最新完成的 index 分析并返回完整 impact report | 否 |
| `parallax_context_for_change` | 为变更文件返回一个按 budget（`brief`/`standard`/`deep`）裁剪的 context pack——排序后的 impact path、evidence 引用与 resource link | 否 |
| `parallax_search_context` | 按 keyword、path、symbol、relation provenance 或 evidence snippet 搜索最新 index 并返回排序后的 entity context | 否 |
| `parallax_contract_diff` | 将当前 OpenAPI contract 文件与已索引的 workspace baseline 比较，返回紧凑的 breaking-change impact | 否 |
| `parallax_remember` | 将 agent 观察作为 content-addressable fact 持久化到 branch（`assert`/`retract`） | 否 |
| `parallax_recall` | 按 entity、attribute、branch 查询 fact（可选 semantic） | 是 |
| `parallax_branch` | 从已有 branch（默认 `main`）分叉出新的 memory branch；不复制数据 | 否 |
| `parallax_merge` | 创建 merge transaction，使 target 上的 recall 遍历两个 branch DAG | 否 |
| `parallax_reflect` | 将较旧的 fact 按 entity 分组，把每组汇总为带 provenance 的新 summary fact | 否 |
| `parallax_abandon_branch` | 将 branch 标记为 abandoned，使后续 GC 归档其 transaction（不能 abandon `main`） | 否 |
| `parallax_gc_branches` | 归档 abandoned branch 的 transaction，使 recall 不再暴露它们；fact 本身永不删除 | 否 |
| `parallax_profile` | 将某 entity 的 fact 聚合为 static / dynamic / summary 三个桶 | 是 |
| `parallax_explain_entity` | 为某个已索引 entity 返回紧凑的直接 relation 与 evidence context | 否 |
| `parallax_context_telemetry` | 返回最近的 MCP context tool 运行与 resource 读取，以便查看哪些被展开 | 是 |
| `parallax_doctor` | 返回 read-only 健康报告（schema、最新 index、coverage、adapter run、vector 状态） | 是 |
| `parallax_repair_reflections` | 为 orphan reflection fact 恢复丢失的 provenance edge 与 audit 行（幂等） | 否 |
| `parallax_restore_branch` | 将 abandoned branch 恢复为 active 并 un-archive 其 transaction（幂等） | 否 |
| `parallax_trace` | 从某 fact 沿 evidence chain 回溯遍历 `fact_provenance` edge | 是 |

## Resource

Resource 通过 MCP resource URI 读取。模板 URI 会展开 `{...}` 段；`parallax://coverage/latest` 是固定 URI。

| Resource | URI / 模板 | 角色 |
| :--- | :--- | :--- |
| `parallax_reports` | `parallax://reports/{reportId}` | 已持久化的 impact report JSON 文档 |
| `parallax_entities` | `parallax://entities/{entityId}` | 来自最新完成 index run 的 canonical 已索引 entity |
| `parallax_evidence` | `parallax://evidence/{evidenceId}` | 带 source span、redacted snippet 与 relation context 的 relation evidence |
| `parallax_context_packs` | `parallax://context-packs/{contextPackId}` | 以 content hash 为键、供重复复用的紧凑 context pack |
| `parallax_workspaces` | `parallax://workspaces/{workspaceName}` | workspace catalog 成员关系及到 contract 与 cross-repo impact resource 的 link |
| `parallax_workspace_contracts` | `parallax://workspaces/{workspaceName}/contracts` | 本地 workspace catalog 范围内最新已索引的 contract baseline |
| `parallax_workspace_cross_repo_links` | `parallax://workspaces/{workspaceName}/cross-repo-links` | workspace 范围的 provider/consumer 及 breaking contract impact link |
| `parallax_graphs` | `parallax://reports/{reportId}/graph/{format}` | report 范围的 relationship graph 投影（`mermaid`、`json`、`dot`） |
| `parallax_coverage_latest` | `parallax://coverage/latest` | 最新完成 index run 的 index coverage 行 |

graph export 作为 `parallax_graphs` **resource** 而非 tool 提供：读取 `parallax://reports/{reportId}/graph/{format}`，其中 `format` 为 `mermaid`、`json` 或 `dot` 之一。等价的 CLI 形式是 `parallax graph export`（见 [cli-reference.zh.md](cli-reference.zh.md)）。

## 另见

- [cli-reference.zh.md](cli-reference.zh.md) — 同一存储之上的本地 CLI surface
- [extending-adapters.zh.md](extending-adapters.zh.md) — tool 读取的已索引 graph 如何产生
- [invariants.zh.md](invariants.zh.md) — read-only-first 与 evidence-first 不变量
- [glossary.zh.md](glossary.zh.md) — context pack、evidence、confidence 等术语
