# Task 3 Report: MCP Cross-Repo Query Tools And Resolution Preview

## What I Implemented

- Added `ResolveCrossRepoContractsOptions.persist?: boolean`.
- Updated `resolveCrossRepoContracts` so `persist: false` previews links without clearing or inserting `cross_repo_links` rows.
- Preserved existing CLI behavior: omitted `persist` still writes persisted workspace links.
- Added MCP tools:
  - `parallax_cross_repo_consumers`
  - `parallax_cross_repo_providers`
  - `parallax_resolve_cross_repo_contracts`
- Marked all three new MCP tools with `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false`.
- Wired the consumers/providers tools to Task 1 `consumersOf` and `providersFor`.
- Wired the resolver preview tool to `resolveCrossRepoContracts({ persist: false })` and returned workspace resource links.
- Added resolver preview and MCP behavior tests.
- Updated MCP docs and Parallax skill tool tables in English, Korean, and Chinese, including `MCP tools surfaced (23)` headings.

## What I Tested And Exact Results

### Required focused resolver command

Command:

```bash
node --import tsx --test tests/cross-repo-resolver.test.ts --test-name-pattern "persist false"
```

GREEN result:

```text
ℹ tests 54
ℹ suites 0
ℹ pass 54
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11997.109083
```

### Required focused MCP command

Command:

```bash
npm run test:mcp -- --test-name-pattern "stdio server initializes|cross-repo consumers|resolve_cross_repo"
```

GREEN result:

```text
ℹ tests 57
ℹ suites 0
ℹ pass 57
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 30805.9945
```

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

### Docs lint

Command:

```bash
npm run docs:lint
```

Result:

```text
> parallax@0.1.0 docs:lint
> node scripts/docs-lint.js

docs-lint: OK
```

Exit code: 0.

### Diff whitespace check

Command:

```bash
git diff --check
```

Result: no output, exit code 0.

## TDD Evidence

### RED command/output summary

Command:

```bash
node --import tsx --test tests/cross-repo-resolver.test.ts --test-name-pattern "persist false"
```

RED result before production changes:

```text
ℹ tests 54
ℹ pass 53
ℹ fail 1
✖ resolveCrossRepoContracts persist false previews links without mutating cross_repo_links
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
1 !== 0
```

Command:

```bash
npm run test:mcp -- --test-name-pattern "stdio server initializes|cross-repo consumers|resolve_cross_repo"
```

RED result before production/docs changes:

```text
ℹ tests 57
ℹ pass 54
ℹ fail 3
✖ MCP stdio server initializes and exposes the full agent memory tool surface
AssertionError [ERR_ASSERTION]: skills/parallax/SKILL.md must have a ## MCP tools surfaced (23) section
✖ MCP cross-repo consumers and providers query persisted workspace links
TypeError: Cannot read properties of undefined (reading 'map')
✖ MCP resolve_cross_repo_contracts previews links without mutating persisted links
TypeError: Cannot read properties of undefined (reading 'map')
```

### GREEN command/output summary

Command:

```bash
node --import tsx --test tests/cross-repo-resolver.test.ts --test-name-pattern "persist false"
```

GREEN result after implementation:

```text
ℹ tests 54
ℹ pass 54
ℹ fail 0
```

Command:

```bash
npm run test:mcp -- --test-name-pattern "stdio server initializes|cross-repo consumers|resolve_cross_repo"
```

GREEN result after implementation:

```text
ℹ tests 57
ℹ pass 57
ℹ fail 0
```

Note: both focused Node test invocations executed the full target test file in this environment despite the `--test-name-pattern` argument.

## Files Changed

- `src/cross_repo_resolver.ts`
- `src/mcp.ts`
- `tests/cross-repo-resolver.test.ts`
- `tests/mcp.test.ts`
- `docs/mcp.md`
- `docs/mcp.ko.md`
- `docs/mcp.zh.md`
- `skills/parallax/SKILL.md`
- `skills/parallax/SKILL.ko.md`
- `skills/parallax/SKILL.zh.md`
- `.superpowers/sdd/task-3-report.md`

`src/index.ts` did not require a source edit because it already re-exported `ResolveCrossRepoContractsOptions`.

## Self-Review Findings

- Verified `persist: false` leaves `cross_repo_links` row count at `0`.
- Verified omitted `persist` still writes links through the existing resolver test and CLI assertion.
- Verified the new MCP preview tool calls `resolveCrossRepoContracts` with `persist: false`.
- Verified all three new MCP tools advertise read-only/idempotent annotations.
- Verified docs and skill tables match `tools/list` through the MCP parity test.
- Verified changed files are limited to the task-owned files plus the required tracked report file.
- Verified whitespace, TypeScript, and docs lint checks are clean.

## Issues Or Concerns

- No blocking issues.
- The Node test-name pattern did not narrow execution in this environment; the full referenced test files passed.
