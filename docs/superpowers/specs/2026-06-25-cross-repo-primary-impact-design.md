# Cross-Repo Primary Impact Design

**English** · [한국어](2026-06-25-cross-repo-primary-impact-design.ko.md) · [中文](2026-06-25-cross-repo-primary-impact-design.zh.md)

**Status:** Approved for design. Implementation still requires review of this written spec.

**Backlog item:** W1, cross-repo contract impact in `analyzeDiff`.

**Goal:** When a changed contract breaks registered workspace consumers, the primary impact report must show those consumer services and files directly. Cross-repo impact should no longer live only in `parallax workspace contract-diff` output or the `parallax://workspaces/{name}/cross-repo-links` resource.

## User Outcome

A user changing a provider contract must immediately see:

- which consumer service is at risk;
- which consumer file matched the broken endpoint or event;
- which provider contract and breaking change caused the risk;
- what confidence and evidence support the result;
- where to continue investigation through MCP/UI resource links.

The first-glance report and UI must answer "who breaks if I ship this contract change?" without requiring the user or agent to know the workspace side lane exists.

## Current State

Parallax already has the raw data required for this feature:

- `contracts` and `contract_versions` identify indexed provider contracts.
- `cross_repo_links` stores `BREAKS_COMPATIBILITY_WITH` links emitted by `analyzeContractDiff`.
- link provenance carries `consumer`, `provider`, `change`, and `evidence` objects.
- MCP resources can expose workspace contracts and cross-repo links.

The gap is integration. `analyzeDiff` only walks the local entity graph and legacy file edges. It does not inspect workspace breaking links, so `parallax analyze`, MCP `parallax_analyze_diff`, persisted reports, graph exports, and the UI miss cross-repo consumers in their primary path.

## Chosen Approach

Add a focused cross-repo lane inside `analyzeDiff`.

The lane runs only when a changed file matches a contract path indexed in the latest completed run. For those contracts, it reads workspace `BREAKS_COMPATIBILITY_WITH` links whose provenance references the same provider repo and contract path. Each valid link becomes:

- one `crossRepoImpacts` entry;
- one `affectedFiles` entry for the consumer file, using a cross-repo path label;
- one `affected` target with an `external_entity` target for the consumer file;
- one evidence item with relation metadata so graph export and UI can render the edge.

This is intentionally read-only. The lane does not resolve contracts, recompute breaking changes, or mutate workspace links. It only surfaces already-persisted workspace evidence in the main report.

## Alternatives Considered

### A. Surface existing breaking links in `analyzeDiff` (selected)

This gives the highest user-visible value per slice. It reuses existing resolver and contract-diff outputs, keeps the implementation deterministic, and makes the primary report useful without a new workflow.

Tradeoff: the report only shows links that were already resolved and persisted. If the workspace is stale, the report warns rather than silently recomputing.

### B. Run contract-diff automatically during `analyzeDiff`

This would make reports fresher, but it introduces more write behavior and more expensive analysis into a command that currently maps impact against the latest index. It also blurs the read-only-first MCP boundary because `parallax_analyze_diff` already persists reports/telemetry in some modes.

Tradeoff: better freshness, worse predictability and more coupling.

### C. Add only a new MCP tool/resource

This keeps the primary report unchanged, but it does not solve the user problem. Agents and users would still need to discover and call a side lane to understand cross-repo breakage.

Tradeoff: low schema risk, low product impact.

## Report Shape

Add an optional field to `ImpactReport`:

```ts
type CrossRepoImpact = {
  workspace: string;
  provider: {
    serviceName: string;
    repoPath?: string;
    contractPath: string;
  };
  consumer: {
    serviceName: string;
    repoPath?: string;
    path: string;
  };
  change: {
    kind: string;
    method?: string;
    path?: string;
    previousEndpointId?: string;
  };
  confidence: Confidence;
  evidence: {
    filePath: string;
    snippet: string;
  };
  resources?: {
    workspace?: string;
    crossRepoLinks?: string;
  };
};
```

The field is optional and additive, so the report schema receives a minor version bump. Existing reports remain valid against the new schema. The implementation must also correct any stale report-schema documentation that still names an older schema version.

For privacy, `repoPath` must be omitted from public JSON when the value would expose an absolute local path. The primary identity is `serviceName`, `contractPath`, and `consumer.path`. Resource URIs can point to the workspace resource without leaking local paths.

## Affected Targets And Evidence

Cross-repo impact must participate in the existing report surfaces:

- `affectedFiles.path`: use a stable display label such as `web:src/client.ts`, not an absolute repo path.
- `affectedFiles.reason`: `breaks cross-repo consumer web via contracts/openapi.yaml`.
- `affectedFiles.confidence`: use the `cross_repo_links.confidence` value, normalized through `asConfidence`.
- `affectedFiles.depth`: `1`.
- `affectedFiles.relationPath`: include a human-readable contract break step.
- `affected.target.kind`: `external_entity`.
- `evidence.kind`: `BREAKS_COMPATIBILITY_WITH`.
- `evidence.subject`: the consumer target.
- `evidence.target`: the provider contract entity.
- `evidence.relationKind`: `BREAKS_COMPATIBILITY_WITH`.
- `evidence.extractorId`: `cross-repo-contract-impact`.

This lets saved report graph export rebuild the cross-repo edge from persisted JSON without depending on canonical rows, matching invariant I-11.

## Matching Rules

The lane emits a cross-repo impact only when all of these are true:

- the changed file path equals an indexed contract path for the current repo;
- a workspace row exists in the local DB;
- a `BREAKS_COMPATIBILITY_WITH` link belongs to that workspace;
- the parsed provenance provider `contractPath` equals the changed contract path;
- the parsed provenance provider repo matches this repo when a usable repo identity exists;
- the parsed provenance contains a consumer file path and evidence snippet.

Invalid or legacy provenance must not throw. It is skipped, and one report warning states how many malformed cross-repo links were ignored.

## UI, MCP, And Graph Behavior

No new command is required in this slice.

The primary surfaces receive the new data through the report:

- CLI `analyze --json` includes `crossRepoImpacts`.
- MCP `parallax_analyze_diff` returns the same report field.
- persisted report resources include the field.
- graph export renders cross-repo `BREAKS_COMPATIBILITY_WITH` edges from report evidence.
- UI shows cross-repo impacts in the existing affected/inspector flow, with a small lane label such as `cross-repo`.

If the UI needs a small mapping helper for display labels, keep it local to UI data preparation. Do not create a separate data source that can drift from the report JSON.

## Error Handling

- No workspace: no cross-repo impacts, no warning.
- Workspace exists but no matching breaking links: no cross-repo impacts, no warning.
- Malformed provenance: skip malformed links and add one deterministic warning.
- Stale workspace links: show existing link confidence and evidence; do not recompute. A future W2 verification command can handle stale/orphan detection.
- Absolute paths: do not put local machine paths into docs or public-facing report display labels.

## Tests

Add focused coverage before implementation:

1. `analyzeDiff` surfaces a persisted `BREAKS_COMPATIBILITY_WITH` link when the changed file is the provider contract.
2. The emitted report includes `crossRepoImpacts`, `affectedFiles`, `affected`, and relation-bearing evidence for the consumer file.
3. A report graph export built from the persisted report includes a cross-repo `BREAKS_COMPATIBILITY_WITH` edge and remains stable without querying cross-repo rows.
4. Non-contract changed files and contracts with no matching breaking links keep existing report output unchanged.
5. Malformed breaking-link provenance is skipped with one deterministic warning.
6. The report schema drift guard passes after the optional field and schema version bump.

## Documentation

Update these public docs in the implementation slice:

- `docs/cli-reference*.md`: explain that `analyze` can include cross-repo consumer impact when workspace links exist.
- `docs/mcp*.md`: explain that `parallax_analyze_diff` returns the same cross-repo section.
- `docs/report-schema*.md`: bump the documented current version and describe `crossRepoImpacts`.
- `docs/roadmap*.md`: mark W1 shipped after implementation.
- `IMPROVEMENT_OPPORTUNITIES.md`: move W1 to shipped and update sequencing.

Keep translations meaning-equivalent across English, Korean, and Chinese.

## Implementation Boundary

This design does not implement:

- automatic contract diff execution inside `analyzeDiff`;
- cross-repo link reconciliation or bidirectional repair, which belongs to W2;
- monorepo sub-package cataloging, which belongs to W3;
- new MCP write surfaces;
- network access or remote repository discovery.

## Verification Gate

Before merge, the implementation must pass:

```bash
npm run schemas:build
npm run lint
npm test
npm run test:mcp
npm run test:ui
npm run verify
```

Scoped tests may run first during development, but final acceptance requires `npm run verify`.

## Open Implementation Notes

- Prefer a small helper such as `loadCrossRepoImpactsForChangedContract(...)` inside `src/analyzer.ts` or a dedicated module if the SQL/provenance parsing grows beyond a compact function.
- Reuse `workspaceResources(...)` from `src/mcp_resources.ts` only if it does not create a layering cycle. If it would, move URI construction into a shared helper.
- Keep warning text deterministic and sorted with existing warnings.
- Keep `CrossRepoImpact` additive and optional so old persisted reports remain readable.
