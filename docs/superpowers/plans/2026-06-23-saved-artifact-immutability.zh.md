# Saved Artifact Immutability 实施计划

**中文** · [English](2026-06-23-saved-artifact-immutability.md) · [한국어](2026-06-23-saved-artifact-immutability.ko.md)

> **For agentic workers:** 执行本计划时使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`。代码级详细步骤和准确测试片段保留在 canonical 英文文档中。

**目标:** 将已保存 report 与 graph export 明确为 immutable snapshot。后续 index cohort、carry-forward、repair、retention 或 canonical graph row 变化，都不能改变已有 report 的 graph export。

**架构:** 当前 report 在 `reports.json` 中保存 `ImpactReport` payload 作为 snapshot。现代 report 已包含 relation-bearing evidence，因此 `exportImpactGraph` 应优先使用 report JSON edges；canonical/legacy rows 只作为旧 report 的兼容 fallback。

## 全局约束

- 保持 local-first SQLite 与 additive migration invariant。
- 如果 report JSON 足以表达 snapshot 契约，不添加 schema migration。
- `analyze --json` 继续保持 stdout-only、non-persisted。
- 缺少 relation-bearing evidence 的旧 persisted report 仍必须可读。
- 即使 canonical relation/evidence row 被修改或被后续 index cohort 移动，saved report graph output 也必须稳定。
- push 前必须通过 `npm run verify`。

## Task 1: 让 graph export 优先使用 persisted report snapshot

修改范围:

- `src/graph.ts`
- `tests/parallax.test.ts`

核心验证:

```bash
node --import tsx --test tests/parallax.test.ts --test-name-pattern "immutable graph snapshot"
node --import tsx --test tests/parallax.test.ts --test-name-pattern "exportImpactGraph renders report graph|saved report graph stable|immutable graph snapshot"
```

预期行为:

- RED: 修改 canonical relation/evidence row 会导致当前 graph export 改变。
- GREEN: 现代 report 以 persisted report JSON 中的 relation-bearing evidence 为 source of truth，返回相同的 graph edge snapshot。
- 缺少 relation-bearing evidence 的 legacy report 继续通过现有 canonical/legacy fallback 可读。

## Task 2: 文档化 snapshot 契约并更新 S7 状态

修改范围:

- `docs/invariants.md`
- `docs/invariants.ko.md`
- `docs/invariants.zh.md`
- `docs/roadmap.md`
- `docs/roadmap.ko.md`
- `docs/roadmap.zh.md`
- `IMPROVEMENT_OPPORTUNITIES.md`

核心内容:

- 添加 I-11，说明 saved reports / report-scoped graph exports 从 stored report JSON snapshot 读取。
- 将 roadmap 中 saved report/export immutability 项标记为完成。
- 将 backlog 中 S7 标记为 shipped，并从 S1 open text 移除 saved-artifact immutability。

验证:

```bash
npm run docs:lint
git diff --check
```

## Task 3: 最终验证、review、commit、push

最终验证:

```bash
npm run verify
```

commit 信息:

```bash
git commit -m "fix(graph): make saved report exports immutable"
```

read-only review 没有 Critical/Important finding 后，执行 `git push origin main`。
