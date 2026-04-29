# Phase 3 Design — Reflective Consolidation + Speculative Branch GC

> **상태:** 2026-04-29 작성 · Phase 3 본격 시작
> **선행:** [phase3-handoff.ko.md](phase3-handoff.ko.md) (이전 세션 핸드오프) · [agent-db-exploration.ko.md](agent-db-exploration.ko.md) (큰 그림) · [agent-memory-cookbook.ko.md](agent-memory-cookbook.ko.md) (사용 가이드)
> **이 문서의 목적:** 코드를 짜기 전에 *무엇을, 왜, 어떻게* 만들지 결정한다. autoplan 방법론(CEO scope challenge / Eng dual-voice consensus / DX scorecard)을 차용해 본 문서 자체에 self-review를 내장한다.

---

## 0. 한 줄 요약

> *"오래된 episodic facts를 entity별로 LLM이 묶어 요약해 semantic 계층으로 승격하고, 버려진 branch의 transactions를 soft-delete로 정리한다. LLM은 Anthropic/OpenAI/Ollama/stub 4-provider 추상화. 모든 변경은 schema v7 ADD-only 마이그레이션 1개에 들어간다."*

---

## 1. 문제 정의 (premise)

| 문제 | 증거 | 미해결 시 비용 |
|---|---|---|
| **Episodic memory 무한 누적** | Phase 1+2 완성 후 facts 테이블은 영원히 append. 1년 후 백만 건 단위 가능. | recall 속도 저하, 의미 있는 fact가 노이즈에 묻힘. |
| **Speculative branch 누적** | agent가 plan 시뮬레이션을 위해 branch를 마구 만들고 버리는 패턴. 한 달 100개 가능. | DB 비대화, branch 목록 관리 복잡도 ↑. |
| **요약 LLM provider lock-in 회피** | local-only(Ollama) vs API-only(Anthropic) 둘 중 하나 고르면 사용자 환경에 따라 막힘. | 사용자가 Ollama 안 깔린 머신/CI에서 작동 불가. |

**Premise 평가** (autoplan CEO 풍 self-challenge):
1. *"무한 누적이 정말 문제냐?"* → SQLite는 수백만 행도 잘 처리. 진짜 비용은 **agent가 매번 모든 fact를 훑는 비용** (recall LIMIT 20 이라도 candidate set이 커지면 ranking 비용 증가). **유효한 premise.**
2. *"branch GC가 정말 필요하냐?"* → content-addressable이라 facts는 어차피 dedup된다. branch 자체와 transactions만 정리하면 된다. *상대적으로 작은 문제지만, schema v7에 포함하면 marginal cost가 0에 수렴*. **포함.**
3. *"multi-provider가 정말 필요하냐?"* → user 명시 요청. 그리고 stub provider가 있으면 *외부 호출 없이 CI/test 가능*해서 단일 provider보다 오히려 단순하다. **유효.**

---

## 2. 결정 사항 (D1–D4) — 확정값

| ID | 결정 | 선택 | 거부된 옵션과 이유 |
|---|---|---|---|
| **D1** | LLM provider 선택 | **Multi-provider** (`stub`/`ollama:*`/`anthropic:*`/`openai:*`) | (a) Ollama-only: API 사용자 막힘. (b) Anthropic-only: privacy 정체성 위반. |
| **D2** | Reflection trigger | **명시 명령** `impact-trace reflect` | (1) cron-style 자동: daemon-less 정체성 위반. (2) 카운트 hook: 예측 불가 latency. |
| **D3** | 원본 fact 처리 | **(A) 보존 + summary fact 추가** + `fact_provenance kind='summary'` edge | (B) retract: 소급 검색 불가. (C) archive 테이블 분리: 두 SELECT 경로 필요, 복잡도 ↑. |
| **D4** | Branch GC 정책 | **명시 abandon + soft-delete** via `transactions.archived=1` | (i) 시간 기반 자동: 사용자 의도 모름. (B) hard-delete: 비가역, 위험. |

---

## 3. Schema v7 — ADD-only 마이그레이션

### 3.1 변경 사항

```sql
-- 새 컬럼 (idempotent via PRAGMA table_info check)
ALTER TABLE branches         ADD COLUMN state    TEXT    NOT NULL DEFAULT 'active';
ALTER TABLE transactions     ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fact_provenance  ADD COLUMN kind     TEXT    NOT NULL DEFAULT 'evidence';

-- 새 테이블
CREATE TABLE IF NOT EXISTS reflections (
  id                 TEXT PRIMARY KEY NOT NULL,
  branch_id          TEXT NOT NULL,
  model              TEXT NOT NULL,
  summary_fact_id    TEXT NOT NULL,
  source_fact_count  INTEGER NOT NULL,
  criteria_json      TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  FOREIGN KEY(branch_id)       REFERENCES branches(id),
  FOREIGN KEY(summary_fact_id) REFERENCES facts(id)
);
CREATE INDEX IF NOT EXISTS idx_reflections_branch ON reflections(branch_id);

INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (7, datetime('now'));
```

### 3.2 ADD COLUMN idempotence

SQLite는 `ALTER TABLE ... ADD COLUMN`을 지원하지만 `IF NOT EXISTS`는 없다. 본 코드베이스 패턴(`CREATE TABLE IF NOT EXISTS`)을 유지하기 위해 작은 헬퍼:

```typescript
function tryAddColumn(db: Db, table: string, column: string, definition: string): void {
  const exists = db
    .prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?')
    .get(table, column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
```

`pragma_table_info`는 SQLite 3.16+ 에서 사용 가능한 *table-valued function*. parameterized query로 안전.

### 3.3 backward compat

- `branches.state`: 기존 row는 NOT NULL DEFAULT 'active'로 자동 채워짐. 어떤 코드도 깨지지 않음.
- `transactions.archived`: DEFAULT 0. recall 쿼리에 `AND t.archived = 0` 추가 필요(아래 §6.4).
- `fact_provenance.kind`: DEFAULT 'evidence'. 기존 `trace()` 함수는 kind 무시하고 모든 edge walk → 동작 유지. 새 reflection은 'summary' kind로 표시.

---

## 4. LLM 추상화 (`src/llm.ts`)

### 4.1 디자인 원칙

본 코드베이스의 `src/embeddings.ts`가 이미 **provider-prefix sentinel** 패턴을 사용한다. 같은 패턴을 LLM에도 적용한다.

```
IMPACT_TRACE_REFLECTION_MODEL=stub                       → summarizeStub
IMPACT_TRACE_REFLECTION_MODEL=ollama:gemma2:2b           → summarizeOllama
IMPACT_TRACE_REFLECTION_MODEL=anthropic:claude-haiku-4-5 → summarizeAnthropic
IMPACT_TRACE_REFLECTION_MODEL=openai:gpt-4o-mini         → summarizeOpenAI
```

### 4.2 인터페이스

```typescript
export interface SummarizeInput {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;     // default 1024
  temperature?: number;   // default 0.2 (deterministic-ish)
}

export interface ReflectionResult {
  model: string;          // canonical id ("ollama:gemma2:2b" 등)
  summary: string;        // raw text. caller가 redactSecrets() 적용
  inputTokens?: number;
  outputTokens?: number;
}

export async function summarize(input: SummarizeInput): Promise<ReflectionResult>;
```

### 4.3 의존성 결정 — *fetch만 사용, SDK 추가 없음*

| 옵션 | 무게 | 결정 |
|---|---|---|
| `@anthropic-ai/sdk` 추가 | +2.5 MB transitive deps | ❌ |
| `openai` SDK 추가 | +3 MB | ❌ |
| Native `fetch` (Node 24+) + REST | 0 추가 deps | ✅ |

**근거:** Anthropic/OpenAI Messages API는 단일 POST. SDK가 주는 가치는 retry/streaming 정도지만, *first call* reflection은 streaming 불필요, retry는 한 번 시도 후 실패 throw로 충분. dep 추가는 본 프로젝트 minimalism 위반.

### 4.4 redact-then-prompt 게이트

```typescript
// 모든 LLM 호출 직전에 적용
const safeSystem = redactSecrets(input.systemPrompt);
const safeUser   = redactSecrets(input.userPrompt);
// → fetch(...)
```

그리고 **출력도 redactSecrets**: 모델이 입력을 echo할 수 있다.

```typescript
const summary = redactSecrets(rawOutput);
```

### 4.5 stub provider — 테스트용 결정적 출력

```typescript
function summarizeStub(input: SummarizeInput): ReflectionResult {
  // 결정적: 동일 입력 → 동일 출력. 외부 호출 없음.
  const compact = `[stub-summary] sys=${input.systemPrompt.length}b user=${input.userPrompt.length}b`;
  return { model: 'stub', summary: compact };
}
```

CI에서 `IMPACT_TRACE_REFLECTION_MODEL=stub`로 외부 의존 없이 reflection 경로 검증 가능.

---

## 5. Reflection (`src/reflection.ts`)

### 5.1 알고리즘 (entity별 그룹화)

```
Input: branch (default main), olderThanDays (default 30)
1. SELECT facts WHERE branch_id = ? AND ts < cutoff AND redacted = 0 AND op = 'assert'
   GROUP BY entity_id (in-memory)
2. for each entity with >= 2 facts:
   - prompt = system "summarize an entity's history"
   + user "Entity: <id>\nObservations:\n<bullet list>"
   - call summarize() (async, OUTSIDE SQLite tx)
   - redactSecrets(output)
3. for each result:
   - remember(entity, attribute='reflection', value=summary,
              evidenceFactIds=sourceFactIds) → factId
   - UPDATE fact_provenance SET kind='summary' WHERE fact_id=factId AND source_fact_id IN (...)
   - INSERT INTO reflections (...)
```

### 5.2 임계값 — 왜 2개 이상?

1개짜리 entity는 요약할 *것이 없다* (한 fact를 그대로 다시 적는 셈). 2개 미만은 skip.

상한은 두지 않는다. 100개 fact entity가 있다면 prompt에 100줄 들어가는데, 모델 context 한도 (~8K tokens for gemma2:2b, ~200K for Claude)는 사실상 안전. 만약 토큰 초과로 fail하면 caller가 `--older-than 14d` 같은 좁은 범위로 재시도.

### 5.3 attribute 등록

새 attribute `reflection`을 `attribute_defs` registry에 추가 (idempotent INSERT OR IGNORE):

```sql
INSERT OR IGNORE INTO attribute_defs (name, value_type, is_code_relation, description)
VALUES ('reflection', 'text', 0, 'LLM-generated semantic summary of an entity history');
```

### 5.4 Async outside SQLite tx — *이 코드베이스의 표준 패턴*

`rememberOnRepo`/`recallOnRepo`/`reembedFacts` 모두 동일 패턴:

1. async LLM/embedding 계산 → **DB tx 바깥**에서 끝낸다
2. sync withAgentMemoryDb(...) 안에서 짧은 BEGIN/COMMIT으로 write

이유: better-sqlite-style sync API는 callback이 sync이고, 그 안에 await가 있으면 db 핸들이 너무 일찍 close된다. Phase 1 이후로 일관적으로 지킨 invariant. **반드시 유지**.

### 5.5 인터페이스

```typescript
export interface ReflectOptions {
  branch?: string;        // default 'main'
  olderThanDays?: number; // default 30
  entity?: string;        // 좁은 entity로 제한
  agent?: string;         // default 'reflect:<model>'
  dryRun?: boolean;       // LLM 호출은 하되 write 안 함
}

export interface ReflectResult {
  branch: string;
  model: string;
  summarized: number;
  skippedEntities: number;
  reflections: Array<{
    entity: string;
    summaryFactId: string;
    sourceCount: number;
  }>;
}

export async function reflectFacts(
  repoRoot: string,
  options?: ReflectOptions
): Promise<ReflectResult>;
```

---

## 6. Branch GC (`src/branch_gc.ts`)

### 6.1 abandon 동작

```typescript
abandonBranch(db, { name }):
  - branch = SELECT FROM branches WHERE name = ?
  - guard: name == 'main' → throw
  - guard: state == 'abandoned' → idempotent no-op
  - UPDATE branches SET state = 'abandoned' WHERE id = ?
```

### 6.2 GC sweep — soft-delete

```typescript
gcBranches(db, { dryRun? }):
  - branches = SELECT id, name FROM branches
               WHERE state = 'abandoned' AND name != 'main'
  - for each branch:
      - exclusiveTxs = SELECT id FROM transactions WHERE branch_id = ?
      - if !dryRun: UPDATE transactions SET archived = 1 WHERE id IN exclusiveTxs
      - facts: 절대 건드리지 않음 (content-addressable, 다른 branch에서 참조 가능)
  - return { scanned, archivedTransactions, branches: [...] }
```

**핵심 안전성:** facts는 절대 삭제하지 않는다. content-addressable이라서:
- abandoned branch가 만든 fact A
- 다른 active branch도 같은 (entity, attribute, value)를 remember하면 → 동일 fact A를 참조
- A를 삭제하면 active branch가 깨진다

대신 *transaction*을 archive: recall이 archived tx 통해 fact를 가져오지 않게 막으면 됨. fact 자체는 그대로 남는다.

### 6.3 archive로 무엇을 막는가?

```sql
-- recall (구조 필터)
SELECT ... FROM facts f INNER JOIN transactions t ON f.tx_id = t.id
WHERE t.branch_id = ? AND t.archived = 0 ...

-- recallSemantic
... INNER JOIN transactions t ON f.tx_id = t.id ...
... AND t.archived = 0 ...
```

archived=1인 tx를 거쳐서만 도달 가능한 fact는 recall 결과에서 사라진다. 다른 *active* tx에서 같은 fact를 작성한 적이 있으면 그쪽 경로로 여전히 보인다.

### 6.4 recall에 archived 필터 추가

`agent_memory.ts`의 `recall`/`recallSemantic` SQL에 한 줄씩 추가:

```diff
 const conditions: string[] = [];
+conditions.push('t.archived = 0');
 if (!useAsOf) {
   conditions.push('t.branch_id = ?');
```

기존 테스트는 archived=0 default라 모두 통과. 새 테스트만 추가.

### 6.5 trace는?

`trace()`는 fact_provenance edge를 walk한다. archived 무관. *causal chain은 archive 영향 받지 않음* — 의도. trace는 audit/debug 용도라 archived branch도 보이는 게 맞다.

---

## 7. CLI / MCP 표면

### 7.1 CLI

```bash
impact-trace reflect [--branch main]
                     [--older-than-days 30]
                     [--entity <id>]
                     [--model <provider:id>]
                     [--dry-run]

impact-trace branch --abandon <name>      # state 변경
impact-trace gc-branches [--dry-run]      # archive sweep
```

기존 명령은 그대로. `branch`는 두 mode로 동작:
- `--name`: 새 branch 생성 (기존)
- `--abandon`: 기존 branch state 변경 (신규)

### 7.2 MCP

세 새 tool. `readOnlyHint`/`destructiveHint`는 정직하게:

| Tool | readOnly | destructive | 설명 |
|---|---|---|---|
| `impact_trace_reflect` | false | false | LLM 호출 + summary fact 추가. 원본 보존이라 destructive 아님. |
| `impact_trace_abandon_branch` | false | false | state 컬럼 변경. soft change. |
| `impact_trace_gc_branches` | false | false | archived flag 갱신. soft-delete. |

만약 D4 결정이 (B) hard-delete였다면 `destructiveHint=true`였을 것. 우리 정책에선 false.

### 7.3 reembed와 reflect의 관계

`reembed`는 *모델 swap* 용도 (동일 fact, 새 vector). `reflect`는 *새 fact 생성* (summary).

별도 명령으로 분리. 혼동 없음. 둘 다 SQLite tx 바깥에서 async 처리하는 패턴 동일.

---

## 8. dual-voice consensus — self-review

autoplan의 dual-voice 패턴을 수동으로 적용. 두 가지 관점("CEO/strategist" + "Eng senior")으로 본 design을 도전.

### 8.1 CEO/Strategist 관점 — 전략 도전

| Q | 답 |
|---|---|
| 진짜 문제 맞나? | ✅ Episodic 누적은 *agent memory 시스템의 잘 알려진 한계* (Park 2023, Letta MemGPT, Mem0 모두 reflection 메커니즘 보유). |
| 6개월 후 후회 시나리오? | ⚠️ "Ollama만 썼으면 됐는데 multi-provider라 fetch 코드 4배". → 답: stub만으로도 CI/test 충분, anthropic/openai는 *opt-in*. 사용자가 안 켜면 추가 비용 0. |
| 더 큰 reframing 가능? | ❌ "차라리 vector clustering으로 자동 그룹화"? → topic 클러스터링은 Phase 4 후보. entity별 그룹화가 *최소 viable*. handoff §3 Recommendation과 일치. |
| 경쟁/시장 risk? | 없음 (local-first 자체가 경쟁 없는 niche). |

### 8.2 Eng senior 관점 — 아키텍처 도전

| Q | 답 |
|---|---|
| ALTER TABLE이 정말 안전? | SQLite ADD COLUMN은 metadata-only 변경, 빠르고 락 짧음. NOT NULL DEFAULT 허용됨. |
| `transactions.archived` 인덱스? | 추가하지 않음. recall은 이미 `idx_transactions_branch (branch_id, ts)` 사용 중. archived는 high-cardinality가 아니라 (대부분 0) compound index에 추가해도 selectivity 낮음. **트레이드오프 인정.** 큰 abandoned set이 생기면 Phase 4에서 `idx_transactions_archived_branch` 추가 검토. |
| LLM 호출 실패 시? | `summarize()` throw → reflectFacts()가 catch하지 않고 throw → CLI/MCP가 사용자에게 표면. *각 entity별로 try-catch*해서 부분 성공도 가능하게 할 수 있지만, **첫 버전은 fail-fast**. 부분 실패는 사용자가 좁은 `--entity` 재시도. |
| concurrency/race? | reflectFacts는 한 프로세스가 직렬 실행. 두 프로세스가 동시에 reflect를 돌리면? 같은 entity를 두 번 요약할 수 있음. 결과: 두 summary fact가 다른 텍스트로 들어감(content-hash 다름). 큰 문제 아님 — recall이 둘 다 보여줌. **Phase 3 범위 밖** (현실에 user-driven 명시 명령이라 동시 실행 가능성 낮음). |
| schema migration 실패 시 rollback? | tryAddColumn은 fail-soft (이미 컬럼이 있으면 silent no-op). v7 row INSERT OR IGNORE라 idempotent. 수동 rollback 필요한 destructive op 없음. |
| 보안: prompt injection? | LLM input이 facts의 value_blob (사용자 데이터). agent가 악의적 fact를 심어 reflect 시 *모델을 instruct할 수 있음.* 대응: (a) redact-then-prompt가 secret만 막음, prompt injection은 못 막음. (b) summary는 fact로 저장될 뿐 *실행되지 않음*. 위험 표면은 "잘못된 요약을 사용자가 신뢰하는 것"뿐. *Acceptable risk* (audit trail은 fact_provenance로 추적 가능). |

### 8.3 consensus table

| 차원 | CEO 관점 | Eng 관점 | 합의 |
|---|---|---|---|
| Premise 유효 | ✅ | ✅ | **CONFIRMED** |
| 6개월 후회 risk | ⚠️ multi-provider 비용 | ✅ stub만으로 충분 | **CONFIRMED** (opt-in 모델) |
| Schema migration 안전 | N/A | ✅ ADD-only | **CONFIRMED** |
| 동시성 risk | N/A | ⚠️ 두 reflect 프로세스 | **CONFIRMED** (Phase 4로 defer) |
| Prompt injection | N/A | ⚠️ acceptable risk | **CONFIRMED** (zero-trust LLM output) |
| 보존 정책 (D3=A) | ✅ 안전 | ✅ 안전 | **CONFIRMED** |

**no DISAGREE** — 두 관점 합의. *taste decision* 없음, 모두 mechanical.

---

## 9. test plan

### 9.1 신규 테스트 (TDD: write first)

| 파일 | 테스트 | 검증 |
|---|---|---|
| `tests/store.test.ts` | `migrate to v7 is idempotent` | `migrate()` 두 번 호출 후 `pragma_table_info`가 새 컬럼 있고, schema_versions에 7 포함, reflections 테이블 존재. |
| `tests/llm.test.ts` (신규) | `stub provider returns deterministic summary` | `IMPACT_TRACE_REFLECTION_MODEL=stub`로 두 번 호출 → 동일 결과. |
| `tests/llm.test.ts` | `unknown provider throws` | `IMPACT_TRACE_REFLECTION_MODEL=foo:bar` → throw. |
| `tests/reflection.test.ts` (신규) | `reflect skips redacted facts` | secret 패턴이 든 value를 remember → reflect 결과에 [REDACTED] 패턴 없고 source_fact_ids에 redacted fact 미포함. |
| `tests/reflection.test.ts` | `reflect creates summary fact + provenance edges` | n개 fact (n≥2) for entity X → reflect 후 facts 테이블에 attribute='reflection' row 1개 추가, fact_provenance에 n개 edge with kind='summary'. |
| `tests/reflection.test.ts` | `reflect dry-run does not write` | dry-run 후 facts/reflections row 수 변화 없음. |
| `tests/reflection.test.ts` | `reflect single-fact entity is skipped` | entity에 fact 1개만 있으면 reflect 결과 summarized=0. |
| `tests/branch_gc.test.ts` (신규) | `abandon main branch throws` | `abandonBranch({name:'main'})` → throw. |
| `tests/branch_gc.test.ts` | `gc archives only abandoned branch txs` | active branch tx는 archived=0 유지. |
| `tests/branch_gc.test.ts` | `recall hides archived txs` | archived=1된 tx의 fact는 구조 recall에서 안 보임. semantic recall에서도 안 보임. |
| `tests/branch_gc.test.ts` | `trace still walks archived facts` | trace는 archive 무관. |
| `tests/impact-trace.test.ts` | `CLI: branch --abandon + gc-branches` | round-trip 검증. |
| `tests/mcp.test.ts` | `MCP reflect/abandon/gc tools` | `tools/list`에 새 tool 등장 + 호출 시 동작. |

### 9.2 기존 43 tests

영향: `agent_memory.recall` SQL에 `t.archived = 0` 추가 → 모든 기존 test는 archived=0 default라 통과 유지. **regression risk 매우 낮음.**

---

## 10. DX scorecard (autoplan 풍 self-grade)

| 차원 | 점수 | 평가 |
|---|---|---|
| Time to hello world | 9/10 | `impact-trace reflect`만 치면 됨 (env로 provider 골랐으면). |
| API/CLI 일관성 | 9/10 | 기존 `--branch` `--entity` flag 재사용. `--older-than-days`만 신규. |
| Error 메시지 actionable | 8/10 | `ANTHROPIC_API_KEY not set for anthropic provider` 같은 구체 메시지. ollama 미실행 시 fetch error는 transparent. |
| Docs 발견 가능 | 9/10 | `--help`에 reflect/abandon/gc 한 줄씩. 본 design doc에서 사용 패턴 cookbook 업데이트. |
| Upgrade 안전성 | 10/10 | schema v7 ADD-only. v6 DB는 `migrate()` 자동 v7로. 다운그레이드는 안 됨 (consciously). |
| 환경 변수 일관성 | 9/10 | `IMPACT_TRACE_REFLECTION_MODEL` (← `IMPACT_TRACE_EMBEDDING_MODEL`과 같은 컨벤션). |

총점 9/10. 잃은 1점: ollama 미실행 시 error UX를 좀 더 안내적이게 만들 수 있음. follow-up.

---

## 11. failure modes registry

| ID | 시나리오 | 감지 | 완화 |
|---|---|---|---|
| F1 | LLM API 키 없음 | provider별 throw | error 메시지에 env name 명시 |
| F2 | Ollama 서버 down | fetch reject | 메시지: "Ollama unreachable at <url>" |
| F3 | 토큰 한도 초과 | API 4xx | 메시지에 한도 + 좁히기 안내 (`--older-than 14d`) |
| F4 | LLM 응답에 secret echo | redactSecrets()가 catch | 자동, 사용자에게 보이는 행동 변화 없음 |
| F5 | 두 프로세스 동시 reflect | 결과: 같은 entity에 2 summary fact | recall이 둘 다 보여줌, 큰 손해 없음. **Phase 4 검토.** |
| F6 | abandoned branch에 추가 remember 호출 | 동작은 함 (state는 read-only flag). 다음 gc에서 archive됨 | optional: `state='abandoned'`이면 remember에서 warn |
| F7 | gc 후 abandoned branch 복구 시도 | state를 'active'로 되돌리면 transactions.archived는 그대로 | 별도 unarchive 명령 필요. **Phase 4.** |

F1–F4: 본 PR에서 해결.
F5–F7: 명시 defer.

---

## 12. commit 분할

```
Commit 1: schema v7 — ADD-only migration + tryAddColumn helper + reflections table
Commit 2: LLM abstraction (src/llm.ts) + 4 providers + tests
Commit 3: reflectFacts (src/reflection.ts) + CLI/MCP wiring + tests
Commit 4: branch GC (src/branch_gc.ts) + abandon/gc CLI/MCP + recall archived filter + tests
Commit 5: 문서 일괄 업데이트 — progress / cookbook / exploration / README / decisions
```

— 5번째는 문서 통합 commit. handoff에서 4 commit이라 했지만 user의 *"문서들도 완벽하게 만들어줘"* 요청 반영해 분리.

---

## 13. NOT in scope (Phase 4 후보)

- topic 클러스터링 (entity별이 아닌 의미 클러스터링)
- 시간 기반 자동 abandon
- Reembed cleanup (구모델 row drop)
- sqlite-vec virtual table ANN
- archived → unarchived 복구 명령
- 동시 reflect 락
- multi-prompt template (사용자 정의 system prompt)

각 항목은 *현재 명시적으로 안 만든다는 결정*이지 무시가 아니다. Phase 4 진입 시 우선순위로 평가.

---

## 14. dream-state delta

```
[CURRENT — Phase 1+2]
   - 무한 episodic. branch 정리 없음. LLM은 안 씀.

[THIS PR — Phase 3]
   - reflect: 30일+ facts → entity별 summary fact (kind='summary' provenance)
   - branch --abandon + gc-branches: state 분리 + soft-delete
   - LLM 4-provider: stub/ollama/anthropic/openai (env-swap)

[12-MONTH IDEAL — 참고]
   - topic 클러스터링 reflection
   - 자동 abandon 정책
   - sqlite-vec ANN (10M+ facts)
   - reflection-of-reflections (다층 semantic 계층)
   - 협업 다중 agent — branch state로 ownership 표현
```

이번 PR은 ideal의 **하단 1/3** 까지 도달.

---

## 15. 진행 다음 단계

1. ✅ design doc (이 문서)
2. ⏭ schema v7 + migrate()
3. ⏭ LLM abstraction + tests
4. ⏭ reflectFacts + tests
5. ⏭ branch GC + tests
6. ⏭ CLI/MCP wiring
7. ⏭ team-builder 4-agent split-role 리뷰
8. ⏭ 리뷰 피드백 반영
9. ⏭ 문서 5종 일괄 업데이트
10. ⏭ commit + push

— 본 design은 *작성된 시점*에서 결정사항의 단일 진실원본. 구현 중 변경되면 *반드시 본 문서를 함께 업데이트*.
