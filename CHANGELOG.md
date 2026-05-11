# Changelog

All notable changes to Impact-Trace are recorded here. The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), grouped by *Phase* rather than calendar releases because development is incremental.

For day-by-day developer log see [docs/progress.ko.md](docs/progress.ko.md). For ADR rationale see [docs/decisions.ko.md](docs/decisions.ko.md).

---

## Planning — Impact context layer (2026-05-09)

### Added

- **Product plan** — `docs/impact-context-layer-plan.ko.md` defines the MCP + local UI product shape, with code/docs/policies/proposals/decisions in one impact graph.
- **Context budget goal** — the plan makes AI context reduction a first-class requirement: compact context packs, resource-on-demand evidence, ranking/dedupe, and `brief`/`standard`/`deep` MCP budgets.
- **Phase 6B retargeted** — the next product slice is now Multi-language + Spring Boot Adapter Pack v0 + Trusted Evidence, covering Java, Kotlin, Spring Boot, Python, Go, Rust, TypeScript, and JavaScript rather than a TypeScript-only lane.
- **ImpactBench thin spine** — `npm run bench` now builds a deterministic multi-language/Spring Boot fixture, scores relation recall/precision, affected-file recall, evidence presence, span completeness, adapter attribution, and context-pack readiness, then writes `.impact-trace/bench/impact-bench-report.json`.
- **OpenAPI contract impact baseline** — path-obvious OpenAPI/Swagger/AsyncAPI YAML/JSON files are indexed as contracts, persisted to contract baseline/version tables, and reverse-linked from implementing code when the contract explicitly names repo-local source paths.
- **Workspace catalog v0** — `impact-trace workspace init/add-repo/list` manages an explicit local repo allowlist in `.impact-trace/workspace.json` and syncs it into `workspaces`/`workspace_repos` without cloning or network access.
- **Cross-repo contract resolver v0** — `impact-trace workspace resolve-contracts` reads indexed local workspace repos, matches consumer HTTP literals to provider OpenAPI endpoints, and persists deterministic `cross_repo_links` without cloning or network access.
- **GraphQL consumer resolver v0** — `impact-trace workspace resolve-contracts` also matches indexed GraphQL operation documents to provider `Query.*`/`Mutation.*`/`Subscription.*` root fields, reusing compact cross-repo links so contract diff can persist known GraphQL consumer impact.
- **Protobuf/AsyncAPI consumer resolver v0** — `impact-trace workspace resolve-contracts` also matches Protobuf RPC calls and AsyncAPI event address literals to provider operations, so removed RPCs/events can persist known downstream impact without Buf, runtime reflection, schema registry, or raw contract snapshots.
- **Generated-client/event topology resolver v0** — Protobuf matching now covers Connect-ES style generated client calls and full `pkg.Service/Rpc` route strings, while AsyncAPI event matches record producer/consumer topology hints for common Spring Kafka, KafkaJS, Python, Go, and Rust call-site shapes without adding EventCatalog, AsyncAPI parser/diff, or Buf/protoc runtime dependencies.
- **Contract diff event topology provenance** — removed AsyncAPI operation impact now carries the resolved producer/consumer topology hint from `CONSUMES_HTTP_ENDPOINT` into impacted consumer results and `BREAKS_COMPATIBILITY_WITH` provenance.
- **Contract topology surface v0** — contract diff summary, CLI human output, and MCP `/cross-repo-links` resource now expose producer/consumer topology hints as compact fields so agents do not need to re-parse nested provenance.
- **UI workspace topology surface v0** — `impact-trace ui` now shows workspace contract baselines, cross-repo provider/consumer links, event topology hints, and `/api/workspaces/{name}` JSON so humans can inspect the same compact resource shape that MCP agents expand on demand.
- **Build-system/package resolver v0** — `indexProject()` reads `package.json`, `pom.xml`, `build.gradle(.kts)`, `go.mod`, `Cargo.toml`, and `pyproject.toml` as manifest-only package graph inputs, emits package `DECLARES`/`DEPENDS_ON` relations, and lets package manifest changes reach dependent manifests without executing npm, Maven, Gradle, Go, Cargo, or Python tooling.
- **OpenAPI contract diff v0** — `impact-trace workspace contract-diff` compares the latest indexed OpenAPI endpoint surface with the current contract file, classifies removed endpoints as breaking and added endpoints as non-breaking, and persists impacted consumers as `BREAKS_COMPATIBILITY_WITH` links.
- **OpenAPI nested schema diff v0** — JSON/YAML OpenAPI compatibility signatures now use schemaVersion 2 with nested object paths, root/nested array item paths, allOf object merges, and oneOf/anyOf property/root body fingerprints so contract diff can report nested body breaking changes without sending whole contract files to the agent.
- **Protobuf contract diff v0** — `.proto` baselines now store compact `protobuf-compat-v0` service/RPC/message signatures, and `workspace contract-diff` classifies removed RPCs plus response message field removals/type changes as breaking without requiring Buf, BSR, or raw contract snapshots in SQLite.
- **GraphQL contract diff v0** — `.graphql`/`.gql` baselines now store compact `graphql-compat-v0` root operation/object/input signatures, and `workspace contract-diff` classifies removed root fields, response field removals/type changes, required argument additions, and required input field additions as breaking without requiring Hive, GraphQL Inspector, or raw SDL snapshots in SQLite.
- **AsyncAPI contract diff v0** — AsyncAPI YAML/JSON baselines now store compact `asyncapi-compat-v0` operation/channel/message payload signatures, and `workspace contract-diff` classifies removed operations plus message payload field removal/type changes and newly required payload fields as breaking without requiring `@asyncapi/parser` or `@asyncapi/diff` at runtime.
- **MCP workspace/contract resources v0** — `impact_trace_contract_diff` exposes the endpoint-surface classifier to coding agents and returns `impact-trace://workspaces/{name}` resource links for workspace membership, latest contract baselines, and provider/consumer impact links.
- **MCP context pack v0** — `impact_trace_context_for_change` returns budgeted `brief`/`standard`/`deep` context packs with top impact paths, compact evidence, actions, omitted counts, and entity/coverage resource links without persisting a full report.
- **Docs root cleanup** — root `docs/` keeps the current high-signal docs for planning, onboarding, and implementation.

---

## Phase 6 — Adapter foundations (2026-05-04, landed on main 2026-05-09)

Originally developed on `feature/phase6-adapter-foundations`; landed on `main` as the rewritten 8-commit Phase 6 series ending at `3cba0a2`.

### Added

- **Adapter foundation scaffold** — `SemanticAdapter`/`AdapterRun` streaming interface, priority `AdapterRegistry`, and `MultiLanguageRegexAdapter` extraction give future language/framework, LSP, CodeQL, and workspace adapters a stable dispatch point.
- **Multi-adapter attribution** — `indexProject()` now creates per-adapter runs, attributes coverage per adapter, writes relation `adapter_run_id`, and reports adapters used by language.
- **Adapter diagnostics observability** — diagnostics are persisted as coverage diagnostic entries and summarized on adapter runs, including diagnostics emitted before a later adapter failure.
- **Public exports fence** — package exports are fenced so consumers import through the intended public package surface.

### Changed

- **Failure handling keeps completed adapter runs intact** — a later adapter failure no longer erases or rewrites earlier completed adapter run status; unstarted later adapters are marked skipped.
- **Relation evidence preservation** — adapter-provided relation evidence is stored as first-class relation evidence, redacted before persistence, and assigned stable IDs that do not change with evidence order.
- **Fanout accounting** — impact fanout limits now dedupe relation joins with multiple evidence rows so evidence count does not inflate relation fanout.
- **Symbol version hashes** — symbol `entity_versions.content_hash` now includes the containing file content hash, so symbol versions change when the file body changes.
- **Relation-kind memory mapping** — relation-kind to memory attribute mapping is explicit, and static code-relation attributes are seeded/promoted with `is_code_relation = 1`.

### Follow-up scope

- GraphQL/protobuf/AsyncAPI full parser/LSP depth, generated-client data-flow graph, richer event topology inference, and deeper package-manager/build model resolution.

---

## Phase 4 — Five sub-phases shipped (2026-04-29 ~ 2026-05-01)

Phase 4 code baseline `33c49f0`. **112 tests passing.** ADR D-001..D-018. MCP 12 tools. CLI 16 commands.

### Added (P1 — scaling cap + Profile API + supermemory adoption)

- **Profile API** — `impact-trace profile --entity X` (CLI) and `impact_trace_profile` (MCP tool, readOnly) return a per-entity three-bucket view: `staticFacts` (indexer-emitted code relations), `dynamicFacts` (agent activity), `summaryFacts` (Phase 3 reflection outputs). Implementation in `src/profile.ts`.
- **`factLifecycle()` helper** — exposes the existing `attribute_defs.is_code_relation` binary as a typed `Lifecycle = 'static' | 'dynamic'` union. No new database column.
- **Reflect scaling cap** — `collectCandidates` now uses `StatementSync.iterate()` for streaming, and per-entity facts are bounded by `MAX_FACTS_PER_ENTITY` (default 50, override via env `IMPACT_TRACE_REFLECT_MAX_FACTS_PER_ENTITY`). Memory complexity drops from O(total_old_facts) to O(unique_entities × cap).
- **Skill packaging** — new `skills/impact-trace/SKILL.md` + `references/architecture.md` so Claude Code users can `npx skills add YouSangSon/Impact-trace`.

### Added (P2 — `reflect --repair`)

- **`repairReflections()`** + CLI `reflect --repair` + MCP `impact_trace_repair_reflections`. Sweep that reconciles orphan summary facts left by the Phase 3 SAVEPOINT atomicity gap. Idempotent via `INSERT OR IGNORE` audit row.

### Added (P3 — `branch --restore`)

- **`restoreBranch()`** + CLI `branch --restore <name>` + MCP `impact_trace_restore_branch`. Reverses `abandon` + `gc-branches`: `branches.state='active'` AND `transactions.archived=0` in one atomic call. Throws on non-active non-abandoned states (future-proof against `'merged'`).

### Added (P4 — time-based auto-abandon)

- **`gc-branches --max-age N`** flag — opt-in. Auto-abandons every active non-main branch with no activity newer than `now − N days` (head_tx_id's `transactions.ts`, fallback to `branches.created_at`), then archive-sweeps both newly auto-abandoned and pre-existing abandoned in one atomic call. Backward-compat: without the flag, `gc-branches` is byte-identical to before.
- **`GcBranchSummary.autoAbandoned: boolean`** + `GcBranchesResult.autoAbandoned: number`.

### Added (P5 — sqlite-vec ANN)

- **Per-model `vec_facts_<model_slug>` virtual tables** (sqlite-vec vec0, `int8[<dim>]`) — lazy-created at first dual-write.
- **Dual-write in `remember()` and `reembedFacts()`** — mirrors `fact_embeddings` writes via `DELETE + INSERT` (vec0 disallows `OR REPLACE`). `vec_int8(?)` cast prevents 768-byte buffers from being auto-detected as float32.
- **`recallSemantic()` ANN path** — vec0 MATCH with k×5 over-fetch + post-JOIN filters. Silent fallback to brute-force int8 path when extension absent or SQL error.
- **`reindexVec()` + CLI `reindex-vec [--model <id>]`** — manual backfill from `fact_embeddings`.
- **Four new exports in `src/store.ts`** — `isVectorExtensionLoaded`, `vecTableName`, `ensureVecTable`, `hasVecTable`.

### New ADRs (six total in Phase 4)

- D-013: lifecycle binary derives from `is_code_relation`; no new column. (P1)
- D-014: Profile API is built on top of recall, not merged into it. (P1)
- D-015: `reflect --repair` is a separate trigger (not auto-on-reflect). (P2)
- D-016: `branch --restore` flips state AND clears `transactions.archived` in one atomic call. (P3)
- D-017: time-based auto-abandon piggybacks on `gc-branches --max-age`. (P4)
- D-018: sqlite-vec ANN with per-model vec0 tables, lazy create, brute-force fallback. (P5)

### Changed

- README's MCP tools table now lists **12 tools** (added `impact_trace_profile`, `impact_trace_repair_reflections`, `impact_trace_restore_branch`).
- README's CLI list now has **16 commands** (added `profile`, `reindex-vec` — plus `branch --restore`, `reflect --repair`, `gc-branches --max-age` flags).
- README's Phase status table marks Phase 4 complete (P1..P5 all shipped) and adds a Phase 5 candidate row.
- New top-level docs at the time included vision, roadmap, glossary, and planning notes.
- Historical English decision-log sync covered D-001..D-018.

### Rejected (recorded in the historical supermemory adoption review)

- **`fact_provenance.kind` enum expansion** to add `'updates' / 'extends' / 'derives'`. Conflicts with D-002 + D-010.
- **Pipeline state machine** on `index_runs.stage`. Wrong table — D-005 keeps memory ingestion stateless.

### Tests

- **76 → 112 tests** across the five sub-phases. P1 added 9 (profile + factLifecycle + reflect cap), P2 added 4 (repair), P3 added 3 (restore), P4 added 7 (auto-abandon), P5 added 8 (vec.test.ts). External 4-perspective review on P1+P2+P3 PRs surfaced 4 HIGH test gaps + 1 MEDIUM type precision gap; all closed before merge.

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
- **Phase 3 design note** with autoplan-style dual-voice consensus, DX scorecard, failure modes registry.
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
- **`docs/agent-memory-cookbook.ko.md`**.

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

`package.json` currently declares `0.1.0` for npm/dev identity, but this changelog
is still grouped by phase while the public API is stabilizing. Each Phase is a
logical milestone on `main`; when release packaging is formalized, new entries
will be grouped under dated semantic versions instead of only phase headings.
