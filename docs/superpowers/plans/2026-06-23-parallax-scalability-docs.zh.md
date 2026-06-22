# Parallax 可扩展性与文档实施计划

**中文** · [English](2026-06-23-parallax-scalability-docs.md) · [한국어](2026-06-23-parallax-scalability-docs.ko.md)

> **For agentic workers:** 执行本计划时使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`。代码级详细步骤保留在 canonical 英文文档中。

**目标:** 先修复 S1 incremental indexing 后发现的已保存 report graph 回归，再补上扩展性测量和文档漂移修复。

**架构:** Parallax 的核心契约是 local-first SQLite、evidence-first report、confidence disclosure，以及已保存 report 可再次查看。后续 index run 不应让旧 report 的 graph resource 变空。

## 全局约束

- 保持 `docs/invariants.zh.md` 中的 local-first、additive migration、explicit trigger、evidence-first 原则。
- bugfix 和行为变更使用 TDD。
- 完成的 slice 保持小提交；只有当前用户指令或明确批准允许时才 push。
- 不留下 UI、demo、test、bench 后台进程。
- 代码 slice push 前必须通过 `npm run verify`。

## Task 1: Incremental reindex 后保留已保存 report graph

修改范围:

- `tests/parallax.test.ts`
- `src/graph.ts`
- 必要时 `src/indexer.ts`

核心验证:

```bash
node --import tsx --test tests/parallax.test.ts --test-name-pattern "exportImpactGraph keeps a saved report graph stable|exportImpactGraph renders report graph"
npm run check
npm run docs:lint
npm run verify
```

意图:

- 创建旧 report 后运行新的 incremental index。
- 用同一个 `reportId` 再次导出 graph。
- 以 source/target/kind/confidence 为准的 graph edge signature 必须保持。

## Task 2: 测量 full vs incremental indexing 成本

修改范围:

- `bench/impact-perf.ts`
- `bench/synthetic-repo.ts`
- 必要时增加 perf 输出 formatter test

意图:

- 分别测量 full initial index、no-op incremental、single-file incremental、analyze without persistence、analyze with persistence。
- timing 非确定性，因此不放入 deterministic `ImpactBenchReport`。

## Task 3: 修复 packaged documentation drift

修改范围:

- `docs/getting-started.md`
- `docs/getting-started.ko.md`
- `docs/getting-started.zh.md`
- `README*.md`
- `docs/README*.md`
- `package.json`
- `tests/package_metadata.test.ts`

意图:

- package 内文档引用的 schema artifact 也应包含在 package 中。
- 增加带 expected output 的 getting-started walkthrough。

## Task 4: 整理剩余 high-leverage follow-up

修改范围:

- `IMPROVEMENT_OPPORTUNITIES.md`
- `docs/roadmap.md`
- `docs/roadmap.ko.md`
- `docs/roadmap.zh.md`

意图:

- 不再把已经 shipped 的 MCP prompts、`--fail-on`、reverse graph query 支持留作 stale open item。
- 明确记录 crash-atomic indexing、primary analyze cross-repo impact、S1 perf measurement 这些 follow-up。
