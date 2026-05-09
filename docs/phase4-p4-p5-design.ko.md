# Phase 4 P4 + P5 — 회고 Design Doc

> **목적:** P2/P3가 사전 design doc (`phase4-p2-p3-design.ko.md`)를 가졌으므로 parity 차원에서 P4 + P5도 회고 design doc을 남긴다. 이미 main에 ship된 작업의 *왜·무엇을 거부했나·결과는*을 기록.
> **작성:** 2026-05-01 (P4 + P5 머지 직후, 회고)
> **참고:** [decisions.ko.md](decisions.ko.md) D-017 / D-018 · [phase4-p2-p3-design.ko.md](phase4-p2-p3-design.ko.md) (선행 design doc 형식 reference) · [progress.ko.md](progress.ko.md)

---

## 1. P4 — 시간 기반 자동 abandon (D-017)

### 문제

D-011 soft-delete의 핵심 가치는 *오래된 speculative branch가 자동으로 정리됨*. 그러나 Phase 3까지의 구현은 사용자가 매번 `branch --abandon <name>`을 명시 호출해야 함. 사용자가 forgetfulness로 호출 안 하면 abandoned가 누적됨. 시간 기반 자동화가 필요하지만 D-009 (no daemon) 정체성을 유지해야 함.

### 결정 공간

(설계 시점에 사용자에게 물은 4 결정)

| ID | 질문 | 채택 옵션 | 거절 옵션 |
|---|---|---|---|
| **D1** | 명령 형태 | (A) `gc-branches --max-age N` flag | (B) 새 `auto-abandon` 명령 — 두 단계 분리, chain cost ×2; (C) `branch --auto-abandon` — single-name 명령에 sweep 어색 |
| **D2** | "활동" 정의 | (i) `branches.head_tx_id`의 `transactions.ts`, NULL 시 `branches.created_at` fallback | (iii) created_at만 — head_tx_id가 NULL인 빈 branch만 의미 |
| **D3** | 보호 / 예외 | silently skip non-active non-abandoned (e.g. 미래의 `'merged'`) | throw — 사용자 화면 더러움 |
| **D4** | 기본 threshold | (α) **default 없음, explicit only** | (β) 60일 default — 의도치 않은 큰 sweep 위험; (γ) env var — destructive op에 암묵적 정책 부적절 |

### 구현 (1 commit)

`src/branch_gc.ts`:
- `GcBranchesOptions.maxAgeDays?: number` 추가 (no default)
- `GcBranchSummary.autoAbandoned: boolean` (이번 패스에서 promote됐는지)
- `GcBranchesResult.autoAbandoned: number` (count)
- `gcBranches()` two-phase: phase 1 (maxAgeDays 있을 때) `LEFT JOIN transactions ON head_tx_id` + `COALESCE(t.ts, b.created_at) < cutoff`로 후보 식별 → state flip; phase 2 archive sweep (이전 동작 유지). 둘 다 *single BEGIN IMMEDIATE* 안.
- 입력 검증: `maxAgeDays`가 non-negative integer 아니면 throw.

`src/cli.ts`:
- `--max-age <days>` flag, strict non-negative integer parsing (`Number.parseInt` + round-trip equality check).

`src/mcp.ts`:
- `impact_trace_gc_branches` schema에 `maxAgeDays: z.number().int().min(0).optional()`.

### 테스트 (+7)

| 테스트 | 검증 |
|---|---|
| auto-abandons stale active branches | head_tx_id가 cutoff 이전 → abandoned + archived |
| never auto-abandons main | main은 PROTECTED |
| dry-run reports candidates without writing | dry-run 시 state 안 flip, archive 안 함 |
| NULL head_tx_id falls back to created_at | 빈 branch도 cover |
| already-abandoned not double-counted | autoAbandoned=false, archive만 진행 |
| backward compat without flag | flag 없으면 기존 archive sweep과 동일 |
| input validation | -1, 1.5 throw |

97 → 104 tests.

### 결과 / 회고

- **잘 된 것:** opt-in flag 패턴이 backward-compat을 완벽히 보존 — 기존 caller 0 영향. ADR D-017이 *왜 default가 없는지* 명시 → 후속 사용자가 "왜 60일 default 안 함?"을 묻지 않음.
- **함정:** `branches.created_at`이 `main` 행에서만 SQLite `datetime('now')` 형식 (ISO 8601 아님) — main이 PROTECTED라 비교에서 제외되므로 문제 없음. 이 *우연한 일치*는 글로서리에 명시.
- **남은 우려:** 미래에 `'merged'` 같은 새 state가 도입되면 silent skip 동작이 surprising일 수 있음. 그 시점에 별도 ADR로 `'merged'` 처리 정책 결정.

---

## 2. P5 — sqlite-vec ANN (D-018)

### 문제

`sqlite-vec ^0.1.9`가 Phase 1.5부터 dependency tree에 있었으나 *한 번도 wiring되지 않음* (`loadVectorExtension` export됐지만 호출 사이트 0). recallSemantic은 모든 fact_embeddings 행을 SELECT 후 JS dot product — O(N) per query. 1만 행 이상에서 사용자 인지 latency.

### 결정 공간

| ID | 질문 | 채택 옵션 | 거절 옵션 |
|---|---|---|---|
| **D1** | virtual table 구조 | (a) **per-model `vec_facts_<model_slug>`** | (b) single table + model 컬럼 + max-dim padding — 768d + 64d 혼재 시 12배 storage 낭비 |
| **D2** | 생성 시점 | (ii) **lazy at first dual-write** | (i) v8 migration에서 사전 생성 — 알려진 모델 없으면 의미 없음 |
| **D3** | 기존 데이터 backfill | (iii) **explicit `reindex-vec` CLI** + (ii) automatic fallback | (i) v8 자동 backfill — blocking first open |
| **D4** | vector 타입 | (1) **int8[N]** | (2) float[N] (storage 4×); (3) bit[N] (정확도 ↓ 추후 별도 optimization) |
| **D5** | fallback 정책 | (β) **silent fall back to brute-force** | (α) extension 로드 실패 시 throw — 기존 caller 회귀 |

### 구현 (1 commit)

`src/store.ts` — 새 export 4개:
- `isVectorExtensionLoaded(db)` — db 핸들이 sqlite-vec 로드에 성공했는지
- `vecTableName(model)` — model id를 SQL-safe 식별자로 변환 (`Xenova/multilingual-e5-base` → `vec_facts_xenova_multilingual_e5_base`); 비-알파뉴메릭은 `_`로 → SQL injection 차단
- `ensureVecTable(db, model, dim)` — lazy `CREATE VIRTUAL TABLE IF NOT EXISTS`; dim/식별자 검증 실패 시 false 반환
- `hasVecTable(db, model)` — `sqlite_master` lookup으로 존재 확인

`openDatabase()`에 `loadVectorExtension(db)` 호출 추가, 결과를 WeakMap에 기록 (silent fallback).

`src/agent_memory.ts`:
- `remember()` 안 dual-write — `INSERT INTO fact_embeddings ...` 다음에 `DELETE FROM vec_<model> WHERE fact_id = ? + INSERT INTO ... VALUES (?, vec_int8(?))`. **핵심 함정:** 768-byte int8 buffer가 vec0에 의해 자동으로 float32로 인식됨 (768/4=192) → `vec_int8(?)` 명시 cast 필수. **두 번째 함정:** vec0가 `INSERT OR REPLACE` 미지원 → `DELETE + INSERT` 패턴.
- `reembedFacts()` bulk write도 dual-write — model별 prepare 캐싱.
- `recallSemantic()` 분기:
  - `isVectorExtensionLoaded(db) && hasVecTable(db, model)` → `recallSemanticAnn`
  - 그 외 또는 ANN SQL 에러 → `recallSemanticBruteForce` (기존 코드 그대로 보존)
- ANN path SQL: vec0 `WHERE embedding MATCH vec_int8(?) AND k = ?`로 over-fetch (k×5, min 20), 그 후 INNER JOIN `facts` + `transactions`로 archived/entity/attribute/branch filter, `ORDER BY distance ASC LIMIT k`.
- 새 `reindexVec()` + `reindexVecOnRepo()` — `fact_embeddings`에서 (model, dim) 그룹별로 `vec_<model>` 테이블 DELETE + bulk re-INSERT.

`src/cli.ts`: `reindex-vec [--model <id>]` 명령.
`src/mcp.ts`: 변경 없음 (reindex는 CLI 전용).
`src/index.ts`: 새 4개 store 헬퍼 + reindexVec/reindexVecOnRepo + types re-export.

### 테스트 (+8, 신규 파일 `tests/vec.test.ts`)

| 테스트 | 검증 |
|---|---|
| extension load + lazy create | 첫 write 후 vec table 존재 |
| vecTableName SQL safety | injection 시도 (`'; DROP TABLE facts; --`) → 무해한 식별자 |
| ANN top-1 parity with brute-force | 같은 query → 같은 top-1 entity |
| archived filter (D-011) in ANN | gc된 fact는 ANN에서도 surface 안 함 |
| branch isolation in ANN | branch=main 호출이 experiment-a fact 안 surface |
| reindexVec 라운드트립 | DROP vec table → reindex → ANN 정상 |
| reembed populates vec0 | reembed `--all` 후 vec table에 row |
| ensureVecTable input validation | 빈 model, dim=0, dim=99999, dim=1.5 → false |

104 → 112 tests.

### 결과 / 회고

- **잘 된 것:** silent fallback 정책 (D5)이 *upgrade-only* 보장 — sqlite-vec native binary 로드 실패해도 caller 0 영향. P2/P3와 같은 패턴 (D-015 idempotent INSERT OR IGNORE, D-016 atomic state+unarchive)이 P5에도 적용됨 (per-model isolation, lazy create).
- **함정 (다시):** `vec_int8(?)` cast와 `DELETE+INSERT` 패턴은 vec0의 *문서화 안 된* 동작이라 *runtime test*로만 잡힘. ADR D-018에 함정으로 명시 → 후속 회귀 방지.
- **남은 우려:** ANN over-fetch factor (k×5, min 20)가 적절한지 fixture로 검증 못 했음 — Phase 5의 MemoryBench가 등장하면 *실측*으로 조정 가능. 현재는 휴리스틱.
- **시야 외:** sqlite-vec 0.1.x는 활발히 개발 중. 0.2.x로 업그레이드 시 API 호환성 확인 필요 — silent fallback이 buffer 역할.

---

## 3. 종합 — Phase 4가 끝난 시점의 작은 정리

| 측정 | Phase 4 시작 (`e15f668`) | Phase 4 끝 (`33c49f0`) |
|---|---|---|
| Tests | 76 | 112 (+36) |
| MCP tools | 8 | 12 (+4: profile, repair, restore, gc--max-age 추가는 기존 tool 옵션) |
| CLI commands | 14 | 16 (+2: profile, reindex-vec) |
| ADRs | D-001..D-012 | D-001..D-018 (+6) |
| Source LOC (src/) | ~3.5k | ~4.7k (+~1.2k) |
| 외부 dep 추가 | 0 | 0 (sqlite-vec는 이미 in) |
| Schema migration | v7 (Phase 3) | v7 (변경 없음 — vec table은 lazy create, ADD-only 정신) |

Phase 4의 5개 sub-phase가 *각자 독립적으로* 안전하게 ship됨 (각 phase는 backward compat). 이 패턴이 Phase 5에서도 유지되어야 함 — 특히 MemoryBench는 main 빌드를 깨지 않는 *additive* 도입.

---

## 4. 이 문서를 다시 쓸 때

P5 design doc과 같은 *회고 형식* (문제 → 결정 → 구현 → 테스트 → 결과)이 P2/P3와 P4/P5 사이에 일관되도록 유지. 새 phase가 ship된 후 7일 안에 회고 design doc 작성 (memory가 fresh한 동안). dual-voice consensus 형식이 사전 design doc에 더 적합 — 회고는 단일 voice로 충분.
