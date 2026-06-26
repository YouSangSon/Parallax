# Improvement & Expansion Opportunities

> Engineering backlog produced by a structured five-dimension architectural review of Parallax.
> Each item is grounded in the actual code (file cited), preserves the project invariants
> (**determinism / no required network**, **first-class per-relation confidence**, **honest per-adapter
> `knownGaps`**, **read-only-by-default agent surface — I-8**), and carries a rough effort
> (**S** = one slice · **M** = a few slices · **L** = multi-session) and value rating.
>
> This is the detailed backlog *behind* the thematic [docs/roadmap.md](docs/roadmap.md). Concise
> "direction" tracking stays in the roadmap; the depth lives here.

## How to read this

- **Effort** — S/M/L as above. **Value** — HIGH / MED-HIGH / MED / LOW for impact-analysis users.
- Items marked **✅ shipped** were completed after this review; the rest are open.
- Every "proposed direction" is constrained to keep determinism and honest confidence — no LSP
  servers, no native binaries, no non-deterministic parallelism, parser-resolved edges at
  `inferred`/`proven` and fuzzy/unresolved at `heuristic`.

---

## 1. Accuracy & language adapters

The TS/JS lane is parser-backed (per-file `ts.createSourceFile`, no `Program`/`TypeChecker`);
JVM/Spring, Python, Go, Rust extend `RegexBackedSemanticAdapter` at flat `heuristic` confidence.
The only runtime dep is `typescript`, so new parsers must be bundled/offline (tree-sitter WASM or
pure-JS), never an analyzer server.

| # | Opportunity | Effort | Value |
| :-- | :-- | :-- | :-- |
| A1 | **TypeScript program-mode type resolution** — build indexed files into one in-memory `ts.createProgram` and use `getTypeChecker()` to resolve receivers/return types by `Symbol`/`Type` instead of hand-rolled name-matching (`multi-language-regex.ts` ~1876–3335). Checker-resolved → `proven`, name-match fallback → `inferred`. Unlocks generics instantiation, conditional/mapped/`typeof` types, the "wider dynamic dispatch" the roadmap defers. | L | HIGH |
| A2 | **Promote Python to parser-backed** — replace the regex `PythonSemanticAdapter` with a bundled tree-sitter-python (WASM) pass: real imports/defs/calls/class-bases with spans, intra-repo import resolution. AST-resolved → `inferred`, dynamic/unresolved → `heuristic`. Establishes the reusable offline-parser harness A3/A6 reuse. | M | HIGH |
| A3 | **JVM/Spring parser-based DI / persistence / endpoint links** — bundled tree-sitter-java/kotlin to build the bean graph (constructor + `@Autowired` → `DEPENDS_ON`), JPA repository→entity (`READS`/`WRITES`/`IMPLEMENTS`), and controller route→OpenAPI contract (`IMPLEMENTS`). Today a regex lane already emits a coarse `spring:Bean` `DEPENDS_ON` (heuristic, `extractSpringBeanMethods`) plus regex HTTP mappings — but no parser-resolved DI graph, no JPA persistence links, and no controller→contract cross-link. Depends on the offline-parser harness (A2). | L | HIGH |
| A4 | **Symbol-level test↔impl linking** — `inferTestTargets` (`multi-language-regex.ts:5406`) emits `VERIFIES` at file granularity only. Resolve the symbols a test body exercises and emit `VERIFIES` to the target *symbol*; direct call → `inferred`, name-only → `heuristic`. Tells a reviewer exactly which tests cover a changed function. | M | HIGH |
| A5 | ✅ **shipped** — TS/JS `CALLS` (the `multi-language-regex.ts` parser lane, which only emits *resolved* calls) no longer collapse to flat `inferred`: type-inferred receiver dispatch (`instance-call`) and object-flow aliases (`method-alias-call`) — the dynamic-dispatch gap the knownGaps flags — are downgraded to `heuristic`; concretely-resolved calls (import, this-method, super, static, direct-instance, local) stay `inferred`. Resolution stays discoverable via the relation provenance prefix (no schema change). | S | MED-HIGH |
| A6 | **Framework routing for Python/Go web frameworks** — zero routing extraction for Flask/Django/FastAPI or gin/echo/net-http (bench ships FastAPI + Go fixtures). Recognize route decorators/registrations → `endpoint` entities + `DECLARES`, cross-linked to contracts. Depends on A2 / a Go parser. | M | MED-HIGH |

**Sequencing:** A5 (cheap honesty) → A1 (raises the ceiling on the reference lane) → A2 (first regex→parser, builds the harness) → A4 → A3 / A6.

---

## 2. Agent surface & MCP

20 read-only-first MCP tools + 9 resources. Recent additions: `parallax_co_change` (ranked git
co-change coupling), `parallax_query` (read-only Cypher subset), CLI `ingest-traces` (write surface,
off MCP by I-8). Context-pack telemetry is recorded but nothing acts on it.

| # | Opportunity | Effort | Value |
| :-- | :-- | :-- | :-- |
| M1 | ✅ **shipped** — multi-hop + aggregation in `parallax_query`: variable-length paths (`-[r:TYPE*1..N]->`, recursive CTE, depth cap 8), `ORDER BY <projected col> ASC/DESC` (incl. `ORDER BY COUNT(..)` for top-N), and `COUNT(<var>)` with implicit grouping (non-aggregate RETURN items become group keys). `COUNT(*)` and `COUNT` on variable-length paths are rejected. Read-only + deterministic. | M | HIGH |
| M2 | ✅ **shipped** — `parallax_query` now routes through `toolJsonResponse` (telemetered like every sibling) and the result carries the queried `indexRunId` + distinct `resources.entities` ids (from id-projecting columns), navigable via `parallax://entities/{id}`. | S | HIGH |
| M3 | ✅ **shipped** — read-only `parallax_co_change` ranks coupled files by `couplingScore` (parsed from CO_CHANGES provenance), partners navigable via `parallax://entities`. Follow-on ✅: `context_for_change` now folds in the top co-change partners as a budget-aware, heuristic-confidence advisory section (`selectCoChangePartners` + `ContextPack.coChanges`). | M | HIGH |
| M4 | **Structured "what-changed-since" tool** — only a human-readable drift warning exists (`analyzer.ts:372`). Add `parallax_changed_since` returning a deterministic delta (entities/relations added/removed, confidence promotions) between two index runs. Lets agents orient incrementally. | M | MED |
| M5 | **Context-budget advisory from telemetry** — `context_tool_runs`/`hit_count` are recorded but unused. Add `parallax_context_advice` computing omitted-vs-returned and expanded-resource ratios → a suggested budget (advisory only, I-9). | M | MED |
| M6 | ✅ **shipped** — MCP workflow prompts now exist: `impact_workflow` and `triage_change` lay out the analyze→context→query/co_change→remember flow so agents discover the intended read path without guessing. | S | MED |
| M7 | **Permissioned write surface for trace ingestion (I-8)** — Phase A: read-only `parallax_trace_preview` (dry-run match, returns promoted/unmatched, no write). Phase B: gated `parallax_ingest_traces` behind explicit opt-in. Closes the observe→prove loop while honoring read-only-first. | L | LOW-MED |

**Sequencing remaining work:** M4 / M5 → M7-Phase-A → M7-Phase-B. The quick-win prompt/query layer (M1/M2/M3/M6) is now in place.

---

## 3. Architecture, scale & performance

Incremental indexing now exists for the unchanged-file carry-forward path, and indexing now commits
the graph/current-state cohort in one explicit crash-atomic transaction after adapter extraction
finishes. Saved/exported artifact immutability is now explicit; `scanFiles` still walks the repo,
and analyzer traversal is N+1 per frontier node.

| # | Opportunity | Effort | Value |
| :-- | :-- | :-- | :-- |
| S1 | **Incremental indexing follow-through (content-hash-gated)** — the core arc is partially shipped: content-hash/extractor-version delta classification, unchanged-file carry-forward into the new `index_run_id`, saved/exported artifact immutability, crash-atomic graph/current-state commits, and `bench:perf` slices for full/no-op incremental/edited-file incremental/analyze phases are all in place. Still open: reduce the remaining all-files bookkeeping cost for unchanged files. | L | HIGH |
| S2 | ✅ **shipped** — write-mode SQLite pragmas are in place, and indexing now commits the graph/current-state cohort in one explicit transaction after adapter extraction finishes. A child-process crash regression proves partial files/relations/evidence/transactions from a crashed run do not become current. | S | HIGH |
| S3 | ⛔ **deprioritized — premise refuted by measurement.** The idea was to batch the per-node traversal query (`loadCanonicalImpactRows`) to cut round-trips. Built and verified byte-identical, then `bench:perf` showed it **flat** (2k files: 7545→7475 ms) even on a 200-node frontier: **in-process SQLite has no per-query latency, so N+1 query *count* is ~free** — and local-first is an invariant, so it can never matter. Reverted as premature optimization (KISS/YAGNI). The traversal-semantics characterization test (`tests/analyzer-traversal-batch.test.ts`) was kept as a guard for any future change. | M | ~~HIGH~~ LOW |
| S4 | **Large-repo perf benchmark + documented limits** — foundation ✅: deterministic synthetic-repo generator (`bench/synthetic-repo.ts`, guarded by `tests/synthetic-repo.test.ts`) + `npm run bench:perf` (`bench/impact-perf.ts`) now reporting full initial index, no-op incremental index, edited-file incremental index, analyze-without-persist, and analyze-with-persist phases at scale, isolated from the determinism-locked accuracy bench, with an optional `--max-ms-per-kfile` CI gate. The perf run already exposes super-linear analyze cost (the S3 hotspot). Still open: standard 10k/50k scales + peak-RSS capture + published baseline limits; deterministic `verify` should continue to avoid exact timing assertions. | M | MED-HIGH |
| S7 | ✅ **shipped** — saved report graph exports now treat persisted report JSON as the immutable graph snapshot source. Canonical graph rows remain only a legacy fallback when a persisted report lacks relation-bearing evidence, so later index cohorts, carry-forward, retention, repair, or canonical row mutation do not rewrite modern saved artifacts. | M | HIGH |
| S5 | **Retention / prune superseded index runs (+ VACUUM)** — every run inserts a new cohort; nothing prunes old ones, so the DB grows by a full snapshot per run. Add deterministic retention (keep last N completed) inside a transaction + optional VACUUM. | M | MED |
| S6 | **Committable / shareable index artifact** — define export/import of a compacted single-cohort DB + a `{extractor_version, git_commit_sha, content_hash set}` manifest; on import warn when hashes diverge from the working tree. "Index once in CI, everyone consumes." Depends on S5. | M | MED |

**Sequencing:** S1 (biggest structural win) with S4 alongside to guard → S5 → S6. Watch-mode is a thin follow-on to S1.

---

## 4. Workspace, contracts & cross-repo

A cross-repo workspace catalog, provider↔consumer resolver, and OpenAPI/GraphQL/Protobuf/AsyncAPI
breaking-change diff exist. W1/W2/W6 are shipped; remaining work focuses on W4/W5
contract fidelity and W3 package modeling.

| # | Opportunity | Effort | Value |
| :-- | :-- | :-- | :-- |
| W1 | ✅ **shipped** — W1 shipped: primary `analyzeDiff` reports now include persisted workspace `BREAKS_COMPATIBILITY_WITH` consumers as `crossRepoImpacts`, affected external entities, relation-bearing evidence, graph edges, and UI cross-repo lane entries. | M | HIGH |
| W2 | ✅ **shipped** — cross-repo link consistency now has a shared read model plus `parallax workspace verify`, flagging malformed provenance, stale workspace membership, and orphan `BREAKS_COMPATIBILITY_WITH` rows without duplicate inverse storage. | M | HIGH |
| W3 | **Monorepo sub-packages as first-class catalog members** — the catalog treats each entry as one whole repo; sibling packages inside one monorepo can't be provider/consumer. Parse `package.json` workspaces / `pnpm-workspace.yaml` / `nx`/`turbo` (deterministic, no install) into addressable units; same-repo skip becomes same-package skip. | L | HIGH |
| W4 | **Richer contract property signatures** — `*PropertySignature` carries only a coarse `type`, so enum-narrowing, `format`, `nullable`, required-narrowing are invisible. Capture `enum`/`format`/`nullable`, bump compat schema versions, add classification rules (enum removal = breaking, response field optional = non-breaking). The substance of "nested-schema-level". | M | MED-HIGH |
| W5 | **JSON Schema (and Avro) contract kinds** — contract kinds are hardcoded to four; the OpenAPI object-schema signature is ~90% of a JSON Schema diff already. Add a `json-schema` kind reusing it (one synthetic endpoint per top-level schema); Avro as a mechanical follow-on. | S (JSON Schema) / M (Avro) | MED |
| W6 | ✅ **shipped** — agents can query provider consumers/providers through read-only MCP tools and preview cross-repo resolution without mutating `cross_repo_links`; CLI persistence remains the explicit write workflow. | S | MED |

**Sequencing remaining work:** W4 / W5 (deepen the diff) → W3 (biggest scope, monorepo users). W1/W2/W6 are already shipped.

---

## 5. DX, UI, measurement & docs

Parallax has strong CI *for itself* and a rich UI, but the consumer-facing guardrail story is still
unfinished even after shipping the confidence-aware `--fail-on` primitive. Several newer features
also remain thinly bench-covered.

| # | Opportunity | Effort | Value |
| :-- | :-- | :-- | :-- |
| D1 | **Official GitHub Action + remaining impact-gate surfaces** — ✅ **confidence-aware `--fail-on` shipped** (`parallax analyze --fail-on=<proven\|inferred\|heuristic\|any\|none>` now lets CI fail only when affected dependents meet a threshold). Still open: publish an official `action.yml` that runs init→index→analyze over a PR diff using that primitive, decide whether `--min-affected=N` belongs in the same gate family, and thread the shipped gate into the remaining hook/CI guardrail surfaces. | M | HIGH |
| D2 | **Bench coverage for co-change / traces / cross-repo / contract-diff** — W1-focused cross-repo coverage is ✅ **shipped**: `npm run bench` now includes a deterministic two-repo contract-impact lane that gates `summary.passed` when primary `analyzeDiff` or report graph export loses the expected consumer break. Still open: trend metrics for co-change, trace-ingest promotion, and broader paired v1/v2 contract-diff quality. | M | HIGH |
| D3 | ✅ **shipped** (impact report) — `parallax analyze --json` output now has a published, versioned JSON Schema (`schemas/impact-report.schema.json`, draft 2020-12). The hand-written `ImpactReport` stays authoritative; a zod mirror (`src/report_schema.ts`) generates the artifact, with a compile-time conformance assertion + a `npm run lint` drift guard + a test that validates real `analyze --json` output against the schema. Still open: **bench-report schema** (deferred — `bench/` is outside `tsc` scope and `RetrievalBenchReport` isn't exported; it is an internal artifact, not an external contract). | S | MED-HIGH |
| D4 | **UI export + deep-linkable state** — the workbench is a sharing dead-end: no JSON/CSV/PNG export, URL encodes only `?report&lang`. Add client-side export buttons and encode selected path / filter / preset into the URL. Surgical `ui/client.ts` additions. | S-M | MED-HIGH |
| D5 | ✅ **shipped** — trilingual getting-started tutorials now exist (`docs/getting-started*.md`) with a worked init→index→analyze walkthrough, expected affected output, and MCP / CI / UI next steps. | S | MED |
| D6 | **Pre-commit / pre-push impact-gate installer** — `install-agent` proves the scaffold pattern; add `parallax install-hook` dropping a hook that runs `analyze --changed <staged> --fail-on=<level>` (reuses D1's flag). Shift-left to the commit. | S | MED |

**Sequencing:** D3 → D1 → D6 still maximizes reuse, but the `--fail-on` primitive is already landed; the remaining D1 work is the official Action and wiring that gate into more guardrail surfaces. D2 is independently high-value; D4 is still open while D5 is shipped.

---

## Top cross-dimension picks (highest value-to-effort)

1. **S2** ✅ — single transaction + pragmas shipped: graph/current-state writes now commit after adapter extraction in one explicit transaction.
2. **A5** ✅ — resolution-strength confidence (S, MED-HIGH): cheap honesty win in the TS/JS call lane.
3. **M2 + M6** ✅ — telemetered query responses and shipped workflow prompts make the agent surface coherent; the next agent-surface lift is M4/M5 guidance from real drift/telemetry.
4. **D3 → D1** — report JSON Schema plus the shipped confidence-aware `--fail-on`, then the still-open official Action (S→M, HIGH): the CI-guardrail story.
5. **M1** ✅ — multi-hop + aggregation Cypher (M, HIGH): turns `parallax_query` into the blast-radius primitive.
6. **S1 / S4** — incremental indexing is partially shipped; the remaining structural scale/correctness arc is cheaper unchanged-file handling paired with S4 guardrails.

Larger bets (L) that change the tool's ceiling: **A1** (TS TypeChecker), **A3** (Spring DI/persistence),
**W3** (monorepo), **S1** (incremental). Sequence these after the quick wins land and are bench-guarded.

## Larger-bet reassessment (2026-06-21)

The quick-win layer has largely shipped (A5, M1, M2, M3 + co-change context fold,
M6, D3, S2), and the first S4 perf measurement guardrail now exists via
`bench:perf`. The remaining gap is narrower: D2 feature bench coverage is still
open, and S4 still needs standard large-scale baselines plus peak-RSS capture.
Every larger bet is a structural change to the determinism/honesty core, so
guarding must keep moving first.

Reassessed order across the four L bets:

1. **Lay the guardrail — S4 first, then D2 (prerequisite, not optional).** S1/A1
   both move the indexer's cost and output; without a guard their regressions
   land invisibly. Two evidence-based refinements after re-checking the code:
   - **S4 (perf bench) is partially shipped and remains the higher-value half.**
     `bench:perf` now measures full initial index, no-op incremental index,
     edited-file incremental index, analyze-without-persist, and
     analyze-with-persist phases over a deterministic synthetic repo. Caveat:
     timing/peak-RSS are **inherently non-deterministic**, so S4 remains separate
     from `ImpactBenchReport` (its `tests/impact-bench.test.ts` asserts a
     byte-identical, path-free report across runs). Still open: standard 10k/50k
     scale baselines, peak-RSS capture, and published threshold guidance rather
     than exact millisecond assertions.
   - **D2's marginal value is lower than the catalog implies.** All four
     "thinly benched" features already have unit/integration coverage in the
     verify gate (`trace-promotion-index`, `cross-repo-resolver`,
     `contract-diff`, and co-change across six test files). They are *not*
     unguarded — D2 adds quality-metric *trend* tracking (recall/precision over
     time) on top, which is real but incremental and determinism-delicate
     (co-change needs a git fixture; only counts/recall may reach the report).
2. **S1 — incremental indexing.** Highest structural leverage; prereqs already
   exist (`files.content_hash` + `index_run.extractor_version` columns are
   present — only carry-forward logic is missing). Risk lives in reproducing an
   identical graph for unchanged files and in the second `files` write path.
   De-risk with the shipped S2 transaction guardrail and S4 perf measurements.
   S1 also sets the **cost budget** A1 must later fit inside.
3. **A1 — TS TypeChecker.** Highest accuracy ceiling, but `createProgram` is
   whole-repo and pulls *against* S1's incremental cost model — so it must land
   after S1 establishes the budget and after S4 can catch the perf hit.
4. **W3 — monorepo sub-packages.** Self-contained, deterministic manifest
   parsing (lower risk than S1/A1), broad audience — but only pays off once
   W1/W2 surface cross-repo/cross-package impact in the main report, so do those
   medium items first.
5. **A3 — Spring DI/persistence.** Lowest priority of the four: narrower
   (JVM-only) audience, partially started (regex bean lane already exists), and
   gated on building the offline-parser harness (A2). Pursue only after A2.

Net: **S4 → S1 → A1 → W3 (after W1/W2) → A3 (after A2)**. Pick
one arc at a time — each L bet is its own multi-session effort.

### Measured findings from the S4 perf bench (2026-06-21)

The perf harness paid for itself immediately by killing one bet and pointing at another:

- **S3 is not a win — N+1 query count is ~free here.** Batching the per-node
  traversal query was built, verified byte-identical, and measured **flat** at
  2k files even with a 200-node frontier. In-process SQLite has no per-query
  latency, and local-first is an invariant, so query *count* will never be the
  bottleneck. Reverted. (See the S3 row.)
- **Indexing dominates analyze ~3:1 at 2k files** (≈22 s vs ≈7.5 s). The scale
  lever the numbers endorse is **S1 (incremental indexing)** — its premise
  (re-parse every file every run) is exactly this cost. This is the
  evidence-backed next structural arc.
- **Analyze spends ≈7.5 s for only ~200 affected files** — unexplained and
  **not** traversal (200 trivial indexed lookups + one 2k-row sort cannot cost
  seconds). There is an unprofiled O(repo) hotspot in report-building. Any future
  analyze optimization must **start from a profile, not a guess.**

### S1 design — incremental indexing (decided 2026-06-21, arc opened)

**Goal.** Turn O(repo) indexing into O(changed): carry an unchanged file's
graph rows into the new `index_run_id` cohort, re-extract only changed files.

**Write-path facts** (from a full read of `src/indexer.ts` / `src/store.ts`):
- Reads filter by `index_run_id` (relations, relation_evidence, edges, evidence,
  symbols, files) or `updated_index_run_id` (entities). **Carry-forward = re-stamp
  rows with the new run id**, not leave-in-place — old-cohort rows are invisible.
- Entity/relation/evidence ids are **content-addressed and stable** across runs;
  `files.id`/`symbols.id`/`edges.id` are autoincrement (preserve or re-stamp).
- `files.content_hash` (SHA-256 of content) already exists, used only for
  staleness today — it is the delta gate. `index_runs.extractor_version` exists.
- Non-determinism lives on `index_runs`/`adapter_runs` timestamps, **not** on the
  graph rows dogfood/bench compare.

**Resolution probe (decisive).** Cross-file edges proved to be **file-level,
path-resolved, source-attributed**: renaming a target file's exported symbol
(content-only change, path unchanged) left an importer's edges byte-identical for
both a `const` import (`DEPENDS_ON`) and a function call
(`CALLS [call:foo:3:10]` → `file:leaf.ts`). So an unchanged file's edges depend
on its own content + the **existence (path)** of its targets, not their content.

**Chosen architecture — conservative, provably byte-identical:**
- **Re-extraction closure = changed files only** (no reverse-dependency closure),
  **gated** on: `extractor_version` unchanged **and** the file path set unchanged
  (no adds/deletes/renames). Either condition failing → **full reindex** (safe
  fallback). This captures the dominant loop (editing existing files) and
  sidesteps the whole cross-file-resolution hazard class.
- **Carry-forward mechanism:** `INSERT … SELECT` re-stamping the prior cohort's
  rows with the new `index_run_id` for unchanged files (slice 2). Targets the
  measured cost (skip re-parsing), simpler than an event cache.
- **Co-change** is global/git-derived and cheap → always recompute.
- **Validation backbone = correctness oracle test:** full reindex of an end-state
  must equal incremental-to-that-end-state (graph rows modulo `index_run_id` +
  run timestamps). Stronger than dogfood; it catches any edge type that turns out
  to be target-content-dependent (the residual risk the probe couldn't exhaust).

**Slice plan:** (1) ✅ pure `computeIndexDelta` classifier + oracle scaffold (this
arc-opening). (2) ✅ **SHIPPED** — carry-forward wired into the write path behind
the delta. (3) ✅ **SHIPPED** — perf bench reports full vs no-op incremental vs
edited-file incremental timings, plus analyze no-persist vs persisted timings.

**Slice 2 as shipped (2026-06-21).** `IndexResult.mode` (`'full'|'incremental'`);
`indexProjectInternal` computes the delta, skips re-extraction of unchanged files,
and `carryForwardUnchanged` re-stamps their rows into the new run cohort. Design
correction vs the original note: the graph tables use **content-addressed PKs with
an in-place run-id column**, so carry-forward is `UPDATE … SET run_id` (not
`INSERT…SELECT`), except `entity_versions` (PK includes run id → `INSERT OR IGNORE
… SELECT`). Attribution is **inverted** (bump everything on the prior run EXCEPT
rows owned by a changed file) to keep the param list small and strand a changed
file's vanished rows on the prior run. Wrapped in a SAVEPOINT. Oracle widened to
**7 tables** (entities, entity_versions, relations, relation_evidence, evidence,
edges, symbols) — incremental == full byte-identical, verified. Full `verify`
green (573 tests). **Known harmless divergence:** carried relations keep the prior
run's `adapter_run_id` (unread; no run-deleting GC → no dangling FK) — documented
in code. **Perf (synthetic, single-file edit): ~1.5–2.3× faster re-index** (2k:
21s→14s). The win is the skipped re-parse; it is *understated* by the tiny
synthetic files and *bounded* by the SQLite restamp's index-maintenance cost on
`idx_relations_*` (super-linear). Two follow-on arcs left on the table: skip the
all-files file loop for unchanged files (opens the coverage/`entity_versions`
write surface — deferred), and lighten the restamp by dropping run-id from the
relations indexes (trades against traversal speed).
