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
