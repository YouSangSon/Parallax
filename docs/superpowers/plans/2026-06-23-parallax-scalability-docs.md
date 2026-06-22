# Parallax Scalability and Docs Implementation Plan

**English** · [한국어](2026-06-23-parallax-scalability-docs.ko.md) · [中文](2026-06-23-parallax-scalability-docs.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Parallax more scalable and trustworthy by fixing the S1 incremental-indexing artifact regression, adding measurement that proves the scaling direction, and closing the most visible documentation drift.

**Architecture:** Preserve the local-first SQLite graph contract and keep persisted reports inspectable after later index runs. Treat saved report graph stability as a correctness invariant before adding more perf measurement. Documentation updates must stay trilingual where the surrounding doc set is trilingual.

**Tech Stack:** TypeScript, Node.js `node:test`, SQLite via `node:sqlite`, existing Parallax CLI/API modules, Markdown docs with `scripts/docs-lint.js`.

## Global Constraints

- Do not violate `docs/invariants.md`: local-first SQLite, additive migrations only, explicit triggers, read-only agent surface first, evidence first.
- Use TDD for behavior changes: write the failing test, verify RED, implement, verify GREEN.
- Keep work in small verified commits; push only when the current user instruction or explicit approval permits it.
- Do not leave UI, demo, test, or bench processes running.
- Use `npm run verify` before pushing any completed code slice.

---

### Task 1: Preserve Saved Report Graphs Across Incremental Reindex

**Files:**
- Modify: `tests/parallax.test.ts`
- Modify: `src/graph.ts`
- Maybe modify: `src/indexer.ts`

**Interfaces:**
- Consumes: `initProject`, `indexProject`, `analyzeDiff`, `exportImpactGraph` from `src/index.ts`.
- Produces: Stable `exportImpactGraph({ reportId })` output for a persisted report even after a later incremental index.

- [ ] **Step 1: Write the failing regression test**

Add a test next to `exportImpactGraph renders report graph from SQLite relations without graph DB`:

```ts
test('exportImpactGraph keeps a saved report graph stable after incremental reindex', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });
  await indexProject({ repoRoot });
  const report = await analyzeDiff({
    repoRoot,
    changedFiles: ['src/auth/session.ts'],
    writeReport: true
  });
  const before = await exportImpactGraph({ repoRoot, reportId: report.id, format: 'json' });
  const beforeParsed = JSON.parse(before.rendered) as {
    edges: Array<{ kind: string; source: string; target: string }>;
  };
  assert.ok(beforeParsed.edges.some((edge) => edge.kind === 'DEPENDS_ON'));

  await writeFile(
    path.join(repoRoot, 'src/routes/private.ts'),
    [
      'import { validateSession } from "../auth/session";',
      'export function privateRoute(token: string) {',
      '  return validateSession(token.trim()) ? "ok" : "no";',
      '}',
      ''
    ].join('\n')
  );
  const reindex = await indexProject({ repoRoot });
  assert.equal(reindex.mode, 'incremental');

  const after = await exportImpactGraph({ repoRoot, reportId: report.id, format: 'json' });
  const afterParsed = JSON.parse(after.rendered) as {
    edges: Array<{ kind: string; source: string; target: string }>;
  };
  assert.deepEqual(afterParsed.edges, beforeParsed.edges);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --import tsx --test tests/parallax.test.ts --test-name-pattern "exportImpactGraph keeps a saved report graph stable"
```

Expected: FAIL because the old report graph loses the relation edge after `carryForwardUnchanged()` restamps rows away from the report's `indexRunId`.

- [ ] **Step 3: Implement the smallest stable graph fallback**

Keep the persisted `ImpactReport` as the minimum source of truth for saved report graph edges when run-scoped canonical rows have disappeared. In `src/graph.ts`, after `loadCanonicalRows(...)` returns empty, rebuild edges from `report.affected[].relationPath` and `report.changed`/`report.affected` entity IDs before falling back to legacy rows. This avoids a schema migration inside the first bug-fix slice and restores saved artifact behavior.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --import tsx --test tests/parallax.test.ts --test-name-pattern "exportImpactGraph keeps a saved report graph stable|exportImpactGraph renders report graph"
npm run check
```

Expected: PASS.

- [ ] **Step 5: Broaden verification**

Run:

```bash
npm run docs:lint
npm run verify
```

Expected: PASS. Then commit:

```bash
git add .gitignore docs/superpowers/plans/2026-06-23-parallax-scalability-docs.md tests/parallax.test.ts src/graph.ts
git commit -m "fix(graph): preserve saved report graphs after incremental index"
# Push only with explicit user approval/current-session instruction:
# git push origin main
```

### Task 2: Measure Full vs Incremental Index Cost

**Files:**
- Modify: `bench/impact-perf.ts`
- Modify: `bench/synthetic-repo.ts`
- Test: add or modify focused bench/perf tests if a pure formatter/parser is introduced.
- Modify docs: `IMPROVEMENT_OPPORTUNITIES.md`, `docs/verification.md`, localized verification docs if user-facing wording changes.

**Interfaces:**
- Consumes: `generateSyntheticRepo`, `initProject`, `indexProject`, `analyzeDiff`.
- Produces: `npm run bench:perf` output with full initial index, no-op incremental, single-file incremental, analyze without persistence, analyze with persistence, RSS, affected count, and per-kfile timing columns.

- [ ] **Step 1: Add a pure row formatter/parser test if output formatting changes**

Run the new test directly with `node --import tsx --test <test-file>`.

- [ ] **Step 2: Extend `measure(files)`**

After the first full index, run a second no-op `indexProject()` and assert/record `mode === 'incremental'`. Then edit the synthetic changed file or one importer, run a third `indexProject()` and assert/record `mode === 'incremental'`.

- [ ] **Step 3: Split analyze timing**

Measure one `analyzeDiff({ persistReport: false })` and one default persisted analyze. Keep timing outside deterministic `ImpactBenchReport`.

- [ ] **Step 4: Verify**

Run:

```bash
npm run check
npm run bench:perf -- --scales 50,200
npm run docs:lint
```

### Task 3: Close Packaged Documentation Drift

**Files:**
- Add: `docs/getting-started.md`
- Add: `docs/getting-started.ko.md`
- Add: `docs/getting-started.zh.md`
- Modify: `README.md`, `README.ko.md`, `README.zh.md`
- Modify: `docs/README.md`, `docs/README.ko.md`, `docs/README.zh.md`
- Modify: `package.json`
- Modify: `tests/package_metadata.test.ts`
- Maybe modify: `docs/report-schema.md`, `docs/report-schema.ko.md`, `docs/report-schema.zh.md`

**Interfaces:**
- Produces: A worked tutorial with expected output and a self-contained package docs surface for the report schema.

- [ ] **Step 1: Decide schema packaging**

Prefer publishing `schemas/impact-report.schema.json` by adding `schemas` to `package.json.files`; update `tests/package_metadata.test.ts` accordingly.

- [ ] **Step 2: Add trilingual tutorial docs**

Each tutorial must cover: init, index, analyze, expected affected output, UI, MCP next step, CI/guardrail next step.

- [ ] **Step 3: Link docs**

Add tutorial links to the three READMEs and three docs indexes.

- [ ] **Step 4: Verify**

Run:

```bash
npm run docs:lint
npm run check
npm run test:install-smoke
node --import tsx --test tests/package_metadata.test.ts tests/report-schema.test.ts
```

### Task 4: Document Remaining High-Leverage Follow-ups

**Files:**
- Modify: `IMPROVEMENT_OPPORTUNITIES.md`
- Modify: `docs/roadmap.md`, `docs/roadmap.ko.md`, `docs/roadmap.zh.md`
- Maybe modify: `CHANGELOG.md`

**Interfaces:**
- Produces: Updated backlog reflecting shipped MCP prompts, shipped `--fail-on`, reverse graph query support, open crash-atomic indexing, open cross-repo impact in primary analysis, and S1 perf measurement status.

- [ ] **Step 1: Remove stale shipped claims from open backlog rows**
- [ ] **Step 2: Add saved-artifact immutability and crash-atomic indexing as explicit scale/correctness guardrails**
- [ ] **Step 3: Verify with `npm run docs:lint`**
