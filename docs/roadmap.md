# Impact-trace 통합 로드맵

> 이 문서는 *두 축* (영향 분석 + 에이전트 메모리)의 진척과 다음 작업을 한 페이지로 정리한다.
> *왜* 이 방향인지는 [vision.md](vision.md) / [vision.ko.md](vision.ko.md), 제품 단위 계획은 [impact-context-layer-plan.ko.md](impact-context-layer-plan.ko.md), *왜* 각 결정인지는 [decisions.ko.md](decisions.ko.md), *날짜별 로그*는 [progress.ko.md](progress.ko.md).
> 마지막 업데이트: 2026-05-12 (UI Explorer v0 + TS/JS/JVM/Spring/Python/Go/Rust spans + OpenAPI contract impact baseline + workspace catalog v0 + cross-repo contract resolver v0 + GraphQL/Protobuf/AsyncAPI consumer resolver v0 + OpenAPI nested endpoint/schema diff v0 + Protobuf contract diff v0 + GraphQL contract diff v0 + AsyncAPI contract diff v0 + build-system/package resolver v0 + MCP workspace/contract resources v0 landed; next is full parser/LSP depth, generated-client/event topology, and deeper package/build resolution)

## 한 눈에 보기

```
영향 분석 축                   에이전트 메모리 축
────────────────              ────────────────
P0 (file/edge core)  ✅       Phase 1 (스키마 + MCP 8개)        ✅
P0 (workspace/contract) 🟡    Phase 1.5 (인덱서 dual-write)     ✅
P1 (adapter foundations) ✅   Phase 2 (real embed + semantic) ✅
P1 (multi-language v0) ✅     Phase 3 (reflect + branch GC)    ✅
P1 (Spring Boot v0)  ✅       Phase 4 P1..P5 (cap/repair/restore/auto-abandon/ANN) ✅
P1 (config/CI/infra) ⏳       Phase 5 (5 candidates)            ⏳
P2 (JVM/.NET/native) ⏳
P3 (agent-ready MCP + context budget) 🟡

✅ shipped to main · 🟡 active next slice · ⏳ deferred / not started
```

## 영향 분석 축 (`impact-trace-plan.ko.md`의 P0..P4)

자세한 내용은 `impact-trace-plan.ko.md`. 여기는 *다음 N개* 우선순위만.

### P1 — Multi-language + Spring Boot Adapter Pack v0 (next track)

Phase 6 adapter foundations는 `main`에 반영됐다. 이 작업에는 다음 기반이 들어갔다:

- adapter interface + priority registry scaffold, regex MVP의 adapter 추출
- `indexProject()`의 per-adapter run 생성, coverage attribution, relation `adapter_run_id`
- 실패한 adapter가 있어도 앞선 completed run 상태를 보존하고 이후 adapter는 skipped로 남김
- adapter-provided relation evidence 보존, stable redacted evidence ID, fanout 분석의 multi-evidence join dedupe
- adapter diagnostic을 `index_coverage` diagnostic row와 `adapter_runs.error_summary`로 관측 가능하게 저장
- symbol `entity_versions.content_hash`가 containing file content hash까지 반영
- relation-kind → memory attribute mapping 명시화, static relation `attribute_defs.is_code_relation = 1` seed/promote
- package public exports fence

다음 live work는 [Phase 6B Multi-language + Spring Boot Adapter Pack v0 plan](phase6b-ts-accuracy-plan.ko.md)이다. 완료된 항목: ImpactBench thin spine, TS/JS/JVM-Spring/Python/Go/Rust v0 adapter routing, Spring Boot endpoint/config/persistence/test/client fixture coverage, adapter attribution scoring, TS/JS parser-backed import span v0, JVM/Spring lightweight evidence span v0, Python/Go/Rust lightweight evidence span v0, OpenAPI contract baseline + implementer reverse-link v0, workspace catalog v0, cross-repo contract resolver v0, GraphQL/Protobuf/AsyncAPI consumer resolver v0, OpenAPI endpoint-surface contract diff v0, JSON/YAML nested schema/body diff v0, Protobuf contract diff v0, GraphQL contract diff v0, AsyncAPI contract diff v0, build-system/package resolver v0. 아직 완료로 표시하지 않는 항목: full parser/LSP depth, generated-client/event topology, package-manager/build model depth.

| 우선순위 | 작업 | 이유 / 시작 트리거 |
|---|---|---|
| **A0** | Adapter foundations | 완료. adapter pack series의 prerequisite가 `main`에 있음. |
| **A1** | Java/Kotlin/Spring Boot/Python/Go/Rust/TS/JS adapter v0 routing + ImpactBench | 완료. 실제 stack fixture와 adapter attribution gate가 생김. |
| A2 | parser-backed/lightweight source span depth pass | 부분 완료. TS/JS import/test span, JVM/Spring endpoint/declaration/config/test span, Python/Go/Rust declaration/test span은 landed; full parser/LSP depth는 후속. |
| A3 | Spring Boot depth pass | endpoint/config/persistence/test/client relation을 더 넓힘. `@RestController`, mapping annotations, `@Service`, `@Repository`, `@Configuration/@Bean`, `@ConfigurationProperties`, `application.yml/properties`, Spring test annotations, JPA, Spring Data, Feign/WebClient/RestTemplate. |
| A4 | npm/pnpm/yarn + Maven/Gradle/Cargo/Go workspace 어댑터 | v0 landed: `package.json`, `pom.xml`, `build.gradle(.kts)`, `go.mod`, `Cargo.toml`, `pyproject.toml` manifest-only package graph. 다음은 lockfile/transitive/semver/workspace depth. |
| A5 | YAML / GitHub Actions / Docker / Terraform 어댑터 | enterprise repo의 실제 영향 경로. |
| A6 | OpenAPI / protobuf / GraphQL / AsyncAPI 어댑터 + cross-repo resolver | OpenAPI contract baseline, workspace catalog v0, OpenAPI provider/consumer resolver v0, GraphQL/Protobuf/AsyncAPI consumer resolver v0, endpoint-surface contract diff v0, JSON/YAML nested schema/body diff v0, Protobuf contract diff v0, GraphQL contract diff v0, AsyncAPI contract diff v0는 landed. 다음은 generated-client/event topology와 full parser depth. |
| A7 | Mermaid / DOT / JSON graph export | `analyze` 출력에 그래프 첨부 — 사람이 PR 본문에서 바로 봄. |

### P2 — Enterprise Language Adapter Pack

| 작업 |
|---|
| Java / Kotlin deep adapter (Maven/Gradle, package/class/method, annotation beyond v0) |
| C# / .NET (solution/project ref, namespace/class) |
| C / C++ (header include, function/type, build target) |
| deeper build-system resolver (lockfiles/transitive package graph, dotnet, CMake, Bazel, Make) |
| LSP / CodeQL enrichment (지원 언어에서 reference/call/data-flow) |

### P3 — Agent-Ready MCP

| 상태 | 작업 |
|---|---|
| landed | `impact_trace_context_for_change` — `brief`/`standard`/`deep` budget으로 agent context 사용량을 줄이는 context pack |
| landed | `impact_trace_search_context` — keyword/path/symbol/relation/evidence 검색으로 agent가 파일을 덤프하지 않고 관련 entity를 찾는 context discovery |
| landed | `impact_trace_search_context` ranking v1 — keyword/relation/evidence stream RRF, `rankSignals`, deterministic tie-break |
| landed | `impact_trace_search_context` retrieval depth v0 — natural-language query는 FTS5/BM25 keyword lane, 기존 `fact_embeddings`는 `semanticRank`, matched seed의 1-hop relation neighbor는 `graphProximityRank`로 RRF에 fuse |
| landed | context access telemetry — `context_tool_runs`, `context_resource_accesses`, `impact_trace_context_telemetry` |
| landed | doctor/health surface — `impact-trace doctor`, `impact_trace_doctor` |
| landed | opt-in session import/crystal — `impact-trace import-session --file <path> --format codex|claude`, MCP surface에는 노출하지 않음 |
| landed | `impact_trace_search_context` budget/diversification v0 — optional `brief`/`standard`/`deep` budget으로 returned bytes / estimated tokens / omitted counts를 노출하고 `k>=3` 결과를 path prefix/entity kind/relation kind bucket으로 interleave |
| landed | persistent FTS + retrieval bench v0 — schema v11 `relation_evidence`/selected `facts` FTS projection, MCP evidence/fact FTS stream, ImpactBench schema v2 Recall@budget/ablation metrics |
| landed | graph JSON pagination + typed error envelope v0 — `impact-trace://reports/{id}/graph/json?limit=<1..500>&cursor=<nextCursor>` and parseable `{ code, problem, cause, fix, evidence }` MCP failures |
| landed | agentmemory-informed MCP/security guardrails — exact `tools/list` snapshot, forbidden direct `tools/call` rejection, no implicit HTTP/WebSocket daemon static gate, expanded redaction fixtures |
| landed | explicit supersession lifecycle v0 — `supersedesFactIds` → `fact_provenance.kind='supersedes'` + edge `tx_id`; recall/profile/semantic recall hide superseded facts by current/as-of edge visibility, trace returns edge kind |
| landed | entity persistent FTS + sqlite-vec ANN search lane — schema v14 `search_entities_fts` trigger/backfill/repair, `search_context` semantic ANN-first with brute-force fallback |
| landed | persisted context pack id / repeated-query reuse — schema v15 `context_packs`, `impact-trace://context-packs/{id}`, first full pack + repeated `context_pack_reference` |
| landed | UI Explorer v0 over the same MCP resource shapes — `impact-trace ui`, localhost read-only workbench, report/evidence/graph/coverage/context pack panels |
| landed | MCP workspace/contract resources v0 — `impact_trace_contract_diff`, `impact-trace://workspaces/{name}`, `/contracts`, `/cross-repo-links`로 endpoint diff 결과와 provider/consumer links를 resource-on-demand로 확장 |
| landed | build-system/package resolver v0 — manifest-only package graph를 context pack 입력으로 제공해 package manifest 변경의 downstream impact를 줄인 payload로 전달 |
| active next | full parser/LSP and resolver depth — generated Protobuf clients, richer event topology, lockfile/transitive package graph, language-server-backed references로 v0 heuristics를 보강 |

### P4 — Optional Projections

| 작업 |
|---|
| graph DB projection (Neo4j / FalkorDB / Kuzu — 선택) |
| web graph explorer |
| CodeQL adapter |
| Obsidian dry-run export |
| hotspot / history analytics |

### P5 — Work Artifact Impact

| 작업 |
|---|
| Markdown policy/proposal/PRD/decision classifier — v0 landed: repo-local Markdown path conventions become `policy`/`proposal`/`prd`/`decision` entities |
| Work artifact relation inference — v0 landed: policy/decision `GOVERNS`, proposal `PROPOSES`, PRD/requirement `REQUIRES` |
| frontmatter/heading metadata extraction |
| stale decision/proposal freshness calculation |

---

## 에이전트 메모리 축 (Phase 1..5)

### 완료 (main에 있음)

| Phase | 핵심 산출물 | ADR |
|---|---|---|
| **1** | schema v1..v4, MCP 4개 (analyze_diff, remember, recall, branch) | D-001..D-004 |
| **1.5** | indexer dual-write (canonical relation → fact + evidence_snippet + provenance) | — |
| **2** | real `@huggingface/transformers` 임베딩 + semantic recall + branch merge (multi-parent tx) | D-005..D-007 |
| **3** | schema v7 + 4-provider LLM + reflective consolidation + speculative branch GC | D-008..D-012 |
| **4 P1** | reflect scaling cap + Profile API + factLifecycle + Skill packaging + supermemory adoption review | D-013, D-014 |
| **4 P2** | `reflect --repair` for orphan summary facts | D-015 |
| **4 P3** | `branch --restore` (state + tx unarchive) | D-016 |
| **4 P4** | `gc-branches --max-age N` time-based auto-abandon | D-017 |
| **4 P5** | sqlite-vec ANN, per-model `vec_facts_<model_slug>` lazy create, brute-force fallback, `reindex-vec` CLI | D-018 |

Phase 4 code baseline은 `33c49f0`에서 **112 tests passing**, ADR D-001..D-018, MCP 12개, CLI 16개였다. 현재 작업 브랜치는 session import v0, agentmemory follow-up roadmap, graph pagination/typed errors, MCP/security guardrails, explicit supersession v0를 포함한다.

### Phase 5 후보 (ranked, deferred)

현재 우선순위 요약은 아래 표를 기준으로 본다.

| 순위 | 후보 | 이유 | ETA |
|---|---|---|---|
| **B1** | **MemoryBench harness** — 외부 회귀 신호 framework | 다른 모든 P5 후보의 *대전제*. 측정 도구 없으면 clustering / multi-layer / 새 모델이 정말 더 나은지 알 수 없음. | 1+ week (design doc 선행) |
| B2 | Topic clustering reflection | entity별 reflect를 *주제별*로 확장 (Park 2023 / Letta MemGPT 패턴). | 3-5일 |
| B3 | Multi-layer reflection (reflection-of-reflections) | summary fact 자체를 다음 reflect의 input으로 — 장기 semantic hierarchy. | 3일 |
| B4 | Concurrent reflect lock | 두 프로세스가 같은 entity reflect 시 두 다른 summary 생성. policy 결정 + 락 구현. | 반나절 |
| B5 | Reembed cleanup (`reembed --drop-old-model`) | 모델 swap 후 구모델 vector 행 정리 (`fact_embeddings` + `vec_facts_<old>`). | 반나절 |

---

## 두 축이 만나는 지점

두 축이 *같은 SQLite 위에 살지만 코드는 분리*. 향후 통합 후보:

| 후보 | 시점 | 설명 |
|---|---|---|
| **agent의 영향 분석 결과를 fact로 저장** | 미정 | `analyze` 결과를 자동으로 `remember()` → 재실행 비용 0. ADR 필요 (provenance kind 확장). |
| **memory branch가 git branch와 정렬** | 미정 | git branch checkout이 memory branch를 자동 활성화. `git checkout` hook 또는 명시 명령 (`branch --sync-git`). |
| **profile API의 entity가 impact entity와 매칭** | 미정 | `profileEntity('file:src/foo.ts')`이 *코드 entity의 relations + 메모리 facts*를 함께 반환. |
| **MemoryBench가 영향 분석 정확도도 측정** | Phase 5+ | golden-set fixture가 두 축 모두 cover. |

이 통합은 *기회*이지 *현재 약속*이 아님. Phase 5 작업 중 트리거가 자연스러우면 별도 ADR로 등록.

---

## 사용 가이드

- **다음 작업이 뭔지 알고 싶다** → 이 문서의 "P1 next track" / "Phase 5 후보 ranked" 섹션
- **MCP + UI + context 절감 제품 그림을 보고 싶다** → [impact-context-layer-plan.ko.md](impact-context-layer-plan.ko.md)
- **agentmemory에서 무엇을 가져올지 보고 싶다** → [agentmemory-adoption-review.ko.md](agentmemory-adoption-review.ko.md)
- **왜 이 결정인지 알고 싶다** → [decisions.ko.md](decisions.ko.md) (D-001..D-038)
- **언제 무엇이 들어왔는지 알고 싶다** → [progress.ko.md](progress.ko.md) (chronological log) / [CHANGELOG.md](../CHANGELOG.md) (Phase별 grouping)
- **새 contributor / agent에게 한 페이지로 설명** → [vision.ko.md](vision.ko.md)
- **두 축의 어휘가 헷갈린다** → [glossary.md](glossary.md)

## 이 문서를 갱신할 때

1. Phase가 main에 ship될 때 — "완료" 표에 행 추가, 후보/진행 중 섹션에서 해당 행 제거.
2. 새 ADR이 추가될 때 — 해당 Phase 행의 ADR 컬럼 갱신.
3. P1/P2/P3/P4 영향 분석 축 작업이 시작될 때 — "next track" 표의 우선순위 재정렬.
4. *큰 방향 전환*이 있을 때 — [vision.md](vision.md) 먼저 갱신, 이 문서는 그 다음.
