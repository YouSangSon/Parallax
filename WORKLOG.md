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
- Shipped D4 deep-linkable UI/export slice.
  - `src/ui/client.ts` now keeps selected impact path, filter text, and
    report-delta policy preset in the URL using `URLSearchParams` and
    `history.replaceState`.
  - `src/ui.ts` and `src/ui/styles.ts` add toolbar controls for link copy,
    JSON export, affected-path CSV export, and PNG/SVG impact-map export.
  - `src/ui/report_delta.ts` makes policy preset cards selectable so shared
    URLs can reopen the same preset context.
  - `tests/ui.test.ts` covers the rendered export controls, deep-link state
    script, preset state, mobile layout, and CSP image allowances.
- D4 verification:
  - `npm run check`
  - `node --import tsx --test tests/ui.test.ts`
  - `npm run docs:lint`
  - `npm run build`
  - `git diff --check`
  - `npm test`

## 2026-06-28

- Refreshed web/GitHub signals while closing M10.
  - SCIP remains the right standards bridge for code-intelligence
    import/export.
  - The live GitHub queue is still Dependabot PRs #23-#31 plus issue #3, so
    continued dogfooding can use existing read-only PR triage without adding a
    write-capable GitHub surface.
- Shipped S4 observed peak RSS slice.
  - `bench/impact-perf.ts` now reports `observed_peak_rss_mb`, sampled at phase
    boundaries with Node's built-in RSS reading.
  - `docs/verification*.md`, `PLAN.md`, `BACKLOG.md`, `DECISIONS.md`, and
    `IMPROVEMENT_OPPORTUNITIES.md` document the intentionally non-deterministic
    perf signal and leave 10k/50k baseline guidance as the next S4 step.
- S4 observed peak RSS verification:
  - `node --import tsx --test tests/synthetic-repo.test.ts`
  - `npm run check`
  - `npm run bench:perf -- --scales 10`
- Shipped S4 large-repo baseline guidance.
  - `docs/verification*.md` now names
    `npm run bench:perf -- --scales 10000,50000` as the standard comparable
    baseline command and says to record command, commit, Node version, OS /
    hardware class, and the full output table.
  - No new `bench:perf` flag was added because existing `--scales` already
    covers the use case.
  - `BACKLOG.md` and `PLAN.md` move the next active work to S1 unchanged-file
    bookkeeping cost; measured S4 10k/50k limits stay pending until run on a
    stable baseline host.
- S4 large-repo baseline guidance verification:
  - `npm run docs:lint`
  - `git diff --check`
- Shipped M10 SCIP JSON import first slice.
  - `src/scip.ts` imports JSON produced by the official SCIP CLI and augments
    the latest completed Parallax index run instead of creating a SCIP-only run.
  - `src/cli.ts` adds `parallax scip import --file <index.scip.json>`.
  - Imported SCIP definition/reference occurrences become proven file-level
    `REFERENCES` relations with evidence spans, so existing `analyzeDiff`
    reverse traversal can surface impacted referrers.
  - `tests/scip.test.ts` covers API import, CLI import, persisted evidence
    spans, and impact analysis using the imported edge.
- M10 SCIP JSON import verification so far:
  - `npm run check`
  - `node --import tsx --test tests/scip.test.ts`
  - `npm run docs:lint`
  - `npm run build`
  - `git diff --check`
  - `npm test`
- Shipped M10 SCIP binary ingest follow-up.
  - Web/GitHub review reconfirmed SCIP as the right standards bridge:
    `scip-code/scip` documents the language-agnostic index format, official
    `scip print --json`, and path-based `scip print /path/to/index.scip`
    inspection.
  - `src/scip.ts` now accepts binary `index.scip` inputs by shelling out to
    `scip print --json <file>` and reusing the JSON importer. No protobuf
    runtime dependency was added.
  - JSON import remains supported without requiring `scip` at import time.
  - `tests/scip.test.ts` adds a fake official CLI printer to cover binary
    ingest deterministically.
- M10 SCIP binary ingest verification:
  - `npm run check`
  - `node --import tsx --test tests/scip.test.ts`
  - `npm run docs:lint`
  - `npm run build`
  - `git diff --check`
  - `npm test`
- Shipped M10 SCIP JSON export.
  - `src/scip.ts` now exports the latest completed Parallax index as
    SCIP-compatible JSON with metadata, documents, symbols, and relation-backed
    reference occurrences.
  - `src/cli.ts` adds `parallax scip export [--file <index.scip.json>]`; stdout
    emits the JSON payload, while `--file` writes the payload and prints a small
    summary.
  - No protobuf writer dependency was added; binary `.scip` output stays
    deferred until JSON export is not enough.
  - `tests/scip.test.ts` covers API export and CLI file export.
- M10 SCIP JSON export verification:
  - `npm run check`
  - `node --import tsx --test tests/scip.test.ts`
  - `npm run docs:lint`
  - `npm run build`
  - `git diff --check`
  - `npm test`
- Refreshed web/GitHub signals for the next product additions.
  - GitHub issue/PR review still shows one open issue (#3) and Dependabot PRs
    #23-#31 as the live remote queue.
  - External affected-target systems (Nx affected and Bazel query/test
    selection patterns) point to D9: convert Parallax impact output into ranked
    verification commands, not only affected-file lists.
  - SCIP and GitHub SARIF remain the standards/output lanes Parallax already
    started covering through M10 and D7/D1.
- Shipped first S1 unchanged-file bookkeeping slice.
  - Incremental persistence now replays file-level rows only for changed files
    plus contract files.
  - Unchanged `files.index_run_id` rows are carried forward in SQL, file ids are
    bulk-loaded once, and unchanged file `entity_versions` are canonicalized in
    SQL after changed-file events so placeholder endpoints cannot drift from
    full reindex output.
  - The incremental oracle now snapshots current `files` rows, proving chained
    incremental runs keep every live file stamped to the latest completed run
    and remain byte-identical to a full reindex of the same end state.
- S1 file-replay narrowing verification:
  - `node --import tsx --test tests/index-delta.test.ts tests/incremental-index-oracle.test.ts`
  - `npm run check`
  - `npm run docs:lint`
  - `npm run build`
  - `git diff --check`
  - `npm test`
  - `npm run test:dogfood`
  - `npm run bench`
  - `npm run bench:perf -- --scales 10`
  - `npm audit --audit-level=high`
- Shipped second S1 unchanged-file bookkeeping slice.
  - Incremental runs now insert indexed coverage only for changed files.
  - Unchanged indexed coverage rows are carried from the prior completed run to
    the new run inside successful persistence.
  - Skipped and unsupported files intentionally stay on the existing scan loop
    because they are outside the indexed-file delta model.
  - The incremental oracle now snapshots `index_coverage`, so coverage
    carry-forward must remain byte-identical to a full reindex of the same end
    state.
- S1 indexed-coverage carry-forward verification:
  - `node --import tsx --test tests/index-delta.test.ts tests/incremental-index-oracle.test.ts`
  - `npm run check`
  - `npm run docs:lint`
  - `node --import tsx --test tests/parallax.test.ts --test-name-pattern "coverage|failed reruns preserve|incremental"`
  - `npm run build`
  - `git diff --check`
  - `npm test`
  - `npm run bench:perf -- --scales 10`
  - `npm run bench`
  - `npm run test:dogfood`
- Refreshed web/GitHub signals for the current S1 follow-through.
  - Nx and Turborepo both emphasize running only the tasks/packages affected by
    a change, which supports D9 as the next user-facing planner and S1 as the
    current cost-reduction path.
  - The live GitHub queue still has one open issue (#3) and Dependabot PRs
    #23-#31, so there is no newer remote issue that displaces the current S1
    loop.
  - SCIP and GitHub SARIF remain standards/output lanes already covered by M10
    and D7/D1, so the smallest unshipped improvement was not another
    integration but cheaper repeated local indexing.
- Shipped third S1 scan-cost slice.
  - `src/indexer.ts` now reuses the latest completed clean same-HEAD git index
    for default resource limits instead of rescanning, restarting adapters, or
    creating a redundant `index_runs` row.
  - The fast path is disabled when `maxFileBytes` is explicit, the prior run had
    resource-limit coverage skips, current indexed files exceed the default
    resource limit, the repo is dirty/non-git, or prior indexed/coverage paths
    are not git tracked.
  - `src/git-snapshot.ts` adds a small `git ls-files -z` helper so
    git-ignored files that Parallax still scans cannot be hidden by a clean git
    status.
  - `tests/parallax.test.ts` covers the clean same-HEAD reuse, the
    git-ignored-file fallback, and the resource-skip fallback.
- S1 clean same-HEAD fast-path verification:
  - `npm run check`
  - `node --import tsx --test tests/parallax.test.ts --test-name-pattern "same-HEAD|resource skips|git snapshot|dirty state|git-ignored"`
  - `node --import tsx --test tests/index-delta.test.ts tests/incremental-index-oracle.test.ts`
  - `npm run docs:lint`
  - `npm run build`
  - `git diff --check`
  - `npm test`
  - `npm run bench:perf -- --scales 10`
  - `npm audit --audit-level=high`
  - `npm run bench`
  - `npm run test:dogfood`
- Hardened the S1 clean same-HEAD fast path for newly created git-ignored
  scanner targets.
  - Root cause: `git status` can stay clean when a new ignored source file is
    added, while Parallax's scanner intentionally does not follow `.gitignore`.
  - `src/git-snapshot.ts` now exposes ignored files via
    `git ls-files --others --ignored --exclude-standard -z`.
  - `src/indexer.ts` disables clean same-HEAD reuse when any ignored path would
    be scanned by Parallax, preserving correctness without adding a file
    manifest schema.
  - `tests/parallax.test.ts` covers the clean-status/new-ignored-source
    regression.
- S1 ignored-target guard verification:
  - `npm run check`
  - `node --import tsx --test tests/parallax.test.ts --test-name-pattern "same-HEAD|git-ignored|resource skips|new git-ignored"`
  - `node --import tsx --test tests/index-delta.test.ts tests/incremental-index-oracle.test.ts`
  - `npm run docs:lint`
  - `git diff --check`
  - `npm run build`
  - `npm run bench:perf -- --scales 10`
  - `npm audit --audit-level=high`
  - `npm test`
  - `npm run bench`
  - `npm run test:dogfood`
- Refreshed web/GitHub signals for the next improvement candidate.
  - GitHub still has only issue #3 open and Dependabot PRs #23-#31 open.
  - Official Nx/Bazel affected-target docs still point to executable
    verification planning as the clearest unshipped user-facing gap.
  - Repo-map/agent context tools still reinforce that the next output should
    be compact and ranked rather than a separate heavy integration.
- Shipped D9 affected verification planner slice.
  - `src/repo_map.ts` now builds `verificationPlan` from existing
    `ImpactReport.actions`, nearest `package.json` package roots, repo-map
    affected/test/doc/config/work artifact sections, and context-pack limits.
  - Planner groups recommended actions by package root / runner into ranked,
    copy-pasteable commands and reports covered changed / affected / target
    paths, source actions, confidence, and omitted counts.
  - `parallax repo-map` human output prints the verification plan; JSON and MCP
    structured output include it.
  - Docs/backlog now mark D9 shipped and move residual S1 scan-cost work behind
    an adapter-contract design.
- D9 focused verification:
  - `npm run check`
  - `node --import tsx --test tests/repo-map.test.ts`
  - `node --import tsx --test tests/mcp.test.ts --test-name-pattern "repo_map"`
- D9 final verification:
  - `npm run check`
  - `npm run docs:lint`
  - `node --import tsx --test tests/repo-map.test.ts tests/mcp.test.ts --test-name-pattern "repo_map|RepoMap|buildRepoMap|repo-map"`
  - `npm run build`
  - `git diff --check`
  - `npm test`
  - `npm run bench`
  - `npm audit --audit-level=high`
  - `npm run test:dogfood`
- Shipped S4 measured perf baseline limits.
  - Rechecked external direction against Nx affected commands, Bazel query,
    Turborepo affected tasks, and Bazel GitHub issues about
    reverse-dependency/rule-key based changed-target selection.
  - Captured local baseline metadata: commit `f8f6060`, Node `v24.14.0`, npm
    `11.9.0`, macOS Darwin 24.6.0, Apple M1 Max, 10 CPU cores, 32 GiB RAM.
  - `npm run bench:perf -- --scales 1000,2000` completed and is now recorded
    in `docs/verification*.md`.
  - `npm run bench:perf -- --scales 10000` emitted no table within about 20
    minutes and was interrupted. 50k was not started because the 10k full-phase
    run already exceeded this local limit.
  - Backlog now moves to D2 trend metrics.
- S4 measured limit verification:
  - `npm run bench:perf -- --scales 1000,2000`
  - `npm run bench:perf -- --scales 10000` (interrupted after about 20 minutes
    without an output table)
  - `npm run docs:lint`
  - `git diff --check`
  - `ps -axo pid,ppid,stat,etime,pcpu,pmem,command | rg 'impact-perf|bench:perf|tsx bench/impact-perf' | rg -v 'rg ' || true`
