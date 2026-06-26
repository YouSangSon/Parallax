# Cross-Repo Link Verification And Agent Query Design

**English** · [한국어](2026-06-26-cross-repo-link-verification-agent-query-design.ko.md) · [中文](2026-06-26-cross-repo-link-verification-agent-query-design.zh.md)

**Status:** Approved for implementation. Implementation plan: `docs/superpowers/plans/2026-06-26-cross-repo-link-verification-agent-query.md`.

**Backlog items:** W2, bidirectional cross-repo link consistency; W6, cross-repo resolve and reverse-consumer MCP tools.

**Goal:** Make the workspace cross-repo graph trustworthy and directly queryable. Users should be able to verify whether persisted provider/consumer links are still valid, and agents should be able to ask "who consumes provider X?" or preview cross-repo resolution without mutating source files.

## User Outcome

A user working in a registered workspace should get a direct answer to three questions:

- Is the stored cross-repo link graph internally consistent?
- Which consumers depend on this provider contract or endpoint?
- Which providers does this consumer file or service depend on?

Agents should get the same answers through MCP with compact resource links. If a provider contract changes and W1 surfaces cross-repo impact, stale or orphan workspace links should be diagnosable instead of silently making the impact report look incomplete.

## Current State

Parallax already has the storage and first-pass workflows:

- `resolveCrossRepoContracts` scans registered local workspace repos and persists `CONSUMES_HTTP_ENDPOINT` rows in `cross_repo_links`.
- `analyzeContractDiff` persists `BREAKS_COMPATIBILITY_WITH` rows for consumers impacted by breaking provider contract changes.
- `parallax://workspaces/{name}/cross-repo-links` exposes persisted links.
- W1 surfaces persisted `BREAKS_COMPATIBILITY_WITH` rows in primary `analyzeDiff` reports, graph exports, MCP payloads, and the UI.
- D2-W1 now guards that W1 path in `npm run bench`.

The gap is consistency and queryability. Links are stored directionally from consumer to provider. There is no shared read model that can reconcile `BREAKS_COMPATIBILITY_WITH` rows against their parent `CONSUMES_HTTP_ENDPOINT` rows, flag links whose repos left the workspace catalog, or expose a stable reverse index for provider-to-consumer questions.

## Chosen Approach

Add a shared cross-repo link read model plus read-only verification and query surfaces.

The read model should live in a focused module such as `src/cross_repo_links.ts`. It reads `cross_repo_links`, parses provenance, joins workspace membership, and returns normalized records plus diagnostics. Existing producers keep writing canonical directional rows. The new layer makes those rows traversable in both directions without storing redundant inverse rows.

This definition matters: "bidirectional consistency" means one canonical link can be queried provider-to-consumer and consumer-to-provider through helpers. It does not mean writing duplicate inverse rows. Duplicate inverse storage would create a second staleness problem and make repair harder.

## Alternatives Considered

### A. Shared read model with verification and reverse indexes (selected)

This keeps writes simple, removes SQL/provenance duplication, and gives CLI, MCP, UI, and future analyzers the same answer. It also fits the local-first SQLite model and does not need a schema migration.

Tradeoff: implementation must carefully model malformed legacy provenance and stale membership rows instead of relying on current inner joins that hide bad links.

### B. Write explicit inverse rows

This would make reverse lookup look simple at query time, but it duplicates the truth. Every resolver, diff, repair, and future migration would need to keep two rows synchronized.

Tradeoff: simpler reads, worse correctness and cleanup risk.

### C. Add only MCP tools over existing SQL

This would satisfy the narrow agent query surface, but CLI and UI would still lack a reliable consistency check, and future code would likely copy parsing logic again.

Tradeoff: smaller slice, weaker foundation.

## Read Model

Introduce a shared API with names close to:

```ts
type CrossRepoLinkKind = 'CONSUMES_HTTP_ENDPOINT' | 'BREAKS_COMPATIBILITY_WITH';

type CrossRepoLinkRecord = {
  id: string;
  workspace: string;
  kind: CrossRepoLinkKind;
  confidence: Confidence;
  source: {
    serviceName?: string;
    repoPath?: string;
    path?: string;
    inWorkspace: boolean;
  };
  target: {
    serviceName?: string;
    repoPath?: string;
    contractPath?: string;
    inWorkspace: boolean;
  };
  endpoint?: {
    method: string;
    path: string;
  };
  provenance: unknown;
};

type CrossRepoLinkDiagnostics = {
  malformedLinks: CrossRepoDiagnostic[];
  staleWorkspaceLinks: CrossRepoDiagnostic[];
  orphanBreakingLinks: CrossRepoDiagnostic[];
};
```

Exact type names can change in implementation, but the boundary should stay stable:

- one loader normalizes rows for a workspace;
- one verifier returns diagnostics and counts;
- `consumersOf(...)` returns consumer records for a provider service, contract, endpoint, or route;
- `providersFor(...)` returns provider records for a consumer service, file, or endpoint evidence.

The module must use `LEFT JOIN` when verifying integrity so stale links are visible. Resource readers that intentionally show only currently joined links can keep using tighter joins, but verification must not hide broken references.

## Consistency Rules

Verification should classify these cases deterministically:

- **Malformed link:** provenance is not valid JSON or lacks required provider, consumer, endpoint, change, or evidence fields for its kind.
- **Stale workspace link:** `source_repo_id` or `target_repo_id` no longer maps to a current `workspace_repos` row for the link workspace, or the provenance repo path conflicts with the current catalog member path.
- **Orphan breaking link:** a `BREAKS_COMPATIBILITY_WITH` row has no matching `CONSUMES_HTTP_ENDPOINT` parent in the same workspace for the same consumer repo/path, provider repo/contract, and method/path.

Contract baseline freshness is out of scope for this slice. A provider contract may have changed without re-running `workspace resolve-contracts` or `workspace contract-diff`; the verifier should report graph consistency, not prove that every repo has the freshest possible analysis.

## CLI Surface

Add read-only workspace commands:

```bash
parallax workspace verify [--name <name>] [--json]
parallax workspace consumers --provider <service> [--contract <path>] [--method <method>] [--path <route>] [--name <name>] [--json]
parallax workspace providers --consumer <service> [--file <path>] [--name <name>] [--json]
```

`workspace verify` prints a compact human summary and exits non-zero when malformed, stale, or orphan links are found. JSON output returns the same counts, diagnostic rows, and `resources` object for machine use.

`workspace consumers` and `workspace providers` use the same read model. They do not run resolution or contract diff. If no matching rows exist, they return an empty result with a warning that persisted links may need refreshing.

## MCP Surface

Add read-only agent query tools:

- `parallax_cross_repo_consumers`
- `parallax_cross_repo_providers`
- `parallax_resolve_cross_repo_contracts`

`parallax_cross_repo_consumers` and `parallax_cross_repo_providers` query persisted links and set `readOnlyHint: true`.

`parallax_resolve_cross_repo_contracts` should be a preview tool, not the same write path as the CLI. Refactor `resolveCrossRepoContracts` to accept a `persist?: boolean` option. The existing CLI keeps the current persisted behavior by calling it with the default write mode. The MCP preview calls it with `persist: false`, returns proposed links and warnings, and must not clear or insert `cross_repo_links` rows.

This respects invariant I-8. MCP tools marked read-only do not edit source files or workspace link tables, aside from allowed local telemetry rows already documented in `docs/mcp.md`. If a future MCP write tool is needed to persist cross-repo resolution, it must be separately named, annotated `readOnlyHint: false`, and documented as an explicit write surface.

## Error Handling

- Missing workspace: return a typed error consistent with existing workspace commands.
- Empty workspace: verify succeeds with zero links and a warning.
- Malformed provenance: never throw from bulk verification; include deterministic diagnostics.
- Query filters with no matches: return an empty list and resource links, not an error.
- Route filters must normalize method case but preserve route path text.
- Absolute local paths may appear in local CLI JSON when they already exist in the workspace catalog, but MCP compact results should prefer service names, contract paths, consumer paths, and `parallax://` resources.

## Tests

Implementation must add focused coverage for:

1. `workspace verify` reports success for a workspace with matching `CONSUMES_HTTP_ENDPOINT` and `BREAKS_COMPATIBILITY_WITH` rows.
2. `workspace verify` flags orphan `BREAKS_COMPATIBILITY_WITH` rows after the parent consume link is removed.
3. `workspace verify` flags stale links that reference repos no longer in the workspace catalog.
4. Malformed provenance is counted without crashing the verifier.
5. `consumersOf` returns consumers filtered by provider service, contract, method, and route.
6. `providersFor` returns providers filtered by consumer service and file path.
7. MCP tools expose the query results with `readOnlyHint: true` and resource links.
8. MCP resolution preview returns computed links without mutating `cross_repo_links`.
9. Existing `workspace resolve-contracts`, `workspace contract-diff`, W1 primary cross-repo impact, and bench coverage keep passing.

## Documentation

Update:

- `docs/cli-reference*.md`: document `workspace verify`, `workspace consumers`, and `workspace providers`.
- `docs/mcp*.md`: document new cross-repo MCP tools and the read-only preview boundary.
- `docs/roadmap*.md`: check off the link consistency item once implementation lands.
- `IMPROVEMENT_OPPORTUNITIES.md`: mark W2 and W6 as shipped or partially shipped with any remaining follow-ons.
- `docs/verification*.md`: mention the focused verifier tests if the final implementation adds a new verification command to `npm run verify`.

Keep English, Korean, and Chinese docs meaning-equivalent when touching translated pages.

## Implementation Boundary

This design does not implement:

- automatic deletion or repair of stale links;
- duplicate inverse rows in `cross_repo_links`;
- automatic contract diff execution inside `analyzeDiff`;
- remote repository discovery or network cloning;
- monorepo sub-package cataloging;
- a permissioned MCP write tool for persisting cross-repo resolution.

The first implementation should diagnose and query. A later repair slice can add an explicit `workspace repair-links --dry-run/--apply` workflow if users need automatic cleanup.

## Verification Gate

Before implementation is accepted, run:

```bash
npm run lint
npm test -- --test-name-pattern "workspace|cross-repo|MCP"
npm run test:mcp
npm run bench
npm run verify
```

Scoped tests may run during development, but final acceptance requires `npm run verify`.

## Spec Self-Review

- Completeness scan: no unfinished markers, placeholders, or open-ended tool names remain.
- Consistency check: CLI, MCP, and future UI behavior all read through the same normalized link model.
- Scope check: this is one W2+W6 slice focused on verification and queryability; repair, monorepo cataloging, and automatic diff refresh are out of scope.
- Ambiguity check: read-only MCP resolution is explicitly a non-persisting preview, while the existing CLI resolution remains the persisted workflow.
