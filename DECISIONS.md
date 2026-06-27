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
