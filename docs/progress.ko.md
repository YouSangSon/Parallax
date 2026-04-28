# Impact Trace 진행상황

업데이트: 2026-04-28

기준 계획서: [Impact Trace 계획서](impact-trace-plan.ko.md)

## 현재 위치

현재 구현은 계획서의 `P0: Entity Graph Core`를 넘어 `P1: Agent Surface/Visualization`
일부까지 진행됐다. 핵심 목표는 기존 file-edge MVP를 유지하면서 canonical
`Entity`/`Relation` 저장 모델을 실제 분석 경로로 전환하고, 에이전트가 MCP resource로
큰 결과물을 나눠 읽을 수 있게 만드는 것이다.

## 완료

| 날짜 | 단계 | 내용 |
|---|---|---|
| 2026-04-28 | MVP | `init`, `index`, `analyze`, `mcp serve`와 read-only MCP tool 구현 |
| 2026-04-28 | 계획 | workspace/cross-repo API/gRPC/event, 관계 시각화, Java/Kotlin/C#/C/C++ 로드맵 문서화 |
| 2026-04-28 | P0 | `entities`, `entity_versions`, `relations`, `relation_evidence`, `adapter_runs`, `index_coverage` 저장 모델 추가 |
| 2026-04-28 | P0 | TS/JS/Markdown 외 Python, Go, Rust, Java, Kotlin, C#, C, C++ 파일과 기본 symbol/dependency 휴리스틱 인덱싱 |
| 2026-04-28 | P0 | `analyze`가 canonical `relations`를 우선 사용하고 legacy `edges`를 fallback으로 사용하도록 전환 |
| 2026-04-28 | P1 | 별도 graph DB 없이 SQLite `entities`/`relations`에서 report 범위 Mermaid/JSON graph export 생성 |
| 2026-04-28 | P0 | bounded multi-hop traversal, cycle protection, depth/fan-out 제한, stale-index warning 추가 |
| 2026-04-28 | P0 | `impact-trace analyze --base <ref> [--head <ref>]` git diff 입력 추가 |
| 2026-04-28 | P0 | oversized file skip과 `index_coverage` 기록을 추가 |
| 2026-04-28 | P1 | DOT graph export와 MCP graph resource 추가 |
| 2026-04-28 | P1 | MCP report/entity/coverage resource 추가 |
| 2026-04-28 | P0/P1 | shell, YAML, JSON, TOML, Dockerfile, Makefile, Terraform, protobuf, GraphQL, CODEOWNERS 파일 인덱싱 추가 |
| 2026-04-28 | P1/P2 | workspace, contract, cross-repo link, work artifact 확장용 schema 추가 |
| 2026-04-28 | 전략 | 사업계획서, PRD, 회의록, 의사결정, KPI, 고객/영업 문서를 future `Entity`로 포함하는 방향 반영 |

## 진행 중

| 단계 | 작업 | 상태 |
|---|---|---|
| P0 | snapshot-safe indexing | completed run만 읽는 경로는 유지, commit/dirty metadata와 atomic staging 강화 필요 |
| P1 | workspace/cross-repo resolver | schema는 준비, 실제 catalog loading과 contract diff는 예정 |
| P1 | 회사 업무 artifact adapter | schema와 entity kind는 준비, Google Drive/Obsidian/Markdown vault adapter는 예정 |
| P2 | semantic adapter | regex MVP는 동작, Tree-sitter/LSP/CodeQL 정확도 개선 예정 |

## 최근 검증

| 날짜 | 명령 | 결과 |
|---|---|---|
| 2026-04-28 | `npm run lint` | 통과 |
| 2026-04-28 | `npm test` | 20개 테스트 통과 |
| 2026-04-28 | `npm run check` | 통과 |
| 2026-04-28 | `npm run test:mcp` | 5개 테스트 통과 |
| 2026-04-28 | `npm run test:install-smoke` | 통과 |
| 2026-04-28 | `git diff --check` | 통과 |

## 다음 작업

1. 실제 workspace catalog 파일을 정의하고 여러 repo를 등록/조회하는 CLI를 추가한다.
2. OpenAPI/protobuf/GraphQL/AsyncAPI contract baseline과 breaking-change 분류를 구현한다.
3. TypeScript Compiler API 또는 Tree-sitter adapter로 regex MVP의 정확도 한계를 줄인다.
4. 회사 업무 artifact adapter를 설계한다. 우선 Markdown/Obsidian vault, 그 다음 Google Drive/Docs/Sheets 같은 외부 connector를 붙인다.
5. source span, line range, confidence rationale을 evidence에 추가한다.

## 기록 규칙

큰 구현 조각이 끝날 때마다 이 문서에 다음 항목을 남긴다.

- 계획서의 어느 단계(P0/P1/P2/P3/P4)에 해당하는지
- 구현한 기능과 아직 남은 제한
- 실행한 검증 명령
- 다음 구현 순서
