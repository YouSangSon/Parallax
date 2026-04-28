# Impact Trace 진행상황

업데이트: 2026-04-29

기준 계획서: [Impact Trace 계획서](impact-trace-plan.ko.md)
사용 가이드: [agent memory cookbook](agent-memory-cookbook.ko.md) · [agent DB 탐색 노트](agent-db-exploration.ko.md)

## 현재 위치

원래 P0/P1(Entity Graph Core, Agent Surface/Visualization)을 넘어, 2026-04-28~29
세션에서 **agent memory 레이어**를 본격 통합했다. 같은 SQLite + MCP stdio 기반에
agent의 결정·관찰·근거를 1급 시민으로 저장하는 facts/transactions/branches/
fact_provenance/embeddings/attribute_defs 6개 테이블이 추가됐고, MCP/CLI 양쪽으로
remember·recall·branch·trace·retract 동작이 노출됐다. Phase 2 (실제 임베딩 모델
통합과 semantic recall, branch merge)의 scaffolding까지 준비된 상태.

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
| 2026-04-28 | Agent Memory Phase 1 | Schema v4 + WAL + 4 MCP 툴 (remember/recall/branch/trace) + 4 1급 attributes (commit `ffc4bf4`) |
| 2026-04-28 | Agent Memory Phase 1.5 | 인덱서 듀얼 라이트 — relations → facts/transactions (commit `b543ce3`) |
| 2026-04-28 | Agent Memory Q1+Q2 | CLI 4 명령 + retract sugar + tools/list 검증 + init이 ensureRepo 호출 (commit `51b09b0`) |
| 2026-04-28 | Agent Memory M1 | 인덱서 evidence_snippet fact + fact_provenance 인과 사슬 — Bet B 완성 (commit `650104f`) |
| 2026-04-28 | Agent Memory P1+P2 | sqlite-vec extension 통합 + embedding 파이프라인 (stub) + redact-then-embed 게이트 (commit `d0c5cce`) |
| 2026-04-28 | Agent Memory 문서 | docs/agent-db-exploration.ko.md (탐색 노트) + docs/agent-memory-cookbook.ko.md (cookbook) 작성 (commit `4423743`) |
| 2026-04-28 | Agent Memory M3+M4 | retract 동작 + as_of_tx 시간여행 (recursive CTE) (commit `4562024`) |
| 2026-04-29 | Agent Memory polish | recall current-only mode (window function dedup) (commit `34d185c`) |
| 2026-04-29 | 문서 polish | 전 docs에 mermaid 다이어그램 통합 — 시스템 도식, schema ER, 동작 흐름 (commit `4aadaf2`) |

## 진행 중

| 단계 | 작업 | 상태 |
|---|---|---|
| P0 | snapshot-safe indexing | completed run만 읽는 경로는 유지, commit/dirty metadata와 atomic staging 강화 필요 |
| P1 | workspace/cross-repo resolver | schema는 준비, 실제 catalog loading과 contract diff는 예정 |
| P1 | 회사 업무 artifact adapter | schema와 entity kind는 준비, Google Drive/Obsidian/Markdown vault adapter는 예정 |
| P2 | semantic adapter | regex MVP는 동작, Tree-sitter/LSP/CodeQL 정확도 개선 예정 |
| Agent Memory Phase 2 | semantic recall | sqlite-vec 통합 + embedding 파이프라인 scaffolding 완료, 실제 모델(Ollama/OpenAI/Cohere) swap-in과 vec_search wiring 예정 |
| Agent Memory Phase 2 | branch merge | 두 branch facts 합쳐 새 tx로 만들기 (multi-parent tx 스키마 결정 필요) |
| Agent Memory Phase 3 | reflective consolidation | 오래된 episodic facts를 LLM이 자동 요약해 semantic 계층으로 승격 |
| Agent Memory Phase 3 | speculative branch GC | abandoned branch의 fact 정리 (content-addressable이라 다른 branch에서 참조 안 되는 fact만) |

## 최근 검증

| 날짜 | 명령 | 결과 |
|---|---|---|
| 2026-04-29 | `npm run lint` | 통과 |
| 2026-04-29 | `npm test` | 38개 테스트 통과 |
| 2026-04-29 | `npm run check` | 통과 |
| 2026-04-29 | `git push origin main` | 통과 (10 새 커밋 push, `073637c..4aadaf2`) |
| 2026-04-28 | `npm run test:install-smoke` | 통과 |

## 다음 작업

### Agent Memory 트랙

1. 실제 임베딩 모델 통합 — `src/embeddings.ts`의 stub을 Ollama / OpenAI / Cohere / Voyage 중 하나로 교체. 비용/지연/품질 trade-off 비교 + 로컬-우선 정책에 맞는 선택.
2. Semantic recall 경로 활성화 — `recall(query: "...")`가 sqlite-vec virtual table로 실제 ANN 검색하도록 SQL 작성.
3. Branch merge — multi-parent transaction 스키마 (transaction_parents 분리 테이블 또는 parent_tx_ids JSON 필드) + recall이 두 부모 모두 walk 하는 recursive CTE.
4. Reflective consolidation — 오래된 facts를 LLM이 요약해 semantic 계층으로 승격하는 background 작업 정의.

### 기존 트랙 (지속)

5. 실제 workspace catalog 파일을 정의하고 여러 repo를 등록/조회하는 CLI를 추가한다.
6. OpenAPI/protobuf/GraphQL/AsyncAPI contract baseline과 breaking-change 분류를 구현한다.
7. TypeScript Compiler API 또는 Tree-sitter adapter로 regex MVP의 정확도 한계를 줄인다.
8. 회사 업무 artifact adapter를 설계한다. 우선 Markdown/Obsidian vault, 그 다음 Google Drive/Docs/Sheets 같은 외부 connector를 붙인다.
9. source span, line range, confidence rationale을 evidence에 추가한다.

## 기록 규칙

큰 구현 조각이 끝날 때마다 이 문서에 다음 항목을 남긴다.

- 계획서의 어느 단계(P0/P1/P2/P3/P4)에 해당하는지
- 구현한 기능과 아직 남은 제한
- 실행한 검증 명령
- 다음 구현 순서
