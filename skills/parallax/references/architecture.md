# Parallax Architecture

**English** · [한국어](architecture.ko.md) · [中文](architecture.zh.md)

Deep dive into how Parallax works under the hood. Read this when you need to extend the system, debug an unexpected query result, or understand the rationale behind an invariant.

## Core concept: a code-aware fact graph on SQLite

Parallax stores everything as content-addressable facts on a transaction DAG inside a single SQLite database (`<repo>/.parallax/impact.db`). The same database holds:

- **Code structure** (entities, relations, evidence) — produced by the indexer.
- **Agent activity** (facts, transactions, fact_provenance, fact_embeddings) — written when MCP/CLI commands are invoked.
- **Reflective consolidation** (reflections audit, summary facts) — Phase 3 LLM passes.
- **Branch lifecycle** (branches.state, transactions.archived) — Phase 3 speculative branch GC.

Three primary axes:

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
| v8-v9 | (version markers applied with the v7 reflection/branch-GC migration; no standalone DDL) | Phase 3/4 GC sequencing |
| v10 | context_tool_runs, context_resource_accesses | Local MCP context access telemetry (append-only) |
| v11-v14 | search_entities_fts, search_relation_evidence_fts, search_facts_fts + sync triggers | Persistent FTS5 search projections for read-only context search |
| v15 | context_packs | Persisted MCP context packs (content-addressed reuse) |
| v16 | adapter_runs.confidence, adapter_runs.known_gaps_json | Report adapter-level confidence and known gaps |

All migrations are **ADD-only**. The `tryAddColumn` helper in `src/store.ts` enforces an allowlist of `(table, column, definition)` triples so future ALTER calls cannot expand DDL surface accidentally.

## Content-addressable fact id

```
fact.id = SHA-256(entity || ' ' || attribute || ' ' || value_blob || ' ' || op)
```

Implication: there is no in-place update of a fact. Updating a value means writing a *new* fact (whose id differs because the value differs) on a new transaction. See `docs/invariants.md` I-2 for the content-addressable rationale.

Practical consequences:
- "User prefers React" → "User prefers Vue" produces two facts, both reachable. The `--current-only` recall path partitions by `(entity, attribute, value_blob)` so the latest one survives the dedup.
- Retracting an old fact creates an `op='retract'` row with the same content hash skeleton but op flipped.
- `as_of_tx` time-travel works because facts are immutable per id.

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

`node:sqlite` (DatabaseSync) is synchronous. If an `await` runs inside the sync `withAgentMemoryDb` callback, the database handle closes too early and the awaited write fails silently.

Pattern (from `src/agent_memory.ts:rememberOnRepo`, `src/reflection.ts:reflectFacts`):

```typescript
// 1. Compute async work (embeddings, LLM calls) FIRST
const embedding = await computeEmbedding(text);
const summary   = await summarize(prompt);

// 2. Then open one short sync transaction
withAgentMemoryDb(repoRoot, false, (db) => {
  // BEGIN IMMEDIATE / COMMIT inside, sync only
});
```

This is decision D-005. Every new function that mixes async work with DB writes must follow it.

## Recall paths

`src/agent_memory.ts:recall()` builds a single SQL statement from a small DSL of conditions. Three orthogonal modes:

1. **Branch + filter** (default): `WHERE t.branch_id = ? AND t.archived = 0 AND f.entity_id = ? AND f.attribute = ?`
2. **as_of_tx time-travel**: replaces branch filter with a recursive CTE walking `transaction_parents` from the given tx; archived=0 still applies.
3. **--current-only**: wraps the result in a `ROW_NUMBER() OVER (PARTITION BY entity_id, attribute, value_blob ORDER BY ts DESC)` filter that keeps `rn=1 AND op='assert'`.

`recallSemantic()` is a separate path: caller pre-computes the query embedding, the SQL JOINs `fact_embeddings` filtered by `model = ?`, returns rows with int8 vectors, and the function ranks them in JS using int8 dot product (≈cosine similarity since vectors are L2-normalized).

`trace()` is a third path: BFS from one fact through `fact_provenance` edges. Also filters `t.archived = 0` (added in Phase 3 architect-review pass).

## Profile API (Phase 4)

`src/profile.ts:profileEntity()` returns three readonly arrays:

- `staticFacts`: `is_code_relation = 1` (indexer-emitted code structure)
- `dynamicFacts`: `is_code_relation = 0` and `attribute != 'reflection'` (agent activity)
- `summaryFacts`: `attribute = 'reflection'` (Phase 3 LLM consolidation outputs)

Implementation note: a single SELECT pulls all matching facts ordered by `t.ts DESC, f.id ASC`, then the in-memory loop bucketizes. Each bucket is independently capped at `k` (default 50, max 200).

This is decision D-014: profile is built on top of recall, not merged into it. Recall remains a raw history view; profile is an aggregated snapshot.

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

Memory complexity: `O(unique_entities × MAX_FACTS_PER_ENTITY)` thanks to the streaming iterate + per-entity cap. Without those, 1M-fact repos would multi-GB.

## Branch GC

Soft-delete only. `gcBranches()` finds branches where `state='abandoned' AND name != 'main'` and sets `transactions.archived = 1` for each branch's transactions. **Facts are never deleted** because they are content-addressable and may be referenced by other (active) branches. Hiding facts from recall is what `archived = 0` filtering accomplishes.

`abandonBranch('main')` throws — the protected-branch invariant lives in two places: the function guard and the `gcBranches` SQL `WHERE name != 'main'` clause.

## Redact-then-(everything)

`src/security.ts:redactSecrets()` is applied at three points:

1. **Storage** (`remember`): if redaction changes the string, fact is stored with `value_blob='[REDACTED]'`, `redacted=1`, and **no row** is added to fact_embeddings (zero-row policy, D-004).
2. **Embedding** (`reembed`/`computeEmbedding` callers): redacted facts are excluded from embedding input.
3. **LLM** (`reflection`): redaction runs on system prompt + user prompt before fetch, and on the LLM raw output before storing it as a summary fact.

12 secret families: OpenAI / Stripe / GitHub / Slack / AWS access key / AWS secret / Google API / npm / JWT / Bearer / DB URL / Private key block.

## LLM provider abstraction

`src/llm.ts:summarize()` dispatches on the prefix of `PARALLAX_REFLECTION_MODEL`:

| Prefix | Provider | Endpoint default |
|---|---|---|
| `stub` | In-process deterministic summary | (none) |
| `ollama:<model>` | Ollama local HTTP | `http://localhost:11434/api/chat` |
| `anthropic:<model>` | Anthropic Messages | `https://api.anthropic.com/v1/messages` |
| `openai:<model>` | OpenAI Chat Completions | `https://api.openai.com/v1/chat/completions` |

All providers use Node 24+ native `fetch` — no SDK dependencies (D-012). Anthropic/OpenAI base URLs are asserted to be `https://`. All three network providers wrap fetch in try/catch and apply a 30s `AbortSignal.timeout` (env override `PARALLAX_LLM_TIMEOUT_MS`).

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

See `docs/invariants.md` for the load-bearing principles.

## Where to look first when extending

- New table → `src/store.ts:migrate()` (and update tryAddColumn allowlists)
- New CLI command → `src/cli.ts` if-chain + `valueFlags` Set + `printHelp`
- New MCP tool → `src/mcp.ts` `server.registerTool` block (annotate readOnlyHint/destructiveHint honestly)
- New aggregation API like profile → consider building on top of `recall`/`recallSemantic`/`trace` rather than copy-pasting their SQL
- New external integration (LLM, embedding, etc.) → mirror the prefix-sentinel pattern in `src/llm.ts` or `src/embeddings.ts`
- New behavior that changes invariants → update `docs/invariants.md` first with a rationale
