# Codex 导航指南

[English](CODEX-NAVIGATION-GUIDE.md) · [한국어](CODEX-NAVIGATION-GUIDE.ko.md) · **中文**

## 起始顺序

按 `goal.md` → `PLAN.md` → `GATES.md` → `CONTEXT.md` → `DESIGN.md` 的顺序阅读。只用 `rg` 跟踪当前计划指向的符号和测试。在将记录的 SHA 与 `HEAD` 比较之前，不要把旧的 `.superpowers/sdd/CLAUDE_HANDOFF.md` 当作当前状态。

## 范围所有权

- `src/indexer.ts`、`src/index_delta.ts`、`src/adapters/`：扫描、delta、adapter 与 persistence 契约
- `src/store.ts`：additive SQLite schema 与 migration invariant
- `src/ui*.ts`、`src/ui/`：本地 report workbench
- `tests/`：确定性的 correctness 与 regression gate
- `bench/`：确定性的 quality bench 与 advisory performance measurement
- `docs/`：公开的 EN/KO/ZH 产品、运维与验证契约
- `PLAN.md`、`GATES.md`：当前顺序与证据；`IMPROVEMENT_OPPORTUNITIES.md`：详细 backlog

## 变更导航

修改共享函数前，先枚举所有 caller 与相关测试。优先复用既有契约和 helper，保持外部操作只读，并保留 untracked/user-owned 文件。索引变更必须与 full-index oracle 对比，并明确验证 ignored file、resource limit 和 adapter content 语义。

## Diff Packet

Review packet 应包含 base/head SHA、`git diff --stat`、完整范围 diff、带退出码与计数的命令结果、已知 fallback 和 cleanup 证据。分别陈述 local green、commit、push 与 deployment 证据。
