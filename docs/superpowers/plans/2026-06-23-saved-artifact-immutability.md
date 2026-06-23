# Saved Artifact Immutability Implementation Plan

**English** · [한국어](2026-06-23-saved-artifact-immutability.ko.md) · [中文](2026-06-23-saved-artifact-immutability.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make saved reports and graph exports explicit immutable snapshots. A report graph export must not change when later index cohorts, carry-forward, repair, retention, or canonical graph row mutation changes rows outside the persisted report JSON.

**Architecture:** Treat the persisted `reports.json` payload as the authoritative snapshot for report-scoped exports. For current reports that include relation-bearing evidence, `exportImpactGraph` should build graph edges from the report JSON first and avoid canonical graph rows changing those edges. Canonical/legacy rows remain a compatibility fallback for older persisted reports that lack relation-bearing evidence.

**Tech Stack:** TypeScript, Node.js `node:test`, SQLite via `node:sqlite`, existing `ImpactReport` / `GraphExport` types, trilingual Markdown docs.

## Global Constraints

- Preserve local-first SQLite and additive migration invariants.
- Do not add a schema migration unless the implementation proves report JSON cannot carry the snapshot contract.
- Do not change `analyze --json` persistence semantics: `--json` stays stdout-only and non-persisted.
- Preserve old persisted report readability where relation-bearing evidence is absent.
- Saved report graph output must be stable after canonical relation/evidence rows for the report's `index_run_id` are mutated or moved by later index cohorts.
- Run `npm run verify` before pushing.

---

### Task 1: Make Graph Export Prefer the Persisted Report Snapshot

**Files:**
- Modify: `src/graph.ts`
- Modify: `tests/parallax.test.ts`

**Interfaces:**
- Consumes: `ImpactReport`, `exportImpactGraph`, persisted `reports.json`.
- Produces: Stable report graph export based on persisted report evidence for modern reports, with canonical/legacy fallback preserved for old reports.

- [ ] **Step 1: Add a RED regression for canonical-row mutation**

Add a test near `exportImpactGraph keeps a saved report graph stable after incremental reindex`:

```ts
test('exportImpactGraph treats persisted report JSON as the immutable graph snapshot', async () => {
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
    nodes: Array<{ id: string; group: string; confidence?: string }>;
    edges: Array<{ id: string; confidence: string; kind: string; source: string; target: string }>;
  };
  assert.ok(beforeParsed.edges.some((edge) => edge.kind === 'DEPENDS_ON'));

  const db = new DatabaseSync(databasePath(repoRoot));
  try {
    db.prepare(
      `UPDATE relations
          SET confidence = 'heuristic',
              provenance = 'mutated-canonical-row'
        WHERE index_run_id = ?`
    ).run(report.indexRunId);
    db.prepare(
      `UPDATE relation_evidence
          SET confidence = 'heuristic',
              snippet = 'mutated evidence row'
        WHERE index_run_id = ?`
    ).run(report.indexRunId);
  } finally {
    db.close();
  }

  const after = await exportImpactGraph({ repoRoot, reportId: report.id, format: 'json' });
  const afterParsed = JSON.parse(after.rendered) as typeof beforeParsed;
  const edgeSnapshot = (edges: typeof beforeParsed.edges) =>
    edges.map((edge) => `${edge.source}\0${edge.kind}\0${edge.target}\0${edge.confidence}`).sort();
  assert.deepEqual(edgeSnapshot(afterParsed.edges), edgeSnapshot(beforeParsed.edges));
  assert.deepEqual(
    afterParsed.nodes.map((node) => `${node.id}\0${node.group}\0${node.confidence ?? ''}`).sort(),
    beforeParsed.nodes.map((node) => `${node.id}\0${node.group}\0${node.confidence ?? ''}`).sort()
  );
  assert.doesNotMatch(after.rendered, /mutated-canonical-row|mutated evidence row/);
});
```

Run:

```bash
node --import tsx --test tests/parallax.test.ts --test-name-pattern "immutable graph snapshot"
```

Expected before implementation: FAIL because canonical rows currently win over persisted report evidence.

- [ ] **Step 2: Prefer report evidence edges for modern reports**

In `src/graph.ts`:

- Build `const reportEdges = buildReportEvidenceEdges(report)` before loading canonical rows.
- If `reportEdges.length > 0`, upsert nodes and edges from those report edges and do not load canonical rows for those same report graph edges.
- If `reportEdges.length === 0`, keep the existing canonical-row path and then legacy fallback for old persisted reports.
- Keep duplicate suppression and sorting deterministic.
- Do not remove the old canonical/legacy fallback path; old report rows may not have `evidence.subject` / `relationKind` / `relationConfidence`.

- [ ] **Step 3: Verify focused graph tests**

Run:

```bash
node --import tsx --test tests/parallax.test.ts --test-name-pattern "exportImpactGraph renders report graph|saved report graph stable|immutable graph snapshot"
```

Expected: PASS.

### Task 2: Document the Snapshot Contract and Close S7 Status

**Files:**
- Modify: `docs/invariants.md`
- Modify: `docs/invariants.ko.md`
- Modify: `docs/invariants.zh.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/roadmap.ko.md`
- Modify: `docs/roadmap.zh.md`
- Modify: `IMPROVEMENT_OPPORTUNITIES.md`

**Interfaces:**
- Consumes: shipped Task 1 behavior.
- Produces: Trilingual docs that make saved report/export immutability an explicit project invariant/status.

- [ ] **Step 1: Add invariant I-11**

Add to all invariant docs:

```markdown
## I-11. Saved reports are immutable snapshots

Persisted reports and report-scoped graph exports are read from the stored report JSON snapshot. Later index runs, carry-forward, retention, repair, or canonical graph row changes must not change what an existing report says. Canonical graph rows may enrich legacy reports only when the persisted report lacks relation-bearing evidence.
```

Translate meaningfully in Korean and Chinese.

- [ ] **Step 2: Mark S7 shipped in backlog/roadmap**

In `docs/roadmap*.md`, change the saved report/export immutable item from unchecked to checked.

In `IMPROVEMENT_OPPORTUNITIES.md`, update:

- the S1 open text so saved/exported artifact immutability is no longer listed as open;
- S7 to ✅ shipped, mentioning persisted report JSON as the graph snapshot source and canonical rows as legacy fallback.

- [ ] **Step 3: Verify docs**

Run:

```bash
npm run docs:lint
git diff --check
```

Expected: PASS.

### Task 3: Final Verification, Review, Commit, Push

**Files:**
- No additional files beyond Tasks 1-2.

**Interfaces:**
- Produces: One reviewed and pushed S7 commit.

- [ ] **Step 1: Focused verification**

Run:

```bash
node --import tsx --test tests/parallax.test.ts --test-name-pattern "exportImpactGraph renders report graph|saved report graph stable|immutable graph snapshot"
npm run check
npm run docs:lint
git diff --check
```

- [ ] **Step 2: Full verification**

Run:

```bash
npm run verify
```

- [ ] **Step 3: Commit and review**

Commit:

```bash
git add src/graph.ts tests/parallax.test.ts docs/invariants.md docs/invariants.ko.md docs/invariants.zh.md docs/roadmap.md docs/roadmap.ko.md docs/roadmap.zh.md IMPROVEMENT_OPPORTUNITIES.md
git commit -m "fix(graph): make saved report exports immutable"
```

Generate a review package, request read-only review, fix Critical/Important findings, then push to `origin/main`.
