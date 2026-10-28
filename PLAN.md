# Plan

Source of truth for the active improvement loop. Detailed backlog lives in
`IMPROVEMENT_OPPORTUNITIES.md`; implementation plans live under
`docs/superpowers/plans/`.

The 2026-10-25 goal keeps local validation to bounded unit/reproduction cases,
type/build/lint checks; existing remote CI owns required full verification.
Any my-cloud smoke requires current resource, shared-lock and provider-billed
traffic checks before transfer or execution; no Nebula VM is used for Parallax.

## Completed Runtime Slices — 2026-10-26

- TypeScript mixed exports: default/named resolver transitions retain one
  visited-export set. Export lookup caches and namespace/factory traversal also
  use tuple keys to distinguish export names and file paths. Pure cycle, receiver,
  factory, concrete-chain, alternate-branch and key-collision checks pass;
  shared regex version 41 invalidates older extraction receipts. This separate
  correctness repair does not identify the earlier VM timeout's cause.
- Workbench feedback (PR #57/#58): export failures use action-specific localized
  text; the legacy clipboard fallback rejects false copy results and cleans up.
  The actual 375×812 viewport recheck is separate from the earlier deadline and
  request-only attempt. Real legacy-browser execution remains unverified.
- Text evidence (PR #62/#63): original LF ranges preserve Unicode/CRLF positions;
  raw Docker source/from spans prevent false local relations while retaining
  destination references. Validated JSON keeps spaces, escapes and literal
  filename quotes; rejected JSON never enters the secondary string lexer.
  Config/infra version 3 and shared regex version 39 rebuild legacy cohorts.
  Saved reports remain snapshots. This does not implement a full Docker parser.
- Extraction cost (PR #59/#61): a per-run path lookup removes repeated matching;
  a bounded process-local memo reuses fully consumed successful config events
  across public `indexProject()` calls. Body/language/path/root and ordered
  indexed paths invalidate it; fresh copies still use the full publisher and
  redaction path. Separate CLI invocations cannot share it.

Exact local, PR and merged-main evidence is owned by `GATES.md` and the existing
portfolio owner in `CONTEXT.md`. These completed slices are not pending work.

## S1 Remaining Queue — 2026-10-27

Output ownership admission, cohort revalidation under the writer lock, actual
input receipts and deterministic read counters already exist. Config/infra's
full/reversed/single-file and edit/path-set oracles passed in PR #54. A stateful
adapter with both scope flags still disproves general process-order independence.
Changed-body extraction therefore remains conservative; no general selection
flag, partial SQL carry or scanner read skipping is enabled.

The latest package equivalent to `23ec770` passed the VM's 19-step CLI, real
stdio MCP, saved-report graph, loopback HTTP and Docker/Unicode/CRLF checks.
Its 23-body full-index profile also passed, with all bodies still read in every
phase. These independent passes do not make the combined VM command a success:
the following 287-file non-Git source profile timed out after 150 seconds and
reached the 1 GiB cgroup limit. Cleanup and the final resource audit passed.
Exact scope, observations and skipped checks are recorded in `GATES.md`.

1. Diagnose the bounded whole-source profile before another VM execution. No
   completed whole-source timing or bottleneck attribution was collected; do not
   repeat the same workload, raise limits or treat small-fixture timings as a
   representative speedup. Use existing observers and distinct read/sample counters
   to choose a smaller diagnostic scope after inspecting the implicated inputs.
2. Only if residual cost justifies another bounded path, prove process-order and
   startup-context independence, input validity, fresh-full graph/report equality,
   diagnostic/version/audit ownership and rollback behavior before changing carry
   or body reads. Retain legacy adapters' conservative behavior and atomic SQL
   publication. Update the existing portfolio owner after verified delivery.

General selective execution, read reduction and cross-process computation reuse
remain unproven; the whole S1 goal is not complete. Verification and measurements
in `docs/verification.md` retain their original source/environment boundaries.

The input-validity slice in PR #51 uses the existing scanner and publication path. Its versioned pre-classification
scanner/history receipt is stored with completed graph publication. Reuse now
validates bounded bodies and selected history; a miss allocates a new run before
capturing inputs again. NULL/unknown/different inputs require full extraction,
including legacy cohorts and changed skip/unsupported/history inputs. The first
legacy rebuild follows the existing SCIP/trace reapply contract; later identical
inputs retain augmentation. A co-change savepoint failure publishes no valid
receipt. Schema v17 is private to indexing; v16 read APIs remain compatible.

The eight hidden-Git regressions and two mutable-supports cases are preserved.
Required remote gates additionally cover history removal, legacy reapply,
rescan/history capture, summed read counts and graph/receipt rollback. Local
validation stays type/docs/schema only. Runtime selective extraction/read skipping
remains a later step, with no speedup or read-reduction claim for this repair.

## CLI Help Safety Follow-up — 2026-10-23

The resumed usability check found that `index --help` started indexing.
The bounded correction handles help before command imports at the root,
immediately after a command, or immediately after a nested subcommand.
Help must precede other options; existing option values and validation remain
unchanged. Regression tests cover filesystem side effects, server entry points,
literal help-looking values and malformed inputs. The final source must pass
the canonical verification and PR checks before landing; the resume evidence
owner in `CONTEXT.md` retains the run, merge and scoped cleanup receipts.

## Portfolio Readiness Loop — 2026-10-23

Continue from the PR #36 tree (`ab3c365`); preserve the completed milestone.
The user authorized commit, push, PR and main merge after required gates.

1. Replace the expired dependency exception with compatible locked fixes and an
   unconditional high/critical audit gate; retain validation and secret-safe errors.
2. Verify a clean install, the canonical `npm run verify`, and the actual default
   local embedding model separately from stub-based tests.
3. Exercise packaged CLI, MCP and workbench success/failure flows on an isolated
   local demo. Record fixture accuracy and observed timings without claiming
   production adoption, paid-model savings or general large-repository performance.
4. Land verified units, preserve unrelated work, clean only owned test resources,
   and save portfolio evidence in the existing resume evidence structure.

The dependency and badge corrections landed in PR #38 and #39. `GATES.md`
records the native browser follow-up, PNG correction and scoped local recovery.
PR records and the resume evidence bundle own final landing and cleanup receipts.

Selective indexing and deeper language/contract features remain deferred under
existing ownership gates; this loop makes the shipped product reviewable.

## Prior Completed Loop

- Completed checkpoint: S1 changed-content correctness now promotes every
  changed-body run to full extraction. Exact fresh-index oracles cover both
  `tsconfig.json` alias invalidation and a target-only adapter's foreign-source
  output; zero-change runs still skip adapter startup (`22f2414`).
- Completed checkpoint: the canonical final-tree gate and owned-resource
  cleanup passed. The same tree includes the bounded UI interaction /
  accessibility fixes and a fail-closed, expiring exception for the four
  currently unfixable high-severity findings in the locked Transformers tree.
- Completed landing: PR #35's first CodeQL result exposed four high-severity
  findings. The corrected slice removes both regex hazards, binds SCIP import
  to a write-locked immutable source snapshot, and upgrades the redacted
  evidence ID hash. Every local and remote gate passed before the PR
  squash-merged to `main` as `4f289a6`.
- Deferred S1 slice: define and enforce emitted-row ownership separately from
  `fileContentScope`, then add deterministic body/byte read counts. Until that
  contract exists, every changed-body run stays conservative.
- Completed implementation: the five evidence-backed UI defects in `GATES.md`
  are fixed with native sibling controls, contrast-safe focus, reduced-motion
  behavior, history restoration, and fail-closed empty-map PNG export. Static
  tests and a live browser pass cover their distinct boundaries.
- W5 JSON Schema and Avro first slices are now shipped; deeper JSON Schema
  enum/format policy and Avro named-type / schema-registry compatibility remain
  follow-ons rather than the next default loop.
- Completed slice: S1 adapter file-content scope is now explicit through
  `SemanticAdapter.fileContentScope` and `registry.manifest()`. The default is
  conservative `full-index`; config/infra declares `target-only` because it
  uses indexed files only as path context, while build-system/package and
  TypeScript/JavaScript coverage remain `full-index`.
- Completed slice: S1 `bench:perf` now reports actual indexer scan phase
  timings for full, no-op incremental, and edited-file reindex phases. This
  keeps risky content-read skipping out of the runtime path until the adapter
  content contract is explicit, while making the remaining scan/read cost
  measurable.
- Completed slice: S1 dirty/non-git no-changed-file reruns now skip adapter
  startup after the existing scan proves `delta.changed=[]`. The run still
  records fresh git dirty metadata and carries prior graph/coverage rows
  forward into the new cohort; actual scan/read reduction remains behind the
  adapter-contract design.
- Completed slice: W5 Avro contract-kind first slice now recognizes `.avsc`
  files as `avro` contracts, persists root record compatibility signatures,
  declares a synthetic `AVRO #` endpoint, and classifies top-level record
  required field removals, defaulted field removals, field type changes, and
  nullable additions through the same produced-object diff policy used by the
  JSON Schema first slice. The deterministic `contractDiffQuality` bench now
  has 11/11 cases including Avro required-field removal.
- Completed slice: W3 parse-only Nx project config discovery now extends
  `parallax workspace discover-packages` to read `nx.json` and, when present,
  discover Nx `project.json` directories plus `package.json` files with an
  `nx` project config as workspace catalog members. It still does not execute
  Nx, Turbo, package managers, installs, daemons, caches, or network calls.
  Turborepo package membership remains covered through package-manager
  workspace manifests, while `turbo.json` task config is not treated as a
  catalog source.
- Completed slice: W3 deterministic npm/pnpm workspace package discovery now
  adds `parallax workspace discover-packages`, which reads local
  `package.json` `workspaces` / `workspaces.packages` and
  `pnpm-workspace.yaml` `packages`, expands direct paths plus `*`, `**`,
  leading `!` excludes, and simple brace groups, then syncs discovered package
  directories into `.parallax/workspace.json` without npm/pnpm/Nx/Turbo
  execution. When packages are found, the root entry is replaced by package
  entries to avoid duplicate same-monorepo links; entries outside the current
  repo root are preserved.
- Completed slice: W3 explicit package-directory workspace members now share
  the nearest parent Parallax index during `workspace resolve-contracts`.
  Provider contracts and consumer files are filtered to the member package
  prefix, returned paths are package-relative, persisted link provenance keeps
  member paths, and `workspace verify` / `consumers` / `providers` continue to
  read the persisted member-aware links.
- Research refresh: the 2026-06-28 web/GitHub pass confirms W3 remains the
  highest-value next slice. npm/pnpm expose deterministic workspace membership
  through manifests/globs, Nx/Turbo affected workflows operate on a
  package/project graph, and Parallax's current workspace resolver still skips
  every same-`repoPath` pair. Start with package-scoped workspace identity and
  deterministic manifest parsing; do not execute external monorepo CLIs.
- Completed slice: W5 JSON Schema contract-kind first slice now recognizes
  `*.schema.json` and contract-located `schema.json` files as `json-schema`
  contracts, stores `$schema` dialect and compatibility signatures, declares a
  synthetic `SCHEMA #` endpoint, and classifies root-object required removal,
  optional removal, property type changes, and nullable additions through
  `analyzeContractDiff`. The deterministic `contractDiffQuality` bench now has
  JSON Schema required-property removal coverage.
- Completed slice: W4 OpenAPI response optional property removals now surface
  through contract diff as `removed_response_optional_property` non-breaking
  changes. Required response removals still drive breaking consumer links, but
  optional property removals remain visible in `changes` and the deterministic
  `contractDiffQuality` bench now has a response optional-property removal
  case.
- Completed slice: W4 OpenAPI request format additions/changes now reuse the
  existing `format` property signature. `analyzeContractDiff` emits
  `changed_request_property_format` breaking changes when current request
  bodies add a new format constraint or switch to a different format, and the
  deterministic `contractDiffQuality` bench now has a request format-addition
  case.
- Completed slice: W4 OpenAPI request enum-value removal now reuses existing
  type-preserving enum property signatures. `analyzeContractDiff` emits
  `removed_request_property_enum_value` breaking changes when current request
  bodies remove previously accepted enum values, and the deterministic
  `contractDiffQuality` bench now has a request enum-removal case.
- Completed slice: W4 OpenAPI response nullable additions now flow through
  compatibility signatures. `OpenApiPropertySignature` records `nullable`,
  OpenAPI compatibility schemaVersion is bumped to 5, `analyzeContractDiff`
  emits `added_response_property_nullable` breaking changes with nullable
  provenance, and the deterministic `contractDiffQuality` bench now has a
  response nullable-addition case.
- Completed slice: W4 OpenAPI response format changes now flow through
  compatibility signatures. `OpenApiPropertySignature` records `format`,
  OpenAPI compatibility schemaVersion is bumped to 4, `analyzeContractDiff`
  emits `changed_response_property_format` breaking changes with format
  provenance, and the deterministic `contractDiffQuality` bench now has a
  response format-change case.
- Completed slice: W4 OpenAPI response enum removals now flow through
  compatibility signatures. `OpenApiPropertySignature` records `enumValues`,
  OpenAPI compatibility schemaVersion is bumped to 3, `analyzeContractDiff`
  emits `removed_response_property_enum_value` breaking changes with enum
  provenance, and the deterministic `contractDiffQuality` bench now has a
  response enum-removal case.
- Completed slice: D2 trace-promotion quality now adds a deterministic
  `tracePromotionQuality` bench lane. The lane ingests a runtime-observed
  `src/beta.ts -> src/alpha.ts` edge, checks the promotion count, verifies
  `analyzeDiff` surfaces `src/beta.ts` as proven impact, and adds trace
  promotion/count deltas to `bench:report`.
- Completed slice: D2 co-change quality now adds a deterministic
  `coChangeQuality` bench lane with a tiny git-history fixture where
  `src/alpha.ts` and `src/beta.ts` repeatedly change together. The lane checks
  `queryCoChanges` partner output and `analyzeDiff` heuristic affected-file
  output, and `bench:report` now includes co-change metric/count deltas.
- Completed slice: D2 contract-diff quality now adds a deterministic
  `contractDiffQuality` bench lane with paired OpenAPI v1/v2 cases for removed
  response required properties, added request required properties, and response
  property type changes. `bench:report` now includes the metric and count deltas
  in Markdown / GitHub Step Summary output.
- Completed slice: S4 measured perf baseline limits are published in
  `docs/verification*.md`. On the local baseline host, `bench:perf` completed
  1k/2k rows, but a 10k full-phase run did not emit a table within about 20
  minutes and was interrupted; 50k was not started because the 10k limit already
  showed the current full-phase harness is too expensive at that scale.
- Completed slice: D9 affected verification planner now adds `verificationPlan`
  to `parallax repo-map` and MCP `parallax_repo_map`, grouping existing
  recommended actions by nearest `package.json` root / runner into ranked,
  copy-pasteable commands with covered changed / affected / target paths,
  confidence, source actions, and omitted counts.
- Decision: defer residual S1 dirty/non-git changed-file scan-cost work until a
  measured adapter-contract design exists; the remaining scan cost cannot be
  safely removed by only skipping file reads because adapters currently consume
  whole indexed-file context at startup.
- Historical slice (input validation above supersedes read skipping): S1 reused
  the latest completed clean same-HEAD git index for default resource limits,
  skipping scan/body reads as well as adapter startup and a redundant run. The
  fast path is disabled for explicit `maxFileBytes`, prior resource skips, and
  any git-ignored path that Parallax's scanner would index.
- Completed slice: S1 incremental indexing now writes indexed coverage only for
  changed files and carries unchanged indexed coverage rows forward on
  successful incremental persistence.
- Completed slice: S1 incremental indexing now skips unchanged non-contract
  file replay, bulk-loads file ids once, carries unchanged `files` rows forward,
  and canonicalizes unchanged file `entity_versions` so chained incremental
  runs stay byte-identical to full reindex snapshots.
- Backlog addition from latest web/GitHub search: D9 affected verification
  planner, turning impact graph output into ranked test/build commands.
- Completed slice: S4 docs now define the standard large-repo baseline command:
  `npm run bench:perf -- --scales 10000,50000`, with commit/Node/OS/hardware
  metadata capture and no exact timing/RSS in `verify`.
- Completed slice: S4 perf bench now reports `observed_peak_rss_mb`, sampled at
  phase boundaries, while keeping timing/RSS outside deterministic `verify`.
- Completed slice: M10 SCIP export now adds `parallax scip export
  [--file <index.scip.json>]`, emitting SCIP-compatible JSON from the latest
  completed Parallax index without adding a protobuf writer dependency.
- Completed slice: M10 SCIP import now accepts JSON from the official SCIP CLI
  and binary `index.scip` files via `scip print --json`, augmenting the latest
  completed index with SCIP-derived definition/reference edges from external
  indexers.
- Completed slice: D4 UI export/deep-linking now preserves selected impact path,
  filter text, and report-delta policy preset in the URL, and exports JSON,
  affected-path CSV, and PNG/SVG impact maps from the workbench toolbar.
- Completed slice: D6 local Git hook installer now adds `parallax install-hook`
  for managed `pre-commit` / `pre-push` impact gates, preserving existing
  non-Parallax hooks unless forced.
- Completed slice: D1 official PR action wrapper now runs init/index/pr triage,
  supports changed-file or base/head diff discovery, writes SARIF, and appends a
  GitHub step summary while leaving SARIF upload explicit.
- Completed slice: D7 coverage gaps now emit as SARIF warnings anchored to
  changed files.
- Completed slice: D7 cross-repo contract breaks now emit as SARIF warnings
  anchored to provider contracts.
- Completed slice: D7 adapter known gaps now emit as SARIF note results anchored
  to changed files.
- Completed slice: D7 recommended verification actions now emit as SARIF note
  results.
- Completed loop: D8 dependency PR dogfood now has `parallax pr triage` for
  local diff analysis, SARIF output, `--fail-on`, and repo-map context.
- Completed loop: M9 repo-map hardening now carries omitted query-match counts
  and human CLI output exposes query matches, resource URIs, coverage, and
  provenance.
- Push policy: the user explicitly approved pushing this branch, opening PR #35,
  and merging it into `main` after all local and remote gates pass.

## Portfolio Completion and Deferred Work

The portfolio readiness loop is complete. Dependency, UI and PNG corrections
landed in PR #38–#40. PR #41 restored the main-only Scorecard workflow;
`GATES.md` records the successful runs on its exact merge commit. Portfolio
evidence and cleanup receipts remain in the owner location in `CONTEXT.md`.

The following items are deferred beyond this completed loop:

1. Revisit general selective reads only after the remaining S1 evidence above;
   output ownership and deterministic read counters are already implemented.
2. Keep deeper JSON Schema / Avro compatibility semantics behind S1 unless new
   evidence displaces the sequence.
