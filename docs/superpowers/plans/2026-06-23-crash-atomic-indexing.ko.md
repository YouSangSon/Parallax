# Crash-Atomic Indexing 구현 계획

**한국어** · [English](2026-06-23-crash-atomic-indexing.md) · [中文](2026-06-23-crash-atomic-indexing.zh.md)

> **agentic worker용:** 이 계획을 실행할 때는 `superpowers:subagent-driven-development` 또는 `superpowers:executing-plans`를 사용한다. 코드 수준의 상세 단계와 정확한 테스트 스니펫은 canonical 영문 문서에 둔다.

**목표:** index run 중 프로세스가 죽어도 partial `files`, `relations`, `evidence`, `transactions`, branch head 같은 current graph/current-state row가 남지 않게 만든다.

**아키텍처:** async adapter extraction은 SQLite transaction 밖에서 수행한다. adapter가 낸 `IndexEvent`를 메모리에 모은 뒤, graph/current-state write cohort를 하나의 synchronous `BEGIN IMMEDIATE` / `COMMIT` 블록에서 persist한다. 일반 adapter exception에 대한 audit metadata는 기존처럼 보존한다.

## 전역 제약

- `docs/invariants.ko.md`의 local-first SQLite, additive migration, explicit trigger, evidence-first 원칙을 유지한다.
- async 작업은 SQLite transaction 안에 넣지 않는다.
- 동작 변경은 먼저 실패하는 regression test로 증명한다.
- crash 중에는 `branches.main.head_tx_id`가 advance되면 안 된다.
- 일반 adapter failure audit 동작은 보존한다.
- push 전에는 `npm run verify`를 통과시킨다.

## Task 1: crash 재현 테스트 추가

수정 범위:

- `tests/parallax.test.ts`

핵심 검증:

```bash
node --import tsx --test tests/parallax.test.ts --test-name-pattern "crash during adapter processing"
```

기대 RED:

- child process가 adapter event를 하나 emit한 뒤 `process.exit(42)`로 종료된다.
- 현재 구현에서는 auto-commit write path 때문에 crashed run id로 partial graph row가 남아 테스트가 실패해야 한다.

## Task 2: adapter output buffer 후 graph cohort 단일 transaction commit

수정 범위:

- `src/indexer.ts`
- `tests/parallax.test.ts`

핵심 구현:

- `CollectedIndexEvent`, `CollectedIndexRun` 타입을 추가한다.
- `withIndexWriteTransaction<T>(db, body: () => T)` helper를 추가한다.
- adapter processing loop는 `handleEvent`를 즉시 호출하지 않고 event를 collect한다.
- `persistCollectedIndexRun`에서 files/entities/relations/facts/carry-forward/co-change/index completion/branch head advancement를 하나의 synchronous transaction 안에서 persist한다.
- outer `catch`의 `CurrentStateSnapshot.restore`, failed `adapter_runs`, failed `index_runs` audit behavior는 유지한다.

핵심 검증:

```bash
node --import tsx --test tests/parallax.test.ts --test-name-pattern "crash during adapter processing|failed reruns preserve|per-adapter terminal status|preserves diagnostics"
npm run check
```

## Task 3: S2 문서 상태 갱신

수정 범위:

- `IMPROVEMENT_OPPORTUNITIES.md`
- `docs/roadmap.md`
- `docs/roadmap.ko.md`
- `docs/roadmap.zh.md`

핵심 내용:

- S2를 graph/current-state crash-atomic transaction shipped 상태로 표시한다.
- broader retention/export immutability 항목은 별도 open item으로 남긴다.

검증:

```bash
npm run docs:lint
git diff --check
```

## Task 4: 최종 검증, 리뷰, commit, push

최종 검증:

```bash
npm run verify
```

commit 메시지:

```bash
git commit -m "fix(indexer): make index graph writes crash-atomic"
```

read-only reviewer에서 Critical/Important finding이 없으면 `git push origin main`까지 진행한다.
