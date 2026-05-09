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
| [D-015](#d-015-reflect---repair-as-a-separate-trigger) | `reflect --repair` as a separate trigger | P4 | 2026-04-30 |
| [D-016](#d-016-branch---restore-restores-state-and-un-archives-transactions) | `branch --restore` restores state and un-archives transactions | P4 | 2026-04-30 |
| [D-017](#d-017-time-based-auto-abandon-piggybacks-on-gc-branches---max-age) | time-based auto-abandon piggybacks on `gc-branches --max-age` | P4 | 2026-05-01 |
| [D-018](#d-018-sqlite-vec-ann-with-per-model-vec0-tables-lazy-create-and-brute-force-fallback) | sqlite-vec ANN with per-model vec0 tables, lazy create, brute-force fallback | P4 | 2026-05-01 |

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

## D-015: `reflect --repair` as a separate trigger

**Decision:** A repair sweep that reconciles orphan summary facts (Phase 3 SAVEPOINT atomicity gap left a reflection fact whose `kind='summary'` provenance edges or `reflections` audit row are missing) ships as a *separate* command — `impact-trace reflect --repair` (CLI) + `impact_trace_repair_reflections` (MCP). It is **not** auto-run on every `reflect` invocation.

**Context:** The Phase 3 architect review found a gap — `remember()` commits with its own BEGIN/COMMIT, then the outer SAVEPOINT covers `fact_provenance` UPDATE + `reflections` INSERT. A crash between those two commits leaves a summary fact with no audit row and possibly partial provenance — an *orphan*. Recovery path required.

**Rejected alternatives:**
- (b) auto-repair at the start of every `reflect` call — adds unconditional cost; tangles repair semantics with normal reflect output.
- (c) separate `repair-reflections` command — fragments the CLI surface; users have to remember a second verb.

**Consequence/Risk:** If the user never calls `--repair`, orphans accumulate. Mitigation: cookbook recommends monthly cadence (or right after `reflect`). Concurrent repair processes — SAVEPOINT only covers row-level contention; the first version uses `INSERT OR IGNORE` audit rows so two concurrent repairs are harmless.

**Related commit:** Phase 4 P2 `feat/phase4-p2-p3-repair-restore` branch.

---

## D-016: `branch --restore` restores state and un-archives transactions

**Decision:** Restoring an abandoned branch *simultaneously* sets `branches.state = 'active'` AND clears `transactions.archived = 0` for that branch's transactions, in one atomic call. Single command satisfies the user mental model "I restored it, so it's visible again."

**Context:** D-011 soft-delete promised reversibility, but Phase 3 only shipped the abandon→archive direction. Setting `branches.state = 'active'` while leaving archived transactions untouched would mean *recall does not surface facts again* — restore would be in name only.

**Rejected alternatives:**
- (i) state only — violates the mental model above.
- (iii) split into `branch --restore` + `gc-branches --un` — doubles the user-error surface (forgetting the second step looks like a silent failure).

**Consequence/Risk:** After restore, facts surface immediately. If another active branch produced a content-hash-identical fact while this branch was abandoned, it stays deduped — a logical re-emergence with no new row. Re-confirms D-011: facts are never deleted, only the *visibility* of their transactions changes.

**Related commit:** Phase 4 P3 `feat/phase4-p2-p3-repair-restore` branch.

---

## D-017: time-based auto-abandon piggybacks on `gc-branches --max-age`

**Decision:** Time-based auto-abandon ships as an *opt-in flag* `--max-age N` on the existing `gc-branches` command, not as a separate command. Without the flag, `gc-branches` behaves identically to before (backward compat). With the flag, one pass performs `active → abandoned → archived` for active non-main branches whose most-recent activity is older than `now − N days`. Activity timestamp = `transactions.ts` of `branches.head_tx_id`, with `branches.created_at` as the fallback when `head_tx_id` is NULL. `main` is always protected. Future non-active non-abandoned states (e.g. `'merged'`) are *silently skipped* — excluded from auto-abandon candidates rather than throwing.

**Context:** D-011 soft-delete is most valuable when *stale speculative branches actually get cleaned up*. Requiring users to call `branch --abandon` for every old branch shifts cost onto memory and discipline. Time-based automation is needed, but the D-009 (no daemon) identity rules out always-on background processes — the trigger must be user-issued. `gc-branches` is already that trigger (it is the cleanup verb), so opting into auto-abandon there is the natural place.

**Rejected alternatives:**
- (B) a new `auto-abandon` command + a separate `gc-branches` — clean separation but doubles call cost; users have to chain two verbs.
- (C) `branch --auto-abandon` — sweep semantics on a single-name command surface feels wrong.
- (β) `--max-age` defaults to 60 days — convenient but risks unintended large sweeps.
- (γ) env-var default (`IMPACT_TRACE_AUTO_ABANDON_DAYS`) — implicit policy is inappropriate for destructive ops.

**Consequence/Risk:** Users explicitly state their threshold (30/60/90 days) — prevents accidental large abandons. Existing `gc-branches` callers see zero change. The `branches.created_at` fallback mixes ISO 8601 (user-created branches via `new Date().toISOString()`) and SQLite `datetime('now')` format on the seeded `main` row — but `main` is `PROTECTED_BRANCH` and excluded from comparison, so the format mismatch is moot. If `'merged'` is later introduced, silent skip will need a follow-up ADR to clarify treatment.

**Related commit:** Phase 4 P4 `feat/phase4-p4-auto-abandon` branch.

---

## D-018: sqlite-vec ANN with per-model vec0 tables, lazy create, and brute-force fallback

**Decision:** Accelerate `recallSemantic` with sqlite-vec virtual tables. (a) **Per-model vec0 tables** `vec_facts_<model_slug>(fact_id TEXT PRIMARY KEY, embedding int8[<dim>])` — different models have different dims, so a single virtual table with max-dim padding wastes storage. (b) **Lazy creation** — `CREATE VIRTUAL TABLE IF NOT EXISTS` at the first dual-write for that model. (c) **Manual backfill + automatic fallback hybrid** — users run `reindex-vec` (CLI) to repopulate; if the vec table is absent or sqlite-vec extension load fails, recallSemantic *silently* falls back to the JS-side brute-force int8 dot product. (d) **`int8[N]`** type matches existing `fact_embeddings.vector` storage parity. (e) **Silent fallback on extension load failure** — existing callers see zero regression.

**Context:** D-007 multi-model + D-001 local-first jointly narrowed the design space. The `sqlite-vec ^0.1.9` dep had been declared since Phase 1.5 but was never wired (the `loadVectorExtension` function existed and was exported, but had zero call sites; `recallSemantic` always loaded every embedding row and ran a JS dot product). Above ~10K rows the brute-force latency is user-perceptible. The signatures of `recallSemantic` + multi-model isolation must both be preserved.

**Rejected alternatives:**
- (b1) v8 migration creates vec tables per known model — irrelevant when no model is known yet; lazy is simpler.
- (b2) auto-backfill at every db open — *blocks first open* for repos with tens of thousands of rows.
- (c1) explicit reindex with no fallback — existing callers see performance regressions or hard breaks if the extension fails to load.
- (1) single virtual table + model column + max-dim padding — 12× storage waste when 768d and 64d models coexist.
- (2) float[N] — slightly higher recall, 4× storage.
- (3) bit[N] — much faster, slight accuracy loss (binary quantization). Reserved as a follow-up optimization.

**Consequence/Risk:** vec0 does **not** support `INSERT OR REPLACE` — dual-write uses `DELETE WHERE fact_id = ? + INSERT` for idempotent upsert. A raw 768-byte int8 buffer is auto-detected as float32 by vec0 (768/4=192) — `vec_int8(?)` explicit cast is mandatory; missing it is a silent quality loss. ANN combined with archived/branch filters: vec0 MATCH returns top-k from the *whole index*; if post-JOIN filters drop too many rows, results may underflow. Mitigation: over-fetch by `k * 5` (min 20). Future sqlite-vec API drift or native binary architecture mismatch is absorbed by the silent fallback.

**Related commit:** Phase 4 P5 `feat/phase4-p5-sqlite-vec-ann` branch.

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
