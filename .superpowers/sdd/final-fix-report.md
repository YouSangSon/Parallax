# Final Fix Report

Date: 2026-06-26
Base: 17c4fd2

## Changes

- `src/cross_repo_links.ts` now normalizes cross-repo read records with the current joined `workspace_repos.service_name` when the source or target is still a current workspace member. Provenance service names remain the fallback for non-members or stale membership.
- `src/workspace.ts`, `src/cross_repo_links.ts`, and `src/cross_repo_resolver.ts` now support `syncCatalog?: boolean`, defaulting to the previous syncing behavior. The three new MCP cross-repo tools pass `syncCatalog: false` so `readOnlyHint: true` tools read the already synchronized workspace DB view.
- `src/cli.ts` now rejects required option values that are missing or look like another flag.
- `tests/cross-repo-links.test.ts` adds provider and consumer service rename regressions after links are persisted, plus CLI missing-value assertions.
- `tests/mcp.test.ts` adds a regression proving catalog-file service renames are not synced into `workspace_repos` by `parallax_cross_repo_consumers`, `parallax_cross_repo_providers`, or `parallax_resolve_cross_repo_contracts`.
- MCP docs and Parallax skill docs now state that these read-only cross-repo tools read the synchronized DB view and do not mutate `cross_repo_links`.
- `.superpowers/sdd/task-3-report.md` was restored from `eb03394`.

## Verification

- `node --import tsx --test tests/cross-repo-links.test.ts` - passed, 10 tests.
- `npm run test:mcp -- --test-name-pattern "cross-repo consumers|resolve_cross_repo"` - passed, 58 tests.
- `npm run check` - passed.
- `npm run docs:lint` - passed.
- `git diff --check` - passed.

## Concerns

- None.
