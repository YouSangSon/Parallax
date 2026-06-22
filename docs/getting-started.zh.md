# Parallax - 快速上手

[English](getting-started.md) · [한국어](getting-started.ko.md) · **中文**

这是最短但真正可用的一条路径：初始化仓库、建立本地索引、分析一次变更、在 UI 中查看已保存的报告，然后把同一套 read-only surface 暴露给 MCP 客户端或 CI guardrail。

前提：`parallax` CLI 已经在你的 `PATH` 中。

## 1. 初始化仓库

在你要分析的仓库根目录执行：

```bash
parallax init
```

该命令会创建本地 `.parallax/` 目录以及位于 `.parallax/impact.db` 的 SQLite 数据库。

## 2. 建立首个索引

```bash
parallax index
```

首次运行会扫描 working tree，并把文件、entity、relation、evidence 与 coverage 行写入本地数据库。代码或文档变更后，再次运行 `parallax index` 即可刷新图谱。

## 3. 分析一次变更

分析一个显式指定的变更文件：

```bash
parallax analyze --changed src/auth/session.ts --depth 2
```

如果是给机器消费，用 JSON 代替持久化报告：

```bash
parallax analyze --changed src/auth/session.ts --depth 2 --json > report.json
```

具体路径会因仓库而异，但 impact report 大致应类似这样：

```json
{
  "changedFiles": ["src/auth/session.ts"],
  "affectedFiles": [
    { "path": "src/routes/private.ts", "confidence": "proven", "depth": 1 },
    { "path": "tests/session.test.ts", "confidence": "inferred", "depth": 1 },
    { "path": "docs/auth-policy.md", "confidence": "heuristic", "depth": 1 }
  ]
}
```

关键信号在于：Parallax 会把代码、测试、文档、契约或配置上的 blast radius 连同 evidence 与 confidence label 一起排序出来。默认情况下，只要存在受影响文件，`analyze` 就会以退出码 `1` 结束。

## 4. 在 UI 中打开已保存的报告

当你需要本地 explorer 时，使用持久化报告流程：

```bash
parallax analyze --changed src/auth/session.ts --depth 2
parallax ui
```

也可以打开某个特定已保存报告：

```bash
parallax ui --report <report-id> --port 3717
```

UI 会把同一结果展示为 changed -> affected -> evidence -> action 流程，适合查看某个目标为何被排到前面，以及下一步该验证什么。

## 5. MCP 下一步

仓库至少有一次 completed index 后，就可以把同一份本地存储暴露给 MCP 客户端：

```bash
parallax mcp serve
```

把该命令注册为 Claude Code、Codex 或其他 MCP 客户端的 stdio 服务器。服务器会从当前工作目录解析仓库，因此要在你想分析的仓库里启动它。完整 tool/resource surface 见 [mcp.zh.md](mcp.zh.md)。

## 6. CI 或 guardrail 下一步

对于分支或 PR，可以直接分析 git diff：

```bash
parallax analyze --base main --head HEAD --fail-on proven --json > report.json
```

用 `--fail-on` 决定 guardrail 应该在哪个 confidence 级别触发。对 CI 来说，`proven` 是保守的起点，因为它只会在高置信度 impact 时失败。发布的 `report.json` schema 会随包一起提供，路径是 [`../schemas/impact-report.schema.json`](../schemas/impact-report.schema.json)。校验细节见 [report-schema.zh.md](report-schema.zh.md)。

## 另见

- [cli-reference.zh.md](cli-reference.zh.md) - 每个 CLI 命令、标志与 exit code
- [mcp.zh.md](mcp.zh.md) - stdio 服务器、tool、prompt 与 resource
- [report-schema.zh.md](report-schema.zh.md) - `analyze --json` 的 JSON Schema
- [verification.zh.md](verification.zh.md) - release gate、docs lint、dogfood 与 bench 层
