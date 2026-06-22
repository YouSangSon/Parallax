# Parallax — 文档

[English](README.md) · [한국어](README.ko.md) · **中文**

Parallax 是一个 local-first 的代码 impact 分析层——单个 SQLite 存储驱动 CLI、面向编码代理的 MCP 服务器和 UI explorer。本索引链接 `docs/` 中的主要 packaged guide。

## 快速上手

| 文档 | 内容 |
| :--- | :--- |
| [`getting-started.zh.md`](getting-started.zh.md) | 首次使用教程：init、index、analyze、UI、MCP 与 CI guardrail |

## 概念与方向

| 文档 | 内容 |
| :--- | :--- |
| [`vision.zh.md`](vision.zh.md) | 项目愿景 |
| [`value-proposition.zh.md`](value-proposition.zh.md) | 价值主张与差异化 |
| [`roadmap.zh.md`](roadmap.zh.md) | 当前 backlog 与下一批切片 |
| [`invariants.zh.md`](invariants.zh.md) | local-first、脱敏、权限模型等不变量 |
| [`glossary.zh.md`](glossary.zh.md) | 术语表 |
| [`architecture.zh.md`](architecture.zh.md) | Runtime architecture 与扩展地图 |

## 参考

| 文档 | 内容 |
| :--- | :--- |
| [`mcp.zh.md`](mcp.zh.md) | MCP 服务器、tool 与 resource |
| [`cli-reference.zh.md`](cli-reference.zh.md) | 每个 CLI 命令、标志与 exit code |
| [`report-schema.zh.md`](report-schema.zh.md) | `analyze --json` 输出的已发布 JSON Schema |
| [`extending-adapters.zh.md`](extending-adapters.zh.md) | 编写 semantic adapter |
| [`verification.zh.md`](verification.zh.md) | 验证层、测试 script 与 dogfood guard |
| [`operations.zh.md`](operations.zh.md) | Troubleshooting 与运维 runbook |
| [`release-checklist.zh.md`](release-checklist.zh.md) | Release、CI、audit 与 package smoke 检查清单 |

## Source checkout 说明

Repository checkout 还包含 TypeScript source file、test、benchmark fixture，并在 `skills/` 下包含面向 Claude Code / Codex 用户的 Parallax skill。npm package 会发布构建后的 CLI、public docs，以及 `schemas/` 下已发布的 report schema，但不发布 skill directory，因此 packaged docs 不链接到 `skills/`。Architecture 和 release checklist 等 maintainer 文档会在正文中注明何时需要 source checkout。

项目落地页见[根 README](../README.zh.md)。
