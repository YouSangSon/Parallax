# Impact Trace 진행상황

업데이트: 2026-05-09 (Phase 6 adapter foundations `main` 반영; Phase 6B multi-language + Spring Boot adapter pack next)

비전 / 로드맵 / 용어집: [vision.ko.md](vision.ko.md) · [roadmap.md](roadmap.md) · [glossary.md](glossary.md)
제품 계획서: [Impact Context Layer 제품 계획](impact-context-layer-plan.ko.md) (MCP + UI + AI context 절감 + 정책/제안서 impact)
기준 계획서: [Impact Trace 계획서](impact-trace-plan.ko.md) (영향 분석 축의 원본 P0..P4)
사용 가이드: [agent memory cookbook](agent-memory-cookbook.ko.md)
결정 기록: [Architecture decisions log](decisions.ko.md)
Phase 6 자료: [Phase 6 design](phase6-design.ko.md) · [Phase 6B multi-language + Spring Boot plan](phase6b-ts-accuracy-plan.ko.md)

## 현재 위치

main 기준으로는 Phase 4 P1..P5(agent memory cap/repair/restore/auto-abandon/ANN)와
Phase 6 adapter foundations가 완료된 상태다. 현재 next work는 영향 분석 축의
**Phase 6B multi-language + Spring Boot adapter pack v0 + trusted evidence**다. 이는 Java/Kotlin/Spring Boot/Python/Go/Rust/TS/JS adapter v0,
source-span evidence, git snapshot metadata를 묶어 실제 stack의 첫 high-confidence lane을 닫는 작업이다.

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
| 2026-04-28 | Agent Memory 문서 | agent memory cookbook 작성 (commit `4423743`) |
| 2026-04-28 | Agent Memory M3+M4 | retract 동작 + as_of_tx 시간여행 (recursive CTE) (commit `4562024`) |
| 2026-04-29 | Agent Memory polish | recall current-only mode (window function dedup) (commit `34d185c`) |
| 2026-04-29 | 문서 polish | 전 docs에 mermaid 다이어그램 통합 — 시스템 도식, schema ER, 동작 흐름 (commit `4aadaf2`) |
| 2026-04-29 | Phase 3 design | schema v7, LLM abstraction, reflection, branch GC, dual-voice consensus 설계 기록 작성 |
| 2026-04-29 | Agent Memory Phase 3 | Schema v7 ADD-only — branches.state + transactions.archived + fact_provenance.kind + reflections 테이블 |
| 2026-04-29 | Agent Memory Phase 3 | LLM 4-provider 추상화 (`src/llm.ts`) — stub / ollama / anthropic / openai (env IMPACT_TRACE_REFLECTION_MODEL) |
| 2026-04-29 | Agent Memory Phase 3 | Reflective consolidation (`src/reflection.ts`) — entity별 LLM 요약 + summary fact 추가 + kind='summary' provenance |
| 2026-04-29 | Agent Memory Phase 3 | Speculative branch GC (`src/branch_gc.ts`) — abandonBranch + gcBranches soft-delete via transactions.archived |
| 2026-04-29 | Agent Memory Phase 3 | recall + recallSemantic + trace에 t.archived = 0 필터 추가 |
| 2026-04-29 | 보안 polish | secret 패턴 확장 — Stripe / Google API / npm / JWT / DB URL |
| 2026-04-29 | 보안 polish | LLM fetch에 30s timeout, Anthropic/OpenAI HTTPS 강제, fetch try/catch consistency |
| 2026-04-29 | 결정 기록 | docs/decisions.ko.md (ADR-style 결정 로그) — D-001..D-012 12개 결정 정리 |
| 2026-04-29 | 리뷰 | architect + security-reviewer + typescript-reviewer + tdd-guide 4-agent split-role 리뷰 (2 CRITICAL + 7 HIGH + 2 MEDIUM 발견 → 본 PR에서 모두 해결) |
| 2026-04-29 | Phase 4 핸드오프 | 9개 후보 우선순위 + D-013..D-016 결정 + file:line landmarks 기록 작성 |
| 2026-04-29 | Phase 4 P1 | reflectFacts scaling cap — collectCandidates iterate streaming + entity당 50 fact cap (env IMPACT_TRACE_REFLECT_MAX_FACTS_PER_ENTITY) + prompt footer omitted-count |
| 2026-04-30 | supermemory 분석 | supermemoryai/supermemory의 6개 패턴 후보 평가 (Architect + TypeScript + Code-explorer + 보안 직접 review) 기록 작성 |
| 2026-04-30 | P3-EXPOSE | Lifecycle 타입 + factLifecycle 헬퍼 추가 — attribute_defs.is_code_relation을 'static' \| 'dynamic'으로 expose. 새 컬럼 X (D-013) |
| 2026-04-30 | P2 Profile API | src/profile.ts — profileEntity()가 entity별 static/dynamic/summary 3-bucket view 반환. CLI `profile` + MCP impact_trace_profile (D-014) |
| 2026-04-30 | P6 Skills 패키징 | skills/impact-trace/SKILL.md + references/architecture.md — `npx skills add` 한 줄 install path |
| 2026-04-30 | 결정 기록 | docs/decisions.ko.md에 D-013, D-014 추가 |
| 2026-04-30 | Phase 4 P2/P3 design | D-015, D-016 결정 + 알고리즘 + test plan 기록 작성 |
| 2026-04-30 | Phase 4 P2 | reflect --repair — orphan summary fact 보정 sweep (`repairReflections`) + CLI/MCP wiring + 4 tests |
| 2026-04-30 | Phase 4 P3 | branch --restore — abandoned → active + tx unarchive (`restoreBranch`) + CLI/MCP wiring + 3 tests |
| 2026-04-30 | 결정 기록 | docs/decisions.ko.md에 D-015 (reflect --repair) + D-016 (branch --restore) 추가 |
| 2026-04-30 | PR #1·#2 외부-시점 review | architect/security/typescript/code-reviewer 4-agent 병렬 review — invariant 0 위반, F1·F2·F3·F4·F6 (1 MEDIUM type + 4 HIGH 테스트 갭) fix-now, F5 (prompt footer) follow-up issue #3로 이동. main 76→97 tests로 진척, PR #1·#2 모두 rebase merge |
| 2026-05-01 | Phase 4 P4 | gc-branches에 `--max-age N` flag — `branches.head_tx_id`의 `transactions.ts` (NULL일 시 `branches.created_at`)이 `now − N일` 이전인 active non-main branch를 *동일 패스에서* abandoned로 자동 전환 후 archive sweep까지 진행. 기본값 없음 (D-017 explicit-only). +7 tests = 104 total |
| 2026-05-01 | 결정 기록 | docs/decisions.ko.md에 D-017 (auto-abandon piggybacks on gc-branches --max-age) 추가 |
| 2026-05-01 | Phase 4 P5 | sqlite-vec ANN — per-model `vec_facts_<model_slug>` virtual table (vec0, int8[N]) lazy create, dual-write from remember/reembed, recallSemantic이 ANN path → brute-force fallback. 새 `reindexVec()` + `reindex-vec` CLI for manual backfill. +8 vec.test.ts cases = 112 tests total |
| 2026-05-01 | 결정 기록 | docs/decisions.ko.md에 D-018 (sqlite-vec ANN with per-model vec0 tables, lazy create, brute-force fallback) 추가 |
| 2026-05-04 | Phase 6 adapter foundations | `SemanticAdapter`/`AdapterRun` streaming interface, priority `AdapterRegistry`, `MultiLanguageRegexAdapter` extraction, package public exports fence 추가. 2026-05-09 `main` 반영. |
| 2026-05-04 | Phase 6 attribution | `indexProject()`가 per-adapter `adapter_runs`를 만들고, `index_coverage.adapter_id`, `relations.adapter_run_id`, returned `adaptersUsed`를 adapter별로 귀속. later adapter 실패 시 앞선 completed run을 덮어쓰지 않고 이후 adapter는 skipped로 남김. |
| 2026-05-04 | Phase 6 evidence/fanout | adapter-provided relation evidence를 보존하고 secret redaction 이후 stable evidence ID를 생성. evidence 순서 변경에도 identity가 유지되며, fanout 분석은 multi-evidence join이 relation fanout을 부풀리지 않도록 dedupe. |
| 2026-05-04 | Phase 6 diagnostics/hash/mapping | adapter diagnostic을 coverage diagnostic row와 `adapter_runs.error_summary`에 저장하며 실패 후에도 보존. symbol `entity_versions.content_hash`는 containing file content hash를 포함. relation-kind → memory attribute mapping을 명시화하고 static relation attributes를 `is_code_relation = 1`로 seed/promote. |
| 2026-05-09 | Phase 6B autoplan | `/autoplan` + `/team-builder` 결과를 사용자 실제 stack에 맞춰 multi-language + Spring Boot adapter pack v0/trusted evidence로 정정. [phase6b-ts-accuracy-plan.ko.md](phase6b-ts-accuracy-plan.ko.md) 추가. |
| 2026-05-09 | 제품 계획 | [impact-context-layer-plan.ko.md](impact-context-layer-plan.ko.md) 추가. Claude/Codex MCP integration, local UI explorer, AI context budget 절감, 코드/문서/정책/제안서 impact를 제품 기준으로 정리. |
| 2026-05-10 | Phase 6B ImpactBench | `bench/impact-bench.ts` + `npm run bench` 추가. TS/JS, Java/Kotlin/Spring Boot, Python, Go, Rust, Markdown/workflow/Dockerfile fixture를 deterministic JSON report로 채점해 adapter accuracy와 context-pack readiness 기준선을 만든다. |
| 2026-05-10 | MCP context pack v0 | `impact_trace_context_for_change` 추가. `brief`/`standard`/`deep` budget으로 top impact paths, compact evidence, actions, omitted counts, entity/coverage resource links를 반환하며 full report는 persist하지 않는다. |

## 진행 중

| 단계 | 작업 | 상태 |
|---|---|---|
| Phase 6 | adapter foundations | `main` 반영 완료 |
| Phase 6B | ImpactBench thin spine | `npm run bench`가 `.impact-trace/bench/impact-bench-report.json`를 생성하며 relation recall/precision, affected-file recall, evidence/span, adapter attribution, context-pack readiness를 측정 |
| Phase B | MCP context pack v0 | `impact_trace_context_for_change`로 agent가 작업 전 compact context를 받는 첫 read-only tool 구현. report/graph/evidence pagination은 다음 slice |
| Phase 6B | Java/Kotlin/Spring Boot/Python/Go/Rust/TS/JS adapter v0 | 진행 중. 선언/import/test relation과 Spring Boot endpoint/config/persistence/client relation 정확도 개선 중 |
| Phase 6B | source span persistence | `relation_evidence` line/col/range 저장과 analyzer evidence output은 구현됨. 현재 bench 기준 `spanCompleteness`는 regex baseline 특성상 낮으며 parser-backed depth pass에서 개선 예정 |
| Phase 6B | snapshot-safe indexing | `index_runs` commit/dirty/branch metadata와 stale warning 구현됨. migrated legacy run false-positive warning 회귀 테스트 포함 |
| Phase 6/7 | workspace/cross-repo resolver | schema는 준비, 실제 catalog loading과 contract diff는 예정 |
| Phase 9 | 회사 업무 artifact adapter | schema와 entity kind는 준비, Google Drive/Obsidian/Markdown vault adapter는 예정 |
| Agent Memory Phase 5 | 후보 backlog | MemoryBench, topic clustering, multi-layer reflection, concurrent reflect lock, reembed cleanup은 deferred |

## 최근 검증

| 날짜 | 명령 | 결과 |
|---|---|---|
| 2026-05-09 | `npm test` | **144개 테스트 통과** (`main` @ `3cba0a2`) |
| 2026-05-10 | `npm run bench` | **통과** — score 0.9579, expected relations 19/19, affected-file recall 1.0 |
| 2026-05-04 | `npm run check` | 통과 |
| 2026-05-04 | `npm audit --audit-level=high` | 취약점 0개 |
| 2026-04-29 | `npm run lint` | 통과 (Phase 3 완료 후) |
| 2026-04-29 | `npm test` | **78개 테스트 통과** (Phase 1+2: 43 → Phase 3: +33 → Phase 4 P1: +2) |
| 2026-04-29 | `npm run check` | 통과 |
| 2026-04-29 | `git push origin main` | 통과 (10 새 커밋 push, `073637c..4aadaf2`) |
| 2026-04-28 | `npm run test:install-smoke` | 통과 |

## 다음 작업

### Agent Memory 트랙 (완료)

1. ✅ 실제 임베딩 모델 통합 — `@huggingface/transformers` ONNX (Phase 2, commit `43418ec`)
2. ✅ Semantic recall 경로 활성화 — int8 dot product + multi-model embedding (Phase 2, commit `7e86f83`)
3. ✅ Branch merge — multi-parent transactions DAG (Phase 2, commit `0289cc7`)
4. ✅ Reflective consolidation — entity별 LLM 요약 + summary fact (Phase 3, multi-provider)
5. ✅ Speculative branch GC — soft-delete via transactions.archived (Phase 3)

### Impact analysis 트랙 (Phase 6 이후)

5. Java/Kotlin/Spring Boot/Python/Go/Rust/TS/JS adapter v0를 추가해 regex MVP의 정확도 한계를 줄이고, Spring Boot endpoint/config/persistence/test/client relation을 first-class로 만든다.
6. source span, line range, confidence rationale을 persisted `relation_evidence`와 report/MCP output에 추가한다.
7. `index_runs`에 commit SHA, dirty state, branch name을 저장해 snapshot-safe indexing 경고를 정밀화한다.
8. 실제 workspace catalog 파일을 정의하고 여러 repo를 등록/조회하는 CLI를 추가한다.
9. OpenAPI/protobuf/GraphQL/AsyncAPI contract baseline과 breaking-change 분류를 구현한다.

### Agent Memory 트랙 (Phase 5 후보, deferred)

- MemoryBench harness
- topic 클러스터링 reflection (entity별 → 의미 클러스터)
- 다층 reflection (reflection-of-reflections로 long-term memory)
- 동시 reflect 락
- reembed cleanup (구모델 vector drop)

## 기록 규칙

큰 구현 조각이 끝날 때마다 이 문서에 다음 항목을 남긴다.

- 계획서의 어느 단계(P0/P1/P2/P3/P4)에 해당하는지
- 구현한 기능과 아직 남은 제한
- 실행한 검증 명령
- 다음 구현 순서
