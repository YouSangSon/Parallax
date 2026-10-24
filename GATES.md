# Gates

Evidence is current only when the command and result are recorded in this file. A focused pass proves only its named scope.

## S1 Current-Cohort Clean Reuse — 2026-10-25

- [x] Regression-only `74101645` failed remote `npm run verify` in exactly
  2/737 tests: restoring clean HEAD selected a historical cohort, and a real
  child CLI writer moved rows between candidate/count queries. The other
  735 tests passed; later canonical stages were not reached.
- [x] The independent review found a pre-plan overtaking schedule even after
  the first cache fix passed 738/738. Regression-only `b5e6d1c` reproduced it:
  738/739 passed; only the actual child-CLI scan-observer schedule failed with
  an empty latest cohort. Publication also rejects a completed ID greater than
  or equal to its own, preserving cohort publication order without a new epoch.
- Reuse now selects the latest completed row before testing cache fields and
  reads candidate/files/coverage/counters in one short DEFERRED snapshot.
  Hit/miss/error releases it; fatal reuse errors close the caller's DB.
  This changes no extraction output or empty-repository semantics.
- Exact-head mandatory remote CI owns the database oracles and final gate;
  local execution is limited to type/docs/schema and diff checks.

## S1 Publication Admission — 2026-10-25

- [x] Remote `npm run verify` at regression-only `6a643420` failed 1/732:
  the new overlapping no-op oracle observed an empty latest graph. The other
  731 tests passed; this failed run did not reach later canonical stages.
- [x] Before graph/version/transaction writes, publication now checks the exact
  planned completed run ID (including null) and main branch ID/head while holding
  the SQLite writer slot. A mismatch rejects the stale run with a retry message;
  no automatic adapter replay or long-lived adapter transaction is added.
- [x] Local `npm run lint` (type/docs/schema) passes; after the independent
  review's barrier-cleanup correction, `npm run check` passes again. No local
  database/integration/full-suite execution was performed for this slice.
- Independent data-integrity review found no remaining production/test blocker.
  The added remote oracles cover overlapping no-op, full reverse completion with
  and without a baseline, and memory-head movement during adapter startup.
  Final head `f53d2552` passed all five PR checks: 735/735, dogfood 2/2,
  benchmark and audit. PR #47 merged as `3183802` with exact tree equality;
  all four main workflows passed. This does not establish filesystem snapshots
  or atomicity of all trace writer statements.

## S1 Scanner Read Baseline — 2026-10-24

- [x] The new counter regression failed before implementation because scan
  observations had no read counts. After the change, the scan-metrics,
  synthetic-repo and fresh-index oracle suites pass 10/10 with file concurrency
  1; TypeScript no-emit check, docs lint and diff checks pass.
- [x] Integration with the corrected no-op carry passes 16/16 focused cases.
  The repeated 20-file probe retains the same deterministic read/byte counts.
- [x] `node --import tsx bench/impact-perf.ts --scales 20` reports 20 body
  reads / 1,143 bytes for each full, non-git no-op and edited run. The fixture
  produces 19 affected files. This proves the counters and unchanged read cost,
  not a performance improvement or device I/O measurement.
- [x] Independent review found no blocking issue. Counts include unsupported
  recognized-language bodies and bounded samples, use raw returned byte sizes,
  and leave `IndexResult`/CLI output unchanged. Clean same-HEAD reuse emits no
  scan observation; failed scans do not publish a partial counter result.
- [x] PR #46 final head `845343a` passed remote `npm run verify`: 731/731,
  dogfood 2/2, bench and audit. All five PR checks and all four main workflows at
  `7a05f81` succeeded. Main Security's first install timed out in the upstream
  ONNX download; only that failed job was rerun at the same SHA and succeeded.
  No selective extraction or read-skipping is enabled.
- PR #46's first CodeQL summary rejected a stat(path)/readFile(path) race.
  A tiny filesystem-only fixture reproduced path replacement bypassing the
  checked size and same-file growth. The first replacement fixture also removed
  a pending directory entry; that harness issue was corrected before recording
  the product failure. Both logs remain separate.
- [x] Reads now share one checked regular-file descriptor and allocate at most
  its approved body size. Eight filesystem-only cases pass, covering raw/empty/oversize
  counts, optional sample failure, symlink replacement, path replacement,
  growth, short reads and read-error descriptor cleanup. Local full verification
  was cancelled on the finding; under the revised user goal only lightweight
  local checks and the existing mandatory remote CI may establish this slice.
  Final CodeQL clearance and exact-head CI passed as recorded above. Windows execution
  and atomic parent-directory snapshots are outside the proven boundary.
  Initial open failure fails the scan; optional sample-read failure after opening
  preserves a skip. Independent final security review found no blocker.
  Typecheck, schema drift, documentation lint and diff checks pass.

## S1 Output Ownership Gate — 2026-10-24

- [x] Before implementation, the two focused regressions for foreign entity
  rejection and unchanged legacy-to-owned transition failed with missing
  expected rejection.
- [x] `node --import tsx --test --test-concurrency=1
  tests/adapter-output-ownership.test.ts tests/adapter_registry.test.ts
  tests/config-infra-adapter.test.ts tests/incremental-index-oracle.test.ts`
  passes 31/31; `tsc -p tsconfig.json --noEmit` passes. Cases cover invalid
  ownership, preserved graph/current-state tables, declaration invalidation,
  input isolation, post-yield/dispose mutation, config/infra and fresh-index
  equivalence under the existing full-extraction policy.
- [x] Independent data-integrity review found and addressed mutable event
  references and non-file identity scope before delivery; final code review
  found no blocking issue in this bounded contract.
- Local canonical verification of the first head passed 663/713 tests; 48 MCP
  waits, a CLI null child status and a SCIP startup marker wait failed. Serial
  recovery was interrupted after repeated failures. Exact-head Linux CI passed
  713/713, dogfood, benchmark and audit; this does not make the local run green.
- [x] Phase diagnostics identified a 5,048 ms MCP initialize timeout before any
  output, while completed initialization took 2,353–4,089 ms and later requests
  2–324 ms. The bounded test harness now allows 30 seconds for initialize,
  CLI child execution and SCIP startup markers; post-init RPCs retain 5 seconds
  and the SCIP lock assertion is unchanged. The three affected failure cases
  pass with file concurrency 1. This is test robustness, not a latency gain.
- The pre-carry head `394ede7` subsequently passed local canonical verification:
  715/715 tests, dogfood 2/2, benchmark and audit; all five remote checks passed.
- [x] Six no-op oracles reproduced loss of descriptor metadata, file/global
  diagnostics, custom contract versions and foreign placeholders, including a
  SCIP-augmented cohort. Separate regressions reproduced trace confidence
  downgrade and SQL rollback masked by a duplicate snapshot restore.
- [x] No-op carry now copies versions/diagnostics and keeps scanner skips fresh;
  cloned external adapter audits and remapped relation ownership let SCIP
  reimport remove vanished rows. Runtime-proven co-change confidence survives.
  Publication failure leaves graph/version/fact/branch rows unchanged and records
  a failed index run. Focused ownership/registry/config/oracle/trace tests pass
  39/39 and typecheck passes. The semantics revision forces one full rebuild;
  external SCIP/trace augmentation must be reapplied after a full rebuild.
- [x] Clean same-HEAD reuse, dirty no-op startup skipping and one-time revision
  rebuilding pass 3/3. Independent final data-integrity review found no blocker.
- [x] Final head `2607ea4` passed canonical verification after the dependency
  refresh: 721/721, dogfood 2/2, benchmark and audit; all five PR checks passed.
  PR #44 merged as `5876ee1`, with source/main tree equality verified.
  No selective extraction or read-reduction claim is made by this unit.

## Dependency Refresh — 2026-10-25

- The resumed PR's security job rejected two high findings in body-parser and
  zod. A fresh npm audit reproduced both; the old zero-findings receipt does not
  establish the current registry state.
- Compatible `npm audit fix --package-lock-only --ignore-scripts` changes only
  body-parser 2.3.0 to 2.4.0, iconv-lite 0.7.2 to 0.7.3 and zod 4.3.6 to 4.6.7.
  Direct ranges, overrides and the fail-closed audit policy are unchanged.
- [x] Clean native Node 24.14.0 `npm ci` completed with zero vulnerabilities.
  Canonical verification and exact-head CI passed at `2607ea4` before PR #44
  landed; the pre-patch command's audit failure is retained separately.

## CLI Help Safety Gate — 2026-10-23

- [x] Isolated CLI regression reproduced `index --help` returning an index
  result instead of help. The initial harness heading mismatch was corrected
  separately before recording this product failure.
- [x] `node --import tsx --test tests/cli-help.test.ts` passes 2/2 after the
  correction: 16 help prefixes exit without filesystem changes, including
  UI/MCP servers and all five nested command families. Literal `-h`/`--help`
  option values and missing-value, integer and invalid-subcommand errors retain
  their existing behavior.
- [x] Independent review caught an option-before-help validation regression;
  the nested prefix guard now rejects option-prefixed subcommand tokens, with
  explicit `workspace --name --help` and `scip --file -h` regressions.
- The final PR checks and resume evidence bundle own canonical verification,
  landing and cleanup results for this slice. No UI/runtime-model changes are
  included, so prior browser and native embedding evidence retains its scope.

## Portfolio Readiness Gate — 2026-10-23

- [x] Reproduced `npm run audit:dependencies` failure on the expired exception.
  Raw audit: 6 high, 1 critical, 3 moderate; all reported fixes available.
- [x] `npm audit fix` (no force/override) changed only the lockfile and reported
  zero vulnerabilities. Direct dependency ranges are unchanged.
- [x] Removed the exception; focused `tests/security.test.ts` passes 9/9,
  including former-exception rejection, high/critical thresholds, malformed
  reports, exit mismatches and secret-safe failures.
- [x] Actual `computeEmbedding` smoke with default `Xenova/multilingual-e5-base`
  q8 on macOS arm64 / Node 24.14.0 produced a nonzero 768-dimensional,
  768-byte int8 vector; repeat input was identical. This is local CPU inference,
  separate from the canonical suite's deterministic embedding stub.
- [x] Clean `npm ci` and canonical `npm run verify` pass on Node 24.14.0 /
  macOS arm64: lint/schema/build, 697/697 tests, dogfood 2/2, deterministic
  bench 78/78 with no unexpected relations, and dependency audit. The run
  completed 2026-10-23 05:34:38 UTC; test fixtures used an isolated TMPDIR.
- [x] Packaged CLI session-change workflow: 19 commands with expected exits;
  two failing tests become two passing tests after the recommended targets are
  updated. Hand-labelled fixture: expected 4, found 5, missing 0, extra README
  candidate 1. This is fixture evidence, not a general accuracy claim.
- [x] Actual stdio MCP: initialize, 24 listed tools, analyze, context brief,
  path-escape rejection, and unchanged source hashes.
- [x] Live browser: filter, selection, keyboard Enter/Tab and focus, history,
  policy selection, language, report selection, zero affected targets, missing
  report, source rendering, and reduced motion. Postman source escape returns
  expected HTTP 400. The initial headless driver verified Blob payloads and
  clipboard denial; a native Brave follow-up verified link/command clipboard
  contents, actual JSON/CSV/PNG files, source opening in a new tab and returning
  to the same report/language, and Back/Forward path/filter/preset restoration
  with matching visible inspector content.
- [x] Confidence badge regression reproduced at 1.93:1 proven / 2.32:1 heuristic
  on dark cards. Final computed contrast is 5.29:1 / 5.08:1. Desktop 1440px and
  mobile 390px screenshots inspected; mobile document/body have no horizontal
  overflow, with intentional contained metric/SVG scrolling.
- [x] Final UI source `npm run verify` completed at 2026-10-23 05:52:42 UTC:
  lint/schema/build/install smoke, 697 tests, dogfood 2/2, bench 78/78, and audit.
  That packaged runtime differed from the CLI/MCP-tested artifact only in UI
  styles; the later PNG correction also changes the UI client.
- [x] Actual PNG inspection exposed pale map headings on the hard-coded light
  canvas. Export now uses the existing `--graph` background. Saved 760x580 PNG
  pixels match `#263d32`; heading contrast improves from 1.74:1 / 1.33:1 to
  6.58:1 / 8.63:1. Before/after files and native observations are preserved.
- Follow-up `npm run verify` after the PNG change ended at 06:50:45 UTC with
  lint/build/install smoke passing and 684/697 tests passing. Eleven MCP
  response waits, one CLI child deadline and one SCIP fixture wait failed
  while host load exceeded 200 on 10 logical CPUs. The full command did not
  pass; its downstream dogfood/bench/audit commands were not reached.
- [x] The 13 failed cases passed with test-file concurrency 1 and unchanged
  deadlines. The unreached commands then passed separately: dogfood 2/2,
  bench 78/78 expected relations and dependency audit, ending at 07:00:12 UTC.
  This is scoped recovery evidence, not a successful full local command.
  The final PR's checks own remote validation of its exact head.
- [x] Advisory `npm run bench:perf -- --scales 200,1000` on macOS arm64 / M1 Max:
  1,000 synthetic files indexed in 4,957 ms; edited reindex 6,528 ms. Single run,
  sampled RSS, no production-performance claim or performance gate.
- [x] Independent final security review found no P0–P2 issues in the dependency
  gate, tests, lockfile and documentation diff.
- [x] PR #38 and #39 passed all five remote checks and merged to main as
  `27865fe` and `d4cac49`. Each later PR owns its checks and merge event.
- Portfolio provenance, final landing and exact cleanup receipts are maintained
  in the resume evidence folder referenced by `CONTEXT.md`; no remote deployment
  or paid inference was performed.

## Main-only Scorecard Follow-up — 2026-10-23

- Re-audit found that the successful PR checks did not cover the main-only
  Scorecard workflow. Run `39917147939` failed during job setup because
  `ossf/scorecard-action@v2` has no matching branch or tag; analysis never ran.
- The action reference now pins the verified `v2.5.0` release commit. Existing
  triggers, permissions, publication and upload steps are preserved. This pins
  the action metadata, not the upstream container image's version tag.
- Local workflow semantic validation and documentation lint own the pre-merge
  evidence. The final PR checks and exact merge SHA's main workflow runs own
  remote evidence; PR success alone does not establish Scorecard execution.
- [x] PR #41 merged as `6774e64` after all five PR checks passed. On that exact
  main commit, CI `39937453188`, Security `39937453163`, CodeQL `39937453157`
  and Scorecard `39937453174` completed successfully. CI's `npm run verify`
  passed 697 tests, dogfood 2/2, bench 78/78 and the dependency audit. Scorecard
  analysis, artifact/SARIF uploads and public result commit matching passed;
  this does not mean zero advisory findings or complete control visibility.

## Prior S1 Correctness Gate

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
- [x] `git diff --check` and the final intended-file review passed before checkpointing.
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

## Historical Dependency Audit Gate — superseded 2026-10-23

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
- [x] Correction commit `eb21527` was pushed. CodeQL, gitleaks, dependency
  audit, JavaScript/TypeScript analysis, and the 6m28s Release gate all passed;
  PR #35 then squash-merged to `main` as `4f289a6`.

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
