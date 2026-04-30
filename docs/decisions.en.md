# Architecture Decisions Log (English)

> **Purpose:** Capture the project's *hard-to-reverse* decisions and the reasoning behind them in one place. Code changes; the *context* of why a decision was made does not survive in the diff. This log preserves it.
> **Format:** One section per decision: *Decision · Context · Rejected alternatives · Consequence/Risk · Related commits*.
> **Korean original:** [decisions.ko.md](decisions.ko.md). The Korean is the working copy; this English version is a parallel translation kept in sync at the end of each Phase.

---

## Index

| ID | Decision | Phase | Date |
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

---

## D-001: local-first single SQLite DB

**Decision:** All data lives in `<repo>/.impact-trace/impact.db`. No graph database, vector store, or external service dependency. A fresh DB is created on first boot; schema migrations run automatically inside `openDatabase()`.

**Context:** Coding agents like Claude Code and Codex need fast impact analysis on the *repository the user is currently working in*. External-service dependencies bring (a) per-environment setup cost, (b) data leaving the user's machine, (c) inability to run offline — all three rejected.

**Rejected alternatives:**
- Postgres + a separate graph DB (Neo4j) — large setup cost, assumes multi-user.
- Local KV store (LMDB / RocksDB) — relational queries need SQL.
- Hosted vector services like pgvector — external dependency.

**Consequence/Risk:** SQLite limits show up at the millions-of-rows level (slower queries, no built-in ANN index). Mitigation: schema is model-swappable; sqlite-vec virtual tables stay *optional* (Phase 4 candidate).

**Related commit:** `ffc4bf4` (Phase 1 init)

---

## D-002: content-addressable fact id (SHA-256)

**Decision:** `fact.id = SHA-256(entity || attribute || value_blob || op)`. The same `(entity, attribute, value, op)` tuple always hashes to the same id, so dedup is automatic.

**Context:** Agents may `remember` the same observation many times. Unique-by-content makes dedup free.

**Rejected alternatives:**
- Random UUID — caller has to dedupe.
- Sequential PK — collides under distributed / branched merges.

**Consequence/Risk:** Minor changes to `value_blob` (whitespace, JSON key order) produce different facts. Mitigation: `JSON.stringify` is the canonicalisation seam (V8 doesn't formally guarantee key order but is stable in practice). Formal canonicalisation is a follow-up.

**Related commit:** `ffc4bf4`

---

## D-003: ADD-only schema migration

**Decision:** Schema changes are *additive only* — new columns or new tables. DROP, ALTER COLUMN TYPE, and other destructive operations are forbidden. Tooling: `CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE INTO schema_versions`, and a `tryAddColumn` helper that probes `pragma_table_info` before issuing the ALTER.

**Context:** A user must be able to upgrade an existing v6 DB to v7 without losing data and without thinking. The migration must always be safe to re-run.

**Rejected alternatives:**
- An explicit `impact-trace migrate` command — pushes the burden onto the user.
- Data-rewrite migration scripts — destructive operations creep in.

**Consequence/Risk:** A poorly-designed column lives forever (no DROP). Mitigation: be careful when adding columns, especially typed ones. A v8+ cleanup command is a separate follow-up.

**Related commits:** v4 = `ffc4bf4`, v5 = `0289cc7`, v6 = `cb50bc3`, v7 = Phase 3.

---

## D-004: redact-then-embed zero-row policy

**Decision:** Facts whose `value_blob` matches a secret regex are stored with `value_blob='[REDACTED]'`, the `redacted=1` flag set, and **no row** in `fact_embeddings` (zero-row, not `[REDACTED]` substitution). In Phase 3 the same policy was extended to LLM input/output for reflective consolidation.

**Context:** Phase 1 security model. Embedding redacted text would still leak the *semantic position* of the secret in vector space. Refusing to write the row is the simplest backstop. In Phase 3 it generalises: LLM prompts could echo input, so redaction runs on system prompt, user prompt, and raw output before storage.

**Rejected alternatives:**
- Embed `[REDACTED]` literal text — leakage via vector neighbourhood.
- Separate `secret_facts` table — two SELECT paths and divergent invariants.

**Consequence/Risk:** Redacted facts never appear in semantic recall. *Intentional trade-off:* privacy first.

**Related commits:** `d0c5cce` (sqlite-vec + gate), `ffc4bf4` (`security.ts redactSecrets`), Phase 3 (`src/llm.ts` redact-then-prompt).

---

## D-005: async outside SQLite transaction

**Decision:** Async work — embedding inference, LLM calls — must complete *outside* the SQLite transaction. After the async settles, a short sync `withAgentMemoryDb` callback opens a `BEGIN` / `COMMIT` and writes.

**Context:** `node:sqlite` (`DatabaseSync`) is synchronous. If an `await` runs inside a sync callback, the database handle closes too early and the awaited write fails silently. We paid for this lesson once and froze it as an invariant.

**Rejected alternatives:**
- An async SQLite library (better-sqlite3 is sync; libsql is async) — more dependencies, change of binding.
- Cramming a Promise into the sync section — anti-pattern.

**Consequence/Risk:** Each embedding call adds 50–150 ms latency that the caller must `await`. Mitigation: async wrappers (`rememberOnRepo`, `recallOnRepo`, `reembedFacts`, `reflectFacts`) hide the pattern.

**Related commits:** `ffc4bf4` (pattern start), `43418ec` (Phase 2 application), Phase 3 `reflection.ts`.

---

## D-006: multi-parent transactions via transaction_parents

**Decision:** `transactions.parent_tx_id` keeps a *single primary parent* (backward compat). Additional parents (e.g. the source-branch head in a merge transaction) live in a separate `transaction_parents(tx_id, parent_tx_id)` table. Recall walks both with a recursive CTE.

**Context:** Phase 2 branch merge. A merge tx has two branch heads as parents. Storing an array in a column violates SQLite's primitive-type discipline.

**Rejected alternatives:**
- `transactions.parent_tx_ids JSON` — a JSON CTE walk is possible but harder to schema-track.
- Copy facts on merge — violates content-addressability.

**Consequence/Risk:** The transaction graph is a DAG (cycle-freedom is the caller's responsibility). Recall cost scales with traversal depth.

**Related commit:** `0289cc7`

---

## D-007: model-agnostic fact_embeddings composite PK

**Decision:** `fact_embeddings(fact_id, model, vector, dim, created_at)` with PK `(fact_id, model)`. A single fact can carry vectors from multiple models concurrently, enabling incremental reembed during a model swap.

**Context:** Phase 1 v4 had `embeddings(fact_id PK, dim64_binary, dim768_int8)` — a single retrieval strategy and a single model baked in. Real users want to switch models (Korean vs English vs code vs Kotlin).

**Rejected alternatives:**
- One table per model — schema explosion.
- Single model + full reembed — downtime.

**Consequence/Risk:** Vector storage scales linearly with model count. Intentional — the cleanup point is the user's choice.

**Related commits:** `cb50bc3` (schema v6), `a9c8a92` (reembed CLI).

---

## D-008: multi-provider LLM via prefix sentinel

**Decision:** Phase 3 reflection LLM is a 4-provider abstraction. A single env variable `IMPACT_TRACE_REFLECTION_MODEL` carries both provider and model id:
- `stub` → in-process deterministic output (CI / tests)
- `ollama:gemma2:2b` → Ollama HTTP API
- `anthropic:claude-haiku-4-5` → Anthropic Messages API
- `openai:gpt-4o-mini` → OpenAI Chat Completions API

**Context:** Different users prefer different environments. Local-first identity demands Ollama support, but refusing API users in environments without Ollama is also a dead end.

**Rejected alternatives:**
- Ollama-only — locks out API users.
- Anthropic-only — privacy identity violation.
- Single integration layer (an `ai` SDK) — dependency bloat.

**Consequence/Risk:** Four providers × moving API surfaces = maintenance cost. Mitigation: `fetch`-only, zero new dependencies, ~30 lines of code per provider.

**Related commit:** Phase 3 `src/llm.ts`.

---

## D-009: explicit `reflect` trigger (no daemon)

**Decision:** Reflective consolidation runs only when the user invokes `impact-trace reflect`. Cron-style automation and count-based hooks are rejected.

**Context:** This project is *daemon-less* by identity. Nothing runs in the background. Every action requires explicit invocation. LLM calls cost time and money — user consent is required.

**Rejected alternatives:**
- (1) Time-based cron — needs an external cron.
- (2) Auto-trigger after N facts — unpredictable latency.

**Consequence/Risk:** A user who never calls reflect accumulates episodic memory. Mitigation: cookbook recommends a monthly cadence.

**Related commit:** Phase 3 (CLI `reflect`).

---

## D-010: preserve original facts when summarizing

**Decision:** Reflection only *adds* a summary fact. Originals are preserved. The link is a `fact_provenance` edge with `kind='summary'`. No retract, no archive of source facts.

**Context:** Other systems (Letta MemGPT) often retract or archive originals. We prioritise *audit trail*: the answer to "why did I decide X" must always be reachable.

**Rejected alternatives:**
- (B) Retract source facts — historical search becomes impossible.
- (C) Move source facts to an `archive` table — two SELECT paths.

**Consequence/Risk:** The `facts` table grows faster. Mitigation: storage cost is trivial against the value of an intact audit trail.

**Related commit:** Phase 3 `src/reflection.ts`.

---

## D-011: soft-delete branch GC via transactions.archived

**Decision:** Branch GC never deletes facts. Abandoned branches get their *transactions* flagged with `archived=1`. Recall and recallSemantic auto-filter on `t.archived = 0`.

**Context:** Facts are content-addressable. A fact created on an abandoned branch may also be referenced from an active branch (same `entity, attribute, value`). Deleting the fact would corrupt the active branch. Archiving the transaction is safe.

**Rejected alternatives:**
- Hard delete — irreversible.
- Separate `archived_facts` table — complexity.

**Consequence/Risk:** Archived transactions accumulate. A v8+ cleanup option is a follow-up. `trace()` was also updated to filter archived (caught in the architect-review pass) so audit visibility matches recall.

**Related commits:** Phase 3 `src/branch_gc.ts` + `agent_memory.ts` recall filter.

---

## D-012: no LLM or embedding SDKs (fetch only)

**Decision:** `@anthropic-ai/sdk`, `openai`, `ollama-js`, and similar vendor SDKs are rejected. Provider clients are written directly against `fetch` (Node 24+).

**Context:** SDK value-add (retry, streaming, types) is over-kill for a single-call summarise. Adding deps violates the project's minimalism.

**Rejected alternatives:**
- `ai-sdk` (Vercel) — integration layer but heavy.
- One SDK per provider — four new deps.

**Consequence/Risk:** When an upstream API changes shape we patch directly. Mitigation: each provider function is ~30 lines, so the patch surface is small.

**Related commit:** Phase 3 `src/llm.ts`.

---

## D-013: lifecycle binary derives from `is_code_relation`; no new column

**Decision:** Do not add a new `attribute_defs.is_static` / `lifecycle` column. The existing `is_code_relation` already maps 1:1 to the static / dynamic distinction. Profile API and CLI surface the binary as `Lifecycle = 'static' | 'dynamic'` derived at query time.

**Context:** `supermemoryai/supermemory` uses an `isStatic` flag to determine memory lifetime. Our analysis (`docs/supermemory-adoption.ko.md`) found the same information already lived at the *attribute* level: code-extraction attributes (imports / calls / affects / depends_on) are durable; agent-decision attributes (observed / verified / concern / reflection / ...) are dynamic.

**Rejected alternatives:**
- Add a new `is_static` column — data duplication.
- Rename `is_code_relation` to `lifecycle TEXT` — non-destructive but breaks backward compatibility.

**Consequence/Risk:** Profile API derives the lifecycle classification at query time (LEFT JOIN attribute_defs). No new column. The single entry point is the `factLifecycle(db, attribute)` helper.

**Related commit:** Phase 4 supermemory-best-practices branch (`src/agent_memory.ts:factLifecycle`, `src/types.ts:Lifecycle`).

---

## D-014: Profile API is built on top of recall, not merged into it

**Decision:** `profileEntity()` is its own exported function. `recall()` is *not* modified.

**Context:** supermemory's `client.profile()` merges recall and profile into one call. We split them: `recall()` is the *raw history view*; `profileEntity()` is the *aggregated snapshot* per entity, partitioned into static / dynamic / summary buckets.

**Rejected alternatives:**
- `recall({ profile: true })` option — one function with two modes bloats the interface.
- Make `recall` always return profile shape — backward compatibility break.
- Have profile call recall internally — extra round trip; we prefer one SELECT + in-memory bucketization for efficiency.

**Consequence/Risk:** Profile owns its SQL but applies the *same invariants* as recall — `t.archived = 0` filter, branch scoping, redacted facts surfaced as `[REDACTED]`. When a new invariant lands on recall, profile must follow (codebase search must find both sites).

**Related commit:** Phase 4 supermemory-best-practices branch (`src/profile.ts`).

---

## When adding a new decision

1. Assign the next ID (`D-NNN`).
2. Add one line to the index table.
3. Add a section: Decision → Context → Rejected alternatives → Consequence/Risk → Related commit.
4. Include `decisions: D-NNN <slug>` in the commit message's first line so the rationale is greppable.

When *superseding* an existing decision:
- Never delete the old section.
- Add a new ID with `Supersedes: D-NNN` at the top.
- In the index table, append `(superseded by D-MMM)` next to the old date.
