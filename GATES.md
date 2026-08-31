# Gates

Evidence is current only when the command and result are recorded in this file. A focused pass proves only its named scope.

## Active S1 Correctness Gate

- [x] RED: `node --import tsx --test tests/incremental-index-oracle.test.ts`
  passed 3/4 and failed because a `tsconfig.json` alias-only edit did not update
  `src/app.ts` from `src/session.ts` to `other/session.ts`.
- [x] GREEN: the same oracle resolves the final alias, equals a fresh full index,
  and reports `mode=full` for changed context (4/4 passed).
- [x] Scope safety: target-only content scope alone cannot authorize changed-only
  carry-forward; the foreign-source event regression drops vanished rows, while
  zero-change dirty runs still skip adapter startup (focused 4/4 passed).
- [x] Upgrade safety: `extractor_version` includes the indexer-semantics revision;
  a synthetic pre-fix cohort forces one rebuild.
- [x] Focused delta, registry, oracle, perf-formatting tests pass (26/26), and
  bounded `bench:perf -- --scales 200` reports `edit_reindex_ms=383.0` with
  `edit_scan_ms=17.6` as advisory evidence.
- [x] Final-tree `npm run verify` passes after the CodeQL corrective slice:
  lint/schema drift, install smoke, 697/697 tests, dogfood 2/2, deterministic
  bench 78/78 at score 0.9987, and the dependency audit gate all completed.
- [x] `git diff --check` passes; final intended-file review remains before checkpointing.
- [x] No owned Parallax test process remains. The final run's 650 recent
  `parallax-*` fixture directories were moved recoverably to
  `~/.Trash/Parallax-Codex-20260831-codeql-tests.qvAnPM`; no recent match remains.

## Deferred S1 Read-Reduction Gate

Before selective reads, define and enforce emitted-row ownership separately from
`fileContentScope`. Add deterministic file/byte read counts before claiming a
win; timing alone is advisory. Until then every changed-body run stays on the
conservative full-read/full-extraction path.

## Documentation Gate

- [x] `PLAN.md`, `BACKLOG.md`, `IMPROVEMENT_OPPORTUNITIES.md`, `DECISIONS.md`, and EN/KO/ZH verification/roadmap docs describe the same boundary.
- [x] `CLAUDE.md` loads `PLAN.md` before the historical local handoff.
- [x] `docs/CODEX-NAVIGATION-GUIDE.md` exists and matches current ownership/navigation.
- [x] `npm run docs:lint` passes.

## Dependency Audit Gate

- [x] `npm audit fix` refreshed only lockfile-resolved transitive packages and
  removed all six fixable high-severity findings.
- [x] `npm run audit:dependencies` accepts only the exact four remaining
  high-severity nodes/advisories plus their locked versions/edges, expires at
  `2026-10-01T00:00:00Z`, and fails closed on drift, malformed/failed audit
  execution, or expiry. Low/moderate findings remain outside the high-severity
  threshold instead of being silently promoted into release failures.
- [x] `npm run test:security` passes 9/9, including threshold, drift, expiry,
  command/JSON failure, and secret-safe diagnostic regressions.
- [x] Forced package overrides were rejected: the reachable Transformers /
  ONNX path has no compatible upstream fix to smoke-test, so the exception is a
  time-bounded risk acceptance rather than remediation.
- [x] The final current-tree `npm run verify` reached this gate and accepted
  only the pinned, expiring exception; focused security remains 9/9.

## PR Code Scanning Gate

- [x] PR #35's first GitHub Advanced Security result reported four new high
  alerts: polynomial Python test-name regex, duplicated/mis-anchored repo-map
  test regex, SCIP source-read TOCTOU, and SHA-1 over redacted evidence input.
- [x] Focused local correction passes 24/24 plus security 9/9, typecheck,
  docs lint, and `git diff --check`. The two regexes now use linear shared
  classification; SCIP document bodies come only from embedded text or an
  immutable clean Git blob, while existing indexed metadata remains unchanged;
  evidence IDs use SHA-256. A two-process regression proves SCIP takes its
  SQLite snapshot lock before Git blob reads, and explicit trusted `--file`
  inputs no longer claim repository containment they cannot atomically enforce.
- [x] Independent review's P1 snapshot race and P2 input-path/documentation
  findings are corrected; final diff inspection reports no remaining P0-P2.
- [ ] Push the correction and require every PR check, including the distinct
  GitHub Advanced Security CodeQL result, to pass before merge.

## Audited UI Gate

- [x] Native selection buttons are siblings of source/copy controls; rendered
  impact and delta rows contain no nested interactive elements.
- [x] Light-surface selected focus uses `#18735f` (measured 5.29:1 against the
  selected background), while dark controls use the inverse ink token.
- [x] Reduced-motion CSS and scroll behavior are explicit; `popstate` restores
  filter, preset, and path while discrete selection uses browser history.
- [x] PNG export requires a rendered impact path and reports failure for an
  empty map instead of a false `Exported` state.
- [x] `npm run test:ui` passes 12/12. A live Playwright CLI pass exercised
  filtering, native keyboard selection, push/Back restoration, reduced motion,
  focus contrast, valid PNG download, and empty-map failure. Browser fixtures,
  downloads, and processes were cleaned after the pass.
