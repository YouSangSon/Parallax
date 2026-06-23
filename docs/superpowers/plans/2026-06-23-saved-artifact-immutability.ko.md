# Saved Artifact Immutability 구현 계획

**한국어** · [English](2026-06-23-saved-artifact-immutability.md) · [中文](2026-06-23-saved-artifact-immutability.zh.md)

> **agentic worker용:** 이 계획을 실행할 때는 `superpowers:subagent-driven-development` 또는 `superpowers:executing-plans`를 사용한다. 코드 수준의 상세 단계와 정확한 테스트 스니펫은 canonical 영문 문서에 둔다.

**목표:** 저장된 report와 graph export를 명시적인 immutable snapshot으로 만든다. 이후 index cohort, carry-forward, repair, retention, canonical graph row 변경이 생겨도 기존 report graph export가 바뀌면 안 된다.

**아키텍처:** 현재 report는 `reports.json`에 저장된 `ImpactReport` payload를 snapshot으로 갖는다. 최신 report는 relation-bearing evidence를 포함하므로 `exportImpactGraph`는 report JSON edge를 우선 사용하고, canonical/legacy rows는 오래된 report 호환 fallback으로만 사용한다.

## 전역 제약

- local-first SQLite와 additive migration invariant를 유지한다.
- report JSON으로 snapshot 계약을 표현할 수 있으면 schema migration을 추가하지 않는다.
- `analyze --json`은 계속 stdout-only, non-persisted다.
- relation-bearing evidence가 없는 오래된 persisted report도 계속 읽을 수 있어야 한다.
- canonical relation/evidence row가 변조되거나 이후 index cohort로 이동해도 saved report graph output은 안정적이어야 한다.
- push 전 `npm run verify`를 통과한다.

## Task 1: Graph export가 persisted report snapshot을 우선 사용하게 만들기

수정 범위:

- `src/graph.ts`
- `tests/parallax.test.ts`

핵심 검증:

```bash
node --import tsx --test tests/parallax.test.ts --test-name-pattern "immutable graph snapshot"
node --import tsx --test tests/parallax.test.ts --test-name-pattern "exportImpactGraph renders report graph|saved report graph stable|immutable graph snapshot"
```

기대 동작:

- RED: canonical relation/evidence row를 변조하면 현재 구현의 graph export가 바뀐다.
- GREEN: 최신 report는 persisted report JSON의 relation-bearing evidence를 source of truth로 삼아 동일한 graph edge snapshot을 반환한다.
- relation-bearing evidence가 없는 legacy report는 기존 canonical/legacy fallback으로 계속 읽는다.

## Task 2: Snapshot 계약 문서화 및 S7 상태 갱신

수정 범위:

- `docs/invariants.md`
- `docs/invariants.ko.md`
- `docs/invariants.zh.md`
- `docs/roadmap.md`
- `docs/roadmap.ko.md`
- `docs/roadmap.zh.md`
- `IMPROVEMENT_OPPORTUNITIES.md`

핵심 내용:

- I-11로 saved reports / report-scoped graph exports는 stored report JSON snapshot에서 읽는다는 invariant를 추가한다.
- roadmap의 saved report/export immutability 항목을 완료 처리한다.
- backlog의 S7을 shipped로 갱신하고 S1 open text에서 saved-artifact immutability를 제거한다.

검증:

```bash
npm run docs:lint
git diff --check
```

## Task 3: 최종 검증, 리뷰, commit, push

최종 검증:

```bash
npm run verify
```

commit 메시지:

```bash
git commit -m "fix(graph): make saved report exports immutable"
```

read-only review에서 Critical/Important finding이 없으면 `git push origin main`까지 진행한다.
