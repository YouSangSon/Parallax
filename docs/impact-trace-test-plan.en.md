# Impact Trace Test Plan

Generated: 2026-04-28

## Scope

This test plan covers the first implementation of Impact Trace: a local-first
repo indexer, diff impact analyzer, Markdown/Obsidian exporter, CLI, and MCP
server.

## Test Diagram

```text
git diff
  -> changed files
  -> changed symbols
  -> reverse dependency walk
  -> risk classifier
  -> affected tests/docs/routes
  -> evidence packet
  -> CLI / MCP / Markdown export
```

## Unit Tests

| Area | Required Tests |
|---|---|
| Path safety | Reject paths outside repo root; normalize symlinks; block absolute path escape. |
| Git diff parser | Handle untracked files, renames, deletes, binary files, merge-base diffs. |
| Symbol extractor | Extract exported/imported TypeScript symbols, local functions, classes, and call hints. |
| Dependency index | Insert, update, delete file/symbol/import edges idempotently. |
| Impact walk | Traverse reverse imports with depth limits and deterministic ordering. |
| Risk classifier | Produce deterministic severity from evidence, not model guesses. |
| Report renderer | Render stable Markdown with source file links and confidence labels. |
| Obsidian exporter | Write notes without clobbering unrelated vault files. |
| MCP server | Validate inputs, return JSON-RPC errors, expose resources consistently. |
| Secret redaction | Redact planted secrets before SQLite writes, MCP responses, Markdown reports, and Obsidian export. |
| SQLite concurrency | WAL mode, one-writer lock, busy timeout, pinned `index_run_id` reads, crash recovery. |
| Package/workspace graph | Detect npm/pnpm/yarn/bun workspaces, `tsconfig` paths/references, `exports`, and import maps. |
| CLI/MCP contracts | Validate JSON schemas, exit codes, typed error envelopes, pagination, and schema versions. |
| Doc lint | Reject committed docs containing local absolute home paths, hidden tool state, or machine-local metadata. |

## Integration Tests

| Fixture Repo | Scenario | Expected Result |
|---|---|---|
| TypeScript library | Change exported function signature. | Direct importers, tests, README examples, and call sites are reported. |
| Next.js app | Change shared component prop. | Pages/routes using the component and visual states are reported. |
| Node CLI | Change command option parser. | CLI help tests, docs examples, and command handlers are reported. |
| Python package | Change imported function. | Import graph fallback identifies affected modules with lower confidence. |
| Monorepo | Change shared package. | Workspace dependents and package-level test commands are reported. |
| Secret fixture | Change file containing planted tokens/certs. | Reports contain redacted snippets only; raw reveal requires explicit opt-in. |
| Concurrent fixture | Index while MCP reads a report. | MCP sees a complete `index_run_id`, never partial state. |

## Accuracy Gates

| Metric | v1 Gate |
|---|---:|
| Affected-file recall on golden diffs | >= 90% |
| Critical false-negative count | 0 |
| Test recommendation precision | >= 70% |
| Stale-index detection | 100% on fixture cases |
| Secret redaction failures | 0 planted leaks |

## E2E Tests

1. `impact-trace init` in a fixture repo creates local config and database.
2. `impact-trace index` builds a deterministic index.
3. `impact-trace analyze --base main --head feature` produces a Markdown report.
4. MCP client calls read-only `impact_trace_analyze_diff` and receives the same evidence IDs.
5. `impact-trace obsidian sync --vault <tmp-vault>` defaults to dry-run.
6. `impact-trace obsidian sync --vault <tmp-vault> --write` writes notes with backlinks and conflict protection.

## Regression Rule

Every bug found in impact traversal must add a fixture repo or fixture diff before
the fix lands. A report snapshot is acceptable only if the snapshot includes the
underlying evidence IDs.

## Verification Commands

```bash
npm test
npm run lint
npm run typecheck
npm run test:fixtures
npm run test:security
npm run test:mcp
npm run test:benchmark
npm run test:install-smoke
npm run docs:lint
```
