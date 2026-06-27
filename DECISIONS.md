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
