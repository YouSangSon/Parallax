# Parallax 확장성 및 문서 구현 계획

**한국어** · [English](2026-06-23-parallax-scalability-docs.md) · [中文](2026-06-23-parallax-scalability-docs.zh.md)

> **agentic worker용:** 이 계획을 실행할 때는 `superpowers:subagent-driven-development` 또는 `superpowers:executing-plans`를 사용한다. 상세 task와 코드 수준 단계는 canonical 영문 문서에 둔다.

**목표:** S1 incremental indexing 이후 발견된 저장 report graph 회귀를 먼저 고치고, 그 다음 확장성 측정과 문서 drift를 닫는다.

**아키텍처:** Parallax의 핵심 계약은 local-first SQLite, evidence-first report, confidence disclosure, 저장된 report의 재조회 가능성이다. 이후 index run이 생겨도 과거 report graph가 비어 보이면 UI/MCP report resource 계약이 깨진다.

## 전역 제약

- `docs/invariants.ko.md`의 local-first, additive migration, explicit trigger, evidence-first 원칙을 유지한다.
- bugfix와 동작 변경은 TDD로 진행한다.
- 완료된 slice는 작게 commit하고, 현재 사용자 지시나 명시적 승인이 있을 때만 push한다.
- UI, demo, test, bench 프로세스를 백그라운드에 남기지 않는다.
- 코드 slice는 push 전에 `npm run verify`를 통과해야 한다.

## Task 1: Incremental reindex 이후 저장 report graph 보존

수정 범위:

- `tests/parallax.test.ts`
- `src/graph.ts`
- 필요 시 `src/indexer.ts`

핵심 검증:

```bash
node --import tsx --test tests/parallax.test.ts --test-name-pattern "exportImpactGraph keeps a saved report graph stable|exportImpactGraph renders report graph"
npm run check
npm run docs:lint
npm run verify
```

의도:

- 과거 report를 만든 뒤 새 incremental index를 실행한다.
- 같은 `reportId`로 graph export를 다시 호출한다.
- source/target/kind/confidence 기준의 graph edge signature가 유지되어야 한다.

## Task 2: Full vs incremental indexing 비용 측정

수정 범위:

- `bench/impact-perf.ts`
- `bench/synthetic-repo.ts`
- 필요 시 perf 출력 formatter test

의도:

- full initial index, no-op incremental, single-file incremental, analyze without persistence, analyze with persistence를 분리해서 측정한다.
- timing은 비결정적이므로 deterministic `ImpactBenchReport`에는 넣지 않는다.

## Task 3: Packaged documentation drift 닫기

수정 범위:

- `docs/getting-started.md`
- `docs/getting-started.ko.md`
- `docs/getting-started.zh.md`
- `README*.md`
- `docs/README*.md`
- `package.json`
- `tests/package_metadata.test.ts`

의도:

- package에 포함된 문서가 가리키는 schema artifact도 package에 포함되게 한다.
- expected output이 있는 getting-started walkthrough를 추가한다.

## Task 4: 남은 high-leverage follow-up 정리

수정 범위:

- `IMPROVEMENT_OPPORTUNITIES.md`
- `docs/roadmap.md`
- `docs/roadmap.ko.md`
- `docs/roadmap.zh.md`

의도:

- 이미 shipped된 MCP prompts, `--fail-on`, reverse graph query 지원을 backlog에서 stale open item으로 남기지 않는다.
- crash-atomic indexing, primary analyze cross-repo impact, S1 perf measurement를 명확한 follow-up으로 남긴다.
