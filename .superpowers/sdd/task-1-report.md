# Task 1 Report: SARIF Export And GitHub Action

## Status

DONE

## Commit

- `824016e feat: export impact reports as sarif`

## What Changed

- Added `src/sarif.ts` with a pure `ImpactReport` to SARIF 2.1.0 projection.
- Exported `impactReportToSarif`, `SarifLog`, and `SarifOptions` from `src/index.ts`.
- Added `parallax analyze --sarif-output <path>` and `--sarif-category <category>`.
- Preserved existing `analyze --json` behavior and rejected `--json` with `--sarif-output`.
- Kept SARIF output file-oriented: parent directories are created and normal human stdout remains.
- Added `action.yml` as a composite action that generates the SARIF file only; upload remains caller-controlled.
- Added serializer and CLI regression tests.
- Updated English, Korean, and Chinese docs/READMEs for CLI flags, SARIF projection semantics, GitHub upload workflow, and roadmap/backlog status.

## SARIF Projection Notes

- SARIF is not an `ImpactReport` schema bump.
- SARIF findings are emitted from `affectedFiles`.
- Rule ids are confidence-specific: `parallax.impact.proven`, `parallax.impact.inferred`, `parallax.impact.heuristic`, and `parallax.impact.unknown`.
- Evidence spans become SARIF regions where available.
- `relationPath` becomes a SARIF code flow.
- `partialFingerprints.parallaxImpact` is stable over affected path, reason, confidence, relation path, and evidence ids.

## Verification

All requested commands passed:

```bash
node --import tsx --test tests/sarif.test.ts
node --import tsx --test tests/parallax.test.ts --test-name-pattern "SARIF|CLI analyze"
npm run check
npm run docs:lint
git diff --check
```

Additional focused check passed:

```bash
node --import tsx --test tests/package_metadata.test.ts
```

## Self-Review

- Confirmed the committed files match the Task 1 ownership list.
- Confirmed no `ImpactReport` type or JSON Schema shape was changed.
- Confirmed `--sarif-output` writes pretty JSON to the requested path and preserves the human summary.
- Confirmed `--json` remains stdout-only and non-persisting.
- Confirmed `--json` plus `--sarif-output` exits as a CLI usage error.
- Confirmed the GitHub Action does not upload SARIF or require `security-events: write` itself.

## Concerns

- None.

---

## Review Fix Report

Status: DONE

Fixes applied:

- Filtered `affectedFile.relationPath` before emitting SARIF code-flow physical locations. Only repo-relative file-like paths become artifact URIs; descriptive relation steps remain in `properties.relationPath`.
- Changed the GitHub composite action default `fail-on` to `none`.
- Updated README workflow snippets to generate SARIF with `--fail-on none` and document a separate gate step for fail-on behavior.
- Tightened `analyze --sarif-output` and `--sarif-category` parsing so missing values and next-flag values are usage errors.
- Replaced the SARIF package metadata `require('../package.json')` path with an upward root `package.json` lookup that works from both `src` and compiled `dist/src`.
- Added focused regressions for human-readable relation paths, missing SARIF CLI values, and importing the built SARIF module.

Verification:

```bash
node --import tsx --test tests/sarif.test.ts
# pass: 3 tests

node --import tsx --test tests/parallax.test.ts --test-name-pattern "SARIF|CLI analyze"
# pass: 98 tests

npm run build && node -e "import('./dist/src/sarif.js').then(m=>console.log(m.impactReportToSarif({id:'r',indexRunId:1,changedFiles:[],affectedFiles:[],changed:[],affected:[],actions:[],testCommands:[],evidence:[]}).version))"
# pass: printed 2.1.0

npm run check
# pass

npm run docs:lint
# pass: docs-lint: OK

git diff --check
# pass

node --import tsx --test tests/package_metadata.test.ts
# pass: 3 tests
```

Concerns:

- None.

---

## Second Re-Review Fix Report

Status: DONE

Timestamp: 2026-06-27 22:34:54 KST

Fixes applied:

- Moved GitHub composite action input interpolation out of the Bash command and into step environment variables. The `run` command now references only quoted shell variables for changed files, SARIF output, SARIF category, and fail-on.
- Filtered non-repo-relative affected file paths out of uploadable SARIF results before creating primary artifact URIs.
- Added run and invocation properties for omitted affected files: `omittedAffectedFileCount` and `omittedAffectedFiles`.
- Preserved `relationPath` in result properties for uploadable local affected files.
- Added regression coverage for the action metadata shell command and for omitting `web:src/client.ts` from SARIF result artifact URIs while exposing omission details.

Verification:

```bash
node --import tsx --test tests/sarif.test.ts
# pass: 4 tests

node --import tsx --test tests/package_metadata.test.ts
# pass: 4 tests

node --import tsx --test tests/parallax.test.ts --test-name-pattern "SARIF|CLI analyze"
# pass: 98 tests

npm run check
# pass

npm run docs:lint
# pass: docs-lint: OK

git diff --check
# pass
```

Concerns:

- None.
