# Parallax — 运维 Runbook

[English](operations.md) · [한국어](operations.ko.md) · **中文**

当 Parallax 的行为与当前工作树不一致、MCP 设置失败、本地数据库缺失或 CI 失败时，使用本文档。Parallax 的运行状态存储在 `.parallax/impact.db` 中；source file 仍保留在你的仓库里。

## 第一检查

在目标仓库根目录运行：

```bash
parallax doctor
npm run lint
npm test
```

`parallax doctor` 是最快的 health report。它检查数据库、schema version、最新 index、coverage、adapter run、vector 状态和 context telemetry。

## 数据库缺失

症状：

- `parallax doctor` 报告 `database_missing`。
- MCP tool 返回 `.parallax/impact.db` 缺失错误。

修复：

```bash
parallax init
parallax index
parallax doctor
```

如果数据库被误删，重新 index 即可。数据库由本地仓库和显式 memory command 派生。

## Index 过期

症状：

- `analyze` 警告最新 index 来自不同 git commit。
- `analyze` 警告 index 后 working tree dirty state 改变。
- changed file 不在最新 index 中。

修复：

```bash
parallax index
parallax analyze --base main --head HEAD --json
```

如果警告仍存在，运行 `git status --short`，确认 generated file、renamed file 或 ignored file 是否在 index 后改变。

## Coverage 被跳过

症状：

- `doctor` 报告 `coverage_skipped_paths`。
- UI Analysis Trust 面板显示 coverage gap。
- `parallax://coverage/latest` 包含 skipped row。

修复：

1. 在 `parallax doctor` 或 UI 中查看 skipped path 和 reason。
2. 如果文件确实过大，记录该 gap 并保留。
3. 如果文件应被 index，用更高限制重新运行：

```bash
parallax index --max-file-bytes 2000000
```

不要盲目提高 vendored 或 generated 文件的限制。尽量通过 ignore rule 或将其放在 indexed tree 外来处理。

## Adapter 失败

症状：

- `doctor` 显示某个 adapter run 为 `failed`。
- `analyze` 在 `adapterInsights` 中显示 adapter error。

修复：

1. 阅读 adapter `errorSummary`。
2. 用尽可能小的 repository fixture 复现。
3. 在改变 adapter behavior 前，在 `tests/` 下添加测试。
4. 运行：

```bash
npm run check
npm test
npm run test:dogfood
npm run bench
```

Engine change 需要 dogfood 和 bench，因为 unit test 可能通过而真实 graph 已经损坏。

## MCP 设置失败

症状：

- MCP client 无法启动 `parallax mcp serve`。
- Client 中缺少 tools。
- Server 在错误仓库中启动。

修复：

1. 确认 CLI 能启动：

```bash
parallax --help
```

2. 确认工作目录是目标仓库根目录。
3. 运行：

```bash
parallax init
parallax index
parallax mcp serve
```

4. 将 MCP server 作为 stdio command 注册到 client。使用 agent 将要编辑的同一个仓库根目录。

MCP 不会修改 source file。部分 analysis/search 调用会在 `.parallax/impact.db` 中持久化 context-pack 或 telemetry row。

## Node 24 SQLite warning

症状：

- Node 输出 `node:sqlite` experimental warning。

含义：

Parallax 有意使用 Node.js 24 内置 SQLite。当前 Node 版本出现该 warning 属于预期，不代表数据丢失。

行动：

- 保持 Node.js `>=24.0.0`。
- 除非 warning 破坏 CI 的机器解析，否则不要压制它。

## Workspace catalog 问题

症状：

- Cross-repo contract resolution 没有返回 link。
- Repository path 被拒绝。
- Workspace 显示了意外的 service。

修复：

```bash
parallax workspace list --json
parallax workspace init --name platform --service api --force
parallax workspace add-repo ../web --name platform --service web
parallax workspace resolve-contracts --name platform --json
```

Workspace entry 是显式 local path。Parallax 不 clone 仓库，也不扫描用户没有注册的路径。

## CI 失败 triage

CI 先运行 `npm ci`，然后运行 aggregate gate `npm run verify`。在 source checkout 中先本地复现 `npm run verify`，再根据日志里第一个失败的 subcommand 缩小范围。

| 失败 command | 常见含义 | 第一修复 |
| :--- | :--- | :--- |
| `npm run verify` | 某个 release sub-gate 失败 | 在本地重新运行，然后跳到下面第一个失败 subcommand 对应的条目。 |
| `npm audit --audit-level=high` | 当前 lockfile 受 dependency advisory 影响 | 运行 `npm audit fix`，审查 lockfile，再重新运行测试。 |
| `npm run lint` | Typecheck 或 docs lint 失败 | 本地运行命令，先修复第一个报告文件。 |
| `npm run build` | TypeScript compile output 失败 | 运行 `npm run check`，修复 type 或 module error。 |
| `npm test` | 快速 unit/integration suite 失败 | 在本地复现指定 test file。 |
| `npm run test:dogfood` | 真实 self-index graph 回归 | 优先检查 indexer/adapters/analyzer/store 变更。 |
| `npm run bench` | Accuracy 或 retrieval 回归 | 比较 bench report，只有在行为变化是有意的情况下才更新 expectation。 |
| `npm run test:install-smoke` | packaged CLI 无法启动 | 运行 `npm run build && node dist/src/cli.js --help`。 |

## 恢复规则

不确定时，优先创建新的派生状态：

```bash
rm -rf .parallax
parallax init
parallax index
parallax doctor
```

仅在不需要本地 memory fact 的仓库中这样做。如果数据库里有重要决策，删除 `.parallax` 前先 export 或备份。
