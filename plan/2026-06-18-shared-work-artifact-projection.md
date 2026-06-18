# Shared Work Artifact Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Execution note:** This run did not dispatch subagents because the active tool policy requires an explicit user request before spawning sub-agents. Implementation, review, and verification were completed locally.

**Goal:** Remove duplicated work-artifact projection logic from UI bootstrap and MCP context packs so both surfaces share one metadata/freshness/evidence policy.

**Architecture:** Extend `src/work_artifacts.ts` from freshness-only helpers into the shared projection module for report-backed work artifacts. Keep UI and context-pack transport-specific details, such as omitted evidence snippet wording and response type ownership, in their existing modules.

**Tech Stack:** TypeScript ESM, Node.js 24, existing `ImpactReport`, `Evidence`, `EntityRef`, `Confidence`, and Markdown artifact metadata parsing.

## Global Constraints

- Preserve existing UI JSON/HTML behavior and MCP `parallax_context_for_change` response shape.
- Keep UI evidence omission wording unchanged: `Work artifact evidence omitted from UI bootstrap. Open the entity resource for document details.`
- Keep context-pack evidence omission wording unchanged: `Work artifact evidence omitted from context pack. Fetch the entity or evidence resource for document details.`
- Keep work artifact ordering unchanged for both surfaces.
- Do not add new work artifact kinds in this slice.
- Do not move UI-only render text or MCP-only persistence/resource logic into `work_artifacts.ts`.
- Verify with focused UI/MCP/work-artifact tests and TypeScript check.

---

### Task 1: Add Shared Work Artifact Projection Helpers

**Files:**
- Modify: `src/work_artifacts.ts`
- Create: `tests/work_artifacts.test.ts`

**Interfaces:**
- Produces: `isWorkArtifactKind(kind: string): boolean`
- Produces: `workArtifactPathSet(report: ImpactReport): Set<string>`
- Produces: `workArtifactEvidencePath(evidence: Evidence, workArtifactPaths: ReadonlySet<string>): string | undefined`
- Produces: `isWorkArtifactEvidence(evidence: Evidence, workArtifactPaths: ReadonlySet<string>): boolean`
- Produces: `workArtifactEvidenceResourceUri(evidence: Evidence, workArtifactPaths: ReadonlySet<string>): string | undefined`
- Produces: `workArtifactsFromImpactReport(report: ImpactReport, options: { asOfIso: string; includeDepth?: boolean }): WorkArtifactProjection[]`

- [x] **Step 1: Write focused tests**

Create `tests/work_artifacts.test.ts` that builds a small `ImpactReport` with:

- one `policy` target with frontmatter metadata and depth `2`
- one duplicate `policy` target for the same path that must be deduped
- one `decision` target with invalid `updated` metadata so freshness is `unknown`
- one normal `file` target that must not be included
- evidence whose `subject.path` and `file` prove work-artifact evidence detection

Assertions:

- `workArtifactPathSet(report)` contains only work artifact paths.
- `workArtifactsFromImpactReport(report, { asOfIso: '2026-06-18', includeDepth: true })` returns deduped artifacts with policy before decision, metadata extracted, depth included, and freshness states preserved.
- `workArtifactEvidenceResourceUri(...)` returns the entity URI for subject-backed and file-backed artifact evidence.
- `isWorkArtifactEvidence(...)` is false for non-artifact evidence.

Run: `npm test -- tests/work_artifacts.test.ts`

Expected before implementation: FAIL because the exported helpers do not exist.

- [x] **Step 2: Implement helpers in `src/work_artifacts.ts`**

Implementation requirements:

- Reuse existing `hasArtifactMetadata`, `workArtifactFreshness`, `workArtifactFreshnessRank`, and `workArtifactKindRank`.
- Move the shared work artifact kind set into this module.
- Use `markdownArtifactMetadataFromContent()` for metadata extraction.
- Use `parallax://entities/${encodeURIComponent(entity.id)}` for entity resource URIs.
- Preserve UI ordering by supporting `includeDepth: true`; when `includeDepth` is false, omit depth from sorting after freshness/kind.

Run: `npm test -- tests/work_artifacts.test.ts`

Expected: PASS.

- [x] **Step 3: Commit**

```bash
git add src/work_artifacts.ts tests/work_artifacts.test.ts
git commit -m "refactor: share work artifact projection helpers"
```

### Task 2: Wire UI and Context Pack Callers

**Files:**
- Modify: `src/ui/data.ts`
- Modify: `src/context_pack.ts`
- Modify: `tests/ui.test.ts`
- Modify: `tests/mcp.test.ts`

**Interfaces:**
- Consumes shared helpers from `src/work_artifacts.ts`
- Preserves UI/MCP output shape and omission wording

- [x] **Step 1: Replace duplicate UI helpers**

In `src/ui/data.ts`:

- Remove the local work artifact kind set.
- Remove local `workArtifactPathSet`, `workArtifactEvidenceResourceUri`, `workArtifactMetadataByPath`, `workArtifactEvidencePath`, and `compareWorkArtifacts`.
- Import and use `workArtifactsFromImpactReport(report, { asOfIso: row.created_at, includeDepth: true })`.
- Import and use shared `workArtifactPathSet` and `workArtifactEvidenceResourceUri` in `evidencePreviewFromReport`.
- Keep `omittedWorkArtifactEvidenceSnippet` and `workArtifactMetadataText()` local.

- [x] **Step 2: Replace duplicate context pack helpers**

In `src/context_pack.ts`:

- Remove the local context work artifact kind set.
- Remove local `workArtifactsForContextPack`, `workArtifactPathSet`, `workArtifactMetadataByPath`, `workArtifactEvidencePath`, `isWorkArtifactEvidence`, and `compareContextWorkArtifacts`.
- Import and use `workArtifactsFromImpactReport(report, { asOfIso })`.
- Import and use shared `workArtifactPathSet` and `isWorkArtifactEvidence` for evidence compaction.
- Keep the context-pack omitted evidence snippet local.

- [x] **Step 3: Strengthen cross-surface regression assertions**

In `tests/ui.test.ts` and `tests/mcp.test.ts`, keep existing assertions and add one assertion per surface that the `decision` work artifact freshness remains `unknown` while the stale `policy` remains first. Existing tests already cover most of this; add only missing checks if needed.

Run:

```bash
npm test -- tests/work_artifacts.test.ts tests/ui.test.ts tests/mcp.test.ts
npm run check
git diff --check -- src/work_artifacts.ts src/ui/data.ts src/context_pack.ts tests/work_artifacts.test.ts tests/ui.test.ts tests/mcp.test.ts
```

Expected: all PASS.

- [x] **Step 4: Commit**

```bash
git add src/work_artifacts.ts src/ui/data.ts src/context_pack.ts tests/work_artifacts.test.ts tests/ui.test.ts tests/mcp.test.ts
git commit -m "refactor: reuse work artifact projection"
```

### Task 3: Final Review And Verification

**Files:**
- Modify: `plan/2026-06-18-shared-work-artifact-projection.md`

- [x] **Step 1: Run verification**

Run:

```bash
npm test -- tests/work_artifacts.test.ts tests/ui.test.ts tests/mcp.test.ts
npm run check
npm run docs:lint
```

Expected: all PASS.

- [ ] **Step 2: Request review**

Generate an SDD review package from the task base to the current head and dispatch a reviewer. Fix Critical or Important findings.

Review note: subagent review dispatch was not performed because the current tool policy requires an explicit user request before spawning sub-agents. Local diff review found the remaining caller changes scoped to replacing duplicated UI/MCP projection logic with shared helpers.

- [x] **Step 3: Record final status and commit**

Append the final verification and review result to this plan. Mark completed checkboxes.

```bash
git add plan/2026-06-18-shared-work-artifact-projection.md
git commit -m "docs: record work artifact projection verification"
```

## Final Verification - 2026-06-18

- `npx tsx --test tests/work_artifacts.test.ts`: PASS, 3/3 tests.
- `npm run test:ui`: PASS, 11/11 tests.
- `npm run test:mcp`: PASS, 52/52 tests.
- `npm run check`: PASS.
- `npm run docs:lint`: PASS.
- `git diff --check -- src/work_artifacts.ts src/ui/data.ts src/context_pack.ts tests/work_artifacts.test.ts tests/ui.test.ts tests/mcp.test.ts plan/2026-06-18-shared-work-artifact-projection.md`: PASS.

Commits:

- `8b3b080 refactor: share work artifact projection helpers`
- `d4bf7dd refactor: reuse work artifact projection`
