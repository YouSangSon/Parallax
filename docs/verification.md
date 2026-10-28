# Parallax — Verification & Testing

**English** · [한국어](verification.ko.md) · [中文](verification.zh.md)

Parallax verifies correctness in layers: a fast unit suite, a typecheck, a docs linter, a deterministic accuracy bench, and a dogfood guard that re-indexes Parallax against itself. CI runs all of them on every push and pull request. This guide explains each layer, what it catches, and when to run it — with the key lesson that green unit tests are necessary but **not** sufficient for engine changes.

## Scripts at a glance

Every command below is an `npm run` script defined in `package.json`.

| Command | What it does | When to run |
| :--- | :--- | :--- |
| `npm test` | Runs the Node test runner over `tests/**/*.test.ts` via `tsx --test` | After any change; the default fast suite |
| `npm run check` | `tsc --noEmit` typecheck, no output emitted | Before commit; catches type regressions |
| `npm run audit:dependencies` | Runs the fail-closed high-severity dependency audit gate | Before commit / PR and in CI |
| `npm run lint` | `check` + `docs:lint` together | Before commit / PR; the full static gate |
| `npm run docs:lint` | Runs `scripts/docs-lint.js` over tracked and untracked Markdown, including local `.md` link targets | After editing any doc |
| `npm run verify` | Runs the canonical source-checkout release gate: lint, install smoke, fast tests, dogfood, bench, and high-level audit | Before release and in CI |
| `npm run build` | `tsc -p tsconfig.json`, compiles to `dist/` | Before publishing or smoke-testing the CLI |
| `npm run bench` | Runs `bench/impact-bench.ts`; exits non-zero on accuracy regression | After engine/adapter changes |
| `npm run bench:report` | Renders the latest bench JSON as Markdown, optionally comparing it with a baseline report | After `npm run bench`, or in CI summaries |
| `npm run bench:perf` | Runs `bench/impact-perf.ts`; times full index, no-op incremental index, edited-file reindex, their scan phases, analyze phases, and observed peak RSS on a synthetic repo (non-deterministic, not in `verify`) | When working on indexing/traversal performance |
| `npm run test:dogfood` | Indexes Parallax on its own source and asserts the internal graph survives | After engine changes (indexer/adapters/analyzer/store/graph) |
| `npm run test:mcp` | Runs `tests/mcp.test.ts` (impact / context / memory / telemetry / path validation) | After MCP surface changes |
| `npm run test:ui` | Runs `tests/ui.test.ts` (UI snapshot, server, JSON resource endpoints) | After UI changes |
| `npm run test:security` | Runs `tests/security.test.ts` (path containment, redaction, dependency audit gate) | After store / path / redaction / audit-gate changes |
| `npm run test:install-smoke` | `npm run build` then `node dist/src/cli.js --help` | Before release, to confirm the packaged CLI launches |

`bench:perf` also reports `*_scan_body_reads`, `*_scan_body_bytes`, `*_scan_sample_reads` and `*_scan_sample_bytes` for full/no-op/edit runs. These count successful scanner reads and bytes returned by the file API, including recognized files that no adapter supports and bounded samples of oversized files. They exclude Git/metadata work, custom-adapter reads and device/cache I/O. Both non-git no-ops and clean same-HEAD validation read bodies. A cache miss can scan twice; counters and durations sum both scans. `IndexOptions.perfObserver` receives these counts as an optional third argument after a completed scan; a failed scan has no counts. The CLI/index result shape is unchanged.

`test:fixtures` is an alias for `npm test`, and `test:benchmark` is an alias for `npm run bench`. `npm run verify` includes `npm run audit:dependencies`, so its final audit stage depends on npm registry and network availability.

The dependency gate requires a valid npm audit v2 report with zero high/critical
findings and exit code 0. Low/moderate-only reports remain permitted; there is
no exception allowlist. High/critical findings, inconsistent counts or exit
status, malformed JSON, and command/network failures block the gate. Raw npm
diagnostics are not printed; rerun `npm audit --audit-level=high --json` locally
when raw diagnostics are needed.

The Security audit job installs frozen dependencies with `npm ci --ignore-scripts`:
native lifecycle downloads are unnecessary for its metadata audit. Lock mismatch
checks and the fail-closed audit command remain; Release retains normal `npm ci`
and full runtime verification. This does not eliminate registry or Release network
failures. See [npm's option contract](https://docs.npmjs.com/cli/v11/commands/npm-ci/#ignore-scripts).

## The dogfood guard — the real safety net

`tests/dogfood.integration.ts` is the most important layer to understand. It exists because a green unit suite once coexisted with a totally broken internal dependency graph: real NodeNext `./x.js` imports collapsed to `external_entity`, so a heavily imported module reported **zero** code dependents while every unit test stayed green. The unit suite simply did not look at the real engine output the way a user does.

The dogfood guard closes that gap. For each test it:

1. Copies Parallax's own `src/` into an isolated temp repo, then runs `initProject` + `indexProject` on it — the real user path.
2. Calls `analyzeDiff` for `src/store.ts` and asserts there are at least `MIN_PROVEN_SRC_DEPENDENTS` (5) dependents under `src/` with `proven` confidence, and that the top-ranked affected file is itself a `proven` `src/` dependent (this also guards confidence-first ordering).
3. Opens the canonical store read-only and runs raw SQL over the `relations` + `entities` tables: it counts `DEPENDS_ON` edges whose target is a local `src/%` entity with `kind != 'external_entity'` (must exceed `MIN_INTERNAL_DEPENDS_ON_ROWS`, 20), and counts `proven` `src/%` dependents of `file:src/store.ts` (must reach the floor of 5).

The assertions use **floors, not exact counts**, so legitimate refactors do not break the test. The discriminator is the *collapse to ~0* the original bug produced, not any precise number. The SQL deliberately targets the canonical `relations` + `entities` tables and the `external_entity` collapse — that is exactly the failure mode it guards.

### Why it is not in `npm test`

The default suite globs `tests/**/*.test.ts`. The guard is named `tests/dogfood.integration.ts` — it does **not** match `*.test.ts`, so the glob skips it by design (it is also slow, since it re-indexes the whole source tree). `npm run test:dogfood` and CI run it by naming the file directly.

**The lesson:** a green `npm test` is necessary but not sufficient. Any change to the engine — indexer, adapters, analyzer, store, graph, or cross-repo — must be dogfood-verified, because the unit suite can stay green while the real graph is broken.

## Incremental correctness gate

`IndexResult.mode = 'incremental'` requires the same verified scanner inputs and
selected Git history. Changed or unverified inputs, including unsupported bodies
and skip samples, report `mode = 'full'` and use full extraction. The
`fileContentScope` contract alone cannot authorize changed-only extraction: it
constrains reads, not ownership of emitted rows.

The regression oracle is `tests/incremental-index-oracle.test.ts`. It includes a
`tsconfig.json`-only path-alias edit and requires the rerun graph to equal a fresh
index of the same final tree. The component tests also cover a target-only
adapter that emits a foreign-source relation and later removes it.

Unchanged runs preserve entity/contract versions, adapter diagnostics and imported
SCIP relations, while scanner skips are refreshed. Reimporting SCIP replaces its
carried relations, and co-change refresh keeps runtime-promoted confidence.
Publication failures roll back all graph writes before recording a failed run.
An extractor/semantics revision change forces a full rebuild; external SCIP/trace
augmentation must be reapplied after that rebuild.

SQL transactions/savepoints own rollback. Unconsumed manual recovery snapshots
and per-row capture reads/maps were removed; input/event copies, admission and
failure audit remain. No latency or RSS improvement was measured for this cleanup.

```bash
node --import tsx --test tests/incremental-index-oracle.test.ts
```

Before any publication writes, the index transaction rechecks the exact planned
latest completed run ID (including null) and main branch ID/head. A mismatch
fails with `index publication baseline changed; retry indexing`; no automatic
adapter retry occurs. The completed ID must also be lower than this run's ID,
preventing a run overtaken during scanning from moving rows to an older cohort. This prevents overlapping no-op carries and out-of-order
full completion from replacing the current graph/head. The deterministic database
oracles run in existing remote CI under the shared-machine policy. This is not a
filesystem snapshot or an atomicity guarantee for every graph writer. The
[decision and concept reference](verification.ko.md#겹친-인덱싱의-발행-기준) describe the scope.

Clean same-HEAD reuse selects the latest completed cohort, checks its extractor,
HEAD and resource eligibility, then reads current bounded scanner inputs and
selected Git history. Their versioned digest must equal the private receipt
published with that graph. Capture precedes mutable adapter classification; the
same selected history is used by co-change extraction. No body reads are skipped.

Candidate, checks, validation and counters share one DEFERRED reader snapshot,
released on hit, miss or failure. Fatal errors close the database. A miss closes
that snapshot, allocates a new run ID and captures inputs again; it never publishes
precheck data. Even a retained hit rechecks the latest completed ID in a fresh
autocommit read after closing the snapshot; movement becomes a miss. A writer
finishing after that final admission read is outside the freshness guarantee. This can read bodies twice and hold the reader snapshot longer.
WAL avoids a writer slot, but the guarantee is one DB read point, not ongoing
freshness or an atomic filesystem/Git snapshot.

Schema v17 adds a nullable receipt without backfilling legacy hashes. A legacy,
unknown or mismatched receipt forces a full rebuild on the next index; reapply
SCIP/trace augmentation as for other full rebuilds. Later identical-input runs
preserve it. Existing v16 read APIs remain compatible. Co-change savepoint failure
keeps best-effort completed audit but stores no valid receipt, so the next run
retries fully. Graph publication failure rolls back both graph and receipt.

[PR #51](https://github.com/YouSangSon/Parallax/pull/51) records hidden Git body,
mutable classification and history-growth/shrinkage oracles. The explicit
`parallax index --max-file-bytes 1000000` path still bypasses clean reuse; it is not
needed to recheck bodies and is not selective extraction. See the
[Korean rationale](verification.ko.md#git-clean과-실제-본문-변경) for alternatives,
input scope and limitations.

Scanner checks and bounded body/sample reads share one open descriptor. Body
allocation is limited to its checked size; short reads are completed, while EOF,
size or modification-time changes fail the scan. Linux/macOS use no-follow and
nonblocking flags. Optional sample-read failures retain the skip; initial open
failure fails the scan. Platforms lacking no-follow validate leaf identity before
reading. This is not an atomic parent-directory/filesystem snapshot, and Windows
execution is unverified. `tests/scanner.test.ts` exercises these filesystem-only
boundaries without starting a database or server.
The concept reference is Codex's descriptor-bound, capped
[file reader at commit 970111f](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/exec-server/src/local_file_system_read.rs).
Parallax adapts the principle to its synchronous scanner; no source code is copied.

## Process-local config computation reuse

Repeated public `indexProject()` calls in one process may reuse the built-in
config/infra adapter's completed pure computation. Its key binds repo root,
actual target path/language/body and ordered unique indexed paths. Other bodies
are not inputs. Separate CLI processes cannot share this memo; wrapper lifecycle,
other adapters, scanning, current audit IDs and full publication still execute.
Changed inputs retain `mode = 'full'`. This is not general adapter independence,
partial row carry or a read reduction.

The memo holds at most 256 entries and 1 MiB of key/serialized-event UTF-16
payload, not an RSS limit. Oversized results continue without caching; partial
or failed generators add no entry. Both cold and hot events are fresh copies.
Raw snippets stay process-local: persisting them before publisher redaction
could expose secrets, while pre-redacting them changes `facts.redacted` audit.
A complete computation may survive later publication failure; it never proves
that a graph was published. Every retry still passes normal writer admission.

Pure tests observe actual matching rather than elapsed-time thresholds. The
remote indexer oracle requires source edits to reuse config calculations,
config edits to recompute that target and path changes to invalidate the context.
It compares cold fresh-root graph/version/coverage/counts, current relation audit,
redacted facts/provenance and saved reports; a SQL trigger tests miss/hit rollback
and recovery. Actual scanner reads are counted separately. Existing generic
stateful-adapter full fallback remains required. Earlier event independence
checks use cold namespaces so memo replay cannot substitute for fresh work.

Concept reference: Bazel's [input-keyed action cache](https://bazel.build/remote/caching)
and [hermeticity](https://bazel.build/basics/hermeticity). Only the input-identity
principle is used; no implementation, dependency, remote cache or general
hermetic-adapter claim is introduced.

## The accuracy bench

`bench/impact-bench.ts` builds a fixed multi-language fixture (TypeScript/JavaScript, JVM/Spring Boot, Python, Go, Rust, OpenAPI contracts, and build manifests), indexes it, and scores the resulting graph against a pinned set of expected relations. It pins:

- **Relation recall and precision** — every expected relation must be matched, with no unexpected relations.
- **Affected-file recall** — `analyzeDiff` for the changed file must surface every expected dependent.
- **Evidence presence, span completeness, and adapter attribution** — relations must carry evidence/spans and be attributed to the right adapter.
- **Retrieval metrics** — `searchContextForRepo` recall/precision/MRR/nDCG within a brief context budget.
- **Semantic model recall/isolation** — deterministic int8 fixture embeddings verify that semantic recall returns the expected top fact and does not leak cross-model decoys when embedding model names change.

The runner writes a deterministic JSON report and sets a non-zero exit code when the suite does not pass. There are two surfaces:

- `tests/impact-bench.test.ts` runs the bench as part of `npm test` and asserts the report shape, the pinned expected relations, and the score/recall thresholds.
- `npm run bench` runs `bench/impact-bench.ts` directly and exits non-zero on any recall/score regression — this is the form CI uses.

The deterministic bench also includes cross-repo, contract-diff, co-change, and trace-promotion lanes. The cross-repo contract-impact lane builds a two-repo workspace fixture, persists a breaking contract link through `analyzeContractDiff`, then checks that `analyzeDiff` and report-scoped graph export still expose the expected `web:src/client.ts` consumer impact. The contract-diff quality lane runs paired OpenAPI v1/v2 fixtures for removed response required properties, removed response optional properties, added request required properties, request enum-value removals, request format additions, response property type changes, response nullable additions, response format changes, and response enum-value removals, plus JSON Schema root-object and Avro top-level record required-property removal cases, then reports matched cases/changes through `contractDiffQuality`. The co-change quality lane builds a tiny git-history fixture where `src/alpha.ts` and `src/beta.ts` repeatedly change together, then checks that both `queryCoChanges` and `analyzeDiff` surface `src/beta.ts` as the expected heuristic partner through `coChangeQuality`. The trace-promotion lane ingests a runtime-observed `src/beta.ts -> src/alpha.ts` edge, then verifies the promoted relation surfaces as proven impact through `tracePromotionQuality`. These lanes gate `summary.passed` without reweighting the historical `summary.score`.

Run `npm run bench` after any change that touches relation extraction, ranking, or retrieval.

`npm run bench:report` converts `.parallax/bench/impact-bench-report.json` into a compact Markdown summary. Pass `--baseline <json>` to include delta columns against a previous report, or `--github-step-summary` to append the summary to GitHub Actions' step summary. CI uses this on pull requests by generating a baseline report from the PR base SHA, then reporting the head-vs-base bench delta after `npm run verify`.

## The performance bench

`bench/impact-perf.ts` (run via `npm run bench:perf`) measures full index, no-op incremental index, edited-file reindex, their scan phases, and analyze cost on a **deterministic synthetic repo** (`bench/synthetic-repo.ts`) at increasing scales — a hub of modules where changing the leaf ripples to every importer, stressing the analyzer's reverse-dependency traversal. It is intentionally **separate from the accuracy bench and `npm run verify`**: timing and peak RSS are non-deterministic, so they must never reach the byte-identical `impact-bench-report.json`. Use it to capture a baseline or to check a suspected regression while working on the indexer or analyzer; in CI it can gate with a generous `--max-ms-per-kfile` ceiling over the worst index phase.

```bash
npm run bench:perf -- --scales 1000,10000        # custom scales
npm run bench:perf -- --max-ms-per-kfile 2000    # fail above the ceiling
```

For comparable large-repo baselines, use 10k and 50k files on a clean checkout:

```bash
npm run bench:perf -- --scales 10000,50000
```

Record the command, commit, Node version, OS / hardware class, and the full output table. Treat `--max-ms-per-kfile` as a local or CI smoke ceiling only after you have a project baseline; do not wire exact timing or RSS into `npm run verify`.

The output table separates `full_index_ms`, `full_scan_ms`, `noop_incremental_ms`, `noop_scan_ms`, `edit_reindex_ms`, `edit_scan_ms`, `analyze_no_persist_ms`, `analyze_persist_ms`, `observed_peak_rss_mb`, and matching `/kfile` timing columns for the total phases. Peak RSS is sampled at phase boundaries with Node's built-in RSS reading, so it is a practical trend signal, not an exact allocator trace. The synthetic generator and table formatter are guarded by `tests/synthetic-repo.test.ts` in the normal verify gate, even though the timing run is not.

### Indexed path-token lookup

A bounded adapter-only observation on 2026-10-25 found repeated full-body path
searches on real workflow inputs. Base `5a6fbfb` and candidate `808ce5f` used
Node `v24.14.0`, `darwin/arm64`, a 256 MiB V8 old-space limit and immutable local Git
blobs. Context contained tracked paths with recognized languages, not a scanner
snapshot; remote freshness of the local reference was not checked.

| Corpus | Context paths | Workflow bodies / bytes | Base start+process (ms) | Candidate start+process (ms) |
| --- | ---: | ---: | ---: | ---: |
| Parallax `5a6fbfb` | 281 | 5 / 6358 | 1.186 | 0.751 |
| [local Codex `970111f6`](https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/.github/workflows) | 7336 | 28 / 317325 | 415.014 | 22.107 |

The reverse-order Codex observation was 410.206 / 20.077 ms. These are paired
single observations including adapter startup, collection and instrumentation;
they are not distributions, adapter CPU time, end-to-end indexing latency or a
read reduction. Source checkouts stayed unchanged; no DB, app, model or full
local suite was started. Codex supplied input data, not borrowed implementation.

The adapter now builds a per-run path lookup and scans each normalized body for
maximal tokens using its existing ASCII path-boundary character set. Original
path order still materializes results before the existing sort, preserving
collation ties and case variants. Exotic paths use the original substring
fallback; Docker COPY and evidence calculations remain unchanged. Full event
arrays matched the base for both corpora in forward, reverse and individual-file
processing, and for 1298 bounded boundary/Unicode/exotic-path combinations.
Focused tests retain original evidence and ignored-range behavior. Existing
Unicode lowercase-expansion/CRLF offset limitations are not corrected here.
No selective runtime flag, scanner read skipping or carry SQL is enabled; the
other language adapter's separate matcher is outside this observation.

### Source evidence coordinates

A later accuracy repair maps a normalized match to the same LF ordinal in the
original text and materializes that raw line range once. `İ` can expand from one
UTF-16 code unit to two during lowercase conversion; offsets in the search string
therefore cannot index the original body. Whole-string lowercase matching remains
intact because Greek final sigma is context-sensitive. Docker line iteration now
retains physical CRLF widths, and deferred-source ranges use search coordinates.
See [ECMAScript lowercase conversion](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.tolowercase).

`tests/text-reference-evidence.test.ts` covers expansion, final sigma, CRLF,
UTF-16 columns, deferred sources, empty lines and both fallback lookup forms.
Config/infra version 2 and shared regex version 39 force legacy receipts through
full extraction even when files are unchanged. Four Git/non-Git persisted oracles
in `tests/incremental-index-oracle.test.ts` seed captured legacy events, compare
rebuilding with a fresh graph and preserve saved report snapshots. Existing
SCIP/trace reapply requirements remain. Local checks exclude DB/app execution;
required remote CI owns these persisted oracles. Repeated identical source text
on one Docker line still uses the parser's existing first occurrence.

### Evidence position allocation

`offsetPosition()` now scans LF positions in the same prefix instead of creating
a line array. UTF-16 columns and existing newline semantics are unchanged, so
shared regex version 41 remains valid. The pure evidence suite passes 19/19
before and after the change, including empty lines, emoji, CRLF boundaries,
standalone CR, U+2028/U+2029 and EOF.

[Paired CI observation](https://github.com/YouSangSon/Parallax/actions/runs/40643803770)
compared baseline `be8df1a` with candidate `c287c8b` on the same immutable
`23ec770` source archive. Each fresh Node 24.21.0 process had one CPU, 1 GiB RAM
and no swap, with a 5 ms sampling profiler. Both used the full 284-file startup
context and processed the same 11 selected files. All 5,718 events had identical
per-file hashes and encoded sizes. Only the compiled shared adapter differed.

| Observation | Baseline | Candidate |
| --- | ---: | ---: |
| Profile duration | 11,820.212 ms | 10,352.266 ms |
| Sum of file processing windows | 11,327.438 ms | 9,864.443 ms |
| Cgroup peak memory | 225.82 MiB | 215.57 MiB |
| `offsetPosition` exclusive samples | 215 / 2,270 | 128 / 1,953 |

This is one ordered baseline/candidate observation, not a repeated performance
distribution. Windows include event hashing; sampling adds overhead. Events were
consumed without retention or SQL publication. Neither process hit memory limits
or OOM, and owned resources were removed. These results do not establish general
speedup, VM performance or the cause of the earlier whole-source timeout. The
temporary harness is absent from the product tree; CI history retains its source
and profile logs. Required release verification remains unchanged.

### Historical index publication diagnostic

Two bounded CI observations used the immutable `23ec770` source and runtime
(shared adapter version 39), Node 24.21.0, one CPU, 1 GiB RAM and no swap.
[The full-index attempt](https://github.com/YouSangSon/Parallax/actions/runs/40652176355)
completed all 284 file iterators and emitted 26,571 events, but did not return
before the 90-second timeout. It exited 124, produced no CPU profile and skipped
Verify. No cgroup memory-limit or OOM event occurred; the earlier VM failure
remains a separate unresolved observation.

[The smaller diagnostic](https://github.com/YouSangSon/Parallax/actions/runs/40654547854)
extracted only `src/adapters/multi-language-regex.ts`. Its 2,070 events and
1,541,387 encoded bytes matched the previous SHA-256 before publication.
All startup context, 284 body reads (4,698,579 bytes), all-body secret redaction,
metadata and scan-evidence writes remained. Other 283 extraction calls returned
empty results with diagnostic-only adapter versions: this is a partial graph.

The actual indexer returned in 5,298.948 ms, including 2,570.745 ms after collection
completed. That latter window includes SQL and bookkeeping, not isolated SQL
CPU time. All 287 source files remained byte-identical; unit exit and resource
cleanup passed with no memory-limit/OOM events. The completed CPU profile has
280 samples, including 25 exclusive samples in `persistEntityDescriptor` and 18
in the relation-evidence callback. Actual sample intervals vary despite the
configured 50 ms interval; counts are not elapsed-time shares or CPU utilization.
Use these paths for further inspection, not a full-index or VM speedup claim.
Temporary instrumentation is absent from the product tree. Canonical Verify
also passed 832 tests, dogfood 2/2, benchmark and dependency audit on this head.

### TypeScript mixed export cycles

Default-to-named and named-to-default type resolution now share visited export
keys. JSON tuple keys distinguish string export names from colon-bearing paths;
cyclic branches stop while independent concrete re-exports remain discoverable.
The same tuple representation also separates named/namespace lookup cache keys
and namespace/factory traversal keys. Otherwise a successful lookup can bind a
different export to the wrong file, or a cached miss can hide a valid target.
Shared regex version 41 invalidates older extraction receipts. Run the pure
`tests/typescript-export-cycle.test.ts` locally; required CI owns the Git/non-Git
graph, saved-report and adapter-audit checks in the incremental oracle. This
fix does not establish the cause of the earlier whole-source VM timeout. Captured
version 40 events additionally exercise unchanged-input upgrades and preservation
of the earlier saved report.

### Docker source operand spans

The follow-up replaces the first-occurrence limitation above with raw COPY/ADD
operand spans. Leading `--from` token/value and every stage source operand are
excluded from generic local references; the last destination remains visible.
This prevents repeated sources, flag-value collisions and glob/URL substrings
from becoming false local relations. Local dependencies still resolve only
accepted source values. See [Docker COPY source and destination rules](https://docs.docker.com/reference/dockerfile/#copy).

JSON arrays are validated from the original payload before mapping string lexemes
to raw spans. Significant whitespace, decoded escapes and literal quotes remain
part of the path. Invalid/non-string arrays and arrays with fewer than two values
return before secondary lexing. Shell quoting and continuations retain the
existing whitespace-token grammar; this is not a full Dockerfile parser.
Config/infra version 3 adds v2 legacy Git/non-Git oracles for false-source removal,
destination preservation, fresh-graph equality and saved-report immutability.
The prior coordinate/version oracles remain; local checks stay DB/app-free.

### Config extraction observations

Before adding selective config/infra carry, `bench/config-extraction-profile.ts`
records baseline, source-edit and config-edit full extraction on a fresh non-Git
fixture of 20 TypeScript files and three config files. On an approved execution
host, build the checkout and point the compiled observer at a built package:

```bash
npm run build
node dist/bench/config-extraction-profile.js /path/to/built/parallax > config-profile.json
```

It records total index-call time, every scan's summed reads/bytes, config
start/process/dispose windows, per-file event counts, runtime module hashes and
host/Node metadata. Process windows include consumer collection between yields,
waits and instrumentation; they are not adapter CPU time or a net speedup
estimate. `unchangedConfigWindowMs` excludes the edited config file. Reads are
not skipped. This small fixture does not measure Git history/cache prechecks or
large-repository behavior. The fixture is removed on success or ordinary failure.
Keep timing observations outside deterministic accuracy reports and thresholds;
remote correctness coverage checks phases/counts, not performance. The observer
and synthetic generator are bench files outside the npm package payload.

Approved VM observation, 2026-10-25: merge commit `5fc6cba` (PR #55), Node
`v24.14.0 --max-old-space-size=512`, Ubuntu 24.04 / Linux 6.8.0-147-generic
`linux/x64`, Xeon Gold 6148, 2 logical CPUs and 4 GB RAM. The entire execution
used a shared process lock and cgroup limits of one CPU / 1 GiB. The npm archive
SHA-256 was `4f4ab3125c5b85edb149d4586f56c23de77ed0bb019574533c0b9953a3f44309`;
the observer recorded hashes of the five loaded runtime modules. Command:

```bash
node --max-old-space-size=512 profile-tool/config-extraction-profile.js package
```

| Phase | Index call (ms) | Scan (ms) | All config process windows (ms) | Unchanged config windows (ms) | Body reads / bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 146.157 | 14.653 | 2.139 | 2.139 | 23 / 1258 |
| source-edit | 141.282 | 3.716 | 0.876 | 0.876 | 23 / 1258 |
| config-edit | 85.875 | 2.995 | 0.326 | 0.156 | 23 / 1231 |

Each phase used one scan, three nonempty config process calls and full
extraction; sample reads were zero. These are single sequential observations,
with startup/cache effects and no statistical comparison. The sub-millisecond
unchanged-config windows in the edit cases do not justify general selective
carry complexity for this fixture. Keep the conservative path and revisit only
with a representative workload that demonstrates material config cost. This
does not establish a net speedup, safe read skipping or large-repo performance.
The VM used a temporary Node installation and locked dependencies with lifecycle
scripts disabled; no model was requested. CLI help and invalid observer usage
were checked separately. Execution fixtures were removed, including a forced
timeout cleanup check; this was not a default-embedding or production smoke.

Workbench export failure feedback is checked separately from clipboard feedback:
JSON/CSV/PNG failures say "Export failed", while copy failures say "Copy failed"
in the selected UI language. A missing map must still reject PNG creation.
The pure emitted-client test uses platform stubs; actual VM/browser observations
and remote rendered-HTML tests establish different boundaries.

### Current local baseline

Captured on 2026-06-28 from commit `f8f6060` on macOS Darwin 24.6.0, Apple M1 Max, 10 CPU cores, 32 GiB RAM, Node `v24.14.0`, npm `11.9.0`.

This historical table predates the scan phase columns and preserves its original
`edit_incremental_ms` label. Current output calls that changed-body phase
`edit_reindex_ms`; rerun the command on a current checkout for comparisons.

Command:

```bash
npm run bench:perf -- --scales 1000,2000
```

| files | full_index_ms | noop_incremental_ms | edit_incremental_ms | analyze_no_persist_ms | analyze_persist_ms | affected | observed_peak_rss_mb | full_index_ms/kfile | noop_incremental_ms/kfile | edit_incremental_ms/kfile | analyze_no_persist_ms/kfile | analyze_persist_ms/kfile |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1000 | 5251 | 3655.8 | 3594.0 | 1947.0 | 1935.7 | 200 | 328 | 5251 | 3656 | 3594 | 1947 | 1936 |
| 2000 | 17526 | 14266.0 | 14179.2 | 7688.0 | 7707.7 | 200 | 261 | 8763 | 7133 | 7090 | 3844 | 3854 |

The standard large-repo command was also attempted as `npm run bench:perf -- --scales 10000`. It did not emit a table within about 20 minutes on this host and was interrupted. The 50k run was not started because the 10k full-phase run did not complete within that local limit. Treat 10k/50k full-phase `bench:perf` as **not yet supported on this baseline host** until the analyzer/indexing cost is reduced or the perf runner grows a phase-split/progress mode.

## The docs linter

`scripts/docs-lint.js` (run via `npm run docs:lint`) is a static gate over tracked Markdown plus local untracked Markdown that is not ignored. It enforces:

- **No forbidden content** — local machine paths, restore-point metadata, and runtime-redacted secret families such as API keys, service tokens, bearer/JWT credentials, database URLs with embedded credentials, and private keys. This scan runs on the raw text, including fenced code blocks.
- **Trilingual parity** — every doc in the trilingual zone (`docs/` excluding `docs/assets/`, `skills/`, and root `README`/`CONTRIBUTING`/`SECURITY`) must have all three of `X.md`, `X.ko.md`, `X.zh.md`.
- **Switcher presence** — each file must link to its other two language variants (the language switcher under the H1).
- **Same-language internal links** — inside `X.ko.md`, internal `.md` links must point to the `.ko.md` sibling (and `.zh.md` inside `X.zh.md`) whenever that same-language twin exists. The switcher line is the only allowed cross-language exception. Fenced code blocks are ignored for link checking, so markdown link *examples* in code blocks are safe.
- **Existing local Markdown targets** — non-image local `.md` links must resolve to a Markdown file in the working tree, including new untracked docs before they are staged.

## Continuous integration

CI and Release use CPU runners. Their jobs set `ONNXRUNTIME_NODE_INSTALL=skip`
to avoid optional GPU downloads, then load the native ONNX binding and assert
that its bundled CPU backend is available. This supported
[ONNX installation option](https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/js/node/script/install.js)
keeps normal npm lifecycle scripts enabled and also applies to the PR baseline
install. Package versions and user installation defaults are unchanged. The
check does not run a model or verify GPU inference; dependency audit remains a
separate metadata check.

`.github/workflows/ci.yml` runs on every push and pull request to `main`. The `verify` job, on Node.js 24, runs in order:

```bash
npm ci
npm run verify
npm run bench:report -- --github-step-summary --allow-missing --baseline .parallax/bench/impact-bench-baseline.json
```

`npm run verify` is the canonical source-checkout gate. It runs lint first, then install smoke (which owns the only build), the fast unit suite, dogfood, bench, and finally the registry-dependent audit. On pull requests, CI first prepares `.parallax/bench/impact-bench-baseline.json` from the base SHA so the final summary includes score, relation, affected-file, retrieval, and semantic recall deltas.

## How to add tests

Tests live under `tests/` and follow the **Arrange-Act-Assert** pattern: set up an isolated temp repo, run the real entry point (`initProject` / `indexProject` / `analyzeDiff` / `searchContextForRepo`), then assert on the result. Most suites create and tear down a temp directory so each test is isolated.

- **Unit and integration tests** are `tests/*.test.ts` and run under `npm test`.
- **Adapter changes** must also extend the bench fixture in `bench/impact-bench.ts` with the new expected relations, and follow the evidence/confidence discipline described in [`extending-adapters.md`](extending-adapters.md).
- **Engine changes** — anything under the indexer, adapters, analyzer, store, graph, or cross-repo layers — must be dogfood-verified with `npm run test:dogfood`, not just unit-green. If you change how relations are extracted or ranked, re-run `npm run bench` and update the pinned expectations only when the change is intended.

Before opening a PR, run the full local gate:

```bash
npm run verify
```

## See also

- [extending-adapters.md](extending-adapters.md) — adapter contract, evidence/confidence discipline, and adapter tests
- [invariants.md](invariants.md) — the evidence-first and deterministic-output invariants the bench checks
- [cli-reference.md](cli-reference.md) — the CLI surface the tests exercise
- [README.md](README.md) — the documentation index
