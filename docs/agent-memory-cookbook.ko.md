# Agent Memory Cookbook

> **상태:** Phase 1 + 1.5 완성, Phase 2 scaffolding 준비 완료
> **대상:** Impact Trace의 agent memory 레이어를 *지금 바로* 써보고 싶은 사용자
> **선수 지식:** [README.md](../README.md), 선택적으로 [docs/agent-db-exploration.ko.md](agent-db-exploration.ko.md)

이 문서는 *실전 흐름*만 모았습니다. 설계 배경은 exploration 문서, 스키마는 [indexing-model.ko.md](indexing-model.ko.md), 큰 그림은 README를 참고하세요.

---

## 0. 한 페이지 정리

Impact Trace의 agent memory 레이어는 **로컬 SQLite 한 파일에 (a) 코드 관계와 (b) agent의 사고를 함께 저장하는 시스템**입니다. 4개의 1급 동작:

| 동작 | CLI | MCP | 핵심 의미 |
|---|---|---|---|
| 저장 | `impact-trace remember` | `impact_trace_remember` | content-addressable fact 1개 영속화 |
| 조회 | `impact-trace recall` | `impact_trace_recall` | branch + entity + attribute 필터 |
| 분기 | `impact-trace branch` | `impact_trace_branch` | 데이터 복사 없이 head 포인터만 분기 |
| 추적 | `impact-trace trace` | `impact_trace_trace` | fact_provenance를 따라 인과 사슬 반환 |

모든 출력은 JSON. 모든 데이터는 `.impact-trace/impact.db` 한 파일에. 외부 네트워크 의존 없음.

---

## 1. 5분 시작 가이드

```bash
# 1. 워크스페이스 초기화 (한 번만)
cd /path/to/your/repo
impact-trace init
# → .impact-trace/{config.json, impact.db}

# 2. (선택) 코드 인덱싱 — 안 해도 agent memory는 작동하지만,
#    인덱싱하면 코드 관계가 자동으로 facts에 들어가서 trace가 강력해짐
impact-trace index

# 3. 결정 하나 저장
impact-trace remember \
  --entity file:src/auth/session.ts \
  --attribute decided_to \
  --value '"rotate JWT secret quarterly"'
# → {"factId":"<sha256-hex>","txId":"<sha256-hex>"}

# 4. 조회
impact-trace recall --entity file:src/auth/session.ts
# → {"facts":[{"id":"...","entityId":"file:src/auth/session.ts",...}]}

# 5. 인덱서가 만든 코드 관계도 같이 옴
impact-trace recall --attribute imports --k 5
# → {"facts":[{"entityId":"file:src/...","attribute":"imports","value":"file:src/..."}, ...]}
```

---

## 2. CLI 흐름 — 사용자가 직접

### 2.1 결정 저장하기

```bash
# 단순 문자열
impact-trace remember --entity file:src/auth.ts --attribute observed --value '"compiles cleanly"'

# JSON 객체
impact-trace remember \
  --entity file:src/payment.ts \
  --attribute risk_assessment \
  --value '{"level":"high","reason":"PII handling","reviewer":"yousang"}'

# 숫자
impact-trace remember --entity file:src/cache.ts --attribute hit_rate --value 0.93

# 다른 branch에 저장
impact-trace remember \
  --entity file:src/auth.ts \
  --attribute observed \
  --value '"compiles in experimental branch"' \
  --branch experiment-1
```

### 2.2 인과 사슬 만들기

```bash
# 1) source fact
A_RESPONSE=$(impact-trace remember \
  --entity file:src/auth.ts \
  --attribute observed \
  --value '"validateSession returns boolean"')
A_ID=$(echo "$A_RESPONSE" | jq -r .factId)

# 2) derived fact — A가 evidence
impact-trace remember \
  --entity file:src/routes/private.ts \
  --attribute requires \
  --value '"validateSession from auth.ts"' \
  --evidence-fact-ids "$A_ID"

# 3) trace로 연결 확인
impact-trace trace --fact-id <derived-fact-id>
# → {"chain":[{derived fact}, {A fact (source)}]}
```

### 2.3 plan 시뮬레이션

```bash
# 메인에서 분기
impact-trace branch --name try-rate-limiter --from main

# 실험적 결정들을 새 branch에 저장
impact-trace remember \
  --entity file:src/api/handler.ts \
  --attribute will_add \
  --value '"rate limit middleware"' \
  --branch try-rate-limiter

# main에는 영향 없음
impact-trace recall --branch main --entity file:src/api/handler.ts
# → {"facts":[]} (실험은 별 branch에 격리)

# 실험 branch만 조회
impact-trace recall --branch try-rate-limiter --entity file:src/api/handler.ts
# → 실험 fact만 보임
```

### 2.4.1 retract — "이 사실은 더 이상 맞지 않음"

```bash
# 기존 결정을 retract (op=retract fact로 영속)
impact-trace retract \
  --entity file:src/auth.ts \
  --attribute observed \
  --value '"compiles cleanly"'

# 또는 remember 명령으로 같은 효과
impact-trace remember \
  --entity file:src/auth.ts \
  --attribute observed \
  --value '"compiles cleanly"' \
  --op retract

# recall로 둘 다 보임 (Phase 1: 자동 dedup 없음, op 필드로 caller가 구분)
impact-trace recall --entity file:src/auth.ts --attribute observed
# → {"facts":[{...,"op":"retract"},{...,"op":"assert"}]}
```

**중요:** retract된 fact는 *embedding되지 않음* — 의도적 정책. Semantic recall이
"retract됨" 의미를 검색해서 잘못 매칭되는 것을 방지.

### 2.4.2 as_of_tx — 과거 시점 상태로 시간여행

```bash
# 시점 1
TX1=$(impact-trace remember --entity file:src/x.ts --attribute role \
  --value '"primary auth"' | jq -r .txId)

# 시점 2 (이후 변경)
impact-trace remember --entity file:src/x.ts --attribute role \
  --value '"deprecated"'

# TX1 시점의 상태로만 recall
impact-trace recall --entity file:src/x.ts --as-of-tx "$TX1"
# → {"facts":[{...,"value":"primary auth"}]} ← 첫 fact만
# transactions DAG의 ancestor만 포함 (parent_tx_id 체인)
```

### 2.5 trace로 코드까지 따라가기 (인덱서 facts 활용)

```bash
# import 관계 fact 하나 잡기
IMPORT_FACT=$(impact-trace recall --attribute imports --k 1 | jq -r '.facts[0].id')

# trace로 따라가면 evidence_snippet fact까지 옴
impact-trace trace --fact-id "$IMPORT_FACT"
# → {"chain":[
#     {imports fact: source -> target},
#     {evidence_snippet fact: 코드 한 조각, redaction 적용된}
#   ]}
```

---

## 3. MCP 흐름 — Claude Code / Codex가 직접

`.mcp.json`에 등록 (project scope):

```json
{
  "mcpServers": {
    "impact-trace": {
      "type": "stdio",
      "command": "impact-trace",
      "args": ["mcp", "serve"],
      "env": {}
    }
  }
}
```

이후 agent가 다음 툴을 사용 가능:

| MCP tool name | 어노테이션 |
|---|---|
| `impact_trace_analyze_diff` | read-only, idempotent |
| `impact_trace_remember` | write, idempotent (content-hash) |
| `impact_trace_recall` | read-only |
| `impact_trace_branch` | write, NOT idempotent (이름 충돌 시 에러) |
| `impact_trace_trace` | read-only |

agent에게 줄 수 있는 *지시문* 예시:

> "이 PR을 검토하기 전에, `impact_trace_remember`로 검토 가설을 먼저 저장해.
>  검토 후 결과를 `evidence_fact_ids` 인자로 가설에 연결해서 또 한 번 remember 해.
>  그러면 나중에 이 결정의 근거 사슬을 trace로 1쿼리에 볼 수 있어."

---

## 4. 통합 시나리오

### 4.1 코드 PR 검토 + 결정 영속화

```bash
# 1. PR 변경 분석
impact-trace analyze --base main --head HEAD --json > report.json
REPORT_ID=$(jq -r '.id' report.json)

# 2. 영향 받는 파일별 검토 가설 저장
for file in $(jq -r '.affectedFiles[].path' report.json); do
  impact-trace remember \
    --entity "file:$file" \
    --attribute review_hypothesis \
    --value "\"need to verify $file under load\""
done

# 3. 검토 후 결과
impact-trace remember \
  --entity file:src/api/handler.ts \
  --attribute review_outcome \
  --value '{"verdict":"approved","caveat":"add rate limit before launch"}'

# 4. 다음 PR 때 같은 entity의 과거 결정 조회
impact-trace recall --entity file:src/api/handler.ts --attribute review_outcome
```

### 4.2 agent의 다단계 사고 추적

```bash
# 1차 분석: import 관계 파악 (인덱서가 자동으로 facts 작성)
impact-trace index

# 2차 분석: agent가 이 코드의 *역할*을 추론
agent_inference_id=$(impact-trace remember \
  --entity file:src/auth/session.ts \
  --attribute role \
  --value '"primary auth gate"' | jq -r .factId)

# 3차 분석: 보안 우려 — 위 inference가 evidence
impact-trace remember \
  --entity file:src/auth/session.ts \
  --attribute concern \
  --value '{"type":"security","detail":"single point of failure"}' \
  --evidence-fact-ids "$agent_inference_id"

# trace로 보안 우려 → role inference → ... 사슬 확인
impact-trace trace --fact-id <concern-fact-id>
```

---

## 5. 보안 모델 — redact-then-embed 게이트

`remember()`의 `value`가 secret 패턴(OpenAI key, GitHub token, AWS key, private key 등)을 포함하면:

1. **저장 시:** `value_blob = "[REDACTED]"`, `redacted = 1`
2. **임베딩 시:** **0 row** — 임베딩이 secret을 reconstruct할 수 있으므로 *zero-row 정책*
3. **recall 시:** `value: "[REDACTED]"`로 마스킹되어 반환

```bash
# 의도하지 않게 secret 포함된 fact 저장
impact-trace remember \
  --entity file:src/config.ts \
  --attribute observed \
  --value '"loaded sk-test-secret-1234567890 from env"'

# value는 이미 redacted
impact-trace recall --entity file:src/config.ts
# → {"facts":[{...,"value":"[REDACTED]"}]}

# embeddings 테이블엔 row 없음 (검증)
sqlite3 .impact-trace/impact.db \
  'SELECT count(*) FROM embeddings WHERE fact_id = "<the-redacted-fact-id>"'
# → 0
```

---

## 6. 자주 만나는 패턴

| 원하는 것 | 명령 |
|---|---|
| 한 entity의 모든 결정 보기 | `impact-trace recall --entity file:src/X.ts` |
| 한 attribute의 전체 그래프 | `impact-trace recall --attribute imports --k 100` |
| 가장 최근 결정만 | `impact-trace recall --k 5` (recall은 ts DESC 정렬) |
| 새 branch 만들기 | `impact-trace branch --name BR --from main` |
| 결정의 근거 사슬 따라가기 | `impact-trace trace --fact-id ID --depth 10` |
| 결정을 retract | `impact-trace retract --entity ... --attribute ... --value ...` |
| 과거 시점 상태 보기 | `impact-trace recall --as-of-tx <tx-id>` |
| MCP 통해 agent가 같은 동작 | tool call에 `impact_trace_*` 사용 |

---

## 7. Phase 2 미리보기 — 곧 추가될 것들

코드는 *scaffolding이 이미 들어가 있고*, 실제 모델/기능 통합만 남은 상태:

- **실제 임베딩 모델 통합:** 현재 `src/embeddings.ts`의 stub은 SHA-256 chain 기반 deterministic pseudo-vector. 진짜 semantic 의미는 없음. 같은 함수 시그니처로 Ollama / OpenAI / Cohere / Voyage 모델 swap-in 예정.
- **Semantic recall:** `recall(query: "비슷한 결정 찾아줘", k: 10)` — Matryoshka 64-dim binary 1차 + 768-int8 2차 검색.
- **Branch merge:** 두 branch의 facts를 합쳐 새 branch 생성.
- **Current-state SQL:** retract을 자동으로 dedup해서 "지금 유효한 facts만" 반환하는 query mode (현재는 caller가 op 필드로 직접 구분).

---

## 8. 디버깅 팁

| 증상 | 원인 / 해결 |
|---|---|
| `repo is not indexed` | `impact-trace init` 먼저. agent memory 동작은 init만으로 충분 |
| `branch not found: X` | `impact-trace branch --name X` 먼저 또는 main 사용 |
| `fact not found` (trace) | factId가 정확한지 — recall로 확인 |
| `branch already exists` (branch 명령) | 다른 이름 사용 (현재 delete 미지원) |
| recall에 expected fact가 안 보임 | branch가 다를 가능성 — `--branch` 명시 |
| trace 결과가 시작 fact 1개만 | 그 fact에 evidence_fact_ids 또는 indexer가 만든 evidence_snippet 연결 안 됨 |

---

## 부록 A: 데이터 모델 한눈에

```
branches (id, name, head_tx_id, parent_branch_id, created_at)
   │
   └── transactions (id, parent_tx_id, branch_id, ts, agent, index_run_id)
          │
          └── facts (id, entity_id, attribute, value_blob, op, tx_id, redacted)
                 │
                 ├── embeddings (fact_id, dim64_binary, dim768_int8)
                 │      ↑ 비-redacted facts만
                 └── fact_provenance (id, fact_id, source_fact_id)
                        ↑ 인과 사슬

attribute_defs (name, value_type, is_code_relation, description)
   ↑ runtime 자동 등록 — 첫 사용 시 생성
```

자세한 SQL DDL: [docs/agent-db-exploration.ko.md §6](agent-db-exploration.ko.md).
