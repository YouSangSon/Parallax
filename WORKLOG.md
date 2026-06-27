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
- Review:
  - spec reviewer approved the D8 diff.
  - code quality reviewer found depth/fanout and docs-boundary issues; both
    were fixed and re-reviewed clean.
