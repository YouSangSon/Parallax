# Plan

Source of truth for the active improvement loop. Detailed backlog lives in
`IMPROVEMENT_OPPORTUNITIES.md`; implementation plans live under
`docs/superpowers/plans/`.

## Active Loop

- Next loop: start W3 deterministic npm/pnpm workspace package discovery.
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
  10/10 cases including JSON Schema required-property removal. Avro remains a
  lower-priority W5 follow-on.
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
- Completed slice: S1 incremental indexing now reuses the latest completed
  clean same-HEAD git index for default resource limits, skipping directory
  scan, content reads, adapter startup, and a redundant `index_runs` row. The
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
- Push policy: local commits only until the user explicitly approves push.

## Next

1. Add deterministic npm/pnpm workspace discovery, then consider parse-only
   Nx/Turbo metadata after the member model is stable.
2. Keep W5 Avro and residual S1 scan-cost work behind W3 unless new evidence
   displaces the sequence.
