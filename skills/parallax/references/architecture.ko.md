# Parallax 아키텍처

Parallax가 내부적으로 어떻게 동작하는지 깊이 있게 살펴본다. 시스템을 확장하거나, 예상치 못한 쿼리 결과를 디버깅하거나, invariant 뒤에 있는 근거를 이해해야 할 때 이 문서를 읽어라.

## Core concept: a code-aware fact graph on SQLite

Parallax는 모든 것을 단일 SQLite 데이터베이스(`<repo>/.parallax/impact.db`) 내부의 transaction DAG 위에 content-addressable fact로 저장한다. 동일한 데이터베이스가 다음을 함께 담는다:

- **Code structure** (entities, relations, evidence) — indexer가 생성한다.
- **Agent activity** (facts, transactions, fact_provenance, fact_embeddings) — MCP/CLI 명령이 호출될 때 기록된다.
- **Reflective consolidation** (reflections audit, summary facts) — Phase 3 LLM 패스.
- **Branch lifecycle** (branches.state, transactions.archived) — Phase 3 speculative branch GC.

세 가지 주요 축:

```
ENTITY ←──── FACT ────→ TRANSACTION
              │              │
              ↓              ↓
           PROVENANCE     BRANCH (head pointer)
              │              │
              ↓              ↓
           SOURCE        TX_PARENTS (DAG)
            FACT
```

## Schema versions

| Version | Added | Why |
|---|---|---|
| v1-v3 | repos, files, symbols, edges, evidence, reports | MVP code indexer |
| v4 | facts, transactions, branches, fact_provenance, embeddings, attribute_defs | Phase 1 agent memory |
| v5 | transaction_parents | Multi-parent merge transactions |
| v6 | fact_embeddings (model-agnostic, composite PK) | Phase 2 — model swap freedom |
| v7 | branches.state, transactions.archived, fact_provenance.kind, reflections | Phase 3 — reflection + branch GC |
| v16 | adapter_runs.confidence, adapter_runs.known_gaps_json | Report adapter-level confidence and known gaps |

모든 migration은 **ADD-only**다. `src/store.ts`의 `tryAddColumn` 헬퍼는 `(table, column, definition)` 트리플의 allowlist를 강제하여, 향후 ALTER 호출이 실수로 DDL 표면을 확장하지 못하게 한다.

## Content-addressable fact id

```
fact.id = SHA-256(entity || ' ' || attribute || ' ' || value_blob || ' ' || op)
```

함의: fact의 in-place update란 존재하지 않는다. 값을 갱신한다는 것은 새 transaction 위에 *새로운* fact(값이 다르므로 id도 다르다)를 기록한다는 뜻이다. content-addressable 근거는 `docs/invariants.md` I-2를 참고하라.

실질적인 결과:
- "User prefers React" → "User prefers Vue"는 두 개의 fact를 만들며 둘 다 도달 가능하다. `--current-only` recall 경로는 `(entity, attribute, value_blob)`로 partition하므로 dedup 후 가장 최신 것이 살아남는다.
- 오래된 fact를 retract하면 동일한 content hash 골격을 가지되 op만 뒤집힌 `op='retract'` row가 생성된다.
- fact는 id별로 immutable하므로 `as_of_tx` time-travel이 동작한다.

## Six tables of agent memory

```
attribute_defs   ← typed registry of attributes (name, value_type, is_code_relation, description)
branches         ← named heads with state ('active'|'abandoned'|'merged') and parent_branch_id
transactions     ← commits on a branch DAG (id, parent_tx_id, branch_id, ts, agent, archived)
transaction_parents ← multi-parent edges for merge transactions
facts            ← content-addressable rows (id, entity_id, attribute, value_blob, op, tx_id, redacted)
fact_provenance  ← causal links (fact_id, source_fact_id, kind ∈ {evidence, summary})
fact_embeddings  ← model-agnostic vectors (fact_id, model, vector, dim, created_at) — composite PK
reflections      ← audit of LLM consolidation passes (id, branch_id, model, summary_fact_id, source_fact_count, criteria_json, created_at)
```

## The async-outside-tx invariant

`node:sqlite`(DatabaseSync)는 동기적이다. 동기 `withAgentMemoryDb` 콜백 내부에서 `await`이 실행되면 데이터베이스 핸들이 너무 일찍 닫히고, await된 write가 조용히 실패한다.

패턴(`src/agent_memory.ts:rememberOnRepo`, `src/reflection.ts:reflectFacts`에서):

```typescript
// 1. Compute async work (embeddings, LLM calls) FIRST
const embedding = await computeEmbedding(text);
const summary   = await summarize(prompt);

// 2. Then open one short sync transaction
withAgentMemoryDb(repoRoot, false, (db) => {
  // BEGIN IMMEDIATE / COMMIT inside, sync only
});
```

이것이 decision D-005다. async 작업과 DB write를 섞는 모든 새 함수는 이를 따라야 한다.

## Recall paths

`src/agent_memory.ts:recall()`은 조건들로 이루어진 작은 DSL로부터 단일 SQL 문을 빌드한다. 직교하는 세 가지 모드:

1. **Branch + filter** (default): `WHERE t.branch_id = ? AND t.archived = 0 AND f.entity_id = ? AND f.attribute = ?`
2. **as_of_tx time-travel**: branch filter를 주어진 tx로부터 `transaction_parents`를 따라 걷는 recursive CTE로 대체한다. archived=0은 여전히 적용된다.
3. **--current-only**: 결과를 `ROW_NUMBER() OVER (PARTITION BY entity_id, attribute, value_blob ORDER BY ts DESC)` filter로 감싸 `rn=1 AND op='assert'`만 남긴다.

`recallSemantic()`은 별도 경로다: caller가 query embedding을 미리 계산하고, SQL이 `model = ?`로 필터링된 `fact_embeddings`를 JOIN하여 int8 vector를 가진 row를 반환하면, 함수가 JS에서 int8 dot product로 랭킹한다(vector가 L2-normalized이므로 cosine similarity에 근사).

`trace()`는 세 번째 경로다: 하나의 fact에서 `fact_provenance` edge를 따라 BFS한다. 마찬가지로 `t.archived = 0`을 필터링한다(Phase 3 architect-review 패스에서 추가됨).

## Profile API (Phase 4)

`src/profile.ts:profileEntity()`는 세 개의 readonly 배열을 반환한다:

- `staticFacts`: `is_code_relation = 1` (indexer가 방출한 code structure)
- `dynamicFacts`: `is_code_relation = 0`이고 `attribute != 'reflection'` (agent activity)
- `summaryFacts`: `attribute = 'reflection'` (Phase 3 LLM consolidation 출력)

구현 노트: 단일 SELECT가 `t.ts DESC, f.id ASC` 순으로 정렬된 모든 매칭 fact를 끌어온 다음, 메모리 내 루프가 버킷으로 분류한다. 각 버킷은 독립적으로 `k`(default 50, max 200)로 capping된다.

이것이 decision D-014다: profile은 recall 위에 빌드되며 recall에 병합되지 않는다. recall은 원시 history view로 남고, profile은 집계된 snapshot이다.

## Reflection pipeline (Phase 3)

```
reflectFacts(repoRoot, options)
  ├── collectCandidates: stream facts via iterate(),
  │   group per entity, cap at MAX_FACTS_PER_ENTITY (default 50, env override)
  ├── per-entity:
  │   ├── renderUserPrompt: bullet list + truncation footer
  │   ├── summarize: LLM call (stub | ollama | anthropic | openai), redact in/out
  │   ├── computeEmbedding: vector for the summary
  │   └── push draft (no DB write yet)
  └── persistReflections: per-draft SAVEPOINT around
      remember() + UPDATE provenance kind='summary' + INSERT reflections audit
```

메모리 복잡도: streaming iterate + per-entity cap 덕분에 `O(unique_entities × MAX_FACTS_PER_ENTITY)`다. 이것들이 없다면 1M-fact repo는 multi-GB가 될 것이다.

## Branch GC

Soft-delete만 한다. `gcBranches()`는 `state='abandoned' AND name != 'main'`인 branch를 찾아 각 branch의 transaction에 대해 `transactions.archived = 1`로 설정한다. **Fact는 절대 삭제되지 않는다** — content-addressable이며 다른 (active한) branch가 참조할 수 있기 때문이다. recall로부터 fact를 숨기는 일은 `archived = 0` 필터링이 담당한다.

`abandonBranch('main')`은 throw한다 — protected-branch invariant는 두 곳에 존재한다: 함수 가드와 `gcBranches` SQL의 `WHERE name != 'main'` 절.

## Redact-then-(everything)

`src/security.ts:redactSecrets()`는 세 지점에서 적용된다:

1. **Storage** (`remember`): redaction이 문자열을 바꾸면 fact는 `value_blob='[REDACTED]'`, `redacted=1`로 저장되며 fact_embeddings에는 **어떤 row도** 추가되지 않는다(zero-row policy, D-004).
2. **Embedding** (`reembed`/`computeEmbedding` 호출자): redacted된 fact는 embedding 입력에서 제외된다.
3. **LLM** (`reflection`): redaction은 fetch 전 system prompt + user prompt에 대해, 그리고 LLM raw output을 summary fact로 저장하기 전 그것에 대해 실행된다.

11개 secret family: OpenAI / Stripe / GitHub / Slack / AWS access key / AWS secret / Google API / npm / JWT / Bearer / DB URL / Private key block.

## LLM provider abstraction

`src/llm.ts:summarize()`는 `PARALLAX_REFLECTION_MODEL`의 prefix로 dispatch한다:

| Prefix | Provider | Endpoint default |
|---|---|---|
| `stub` | In-process deterministic summary | (none) |
| `ollama:<model>` | Ollama local HTTP | `http://localhost:11434/api/chat` |
| `anthropic:<model>` | Anthropic Messages | `https://api.anthropic.com/v1/messages` |
| `openai:<model>` | OpenAI Chat Completions | `https://api.openai.com/v1/chat/completions` |

모든 provider는 Node 24+ native `fetch`를 사용한다 — SDK 의존성 없음(D-012). Anthropic/OpenAI base URL은 `https://`임이 assert된다. 세 network provider 모두 fetch를 try/catch로 감싸고 30s `AbortSignal.timeout`을 적용한다(env override `PARALLAX_LLM_TIMEOUT_MS`).

## Decisions cheat-sheet

| ID | Decision | What it constrains |
|---|---|---|
| D-001 | local-first single SQLite | no external services |
| D-002 | content-addressable fact id | facts are immutable per id |
| D-003 | ADD-only migration | tryAddColumn allowlist |
| D-004 | redact-then-embed zero-row | redacted → no embedding row |
| D-005 | async outside SQLite tx | embedding/LLM happens first |
| D-006 | multi-parent transactions | branch merge via transaction_parents |
| D-007 | model-agnostic embeddings | composite PK lets multiple models coexist |
| D-008 | multi-provider LLM via prefix sentinel | stub / ollama / anthropic / openai |
| D-009 | explicit reflect trigger | no daemon |
| D-010 | preserve original facts in reflection | summary fact + kind='summary' edge |
| D-011 | soft-delete branch GC | transactions.archived, never DELETE facts |
| D-012 | no LLM/embedding SDKs | fetch only |
| D-013 | lifecycle from is_code_relation | no new is_static column |
| D-014 | profile is built on top of recall | separate function, not a recall mode |
| D-015 | reflect --repair as separate trigger | not auto-on-reflect |
| D-016 | branch --restore bundles state + tx unarchive | one atomic call |
| D-017 | auto-abandon piggybacks on gc-branches --max-age | opt-in flag, no default |
| D-018 | sqlite-vec ANN with per-model vec0 | lazy create, brute-force fallback |

load-bearing 원칙은 `docs/invariants.md`를 참고하라.

## Where to look first when extending

- New table → `src/store.ts:migrate()` (그리고 tryAddColumn allowlist를 업데이트하라)
- New CLI command → `src/cli.ts` if-chain + `valueFlags` Set + `printHelp`
- New MCP tool → `src/mcp.ts` `server.registerTool` 블록 (readOnlyHint/destructiveHint를 정직하게 annotate하라)
- New aggregation API like profile → SQL을 copy-paste하기보다 `recall`/`recallSemantic`/`trace` 위에 빌드하는 것을 고려하라
- New external integration (LLM, embedding, etc.) → `src/llm.ts`나 `src/embeddings.ts`의 prefix-sentinel 패턴을 따르라
- New behavior that changes invariants → 먼저 근거와 함께 `docs/invariants.md`를 업데이트하라
