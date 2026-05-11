# Impact-trace 용어집

이 프로젝트는 두 축 (영향 분석 + 에이전트 메모리)이 같은 SQLite 위에 살면서 *겹치는 어휘*를 쓴다. 이 문서는 그 모호함을 해소한다. 빠른 답은 다음 표를 보고, 정확한 정의는 아래 섹션을 본다.

| 용어 | 영향 분석 축 | 에이전트 메모리 축 |
|---|---|---|
| **branch** | 의미 안 함 (해당 축은 git branch만 다룸) | `branches` 테이블의 한 행 — head_tx_id가 추적하는 *speculative line of work* |
| **entity** | `entities` 테이블 — 코드의 식별 가능한 단위 (file/symbol/module/contract/policy 등 21종) | fact의 *주어* 문자열 (`'file:src/foo.ts'` 같은 자유로운 식별자) |
| **transaction** | 의미 안 함 | `transactions` 테이블의 한 행 — 한 commit 단위의 *fact 묶음* (parent_tx_id로 DAG 형성) |
| **relation** | `relations` 테이블 — entity↔entity (DEPENDS_ON, CALLS, IMPLEMENTS 등 15종) | 사용 안 함 (대신 `fact_provenance` edge) |
| **fact** | 사용 안 함 | `facts` 테이블 — content-addressable 관찰 (`(entity, attribute, value, op)` SHA-256) |
| **report** | `reports` 테이블 — analyzer가 만든 영향도 분석 결과 | 사용 안 함 |

---

## 영향 분석 축의 핵심 용어

### entity (impact)
`entities` 테이블의 한 행. file / symbol / module / package / test / doc / config / policy / workflow / resource / endpoint / contract / event / business_plan / ... 등 21종 중 하나. 영향 분석은 entity 사이의 relation graph를 따라 blast radius를 계산한다.

### relation (impact)
`relations` 테이블. `(source_entity_id, target_entity_id, kind, confidence, adapter_run_id)`. kind는 `DEPENDS_ON`, `DECLARES`, `CALLS`, `REFERENCES`, `VERIFIES`, `DOCUMENTS`, `CONFIGURES`, `GENERATES`, `DEPLOYS`, `OWNS`, `GOVERNS`, `IMPLEMENTS`, `CONSUMES`, `PRODUCES`, `BREAKS_COMPATIBILITY_WITH` 중 하나.

### relation_evidence
relation을 뒷받침하는 source span / 명령 출력 / confidence 근거. "왜 이 relation을 추출했는가"의 audit trail.

### contract / endpoint / event
`contracts`, `cross_repo_links` 테이블. OpenAPI / protobuf / GraphQL / AsyncAPI를 entity로 모델링해 *cross-repo* 영향을 분석한다 (provider repo의 API 변경 → consumer repo 깨짐).

### workspace
`workspaces`, `workspace_repos` — 여러 repo를 하나의 *제품/조직 경계*로 묶는 logical 단위. 단일 repo에서는 의미 안 함.

### adapter_run
한 indexing pass의 메타데이터 — adapter ID, version, parser tool version, error summary. coverage gap을 추적.

---

## 에이전트 메모리 축의 핵심 용어

### fact
`facts` 테이블. 한 행 = 한 관찰. **PK는 SHA-256(`entity || attribute || value_blob || op`)** (D-002). 같은 (entity, attribute, value, op) 튜플은 항상 같은 id → dedup 자동.

| 컬럼 | 의미 |
|---|---|
| `id` | content-hash PK |
| `entity_id` | fact의 *주어* — 자유로운 문자열 (`'file:src/foo.ts'`, `'task:T-1234'`, `'agent:claude'`) |
| `attribute` | *술어* — `'observed'`, `'verified'`, `'imports'`, `'reflection'` 등 |
| `value_blob` | JSON-encoded 값 |
| `op` | `'assert'` 또는 `'retract'` |
| `tx_id` | 이 fact를 만든 transaction |
| `redacted` | 1이면 value가 `'[REDACTED]'`로 저장된 것 (D-004) |

### transaction (memory)
`transactions` 테이블. 한 commit 단위의 *fact 묶음*. `parent_tx_id` (linear) + `transaction_parents(tx_id, parent_tx_id)` (multi-parent, merge용). recall은 recursive CTE로 walk.

| 컬럼 | 의미 |
|---|---|
| `id` | content-hash (parent_tx_id, branch_id, ts, agent) |
| `parent_tx_id` | 직전 tx (linear) |
| `branch_id` | 어느 branch에 속하는지 |
| `ts` | ISO 8601 `'YYYY-MM-DDTHH:mm:ss.sssZ'` |
| `agent` | 누가 만들었는지 (`'mcp:remember'`, `'reflect:branch=main'` 등) |
| `archived` | 1이면 gc-branches로 archive됨 (D-011) |

### branch (memory)
`branches` 테이블 — agent의 speculative line of work. git branch와 *별개 개념*. 같은 repo에서 여러 메모리 branch 가능 (`main`, `experiment-a`, `plan-B`). 각 branch는 head_tx_id가 자기 latest tx를 가리킴.

| 컬럼 | 의미 |
|---|---|
| `name` | UNIQUE — `'main'`이 PROTECTED |
| `head_tx_id` | 최신 tx (NULL이면 빈 branch) |
| `parent_branch_id` | fork 출처 |
| `state` | `'active'` / `'abandoned'` (D-011 soft-delete) |

### fact_provenance
fact 사이의 provenance chain. `(fact_id, source_fact_id, kind, tx_id)` — `kind`는 `'evidence'` (인덱서/agent가 만든 근거), `'summary'` (Phase 3 reflective consolidation의 source), `'supersedes'` (새 fact가 오래된 decision/summary/policy fact를 명시적으로 대체)를 가진다. `tx_id`는 edge가 생성된 transaction이라 content-addressed replacement fact가 재사용돼도 branch/as-of visibility를 정확히 판단한다. `trace`는 edge kind를 함께 반환하고, recall/profile의 현재 view는 superseded fact를 숨긴다.

### reflection
`reflections` 테이블 — Phase 3 reflective consolidation의 audit row. *summary fact*는 `facts.attribute = 'reflection'`로 저장되고, reflections 테이블이 모델/입력 fact 개수/생성 시각을 기록한다. orphan 상태가 발생하면 `reflect --repair` (D-015)가 보정.

### profile
`profileEntity()`의 결과 — 한 entity의 facts를 3-bucket으로 분할: **staticFacts** (코드 관계, `is_code_relation=1`) / **dynamicFacts** (에이전트 활동) / **summaryFacts** (reflection). D-014로 recall과 별도 export.

### lifecycle
attribute의 binary 분류 — `'static'` (코드 관계, 영구적) vs `'dynamic'` (에이전트 활동, 휘발성). D-013에서 새 컬럼 없이 `attribute_defs.is_code_relation`으로부터 query-time derive.

### fact_embeddings (canonical) vs vec_facts_<model_slug> (ANN index)
| 테이블 | 역할 |
|---|---|
| `fact_embeddings(fact_id, model, vector BLOB int8, dim, created_at)` | **canonical** — D-007 multi-model PK; brute-force recall이 사용 |
| `vec_facts_<model_slug>(fact_id TEXT PK, embedding int8[<dim>])` | **ANN index** (D-018) — sqlite-vec vec0, lazy-created at first dual-write, per-model |

---

## 자주 헷갈리는 쌍

### branch (git) vs branch (memory)
같은 단어, *완전히 다른 개념*. git branch는 git 자체가 관리하고 impact-trace는 직접 접근 안 함. memory branch는 `branches` 테이블의 행이며 `branch --name foo` / `branch --abandon foo` / `branch --restore foo` / `merge` 명령으로 다룸.

### entity (impact) vs entity_id (memory)
- impact의 entity는 `entities` 테이블의 *struct* (id + kind + version + source span).
- memory의 `entity_id`는 *문자열* — 어떤 자유 식별자든 가능 (`'file:src/foo.ts'`, `'pr:42'`, `'concept:auth'`). 메모리 축은 entity 테이블을 *읽지 않는다*; 두 축이 같은 문자열을 쓰면 (`'file:src/foo.ts'`) 자연스럽게 cross-reference되지만 강제는 없음.

### transaction (DB) vs transaction (memory)
- DB transaction: `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`. SQLite 수준의 atomic write 단위.
- memory transaction: `transactions` 테이블 행. *논리적 commit unit* — 한 `remember()` 호출이 한 memory tx를 만들고, 그 안에 한 fact 추가. Memory tx는 항상 한 DB tx 안에서 만들어짐.

### fact vs relation
- impact axis: relation (entity ↔ entity).
- memory axis: fact (entity + attribute + value).
- 둘은 *다른 컬럼셋, 다른 테이블*. 의도적 분리 — relation은 typed graph, fact는 free-form key-value with content addressing.

### static fact vs dynamic fact vs summary fact
- **static fact** — `attribute_defs.is_code_relation = 1`인 attribute로 만든 fact (`imports`, `calls`, `affects`, `depends_on`). 인덱서가 추가; 코드 구조를 표현.
- **dynamic fact** — `is_code_relation = 0`인 attribute (`observed`, `verified`, `concern`). 에이전트 활동.
- **summary fact** — `attribute = 'reflection'`인 fact. Phase 3 reflective consolidation이 만든 *원본의 요약본*. D-010으로 원본 보존.

### reflect vs repair (vs reindex-vec)
- `reflect` — 오래된 facts를 LLM으로 요약 (Phase 3, D-009 explicit trigger).
- `reflect --repair` — orphan summary fact 보정 sweep (D-015, Phase 4 P2).
- `reindex-vec` — 기존 `fact_embeddings`로부터 `vec_facts_<model>` 테이블 backfill (D-018, Phase 4 P5).
- 셋 다 *명시 trigger*만 있고 daemon 없음 (D-009).

---

## SQLite 형식 메모

- 모든 ts는 ISO 8601 UTC `'YYYY-MM-DDTHH:mm:ss.sssZ'` (`new Date().toISOString()`).
- 예외: `branches.created_at`이 `main` 행에서만 SQLite `datetime('now')` 형식 (`'YYYY-MM-DD HH:MM:SS'`). main은 PROTECTED라 비교에서 제외되므로 영향 없음.
- 모든 binary 데이터는 BLOB (vector는 int8 packed Buffer).
- 모든 JSON 데이터는 TEXT 컬럼 + JSON.stringify (D-002 content-hash 안정성을 위해 key 순서는 V8 기본).
