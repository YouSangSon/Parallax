# Plan

Source of truth for the active improvement loop. Detailed backlog lives in
`IMPROVEMENT_OPPORTUNITIES.md`; implementation plans live under
`docs/superpowers/plans/`.

## Active Loop

- Next loop: continue S1/S4 scale and perf follow-through.
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

1. Continue S1/S4 scale and perf follow-through with 10k/50k baseline guidance.
2. Keep binary `.scip` protobuf writing out of scope until JSON export is not enough.
