# Worklog

## 2026-06-27

- Refreshed ecosystem research in `IMPROVEMENT_OPPORTUNITIES.md`.
  Commit: `e436032 docs: refresh ecosystem opportunity review`.
- Continued M9 repo-map hardening from review findings.
  - `src/repo_map.ts` now carries omitted query-match counts from
    `searchContext`.
  - `src/cli.ts` human output now prints query matches, resource URIs,
    coverage, and provenance.
  - `tests/repo-map.test.ts` covers omitted query matches and human CLI output.
- Verification so far:
  - `node --import tsx --test tests/repo-map.test.ts`
  - `npm run test:mcp`
  - `npm run check`
  - `npm run docs:lint`
  - `git diff --check`
  - `npm run build`
  - `npm test`
- Review:
  - reviewer subagent found no correctness, regression, safety, or missing-test
    issues in the repo-map hardening diff.
- Refreshed live Dependabot queue on GitHub: PRs #23-#31 remain open as of
  2026-06-27.
- Shipped D8 dependency PR dogfood.
  - `src/cli.ts` adds `parallax pr triage`, a local wrapper around
    `analyzeDiff`, SARIF output, `--fail-on`, and `buildRepoMap`.
  - `tests/parallax.test.ts` covers SARIF emission, repo-map output, and
    `--fail-on none` success for local PR triage.
  - `docs/cli-reference*.md` and `docs/roadmap*.md` document the workflow.
- D8 verification:
  - `node --import tsx --test tests/parallax.test.ts --test-name-pattern "CLI pr triage"`
  - `npm run check`
  - `npm run docs:lint`
  - `npm run build`
  - `git diff --check`
  - `npm test`
  - `npm test`
- Review:
  - spec reviewer approved the D8 diff.
  - code quality reviewer found depth/fanout and docs-boundary issues; both
    were fixed and re-reviewed clean.
- Shipped first D7 SARIF breadth slice.
  - `src/sarif.ts` now projects `ImpactReport.actions` as
    `parallax.verification` note results with target locations, stable
    fingerprints, and command metadata.
  - `tests/sarif.test.ts` covers the verification-action SARIF result.
  - `docs/cli-reference*.md`, `docs/report-schema*.md`,
    `docs/roadmap*.md`, and `IMPROVEMENT_OPPORTUNITIES.md` document that
    verification actions are covered; remaining SARIF breadth continues below.
- Shipped second D7 SARIF breadth slice.
  - `src/sarif.ts` now projects `ImpactReport.adapterInsights[].knownGaps` as
    `parallax.adapter-known-gap` note results anchored to changed files, with
    stable fingerprints and emitted/omitted counts.
  - `tests/sarif.test.ts` covers emitted adapter known-gap notes and omitted
    notes when no uploadable changed-file anchor exists.
  - `docs/cli-reference*.md`, `docs/report-schema*.md`,
    `docs/roadmap*.md`, and `IMPROVEMENT_OPPORTUNITIES.md` document that
    adapter known gaps are covered; remaining SARIF breadth continues below.
- Shipped third D7 SARIF breadth slice.
  - `src/sarif.ts` now projects `ImpactReport.crossRepoImpacts` as
    `parallax.contract-break` warning/note results anchored to provider
    contracts, with consumer/change metadata in SARIF properties.
  - `tests/sarif.test.ts` covers emitted contract-break results and omitted
    results when no uploadable provider contract anchor exists.
  - `docs/cli-reference*.md`, `docs/report-schema*.md`,
    `docs/roadmap*.md`, and `IMPROVEMENT_OPPORTUNITIES.md` document that
    contract breaks are covered; remaining SARIF breadth continues below.
- Shipped fourth D7 SARIF breadth slice.
  - `src/sarif.ts` now projects changed files with `changed file not in index`
    impact state as `parallax.coverage-gap` warning results anchored to the
    changed file.
  - `tests/sarif.test.ts` covers emitted coverage-gap warnings and omitted
    warnings when no uploadable changed-file anchor exists.
  - `docs/cli-reference*.md`, `docs/report-schema*.md`,
    `docs/roadmap*.md`, and `IMPROVEMENT_OPPORTUNITIES.md` document D7 SARIF
    breadth as complete.
- D7 verification:
  - `node --import tsx --test tests/sarif.test.ts`
  - `npm run check`
  - `npm run docs:lint`
  - `npm run build`
  - `git diff --check`
  - `npm test`
- Review:
  - spec reviewer approved the verification-action SARIF slice.
  - code quality reviewer found no blocking issues.
- Shipped D1 PR action wrapper slice.
  - `action.yml` now accepts either `changed` or `base`/`head`, runs
    `parallax init`, `parallax index`, and `parallax pr triage`, writes SARIF,
    captures `.parallax/pr-triage-summary.md`, and appends the summary to
    `$GITHUB_STEP_SUMMARY`.
  - SARIF upload remains outside the action so `security-events: write` stays
    explicit in the user's workflow.
  - `README*.md` now show the action wrapper with `fetch-depth: 0`, PR base/head
    inputs, explicit `github/codeql-action/upload-sarif`, and `fail-on`
    guidance.
- D1 verification:
  - `node --import tsx --test tests/package_metadata.test.ts`
  - `npm run docs:lint`
  - `npm run build`
  - `git diff --check`
  - `npm test`
- Shipped D6 local Git hook installer slice.
  - `src/git_hooks.ts` adds pure planning and install functions for managed
    `pre-commit` / `pre-push` Parallax hooks.
  - `src/cli.ts` adds `parallax install-hook [--hook pre-commit|pre-push|all]`
    with `--fail-on`, `--command`, `--dry-run`, and `--force`.
  - Generated hooks run `parallax init`, `parallax index`, and
    `parallax analyze --changed ... --fail-on ...`; `pre-commit` uses staged
    files and `pre-push` uses Git's pre-push input with safe fallbacks.
  - Existing non-Parallax hooks are skipped unless forced; managed hooks are
    idempotently overwritten; `core.hooksPath` is respected.
  - `README*.md`, `docs/cli-reference*.md`, `docs/roadmap*.md`,
    `PLAN.md`, `BACKLOG.md`, `DECISIONS.md`, and
    `IMPROVEMENT_OPPORTUNITIES.md` document the shipped hook workflow.
- D6 verification:
  - `node --import tsx --test tests/git-hooks.test.ts`
  - `npm run check`
  - `npm run docs:lint`
  - `npm run build`
  - `git diff --check`
