# Crash-Atomic Indexing 实施计划

**中文** · [English](2026-06-23-crash-atomic-indexing.md) · [한국어](2026-06-23-crash-atomic-indexing.ko.md)

> **For agentic workers:** 执行本计划时使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`。代码级详细步骤和准确测试片段保留在 canonical 英文文档中。

**目标:** 即使 index run 期间进程崩溃，也不能留下看起来仍然 current 的 partial `files`、`relations`、`evidence`、`transactions` 或 branch head 状态。

**架构:** async adapter extraction 保持在 SQLite transaction 之外。先把 adapter 产生的 `IndexEvent` 收集到内存，再在一个同步 `BEGIN IMMEDIATE` / `COMMIT` 块中持久化 graph/current-state write cohort。普通 adapter exception 的 audit metadata 继续按现有行为保留。

## 全局约束

- 保持 `docs/invariants.zh.md` 中的 local-first SQLite、additive migration、explicit trigger、evidence-first 原则。
- 不要把 async 工作放进 SQLite transaction。
- 行为变更先用失败的 regression test 证明。
- crash 期间不能推进 `branches.main.head_tx_id`。
- 保留普通 adapter failure 的 audit 行为。
- push 前必须通过 `npm run verify`。

## Task 1: 添加 crash 复现测试

修改范围:

- `tests/parallax.test.ts`

核心验证:

```bash
node --import tsx --test tests/parallax.test.ts --test-name-pattern "crash during adapter processing"
```

预期 RED:

- child process 在 adapter event emit 后执行 `process.exit(42)`。
- 当前实现因为 auto-commit write path 会留下 crashed run id 的 partial graph rows，测试应失败。

## Task 2: Buffer adapter output，然后单 transaction commit graph cohort

修改范围:

- `src/indexer.ts`
- `tests/parallax.test.ts`

核心实现:

- 添加 `CollectedIndexEvent`、`CollectedIndexRun` 类型。
- 添加 `withIndexWriteTransaction<T>(db, body: () => T)` helper。
- adapter processing loop 不再立即调用 `handleEvent`，而是 collect events。
- 在 `persistCollectedIndexRun` 中，把 files/entities/relations/facts/carry-forward/co-change/index completion/branch head advancement 放入一个同步 transaction。
- 保留 outer `catch` 中的 `CurrentStateSnapshot.restore`、failed `adapter_runs`、failed `index_runs` audit behavior。

核心验证:

```bash
node --import tsx --test tests/parallax.test.ts --test-name-pattern "crash during adapter processing|failed reruns preserve|per-adapter terminal status|preserves diagnostics"
npm run check
```

## Task 3: 更新 S2 文档状态

修改范围:

- `IMPROVEMENT_OPPORTUNITIES.md`
- `docs/roadmap.md`
- `docs/roadmap.ko.md`
- `docs/roadmap.zh.md`

核心内容:

- 将 S2 标记为 graph/current-state crash-atomic transaction shipped。
- broader retention/export immutability 继续作为独立 open item 保留。

验证:

```bash
npm run docs:lint
git diff --check
```

## Task 4: 最终验证、review、commit、push

最终验证:

```bash
npm run verify
```

commit 信息:

```bash
git commit -m "fix(indexer): make index graph writes crash-atomic"
```

read-only reviewer 没有 Critical/Important finding 后，执行 `git push origin main`。
