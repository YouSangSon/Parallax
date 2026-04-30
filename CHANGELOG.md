# Changelog

All notable changes to Impact-Trace are recorded here. The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), grouped by *Phase* rather than calendar releases because development is incremental.

For day-by-day developer log see [docs/progress.ko.md](docs/progress.ko.md). For ADR rationale see [docs/decisions.ko.md](docs/decisions.ko.md).

---

## Unreleased — Phase 4 + supermemory adoption (2026-04-29 ~ 2026-04-30)

### Added

- **Profile API** — `impact-trace profile --entity X` (CLI) and `impact_trace_profile` (MCP tool, readOnly) return a per-entity three-bucket view: `staticFacts` (indexer-emitted code relations), `dynamicFacts` (agent activity), `summaryFacts` (Phase 3 reflection outputs). Designed for one-call agent prompt-context injection. Implementation in `src/profile.ts`.
- **`factLifecycle()` helper** — exposes the existing `attribute_defs.is_code_relation` binary as a typed `Lifecycle = 'static' | 'dynamic'` union. No new database column. Used internally by Profile API.
- **`Lifecycle` type** in `src/types.ts`, re-exported from `src/index.ts`.
- **Reflect scaling cap** — `collectCandidates` now uses `StatementSync.iterate()` for streaming, and per-entity facts are bounded by `MAX_FACTS_PER_ENTITY` (default 50, override via env `IMPACT_TRACE_REFLECT_MAX_FACTS_PER_ENTITY`). The prompt footer discloses how many newer observations were elided. Memory complexity drops from O(total_old_facts) to O(unique_entities × cap).
- **Skill packaging** — new `skills/impact-trace/SKILL.md` and `skills/impact-trace/references/architecture.md` so Claude Code users can run `npx skills add YouSangSon/Impact-trace`. Frontmatter follows the supermemoryai/supermemory convention.
- **Documentation index** — new `docs/README.md` aggregates all 18 documents with fast-lookup tables.
- **CHANGELOG** — this file.
- **`docs/supermemory-adoption.ko.md`** — 4-perspective review (architect / typescript-reviewer / code-explorer / security) of supermemoryai/supermemory patterns. Captures which patterns were adopted, which were rejected, and the ADR-anchored reasoning behind each rejection.
- **Two new ADRs (D-013, D-014)** in `docs/decisions.ko.md`:
  - D-013: lifecycle binary derives from `is_code_relation`; no new column.
  - D-014: Profile API is built on top of recall, not merged into it.
- **Phase 4 entry-point handoff** — `docs/phase4-handoff.ko.md` with 9 deferred candidates ranked by priority and 4 design decisions (D-013..D-016) for the next session.

### Changed

- README's MCP tools table now lists 10 tools (added `impact_trace_profile`).
- README's Phase status table marks Phase 4 complete.
- `agent-memory-cookbook.ko.md` plus the indexing model docs reference the v7 schema deltas.

### Rejected (recorded in `supermemory-adoption.ko.md` for future reference)

- **`fact_provenance.kind` enum expansion** to add `'updates' / 'extends' / 'derives'`. Conflicts with D-002 (content-addressable id makes "Updates" already expressible via retract+assert) and D-010 (one `'summary'` kind covers derived/extended). Future need would warrant a new ADR with the discriminating query stated upfront.
- **Pipeline state machine** on `index_runs.stage`. Wrong table — that pipeline is the codebase indexer, not memory ingestion. Memory ingestion is intentionally stateless per D-005.

### Tests

- 87 tests total (78 → +9 profile tests). 9 new tests cover lifecycle partitioning, branch isolation, archived exclusion, redacted surface, reflection bucket, missing-entity error path, unknown-branch error path, `factLifecycle` mapping, and the per-bucket k cap.

---

## Phase 3 — Reflective Consolidation + Speculative Branch GC (2026-04-29)

3 commits (`8ee5010 → 60a9fe1`).

### Added

- **Schema v7** (additive, idempotent ADD COLUMN via PRAGMA + allowlist):
  - `branches.state` (`'active' | 'abandoned' | 'merged'`)
  - `transactions.archived` (soft-delete flag)
  - `fact_provenance.kind` (`'evidence' | 'summary'`)
  - `reflections` audit table
- **Multi-provider LLM abstraction** (`src/llm.ts`) — `stub | ollama:* | anthropic:* | openai:*` selected via `IMPACT_TRACE_REFLECTION_MODEL`. `fetch`-only, no SDK deps. 30s `AbortSignal.timeout`. HTTPS required for Anthropic/OpenAI.
- **Reflective consolidation** (`src/reflection.ts`) — `reflectFacts(repoRoot, options)` groups older facts per entity, asks the LLM to summarise, writes one summary fact with `kind='summary'` provenance. Per-draft SAVEPOINT for atomicity.
- **Speculative branch GC** (`src/branch_gc.ts`) — `abandonBranch` + `gcBranches` (soft-delete via `transactions.archived`). `main` is protected.
- **CLI commands** — `reflect`, `branch --abandon`, `gc-branches`.
- **MCP tools** — `impact_trace_reflect`, `impact_trace_abandon_branch`, `impact_trace_gc_branches`.
- **Secret regex expansion** — added Stripe, Google API, npm, JWT, DB connection URL families to `redactSecrets`.
- **`docs/phase3-design.ko.md`** with autoplan-style dual-voice consensus, DX scorecard, failure modes registry.
- **`docs/decisions.ko.md`** — cumulative ADR log D-001..D-012.

### Changed

- `recall`, `recallSemantic`, `trace` all filter `t.archived = 0` so soft-deleted speculative branches stop surfacing facts. The `trace` filter was added in the architect-review pass, fixing a leak in the first draft.
- All LLM-bound calls run input + output through `redactSecrets` (three-point gate).

### Tests

- 76 tests (43 → +33). Notable additions: schema v7 idempotence + real v6→v7 upgrade, LLM HTTP mock paths, reflection redaction exclusion, branch GC archive parity for trace and recall, MCP wire round-trips for the three new tools.

---

## Phase 2 — Real Embeddings + Semantic Recall + Branch Merge (2026-04-29)

5 commits (`cb50bc3 → 7e86f83 → 43418ec → a9c8a92`).

### Added

- **Real embedding pipeline** — `@huggingface/transformers` ONNX in-process. Default `Xenova/multilingual-e5-base` (768-dim, multilingual including Korean). Override via `IMPACT_TRACE_EMBEDDING_MODEL`.
- **Schema v6 model-agnostic `fact_embeddings`** with composite PK `(fact_id, model)` so a fact can carry vectors from multiple models simultaneously.
- **Semantic recall** — `recall --query --semantic` runs int8 dot product (≈cosine on L2-normalized vectors).
- **Branch merge** — `mergeBranches` creates multi-parent transaction joining two branch heads. Recursive CTE walks `transaction_parents` so recall on the merged branch sees facts from both ancestors.
- **`reembed` CLI** — bulk re-embed pass after a model swap (`--model X` / `--all`).

### Changed

- `transactions` schema gained the `transaction_parents` table for multi-parent edges (schema v5).

---

## Phase 1+1.5 — Agent Memory Layer Foundation (2026-04-28)

7 commits (`ffc4bf4 → 4423743`).

### Added

- **Schema v4** — `facts`, `transactions`, `branches`, `fact_provenance`, `embeddings`, `attribute_defs`. Single SQLite file at `<repo>/.impact-trace/impact.db` (D-001).
- **Content-addressable fact id** — `SHA-256(entity || attribute || value || op)` (D-002). Same observation never duplicates.
- **MCP tools** — `impact_trace_remember`, `impact_trace_recall`, `impact_trace_branch`, `impact_trace_trace`.
- **CLI commands** — `remember`, `retract`, `recall`, `branch`, `trace`.
- **First-class code-relation attributes** seeded with `is_code_relation=1`: `imports`, `calls`, `affects`, `depends_on`.
- **Indexer dual-write** — every canonical relation becomes both a `relations` row and a `facts` row + `evidence_snippet` fact + `fact_provenance` edge so trace can walk from a relation back to source code.
- **sqlite-vec integration** + embedding pipeline scaffolding (stub model).
- **Redact-then-embed zero-row policy** (D-004) — facts whose value matches a secret pattern store `value_blob='[REDACTED]'` and create *no* embedding row.
- **`as_of_tx` time-travel** — recall walks `transaction_parents` via recursive CTE.
- **`--current-only`** — recall window-function dedups retracts (latest assert per `(entity, attribute, value_blob)`).
- **`docs/agent-db-exploration.ko.md`**, **`docs/agent-memory-cookbook.ko.md`**.

---

## P0/P1 — MVP code impact analyzer (2026-04-28)

Pre-Phase 1 baseline.

### Added

- `init`, `index`, `analyze`, `graph export`, `mcp serve` CLI.
- `entities`, `relations`, `relation_evidence`, `adapter_runs`, `index_coverage` canonical schema.
- TypeScript / JavaScript / Markdown / Python / Go / Rust / Java / Kotlin / C# / C / C++ + shell / YAML / JSON / TOML / Dockerfile / Makefile / Terraform / protobuf / GraphQL / CODEOWNERS adapter coverage.
- `analyze --base / --head` git diff input + bounded multi-hop traversal + cycle protection + stale-index warning + oversized file skip.
- Mermaid / JSON / DOT graph export from saved reports.
- Read-only MCP resources: reports, entities, graphs, latest coverage.
- Path containment check (realpath, symlink-safe) and secret redaction in evidence output.

---

## Versioning policy

This project doesn't ship semantic versions yet — everything is *Unreleased* on `main`. Each Phase is a logical milestone. When the public API stabilises and a v0.1 ships, this changelog will switch to date-based versions.
