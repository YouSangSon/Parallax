# Impact Trace 진행상황

업데이트: 2026-04-28

기준 계획서: [Impact Trace 계획서](impact-trace-plan.ko.md)

## 현재 위치

현재 구현은 계획서의 `P0: Entity Graph Core`를 진행 중이다. 핵심 목표는 기존
file-edge MVP를 유지하면서 canonical `Entity`/`Relation` 저장 모델을 실제 분석 경로로
전환하는 것이다.

## 완료

| 날짜 | 단계 | 내용 |
|---|---|---|
| 2026-04-28 | MVP | `init`, `index`, `analyze`, `mcp serve`와 read-only MCP tool 구현 |
| 2026-04-28 | 계획 | workspace/cross-repo API/gRPC/event, 관계 시각화, Java/Kotlin/C#/C/C++ 로드맵 문서화 |
| 2026-04-28 | P0 | `entities`, `entity_versions`, `relations`, `relation_evidence`, `adapter_runs`, `index_coverage` 저장 모델 추가 |
| 2026-04-28 | P0 | TS/JS/Markdown 외 Python, Go, Rust, Java, Kotlin, C#, C, C++ 파일과 기본 symbol/dependency 휴리스틱 인덱싱 |
| 2026-04-28 | P0 | `analyze`가 canonical `relations`를 우선 사용하고 legacy `edges`를 fallback으로 사용하도록 전환 |
| 2026-04-28 | P1 | 별도 graph DB 없이 SQLite `entities`/`relations`에서 report 범위 Mermaid/JSON graph export 생성 |

## 진행 중

| 단계 | 작업 | 상태 |
|---|---|---|
| P0 | analyzer를 canonical graph traversal 기반으로 확장 | direct reverse relation 우선 조회 완료, multi-hop traversal 예정 |
| P1 | 관계 시각화 | Mermaid/JSON report graph export 완료, DOT/MCP graph resource 예정 |
| P0 | snapshot-safe indexing | schema 기반은 준비, running/completed isolation 강화 필요 |
| P0 | git diff input | 아직 `--changed` 중심, `--base/--head` 예정 |

## 최근 검증

| 날짜 | 명령 | 결과 |
|---|---|---|
| 2026-04-28 | `npm run lint` | 통과 |
| 2026-04-28 | `npm test` | 14개 테스트 통과 |
| 2026-04-28 | `npm run test:install-smoke` | 통과 |
| 2026-04-28 | `git diff --check` | 통과 |

## 다음 작업

1. `analyze`를 1-hop reverse lookup에서 bounded multi-hop traversal로 확장한다.
2. DOT export와 MCP graph resource를 추가한다.
3. workspace catalog schema와 cross-repo contract baseline을 구현한다.
4. `--base`, `--head` git diff 입력과 stale-index warning을 추가한다.

## 기록 규칙

큰 구현 조각이 끝날 때마다 이 문서에 다음 항목을 남긴다.

- 계획서의 어느 단계(P0/P1/P2/P3/P4)에 해당하는지
- 구현한 기능과 아직 남은 제한
- 실행한 검증 명령
- 다음 구현 순서
