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

**결과/위험:** Spring/Spring Boot fixture의 핵심 relation은 bounded snippet과 `startLine/endLine/startCol/endCol`를 갖는다. ImpactBench `spanCompleteness` gate는 0.85로 올라간다. v0는 shallow regex라 nested annotation expression, build-generated symbols, runtime wiring은 여전히 다루지 않는다. D-024에서 Python/Go/Rust lightweight span까지 반영하고, workspace resolver는 후속으로 남긴다.

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

## 결정을 추가할 때

1. 다음 ID 할당 (`D-NNN`).
2. 색인 표 한 줄 추가.
3. 섹션 추가: 결정 → 맥락 → 대안 → 결과/위험 → 관련 commit.
4. 커밋 메시지 첫 줄에 `decisions: D-NNN <slug>` 포함하면 grep 가능.

기존 결정을 *번복*할 때는:
- 절대 기존 섹션을 지우지 않는다.
- 새 ID로 추가하고 "Supersedes: D-NNN" 명시.
- 색인 표에 기존 결정의 일자 옆 `(superseded by D-MMM)` 추가.
