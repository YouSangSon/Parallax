# Architecture Decisions Log

> **목적:** 프로젝트의 *돌이키기 어려운* 결정과 그 이유를 한곳에 모은다.
> 코드는 변하지만, 결정의 *맥락*은 코드에 남지 않는다. 이 문서가 그 맥락을 보존한다.
> **포맷:** 결정 1개 = 1 섹션. 각 섹션은 *결정·맥락·고려한 대안·결과/위험·관련 commit*.

---

## 색인

| ID | 결정 | 단계 | 일자 |
|---|---|---|---|
| [D-001](#d-001-local-first-single-sqlite-db) | local-first single SQLite DB | P0 | 2026-04-28 |
| [D-002](#d-002-content-addressable-fact-id-sha-256) | content-addressable fact id (SHA-256) | P1 | 2026-04-28 |
| [D-003](#d-003-add-only-schema-migration) | ADD-only schema migration | P1+ | 2026-04-28 |
| [D-004](#d-004-redact-then-embed-zero-row-policy) | redact-then-embed zero-row policy | P1 | 2026-04-28 |
| [D-005](#d-005-async-outside-sqlite-transaction) | async outside SQLite transaction | P1 | 2026-04-28 |
| [D-006](#d-006-multi-parent-transactions-via-transaction_parents) | multi-parent transactions via transaction_parents | P2 | 2026-04-29 |
| [D-007](#d-007-model-agnostic-fact_embeddings-composite-pk) | model-agnostic fact_embeddings composite PK | P2 | 2026-04-29 |
| [D-008](#d-008-multi-provider-llm-via-prefix-sentinel) | multi-provider LLM via prefix sentinel | P3 | 2026-04-29 |
| [D-009](#d-009-explicit-reflect-trigger-no-daemon) | explicit `reflect` trigger (no daemon) | P3 | 2026-04-29 |
| [D-010](#d-010-preserve-original-facts-when-summarizing) | preserve original facts when summarizing | P3 | 2026-04-29 |
| [D-011](#d-011-soft-delete-branch-gc-via-transactionsarchived) | soft-delete branch GC via transactions.archived | P3 | 2026-04-29 |
| [D-012](#d-012-no-llm-or-embedding-sdks-fetch-only) | no LLM or embedding SDKs (fetch only) | P3 | 2026-04-29 |
| [D-013](#d-013-lifecycle-binary-derives-from-is_code_relation-no-new-column) | lifecycle binary derives from is_code_relation; no new column | P4 | 2026-04-30 |
| [D-014](#d-014-profile-api-is-built-on-top-of-recall-not-merged-into-it) | profile API is built on top of recall, not merged into it | P4 | 2026-04-30 |
| [D-015](#d-015-reflect---repair-as-a-separate-trigger) | `reflect --repair` as a separate trigger | P4 | 2026-04-30 |
| [D-016](#d-016-branch---restore-restores-state-and-un-archives-transactions) | `branch --restore` restores state and un-archives transactions | P4 | 2026-04-30 |
| [D-017](#d-017-time-based-auto-abandon-piggybacks-on-gc-branches---max-age) | time-based auto-abandon piggybacks on `gc-branches --max-age` | P4 | 2026-05-01 |
| [D-018](#d-018-sqlite-vec-ann-with-per-model-vec0-tables-lazy-create-and-brute-force-fallback) | sqlite-vec ANN with per-model vec0 tables, lazy create, brute-force fallback | P4 | 2026-05-01 |
| [D-019](#d-019-search-context-uses-persistent-projections-in-read-only-mode) | search_context uses persistent projections in read-only mode | P3 | 2026-05-11 |
| [D-020](#d-020-context-packs-are-persisted-by-cache-key-and-reused-by-reference) | context packs are persisted by cache key and reused by reference | P3 | 2026-05-11 |
| [D-021](#d-021-ui-explorer-is-local-read-only-and-resource-shaped) | UI Explorer is local, read-only, and resource-shaped | P3 | 2026-05-11 |
| [D-022](#d-022-tsjs-import-spans-use-typescript-parser-without-project-resolution) | TS/JS import spans use TypeScript parser without project resolution | P1 | 2026-05-11 |
| [D-023](#d-023-jvmspring-spans-stay-lightweight-before-build-system-resolution) | JVM/Spring spans stay lightweight before build-system resolution | P1 | 2026-05-11 |
| [D-024](#d-024-pythongorust-spans-use-declaration-lines-before-full-resolvers) | Python/Go/Rust spans use declaration lines before full resolvers | P1 | 2026-05-11 |
| [D-025](#d-025-contract-files-reverse-link-to-implementers-before-cross-repo-resolution) | contract files reverse-link to implementers before cross-repo resolution | P0/P1 | 2026-05-11 |
| [D-026](#d-026-workspace-catalog-is-an-explicit-local-allowlist) | workspace catalog is an explicit local allowlist | P0/P1 | 2026-05-11 |
| [D-027](#d-027-cross-repo-contract-resolution-reads-indexed-local-repos-only) | cross-repo contract resolution reads indexed local repos only | P0/P1 | 2026-05-11 |
| [D-028](#d-028-contract-diff-v0-compares-indexed-openapi-endpoints-to-current-files) | contract diff v0 compares indexed OpenAPI endpoints to current files | P0/P1 | 2026-05-11 |
| [D-029](#d-029-mcp-workspace-contract-resources-expand-contract-impact-on-demand) | MCP workspace contract resources expand contract impact on demand | P3/P0 | 2026-05-11 |
| [D-030](#d-030-json-openapi-schema-diff-uses-indexed-compatibility-signatures) | JSON OpenAPI schema diff uses indexed compatibility signatures | P0/P1 | 2026-05-11 |
| [D-031](#d-031-yaml-openapi-schema-diff-reuses-the-compatibility-signature-model) | YAML OpenAPI schema diff reuses the compatibility signature model | P0/P1 | 2026-05-11 |
| [D-032](#d-032-openapi-nested-schema-diff-extends-compatibility-signatures) | OpenAPI nested schema diff extends compatibility signatures | P0/P1 | 2026-05-11 |
| [D-033](#d-033-protobuf-contract-diff-uses-compact-servicerpc-signatures) | Protobuf contract diff uses compact service/RPC signatures | P0/P1 | 2026-05-12 |
| [D-034](#d-034-graphql-contract-diff-uses-compact-schema-signatures) | GraphQL contract diff uses compact schema signatures | P0/P1 | 2026-05-12 |
| [D-035](#d-035-asyncapi-contract-diff-uses-compact-operationmessage-signatures) | AsyncAPI contract diff uses compact operation/message signatures | P0/P1 | 2026-05-12 |
| [D-036](#d-036-graphql-consumer-resolver-links-operation-documents-to-root-fields) | GraphQL consumer resolver links operation documents to root fields | P0/P1 | 2026-05-12 |
| [D-037](#d-037-protobuf-and-asyncapi-consumer-resolver-reuses-the-cross-repo-link-envelope) | Protobuf and AsyncAPI consumer resolver reuses the cross-repo link envelope | P0/P1 | 2026-05-12 |
| [D-038](#d-038-build-system-package-resolver-stays-manifest-only-in-v0) | Build-system package resolver stays manifest-only in v0 | P1/P2 | 2026-05-12 |
| [D-039](#d-039-generated-client-and-event-topology-v0-stays-heuristic-and-schema-neutral) | Generated-client and event topology v0 stays heuristic and schema-neutral | P0/P1 | 2026-05-12 |
| [D-040](#d-040-contract-diff-preserves-event-topology-provenance) | Contract diff preserves event topology provenance | P0/P1 | 2026-05-12 |
| [D-041](#d-041-contract-topology-surface-stays-compact-and-optional) | Contract topology surface stays compact and optional | P0/P1 | 2026-05-12 |

---

## D-001: local-first single SQLite DB

**결정:** 모든 데이터는 `<repo>/.impact-trace/impact.db`에 저장. graph DB, vector store, 외부 서비스 의존 없음. 첫 부팅 시 fresh DB 생성, schema migration은 `openDatabase()` 호출 시 자동.

**맥락:** Claude Code, Codex 같은 에이전트 도구가 *현재 작업 중인 저장소*에 대해 영향도 분석을 빠르게 받아야 함. 외부 서비스 의존은 (a) 사용자 환경마다 셋업 비용 (b) 데이터 외부 유출 (c) offline 사용 불가 — 셋 다 거부.

**고려한 대안:**
- Postgres + 별도 graph DB (Neo4j) — 셋업 비용 큼, 다중 사용자 가정.
- 로컬 KV store (LMDB/RocksDB) — 관계 쿼리에 SQL 필요.
- pgvector 같은 hosted vector — 외부 의존.

**결과/위험:** 백만 row 단위에서 SQLite 한계 만남 (쿼리 늦어짐, ANN index 부족). 대응: schema는 모델 교체 가능하게 추상화, sqlite-vec virtual table은 *선택적* (Phase 4 후보).

**관련 commit:** `ffc4bf4` (Phase 1 init)

---

## D-002: content-addressable fact id (SHA-256)

**결정:** `fact.id = SHA-256(entity || attribute || value_blob || op)`. 같은 (entity, attribute, value, op) 튜플은 항상 같은 id. 즉 dedup 자동.

**맥락:** 에이전트가 같은 관찰을 여러 번 remember할 수 있음. unique-by-content이면 dedup 비용 0.

**대안:**
- random UUID — dedup을 caller가 책임져야 함.
- 시퀀스 PK — distributed/branch merge에서 충돌.

**결과/위험:** value_blob의 minor 변경 (whitespace, JSON key 순서 등)이 다른 fact를 만든다. 대응: `JSON.stringify` 사용 (현재 V8은 key 순서 보장 not guaranteed by spec → 잠재적 risk, 하지만 실측에선 안정). 형식적 canonicalization은 follow-up.

**관련 commit:** `ffc4bf4`

---

## D-003: ADD-only schema migration

**결정:** schema 변경은 *컬럼/테이블 추가*만. DROP, ALTER COLUMN TYPE 같은 destructive op 금지. `CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE INTO schema_versions`, `pragma_table_info` 기반 idempotent ADD COLUMN.

**맥락:** 기존 DB 그대로 v6→v7 자동 마이그레이션이 가능해야 함. 사용자가 "데이터 잃지 않고 업그레이드만"을 신뢰할 수 있어야 함.

**대안:**
- 명시 마이그레이션 명령 (`impact-trace migrate`) — 사용자 부담.
- 데이터 마이그레이션 스크립트 — destructive op 발생 가능.

**결과/위험:** 잘못 설계된 컬럼은 *영원히 남음* (DROP 못 함). 대응: `description` 같은 스키마 변경 신중히. v8 이후 cleanup 명령은 별도 follow-up.

**관련 commit:** v4=`ffc4bf4`, v5=`0289cc7`, v6=`cb50bc3`, v7=Phase 3 (이번)

---

## D-004: redact-then-embed zero-row policy

**결정:** secret 패턴이 든 fact의 value_blob은 `'[REDACTED]'`로 저장 + `redacted=1` 플래그 + `fact_embeddings`에 *행을 만들지 않는다* (zero-row). Phase 3에서 동일 정책이 LLM input/output에도 적용.

**맥락:** Phase 1 보안 모델. 단순히 redacted 텍스트로 임베딩하면 secret의 *의미 공간 위치*가 vector로 leak할 수 있음. 행을 안 만드는 것이 가장 단순한 안전망. Phase 3에서 LLM provider로 보내는 prompt도 secret echo 가능성 차단.

**대안:**
- `[REDACTED]` 텍스트 임베딩 — leak 가능성.
- 별도 secret_facts 테이블 — 두 SELECT 경로 필요.

**결과/위험:** redacted fact는 semantic recall에 절대 안 나타남. *의도된 trade-off*: privacy 우선.

**관련 commit:** `d0c5cce` (sqlite-vec + 게이트), `ffc4bf4` (security.ts redactSecrets), Phase 3 (`src/llm.ts` redact-then-prompt)

---

## D-005: async outside SQLite transaction

**결정:** embedding 계산, LLM 호출 같은 async 작업은 *반드시* SQLite tx 바깥에서 처리. async 끝난 뒤 sync `withAgentMemoryDb` 안에서 짧은 BEGIN/COMMIT으로 write.

**맥락:** `node:sqlite` (DatabaseSync)는 동기. callback이 sync인데 안에 await가 있으면 db 핸들이 너무 일찍 close됨. 한 번 디버깅 비용을 치른 후 invariant로 굳힘.

**대안:**
- async SQLite 라이브러리 (better-sqlite3는 동기, libsql는 async) — 다른 deps.
- Promise를 sync 안에 채워넣기 — anti-pattern.

**결과/위험:** embedding 1회 호출당 50–150ms latency를 caller가 await해야 함. 대응: `rememberOnRepo`/`recallOnRepo`/`reembedFacts`/`reflectFacts` 같은 async wrapper 제공.

**관련 commit:** `ffc4bf4` (패턴 시작), `43418ec` (Phase 2 적용), Phase 3 reflection.ts (이번)

---

## D-006: multi-parent transactions via transaction_parents

**결정:** `transactions.parent_tx_id`는 *primary parent*만 저장 (backward compat). 추가 부모(merge tx에서 source branch head 등)는 별도 `transaction_parents(tx_id, parent_tx_id)` 테이블에 저장. recall은 recursive CTE로 두 부모 모두 walk.

**맥락:** Phase 2 branch merge. merge tx는 두 branch head를 부모로 가짐. 컬럼에 array 저장 거부 (SQLite primitive 위반).

**대안:**
- `transactions.parent_tx_ids JSON` — JSON CTE walk 가능하지만 schema 추적 어려움.
- merge에 별도 fact-copy — content-addressable 위반.

**결과/위험:** transaction graph는 DAG가 됨 (cycle 없음 보장은 caller). recall 비용은 traversal depth에 비례.

**관련 commit:** `0289cc7`

---

## D-007: model-agnostic fact_embeddings composite PK

**결정:** `fact_embeddings(fact_id, model, vector, dim, created_at)` PK=(fact_id, model). 한 fact가 여러 모델의 vector를 동시 보유. 모델 swap 시 점진적 reembed 가능.

**맥락:** Phase 1 v4 `embeddings(fact_id PK, dim64_binary, dim768_int8)`은 *단일 retrieval 전략 + 단일 모델* 가정. 실제로는 사용자가 모델을 바꾸고 싶어함 (한국어 vs 영어 vs Kotlin 같은 코드).

**대안:**
- 모델별 별도 테이블 — schema 폭발.
- single model + reembed 전체 — downtime.

**결과/위험:** vector storage가 model 수만큼 늘어남. 의도 — 사용자가 cleanup 시점 결정.

**관련 commit:** `cb50bc3` (schema v6), `a9c8a92` (reembed CLI)

---

## D-008: multi-provider LLM via prefix sentinel

**결정:** Phase 3 reflection LLM은 4-provider 추상화. env var `IMPACT_TRACE_REFLECTION_MODEL` 하나가 provider + 모델 식별:
- `stub` → in-process 결정적 출력 (CI/test)
- `ollama:gemma2:2b` → Ollama HTTP API
- `anthropic:claude-haiku-4-5` → Anthropic Messages API
- `openai:gpt-4o-mini` → OpenAI Chat Completions API

**맥락:** 사용자가 환경마다 선호 다름. local-first 정체성을 지키려면 Ollama 가능해야 하고, 그러나 Ollama 미설치 환경에서 작동 불가는 거부.

**대안:**
- Ollama-only — API 사용자 막힘.
- Anthropic-only — privacy 정체성 위반.
- 단일 통합 layer (ai SDK) — 의존성 폭발.

**결과/위험:** 4 provider × 각자 API 변경 가능성 — 유지보수 비용. 대응: `fetch`만 사용, 의존성 0 추가, 각 provider는 ~30 LOC.

**관련 commit:** Phase 3 (`src/llm.ts`)

---

## D-009: explicit `reflect` trigger (no daemon)

**결정:** reflective consolidation은 사용자가 명시 명령 (`impact-trace reflect`)으로 시작. cron-style 자동 / 카운트 기반 hook 거부.

**맥락:** 본 프로젝트는 *daemon-less* 정체성. 백그라운드에서 도는 프로세스 없음. 모든 동작은 사용자가 명시. LLM 호출은 *돈/시간이 드는* 작업이라 사용자 동의가 필수.

**대안:**
- (1) 시간 기반 cron — 외부 cron 필요.
- (2) 1000 facts 후 자동 trigger — 예측 불가 latency.

**결과/위험:** 사용자가 reflect를 절대 안 호출하면 episodic memory 누적. 대응: cookbook에 권장 주기 명시 (월 1회).

**관련 commit:** Phase 3 (CLI `reflect`)

---

## D-010: preserve original facts when summarizing

**결정:** reflection은 *summary fact를 추가*만 하고 원본 facts는 보존. 연결은 `fact_provenance` edge에 `kind='summary'`로 표시. retract/archive 안 함.

**맥락:** Letta MemGPT 같은 다른 시스템은 종종 원본을 archive 또는 retract 처리. 본 프로젝트는 *audit trail* 우선. "왜 이 결정을 내렸나"의 답이 되는 source facts는 영원히 살아있어야 함.

**대안:**
- (B) source facts retract — 소급 검색 불가.
- (C) archive 테이블 분리 — 두 SELECT 경로.

**결과/위험:** facts 테이블이 더 빨리 자람. 대응: storage cost trivial vs lost audit trail.

**관련 commit:** Phase 3 (`src/reflection.ts`)

---

## D-011: soft-delete branch GC via transactions.archived

**결정:** branch GC는 facts를 절대 삭제하지 않음. abandoned branch의 *transactions*에 `archived=1` 플래그만 세움. recall/recallSemantic이 `t.archived = 0`으로 자동 필터.

**맥락:** facts는 content-addressable. abandoned branch가 만든 fact가 다른 active branch에서도 참조 가능 (같은 entity/attribute/value). fact 삭제 = active branch 깨짐. transaction archive = 안전.

**대안:**
- hard-delete — 비가역.
- 별도 archived_facts 테이블 — 복잡.

**결과/위험:** archived tx는 영원히 남음. v8 이후 cleanup 옵션 검토. trace()는 archived 무관하게 walk → audit/debug 시 archived branch도 보임 (의도).

**관련 commit:** Phase 3 (`src/branch_gc.ts` + agent_memory.ts recall 필터)

---

## D-012: no LLM or embedding SDKs (fetch only)

**결정:** `@anthropic-ai/sdk`, `openai`, `ollama-js` 같은 vendor SDK 추가 거부. Node 24+ 내장 `fetch`로 직접 REST.

**맥락:** SDK가 주는 가치(retry, streaming, type)는 single-call summarize에 과잉. dep 추가는 본 프로젝트 minimalism 위반.

**대안:**
- ai-sdk (Vercel) — 통합 layer지만 무거움.
- 각 provider SDK — 4개 추가 deps.

**결과/위험:** API spec 변경 시 직접 수정해야 함. 대응: 각 provider 함수가 ~30 LOC라 수정 비용 작음.

**관련 commit:** Phase 3 (`src/llm.ts`)

---

## D-013: lifecycle binary derives from `is_code_relation`; no new column

**결정:** static / dynamic 구분을 위한 새 `attribute_defs.is_static` 컬럼 추가 *안 함*. 기존 `is_code_relation`을 query-time에 `Lifecycle = 'static' | 'dynamic'`으로 derive.

**맥락:** [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory)는 메모리 lifetime을 결정하는 `isStatic` 플래그를 갖고 있다. 우리 분석 결과 *동일 정보가 이미 attribute level에 있음*. `is_code_relation=1` (imports/calls/affects/depends_on)는 영구 코드 구조, `=0` (observed/verified/concern/reflection/...)는 동적 agent 활동.

**대안:**
- 새 `is_static` 컬럼 추가 — 데이터 중복.
- `is_code_relation`을 `lifecycle TEXT`로 rename — schema migration 비파괴적이지만 backward compat 깨짐.

**결과/위험:** Profile API가 lifecycle 분류를 query-time에 derive (`src/profile.ts`의 LEFT JOIN attribute_defs). 새 컬럼 없음. `factLifecycle(db, attribute)` 헬퍼가 단일 진입점.

**관련 commit:** Phase 4 supermemory-best-practices branch (`src/agent_memory.ts:factLifecycle`, `src/types.ts:Lifecycle`).

---

## D-014: Profile API is built on top of recall, not merged into it

**결정:** `profileEntity()` 함수는 `recall()`과 *독립*. `recall()` 시그니처를 modify 하지 않음.

**맥락:** supermemory의 `client.profile()`은 `recall + profile`을 한 함수로 합쳤다. 우리는 분리:
- `recall()`은 *raw history view* (모든 facts, 시간순, 필터 가능)
- `profileEntity()`는 *aggregated snapshot* (한 entity의 static/dynamic/summary 3-bucket view)

명확한 책임 분리.

**대안:**
- `recall({ profile: true })` 옵션 — 한 함수가 두 가지 mode를 가지면 인터페이스 부풀어짐.
- `recall`이 항상 profile 형식 반환 — backward compat 깨짐.
- profile이 recall을 내부 호출 — *추가 round-trip*. 우리는 단일 SELECT + in-memory bucketization로 효율 우선.

**결과/위험:** profile은 자체 SQL을 갖되 *recall과 같은 invariants*를 적용 — `t.archived = 0` 필터, branch scope, redacted facts surface as `[REDACTED]`. 만약 recall에 새 invariant이 추가되면 profile도 함께 갱신해야 함 (코드베이스 검색 시 두 곳 모두 손봐야 함).

**관련 commit:** Phase 4 supermemory-best-practices branch (`src/profile.ts`).

---

## D-015: `reflect --repair` as a separate trigger

**결정:** orphan summary fact (Phase 3 SAVEPOINT atomicity 갭으로 audit row 또는 provenance kind가 누락된 reflection fact)를 보정하는 sweep을 *별도 명령*으로 분리. `impact-trace reflect --repair` (CLI) + `impact_trace_repair_reflections` (MCP).

**맥락:** Phase 3 architect review가 발견한 갭 — `remember()`가 자기 BEGIN/COMMIT으로 commit한 후 SAVEPOINT 안에서 provenance UPDATE + reflections INSERT. 그 사이 crash 시 summary fact만 남고 audit/edge가 없는 *orphan*이 됨. 회복 path 필요.

**대안:**
- (b) 매 reflect 호출 시 자동 repair — 시작마다 추가 비용. 일반 reflect와 격리 안 됨.
- (c) 별도 `repair-reflections` 명령 — CLI 표면 분산.

**결과/위험:** 사용자가 repair를 안 부르면 orphan 누적. 대응: cookbook에 권장 주기 명시 (월 1회 또는 reflect 직후). 동시 두 repair 프로세스: SAVEPOINT가 row-level contention만 처리하므로 정책 결정 필요 — 첫 버전은 *idempotent INSERT OR IGNORE*로 무해.

**관련 commit:** Phase 4 P2 `feat/phase4-p2-p3-repair-restore` branch.

---

## D-016: `branch --restore` restores state and un-archives transactions

**결정:** abandoned branch를 복구하면 *동시에* `branches.state = 'active'`로 변경하고 `transactions.archived = 0` 회수. 한 명령으로 mental model "복구하면 보인다"를 만족.

**맥락:** soft-delete 정책 D-011은 *되돌릴 수 있다*가 핵심 가치인데 Phase 3에선 abandon→archive 한 방향만 있었음. branch state만 active로 되돌리고 archived tx는 그대로면 *recall이 facts를 surface 안 함* — 사용자에게는 "복구가 복구가 아닌" 상태.

**대안:**
- (i) state만 — 위 mental model 위반.
- (iii) 별도 `gc-branches --un` 명령 — 두 단계라 사용자 실수 surface 늘어남.

**결과/위험:** restore 후 facts가 즉시 다시 surface — abandoned 동안 발생한 다른 branch의 활동과 *content-hash로* 같은 fact가 있다면 dedup된 채로 그대로. retire의 "사라짐"은 logical만이고 *fact 자체는 항상 살아있음* (D-011 재확인).

**관련 commit:** Phase 4 P3 `feat/phase4-p2-p3-repair-restore` branch.

---

## D-017: time-based auto-abandon piggybacks on `gc-branches --max-age`

**결정:** 시간 기반 자동 abandon은 *별도 명령*이 아닌 기존 `gc-branches`의 *opt-in flag* `--max-age N`으로 구현. flag 없으면 기존 archive-only sweep과 동일 (backward compat). flag가 있으면 1-패스로 active→abandoned→archived까지 진행. 기준값은 `branches.head_tx_id`의 `transactions.ts`, NULL일 때 `branches.created_at`로 fallback. `main`은 항상 보호. `'merged'` 같은 미래의 다른 상태는 *silently skip* (auto-abandon 후보에서 제외하되 throw하지 않음).

**맥락:** D-011 soft-delete의 핵심 가치는 *오래된 speculative branch가 누적되지 않도록 정리*. 사용자가 `branch --abandon`을 매번 명시적으로 부르는 비용을 줄이려면 시간 기반 자동화가 필요. 그러나 D-009 (no daemon) 정체성을 지키려면 자동 백그라운드 실행은 거부 — 사용자가 *명시 명령*으로 trigger해야 함. `gc-branches`가 이미 해당 의도("정리"이니까)를 갖는 trigger이므로 `--max-age` opt-in이 자연스러움.

**대안:**
- (B) 새 `auto-abandon` 명령 + 별도 `gc-branches` — 두 단계 분리되어 사용자가 둘을 chain해야 함. 명확하지만 호출 비용 ×2.
- (C) `branch --auto-abandon` — 기존 single-name 명령군에 sweep semantics 끼움. 어색.
- (β) `--max-age` 기본값 60일 — UX 편의지만 사용자가 의도하지 않은 큰 sweep 위험.
- (γ) env var 기본값 — 다른 reembed/reflect와 일관성 있으나 *암묵적 정책*은 destructive op에 부적절.

**결과/위험:** 사용자가 30일/60일/90일 같은 자체 정책을 `--max-age`로 명시 — 잘못된 기본 정책으로 의도치 않게 abandon하는 사고 방지. flag 없는 기존 `gc-branches` 호출자는 0 영향. `branches.created_at` fallback이 `'main'`의 SQLite-format ts와 ISO 8601이 섞여있을 수 있으나 main은 PROTECTED_BRANCH로 항상 제외되므로 비교 안전. 미래에 `'merged'` 상태가 도입되면 silent skip — 별도 ADR이 그 처리를 결정.

**관련 commit:** Phase 4 P4 `feat/phase4-p4-auto-abandon` branch.

---

## D-018: sqlite-vec ANN with per-model vec0 tables, lazy create, brute-force fallback

**결정:** 의미 검색(`recallSemantic`)을 sqlite-vec virtual table로 가속. (a) **per-model vec0 테이블** `vec_facts_<model_slug>(fact_id TEXT PK, embedding int8[<dim>])` — 모델마다 dim이 다르므로 single virtual table에 max-dim padding은 storage 낭비. (b) **lazy 생성** — 첫 write 시점에 `CREATE VIRTUAL TABLE IF NOT EXISTS`. (c) **manual backfill + automatic fallback hybrid** — 사용자가 `reindex-vec` CLI로 전체 백필; 그러나 vec table이 없거나 sqlite-vec 확장 로드에 실패하면 *조용히* JS-side brute-force int8 dot product로 fallback. (d) **int8[N]** 형식 유지 (기존 `fact_embeddings.vector` 와 storage parity). (e) **silent fallback on extension load failure** — 기존 caller 회귀 0.

**맥락:** D-007 multi-model + D-001 local-first가 ANN 설계 공간을 좁힘. sqlite-vec dep는 이미 in (`^0.1.9`); 그러나 한 번도 wiring되지 않아 `loadVectorExtension` 함수가 export되었으나 호출 사이트가 0이었음 (`recallSemantic`은 모든 행을 SELECT 후 JS dot product). 1만 행 이상에서 brute-force는 O(N) latency가 사용자 인지 가능 수준. `recallSemantic` 시그니처 호환성 + multi-model 격리가 동시 만족되어야 함.

**대안:**
- (b1) v8 마이그레이션에서 *기존 모델별로* vec table 사전 생성 — 알려진 model이 없으면 의미 없음, lazy가 자연스러움.
- (b2) 첫 db open 시 모든 (model, dim) 그룹 자동 backfill — *blocking first open* 발생 (수만 row × insert latency).
- (c1) explicit reindex만, fallback 없음 — 기존 caller가 성능 회귀 또는 깨짐.
- (1) single virtual table + model 컬럼 + max-dim padding — 768 dim + 64 dim 혼재 시 12배 storage 낭비.
- (2) float[N] — 정확도 약간 ↑, storage 4배.
- (3) bit[N] — 속도 ↑↑, 정확도 약간 ↓ (binary quantization). 추후 별도 optimization.

**결과/위험:** `vec0`는 `INSERT OR REPLACE`를 지원 *안 함* — `DELETE WHERE fact_id = ? + INSERT` 패턴으로 idempotent upsert 구현. raw 768-byte buffer가 vec0에 의해 자동으로 float32 (768/4=192) 인식되는 함정 — `vec_int8(?)` 명시 cast 필수. ANN과 archived/branch 필터 조합: vec0 MATCH는 *전체 인덱스에서 top-k*만 — post-filter로 archived row가 drop되면 결과 부족 가능 → `k * 5` over-fetch (min 20)로 보완. 충분한 k가 안 나오면 LIMIT k 미달이지만 false-positive는 0. 향후 sqlite-vec API 변경 또는 native binary 호환성 issue → silent fallback이 차단막.

**관련 commit:** Phase 4 P5 `feat/phase4-p5-sqlite-vec-ann` branch.

---

## D-019: search_context uses persistent projections in read-only mode

**결정:** `impact_trace_search_context`의 entity keyword lane은 read-only 호출 중 temp FTS table을 만들지 않고 schema v14 `search_entities_fts`를 읽는다. semantic lane은 D-018의 sqlite-vec `vec_facts_<model>` table이 있으면 ANN을 먼저 사용하고, extension/table 부재나 SQL 실패 시 기존 `fact_embeddings` brute-force int8 dot product로 fallback한다.

**맥락:** `search_context`는 agent context를 줄이는 hot path다. 이전 depth v0는 relation evidence/facts만 persistent FTS였고 entity FTS는 read-only 호출마다 temp table을 rebuild했다. large repo에서는 query마다 O(entities) rebuild가 발생하고, semantic lane도 모든 `fact_embeddings`를 scan했다. MCP read-only 호출은 migration/write를 하면 안 되므로 projection 생성·repair는 writable `openDatabase()`에만 있어야 한다.

**대안:**
- temp FTS 유지 — 구현은 단순하지만 large repo에서 반복 query 비용이 계속 발생.
- read-only MCP에서 missing projection을 자동 생성 — read-only 계약 위반.
- ANN-only semantic — sqlite-vec extension이 없는 환경에서 검색 회귀.
- branch argument 추가 — 제품 동작 범위가 넓어짐. 이번 slice는 default-main context search만 유지.

**결과/위험:** schema v14는 `entities` trigger, backfill, restart repair를 추가한다. `search_context`는 항상 `entities.updated_index_run_id = latestCompletedIndexRun` join으로 currentness를 보장한다. sqlite-vec ANN은 post-join visibility filter를 그대로 적용하므로 branch-only/archived/superseded fact가 surface되지 않는다. ANN이 빈 결과 또는 SQL 오류를 내면 brute-force fallback을 사용해 recall을 우선한다. pre-v14 read-only DB는 `schema_outdated`로 `impact-trace init`을 안내한다. context telemetry write는 current-schema projection scan을 건너뛰는 lightweight open을 사용하지만, schema upgrade/missing-table backfill과 명시적인 normal writable open repair 계약은 유지한다.

**관련 commit:** `feat(search): persist entity fts and ann context`

---

## D-020: context packs are persisted by cache key and reused by reference

**결정:** `impact_trace_context_for_change`는 schema v15 `context_packs` table에 compact `ContextPack`만 저장한다. 첫 호출은 기존 full compact pack shape를 유지하되 `contextPackId`, `resourceUri`, `contentHash`, `reused=false`, `resources.contextPack`을 추가한다. 같은 cache key가 다시 요청되면 기본 `reusePolicy='auto'`는 `kind='context_pack_reference'`, `reused=true`, pack id/resource URI, budget/indexRunId, 작은 summary만 반환하고 `context`/`actions`/`evidence` arrays는 재전송하지 않는다. 필요하면 `impact-trace://context-packs/{contextPackId}` resource를 읽어 full pack을 복원한다.

**맥락:** Impact Trace의 핵심 목표는 Claude/Codex 같은 coding agent가 전체 repo/report를 반복으로 받지 않게 하는 것이다. 기존 `context_for_change`는 report persistence를 피했지만, 같은 changed file/budget 호출을 반복하면 같은 compact payload를 계속 전송했다. agent workflow에서는 "한 번 본 context"를 이후 turn에서 resource id로 지칭할 수 있어야 token 절감이 커진다.

**대안:**
- report JSON 재사용 — full report persistence를 다시 도입해 context 절감 목표와 privacy boundary가 흐려짐.
- content hash만으로 reuse — changed-file content/git snapshot/depth/fanout이 달라도 pack output이 우연히 같으면 stale mental model을 만들 수 있음.
- always reference-only — 첫 호출 backward compatibility가 깨지고 agent가 한 번 더 resource read를 해야 함.
- in-memory cache — MCP process 재시작 시 사라져 local-first memory substrate와 맞지 않음.

**결과/위험:** cache key는 contract version, latest indexRunId, normalized changed files, effective budget/depth/fanout, changed-file content hashes, current git snapshot을 포함한다. pack id는 request cache key에서, `contentHash`는 full compact pack JSON에서 나온다. repeated response는 작지만 union shape이므로 `kind='context_pack_reference'`를 명시한다. context pack resource read는 `context_resource_accesses.resource_kind='context_pack'`로 기록된다. v0에는 TTL/GC가 없으므로 DB 성장은 후속 cleanup 정책에서 다룬다. pre-v15 read-only DB는 `schema_outdated`로 `impact-trace init`을 안내한다.

**관련 commit:** `feat(context): persist reusable context packs`

---

## D-021: UI Explorer is local, read-only, and resource-shaped

**결정:** 첫 UI는 `impact-trace ui` CLI가 여는 `127.0.0.1` read-only workbench로 제한한다. 첫 화면은 landing page가 아니라 최신 impact report의 Change Set, Impact Paths, Evidence, Focused Graph, Verification Queue, Doctor Findings, Context Packs, Coverage Gaps를 바로 보여준다. JSON endpoint는 persisted `ImpactReport`, `GraphExport`, coverage, context pack shape를 재사용한다.

**맥락:** 제품 목표는 Claude/Codex가 받는 context를 줄이는 것과, 사람이 같은 근거를 눈으로 검증하는 것이다. UI가 별도 product surface나 cloud dashboard로 커지면 로컬 SQLite provenance와 MCP resource contract가 흐려진다. v0는 사람이 agent와 같은 report/resource를 보는 최소 workbench여야 한다.

**대안:**
- React/SPA + bundler 도입 — 빠르게 화려해질 수 있지만 dependency와 build surface가 커지고 core CLI 검증이 느려진다.
- cloud/team dashboard — 현재 local-first identity와 보안 경계를 벗어난다.
- report markdown만 생성 — 사람이 훑기 쉽지만 graph/resource/API contract와 drift가 생긴다.
- UI에서 index/analyze/write action 제공 — 편하지만 v0 read-only 안전 모델을 깨고 의도치 않은 repo-local write를 늘린다.

**결과/위험:** UI server는 loopback host에만 bind하고 DB를 read-only로 연다. 기본 포트가 사용 중이면 빈 포트로 fallback한다. `/api/reports/{id}/graph/json`은 `limit/cursor` pagination을 유지해 큰 graph를 한 번에 밀어 넣지 않는다. v0는 vanilla HTML/CSS/JS라 유지비가 작지만, session timeline, rank feedback, multi-repo workspace view 같은 richer interaction은 후속 slice에서 별도 설계가 필요하다.

**관련 commit:** `feat(ui): add local report workbench`

---

## D-022: TS/JS import spans use TypeScript parser without project resolution

**결정:** TS/JS import-backed evidence는 regex line guessing이 아니라 TypeScript compiler의 `ts.createSourceFile` parser로 뽑는다. 범위는 static import, type-only import, namespace import, export-from, dynamic `import()`, string-literal `require()`까지로 제한한다. `ts.createProgram`/tsconfig resolution/type-checker는 이 slice에 넣지 않는다.

**맥락:** Impact Trace가 agent context를 줄이려면 relation이 맞는 것뿐 아니라 "근거가 파일의 어느 위치인지"를 작게 보내야 한다. 기존 v0 adapter는 import relation을 만들었지만 evidence snippet이 파일 전체에 가깝거나 span이 비어 `spanCompleteness`가 낮았다. TS/JS는 ImpactBench의 핵심 fixture가 이미 re-export/type-only/namespace/dynamic/require를 포함하므로 parser-backed span을 가장 작게 넣을 수 있는 첫 대상이다.

**대안:**
- regex span만 확장 — 구현은 빠르지만 TS/JS grammar edge에서 line/col 신뢰도가 낮다.
- `ts.createProgram`으로 alias/type resolution까지 처리 — 정확도는 높지만 tsconfig/project graph/build setup까지 끌어와 blast radius가 커진다.
- Tree-sitter 공통 parser 도입 — multi-language 확장성은 좋지만 새 native dependency와 packaging surface가 생긴다.
- whole-file evidence에 `startLine=1`만 채움 — metric은 좋아지지만 사용자가 신뢰할 수 있는 근거가 아니다.

**결과/위험:** `typescript`는 runtime dependency가 된다. relation provenance와 resolver는 기존 specifier 문자열을 유지해 relation id churn을 줄인다. import-backed `VERIFIES`는 같은 import evidence span을 재사용한다. parser는 syntax tree만 쓰므로 path alias/type resolution은 기존 resolver와 후속 depth pass에 남는다. 이 slice에서 ImpactBench `spanCompleteness >= 0.75`가 첫 gate가 됐고, D-023에서 JVM/Spring span까지 반영해 0.85로 올린다.

**관련 commit:** `feat(adapters): add ts js parser import spans`

---

## D-023: JVM/Spring spans stay lightweight before build-system resolution

**결정:** JVM/Spring depth v0는 Java/Kotlin parser, Tree-sitter, Maven/Gradle model 없이 기존 regex-backed adapter 안에서 line/annotation scanning으로 evidence span만 정밀화한다. 대상은 Spring endpoint `IMPLEMENTS`, Spring role/bean `DECLARES`, config path mention `CONFIGURES`, filename-inferred JVM `VERIFIES`다.

**맥락:** 사용자는 Spring Boot를 실제 stack으로 쓴다. TS/JS span만 정밀하면 MCP/UI가 Spring 변경 영향의 위치를 충분히 보여주지 못한다. 그러나 Maven/Gradle classpath, annotation processor, Kotlin compiler까지 한 번에 붙이면 dependency와 blast radius가 커진다. 먼저 agent가 바로 펼칠 수 있는 source span 신뢰도를 높인다.

**대안:**
- Tree-sitter/JavaParser/Kotlin compiler 도입 — 정확도는 높지만 native/package surface와 setup 부담이 늘어난다.
- Maven/Gradle resolver 선행 — cross-module classpath는 풀 수 있지만 단일 repo evidence 품질 개선보다 범위가 크다.
- config key semantic binding까지 구현 — `@ConfigurationProperties(prefix=...)`와 YAML tree 매칭은 가치가 있지만 별도 parser/contract가 필요하다.
- whole-file evidence 유지 — context 절감 목표와 UI evidence panel 신뢰도가 약하다.

**결과/위험:** Spring/Spring Boot fixture의 핵심 relation은 bounded snippet과 `startLine/endLine/startCol/endCol`를 갖는다. ImpactBench `spanCompleteness` gate는 0.85로 올라간다. v0는 shallow regex라 nested annotation expression, build-generated symbols, runtime wiring은 여전히 다루지 않는다. D-024에서 Python/Go/Rust lightweight span까지 반영했고, build-system/package workspace resolver는 후속으로 남긴다.

**관련 commit:** `feat(adapters): add jvm spring evidence spans`

---

## D-024: Python/Go/Rust spans use declaration lines before full resolvers

**결정:** Python/Go/Rust depth v0는 Tree-sitter, language server, package/workspace resolver 없이 기존 deterministic adapter에서 declaration-line evidence를 먼저 저장한다. 대상은 Python/Go/Rust generic `DECLARES`와 filename-inferred `VERIFIES`다. import-backed `VERIFIES`는 기존 import evidence를 계속 우선한다.

**맥락:** TS/JS와 JVM/Spring span이 생긴 뒤에도 Python/Go/Rust 테스트 영향은 filename inference일 때 whole-file evidence로 남아 agent context를 불필요하게 키웠다. 사용자는 이 언어들을 실제 stack으로 쓴다. full resolver를 기다리기보다 UI/MCP가 바로 펼칠 수 있는 작은 근거를 먼저 보강한다.

**대안:**
- Tree-sitter 공통 parser 도입 — Python/Go/Rust 확장성은 좋지만 native dependency와 packaging surface가 커진다.
- 각 언어 LSP/gopls/rust-analyzer/pyright 연동 — 정확도는 높지만 설치 상태와 workspace model에 강하게 의존한다.
- package/workspace resolver 선행 — cross-module import는 좋아지지만 단일 파일 근거 위치 개선보다 범위가 크다.
- import-backed span만 유지 — filename-inferred tests와 declaration relation이 계속 whole-file context로 남는다.

**결과/위험:** ImpactBench expected relation은 43개로 늘고 `spanCompleteness` gate는 0.9로 올라간다. 현재 fixture는 `spanCompleteness 0.9535`다. v0는 declaration-line 기반이라 decorator/attribute 일부와 simple test declaration에는 강하지만, Python dynamic imports, Go build tags, Rust cfg feature/module tree resolution은 후속 workspace/contract resolver로 남긴다.

**관련 commit:** `feat(adapters): add python go rust evidence spans`

---

## D-025: contract files reverse-link to implementers before cross-repo resolution

**결정:** OpenAPI/Swagger/AsyncAPI YAML/JSON, protobuf, GraphQL contract 파일은 first-class `contract` entity로 저장한다. 기존 `contracts`/`contract_versions` 테이블을 사용하고 schema migration은 추가하지 않는다. contract 파일이 repo-local code path를 명시적으로 언급하면 contract → code `REFERENCES`와 code → contract `IMPLEMENTS`를 함께 저장한다.

**맥락:** `analyzeDiff()`는 변경된 entity의 inbound relation을 역방향으로 따라간다. 따라서 contract 파일이 source이고 구현 코드가 target인 relation만 있으면 "contract 변경이 어떤 구현 코드를 건드리는가"를 바로 보여줄 수 없다. v0는 cross-repo resolver를 기다리지 않고 단일 repo 안에서 명시적 path mention을 구현자 링크로 뒤집어 저장한다.

**대안:**
- analyzer를 양방향 traversal로 바꿈 — 영향 범위가 급격히 넓어지고 기존 report semantics가 흔들린다.
- contract → code relation만 유지 — code 변경 시 contract 문서 영향은 보이지만, contract 변경 시 구현 코드 영향이 누락된다.
- YAML/JSON stem matching 유지 — `User API` 같은 일반 단어가 `User.java`로 연결되는 false positive가 생긴다.
- OpenAPI parser/library 도입 — 정확도는 높지만 v0의 local deterministic adapter blast radius보다 크다.

**결과/위험:** OpenAPI contract는 endpoint `DECLARES`와 구현자 `IMPLEMENTS` relation을 bounded line/col evidence로 갖는다. `contracts` row는 `kind=openapi`, `service_name`, metadata를 저장하고 `contract_versions.schema_version`은 OpenAPI schema version을 기록한다. ImpactBench expected relation은 46개로 늘고 `spanCompleteness`는 0.9565다. 단일 repo 안에서는 명시적 repo path mention만 구현자로 인정한다. cross-repo consumer mapping의 첫 v0는 D-027에서 별도 resolver로 처리했고, endpoint-surface contract diff는 D-028에서 처리했다. 자동 route-method matching 확대, package/service discovery, schema/body-level diff는 후속으로 남긴다.

**관련 commit:** `feat(contracts): add OpenAPI impact baseline`

---

## D-026: workspace catalog is an explicit local allowlist

**결정:** workspace v0는 `.impact-trace/workspace.json`에 repo local path를 명시적으로 등록하고, `impact-trace workspace init/add-repo/list`가 이 catalog를 기존 `workspaces`/`workspace_repos`/`repos` 테이블에 동기화한다. 등록 path는 canonical realpath directory여야 하며 URL-like path나 `git@host:repo` 형태는 거절한다.

**맥락:** cross-repo API/gRPC/event impact를 하려면 provider/consumer repo boundary가 필요하다. 그러나 Impact Trace의 신뢰 경계는 local-first, no daemon, no implicit clone이다. 따라서 "어떤 repo를 읽어도 되는가"는 추론하지 않고 사용자가 명시한 local allowlist로 시작한다.

**대안:**
- Git remote나 package metadata에서 repo를 자동 clone — 편하지만 network/credential/write boundary가 불분명하다.
- 중앙 workspace DB를 별도로 둠 — multi-repo에는 자연스럽지만 단일 repo `.impact-trace/impact.db`의 auditability와 설치 단순성이 깨진다.
- MCP tool에서 workspace path를 임의 입력으로 매번 받음 — 빠르지만 반복 호출마다 trust boundary를 다시 검증해야 하고 UI/list UX가 없다.
- workspace catalog 없이 contract resolver부터 구현 — consumer/provider graph가 어떤 repo 범위에서 유효한지 설명할 수 없다.

**결과/위험:** workspace catalog는 config file 기준 상대경로를 사용하고 DB에는 canonical realpath를 저장한다. `add-repo` 재실행은 같은 path row를 업데이트하므로 idempotent하다. v0는 repo 등록/조회만 제공한다. indexed local repo를 읽는 첫 cross-repo resolver는 D-027에서 추가됐고, OpenAPI endpoint-surface contract diff는 D-028에서 추가됐다. MCP workspace/contract resource는 D-029에서 추가됐다.

**관련 commit:** `feat(workspace): add local catalog CLI`

---

## D-027: cross-repo contract resolution reads indexed local repos only

**결정:** cross-repo provider/consumer v0는 workspace catalog에 등록된 local repo들의 기존 Impact Trace index DB를 read-only로 열고, provider OpenAPI endpoint `DECLARES`와 consumer code의 HTTP path literal을 매칭해 root workspace DB의 `cross_repo_links`에 저장한다. 실행 명령은 `impact-trace workspace resolve-contracts`이며 clone, remote fetch, credential access는 하지 않는다.

**맥락:** workspace catalog와 OpenAPI baseline이 준비됐지만, 바로 contract diff/breaking-change classifier로 가면 "어떤 consumer repo/file이 어떤 provider endpoint를 실제로 소비하는가"라는 중간 graph가 비어 있다. Codex/Claude에 줄 context를 줄이려면 contract 변경 시 전체 workspace를 밀어 넣는 대신, 이미 indexed된 repo에서 endpoint consumer 후보만 작게 뽑아야 한다.

**대안:**
- resolver 실행 중 repo를 자동 index — 편하지만 read-only expectation이 깨지고 오래 걸린다.
- live filesystem 전체를 매번 scan — 빠르게 보일 수 있지만 최신 completed index와 다른 파일을 근거로 삼아 stale impact를 만들 수 있다.
- package manager/service discovery를 먼저 구현 — 정확도는 좋아지지만 Java/Kotlin/Spring/Python/Go/Rust/TS/JS 전체 build model이 필요해 blast radius가 크다.
- `relations`에 cross-repo edge를 직접 삽입 — 기존 canonical relation은 single-repo `repo_id` invariant가 강해서 schema/ID 충돌 위험이 크다.

**결과/위험:** v0는 provider contract와 consumer file 모두 repo-root fence를 통과한 뒤 읽고, indexed file hash와 live file hash가 다르면 link 생성을 skip하고 warning을 반환한다. 링크는 `CONSUMES_HTTP_ENDPOINT` kind와 provenance JSON에 consumer/provider service, repo path, contract path, endpoint id, HTTP method/path, evidence snippet을 담는다. 현재 매칭은 deterministic literal/path heuristic이다. 이 링크를 사용한 OpenAPI endpoint-surface breaking-change classification은 D-028에서 추가됐고, GraphQL operation document consumer matching은 D-036에서 같은 link envelope로 확장했다. generated client, service discovery, auth/config binding은 후속 slice다.

**관련 commit:** `feat(workspace): cross-repo contract resolver 추가`

---

## D-028: contract diff v0 compares indexed OpenAPI endpoints to current files

**결정:** contract diff v0는 workspace root에서 `impact-trace workspace contract-diff --contract <path> [--name <workspace>] [--provider <service>] [--provider-path <path>] [--json]`로 실행한다. provider repo의 latest completed index에 저장된 OpenAPI endpoint `DECLARES` surface와 현재 contract 파일을 비교해 removed endpoint를 `breaking`, added endpoint를 `non-breaking`, unreadable/unparsed/body-only change를 `unknown`으로 분류한다. 기존 `CONSUMES_HTTP_ENDPOINT` cross-repo link와 만나는 removed endpoint만 root workspace DB에 `BREAKS_COMPATIBILITY_WITH` link로 저장한다.

**맥락:** 사용자가 Claude/Codex로 provider API contract를 수정했을 때 agent에게 전체 workspace를 다시 읽히면 context가 낭비된다. 이미 OpenAPI baseline과 cross-repo consumer links가 있으므로, 변경된 contract endpoint surface와 known consumer만 작은 JSON으로 반환하면 된다. diff 대상은 "latest indexed baseline vs current working tree file"이다. 이렇게 해야 코드 수정 직후 re-index 전에 breaking risk를 볼 수 있다.

**대안:**
- 두 index run 사이를 비교 — raw contract content를 저장하지 않으므로 re-index 전 변경 영향 확인이 늦고, agent 수정 직후 UX가 나쁘다.
- resolver 실행 중 모든 repo를 live scan — D-027의 completed-index 신뢰 경계를 깨고 stale/dirty consumer를 근거로 만들 수 있다.
- OpenAPI schema parser 라이브러리 도입 — request/response body rule에는 필요하지만 v0 endpoint surface classification보다 dependency/blast radius가 크다.
- breaking relation을 provider repo의 `relations`에 저장 — existing relation schema는 single-repo `repo_id` invariant가 강하고 consumer repo path를 자연스럽게 담기 어렵다.

**결과/위험:** v0는 OpenAPI YAML/JSON endpoint surface에 한정된다. endpoint removal은 known HTTP literal consumer가 있을 때만 persisted breaking link가 되며, consumer가 없더라도 result summary에는 breaking change로 남는다. unreadable/unparsed current contract는 unknown으로 반환하고 기존 breaking links를 지우지 않는다. path는 provider repo root fence를 통과해야 하며 post-index symlink escape를 읽지 않는다. schema/status/body diff는 D-030..D-032에서, Protobuf diff는 D-033에서, GraphQL diff는 D-034에서, AsyncAPI diff는 D-035에서 확장했다. auth scope와 consumer resolver는 후속 slice다.

**관련 commit:** `feat(contracts): OpenAPI contract diff 추가`

---

## D-029: MCP workspace contract resources expand contract impact on demand

**결정:** endpoint-surface contract diff를 MCP tool `impact_trace_contract_diff`로 노출하고, 결과에는 `impact-trace://workspaces/{workspaceName}`, `impact-trace://workspaces/{workspaceName}/contracts`, `impact-trace://workspaces/{workspaceName}/cross-repo-links` resource URI를 포함한다. workspace resource는 local catalog membership을, contracts resource는 workspace repo들의 latest indexed contract baseline과 endpoint count를, cross-repo links resource는 `CONSUMES_HTTP_ENDPOINT`와 `BREAKS_COMPATIBILITY_WITH` provenance를 compact JSON으로 반환한다.

**맥락:** 사용자는 Claude/Codex가 코드를 수정할 때 관련 코드/정책/문서/contract impact를 알되 AI context 사용량은 줄이고 싶다고 했다. CLI `workspace contract-diff`만 있으면 agent가 결과를 받더라도 이후 workspace membership, contract baseline, provider/consumer link를 다시 파일 탐색으로 찾기 쉽다. MCP에서는 큰 payload를 tool response에 모두 넣는 대신 작은 diff summary + resource URI를 주고, 필요한 경우에만 resource를 읽게 해야 한다.

**대안:**
- contract diff 결과에 모든 workspace contract와 link를 inline — 한 번에 편하지만 context 절감 목표와 충돌한다.
- `resources/list` 없이 tool-only JSON 유지 — 자동화는 가능하지만 UI/list UX와 agent의 expand-on-demand 흐름이 약하다.
- MCP resource가 live provider contract file을 읽음 — current diff 확인에는 필요하지만 baseline resource는 latest completed index 기준이어야 stale/dirty 경계를 설명할 수 있다.
- schema/body diff까지 기다렸다가 MCP에 노출 — endpoint removal은 이미 useful하고 작은 slice로 검증 가능하다.

**결과/위험:** v0는 OpenAPI endpoint-surface diff 결과를 MCP로 연결하는 surface다. `impact_trace_contract_diff`는 기본적으로 root workspace DB에 breaking link를 갱신하므로 MCP annotation은 write-capable이다. resource read는 read-only payload지만 context telemetry row는 append될 수 있다. contracts resource는 latest completed index baseline과 endpoint count만 보여주며 current working tree body/schema details는 후속 schema/body-level diff에서 확장한다.

**관련 commit:** `feat(mcp): contract impact resources 추가`

---

## D-030: JSON OpenAPI schema diff uses indexed compatibility signatures

**결정:** JSON OpenAPI contract는 index 시점에 `openapi-compat-v0` compatibility signature를 `contract_versions.compatibility_json`에 저장한다. signature는 operation별 method/path, JSON request body flat object required/properties type, JSON response status/body flat object required/properties type만 담는다. `workspace contract-diff`와 `impact_trace_contract_diff`는 latest indexed signature와 current JSON contract signature를 비교해 removed response status, removed response required property, changed response property type, added request required property, changed request property type을 `breaking`으로 분류한다. matching `CONSUMES_HTTP_ENDPOINT` consumer가 있으면 기존 endpoint removal과 같은 `BREAKS_COMPATIBILITY_WITH` link로 저장한다.

**맥락:** endpoint surface만 비교하면 `/api/users`가 남아 있어도 response `name` required field가 사라지거나 request `email` required field가 추가되는 breaking change를 `unknown`으로만 반환한다. 사용자는 Claude/Codex가 코드 수정 직후 관련 contract impact를 작은 context로 알고 싶다고 했으므로, full OpenAPI parser/linter를 도입하기 전에 local deterministic signature로 가장 흔한 body-level break를 잡는다.

**대안:**
- full OpenAPI diff library 도입 — 장기적으로 좋지만 dependency, output normalization, YAML/ref/allOf/oneOf behavior 검증 범위가 크다.
- current file만 깊게 parse하고 indexed baseline은 endpoint relation에서 재구성 — previous response/request body 정보가 없어서 body-level diff가 불가능하다.
- contract raw content를 DB에 저장 — diff fidelity는 좋아지지만 DB 크기와 private payload 보존 정책이 커진다.
- body-only change를 계속 `unknown` 유지 — context 절감 목표에는 안전하지만 사용자에게 실제 breaking risk를 충분히 알려주지 못한다.

**결과/위험:** v0는 JSON OpenAPI의 flat object body signature와 local `#/...` `$ref`만 지원한다. YAML body diff는 D-031에서, nested property path/arrays/items/allOf/oneOf/anyOf는 D-032에서, Protobuf diff는 D-033에서, GraphQL diff는 D-034에서, AsyncAPI diff는 D-035에서 확장했다. enum cardinality, format/nullability, auth scope, consumer resolver는 후속 slice다. signature는 contract metadata JSON에는 넣지 않고 `contract_versions.compatibility_json`에만 저장해 baseline metadata payload가 커지지 않게 한다. unreadable/unparsed current contract는 기존처럼 unknown이며 기존 breaking links를 보존한다.

**관련 commit:** `feat(contracts): OpenAPI JSON schema diff 추가`

---

## D-031: YAML OpenAPI schema diff reuses the compatibility signature model

**결정:** YAML OpenAPI contract도 D-030의 `openapi-compat-v0` signature model을 재사용한다. index 시점에는 `yaml` parser로 YAML을 object model로 정규화한 뒤 `contract_versions.compatibility_json`에 operation method/path, JSON media request/response flat object required/properties type, response status를 저장한다. current YAML contract diff도 기존 lightweight endpoint scanner가 `ok`로 인정한 파일에 한해서 같은 signature를 계산하고, JSON과 같은 breaking rule을 적용한다.

**맥락:** Spring Boot와 enterprise API spec은 OpenAPI YAML이 JSON보다 흔하다. JSON-only body diff는 기능적으로 맞지만 실제 사용자 stack에서는 같은 `/api/users` 변경이 YAML spec에 있으면 여전히 `unknown`이 된다. 기존 hand-rolled YAML endpoint scanner는 surface safety에는 충분하지만 nested maps, `$ref`, media content, required arrays를 직접 확장하면 parser bug가 늘어난다.

**대안:**
- hand-rolled YAML body parser 확장 — dependency는 줄지만 indentation, quotes, inline object, `$ref`, arrays 처리가 취약해 false impact 위험이 크다.
- OpenAPI 전용 diff library 도입 — 장기적으로 좋지만 allOf/oneOf/auth/nullable/format 등 해석 범위가 커져 이번 flat signature slice보다 blast radius가 크다.
- YAML은 endpoint surface만 유지 — Spring/OpenAPI 실사용에서 body-level breaking change를 계속 놓친다.
- YAML parser 결과만 믿고 endpoint scanner를 우회 — 기존 malformed/unparsed YAML 보존 규칙과 nested callback/path guard가 약해질 수 있다.

**결과/위험:** v0는 YAML parser를 추가 의존성으로 사용하지만, current diff에서는 기존 endpoint scanner가 성공한 경우에만 compatibility signature를 붙인다. 따라서 tab indentation, malformed path/method, non-object operation 같은 기존 unknown/preserve behavior는 유지된다. 지원 범위는 JSON media type의 flat object body, local `#/...` `$ref`, response status/required/type, request required/type까지다. nested properties, arrays/items details, allOf/oneOf/anyOf는 D-032에서, Protobuf diff는 D-033에서, GraphQL diff는 D-034에서, AsyncAPI diff는 D-035에서 확장했다. enum/format/nullability, auth scope, consumer resolver는 후속 slice다.

**관련 commit:** `feat(contracts): OpenAPI YAML schema diff 추가`

---

## D-032: OpenAPI nested schema diff extends compatibility signatures

**결정:** JSON/YAML OpenAPI contract diff는 `openapi-compat-v0` compatibility payload를 schemaVersion 2로 올리고, `required`와 `properties` key를 nested schema path로 확장한다. 예를 들어 `profile.displayName`, `members[].id`, root array item `[].id` 같은 path가 `contract_versions.compatibility_json`에 들어가며, diff는 기존 breaking rule을 같은 방식으로 적용한다. `allOf` object schema는 deterministic merge로 펼치고, overlapping property type은 order-insensitive set fingerprint로 저장한다. `oneOf`/`anyOf`는 branch 전체를 full semantic diff하지 않고 object required set을 포함한 property type fingerprint나 root body fingerprint(`$`) 변화로 비교하며, `properties` 없이 `required`만 있는 object branch도 fingerprint에 포함한다.

**맥락:** flat object signature는 `/api/users` endpoint가 유지되어도 response 내부 nested required field 제거, array item type 변경, composed schema 변경을 놓친다. 사용자가 원하는 제품은 Claude/Codex에 전체 OpenAPI 파일을 다시 넣는 것이 아니라 "어떤 nested contract path가 어떤 consumer를 깨뜨리는가"를 작은 context로 알려주는 것이므로, 기존 compatibility signature를 path 기반으로 깊게 만드는 편이 가장 작다.

**대안:**
- OpenAPI 전용 diff library 도입 — 장기적으로 가능하지만 dependency와 output normalization, allOf/oneOf/nullable/auth rule 검증 범위가 커진다.
- schemaVersion을 유지 — 기존 flat baseline과 nested-capable baseline이 조용히 섞여 false unknown이 생길 수 있어 거부한다. schemaVersion 1 baseline은 warning을 내고 provider reindex를 요구한다.
- nested schema를 raw JSON으로 저장 — 정확도는 올라가지만 DB payload와 private contract body 보존 범위가 커진다.
- oneOf/anyOf를 full branch-aware로 해석 — request/response variance rule과 branch matching 비용이 커져 이번 deterministic slice 범위를 넘는다.

**결과/위험:** nested object required/type, root/nested array item required/type, local `#/...` ref chain(object와 array pointer segment 포함), `allOf` object merge, `oneOf`/`anyOf` property/root body fingerprint 변화가 known consumer endpoint에 `BREAKS_COMPATIBILITY_WITH` link로 저장된다. 기존 schemaVersion 1 flat baseline은 nested-capable으로 취급하지 않고 warning과 `unknown` fallback을 반환하므로 provider repo를 새로 index해야 nested impact가 잡힌다. oneOf/anyOf는 "대안 집합 fingerprint가 바뀌었다"는 보수적 breaking signal이며, branch matching/discriminator semantics, nullable/format/enum cardinality, auth scope, consumer resolver는 후속 slice다. Protobuf diff는 D-033에서, GraphQL diff는 D-034에서, AsyncAPI diff는 D-035에서 별도 compact signature로 다룬다.

**관련 commit:** `feat(contracts): OpenAPI nested schema diff 추가`

---

## D-033: Protobuf contract diff uses compact service/RPC signatures

**결정:** `.proto` contract는 index 시점에 `protobuf-compat-v0` schemaVersion 1 compatibility signature를 `contract_versions.compatibility_json`에 저장한다. signature는 package, service/RPC, request/response type, stream flag, message field number/name/type/label만 담는다. `workspace contract-diff`는 contract kind가 `protobuf`이거나 current path가 `.proto`이면 latest indexed signature와 현재 `.proto`를 비교하고, removed RPC, RPC request/response type 또는 streaming flag 변화, response message field removal/type/name/label 변화를 `breaking`으로 분류한다.

**맥락:** OpenAPI endpoint/schema diff가 들어간 뒤 다음 contract risk는 Protobuf였다. 사용자는 Claude/Codex가 provider contract를 수정했을 때 전체 proto 파일이나 workspace를 다시 context에 넣는 대신, 어떤 service/RPC/message field가 깨졌는지만 작은 payload로 받고 싶다고 했다. Buf의 `breaking` rule taxonomy는 좋은 reference지만, Buf CLI/BSR이나 raw proto image를 core runtime dependency로 요구하면 local-first, compact metadata, no raw body baseline 원칙과 충돌한다.

**대안:**
- Buf CLI/BSR을 필수화 — rule fidelity는 높지만 설치/네트워크/registry 경계가 커져 core runtime에서는 거부한다.
- raw `.proto` content 또는 descriptor image를 SQLite에 저장 — diff fidelity는 좋아지지만 private contract body 보존 범위와 DB payload가 커진다.
- Protobuf endpoint-only diff만 유지 — removed RPC는 잡지만 response field removal/type change를 놓친다.
- GraphQL/AsyncAPI까지 generic compatibility layer를 먼저 만든 뒤 Protobuf를 넣기 — 설계는 깔끔하지만 이번 slice의 사용자 가치가 늦어진다.

**결과/위험:** v0 parser는 deterministic regex 기반이며 top-level service/message, unary/stream RPC, simple field/map/oneof-member field signature만 다룬다. imports, nested message diff, enum/reserved/options, oneof group semantics, proto2 default semantics, package-qualified cross-file type resolution, generated-client source compatibility는 후속이다. consumer impact persistence는 기존 `cross_repo_links`가 있을 때만 가능하다. D-037에서 service-anchored Protobuf RPC consumer resolver v0가 추가되어 removed RPC는 known consumer link가 있으면 `BREAKS_COMPATIBILITY_WITH`로 저장된다. D-039에서 Connect-ES style generated client call과 full route string matching을 추가했지만, response field break의 generated-client/source compatibility와 cross-file usage graph는 여전히 후속이다. GraphQL diff는 D-034에서, AsyncAPI diff는 D-035에서 확장했다.

**관련 commit:** `feat(contracts): Protobuf contract diff 추가`

---

## D-034: GraphQL contract diff uses compact schema signatures

**결정:** `.graphql`/`.gql` contract는 index 시점에 `graphql-compat-v0` schemaVersion 1 compatibility signature를 `contract_versions.compatibility_json`에 저장한다. signature는 `Query`/`Mutation`/`Subscription` root field, field return type, argument type/required flag, object type field, input type field type/required flag만 담는다. `workspace contract-diff`는 contract kind가 `graphql`이거나 current path가 `.graphql`/`.gql`이면 latest indexed signature와 현재 SDL을 비교하고, removed root field, root return type change, root response에서 도달 가능한 object field removal/type change, required argument addition/type/required-flag change, operation input에서 도달 가능한 required input field addition/type/required-flag change를 `breaking`으로 분류한다.

**맥락:** OpenAPI와 Protobuf diff 이후 남은 주요 contract risk는 GraphQL schema였다. 사용자는 Claude/Codex가 provider schema를 수정했을 때 전체 SDL이나 workspace를 다시 context에 넣는 대신, 어떤 root field/object/input field가 깨졌는지만 작은 payload로 받고 싶다고 했다. GraphQL Inspector의 breaking taxonomy는 좋은 reference지만, Hive/cloud registry, GitHub app, raw SDL snapshot, CLI dependency를 core runtime으로 요구하면 local-first, compact metadata, no raw body baseline 원칙과 충돌한다.

**대안:**
- GraphQL Inspector/Hive를 필수화 — rule fidelity는 높지만 설치/네트워크/registry 경계가 커져 core runtime에서는 거부한다.
- `graphql` parser dependency와 full AST diff를 바로 도입 — 장기적으로 좋지만 schema root remap, directive, interface/union, enum, deprecation semantics까지 검증해야 해서 이번 compact slice보다 blast radius가 크다.
- raw SDL을 SQLite에 저장 — diff fidelity는 좋아지지만 private contract body 보존 범위와 DB payload가 커진다.
- root field endpoint-only diff만 유지 — removed root field는 잡지만 response object field removal/type change와 required input 추가를 놓친다.

**결과/위험:** v0 parser는 deterministic regex 기반이며 `type`/`extend type`/`input` block의 한 줄 field 선언, comma-delimited argument list, 기본 `Query`/`Mutation`/`Subscription` root names만 다룬다. response object와 input object는 같은 named type을 따라 cycle guard로 순회하지만, `schema { query: RootQuery }`, interfaces/unions/enums/scalars/directives/deprecation, fragments, multi-line argument lists, full GraphQL parser/LSP depth는 후속이다. defaulted non-null input은 required로 보지 않는다. GraphQL operation document consumer resolver는 D-036에서 top-level root field heuristic으로 확장했다. AsyncAPI diff는 D-035에서 확장했다.

**관련 commit:** `feat(contracts): GraphQL contract diff 추가`

---

## D-035: AsyncAPI contract diff uses compact operation/message signatures

**결정:** AsyncAPI YAML/JSON contract는 index 시점에 `asyncapi-compat-v0` schemaVersion 1 compatibility signature를 `contract_versions.compatibility_json`에 저장한다. signature는 operation action, channel id/address, message id, payload object required/properties type만 담는다. `workspace contract-diff`는 contract kind가 `asyncapi`이거나 filename stem에 `asyncapi`가 있으면 latest indexed signature와 현재 파일을 비교하고, removed operation, message payload field removal, message payload field type change, 새 required payload field 추가를 `breaking`으로 분류한다.

**맥락:** OpenAPI, Protobuf, GraphQL diff 이후 남은 주요 cross-repo/event contract risk는 AsyncAPI였다. 사용자는 Claude/Codex가 event contract를 수정했을 때 전체 AsyncAPI 파일이나 workspace를 다시 context에 넣는 대신, 어떤 channel/operation/message payload가 깨졌는지만 작은 payload로 받고 싶다고 했다. AsyncAPI parser/diff는 좋은 reference지만 valid dereferenced full document와 JSON Pointer 중심 output을 core runtime dependency로 요구하면 local-first, compact metadata, no raw body baseline 원칙과 충돌한다.

**대안:**
- `@asyncapi/parser`와 `@asyncapi/diff`를 필수화 — rule fidelity는 높지만 dependency, dereference behavior, parser version drift, install surface가 커져 core runtime에서는 거부한다.
- raw AsyncAPI document를 SQLite에 저장 — diff fidelity는 좋아지지만 private event schema 보존 범위와 DB payload가 커진다.
- AsyncAPI를 OpenAPI YAML scanner에 계속 태움 — endpoint/operation이 비어 `unknown`이 되며 event contract risk를 놓친다.
- consumer resolver부터 구현 — downstream link는 중요하지만 provider contract 자체의 breaking classifier가 없으면 어떤 변화가 위험한지 작은 payload로 설명할 수 없다.

**결과/위험:** v0 parser는 deterministic compact extractor이며 AsyncAPI 3.x `operations`/`channels`와 2.x `publish`/`subscribe` 형태의 local `#/...` refs를 우선 지원한다. payload schema는 JSON-schema-like object required/properties, local refs, nested/array/composition fingerprint를 compact path로 저장한다. operation removal은 endpoint-equivalent breaking change로 분류되고, message payload field removal/type change 및 newly required payload field는 message-level breaking change로 분류된다. event consumer impact persistence는 기존 `cross_repo_links`가 있을 때만 가능하다. D-037에서 event address literal consumer resolver v0가 추가되어 removed operation은 known consumer link가 있으면 `BREAKS_COMPATIBILITY_WITH`로 저장된다. D-039에서 common producer/consumer call-site direction hint를 추가했지만, message trait/security/binding semantics, external refs, schema registry integration, NATS/AMQP/Kafka binding depth는 후속이다.

**관련 commit:** `feat(contracts): AsyncAPI contract diff 추가`

---

## D-036: GraphQL consumer resolver links operation documents to root fields

**결정:** `workspace resolve-contracts`는 indexed workspace repo의 GraphQL provider endpoint(`Query.users`, `Mutation.createUser`, `Subscription.userUpdated`)와 consumer file에 포함된 GraphQL operation document의 top-level root field를 매칭한다. v0는 기존 `cross_repo_links` 저장 경로를 재사용하고, `CONSUMES_HTTP_ENDPOINT` provenance의 `http.method`를 `GRAPHQL`, `http.path`를 `Query.users` 같은 root field coordinate로 저장한다.

**맥락:** GraphQL contract diff v0는 removed root field와 schema field breaking change를 분류할 수 있지만, known downstream consumer가 없으면 `BREAKS_COMPATIBILITY_WITH` link를 만들 수 없다. GraphQL Inspector와 Apollo/Rover 계열 도구의 공통 패턴은 schema diff와 operation document usage를 분리하는 것이다. Impact Trace는 hosted registry나 operation telemetry 없이 local-first로 동작해야 하므로, latest completed index의 파일 hash를 신뢰 경계로 삼아 consumer operation documents만 작게 연결한다.

**대안:**
- GraphQL Inspector/Hive document validation을 core dependency로 도입 — operation validation 품질은 좋지만 dependency와 hosted/CI surface가 커져 core local-first resolver에는 거부한다.
- Apollo GraphOS/Rover operation checks 사용 — historical operation usage는 강력하지만 GraphOS auth/registry/metrics가 필요해 v0 경계를 넘는다.
- 새 `CONSUMES_GRAPHQL_FIELD` link kind 추가 — 의미는 명확하지만 `contract-diff`와 MCP resource가 이미 `CONSUMES_HTTP_ENDPOINT`/`BREAKS_COMPATIBILITY_WITH` envelope를 읽고 있어 schema migration 없이 작은 slice로 검증하기 어렵다.
- GraphQL consumer resolver를 full parser까지 미룸 — 정확도는 높아지지만 provider root field removal의 실제 consumer impact를 계속 놓친다.

**결과/위험:** v0는 deterministic heuristic이다. `.graphql`, `.gql`, `.ts`, `.tsx`, `.js`, `.jsx` consumer file만 scan하고 `query`/`mutation`/`subscription` operation의 selection set에서 top-level root field만 본다. provider root type과 field name이 맞으면 link를 저장한다. indexed file과 live file hash가 다르면 기존 resolver처럼 skip하고 warning을 남긴다. fragment expansion, cross-file fragments, full schema validation, directive semantics, persisted query manifest, generated client mapping, Apollo client metadata, custom root operation type remap은 후속이다. Link kind 이름은 기존 envelope 재사용 때문에 아직 HTTP 명칭을 유지하지만 provenance method/path로 GraphQL 여부를 구분한다.

**관련 commit:** `feat(workspace): GraphQL consumer resolver 추가`

---

## D-037: Protobuf and AsyncAPI consumer resolver reuses the cross-repo link envelope

**결정:** `workspace resolve-contracts`는 Protobuf provider endpoint(`UserService.ListUsers`)를 `RPC UserService/ListUsers` key로, AsyncAPI provider operation(`SEND orders.submitted`, `RECEIVE users.requested`)을 event `ACTION address` key로 해석한다. consumer repo에서는 indexed fresh file만 읽고, Protobuf는 service anchor와 RPC call/route literal을, AsyncAPI는 source/config file의 exact event address literal을 매칭한다. 저장은 기존 `cross_repo_links`와 `CONSUMES_HTTP_ENDPOINT` provenance의 `http.method`/`http.path` envelope를 재사용한다.

**맥락:** Protobuf contract diff(D-033)와 AsyncAPI contract diff(D-035)는 compact signature 기반 breaking classification을 이미 제공하지만, downstream consumer link가 없으면 `BREAKS_COMPATIBILITY_WITH`가 제한된다. Buf, grpcurl, Connect/protobuf-es, AsyncAPI parser/diff, EventCatalog, Microcks는 모두 descriptor/signature 또는 event catalog identity를 중심으로 producer/consumer 영향을 좁히지만, Impact Trace v0는 hosted registry, reflection network call, raw contract body persistence 없이 local-first로 동작해야 한다.

**대안:**
- Buf CLI/BSR 또는 protoc descriptor build를 resolver dependency로 추가 — descriptor fidelity는 높지만 build config, external module, registry surface가 커져 v0 local resolver에는 과하다.
- gRPC reflection/grpcurl 방식으로 live service를 조회 — 런타임 네트워크와 credential surface가 생겨 Impact Trace의 offline index model과 맞지 않는다.
- AsyncAPI parser/diff/EventCatalog를 core dependency로 도입 — validated/dereferenced document와 catalog model은 유용하지만 현재 compact signature + file hash model을 우회하고 payload가 커진다.
- 새 `CONSUMES_RPC`/`CONSUMES_EVENT` link kind 추가 — 의미는 더 정확하지만 existing MCP/contract-diff resource가 이미 `CONSUMES_HTTP_ENDPOINT` envelope를 읽으므로 schema migration 없이 닫기 어렵다.

**결과/위험:** v0는 deterministic heuristic이다. Protobuf consumer scan은 source file만 대상으로 하고 docs/examples/README와 generated protobuf descriptors(`gen/`, `generated/`, `*_pb.*`, `*_grpc_pb.*`)는 제외한다. RPC method-name-only match에는 `UserService` 같은 service anchor가 필요하고, exact gRPC route string(`/pkg.UserService/ListUsers`)은 직접 매칭한다. AsyncAPI consumer scan은 source/config file에서 exact address token을 찾고 docs/examples/README와 partial topic(`orders.submitted.v2`)은 제외한다. Java/Kotlin/Python/Go/Rust/TS/JS common client call shape와 Spring/Kafka config의 literal은 v0에서 잡지만, cross-file client data flow, generated-client usage graph, Buf descriptor import graph, AsyncAPI operationId-only matching, NATS wildcard semantics, AMQP exchange topology, schema registry integration은 후속이다. Link kind 이름은 기존 envelope 재사용 때문에 아직 HTTP 명칭을 유지하지만 `RPC`, `SEND`, `RECEIVE`, `PUBLISH`, `SUBSCRIBE` method로 contract type을 구분한다.

**관련 commit:** `feat(workspace): Protobuf AsyncAPI consumer resolver 추가`

---

## D-038: Build-system package resolver stays manifest-only in v0

**결정:** build-system/package resolver v0는 새 `build-system-package-resolver-v0` adapter로 둔다. 기본 registry에서 언어별 adapter와 regex fallback보다 먼저 `package.json`, `pom.xml`, `build.gradle(.kts)`, `go.mod`, `Cargo.toml`, `pyproject.toml`을 읽고, local package entity와 manifest file의 `DECLARES`, package → manifest identity `DEPENDS_ON`, package → package `DEPENDS_ON` relation을 저장한다. `settings.gradle(.kts)`, `go.work`, `pnpm-workspace.yaml`은 build-system manifest로 인식하지만 v0에서는 실행 없이 scope fence로만 다룬다.

**맥락:** 사용자는 Java/Kotlin/Spring Boot/Python/Go/Rust/TS/JS repo에서 AI context를 줄이고 싶다고 했다. 언어 adapter만으로는 monorepo package 경계, local package dependency, Maven/Gradle/Go/Cargo/Python manifest 영향이 빠져서 변경된 manifest가 dependent app/package까지 전파되지 않는다. Renovate/Dependabot/Syft/OSV Scanner 같은 도구들은 ecosystem별 manifest/lockfile cataloging을 분리하지만, Impact Trace v0는 "AI에게 줄 compact impact graph"가 목적이므로 package manager나 build tool을 실행하지 않는 deterministic manifest-first lane이 먼저 필요하다.

**대안:**
- npm/pnpm/yarn, Maven, Gradle, Go, Cargo, Python tooling을 실행해 실제 resolved graph를 만든다 — 정확도는 높지만 설치 상태, 네트워크, credential, build side effect, 실행 시간 표면이 커져 local-first/offline index model과 맞지 않는다.
- Renovate/Dependabot/Syft 같은 resolver를 core dependency로 통합한다 — coverage는 넓지만 의존성과 output model이 커지고, 현재 `Entity`/`Relation` graph에 필요한 compact edge만 고르기 어렵다.
- 언어 adapter나 regex fallback에 manifest 처리를 계속 섞는다 — 빠르지만 package graph attribution, adapter diagnostics, bench coverage가 흐려진다.
- lockfile/transitive/semver/Gradle DSL/Maven profile/Cargo feature/Go workspace까지 한 번에 구현한다 — 제품 가치는 있지만 scope가 커서 v0 regression gate를 만들기 어렵다.

**결과/위험:** v0는 manifest-only extractor라 dependency resolution의 실제 build semantics를 보장하지 않는다. npm workspace/file dependency, Gradle `project(":x")`, Cargo path dependency는 proven local signal로 취급하고, registry/external coordinate는 heuristic package dependency로 남긴다. package → manifest identity edge를 저장하므로 manifest file 변경은 dependent package manifests까지 도달한다. exact repo-local path mention은 `CONFIGURES`로 보존해 build manifest가 기존 system/config reference lane을 완전히 잃지 않게 한다. lockfile drift, transitive dependency, Gradle version catalog, Maven parent/profile/property interpolation, Go replace/workspace, Python optional dependencies/Poetry/uv, generated-client/source usage graph는 후속이다.

**관련 commit:** `feat(adapters): build-system package resolver 추가`

---

## D-039: Generated-client and event topology v0 stays heuristic and schema-neutral

**결정:** `workspace resolve-contracts`는 Protobuf/generated-client v0를 기존 RPC matcher 안에서 보강하고, AsyncAPI event topology v0를 기존 `CONSUMES_HTTP_ENDPOINT` envelope의 optional provenance로 저장한다. Protobuf는 Connect-ES `createClient`/`createPromiseClient` 같은 service anchor + lowerCamel RPC call과 `/pkg.Service/Rpc` 또는 `pkg.Service/Rpc` full path 문자열을 인식한다. AsyncAPI는 exact event address token을 계속 요구하되, 해당 line이 Spring Kafka `@KafkaListener`, KafkaJS/Python/Go/Rust style subscribe/listener/consumer 패턴이면 consumer로, `KafkaTemplate.send`, `producer.send`, `send_and_wait`, writer/producer 패턴이면 producer로 분류한다. Provider operation action이 `SEND`/`PUBLISH`면 consumer-side call site만, `RECEIVE`/`SUBSCRIBE`면 producer-side call site만 연결한다.

**맥락:** D-037의 Protobuf/AsyncAPI resolver는 removed RPC/event operation을 known downstream impact로 연결했지만, 사용자가 실제로 쓰는 Claude/Codex context에서는 generated client call-site와 event producer/consumer 방향이 더 중요하다. EventCatalog는 event-driven architecture catalog/visualization, AsyncAPI parser/diff는 dereferenced document validation/diff, Buf/Connect/protobuf-es는 generated service/client shape의 좋은 reference다. 하지만 이 프로젝트의 core value는 local-first, no network/build execution, compact context pack이므로 v0는 외부 toolchain을 실행하지 않고 fresh indexed files만 읽는 deterministic heuristic이어야 한다.

**대안:**
- EventCatalog를 embedded catalog/runtime dependency로 도입 — EDA visualization과 schema explorer는 유용하지만 Astro/React catalog surface와 generator model이 core resolver보다 크다. UI/visual concept만 참고한다.
- `@asyncapi/parser`/`@asyncapi/diff` 또는 Buf/protoc descriptor build를 runtime dependency로 추가 — fidelity는 높지만 install/build/network/dereference/version drift 표면이 커져 D-035/D-037의 compact signature 원칙과 충돌한다.
- 새 `CONSUMES_EVENT`/`PRODUCES_EVENT`/`CONSUMES_RPC` link kind와 DB schema를 추가 — 의미는 더 정확하지만 MCP resource/contract diff가 이미 기존 cross-repo link envelope를 읽고 있어 이번 slice에서는 provenance 확장으로 닫는 편이 작다.
- 변수 추적, config placeholder, Spring property resolution, Kafka regex subscription, AMQP/NATS binding topology까지 구현 — 실제성이 높지만 v0 deterministic test gate를 넘는 scope다.

**결과/위험:** Protobuf generated-client usage는 source files에서만 찾고 generated descriptor files와 generated headers는 계속 제외한다. RPC method-name-only match에는 comment-masked service anchor가 필요하고 source comment 안의 service anchor/full path/RPC call은 consumer evidence로 쓰지 않는다. AsyncAPI event topology는 source/config line의 exact token과 direction-bearing call-site pattern을 함께 요구하며 source comments, docs/examples/README, partial topic match, exact-address-only constants/config는 제외한다. `cross_repo_links.provenance.eventTopology`에는 provider action, counterparty role, pattern name만 저장하고 confidence는 `heuristic`으로 유지한다. 이 v0는 literal topic/call-site가 있는 common path를 줄이는 용도이며, cross-file constants, generated client type flow, GraphQL/protobuf/AsyncAPI full parser/LSP depth, Kafka regex topic, NATS wildcard, AMQP exchange/routing-key graph, schema registry subject inference는 후속이다.

**관련 commit:** `feat(workspace): generated client event topology 추가`

---

## D-040: Contract diff preserves event topology provenance

**결정:** `workspace contract-diff`가 기존 `CONSUMES_HTTP_ENDPOINT` link에서 impacted consumer를 만들 때 optional `eventTopology` provenance를 함께 읽고, `BREAKS_COMPATIBILITY_WITH` link provenance에도 그대로 저장한다. 새 DB column이나 새 link kind는 추가하지 않는다.

**맥락:** D-039에서 AsyncAPI consumer/producers의 방향 hint를 `eventTopology`로 저장했지만, removed AsyncAPI operation을 `BREAKS_COMPATIBILITY_WITH`로 승격하는 contract diff 단계에서 이 정보를 버리면 MCP/UI가 “깨지는 파일”은 알 수 있어도 그 파일이 producer인지 consumer인지 다시 추론해야 한다. 사용자가 원하는 AI context 절감은 resolve 단계의 작은 evidence가 breaking impact까지 이어지는 것이므로, contract diff가 provenance를 손실 없이 전달해야 한다.

**대안:**
- `BREAKS_EVENT_TOPOLOGY_WITH` 같은 새 link kind 추가 — 의미는 명확하지만 MCP/contract resource와 기존 consumer impact path를 넓혀야 하므로 이번 slice에서는 과하다.
- `ImpactedContractConsumer` 결과에는 숨기고 persisted provenance에만 저장 — CLI/MCP caller가 같은 정보를 두 경로에서 다르게 보게 되어 거부한다.
- event topology를 contract diff에서 다시 추론 — D-039의 resolver 판단을 반복하고 drift 위험을 만든다.

**결과/위험:** AsyncAPI removed operation의 impacted consumer result와 persisted breaking link provenance가 provider action, counterparty role, pattern을 유지한다. malformed/legacy consumes provenance처럼 topology가 없거나 shape가 맞지 않는 경우에는 기존처럼 consumer impact만 유지하고 topology는 생략한다. eventTopology schemaVersion은 아직 cross-repo link provenance 내부 shape에 묶여 있으므로, 더 풍부한 NATS/AMQP/Kafka binding graph가 들어오면 새 D-0xx에서 versioned topology payload를 검토한다.

**관련 commit:** `feat(contracts): event topology provenance 보존`

---

## D-041: Contract topology surface stays compact and optional

**결정:** `workspace contract-diff` summary에 optional `eventTopologyCount`와 `eventTopologyBreakdown`을 추가하고, CLI human output과 MCP `/cross-repo-links` resource가 `eventTopology`를 top-level hint로 노출한다. 기존 provenance JSON은 그대로 유지하며, topology가 없는 link/result에는 새 필드를 생략한다.

**맥락:** D-040은 topology를 손실 없이 보존했지만, agent나 사람이 매번 `impactedConsumers[*].eventTopology` 또는 nested provenance를 직접 파싱해야 하면 context 절감 효과가 약해진다. 사용자가 보는 표면에는 “이 breaking impact가 event consumer인지 producer인지”를 한 줄로 보여주고, MCP resource는 full provenance를 확장하지 않아도 rank/filter에 쓸 수 있는 작은 hint를 제공해야 한다.

**대안:**
- 모든 topology detail을 provenance에만 둔다 — schema는 단순하지만 MCP/UI/CLI가 다시 JSON을 파싱해야 하므로 거부한다.
- 새 table/column으로 topology를 정규화한다 — richer topology graph가 확정되기 전에는 migration 비용이 크다.
- topology 없는 HTTP/OpenAPI impact에도 빈 summary를 항상 넣는다 — payload noise가 늘어 compact-first 원칙과 맞지 않는다.

**결과/위험:** topology가 있는 impacted consumer만 summary breakdown에 집계된다. MCP cross-repo link resource는 top-level `eventTopology`를 제공하지만 원본 `provenance`도 계속 제공해 하위 호환을 유지한다. malformed/legacy provenance는 기존처럼 provenance만 반환하고 top-level hint는 생략한다. 더 풍부한 NATS/AMQP/Kafka binding이나 graph UI가 들어오면 이 compact surface를 입력으로 쓰되, 저장 모델 확장은 별도 ADR에서 다룬다.

**관련 commit:** `feat(contracts): topology surface 요약 추가`

---

## 결정을 추가할 때

1. 다음 ID 할당 (`D-NNN`).
2. 색인 표 한 줄 추가.
3. 섹션 추가: 결정 → 맥락 → 대안 → 결과/위험 → 관련 commit.
4. 커밋 메시지 첫 줄에 `decisions: D-NNN <slug>` 포함하면 grep 가능.

기존 결정을 *번복*할 때는:
- 절대 기존 섹션을 지우지 않는다.
- 새 ID로 추가하고 "Supersedes: D-NNN" 명시.
- 색인 표에 기존 결정의 일자 옆 `(superseded by D-MMM)` 추가.
