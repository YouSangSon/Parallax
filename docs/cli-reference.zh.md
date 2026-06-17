# Parallax — CLI 参考

[English](cli-reference.md) · [한국어](cli-reference.ko.md) · **中文**

`parallax` CLI 是进入 indexing、impact 分析、graph export、agent memory、workspace catalog、诊断、MCP 服务器与 UI 的本地入口。所有命令都针对当前工作目录中的 repo 运行，并读写 `<repo>/.parallax/impact.db`。运行 `parallax --help`（或 `-h`）查看内置摘要。

大多数 machine-oriented 命令可通过 command-specific flag 输出 JSON。`analyze` 默认输出人类可读摘要，`graph export` 默认输出 Mermaid 文本。

## Indexing

| 命令 | 用途 |
| :--- | :--- |
| `parallax init` | 为 repo 创建本地 `.parallax/` 存储与全新数据库 |
| `parallax index [--max-file-bytes <n>]` | 扫描 repo 并提取 entity/relation graph；`--max-file-bytes` 限制每文件扫描大小 |
| `parallax reindex-vec [--model <hf-model>]` | 重建 sqlite-vec ANN 索引；`--model` 选择 embedding 模型 |
| `parallax reembed [--model <hf-model>] [--all]` | 重新计算 fact embedding；`--all` 重嵌入所有 fact，否则仅缺失部分 |

## Analysis

| 命令 | 用途 |
| :--- | :--- |
| `parallax analyze --changed <file[,file]> [--depth <n>] [--max-fanout <n>] [--json]` | 将显式给出的变更文件列表对最新 index 分析 |
| `parallax analyze --base <ref> [--head <ref>] [--depth <n>] [--max-fanout <n>] [--json]` | 从 `git diff <base>...<head>`（默认 head `HEAD`）推导变更文件列表 |

标志：

- `--changed` — 逗号分隔的变更文件（与 `--base`/`--head` 互斥）。
- `--base` / `--head` — Git ref；`--head` 需要 `--base`。若无 `--base`/`--head`/`--changed`，则接受 positional 文件路径。
- `--depth` — ripple 计算的最大 traversal 深度。
- `--max-fanout` — traversal 期间每节点的最大 fan-out。
- `--json` — 输出完整 report JSON 而非摘要，并跳过将 report 写入存储。

默认（无 `--json`）会持久化 report 并打印简短摘要；写入时显示 report 路径。

## Graph

| 命令 | 用途 |
| :--- | :--- |
| `parallax graph export --report <id> [--format mermaid\|json\|dot] [--limit <n>] [--cursor <cursor>]` | 渲染某已存 report 的 relationship graph；默认格式为 `mermaid` |

`--limit` 和 `--cursor` 仅在 `--format json` 下生效。它们使用与 MCP/UI graph JSON pagination 相同的 `nodeOffset:edgeOffset` cursor 和 `1..500` limit contract。

## Agent memory

| 命令 | 用途 |
| :--- | :--- |
| `parallax remember --entity <id> --attribute <name> --value <json\|string> [--branch <name>] [--agent <id>] [--op assert\|retract] [--evidence-fact-ids id1,id2] [--supersedes-fact-ids id1,id2]` | 将 fact 作为 content-addressable 观察持久化 |
| `parallax retract --entity <id> --attribute <name> --value <json\|string> [--branch <name>] [--agent <id>]` | 持久化一次撤回（等价于 `remember --op retract`） |
| `parallax recall [--query <text>] [--semantic] [--entity <id>] [--attribute <name>] [--branch <name>] [--k <n>] [--as-of-tx <tx-id>] [--current-only]` | 按 filter 或 semantic similarity 查询 fact |
| `parallax profile --entity <id> [--branch <name>] [--k <n>] [--as-of-tx <tx-id>]` | 将 entity 的 fact 聚合为 static / dynamic / summary 桶 |
| `parallax trace --fact-id <id> [--depth <n>]` | 遍历某 fact 的 provenance/evidence chain |
| `parallax branch --name <name> [--from <name>]` | 从已有 branch（默认 `main`）分叉出新 branch |
| `parallax branch --abandon <name>` | 将 branch 标记为 abandoned |
| `parallax branch --restore <name>` | 将 abandoned branch 恢复为 active |
| `parallax merge --target <branch> --source <branch> [--agent <id>]` | 将 source branch merge 进 target |
| `parallax reflect [--branch <name>] [--older-than-days <n>] [--entity <id>] [--model <provider:id>] [--agent <id>] [--dry-run]` | 将较旧的 fact 汇总为新的 summary fact |
| `parallax reflect --repair [--branch <name>] [--dry-run]` | 为 orphan reflection fact 恢复丢失的 provenance |
| `parallax gc-branches [--dry-run] [--max-age <days>]` | 归档 abandoned branch 的 transaction；`--max-age` 先 auto-abandon 陈旧的 active branch |
| `parallax import-session --file <path> --format codex\|claude [--branch <name>] [--agent <id>]` | 将 agent 会话 transcript 导入 memory |

通过 `--value` 传入的 `remember`/`recall` 值在可能时按 JSON 解析，否则当作字符串。`--op` 标志接受 `assert` 或 `retract`；`retract` 是 `remember --op retract` 的简写。

## Workspace

| 命令 | 用途 |
| :--- | :--- |
| `parallax workspace init [--name <name>] [--service <service>] [--force]` | 为该 repo 创建或重建 workspace catalog |
| `parallax workspace add-repo <path> [--name <name>] [--service <service>] [--remote <url>]` | 将另一个本地 repo 注册进 workspace catalog |
| `parallax workspace list [--name <name>] [--json]` | 列出 workspace 及其成员 repo |
| `parallax workspace resolve-contracts [--name <name>] [--json]` | 解析 cross-repo 的 provider/consumer contract link |
| `parallax workspace contract-diff --contract <path> [--name <name>] [--provider <service>] [--provider-path <path>] [--json]` | 将 contract 文件与已索引的 workspace baseline 做 diff |

`workspace add-repo` 以 repo 路径作为 positional 参数。cross-repo 范围仅限用户显式注册的本地 repo——无 clone 或网络访问。

## Diagnostics

| 命令 | 用途 |
| :--- | :--- |
| `parallax doctor` | 打印健康报告（schema、最新 index、coverage、adapter run、vector 状态） |

## MCP

| 命令 | 用途 |
| :--- | :--- |
| `parallax mcp serve` | 为当前 repo 启动 MCP stdio 服务器（见 [mcp.zh.md](mcp.zh.md)） |

## UI

| 命令 | 用途 |
| :--- | :--- |
| `parallax ui [--report <id>] [--port <n>]` | 启动本地 UI explorer；`--report` 打开指定 report，`--port` 设置监听端口 |

UI 会一直运行直到被中断（`SIGINT`/`SIGTERM`）；启动时打印其 URL。

## Exit code

| 代码 | 含义 |
| :--- | :--- |
| `0` | 成功 |
| `1` | `analyze` 找到一个或多个 affected 文件（一个有意的 CI/agent 信号，表示变更有 impact），或 `doctor` 发现健康错误 |
| `2` | 命令抛出错误（未知命令、缺失必需标志或其他失败） |

有 impact 时 `analyze` 的 exit code `1` 是有意为之：它让 CI 作业与 agent hook 无需解析 report 即可把"此变更影响其他文件"当作非零信号处理。

## 另见

- [mcp.zh.md](mcp.zh.md) — 同一存储之上的 MCP 服务器 surface
- [extending-adapters.zh.md](extending-adapters.zh.md) — `parallax index` 如何提取 graph
- [invariants.zh.md](invariants.zh.md) — local-first、explicit-trigger、read-only-first 不变量
- [glossary.zh.md](glossary.zh.md) — 术语
