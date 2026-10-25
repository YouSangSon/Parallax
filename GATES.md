# Gates

Evidence is current only when the command and result are recorded in this file. A focused pass proves only its named scope.

## Workbench Export Feedback — 2026-10-25

- Clipboard follow-up: the emitted-client regression reproduced a false legacy
  copy result being displayed as success. The shared helper now throws on that
  result so both link and command controls use their existing failure handling.
  Bounded tests exercise true/false/throw results, localized/fallback feedback,
  exact copied text, temporary textarea cleanup and restored button state.
  Modern Clipboard API resolution/rejection stays separate; a rejection does
  not retry the legacy path. Real legacy-browser execution is not claimed.
  Source contract: [W3C copy action](https://www.w3.org/TR/clipboard-apis/#copy-action).
- [x] `node --import tsx --test --test-concurrency=1 tests/ui-toolbar-feedback.test.ts`
  passes 4/4; `npm run lint`, `npm run build` and `git diff --check` pass.
  Local execution contains no DB/app/integration suite. The final PR and main
  required checks retain their own commit-specific receipts.

- The `70ccf92` npm package passed the approved VM's 19-step public CLI fixture,
  real stdio MCP (24 tools), invalid-path controls, and saved-graph equality after
  a later full reindex. Native desktop inspection covered filtering, selection,
  Strict policy, copied link state, history restoration, source new-tab/back
  links, EN/KO/ZH, keyboard focus, zero-impact and missing-report states.
- PNG output was saved through the native browser dialog and decoded as a
  760×580 PNG. Waiting for the automated download event timed out. The enclosing
  UI observation later reached its own deadline and exited 1; its finally cleanup,
  absent UI process/port/path and released lock were verified separately. This
  is not an all-green wrapper or a 375-pixel result: actual width stayed 2560.
- The missing-map PNG guard rejected export, but its button said "Copy failed".
  The emitted-client regression reproduced that error without local DB/app
  execution. The shared handler now accepts action-specific failure text;
  JSON/CSV/PNG use EN/KO/ZH export messages and copy retains its prior messages.
  Pure tests cover localized/fallback failures, no file on failed export,
  successful JSON/CSV/copy feedback and restoration. Rendered locale payloads
  remain covered by remote UI tests. No full local suite is run.
- [x] Candidate `48907f2` was freshly built and packaged; only `dist/src/ui.js`
  and `dist/src/ui/client.js` differ from the public-flow archive. The approved
  VM displayed `Export failed` / `내보내기 실패` / `导出失败` for missing-map PNG
  export, with no SVG, while Korean copy success still displayed `복사됨`.
- [x] Activating the owned tab and using native DevTools established an actual
  375×812 CSS-pixel viewport, document/body width 375 and a saved 750×1624 image.
  Image pixels are separate from CSS pixels. Prior request-only attempts and
  an emulated-mode CDP click timeout are not counted as passing checks. Device
  defaults, device mode and DevTools were restored; the final width was 2560.
  Normal VM shutdown and cleanup passed after this narrow recheck. Exact final
  PR/main gates remain separately owned by the PR and portfolio receipts.

## Config/Infra Selection Contract — 2026-10-25

- [x] Bounded process-local memo tests pass 11/11, including actual computation
  misses/hits across new instances, exact body/language/path/order/root identity,
  empty output, partial/failing generators, mutation isolation, interleaved runs
  and payload/entry eviction. Earlier independence checks use cold namespaces.
- A new remote public-indexer oracle compares warm source/config/path edits with
  cold fresh graphs, versions, coverage, counters, current adapter audit,
  redacted facts/provenance and saved reports. A separate trigger checks that
  both miss and hit still fail publication, preserve the old graph and publish
  no valid receipt; recovery reuses computation through normal publication.
  These DB tests are not run locally; exact PR/main gates own their results.
- Paired pure Git-corpus arrays match base `63c17db` for Parallax and Codex.
  Codex's 28 configs compute 28/0/1/28 times for cold/warm/one-body-edit/path-change;
  observed windows are 32.719/6.955/8.436/22.651 ms. Corresponding uncached original,
  edited and path-change windows are 43.705/18.694/17.444 ms. These are single
  ordered observations with startup/JIT/instrumentation effects, not a latency
  distribution, a CLI speedup or a read reduction. The unchanged reference is
  still `970111f6`; freshness against its remote is unverified.
- Only repeated same-process public API calls can benefit. No daemon, general
  independence flag, persistent raw-event cache or selective SQL carry is added.
  Local checks remain pure/type/build/docs/schema; existing remote canonical
  verification must pass before landing.

- [x] A bounded pure observation uses immutable Git workflow blobs and recognized
  tracked-language path context. The fixed old compiled adapter and candidate
  `808ce5f` produce equal full event arrays for Parallax/Codex forward, reverse
  and individual-file processing, plus 1298 boundary/exotic/Unicode cases.
  The context bodies/hashes are inaccessible. Timing includes start and
  consumption; it is not whole-index latency, CPU time or a read reduction.
- [x] `node --import tsx --test --test-concurrency=1 tests/config-infra-selection.test.ts`
  passes 5/5 before and after the change. `npm run lint`, `npm run build` and
  `git diff --check` pass. Independent design and implementation reviews approve
  the preserved ordering/fallback/evidence/cache boundary. Final PR/main gates
  remain owned by their exact remote receipts; no full local suite is run.

- [x] The approved my-cloud measurement used the PR #55 / `5fc6cba` package,
  verified artifact/module hashes, a nonblocking shared process lock, and actual
  cgroup limits of one CPU and 1 GiB. Provider-billed usage was below the agreed
  hold threshold; delayed aggregation and unconfirmed overage blocking remain
  separate limitations. No host installation, credentials or Docker permissions
  were changed. See [observations](docs/verification.md#config-extraction-observations).
- [x] All three profile phases returned full extraction, 23 body reads and three
  nonempty config process samples. The enclosing runner later failed an optional
  help assertion: the CLI prints `Commands:`, not `Usage`. Its valid profile
  output is retained; the full profile was not repeated to repair that assertion.
- [x] A separate narrow run checked CLI help exit 0, invalid observer invocation
  exit 2, both expected messages and no fixture residue. It exited 0. Locked npm
  install used disabled lifecycle scripts; default embeddings and a general
  installed-package workflow were not tested on this VM.
- [x] Ordinary/failure cleanup and a forced service-timeout cleanup were observed.
  Final checks found all owned units inactive, owned execution paths absent,
  no Node process and the shared lock available. Original shared resources stay
  outside this cleanup scope. Selective runtime extraction remains deferred.
- PR #54's persisted full/reversed and stateful-fallback gates passed 771/771,
  dogfood 2/2, benchmark/audit, all five PR checks and all four main workflows.
- The config extraction observer uses a small non-Git fixture and the existing
  scanner observer. Only its pure wrapper is executed locally; the remote
  correctness case checks phases, event/file counts and runtime hashes without
  timing thresholds. Actual VM observations remain separate from those checks.

- [x] `node --import tsx --test --test-concurrency=1 tests/config-infra-selection.test.ts`:
  3/3 pure cases pass without DB, services, filesystem fixtures or model access.
  Exact emitted events agree for full/reversed/single-file processing and an
  edited target, while context content/hash getters throw on access.
- [x] Removing an indexed target path changes an unchanged Dockerfile's output;
  path-set invalidation is required. Nonempty target/evidence assertions prevent
  vacuous equality. Product code, schema and adapter declarations are unchanged.
- Added remote persisted oracles compare reversed config/infra full processing
  with fresh full graph tables, report JSON and exported report graphs after
  target edits and path removal. Earlier saved reports must remain unchanged.
- A run-local ordinal adapter declares both target-only content and
  processed-file ownership but emits a different relation if an earlier process
  call is skipped. Its changed-body oracle requires all files to be processed
  and compares the persisted graph/report with a fresh full index.
- These additions require the remote canonical gate; no local DB/app/full suite
  is run. General adapter independence and selective runtime extraction remain
  unproven; changed-body full fallback stays active.

## Git Cache Input Validity — 2026-10-25

- [x] Regression head `48e2f53` at PR merge `3565445` failed 8/758 remote tests:
  seven hidden-body cases plus same-HEAD shallow deepen. All eight actual CLI
  controls matched fresh full graphs. Later Verify stages were not reached.
- [x] `5f5120f` adds actual DB mutable-supports cache/normal-delta oracles:
  remote Release failed exactly 10/760, including both new cases; 750 passed.
  These are separate failures, not a passing overall gate or a local DB run.
- Implementation captures ordered scanner inputs before callbacks and shares the
  selected history with co-change extraction. A private nullable v17 receipt is
  committed with the graph; absent/unknown/mismatched inputs force full.
  Co-change savepoint failure keeps completed audit but no valid receipt.
- Legacy cohorts rebuild once without backfill; SCIP/trace must be reapplied,
  then actual identical-input preservation remains mandatory. V16 read APIs
  remain supported. No new CLI/JSON field or dependency is introduced.
- New remote oracles cover history loss as well as growth, legacy reapply,
  second-scan/history publication, summed benchmark read counters, receipt/graph
  rollback and partial co-change recovery. Local execution is type/lint only.
- A retained hit also checks the latest completed ID after closing its reader
  snapshot. A real child B publication followed by file restoration to A must
  leave the latest graph equal to fresh A; movement requires a new capture.
- [x] Candidate `a0d03fe` passed 768/769 remotely; only the real child B→restore A
  admission oracle failed. The follow-up guard reads the latest ID after ending
  the snapshot; same-body child movement also requires fresh capture.
- `npm run lint` (type/docs/schema) passes locally. Exact final-head Release,
  security, merge and main-run receipts are owned by [PR #51](https://github.com/YouSangSon/Parallax/pull/51)
  and the portfolio evidence owner in `CONTEXT.md`. Required checks must pass
  before landing; a focused pass is not the full gate. Selective execution and
  read reduction remain off.
- [x] Final `b239c21` passed all five PR checks: 769/769, dogfood 2/2,
  benchmark and audit. PR #51 merged as `eca7eb1` with exact tree equality;
  CI, Security, CodeQL and Scorecard passed on that main commit separately.

## S1 Recovery Bookkeeping Removal — 2026-10-25

- [x] Static call-path review found no caller of private `restore()`; its seven
  capture SELECTs only filled maps consumed by that dead method. All live
  capture sites were already inside the publication transaction/savepoint.
- [x] Removed 447 source lines and eight capture call sites, with no added source
  lines. Exact AST comparison preserves public exported functions, extractor
  identity, immutable input snapshots, writer rollback and clean-reuse snapshot.
  Public types, schema and existing tests are unchanged; `npm run check` passes.
- Independent final integrity review found no blocker. Existing rollback,
  cohort and saved-report oracles remain mandatory in remote Release; no local
  DB/integration/full suite or new implementation-mirroring test was run.
  Final head `45c4fa2` passed all five PR checks, 739/739, dogfood 2/2 and
  bench/audit. PR #50 merged as `8b337ba` with exact tree equality and all four
  main workflows passed. No latency/RSS improvement claim is made.

## Audit Setup Reliability — 2026-10-25

- Main #46 and #48 Security installs failed in the ONNX lifecycle download
  before reaching vulnerability assessment. #48 recorded ENETUNREACH/timeout;
  the same source tree passed normal install/full verification/audit in Release.
- The audit job alone uses `npm ci --ignore-scripts`. Frozen dependency/lock
  validation and the fail-closed high/critical/JSON/command gate remain intact.
  Gitleaks, workflow triggers/permissions and normal Release installation are
  unchanged. Registry and Release download failures remain possible.
- [x] YAML parsing and an exact object-diff assertion confirm only the audit
  install command changed. No local dependency installation/full suite ran.
  PR #49 final head `2034986` passed all five checks, including Security audit
  and normal Release install, 739/739, dogfood 2/2 and bench/audit. It merged as
  `f4dc665` with exact source/main tree equality. Main-run receipts are separate.

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
- [x] Final head `54da882` passed 739/739, dogfood 2/2, bench/audit and all
  five PR checks. PR #48 merged as `ee21205` with source/main tree equality.
  Main Release also passed; its separate Security install failure is retained
  under the audit setup follow-up above. Local execution was limited to
  type/docs/schema and diff checks; no local DB/integration suite ran.

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
