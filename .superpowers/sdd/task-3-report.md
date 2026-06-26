# Task 3 Report: UI Preview, Lane Label, And External Evidence Links

## What I Implemented

- Added `crossRepoImpacts` to the UI report preview type and populated it from saved report JSON with an empty-array fallback.
- Added shared UI classifiers for cross-repo evidence and cross-repo affected paths.
- Suppressed local source links for `cross-repo-contract-impact` evidence in server-rendered evidence links and client-side inspector evidence rendering.
- Added the `crossRepo` impact lane, including English, Korean, and Chinese messages:
  - `Cross-repo consumers`
  - `No cross-repo consumer impact`
  - `교차 저장소 소비자`
  - `교차 저장소 소비자 영향 없음`
  - `跨仓库消费者`
  - `无跨仓库消费者影响`
- Classified cross-repo impact reasons and `BREAKS_COMPATIBILITY_WITH` relation paths into the new lane.
- Removed the local source link from affected-path rows for external cross-repo consumer paths.
- Added a UI regression test that seeds a saved report with:
  - one `crossRepoImpacts` entry,
  - one `web:src/client.ts` affected file,
  - one `cross-repo-contract-impact` evidence item.

## What I Tested And Exact Results

### Focused UI command from the brief

Command:

```bash
node --import tsx --test tests/ui.test.ts --test-name-pattern "cross-repo consumer impacts|list-first report workbench"
```

Result:

```text
✔ UI snapshot and HTML render a list-first report workbench (189.232209ms)
✔ UI snapshot and HTML render cross-repo consumer impacts (69.606625ms)
✔ UI snapshot and HTML compare the selected report to the previous saved report (66.906541ms)
✔ UI report delta honors configured team policy thresholds (70.325042ms)
✔ UI snapshot and HTML expose work artifact impact (64.6685ms)
✔ UI snapshot exposes typed empty states before reports exist (42.419084ms)
✔ UI snapshot and API expose workspace contract topology (203.107333ms)
✔ UI workspace snapshot tolerates legacy link provenance and unindexed repos (158.653375ms)
✔ UI snapshot can select an older explicit report outside the latest selector window (80.4545ms)
✔ UI server exposes bootstrap and resource-shaped JSON endpoints (155.948084ms)
✔ UI graph JSON API rejects invalid pagination query params with structured JSON (145.278042ms)
✔ CLI ui prints a localhost URL and shuts down cleanly (186.967833ms)
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2293.183875
```

Note: this Node test invocation executed all 12 tests in `tests/ui.test.ts` even with `--test-name-pattern`.

### TypeScript check

Command:

```bash
npm run check
```

Result:

```text
> parallax@0.1.0 check
> tsc -p tsconfig.json --noEmit
```

Exit code: 0.

### Diff whitespace check

Command:

```bash
git diff --check
```

Result: no output, exit code 0.

### Commit whitespace check

Command:

```bash
git show --check --format=fuller --no-renames HEAD
```

Result: no whitespace errors.

## TDD Evidence

- Added the regression test `UI snapshot and HTML render cross-repo consumer impacts` in `tests/ui.test.ts`.
- The test asserts:
  - `snapshot.selectedReport?.crossRepoImpacts.length === 1`
  - rendered HTML includes `Cross-repo consumers`
  - rendered HTML includes `web:src/client.ts`
  - rendered HTML includes `parallax://workspaces/platform/cross-repo-links`
  - rendered HTML does not include `/source?path=web%3Asrc%2Fclient.ts`
  - Korean render includes `교차 저장소 소비자`
  - Chinese render includes `跨仓库消费者`

## Files Changed

- `src/ui.ts`
- `src/ui/data.ts`
- `src/ui/shared.ts`
- `src/ui/panels.ts`
- `src/ui/client.ts`
- `tests/ui.test.ts`

## Self-Review Findings

- Verified the implementation stays within Task 3 UI preview/lane/source-link scope.
- Verified no public documentation was added.
- Verified cross-repo evidence source suppression is centralized through `evidenceSourceLocation` for server-rendered evidence and mirrored in client-side inspector rendering.
- Verified affected external consumer rows suppress local source links through `isCrossRepoImpactPath`.
- Verified `crossRepoImpacts` is present in UI bootstrap/report preview JSON via `reportPreviewFromRow`.
- One nuance: the exact focused command from the brief ran the full `tests/ui.test.ts` file under this Node runner rather than filtering to two tests, but all 12 UI tests passed.

## Issues Or Concerns

- No blocking issues.
- I did not modify public docs, per Task 3 instructions.

## Review Fix: Delta Source Links And Cross-Repo Map Lane

### What I Fixed

- Preserved full affected-file metadata in saved-report comparisons through `addedAffectedFiles` and `removedAffectedFiles`, while keeping the existing `addedAffectedPaths` and `removedAffectedPaths` string arrays.
- Updated saved-report delta path rendering to suppress `/source` links for:
  - affected-file rows classified by `isCrossRepoImpactPath`, and
  - non-local path shapes such as `web:src/client.ts` when only a path string is available.
- Added the missing `crossRepo` branch to the impact-map lane display helper so initial map and inspector metadata render `Cross-repo consumers` instead of falling through to `Runtime code`.
- Added a `crossRepo` edge label branch so cross-repo map routes render as `CROSS-REPO`.
- Extended the cross-repo UI regression to assert:
  - saved-report delta rows include `web:src/client.ts`,
  - rendered HTML does not contain `/source?path=web%3Asrc%2Fclient.ts`,
  - initial inspector metadata contains `Cross-repo consumers · heuristic`, and
  - initial impact map lane metadata uses `Cross-repo consumers`.

### Review Fix Test Results

Command:

```bash
node --import tsx --test tests/ui.test.ts --test-name-pattern "cross-repo consumer impacts|list-first report workbench"
```

Result: pass, 12 tests passed, 0 failed. Note: this Node invocation still executed all `tests/ui.test.ts` tests despite the test-name pattern.

Command:

```bash
npm run check
```

Result: pass, `tsc -p tsconfig.json --noEmit` exited 0.
