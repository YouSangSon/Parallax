# Plan

Source of truth for the active improvement loop. Detailed backlog lives in
`IMPROVEMENT_OPPORTUNITIES.md`; implementation plans live under
`docs/superpowers/plans/`.

## Active Loop

- Next loop: D7 SARIF breadth for contract breaks, known gaps, coverage gaps,
  and recommended verification actions.
- Completed loop: D8 dependency PR dogfood now has `parallax pr triage` for
  local diff analysis, SARIF output, `--fail-on`, and repo-map context.
- Completed loop: M9 repo-map hardening now carries omitted query-match counts
  and human CLI output exposes query matches, resource URIs, coverage, and
  provenance.
- Push policy: local commits only until the user explicitly approves push.

## Next

1. Continue SARIF breadth after dogfood proved the PR workflow.
2. Revisit D1 official PR wrapper once the SARIF result contract is broader.
3. Keep D4 deep-linkable UI/export queued for human sharing.
