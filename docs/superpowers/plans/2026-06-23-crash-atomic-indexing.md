# Crash-Atomic Indexing Implementation Plan

**English** · [한국어](2026-06-23-crash-atomic-indexing.ko.md) · [中文](2026-06-23-crash-atomic-indexing.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the indexing graph/current-state write cohort crash-atomic, so a process death during an index run cannot leave partial rows that look current.

**Architecture:** Keep async adapter extraction outside the SQLite transaction. Collect adapter `IndexEvent`s in memory, then persist files, entities, relations, facts, carry-forward rows, co-change rows, index completion, and branch-head advancement in one synchronous `BEGIN IMMEDIATE` / `COMMIT` block. Keep audit metadata (`index_runs`, `adapter_runs`, and `index_coverage`) available for ordinary adapter exceptions without letting failed/crashed graph rows become current.

**Tech Stack:** TypeScript, Node.js `node:test`, `node:sqlite`, existing `AdapterRegistry` / `SemanticAdapter` interfaces, SQLite WAL.

## Global Constraints

- Preserve `docs/invariants.md`, especially I-5: async work stays outside SQLite transactions.
- No production behavior change without a failing test first.
- A crash during indexing must not advance `branches.main.head_tx_id`.
- A crash during indexing must not leave `files`, `relations`, `relation_evidence`, `evidence`, `symbols`, `edges`, `facts`, or `fact_provenance` rows stamped as the crashed run's current graph cohort.
- Ordinary adapter exceptions should keep the existing failure audit behavior: a failed `index_runs` row, useful `adapter_runs` statuses, skipped/indexed `index_coverage`, and latest completed analysis still reading the last completed run.
- Run `npm run verify` before pushing.

---

### Task 1: Add a Crash Reproduction Test

**Files:**
- Modify: `tests/parallax.test.ts`

**Interfaces:**
- Consumes: `initProject`, `databasePath`, child-process execution with `tsx`.
- Produces: A RED regression proving an abrupt process exit during adapter processing leaves no current graph rows for the crashed run.

- [ ] **Step 1: Write the failing child-process crash test**

Add imports if missing:

```ts
import { pathToFileURL } from 'node:url';
```

Add this test near `failed reruns preserve last completed current-state snapshot for analyzeDiff`:

```ts
test('indexProject crash during adapter processing does not strand a partial current graph cohort', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-crash-atomic-index-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/a.ts'), 'import { core } from "./core";\nexport const a = core;\n');
  await writeFile(path.join(repoRoot, 'src/core.ts'), 'export const core = 1;\n');
  await initProject({ repoRoot });

  const crashScript = path.join(repoRoot, 'crash-index.mjs');
  await writeFile(
    crashScript,
    [
      `import { AdapterRegistry } from ${JSON.stringify(pathToFileURL(path.resolve('src/adapters/registry.ts')).href)};`,
      `import { indexProjectWithRegistryForTest } from ${JSON.stringify(pathToFileURL(path.resolve('src/indexer.ts')).href)};`,
      '',
      'const registry = new AdapterRegistry();',
      'registry.register({',
      "  id: 'crash-after-relation-adapter',",
      "  version: '1',",
      "  capabilities: ['imports'],",
      "  supports: (file) => file.language === 'typescript',",
      '  start: () => ({',
      '    async *process(file) {',
      "      if (file.relativePath === 'src/a.ts') {",
      '        yield {',
      "          kind: 'relation',",
      '          relation: {',
      "            source: { kind: 'file', path: 'src/a.ts', languageId: file.language },",
      "            target: { kind: 'file', path: 'src/core.ts', languageId: file.language },",
      "            kind: 'DEPENDS_ON',",
      "            metadata: { confidence: 'proven', provenance: 'crash-after-relation-adapter:import' },",
      "            evidence: [{ file: file.relativePath, snippet: file.content, confidence: 'proven' }]",
      '          }',
      '        };',
      '        process.exit(42);',
      '      }',
      '    }',
      '  })',
      '});',
      'await indexProjectWithRegistryForTest({ repoRoot: process.argv[2] }, registry);',
      ''
    ].join('\n'),
    'utf8'
  );

  const result = spawnSync(process.execPath, ['--import', tsxLoaderPath, crashScript, repoRoot], {
    cwd: path.resolve('.'),
    encoding: 'utf8'
  });
  assert.equal(result.status, 42, result.stderr);

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const crashedRun = db
      .prepare("SELECT id, status FROM index_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1")
      .get() as { id: number; status: string } | undefined;
    assert.ok(crashedRun, 'crashed run should leave only audit metadata in running state');

    const graphRows = db
      .prepare(
        `SELECT
           (SELECT count(*) FROM files WHERE index_run_id = ?) AS files,
           (SELECT count(*) FROM relations WHERE index_run_id = ?) AS relations,
           (SELECT count(*) FROM relation_evidence WHERE index_run_id = ?) AS relation_evidence,
           (SELECT count(*) FROM evidence WHERE index_run_id = ?) AS evidence,
           (SELECT count(*) FROM symbols WHERE index_run_id = ?) AS symbols,
           (SELECT count(*) FROM edges WHERE index_run_id = ?) AS edges,
           (SELECT count(*) FROM transactions WHERE index_run_id = ?) AS transactions`
      )
      .get(
        crashedRun.id,
        crashedRun.id,
        crashedRun.id,
        crashedRun.id,
        crashedRun.id,
        crashedRun.id,
        crashedRun.id
      ) as {
      files: number;
      relations: number;
      relation_evidence: number;
      evidence: number;
      symbols: number;
      edges: number;
      transactions: number;
    };
    assert.deepEqual(graphRows, {
      files: 0,
      relations: 0,
      relation_evidence: 0,
      evidence: 0,
      symbols: 0,
      edges: 0,
      transactions: 0
    });

    const main = db
      .prepare("SELECT head_tx_id FROM branches WHERE name = 'main'")
      .get() as { head_tx_id: string | null };
    assert.equal(main.head_tx_id, null);
  } finally {
    db.close();
  }
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --import tsx --test tests/parallax.test.ts --test-name-pattern "crash during adapter processing"
```

Expected before implementation: FAIL because the current auto-commit write path strands at least `files`, `relations`, `relation_evidence`, `evidence`, or `transactions` rows for the crashed run.

### Task 2: Buffer Adapter Output and Commit the Graph Cohort in One Transaction

**Files:**
- Modify: `src/indexer.ts`
- Test: `tests/parallax.test.ts`

**Interfaces:**
- Consumes: `IndexEvent`, `ScannedFile`, `SemanticAdapter`, `AdapterRun`, `PreparedStatements`, `PersistContext`, `CurrentStateSnapshot`.
- Produces: A synchronous write transaction that persists one completed index graph cohort atomically after async adapter work has finished.

- [ ] **Step 1: Add collection types**

In `src/indexer.ts`, near `type AdapterGroup`, add:

```ts
type CollectedIndexEvent = {
  adapter: SemanticAdapter;
  adapterRunId: number;
  adapterId: string;
  file: ScannedFile;
  event: IndexEvent;
};

type CollectedIndexRun = {
  events: CollectedIndexEvent[];
  completedFilePathsByAdapterId: Map<string, Set<string>>;
};
```

- [ ] **Step 2: Add a synchronous transaction helper**

Add this helper below `failRunningAdapterRuns`:

```ts
function withIndexWriteTransaction<T>(db: Db, body: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
```

Do not make `body` async. The type should stay `() => T`, not `() => Promise<T>`.

- [ ] **Step 3: Extract adapter event collection outside the transaction**

Replace the event-persisting adapter loop with a collector that:

- starts each adapter exactly as today;
- skips unchanged incremental files exactly as today;
- pushes `{ adapter, adapterRunId, adapterId: adapter.id, file, event }` instead of calling `handleEvent`;
- adds processed paths to `completedFilePaths`;
- calls `updateAdapterRun(..., 'completed')` for successful adapters;
- on adapter error, keeps the existing `updateAdapterRun(..., 'failed')`, `markAdapterCoverageSkipped(...)`, and `markUnstartedAdapterRunsSkipped(...)` behavior, then throws.

The helper signature should be:

```ts
async function collectAdapterEvents(input: {
  repoRoot: string;
  indexRunId: number;
  indexedFiles: readonly ScannedFile[];
  adapterGroups: readonly AdapterGroup[];
  adapterRunIds: ReadonlyMap<SemanticAdapter, number>;
  fileAdapterByPath: ReadonlyMap<string, SemanticAdapter>;
  isIncremental: boolean;
  changedSet: ReadonlySet<string>;
  db: Db;
  insertCoverage: Statement;
}): Promise<CollectedIndexRun>
```

- [ ] **Step 4: Move current graph writes into `persistCollectedIndexRun`**

Create a synchronous helper:

```ts
function persistCollectedIndexRun(input: {
  db: Db;
  repoId: number;
  repoRoot: string;
  indexRunId: number;
  indexedFiles: readonly ScannedFile[];
  unsupportedFiles: readonly ScannedFile[];
  scan: ScanResult;
  adapterGroups: readonly AdapterGroup[];
  fileAdapterByPath: ReadonlyMap<string, SemanticAdapter>;
  collected: CollectedIndexRun;
  priorRun: PriorIndexRun | null;
  delta: IndexDelta;
  mainBranch: { id: string; head_tx_id: string | null };
  memoryTxId: string;
  memoryTs: string;
  currentStateSnapshot: CurrentStateSnapshot;
}): IndexResult
```

Inside `persistCollectedIndexRun`, prepare statements, create `persistCtx`, and call `withIndexWriteTransaction(db, () => { ... })`.

The body must synchronously perform these writes in this order:

1. Insert the indexer memory transaction and `transaction_parents`.
2. Upsert `files`, file entities, file `entity_versions`, and contract descriptors for `indexedFiles`.
3. Replay `collected.events` through `handleEvent(event, file, adapterPersistCtx)`.
4. Insert scan evidence only for files that were actually extracted in this run (`!isIncremental || changedSet.has(file.relativePath)`).
5. Run `carryForwardUnchanged(...)` for incremental runs after changed-file event replay.
6. Insert the co-change adapter run outside or before the transaction, but insert its `CO_CHANGES` graph rows inside the transaction.
7. Update `index_runs` to `completed`.
8. Update `branches.main.head_tx_id` to `memoryTxId`.

Return the same `IndexResult` fields as the current function.

- [ ] **Step 5: Preserve failure audit behavior**

In the outer `catch`, keep failed run status and adapter-run audit behavior. If failure happens before the transaction, no graph write rollback is needed. If failure happens inside `withIndexWriteTransaction`, the helper already rolls back the graph cohort.

Keep this existing pattern valid:

```ts
currentStateSnapshot.restore();
failRunningAdapterRuns(db, indexRunId, error instanceof Error ? error.message : String(error));
db.prepare("UPDATE index_runs SET status = ?, finished_at = datetime('now') WHERE id = ?").run(
  'failed',
  indexRunId
);
```

If `currentStateSnapshot.restore()` becomes redundant after transaction rollback, leave it as a defensive no-op unless tests prove it breaks nested savepoint semantics.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
node --import tsx --test tests/parallax.test.ts --test-name-pattern "crash during adapter processing|failed reruns preserve|per-adapter terminal status|preserves diagnostics"
npm run check
```

Expected: PASS.

### Task 3: Update S2 Documentation Status

**Files:**
- Modify: `IMPROVEMENT_OPPORTUNITIES.md`
- Modify: `docs/roadmap.md`
- Modify if same section exists: `docs/roadmap.ko.md`, `docs/roadmap.zh.md`

**Interfaces:**
- Consumes: shipped S2 behavior from Task 2.
- Produces: Accurate backlog/roadmap wording that says the graph/current-state write cohort is crash-atomic while broader retention/export work remains open.

- [ ] **Step 1: Update backlog wording**

In `IMPROVEMENT_OPPORTUNITIES.md`, change S2 from open to shipped/mostly shipped:

```markdown
| S2 | ✅ **shipped** — write-mode SQLite pragmas are in place, and indexing now commits the graph/current-state cohort in one explicit transaction after adapter extraction finishes. A child-process crash regression proves partial files/relations/evidence/transactions from a crashed run do not become current. |
```

Keep S1/S7/S5/S6 open where applicable.

- [ ] **Step 2: Update roadmap wording**

In `docs/roadmap.md` and localized variants, change:

```markdown
- [ ] Wrap indexing in one explicit transaction so the write path is crash-atomic, not only pragma-tuned
```

to:

```markdown
- [x] Commit indexing graph/current-state writes in one explicit transaction so a crashed run cannot strand a partial current graph cohort
```

- [ ] **Step 3: Verify docs**

Run:

```bash
npm run docs:lint
git diff --check
```

Expected: PASS.

### Task 4: Final Verification, Review, Commit, Push

**Files:**
- No new implementation files beyond Tasks 1-3.

**Interfaces:**
- Produces: One reviewed and pushed commit for S2.

- [ ] **Step 1: Focused verification**

Run:

```bash
node --import tsx --test tests/parallax.test.ts --test-name-pattern "crash during adapter processing|failed reruns preserve|per-adapter terminal status|preserves diagnostics"
npm run check
npm run docs:lint
git diff --check
```

- [ ] **Step 2: Full verification**

Run:

```bash
npm run verify
```

- [ ] **Step 3: Commit**

If all checks pass, commit:

```bash
git add src/indexer.ts tests/parallax.test.ts IMPROVEMENT_OPPORTUNITIES.md docs/roadmap.md docs/roadmap.ko.md docs/roadmap.zh.md
git commit -m "fix(indexer): make index graph writes crash-atomic"
```

- [ ] **Step 4: Review and push**

Generate a review package and request a read-only reviewer. If no Critical or Important issues remain:

```bash
git push origin main
```
