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
| A3 | **JVM/Spring parser-based DI / persistence / endpoint links** — bundled tree-sitter-java/kotlin to build the bean graph (constructor + `@Autowired` → `DEPENDS_ON`), JPA repository→entity (`READS`/`WRITES`/`IMPLEMENTS`), and controller route→OpenAPI contract (`IMPLEMENTS`). Today only regex HTTP mappings exist; no DI, no persistence, no contract cross-link. | L | HIGH |
| A4 | **Symbol-level test↔impl linking** — `inferTestTargets` (`multi-language-regex.ts:5406`) emits `VERIFIES` at file granularity only. Resolve the symbols a test body exercises and emit `VERIFIES` to the target *symbol*; direct call → `inferred`, name-only → `heuristic`. Tells a reviewer exactly which tests cover a changed function. | M | HIGH |
| A5 | **Resolution-strength-aware confidence in regex lanes** — all regex-lane `CALLS` collapse to flat `inferred` (`multi-language-regex.ts:436`). Thread a resolution tag: import/intra-repo-resolved → `inferred`, unresolved/ambiguous name → `heuristic`, plus a `metadata.resolution` field. No parser work — pure scoring honesty; prerequisite for trusting regex lanes during migration. | S | MED-HIGH |
| A6 | **Framework routing for Python/Go web frameworks** — zero routing extraction for Flask/Django/FastAPI or gin/echo/net-http (bench ships FastAPI + Go fixtures). Recognize route decorators/registrations → `endpoint` entities + `DECLARES`, cross-linked to contracts. Depends on A2 / a Go parser. | M | MED-HIGH |

**Sequencing:** A5 (cheap honesty) → A1 (raises the ceiling on the reference lane) → A2 (first regex→parser, builds the harness) → A4 → A3 / A6.

---

## 2. Agent surface & MCP

19 read-only-first MCP tools + 9 resources. Recent additions: `parallax_query` (read-only Cypher
subset), CLI `ingest-traces` (write surface, off MCP by I-8). Co-change coupling is computed but not
a first-class agent surface; context-pack telemetry is recorded but nothing acts on it.

| # | Opportunity | Effort | Value |
| :-- | :-- | :-- | :-- |
| M1 | **Multi-hop + aggregation in `parallax_query`** — the Cypher subset is capped at one hop (`graph_query.ts`); blast-radius is exactly the multi-hop traversal agents want. Add bounded variable-length paths `-[r:TYPE*1..N]->` (recursive CTE, depth cap ≤ 8 like `analyze_diff`), `COUNT(...)`+`GROUP BY`, `ORDER BY`. Stays read-only + deterministic. | M | HIGH |
| M2 | **Telemeter + resource-link `parallax_query`** — unlike every sibling, `parallax_query` (`mcp.ts:355-376`) skips `toolJsonResponse`/telemetry and emits no `parallax://entities/{id}` links. Route it through the existing rails so results are navigable and measurable. | S | HIGH |
| M3 | **Expose co-change as an MCP tool + resource** — `co-change.ts` computes `CO_CHANGES` coupling but no dedicated surface exists. Add read-only `parallax_co_change` (ranked coupled files by `couplingScore`) and optionally fold top partners into `context_for_change`. Surfaces couplings the static graph misses. | M | HIGH |
| M4 | **Structured "what-changed-since" tool** — only a human-readable drift warning exists (`analyzer.ts:372`). Add `parallax_changed_since` returning a deterministic delta (entities/relations added/removed, confidence promotions) between two index runs. Lets agents orient incrementally. | M | MED |
| M5 | **Context-budget advisory from telemetry** — `context_tool_runs`/`hit_count` are recorded but unused. Add `parallax_context_advice` computing omitted-vs-returned and expanded-resource ratios → a suggested budget (advisory only, I-9). | M | MED |
| M6 | **MCP prompt(s) teaching the impact workflow** — no prompt surface exists. Register `impact_workflow`/`triage_change` prompts laying out analyze→context→expand-resource→query/co_change/trace→remember. Lowest-effort lever for correct tool use. | S | MED |
| M7 | **Permissioned write surface for trace ingestion (I-8)** — Phase A: read-only `parallax_trace_preview` (dry-run match, returns promoted/unmatched, no write). Phase B: gated `parallax_ingest_traces` behind explicit opt-in. Closes the observe→prove loop while honoring read-only-first. | L | LOW-MED |

**Sequencing:** M2 / M6 / M7-Phase-A (quick wins) → M1 / M3 (core impact value) → M4 / M5 → M7-Phase-B.

---

## 3. Architecture, scale & performance

Indexing is a **full re-index every run** (confirmed: `scanFiles` reads every file; `content_hash`
is stored but used only for staleness warnings). No explicit transaction around the write path.
Analyzer traversal is N+1 per frontier node.

| # | Opportunity | Effort | Value |
| :-- | :-- | :-- | :-- |
| S1 | **Incremental indexing (content-hash-gated)** — load the prior run's `path → content_hash`, carry forward unchanged files' entities/relations/evidence to the new `index_run_id`, re-extract only changed/added/deleted (gate on `extractor_version` for adapter upgrades). Turns O(repo) into O(changed). The single highest-leverage scale change. | L | HIGH |
| S2 | **Single transaction + SQLite pragmas** — no explicit `BEGIN/COMMIT` wraps the write loop; each `stmts.*.run` is its own WAL commit (+FTS triggers). Wrap the loop in one transaction (rollback to the existing restore path on error), add `PRAGMA synchronous=NORMAL`, larger `cache_size`, `mmap_size`. Large constant-factor win, tiny diff. | S | HIGH |
| S3 | **Batch the analyzer's per-node traversal** — `loadCanonicalImpactRows` (`analyzer.ts:448-500`) runs one query per frontier node per depth (up to fanout 2000 × depth 8). Batch each depth into one `WHERE target_entity_id IN (frontier)` query; replace the correlated evidence subquery with a grouped join. Same ordering/semantics, far fewer round-trips. | M | HIGH |
| S4 | **Large-repo perf benchmark + documented limits** — the bench is correctness-only on one fixture. Add a seeded synthetic-repo generator (1k/10k/50k files), time index+analyze and peak RSS, publish limits. Regression-guards S1–S3. | M | MED-HIGH |
| S5 | **Retention / prune superseded index runs (+ VACUUM)** — every run inserts a new cohort; nothing prunes old ones, so the DB grows by a full snapshot per run. Add deterministic retention (keep last N completed) inside a transaction + optional VACUUM. | M | MED |
| S6 | **Committable / shareable index artifact** — define export/import of a compacted single-cohort DB + a `{extractor_version, git_commit_sha, content_hash set}` manifest; on import warn when hashes diverge from the working tree. "Index once in CI, everyone consumes." Depends on S5. | M | MED |

**Sequencing:** S2 (tiny, compounding) → S1 (biggest structural win) with S4 alongside to guard → S3 → S5 → S6. Watch-mode is a thin follow-on to S1.

---

## 4. Workspace, contracts & cross-repo

A cross-repo workspace catalog, provider↔consumer resolver, and OpenAPI/GraphQL/Protobuf/AsyncAPI
breaking-change diff exist. The contract nested-schema *traversal* already exists; the field-level
fidelity and the integration into the primary report are the gaps.

| # | Opportunity | Effort | Value |
| :-- | :-- | :-- | :-- |
| W1 | **Cross-repo contract impact in `analyzeDiff`** — the primary report is workspace-blind; `BREAKS_COMPATIBILITY_WITH` links in `cross_repo_links` are never surfaced. When a changed path matches an indexed contract, join the links and append cross-repo consumers to `affected` (cross-repo lane, `heuristic`/`inferred`). Makes the whole subsystem visible in the main surface. | M | HIGH |
| W2 | **Bidirectional cross-repo link consistency** — links are stored strictly directionally; no reconcile/reverse helper exists, and a stale `BREAKS` link can outlive its `CONSUMES` parent. Add `reconcileCrossRepoLinks` + `parallax workspace verify` (flag orphans, expose `consumersOf`/`providersFor`). Closes roadmap §2 item 4. | M | HIGH |
| W3 | **Monorepo sub-packages as first-class catalog members** — the catalog treats each entry as one whole repo; sibling packages inside one monorepo can't be provider/consumer. Parse `package.json` workspaces / `pnpm-workspace.yaml` / `nx`/`turbo` (deterministic, no install) into addressable units; same-repo skip becomes same-package skip. | L | HIGH |
| W4 | **Richer contract property signatures** — `*PropertySignature` carries only a coarse `type`, so enum-narrowing, `format`, `nullable`, required-narrowing are invisible. Capture `enum`/`format`/`nullable`, bump compat schema versions, add classification rules (enum removal = breaking, response field optional = non-breaking). The substance of "nested-schema-level". | M | MED-HIGH |
| W5 | **JSON Schema (and Avro) contract kinds** — contract kinds are hardcoded to four; the OpenAPI object-schema signature is ~90% of a JSON Schema diff already. Add a `json-schema` kind reusing it (one synthetic endpoint per top-level schema); Avro as a mechanical follow-on. | S (JSON Schema) / M (Avro) | MED |
| W6 | **Cross-repo resolve + reverse-consumer MCP tools** — agents can read pre-computed links but cannot trigger resolution or ask "who consumes provider X". Add read-only `resolve_cross_repo_contracts` and `cross_repo_consumers` (confirm against I-8). | S | MED |

**Sequencing:** W6 (cheap) → W1 / W2 (most user-visible per effort) → W4 / W5 (deepen the diff) → W3 (biggest scope, monorepo users).

---

## 5. DX, UI, measurement & docs

Parallax has strong CI *for itself* and a rich UI, but ships nothing for consumers and leaves four
new features bench-uncovered. The `analyze` exit code is confidence-blind (`cli.ts:202`: `length > 0`).

| # | Opportunity | Effort | Value |
| :-- | :-- | :-- | :-- |
| D1 | **Official GitHub Action + confidence-aware `--fail-on` gate** — add `parallax analyze --fail-on=<proven\|inferred\|heuristic\|any\|none>` (+ `--min-affected=N`) so exit codes encode confidence-weighted impact, then publish an `action.yml` that runs init→index→analyze over a PR diff and fails per `--fail-on`. Turns Parallax into a CI guardrail. | M | HIGH |
| D2 | **Bench coverage for co-change / traces / cross-repo / contract-diff** — four shipped features have zero/thin bench coverage, so regressions are invisible to the gate. Add micro-fixtures (multi-commit co-change, trace-ingest promotion, two-repo cross-repo, paired v1/v2 contract) + metrics into `ImpactBenchReport`. Defends the determinism+honesty core. | M | HIGH |
| D3 | **Published JSON Schema for the impact + bench reports** — `ImpactReport` is a hand-written TS type with no published schema; `analyze --json` consumers reverse-engineer it. Define zod schemas (pattern already in `mcp.ts`) and emit versioned JSON Schema. Prerequisite that makes D1 robust. | S | MED-HIGH |
| D4 | **UI export + deep-linkable state** — the workbench is a sharing dead-end: no JSON/CSV/PNG export, URL encodes only `?report&lang`. Add client-side export buttons and encode selected path / filter / preset into the URL. Surgical `ui/client.ts` additions. | S-M | MED-HIGH |
| D5 | **Getting-started tutorial (trilingual)** — no `docs/getting-started.md`; the README shows commands but no expected output. Add a worked before/after walkthrough with real affected-files output, branching into MCP / CI / UI next steps. | S | MED |
| D6 | **Pre-commit / pre-push impact-gate installer** — `install-agent` proves the scaffold pattern; add `parallax install-hook` dropping a hook that runs `analyze --changed <staged> --fail-on=<level>` (reuses D1's flag). Shift-left to the commit. | S | MED |

**Sequencing:** D3 → D1 → D6 (shared `--fail-on` primitive) maximizes reuse; D2 is independently high-value; D4/D5 amplify adoption.

---

## Top cross-dimension picks (highest value-to-effort)

1. **S2** — single transaction + pragmas (S, HIGH): biggest perf win for the smallest diff.
2. **A5** — resolution-strength confidence (S, MED-HIGH): cheap honesty win across all regex lanes.
3. **M2 + M6** — telemeter `parallax_query` + workflow prompts (S, HIGH/MED): make the agent surface coherent.
4. **D3 → D1** — report JSON Schema then confidence-aware `--fail-on` + Action (S→M, HIGH): the CI-guardrail story.
5. **M1** — multi-hop Cypher (M, HIGH): turns `parallax_query` into the blast-radius primitive.
6. **S1** — incremental indexing (L, HIGH): the structural scale unlock; pair with S4 to guard it.

Larger bets (L) that change the tool's ceiling: **A1** (TS TypeChecker), **A3** (Spring DI/persistence),
**W3** (monorepo), **S1** (incremental). Sequence these after the quick wins land and are bench-guarded.
