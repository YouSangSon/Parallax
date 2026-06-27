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
