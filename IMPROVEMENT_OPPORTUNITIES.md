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
| M8 | ✅ **shipped** — `parallax install-agent --copilot-package --target <repo>` now plans or installs `.github/copilot-instructions.md`, `.github/agents/parallax-impact.agent.md`, and an optional target-repo MCP config snippet. Dry-run reports planned relative paths/actions, existing files are skipped unless `--force` is explicit, and the command never calls GitHub. | S-M | HIGH |
| M9 | ✅ **shipped** — token-budgeted repo map / context card now exists as `parallax repo-map --changed <files> [--query <text>] [--budget <tokens>] [--json]` and read-only MCP `parallax_repo_map`, ranking changed roots, affected files, tests/docs/config/work artifacts, evidence refs, verification actions, resources, confidence, provenance, `knownGaps`, and omitted counts. It reuses `buildContextPack`, `searchContext`, and `parallax://` resources; token use is documented as `Math.ceil(text.length / 4)`. | M | HIGH |
| M10 | ✅ **shipped** — SCIP import/export bridge: `parallax scip import --file <index.scip.json>` ingests JSON from the official SCIP CLI, `parallax scip import --file <index.scip>` shells out to `scip print --json` for binary ingest, and `parallax scip export [--file <index.scip.json>]` emits SCIP-compatible JSON from the latest completed Parallax index. Binary `.scip` protobuf writing is intentionally deferred until JSON export is not enough. | M-L | MED-HIGH |

**Sequencing remaining work:** M4 / M5 → M10 → M7-Phase-A → M7-Phase-B, with M8/M9 now available for dogfooding in PR/dependency workflows. The quick-win prompt/query/repo-map layer (M1/M2/M3/M6/M9) is now in place.

---

## 3. Architecture, scale & performance

Incremental indexing now exists for the unchanged-file carry-forward path, and indexing now commits
the graph/current-state cohort in one explicit crash-atomic transaction after adapter extraction
finishes. Saved/exported artifact immutability is now explicit; `scanFiles` still walks the repo,
and analyzer traversal is N+1 per frontier node.

| # | Opportunity | Effort | Value |
| :-- | :-- | :-- | :-- |
| S1 | **Incremental indexing follow-through (content-hash-gated)** — the core arc is partially shipped: content-hash/extractor-version delta classification, unchanged-file carry-forward into the new `index_run_id`, saved/exported artifact immutability, crash-atomic graph/current-state commits, and `bench:perf` slices for full/no-op incremental/edited-file reindex/analyze phases are all in place. Follow-through slices ✅: incremental runs now replay file-level persistence only for changed files plus contract files, bulk-load file ids once, carry `files.index_run_id` forward in SQL, canonicalize unchanged file `entity_versions`, carry unchanged indexed coverage rows forward, reuse a clean same-HEAD default git index without rescanning or creating a redundant run when all indexed/coverage paths are tracked, no git-ignored scanner targets exist, and files fit default resource limits, skip adapter startup on dirty/non-git no-changed-file reruns after scan proves `delta.changed=[]`, report actual scan phase timings in `bench:perf` for full/no-op/edit index phases, and publish an explicit `fileContentScope` adapter contract. Correctness correction ✅: any changed indexed body uses full extraction because `full-index` startup context can invalidate unchanged owned files and `target-only` content scope does not constrain emitted-row ownership. Before selective reads return, define and enforce a separate output-ownership contract. | L | HIGH |
| S2 | ✅ **shipped** — write-mode SQLite pragmas are in place, and indexing now commits the graph/current-state cohort in one explicit transaction after adapter extraction finishes. A child-process crash regression proves partial files/relations/evidence/transactions from a crashed run do not become current. | S | HIGH |
| S3 | ⛔ **deprioritized — premise refuted by measurement.** The idea was to batch the per-node traversal query (`loadCanonicalImpactRows`) to cut round-trips. Built and verified byte-identical, then `bench:perf` showed it **flat** (2k files: 7545→7475 ms) even on a 200-node frontier: **in-process SQLite has no per-query latency, so N+1 query *count* is ~free** — and local-first is an invariant, so it can never matter. Reverted as premature optimization (KISS/YAGNI). The traversal-semantics characterization test (`tests/analyzer-traversal-batch.test.ts`) was kept as a guard for any future change. | M | ~~HIGH~~ LOW |
| S4 | ✅ **shipped** — large-repo perf benchmark + documented limits: deterministic synthetic-repo generator (`bench/synthetic-repo.ts`, guarded by `tests/synthetic-repo.test.ts`) + `npm run bench:perf` (`bench/impact-perf.ts`) now report full initial index, no-op incremental index, edited-file reindex, analyze-without-persist, analyze-with-persist, and observed peak RSS at scale, isolated from the determinism-locked accuracy bench, with an optional `--max-ms-per-kfile` CI gate. `docs/verification*.md` publishes the current local baseline table for 1k/2k and the measured 10k/50k limit: a 10k full-phase run did not emit a table within about 20 minutes on the baseline host, so 50k was not started. Deterministic `verify` continues to avoid exact timing assertions. | M | MED-HIGH |
| S7 | ✅ **shipped** — saved report graph exports now treat persisted report JSON as the immutable graph snapshot source. Canonical graph rows remain only a legacy fallback when a persisted report lacks relation-bearing evidence, so later index cohorts, carry-forward, retention, repair, or canonical row mutation do not rewrite modern saved artifacts. | M | HIGH |
| S5 | **Retention / prune superseded index runs (+ VACUUM)** — every run inserts a new cohort; nothing prunes old ones, so the DB grows by a full snapshot per run. Add deterministic retention (keep last N completed) inside a transaction + optional VACUUM. | M | MED |
| S6 | **Committable / shareable index artifact** — define export/import of a compacted single-cohort DB + a `{extractor_version, git_commit_sha, content_hash set}` manifest; on import warn when hashes diverge from the working tree. "Index once in CI, everyone consumes." Depends on S5. | M | MED |

**Sequencing:** W3 monorepo package modeling → S5/S6 storage/shareability. Residual S1 scan-cost work now uses the measured scan timings plus the `fileContentScope` contract before any cached-content shortcut.

---

## 4. Workspace, contracts & cross-repo

A cross-repo workspace catalog, provider↔consumer resolver, and OpenAPI/GraphQL/Protobuf/AsyncAPI/JSON Schema/Avro
breaking-change diff exist. W1/W2/W3/W4/W5/W6 first slices are shipped; deeper
contract fidelity remains follow-on work.

| # | Opportunity | Effort | Value |
| :-- | :-- | :-- | :-- |
| W1 | ✅ **shipped** — W1 shipped: primary `analyzeDiff` reports now include persisted workspace `BREAKS_COMPATIBILITY_WITH` consumers as `crossRepoImpacts`, affected external entities, relation-bearing evidence, graph edges, and UI cross-repo lane entries. | M | HIGH |
| W2 | ✅ **shipped** — cross-repo link consistency now has a shared read model plus `parallax workspace verify`, flagging malformed provenance, stale workspace membership, and orphan `BREAKS_COMPATIBILITY_WITH` rows without duplicate inverse storage. | M | HIGH |
| W3 | ✅ **shipped** — explicit package-directory catalog members can share the nearest parent Parallax index, provider/consumer paths are scoped to the package, and persisted consumer/provider queries stay member-aware. `parallax workspace discover-packages` now parses `package.json` workspaces, `pnpm-workspace.yaml` package globs, and Nx `project.json` / `package.json` `nx` project config into package/project directory catalog members without installs or package-manager/Nx/Turbo execution. Turborepo package membership remains covered through package-manager workspace manifests; `turbo.json` task config is not treated as a catalog source. | L | HIGH |
| W4 | ✅ **shipped** — richer OpenAPI contract property signatures: response enum-value removal, response format changes, response nullable additions, request enum-value removal, request format additions/changes, and response optional-property removals are now captured via richer property signatures, compat schemaVersion 5 where needed, provenance on breaking changes, non-breaking optional-removal visibility, and `contractDiffQuality` bench cases. | M | MED-HIGH |
| W5 | ✅ **first slices shipped** — `*.schema.json` / contract-located `schema.json` files persist as `json-schema` contracts, `.avsc` files persist as `avro` contracts, both reuse the produced object-schema comparison lane, and both declare synthetic root endpoints (`SCHEMA #` / `AVRO #`). JSON Schema covers root-object required removal, optional removal, property type changes, and nullable additions; Avro covers top-level record required/defaulted field removals, field type changes, and nullable additions. Follow-ons: JSON Schema enum/format policy plus full Avro nested/named type resolution, aliases, promotions, and schema-registry integration. | M | MED |
| W6 | ✅ **shipped** — agents can query provider consumers/providers through read-only MCP tools and preview cross-repo resolution without mutating `cross_repo_links`; CLI persistence remains the explicit write workflow. | S | MED |

**Sequencing remaining work:** residual S1 scan-cost work using the measured `fileContentScope` contract → deeper JSON Schema / Avro compatibility semantics. W1/W2/W3/W4/W5/W6 first slices are already shipped.

---

## 5. DX, UI, measurement & docs

Parallax has strong CI *for itself* and a rich UI, but the consumer-facing guardrail story is still
unfinished even after shipping the confidence-aware `--fail-on` primitive. Several newer features
also remain thinly bench-covered.

| # | Opportunity | Effort | Value |
| :-- | :-- | :-- | :-- |
| D1 | ✅ **shipped** — Official GitHub Action + PR wrapper now runs `parallax init`, `parallax index`, and `parallax pr triage`; supports `changed` or `base`/`head` diff discovery; writes SARIF; appends a GitHub step summary; keeps SARIF upload explicit via `github/codeql-action/upload-sarif`; and honors confidence-aware `fail-on`. Remaining impact-gate surface work is now tracked by D6 / hook installation and the separate `--min-affected=N` decision. | M | HIGH |
| D2 | ✅ **shipped** — Bench coverage for co-change / traces / cross-repo / contract-diff: `npm run bench` now includes deterministic quality lanes for W1 cross-repo contract impact (`crossRepoContracts`), contract-diff detection (`contractDiffQuality`), git-history co-change impact (`coChangeQuality`), and runtime trace promotion (`tracePromotionQuality`). `bench:report` shows metric/count deltas for each lane in Markdown and GitHub Step Summary output. | M | HIGH |
| D3 | ✅ **shipped** (impact report) — `parallax analyze --json` output now has a published, versioned JSON Schema (`schemas/impact-report.schema.json`, draft 2020-12). The hand-written `ImpactReport` stays authoritative; a zod mirror (`src/report_schema.ts`) generates the artifact, with a compile-time conformance assertion + a `npm run lint` drift guard + a test that validates real `analyze --json` output against the schema. Still open: **bench-report schema** (deferred — `bench/` is outside `tsc` scope and `RetrievalBenchReport` isn't exported; it is an internal artifact, not an external contract). | S | MED-HIGH |
| D4 | ✅ **shipped** — UI export + deep-linkable state preserves selected impact path, filter text, and report-delta policy preset in the workbench URL. Native sibling controls avoid nested interactions; Back/Forward restores state; focus contrast and reduced motion are explicit; empty maps fail instead of reporting a successful PNG export. The toolbar exports JSON, affected-path CSV, and PNG maps with SVG fallback using browser-native APIs only. | S-M | MED-HIGH |
| D5 | ✅ **shipped** — trilingual getting-started tutorials now exist (`docs/getting-started*.md`) with a worked init→index→analyze walkthrough, expected affected output, and MCP / CI / UI next steps. | S | MED |
| D6 | ✅ **shipped** — `parallax install-hook` plans or installs managed `pre-commit` / `pre-push` impact gates. It writes executable hooks into the active Git hooks directory, respects `core.hooksPath`, skips existing non-Parallax hooks unless `--force` is supplied, supports `--dry-run`, uses `--fail-on`, and allows intentional bypass with `PARALLAX_SKIP_HOOK=1` or Git's `--no-verify`. | S | MED |
| D7 | ✅ **shipped** — SARIF / GitHub Code Scanning export now projects `ImpactReport` via `parallax analyze --sarif-output <path> [--sarif-category <category>]`, with affected-file findings, index coverage-gap warnings, cross-repo contract-break warnings, recommended verification-action notes, adapter `knownGaps`, evidence locations, relation paths, confidence rules, stable fingerprints, and docs for Code Scanning upload. | M | HIGH |
| D8 | ✅ **shipped** — local dependency/PR dogfood lane exists as `parallax pr triage`. It accepts `--changed` or `--base/--head`, persists the impact report, writes SARIF (default `.parallax/pr-triage.sarif`), applies `--fail-on`, and prints a dependency-focused repo map without calling GitHub or changing remote state. The open Dependabot queue was refreshed on 2026-06-27 (#23-#31) as the first real dogfood target. | S | MED-HIGH |
| D9 | ✅ **shipped** — affected verification planner: `parallax repo-map` / MCP `parallax_repo_map` now include `verificationPlan`, grouping existing `ImpactReport.actions` by nearest `package.json` package root and runner into ranked, copy-pasteable commands with covered changed / affected / target paths, confidence, source actions, and omitted counts. It stays deterministic and does not execute Nx, Bazel, or other external build tools. | M | HIGH |

**Sequencing:** return to the residual S1 scan-cost work using the measured `fileContentScope` contract. The D2 trend metrics, `--fail-on` primitive, broad SARIF projection, repo-map, affected verification planner, local PR triage wrapper, official PR action wrapper, local Git hook installer, shareable UI/export surface, M10 SCIP bridge, W3 monorepo package discovery, and W5 JSON Schema / Avro first slices are landed.

---

## Top cross-dimension picks (highest value-to-effort)

1. **D7 → D1** — SARIF export plus the official GitHub Action (M, HIGH): turns Parallax from a local report into native PR/code-scanning feedback.
2. **M8 + M9** ✅ — GitHub-native agent package and token-budgeted repo map/context card (S-M→M, HIGH): makes Parallax discoverable and useful inside Copilot / Claude / Cursor workflows.
3. **D4** — UI export + deep-linkable state (S-M, MED-HIGH): lets a PR reviewer share the exact selected impact path, evidence, and policy preset.
4. **S2** ✅ — single transaction + pragmas shipped: graph/current-state writes now commit after adapter extraction in one explicit transaction.
5. **A5** ✅ — resolution-strength confidence (S, MED-HIGH): cheap honesty win in the TS/JS call lane.
6. **S1 / S4** — incremental indexing is partially shipped; the remaining structural scale/correctness arc is cheaper unchanged-file handling paired with S4 guardrails.

Larger bets (L) that change the tool's ceiling: **A1** (TS TypeChecker), **A3** (Spring DI/persistence),
**W3** (monorepo), **S1** (incremental). Sequence these after the quick wins land and are bench-guarded.

## Ecosystem reassessment (2026-06-27)

The web/GitHub review changes the short-term adoption order without invalidating the core-engine order above. The durable product thesis is still local-first impact intelligence, but the highest-friction gap is now **where the result appears**: coding agents and reviewers live in Copilot / Claude / Cursor, GitHub PRs, Code Scanning, and compact repo-map context windows.

### Sources checked

- GitHub Copilot repository instructions: <https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions>
- GitHub Copilot custom agents: <https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/create-custom-agents>
- GitHub Agentic Workflows: <https://github.com/github/gh-aw>
- GitHub SARIF upload: <https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/upload-sarif-file>
- GitHub SARIF support: <https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support>
- Sourcegraph MCP: <https://sourcegraph.com/mcp>
- SCIP: <https://github.com/scip-code/scip>
- SCIP protobuf schema: <https://github.com/scip-code/scip/blob/main/scip.proto>
- SCIP CLI reference: <https://github.com/scip-code/scip/blob/main/docs/CLI.md>
- scip-typescript indexer: <https://github.com/sourcegraph/scip-typescript>
- Nx affected commands: <https://nx.dev/ci/features/affected>
- Bazel query guide: <https://bazel.build/query/guide>
- Aider repo map: <https://aider.chat/docs/repomap.html>
- Repomix: <https://github.com/yamadashy/repomix>
- CodeGraphContext: <https://github.com/CodeGraphContext/CodeGraphContext>
- code-review-graph: <https://github.com/tirth8205/code-review-graph>
- agentmap: <https://github.com/raymondchins/agentmap>
- Semgrep MCP: <https://github.com/semgrep/mcp>
- OpenRewrite docs: <https://docs.openrewrite.org/>
- Git hooks documentation: <https://git-scm.com/docs/githooks>
- Git `core.hooksPath`: <https://git-scm.com/docs/git-config#Documentation/git-config.txt-corehooksPath>
- pre-commit: <https://pre-commit.com/>
- Lefthook: <https://lefthook.dev/>
- Husky: <https://typicode.github.io/husky/>
- MDN URLSearchParams: <https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams>
- MDN History.replaceState: <https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState>
- MDN Blob / object URLs: <https://developer.mozilla.org/en-US/docs/Web/API/Blob>
- Parallax dependency PR queue, refreshed 2026-06-28: <https://github.com/YouSangSon/Parallax/pulls?q=is%3Apr+is%3Aopen+dependabot>
- Parallax open issues, refreshed 2026-06-28: <https://github.com/YouSangSon/Parallax/issues?q=is%3Aissue+is%3Aopen>

### What the search implies

1. **GitHub-native output is the strongest next adoption slice.** GitHub supports repository instructions for Copilot and SARIF upload for third-party tools, so Parallax should emit both an agent setup package and a code-scanning artifact. This is D7 → D1 → M8.
2. **Repo-map output is now table stakes for agent UX.** Aider, Sourcegraph, Repomix, CodeGraphContext, code-review-graph, and agentmap all frame success as ranked, compact, tool-call-efficient code context. Parallax now has the named repo-map/context-card command and MCP surface from M9; the next work is dogfooding and tuning it against real PR workflows.
3. **SCIP is the standards bridge for precision.** It is a practical path to cross-language definitions/references before Parallax owns parser-grade precision for every language. M10 now has JSON import, CLI-backed binary ingest, and JSON export.
4. **Security and codemod systems should be integrations first.** Semgrep and OpenRewrite are mature in their own lanes. Parallax should recommend and scope scans/refactors based on affected files and evidence, not rebuild those engines.
5. **Current repo state gives an immediate dogfood target.** As of 2026-06-28, open Dependabot PRs #23-#31 are still available: GitHub Actions major bumps (#23-#28), `@types/node` (#29), TypeScript 6 (#30), and Zod (#31); issue #3 remains the only open non-Dependabot follow-up. This makes dependency-impact triage a useful real workflow: analyze the bump, emit SARIF/Markdown, provide repo-map context, and show verification actions.
6. **Agentic workflow safety reinforces Parallax's I-8 boundary.** GitHub Agentic Workflows emphasizes read-only defaults, guarded writes, sandboxing, and approval gates. Parallax should keep PR/action automation read-only by default, with explicit opt-in for any write surface.
7. **Hook adoption should stay dependency-free.** Git, pre-commit, Lefthook, and Husky all converge on explicit local installation and skippable hooks, but Parallax can satisfy D6 with Git's native hook directory and `core.hooksPath` instead of adding a framework dependency.
8. ✅ **Affected target planning is now covered at repo-map level.** Nx and Bazel both frame scale around selecting the tasks/targets impacted by a change. Parallax now groups its existing recommended actions into deterministic verification-plan commands with affected-path coverage, while intentionally avoiding external target discovery.

### Reprioritized adoption lane

1. ✅ **M9 hardening / dogfood** — repo-map human and MCP output expose query matches, resource URIs, provenance, omissions, and verification actions clearly.
2. ✅ **D8 dependency PR dogfood lane** — `parallax pr triage` now supports PR diff → `analyze` / SARIF → repo-map → verification planning for the live Dependabot queue (#23-#31).
3. ✅ **D7 SARIF breadth** — Code Scanning projection now covers affected files, coverage gaps, contract breaks, verification actions, and adapter known gaps.
4. ✅ **D1 official PR wrapper** — run init → index → PR diff discovery → triage, write SARIF, append Markdown summary, and support `fail-on` while keeping upload explicit.
5. ✅ **D6 local Git hook installer** — shift the same impact gate left into opt-in `pre-commit` / `pre-push` without adding a hook framework dependency.
6. ✅ **D4 deep-linkable UI/export** — humans can share the selected impact path/filter/preset and export the same workbench view as JSON/CSV/map image.
7. ✅ **M10 SCIP bridge** — JSON import, CLI-backed binary ingest, and JSON export shipped; binary protobuf writing stays deferred until JSON is insufficient.
8. ✅ **D9 affected verification planner** — repo-map and MCP output now rank verification command groups by package root/runner and show what impact paths each command covers.

## Monorepo / workspace reassessment (2026-06-28)

The latest web/GitHub pass reinforces W3 as the next product-fit gap rather
than introducing a higher-priority new lane. Modern monorepo tools model impact
around packages/projects, while Parallax's workspace catalog still models only
whole repo roots.

### Sources checked

- npm workspaces: <https://docs.npmjs.com/cli/using-npm/workspaces/>
- pnpm workspace manifest: <https://pnpm.io/pnpm-workspace_yaml>
- Nx affected commands: <https://nx.dev/docs/features/ci-features/affected>
- Turborepo filters: <https://turbo.build/repo/docs/crafting-your-repository/running-tasks>
- GitHub semantic-code-graph / repo-map search examples:
  <https://github.com/VirtusLab/scg-cli>,
  <https://github.com/LordCasser/atlas>,
  <https://github.com/suatkocar/codegraph>,
  <https://github.com/iamsaquib8/tessera>,
  <https://github.com/khalomsky/syke>,
  <https://github.com/Ataraxy-Labs/sem>,
  <https://github.com/raymondchins/agentmap>,
  <https://github.com/Congmoow/RepoMapper>
- Parallax open issue queue refreshed 2026-06-28:
  <https://github.com/YouSangSon/Parallax/issues/3>
- Parallax open PR queue refreshed 2026-06-28:
  <https://github.com/YouSangSon/Parallax/pulls?q=is%3Apr+is%3Aopen+dependabot>

### What the search implies

1. ✅ **W3 npm/pnpm package discovery is now covered.** npm and pnpm expose
   deterministic workspace membership through manifest fields/globs, and
   Parallax now discovers addressable package units without `npm install`,
   `pnpm install`, or tool daemons.
2. **Affected-task tools validate the package/project graph shape.** Nx
   computes affected projects from Git changes plus the project graph, and
   Turborepo filters by package, directory, dependents/dependencies, and Git
   ranges. Parallax already has change and relation graphs; the missing piece is
   mapping files/contracts to a package-scoped workspace member.
3. **Remaining monorepo work should preserve the local-first boundary.** Treat
   Nx/Turbo as metadata sources only when their config is parseable; do not
   execute external CLIs, use remote caches, or depend on daemons.
4. **The resolver needs member identity, not just repo identity.** Current
   cross-repo resolution skips when `repoPath` is equal, and
   `workspace_repos` is unique on `(workspace_id, local_path)`. Same-monorepo
   sibling packages need a stable member key such as
   `(repo_root, package_path/service_name)` so same-repo skip can become
   same-package skip.
5. **Do not pivot to generic semantic-code-graph parity.** GitHub search shows
   several small/local code graph + MCP projects, but Parallax's differentiated
   lane is contract-aware impact, CI/SARIF/repo-map integration, and read-only
   agent workflows. W3 makes that lane work for a common repo topology.

## Monorepo / workspace refresh (2026-06-29)

The latest official-doc and GitHub pass closes the useful W3 catalog slice.
Nx has parseable project config (`project.json` and `package.json` `nx`
configuration) that can identify package/project member directories without
running Nx. Turborepo package membership is still defined through the package
manager workspace manifests; `turbo.json` describes task behavior, not an
additional catalog membership source.

### Sources checked

- Nx project configuration:
  <https://nx.dev/docs/reference/project-configuration>
- Nx affected / project graph behavior:
  <https://nx.dev/docs/features/ci-features/affected>
- Turborepo repository structure / workspace packages:
  <https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository>
- Turborepo run filtering:
  <https://turborepo.dev/docs/reference/run>
- Parallax open issue queue refreshed 2026-06-29:
  <https://github.com/YouSangSon/Parallax/issues/3>
- Parallax open PR queue refreshed 2026-06-29:
  <https://github.com/YouSangSon/Parallax/pulls?q=is%3Apr+is%3Aopen+dependabot>
- GitHub semantic-code-graph / MCP search examples refreshed 2026-06-29:
  <https://github.com/VirtusLab/scg-cli>,
  <https://github.com/LordCasser/atlas>,
  <https://github.com/suatkocar/codegraph>,
  <https://github.com/iamsaquib8/tessera>

### What changed

1. ✅ **W3 Nx project config discovery is covered.** `workspace
   discover-packages` now reads `nx.json` and, when present, discovers
   `project.json` directories plus `package.json` files with an `nx` project
   config as package/project catalog members.
2. ✅ **No Turbo-specific catalog parser is justified yet.** Turborepo package
   membership comes from npm/pnpm/Yarn/Bun workspace manifests, while
   `turbo.json` is task/caching/filter configuration. Parallax already covers
   the relevant package membership path through package-manager manifests and
   should not treat task config as workspace catalog state.
3. ✅ **W5 Avro first slice is covered.** `.avsc` files now participate in
   contract indexing and top-level record compatibility diffs. The next
   highest-value default returns to residual S1 scan-cost reduction, while
   deeper JSON Schema / Avro compatibility semantics stay as follow-ons.

## Larger-bet reassessment (2026-06-21)

The quick-win layer has largely shipped (A5, M1, M2, M3 + co-change context fold,
M6, D3, S2), and the first S4 perf measurement guardrail now exists via
`bench:perf`. The remaining gap is narrower: D2 feature bench coverage is now
tracked for cross-repo, contract-diff, co-change, and trace-promotion quality.
S4 now has published local limits rather
than green 10k/50k timing.
Every larger bet is a structural change to the determinism/honesty core, so
guarding must keep moving first.

Reassessed order across the four L bets:

1. **Lay the guardrail — S4 first, then D2 (prerequisite, not optional).** S1/A1
   both move the indexer's cost and output; without a guard their regressions
   land invisibly. Two evidence-based refinements after re-checking the code:
   - **S4 (perf bench) is shipped as a measurement guardrail.**
     `bench:perf` now measures full initial index, no-op incremental index,
     edited-file reindex, analyze-without-persist, and
     analyze-with-persist phases over a deterministic synthetic repo. Caveat:
     timing/peak-RSS are **inherently non-deterministic**, so S4 remains separate
     from `ImpactBenchReport` (its `tests/impact-bench.test.ts` asserts a
     byte-identical, path-free report across runs). Current perf output includes
     `observed_peak_rss_mb`, sampled at phase boundaries, and
     `docs/verification*.md` publishes the local 1k/2k baseline plus the
     measured 10k/50k limit: 10k did not emit a table within about 20 minutes on
     the baseline host, so 50k was not started.
   - **D2's marginal value is lower than the catalog implies.** All four
     "thinly benched" features already have unit/integration coverage in the
     verify gate (`trace-promotion-index`, `cross-repo-resolver`,
     `contract-diff`, and co-change across six test files). They are *not*
     unguarded — D2 adds quality-metric *trend* tracking on top, which is real
     but incremental and determinism-delicate. Contract-diff now has a
     deterministic `contractDiffQuality` lane, co-change now has a deterministic
     `coChangeQuality` git-history lane, and trace-ingest now has a deterministic
     `tracePromotionQuality` promotion-count lane.
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

**Resolution probe (superseded 2026-08-31).** The original probe changed a target
symbol but did not exercise adapter startup context. A stronger oracle changed
only `tsconfig.json` path aliases and disproved the conclusion: the incremental
graph retained `src/app.ts -> src/session.ts`, while a fresh index produced
`src/app.ts -> other/session.ts`. A second custom-adapter oracle showed that
`target-only` constrains reads, not row ownership: processing changed `a.ts` may
legitimately emit a relation sourced from unchanged `b.ts`.

**Revised architecture — conservative, provably byte-identical:**
- Any changed indexed body promotes the effective run to the existing full
  extraction/persistence path.
- No-change incremental runs still skip adapter startup and carry the complete
  prior cohort forward.
- The indexer orchestration semantics are part of `extractor_version`, forcing a
  one-time rebuild instead of reusing a pre-fix completed cohort.
- Changed-only extraction remains deferred until emitted-row ownership is a
  separate, enforced contract with its own persistence oracle.
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
edited-file reindex timings, plus analyze no-persist vs persisted timings.
(4) **ACTIVE CORRECTION** — changed-body runs use full extraction; alias-context
and foreign-source-row oracles must both equal the safe final graph.

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

The historical edited-file speedup above applies only to the superseded
changed-only policy. Under the corrected policy, full-index synthetic edits take
the full path by design; only zero-change cohorts remain incremental.
