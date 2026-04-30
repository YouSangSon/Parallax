# Architecture Decisions Log

> **목적:** 프로젝트의 *돌이키기 어려운* 결정과 그 이유를 한곳에 모은다.
> 코드는 변하지만, 결정의 *맥락*은 코드에 남지 않는다. 이 문서가 그 맥락을 보존한다.
> **포맷:** 결정 1개 = 1 섹션. 각 섹션은 *결정·맥락·고려한 대안·결과/위험·관련 commit*.
> **English pair:** [decisions.en.md](decisions.en.md).

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

**맥락:** Letta MemGPT 같은 다른 시스템은 종종 원본을 archive/retract. 본 프로젝트는 *audit trail* 우선. "왜 이 결정을 내렸나"의 답이 되는 source facts는 영원히 살아있어야 함.

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

**맥락:** [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory)는 메모리 lifetime을 결정하는 `isStatic` 플래그를 갖고 있다. 우리 분석 (`docs/supermemory-adoption.ko.md`) 결과 *동일 정보가 이미 attribute level에 있음*. `is_code_relation=1` (imports/calls/affects/depends_on)는 영구 코드 구조, `=0` (observed/verified/concern/reflection/...)는 동적 agent 활동.

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

## 결정을 추가할 때

1. 다음 ID 할당 (`D-NNN`).
2. 색인 표 한 줄 추가.
3. 섹션 추가: 결정 → 맥락 → 대안 → 결과/위험 → 관련 commit.
4. 커밋 메시지 첫 줄에 `decisions: D-NNN <slug>` 포함하면 grep 가능.

기존 결정을 *번복*할 때는:
- 절대 기존 섹션을 지우지 않는다.
- 새 ID로 추가하고 "Supersedes: D-NNN" 명시.
- 색인 표에 기존 결정의 일자 옆 `(superseded by D-MMM)` 추가.
