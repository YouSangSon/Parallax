# Plan

Source of truth for the active improvement loop. Detailed backlog lives in
`IMPROVEMENT_OPPORTUNITIES.md`; implementation plans live under
`docs/superpowers/plans/`.

## Active Loop

- Next loop: D8 dependency PR dogfood against live Dependabot PRs #23-#31.
- Completed loop: M9 repo-map hardening now carries omitted query-match counts
  and human CLI output exposes query matches, resource URIs, coverage, and
  provenance.
- Push policy: local commits only until the user explicitly approves push.

## Next

1. Dogfood dependency PR triage against live Dependabot PRs #23-#31.
2. Continue SARIF breadth after dogfood proves the PR workflow.
3. Revisit D1 official PR wrapper once the dependency workflow is grounded.
