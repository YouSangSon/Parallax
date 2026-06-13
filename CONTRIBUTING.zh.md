# Contributing to Parallax

[English](CONTRIBUTING.md) · [한국어](CONTRIBUTING.ko.md) · **中文**

欢迎贡献。Parallax 是一个 local-first 工具，让 agent 编码工具在改动代码之前
能够更准确地看到影响范围和测试候选。

## 开发环境

需要：

- Node.js `>=24.0.0`
- npm

开始：

```bash
npm install
npm run build
npm test
```

## 工作方式

在改动之前，请先确认以下范围。

- MVP 聚焦于 `init`、`index`、`analyze` 和 read-only MCP。
- Obsidian write sync、graph DB、CodeQL adapter 目前仍属于 deferred scope。
- 默认不添加 MCP write tool。
- file input 必须经过 repo root containment check。
- evidence 在保存或输出之前必须经过 redaction。

## Pull Request 检查清单

在提交 PR 之前，请运行以下命令。

```bash
npm run lint
npm test
npm run test:security
npm run test:mcp
npm run test:install-smoke
npm audit --audit-level=high
```

即使只改了文档，也请至少运行以下命令。

```bash
npm run docs:lint
```

## 测试原则

- 新功能先添加测试。
- 改动 security boundary 时，在 `tests/security.test.ts` 中添加回归测试。
- 改动 MCP surface 时，在 `tests/mcp.test.ts` 中添加 contract test。
- 改动 impact 分析结果时，添加基于 fixture 的测试。

## 提交消息

推荐格式：

```text
feat: add diff parser
fix: reject symlink escapes
docs: update MCP usage
test: cover redaction edge cases
```
