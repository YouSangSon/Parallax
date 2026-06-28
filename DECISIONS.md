# Decisions

## 2026-06-27: Keep Repo Map Fix Narrow

Decision: finish M9 by fixing the two concrete review findings instead of
expanding the repo-map schema or adding a new presentation layer.

Why:
- The data already exists in `searchContext`, `buildContextPack`, and
  `parallax://` resources.
- The missing behavior was projection only: omitted query counts and visible
  human CLI context.
- A small test-backed fix preserves the local-first, read-only agent surface.

## 2026-06-27: Adoption Order

Decision: prioritize M9 hardening, then D8 dependency PR dogfood, then D7 SARIF
breadth.

Why:
- External research showed repo maps and compact codebase context are now table
  stakes for agent UX.
- The live Dependabot PR queue gives an immediate real workflow.
- SARIF breadth should follow a proven PR triage flow instead of guessing at
  output shape.

## 2026-06-27: Dependency PR Triage Surface

Decision: add `parallax pr triage` as a thin local CLI wrapper instead of a
GitHub-integrated PR bot or action.

Why:
- D8 needs a real dogfood workflow, but `analyze`, SARIF, `--fail-on`, and
  `repo-map` already exist.
- A wrapper gives agents and maintainers one repeatable command without adding
  a network dependency or a write-capable GitHub surface.
- Uploading SARIF, checking out PR branches, commenting, merging, and pushing
  stay explicit external actions.

## 2026-06-27: SARIF Verification Actions

Decision: emit recommended verification actions as SARIF `note` results under a
separate `parallax.verification` rule.

Why:
- `ImpactReport.actions` already has target paths and command metadata, so this
  broadens Code Scanning output without adding new analysis.
- Notes keep test/review commands visible without treating them as impact
  warnings.
- Contract breaks, adapter known gaps, and coverage gaps needed more careful
  location mapping, so they were left for later D7 slices.

## 2026-06-27: SARIF Adapter Known Gaps

Decision: emit adapter `knownGaps` as SARIF `note` results under a separate
`parallax.adapter-known-gap` rule, anchored to the changed files in the report.

Why:
- `ImpactReport.adapterInsights` already carries adapter confidence and known
  gaps, so this broadens Code Scanning output without changing report JSON.
- GitHub-facing SARIF results need file locations to be useful, while adapter
  known gaps are run-scoped. Anchoring them to changed files makes the trust
  warning visible without pretending it is a defect in a specific affected file.
- If a report has no uploadable changed-file anchor, Parallax omits the note and
  records the omitted count in SARIF run properties.
- Contract breaks and coverage gaps were handled as separate later D7 slices
  because they needed more precise path mapping.

## 2026-06-27: SARIF Contract Breaks

Decision: emit `crossRepoImpacts` as SARIF results under a separate
`parallax.contract-break` rule, anchored to the provider contract path.

Why:
- `crossRepoImpacts` already carries the provider contract, consumer service,
  consumer path, breaking change, confidence, and workspace resources.
- The consumer path is relative to the consumer repository, not necessarily the
  repository receiving the SARIF upload. Keeping it in result properties avoids
  misleading GitHub artifact locations.
- The provider contract is the changed file in the current repo, so it is the
  safest Code Scanning anchor for making the break visible in PR review.
- If the provider contract path is not uploadable as a repo-relative path,
  Parallax omits the result and records the omitted count in SARIF run
  properties.

## 2026-06-27: SARIF Coverage Gaps

Decision: emit changed files whose impact state is `changed file not in index`
as SARIF `warning` results under `parallax.coverage-gap`.

Why:
- The existing affected-file projection already shows the path as an `unknown`
  impact, but coverage gaps are a trust problem with the analysis itself.
- Anchoring the warning to the changed file makes the missing-index condition
  visible in Code Scanning without adding new report JSON fields.
- The result is derived only when the changed file and affected file agree on
  the same path and the affected reason is the analyzer's existing
  `changed file not in index` state.
- If the changed path is not uploadable as a repo-relative path, Parallax omits
  the result and records the omitted count in SARIF run properties.

## 2026-06-27: PR Action Wrapper

Decision: turn the composite action into a local PR triage wrapper that runs
`parallax init`, `parallax index`, and `parallax pr triage`, while keeping SARIF
upload as an explicit workflow step.

Why:
- The action should remove the repetitive PR shell glue around init, indexing,
  diff discovery, SARIF generation, and the human triage summary.
- Supporting both `changed` and `base`/`head` keeps local changed-file workflows
  and normal pull-request workflows on the same wrapper.
- Uploading SARIF requires `security-events: write`; keeping upload outside the
  action preserves the project's read-only-by-default boundary.
- Appending `$GITHUB_STEP_SUMMARY` gives reviewers the repo-map/triage summary
  even before they open Code Scanning.

## 2026-06-27: Local Git Hook Installer

Decision: add `parallax install-hook` as a dependency-free local installer for
managed `pre-commit` and `pre-push` hooks instead of adopting Husky, Lefthook,
or pre-commit as a runtime dependency.

Sources:
- Git hook execution model: <https://git-scm.com/docs/githooks>
- Git `core.hooksPath`: <https://git-scm.com/docs/git-config#Documentation/git-config.txt-corehooksPath>
- Hook-framework ecosystem checked: <https://pre-commit.com/>,
  <https://lefthook.dev/>, <https://typicode.github.io/husky/>

Why:
- Git already provides executable hook files and `core.hooksPath`, so Parallax
  can shift impact gating left without increasing install cost.
- The installer follows the existing `install-agent` scaffold pattern: a pure
  plan, a thin write layer, `--dry-run`, and explicit `--force`.
- Existing non-Parallax hooks are user-owned and are skipped by default.
- `pre-commit` should gate staged paths, while `pre-push` should prefer Git's
  pushed ref input and only fall back to configured or conventional bases.
- Local hooks remain intentionally bypassable with Git's `--no-verify` or
  `PARALLAX_SKIP_HOOK=1`; CI and GitHub Code Scanning remain the authoritative
  shared review surfaces.

## 2026-06-28: UI Deep Links And Exports

Decision: implement D4 with browser-native state and download APIs inside the
existing static UI instead of adding a router, client framework, or export
service.

Sources:
- URL state: <https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams>
- History update: <https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState>
- Local export payloads: <https://developer.mozilla.org/en-US/docs/Web/API/Blob>

Why:
- The workbench already renders all selected report data into the bootstrap
  JSON, so JSON/CSV export can be client-only.
- `URLSearchParams` plus `history.replaceState` is enough to preserve selected
  impact path, filter text, and policy preset in shareable URLs.
- A PNG map export can use the existing SVG, `Blob`, object URLs, and canvas,
  with SVG fallback when rasterization is unavailable.
- No new dependency or server-side export path is needed.

## 2026-06-28: SCIP Import First

Decision: start M10 with dependency-free SCIP import. `parallax scip import
--file <index.scip.json>` consumes JSON from the official SCIP CLI, while
`parallax scip import --file <index.scip>` shells out to `scip print --json`
and then reuses the same importer. Both paths augment the latest completed
Parallax index run instead of adding a protobuf runtime or replacing Parallax
indexing with a SCIP-only run.

Sources:
- SCIP project and indexer list: <https://github.com/scip-code/scip>
- SCIP protobuf schema: <https://github.com/scip-code/scip/blob/main/scip.proto>
- SCIP CLI JSON printer: <https://github.com/scip-code/scip/blob/main/docs/CLI.md>
- SCIP development docs show path-based `scip print` inspection:
  <https://github.com/scip-code/scip/blob/main/docs/Development.md>

Why:
- The official `scip print --json` path gives Parallax a stable first ingest
  lane without adding protobuf codegen or a new runtime dependency.
- Binary ingest should rely on the official CLI rather than local protobuf
  bindings until export or streaming needs justify a stronger dependency.
- Augmenting the latest completed index preserves existing Parallax adapter
  output; creating a separate SCIP-only index run would hide non-SCIP graph
  rows from `analyze`.
- File-level `REFERENCES` edges let existing reverse impact traversal surface
  files that reference a changed definition file immediately.
- Parallax-to-SCIP JSON export remains scoped as follow-up M10 work; binary
  protobuf writing is a separate later decision.

## 2026-06-28: SCIP JSON Export Before Binary Writer

Decision: complete the M10 bridge with `parallax scip export
[--file <index.scip.json>]`, emitting SCIP-compatible JSON from the latest
completed Parallax index. Do not add protobuf codegen or a binary `.scip`
writer yet.

Sources:
- SCIP protobuf schema: <https://github.com/scip-code/scip/blob/main/scip.proto>
- SCIP CLI JSON printer: <https://github.com/scip-code/scip/blob/main/docs/CLI.md>

Why:
- The import path already treats official SCIP JSON as the stable interchange
  surface, so exporting that shape closes the bridge without a new dependency.
- Parallax stores file/symbol rows plus relation evidence spans; those map
  directly to SCIP `Document`, `SymbolInformation`, and `Occurrence` JSON.
- Binary `.scip` writing requires owning protobuf serialization and should wait
  until JSON export is measurably insufficient.

## 2026-06-28: Observed Peak RSS For Perf Bench

Decision: keep S4 memory reporting inside `bench:perf` as
`observed_peak_rss_mb`, sampled at phase boundaries with Node's built-in RSS
reading. Do not add a sampler, child-process harness, or dependency for exact
allocator tracing yet.

Sources:
- Node.js `process.memoryUsage.rss()`:
  <https://nodejs.org/api/process.html#processmemoryusagerss>

Why:
- S4 needs a trend signal for large-repo memory growth, not a deterministic CI
  contract.
- Phase-boundary RSS is cheap, portable, and enough to catch obvious scale
  regressions alongside the existing timing columns.
- A true peak sampler would add process orchestration and nondeterministic noise
  before there is a concrete memory regression to chase.

## 2026-06-28: Document Perf Baseline Command, Not A New Flag

Decision: use the existing `npm run bench:perf -- --scales 10000,50000`
command as the standard large-repo baseline path instead of adding a `--standard`
or `--large` flag.

Why:
- `bench:perf` already accepts arbitrary scales, so a new flag would duplicate
  an existing path.
- The value is comparable run guidance: command, commit, Node version, OS /
  hardware class, and full output table.
- Exact timing and RSS stay outside `npm run verify`; `--max-ms-per-kfile`
  should be applied only after a project has a real baseline.

## 2026-06-28: Narrow Incremental File Replay Before Scan Changes

Decision: in incremental runs, replay file-level persistence only for changed
files plus contract files; carry unchanged `files.index_run_id` forward in SQL;
bulk-load file ids once; and canonicalize unchanged file `entity_versions` in
SQL after changed-file events.

Why:
- The adapter extraction path already skips unchanged non-contract files, but
  the persistence path still replayed every file row and re-selected every file
  id.
- Contract files still need per-run contract descriptors / versions, so they
  remain in the replay set until a contract-specific carry-forward path exists.
- Changed-file relations can create unchanged file endpoints as placeholders.
  Replacing unchanged file `entity_versions` with the same canonical shape as a
  full reindex keeps chained incremental snapshots byte-identical.
- This is a small S1 slice with no schema or dependency changes; the remaining
  cost is scan / coverage bookkeeping, not file replay.

## 2026-06-28: Add Affected Verification Planner To Backlog

Decision: add D9, an affected verification planner, as a user-facing follow-up
from the latest web/GitHub review.

Sources:
- Nx affected commands: <https://nx.dev/ci/features/affected>
- Bazel query guide: <https://bazel.build/query/guide>
- GitHub Code Scanning SARIF upload: <https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/upload-sarif-file>
- SCIP bridge context: <https://github.com/scip-code/scip>
- Parallax open PR queue: <https://github.com/YouSangSon/Parallax/pulls?q=is%3Apr+is%3Aopen>
- Parallax open issues: <https://github.com/YouSangSon/Parallax/issues?q=is%3Aissue+is%3Aopen>

Why:
- External affected-target tools emphasize tasks/tests, not just changed files.
- Parallax already has impact reports, recommended actions, package manifests,
  PR triage, SARIF, and repo-map output; the missing step is grouping affected
  evidence into ranked verification commands.
- Keeping the planner deterministic and local-first preserves the existing
  safety boundary while making impact results more immediately actionable for
  agents and reviewers.

## 2026-06-28: Carry Forward Indexed Coverage On Successful Incremental Runs

Decision: in incremental runs, insert `index_coverage` rows for changed indexed
files only, then move unchanged prior-run indexed coverage rows to the new run
inside the successful persistence transaction.

Why:
- Coverage resources still need a full latest-run view, so rows cannot simply be
  omitted.
- The delta model only tracks indexed files; skipped and unsupported files stay
  on the existing scan loop so added/deleted non-indexed files do not get stale
  carry-forward rows.
- Failed runs keep the existing simple failure coverage behavior for changed or
  full-run files. Carry-forward is reserved for successful completed cohorts.
- This removes one more unchanged-file write loop without adding schema,
  temp-table, or diagnostic-coverage complexity.

## 2026-06-28: Reuse Clean Same-HEAD Index Before Metadata Caching

Decision: for default resource limits, when the current git snapshot is clean
and has the same commit SHA as the latest clean completed run with the same
extractor version, return that completed index result directly instead of
creating another `index_runs` row.

Sources:
- Nx affected commands: <https://nx.dev/ci/features/affected>
- Turborepo affected tasks: <https://turborepo.com/docs/crafting-your-repository/constructing-ci#using---affected>
- SCIP code intelligence bridge: <https://github.com/scip-code/scip>
- GitHub SARIF upload for third-party analysis:
  <https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/upload-sarif-file>

Why:
- External affected-target systems reinforce that repeated analysis should do
  the minimum work needed to prove what changed; a clean same-HEAD git state is
  the narrowest deterministic no-op proof Parallax already has.
- This avoids directory walking, content reads, adapter startup, and redundant
  run-row growth for the most common repeated `parallax index` command.
- The fast path is intentionally conservative: explicit `maxFileBytes`, prior
  resource-limit skips, oversized currently indexed files, dirty/non-git repos,
  existing git-ignored scan targets, and newly added git-ignored paths that
  Parallax's scanner would index all fall back to the existing scan path.
- Reusing the prior `indexRunId` is deliberate. If code state, extractor
  version, and resource semantics are identical, a new cohort would add storage
  churn without adding evidence.
- A broader mtime/size cache, watcher, or file-manifest schema can still be
  considered later, but only after this zero-schema path is measured.

## 2026-06-28: Ship D9 As Repo-Map Verification Plan

Decision: expose the affected verification planner inside `RepoMap` as
`verificationPlan` instead of adding a separate CLI command.

Sources:
- Nx affected commands: <https://nx.dev/ci/features/affected>
- Bazel query guide: <https://bazel.build/query/guide>
- Aider repo map: <https://aider.chat/docs/repomap.html>
- GitHub Copilot repository instructions:
  <https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions>
- Parallax open PR queue refreshed via `gh pr list` on 2026-06-28: #23-#31
  are still Dependabot PRs.
- Parallax open issues refreshed via `gh issue list` on 2026-06-28: #3 is
  still the only open issue.

Why:
- External affected-target tools emphasize executable test/task selection; AI
  repo-map tools emphasize compact ranked context. Parallax already has both
  impact evidence and recommended `ImpactReport.actions`, so `repo-map` is the
  narrowest place to join them.
- The planner groups existing actions by nearest `package.json` root and
  runner, emits copy-pasteable commands, and reports covered changed /
  affected / target paths, confidence, source actions, and omitted counts.
- It intentionally does not execute or require Nx, Bazel, or other build tools.
  That preserves the local-first / deterministic surface and keeps external
  target discovery as a future explicit integration, not hidden behavior.

## 2026-06-28: Defer Residual S1 Scan-Cost Work Pending Adapter Contract Design

Decision: move the remaining dirty/non-git S1 scan-cost reduction out of the
immediate loop until there is a measured adapter-contract design.

Why:
- The clean same-HEAD path already removes the safe no-op case without a schema
  change.
- The remaining dirty/non-git or changed-file scan cost is not just directory
  walking: current adapters consume full `indexedFiles` context at startup for
  manifests, path aliases, and cross-file TS/JS matching.
- Skipping reads for unchanged files without changing that contract risks stale
  package/config/call evidence. A future design should specify which adapter
  inputs are cacheable, which files are manifest-like global inputs, and what
  measurement justifies the added complexity.

## 2026-06-28: Publish S4 Baseline As A Limit, Not A Green 10k/50k Claim

Decision: document the local S4 perf baseline in `docs/verification*.md` with
the completed 1k/2k table and the failed-to-complete 10k limit instead of
claiming a successful 10k/50k baseline.

Sources:
- Nx affected commands: <https://nx.dev/ci/features/affected>
- Bazel query guide: <https://bazel.build/query/guide>
- Turborepo affected tasks:
  <https://turborepo.com/docs/crafting-your-repository/constructing-ci#using---affected>
- GitHub cross-checks:
  <https://github.com/bazelbuild/bazel/issues/13190>,
  <https://github.com/bazelbuild/bazel/issues/7962>

Why:
- External affected-target systems reinforce that large monorepos should avoid
  whole-graph work where possible; the S4 synthetic hub is intentionally a
  worst-case full-phase stress test.
- The GitHub issue cross-checks show real teams using reverse-dependency and
  rule-key style queries to decide which targets to build/test after a change,
  with query cost and graph scope showing up as scale problems.
- On the local baseline host (Apple M1 Max, 32 GiB RAM, Node `v24.14.0`, commit
  `f8f6060`), `npm run bench:perf -- --scales 1000,2000` completed and
  published concrete rows.
- `npm run bench:perf -- --scales 10000` stayed CPU-bound and emitted no table
  within about 20 minutes, so it was interrupted. Because 10k did not complete
  within that limit, 50k was not started.
- This is a real limit and should stay visible. Exact timing remains outside
  `npm run verify`; a future improvement should reduce analyzer/indexing cost
  or add phase-split/progress output before attempting 10k/50k again.

## 2026-06-28: Add Contract-Diff Quality To The Deterministic Bench

Decision: start the remaining D2 trend-metric work with a small
`contractDiffQuality` lane in `bench/impact-bench.ts`, not a separate benchmark
runner or a new dependency.

Sources:
- oasdiff: <https://github.com/oasdiff/oasdiff>
- OpenAPI diff tooling search:
  <https://github.com/OpenAPITools/openapi-diff>

Why:
- Existing OpenAPI diff tools frame contract evolution as a paired old/new
  contract comparison with breaking-change output, which matches Parallax's
  current `analyzeContractDiff` surface.
- The repo already has deterministic OpenAPI contract-diff tests. The missing
  D2 piece was trend reporting in the bench JSON and GitHub summary, not a new
  analysis engine.
- Reusing `analyzeContractDiff` over three paired OpenAPI v1/v2 cases gives a
  visible quality signal for removed response required properties, added
  request required properties, and response property type changes with no
  runtime dependency or nondeterministic timing.
- Co-change and trace-ingest metrics remain separate D2 follow-ups because they
  need git-history and promotion-count fixtures respectively.

## 2026-06-28: Add Co-Change Quality To The Deterministic Bench

Decision: add a small `coChangeQuality` lane to `bench/impact-bench.ts` before
the trace-ingest promotion metric.

Sources:
- Code Maat VCS mining tool: <https://github.com/adamtornhill/code-maat>
- Adjacent local code-intelligence tool with git diff impact and co-change
  analysis: <https://github.com/optave/ops-codegraph-tool>
- Parallax open issue queue refreshed via `gh issue list` on 2026-06-28: #3 is
  still the only open issue.
- Parallax open PR queue refreshed via `gh pr list` on 2026-06-28: #23-#31
  remain Dependabot PRs.

Why:
- External and adjacent tools reinforce that version-control history and
  co-change coupling are useful impact signals, especially for relationships a
  static graph structurally misses.
- Parallax already has `CO_CHANGES`, `queryCoChanges`, and `analyzeDiff`
  coverage. The missing D2 piece was a trend metric visible in the deterministic
  bench report and CI summary.
- A tiny git-history fixture keeps this lane local-first and deterministic:
  unrelated files co-change three times, then the bench asserts both
  `queryCoChanges` and `analyzeDiff` surface the expected heuristic partner.
- Trace-ingest promotion stays as the next D2 slice because it exercises a write
  surface and promotion counters, so it should remain separate from this
  read-only co-change fixture.

## 2026-06-28: Add Trace-Promotion Quality To The Deterministic Bench

Decision: finish D2 with a small `tracePromotionQuality` lane in the existing
deterministic impact bench, reusing the co-change fixture and `ingestTraces`.

Sources:
- OpenTelemetry traces concept docs:
  <https://opentelemetry.io/docs/concepts/signals/traces/>
- Parallax open issue queue refreshed via `gh issue list` on 2026-06-28: #3 is
  still the only open issue.
- Parallax open PR queue refreshed via `gh pr list` on 2026-06-28: #23-#31
  remain Dependabot PRs.

Why:
- Runtime traces represent observed execution paths, which matches Parallax's
  model of promoting matching heuristic/inferred relations to proven confidence.
- The repo already has trace-ingest integration tests. The missing D2 piece was
  trend visibility in the same deterministic bench and PR summary as the other
  impact-quality lanes.
- Reusing the tiny co-change fixture keeps this deterministic: first create a
  heuristic `src/beta.ts -> src/alpha.ts` relation, then ingest that observed
  edge and assert `analyzeDiff` reports `src/beta.ts` as proven impact.
- No new trace collector, OpenTelemetry dependency, or write-capable MCP surface
  is needed for this bench metric.

## 2026-06-28: Detect OpenAPI Response Enum-Value Removals

Decision: start W4 richer contract signatures with type-preserving OpenAPI
response enum-value removal detection, and bump the OpenAPI compatibility
signature schema to v3.

Sources:
- OpenAPI 3.0.3 Schema Object:
  <https://spec.openapis.org/oas/v3.0.3.html#schema-object>
- OpenAPI 3.1.0 Schema Object:
  <https://spec.openapis.org/oas/v3.1.0.html#schema-object>
- JSON Schema enum reference:
  <https://json-schema.org/understanding-json-schema/reference/enum>
- Parallax open issue queue refreshed via `gh issue list` on 2026-06-28: #3 is
  still the only open issue.
- Parallax open PR queue refreshed via `gh pr list` on 2026-06-28: #23-#31
  remain Dependabot PRs.

Why:
- OpenAPI schema objects use JSON Schema vocabulary for schema constraints, and
  `enum` is a validation constraint on allowed values. A property signature that
  only records `type` cannot distinguish `status: active|disabled|pending` from
  `status: active|pending`.
- The smallest useful W4 slice is to record type-preserving `enumValues`
  alongside the existing `type` without changing the endpoint resolver or
  adding a dependency. Enum fingerprints keep JSON primitive identity, so
  numeric `1`, string `"1"`, boolean `true`, string `"true"`, null, and
  string `"null"` do not collapse into the same provenance key.
- A schemaVersion bump is required because indexed OpenAPI compatibility JSON now
  carries additional property-signature data; old baselines should ask users to
  reindex rather than silently compare different signature shapes.
- The deterministic contract-diff bench now includes an enum-removal case so the
  new signal is visible in CI summaries, not only in focused unit tests.

## 2026-06-28: Detect OpenAPI Response Format Changes

Decision: extend the W4 OpenAPI property signature with response `format`
provenance, classify response format changes/removals as breaking, and bump the
OpenAPI compatibility signature schema to v4.

Sources:
- OpenAPI 3.0.3 Data Types:
  <https://spec.openapis.org/oas/v3.0.3.html#data-types>
- OpenAPI 3.0.3 Schema Object:
  <https://spec.openapis.org/oas/v3.0.3.html#schema-object>
- OpenAPI 3.1.0 Schema Object:
  <https://spec.openapis.org/oas/v3.1.0.html#schema-object>
- JSON Schema format vocabularies:
  <https://json-schema.org/draft/2020-12/json-schema-validation#name-format-vocabularies>
- Parallax open issue queue refreshed via `gh issue list` on 2026-06-28: #3 is
  still the only open issue.
- Parallax open PR queue refreshed via `gh pr list` on 2026-06-28: #23-#31
  remain Dependabot PRs.

Why:
- OpenAPI `format` further qualifies primitive values such as `uuid` and
  `date-time`. A response property changing from one format to another can
  break consumers even when its base JSON type remains `string`.
- The smallest useful W4 follow-up is response-side detection only: record an
  optional `format` on each property signature, compare previous/current
  response body properties, and leave request-side broadening/narrowing
  semantics plus `nullable` for separate slices.
- A schemaVersion bump is required because indexed OpenAPI compatibility JSON
  now carries additional property-signature data; old baselines should ask
  users to reindex rather than silently compare different signature shapes.
- The deterministic contract-diff bench now includes a response format-change
  case so this signal stays visible in CI summaries.

## 2026-06-28: Detect OpenAPI Response Nullable Additions

Decision: extend the W4 OpenAPI property signature with response
`nullable: true` provenance, classify non-nullable response properties becoming
nullable as breaking, and bump the OpenAPI compatibility signature schema to v5.

Sources:
- OpenAPI 3.0.3 Schema Object:
  <https://spec.openapis.org/oas/v3.0.3.html#schema-object>
- OpenAPI 3.1.0 Schema Object:
  <https://spec.openapis.org/oas/v3.1.0.html#schema-object>
- JSON Schema null type reference:
  <https://json-schema.org/understanding-json-schema/reference/null>
- Parallax open issue queue refreshed via `gh issue list` on 2026-06-28: #3 is
  still the only open issue.
- Parallax open PR queue refreshed via `gh pr list` on 2026-06-28: #23-#31
  remain Dependabot PRs.

Why:
- OpenAPI 3.0 `nullable: true` adds `null` to the allowed value set for a typed
  schema. A response property that can newly be `null` can break consumers even
  when its base type stays the same.
- The smallest useful W4 follow-up is response-side detection only: record
  nullable truth on property signatures and emit a breaking change when the
  previous response was not nullable and the current response is nullable.
- OpenAPI 3.1 / JSON Schema `type: ["string", "null"]` already flows through
  the existing type-signature path, so this slice deliberately targets the
  OpenAPI 3.0 `nullable` keyword without adding request-side semantics.
- A schemaVersion bump is required because indexed OpenAPI compatibility JSON
  now carries additional property-signature data; old baselines should ask
  users to reindex rather than silently compare different signature shapes.
- The deterministic contract-diff bench now includes a response nullable
  addition case so this signal stays visible in CI summaries.
