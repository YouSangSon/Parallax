import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import childProcess, { execFileSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { analyzeDiff, exportImpactGraph, importScipJson, indexProject, initProject } from '../src/index.js';
import { remember } from '../src/agent_memory.js';
import type { IndexScanReads, ScannedFile } from '../src/types.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { createDefaultRegistry, indexProjectWithRegistryForTest } from '../src/indexer.js';
import { CONFIG_INFRA_SEMANTIC_ADAPTER_ID } from '../src/adapters/config-infra.js';
import type { IndexEvent, SemanticAdapter } from '../src/adapters/types.js';
import { readGitSnapshot } from '../src/git-snapshot.js';
import { normalizeRepoRoot } from '../src/security.js';
import { getRepoId, latestCompletedIndexRun, openDatabase } from '../src/store.js';

// Correctness oracle for incremental indexing (S1). The graph rows
// (entities/relations/relation_evidence) of the latest completed run, with the
// run id stripped, are the contract that any future incremental path must
// reproduce exactly. This scaffold pins the property that matters today — a full
// reindex is deterministic across runs (modulo index_run_id and run timestamps).
// Slice 2 will reuse `snapshotGraph` to assert: incremental-to-an-end-state ==
// full-reindex-of-that-end-state.

type GraphSnapshot = {
  files: Array<Record<string, unknown>>;
  coverage: Array<Record<string, unknown>>;
  entities: Array<Record<string, unknown>>;
  entityVersions: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  relationEvidence: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  symbols: Array<Record<string, unknown>>;
  contracts: Array<Record<string, unknown>>;
  contractVersions: Array<Record<string, unknown>>;
};

// Snapshot every table the incremental carry-forward mutates, modulo the columns
// that legitimately differ between two repos: index_run_id (the cohort marker)
// and autoincrement surrogate ids (files.id/symbols.id/edges.id). Content-
// addressed ids (entities/relations/*_evidence) are stable, so they are
// compared directly; autoincrement-keyed rows (symbols/edges) are projected
// through files.path so the comparison is identity-free.
function snapshotGraph(root: string): GraphSnapshot {
  const normalized = normalizeRepoRoot(root);
  const db = openDatabase(normalized, { readOnly: true });
  const repoId = getRepoId(db, normalized);
  const runId = latestCompletedIndexRun(db, repoId);
  const files = db
    .prepare(
      `SELECT path, language, content_hash
       FROM files WHERE repo_id = ? AND index_run_id = ? ORDER BY path`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  const coverage = db
    .prepare(
      `SELECT path, adapter_id, language_id, status, reason
       FROM index_coverage WHERE index_run_id = ? ORDER BY path, adapter_id`
    )
    .all(runId) as Array<Record<string, unknown>>;
  const entities = db
    .prepare(
      `SELECT id, kind, path, symbol, language_id, display_name
       FROM entities WHERE repo_id = ? AND updated_index_run_id = ? ORDER BY id`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  const entityVersions = db
    .prepare(
      `SELECT ev.entity_id, ev.content_hash, ev.location_json, ev.state
       FROM entity_versions ev
       JOIN entities e ON e.id = ev.entity_id
       WHERE e.repo_id = ? AND ev.index_run_id = ? ORDER BY ev.entity_id`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  const relations = db
    .prepare(
      `SELECT id, source_entity_id, target_entity_id, kind, confidence, provenance
       FROM relations WHERE repo_id = ? AND index_run_id = ? ORDER BY id`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  const relationEvidence = db
    .prepare(
      `SELECT id, relation_id, file_path, kind, snippet, confidence, start_line, end_line, start_col, end_col
       FROM relation_evidence WHERE repo_id = ? AND index_run_id = ? ORDER BY id`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  const evidence = db
    .prepare(
      `SELECT id, file_path, kind, snippet, confidence
       FROM evidence WHERE repo_id = ? AND index_run_id = ? ORDER BY id`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  // edges/symbols use autoincrement ids that differ between repos; project
  // through files.path and order by stable columns only.
  const edges = db
    .prepare(
      `SELECT src.path AS source_path, tgt.path AS target_path_resolved,
              e.kind, e.target_path, e.confidence, e.provenance
       FROM edges e
       JOIN files src ON src.id = e.source_file_id
       LEFT JOIN files tgt ON tgt.id = e.target_file_id
       WHERE e.repo_id = ? AND e.index_run_id = ?
       ORDER BY src.path, e.kind, e.target_path`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  const symbols = db
    .prepare(
      `SELECT f.path AS file_path, s.name, s.kind, s.exported, s.semantic_id
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE f.repo_id = ? AND s.index_run_id = ?
       ORDER BY f.path, s.semantic_id`
    )
    .all(repoId, runId) as Array<Record<string, unknown>>;
  const contracts = db.prepare(`SELECT id, kind, service_name, path, display_name, metadata_json
    FROM contracts WHERE repo_id = ? ORDER BY id`).all(repoId) as Array<Record<string, unknown>>;
  const contractVersions = db.prepare(`SELECT contract_id, content_hash, schema_version,
      compatibility_json, breaking_change_summary FROM contract_versions
    WHERE index_run_id = ? ORDER BY contract_id`).all(runId) as Array<Record<string, unknown>>;
  db.close();
  return {
    files,
    coverage,
    entities,
    entityVersions,
    relations,
    relationEvidence,
    evidence,
    edges,
    symbols,
    contracts,
    contractVersions
  };
}

function writeChain(root: string): void {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src/leaf.ts'), 'export function foo() {\n  return 1;\n}\n');
  writeFileSync(
    path.join(root, 'src/a.ts'),
    "import { foo } from './leaf.js';\nexport function bar() {\n  return foo();\n}\n"
  );
  writeFileSync(
    path.join(root, 'src/aa.ts'),
    "import { bar } from './a.js';\nexport function baz() {\n  return bar();\n}\n"
  );
}

async function savedImpact(root: string) {
  const report = await analyzeDiff({ repoRoot: root, changedFiles: ['src/a.ts'], writeReport: true });
  const db = openDatabase(normalizeRepoRoot(root), { readOnly: true });
  try {
    const row = db.prepare('SELECT json FROM reports WHERE id = ?').get(report.id) as { json: string };
    assert.deepEqual(JSON.parse(row.json), report, 'compare the persisted report, including its evidence');
  } finally {
    db.close();
  }
  const { id, indexRunId, reportPath, ...semanticReport } = report;
  const { nodes, edges } = await exportImpactGraph({ repoRoot: root, reportId: id, format: 'json' });
  return { id, semanticReport, graph: { nodes, edges } };
}

test('target-only processed-file output can still depend on earlier process calls', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-order-dependent-'));
  const fresh = mkdtempSync(path.join(tmpdir(), 'parallax-order-fresh-'));
  const makeRegistry = (processed: string[]) => {
    const registry = new AdapterRegistry();
    registry.register({
      id: 'run-local-order', version: '1', capabilities: ['references'],
      fileContentScope: 'target-only', outputOwnership: 'processed-file',
      supports: (file) => file.language === 'typescript',
      start: () => {
        let ordinal = 0;
        return {
          async *process(file) {
            processed.push(file.relativePath);
            ordinal += 1;
            if (file.relativePath !== 'src/b.ts') return;
            yield {
              kind: 'relation',
              relation: {
                source: { kind: 'file', path: file.relativePath },
                target: { kind: 'file', path: ordinal === 2 ? 'src/a.ts' : 'src/c.ts' },
                kind: 'DEPENDS_ON',
                evidence: [{ file: file.relativePath, snippet: `ordinal ${ordinal}`, confidence: 'proven' }]
              }
            };
          }
        };
      }
    });
    return registry;
  };
  const write = (dir: string, body: string) => {
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    for (const name of ['a', 'b', 'c']) {
      writeFileSync(path.join(dir, `src/${name}.ts`), name === 'b' ? body : `export const ${name} = 1;\n`);
    }
  };
  try {
    write(root, 'export const b = 1;\n');
    await initProject({ repoRoot: root });
    await indexProjectWithRegistryForTest({ repoRoot: root }, makeRegistry([]));
    const saved = await savedImpact(root);
    assert.ok(saved.semanticReport.affectedFiles.some((file) => file.path === 'src/b.ts'));

    const processed: string[] = [];
    write(root, 'export const b = 2;\n');
    const rerun = await indexProjectWithRegistryForTest({ repoRoot: root }, makeRegistry(processed));
    assert.equal(rerun.mode, 'full', 'content scope and output ownership do not prove process independence');
    assert.deepEqual(processed, ['src/a.ts', 'src/b.ts', 'src/c.ts']);

    write(fresh, 'export const b = 2;\n');
    await initProject({ repoRoot: fresh });
    await indexProjectWithRegistryForTest({ repoRoot: fresh }, makeRegistry([]));
    assert.deepEqual(snapshotGraph(root), snapshotGraph(fresh));
    const actual = await savedImpact(root);
    const expected = await savedImpact(fresh);
    assert.deepEqual(actual.semanticReport, expected.semanticReport);
    assert.deepEqual(actual.graph, expected.graph);
    assert.ok(actual.graph.edges.some((edge) => edge.source === 'file:src/b.ts' && edge.target === 'file:src/a.ts'));
    const old = await exportImpactGraph({ repoRoot: root, reportId: saved.id, format: 'json' });
    assert.deepEqual({ nodes: old.nodes, edges: old.edges }, saved.graph);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});

test('config infra reordered full extraction preserves persisted graphs and saved reports across input changes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-config-order-'));
  const freshRoots: string[] = [];
  const registry = createDefaultRegistry();
  const classify = registry.classify.bind(registry);
  let reversedPaths: string[] = [];
  registry.classify = (files) => {
    const groups = classify(files);
    for (const [adapter, targets] of groups) {
      if (adapter.id === CONFIG_INFRA_SEMANTIC_ADAPTER_ID) {
        targets.reverse();
        reversedPaths = targets.map((file) => file.relativePath);
      }
    }
    return groups;
  };
  const write = (dir: string, edited: boolean, removed: boolean) => {
    mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    mkdirSync(path.join(dir, 'infra'), { recursive: true });
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, '.github/workflows/ci.yml'), 'steps:\n  - run: node src/a.ts\n');
    writeFileSync(path.join(dir, 'Dockerfile'), edited
      ? 'COPY src/b.ts /app/only-b.ts\n'
      : 'COPY src/a.ts /app/a.ts\nCOPY src/b.ts /app/b.ts\n');
    writeFileSync(path.join(dir, 'infra/main.tf'), 'source = "src/b.ts"\n');
    writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n');
    if (removed) rmSync(path.join(dir, 'src/b.ts'), { force: true });
    else writeFileSync(path.join(dir, 'src/b.ts'), 'export const b = 2;\n');
  };
  try {
    write(root, false, false);
    await initProject({ repoRoot: root });
    await indexProjectWithRegistryForTest({ repoRoot: root }, registry);
    assert.deepEqual(reversedPaths, ['infra/main.tf', 'Dockerfile', '.github/workflows/ci.yml']);
    const saved = await savedImpact(root);
    assert.ok(saved.graph.edges.some((edge) => edge.source === 'file:Dockerfile' && edge.target === 'file:src/a.ts'));

    for (const state of [{ name: 'edited target', edited: true, removed: false },
      { name: 'removed context path', edited: true, removed: true }]) {
      write(root, state.edited, state.removed);
      const rerun = await indexProjectWithRegistryForTest({ repoRoot: root }, registry);
      assert.equal(rerun.mode, 'full', state.name);
      const fresh = mkdtempSync(path.join(tmpdir(), 'parallax-config-fresh-'));
      freshRoots.push(fresh);
      write(fresh, state.edited, state.removed);
      await initProject({ repoRoot: fresh });
      await indexProject({ repoRoot: fresh });
      const expected = snapshotGraph(fresh);
      assert.ok(expected.relations.length > 0, state.name);
      assert.ok(expected.relationEvidence.length > 0, state.name);
      assert.ok(expected.coverage.length > 0, state.name);
      if (state.removed) {
        assert.ok(expected.files.every((file) => file.path !== 'src/b.ts'));
        assert.ok(expected.relations.every((relation) => relation.target_entity_id !== 'file:src/b.ts'));
      }
      assert.deepEqual(snapshotGraph(root), expected, state.name);
      const actualReport = await savedImpact(root);
      const expectedReport = await savedImpact(fresh);
      assert.deepEqual(actualReport.semanticReport, expectedReport.semanticReport, state.name);
      assert.deepEqual(actualReport.graph, expectedReport.graph, state.name);
      assert.ok(actualReport.graph.edges.every((edge) => edge.source !== 'file:Dockerfile'), state.name);
      const old = await exportImpactGraph({ repoRoot: root, reportId: saved.id, format: 'json' });
      assert.deepEqual({ nodes: old.nodes, edges: old.edges }, saved.graph, state.name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const fresh of freshRoots) rmSync(fresh, { recursive: true, force: true });
  }
});

function configAudit(root: string) {
  const db = openDatabase(root, { readOnly: true });
  try {
    const runId = latestCompletedIndexRun(db, getRepoId(db, root));
    const owners = db.prepare(`SELECT r.id, ar.adapter_id, ar.status,
        ar.index_run_id = r.index_run_id AS current_owner
      FROM relations r LEFT JOIN adapter_runs ar ON ar.id = r.adapter_run_id
      WHERE r.index_run_id = ? ORDER BY r.id`).all(runId);
    assert.ok(owners.length > 0);
    assert.ok(owners.every((row) => row.current_owner === 1 && row.status === 'completed'));
    const redaction = db.prepare(`SELECT f.id, f.value_blob, f.redacted, fp.kind,
        relation.entity_id, relation.attribute, relation.value_blob AS target
      FROM facts f JOIN fact_provenance fp ON fp.source_fact_id = f.id
      JOIN facts relation ON relation.id = fp.fact_id
      WHERE f.entity_id = 'file:.github/workflows/memo.yml'
        AND f.attribute = 'evidence_snippet' ORDER BY f.id, relation.id`).all();
    assert.ok(redaction.length > 0);
    assert.ok(redaction.every((row) => row.redacted === 1 && row.kind === 'evidence' &&
      String(row.value_blob).includes('[REDACTED_GITHUB_TOKEN]')));
    return { owners, redaction };
  } finally { db.close(); }
}

test('config memo replays through full publication and matches cold fresh graphs, audit and saved reports', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-config-memo-'));
  const freshRoots: string[] = [];
  const workflow = `steps:\n  - run: node src/a.ts # ghp_${'fixture'.repeat(5)}\n`;
  const docker = 'COPY src/a.ts /app/a.ts\nCOPY src/b.ts /app/b.ts\n';
  const editedDocker = 'COPY src/b.ts /app/only-b.ts\n';
  const terraform = 'source = "src/b.ts"\n';
  const configBodies = new Set([workflow, docker, editedDocker, terraform]);
  let computed: string[] = [];
  const lower = String.prototype.toLowerCase;
  t.mock.method(String.prototype, 'toLowerCase', function (this: string) {
    if (configBodies.has(String(this))) computed.push(String(this));
    return lower.call(this);
  });
  const write = (dir: string, source: number, edited: boolean, removed: boolean) => {
    for (const name of ['.github/workflows', 'infra', 'src']) mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(path.join(dir, '.github/workflows/memo.yml'), workflow);
    writeFileSync(path.join(dir, 'Dockerfile'), edited ? editedDocker : docker);
    writeFileSync(path.join(dir, 'infra/main.tf'), terraform);
    writeFileSync(path.join(dir, 'src/a.ts'), `export const a = ${source};\n`);
    if (removed) rmSync(path.join(dir, 'src/b.ts'));
    else writeFileSync(path.join(dir, 'src/b.ts'), "import { a } from './a.js';\nexport const b = a;\n");
  };
  try {
    write(root, 1, false, false);
    await initProject({ repoRoot: root });
    await indexProject({ repoRoot: root });
    assert.deepEqual(computed.sort(), [workflow, docker, terraform].sort());
    const saved = await savedImpact(root);
    assert.ok(saved.graph.edges.some((edge) => edge.source === 'file:Dockerfile'));
    for (const state of [
      { name: 'source body edit', edited: false, removed: false, computed: [] },
      { name: 'config body edit', edited: true, removed: false, computed: [editedDocker] },
      { name: 'context path removal', edited: true, removed: true, computed: [workflow, editedDocker, terraform] }
    ]) {
      write(root, 2, state.edited, state.removed);
      computed = [];
      const reads: IndexScanReads[] = [];
      const actual = await indexProject({ repoRoot: root, perfObserver: (_phase, _ms, scan) => {
        if (scan) reads.push(scan);
      } });
      assert.equal(actual.mode, 'full', state.name);
      assert.deepEqual(computed.sort(), state.computed.sort(), state.name);
      assert.equal(reads.reduce((sum, scan) => sum + scan.bodyReads, 0), state.removed ? 4 : 5,
        'computation reuse must not be reported as skipped scanner reads');
      const fresh = mkdtempSync(path.join(tmpdir(), 'parallax-config-memo-fresh-'));
      freshRoots.push(fresh);
      write(fresh, 2, state.edited, false);
      if (state.removed) rmSync(path.join(fresh, 'src/b.ts'));
      await initProject({ repoRoot: fresh });
      computed = [];
      const expected = await indexProject({ repoRoot: fresh });
      assert.deepEqual(computed.sort(), [workflow, state.edited ? editedDocker : docker, terraform].sort(),
        'the fresh root must compute every config instead of using the warm root memo');
      const { indexRunId: _actualRun, ...actualResult } = actual;
      const { indexRunId: _expectedRun, ...expectedResult } = expected;
      assert.deepEqual(actualResult, expectedResult, state.name);
      assert.deepEqual(snapshotGraph(root), snapshotGraph(fresh), state.name);
      assert.deepEqual(configAudit(root), configAudit(fresh), state.name);
      const report = await savedImpact(root);
      const freshReport = await savedImpact(fresh);
      assert.deepEqual(report.semanticReport, freshReport.semanticReport, state.name);
      assert.deepEqual(report.graph, freshReport.graph, state.name);
      const old = await exportImpactGraph({ repoRoot: root, reportId: saved.id, format: 'json' });
      assert.deepEqual({ nodes: old.nodes, edges: old.edges }, saved.graph, state.name);
      computed = [];
      assert.equal((await indexProject({ repoRoot: root })).mode, 'incremental');
      assert.deepEqual(computed, []);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const fresh of freshRoots) rmSync(fresh, { recursive: true, force: true });
  }
});

for (const git of [false, true]) {
  test(`mixed TypeScript export cycle indexes and matches a fresh graph in ${git ? 'clean Git' : 'non-Git'} repositories`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'parallax-type-cycle-'));
    const fresh = mkdtempSync(path.join(tmpdir(), 'parallax-type-cycle-fresh-'));
    const write = (dir: string) => {
      mkdirSync(path.join(dir, 'src'));
      writeFileSync(path.join(dir, 'src/a.ts'), 'export { Thing as default } from "./b.js";');
      writeFileSync(path.join(dir, 'src/b.ts'), 'export { default as Thing } from "./a.js";');
      writeFileSync(path.join(dir, 'src/use.ts'), 'import Thing from "./a.js"; export class Child extends Thing {}');
      if (git) {
        writeFileSync(path.join(dir, '.gitignore'), '.parallax/\n');
        initOracleGitRepo(dir);
      }
    };
    try {
      write(root);
      await initProject({ repoRoot: root });
      const indexed = await indexProject({ repoRoot: root });
      assert.equal(indexed.mode, 'full');
      const graph = snapshotGraph(root);
      assert.ok(graph.relations.some(row => row.kind === 'DEPENDS_ON' && row.source_entity_id === 'file:src/use.ts'));
      assert.ok(!graph.relations.some(row => row.kind === 'EXTENDS'));
      const db = openDatabase(root, { readOnly: true });
      try {
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM adapter_runs WHERE status = 'failed'").get()?.count, 0);
      } finally { db.close(); }
      const saved = await savedImpact(root);
      assert.equal((await indexProject({ repoRoot: root })).mode, 'incremental');
      write(fresh);
      await initProject({ repoRoot: fresh });
      await indexProject({ repoRoot: fresh });
      assert.deepEqual(snapshotGraph(root), snapshotGraph(fresh));
      const expected = await savedImpact(fresh);
      const actual = await savedImpact(root);
      assert.deepEqual(actual.semanticReport, expected.semanticReport);
      assert.deepEqual(actual.graph, expected.graph);
      const old = await exportImpactGraph({ repoRoot: root, reportId: saved.id, format: 'json' });
      assert.deepEqual({ nodes: old.nodes, edges: old.edges }, saved.graph);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fresh, { recursive: true, force: true });
    }
  });
}

const legacyExportKeys = JSON.parse(readFileSync(new URL('./fixtures/legacy-export-key-events.json', import.meta.url), 'utf8')) as {
  adapterId: string; version: string;
  files: Array<{ relativePath: string; language: string; content: string }>;
  events: Record<string, IndexEvent[]>;
};

for (const git of [false, true]) {
  test(`v40 export-key collisions rebuild unchanged ${git ? 'clean Git' : 'non-Git'} inputs and preserve saved reports`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'parallax-export-key-upgrade-'));
    const fresh = mkdtempSync(path.join(tmpdir(), 'parallax-export-key-fresh-'));
    const write = (dir: string) => {
      for (const file of legacyExportKeys.files) {
        assert.ok(!path.posix.isAbsolute(file.relativePath) && !file.relativePath.split('/').includes('..'));
        const target = path.join(dir, file.relativePath);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, file.content);
      }
      if (git) {
        writeFileSync(path.join(dir, '.gitignore'), '.parallax/\n');
        initOracleGitRepo(dir);
      }
    };
    try {
      write(root);
      await initProject({ repoRoot: root });
      const legacy = new AdapterRegistry();
      for (const adapter of createDefaultRegistry().list()) {
        if (adapter.id !== legacyExportKeys.adapterId) { legacy.register(adapter); continue; }
        const old: SemanticAdapter = Object.create(adapter);
        Object.defineProperty(old, 'version', { value: legacyExportKeys.version });
        Object.defineProperty(old, 'start', { value: () => ({
          async *process(file: ScannedFile) {
            for (const event of legacyExportKeys.events[file.relativePath] ?? []) yield structuredClone(event);
          }
        }) });
        legacy.register(old);
      }
      const indexed = await indexProjectWithRegistryForTest({ repoRoot: root }, legacy);
      const prior = snapshotGraph(root);
      const child = prior.entities.find(row => row.symbol === 'ChildTwo')?.id;
      const first = prior.entities.find(row => row.symbol === 'First' && row.path === 'src/a.ts')?.id;
      assert.ok(child && first);
      assert.ok(prior.relations.some(row => row.kind === 'EXTENDS' && row.source_entity_id === child && row.target_entity_id === first));
      const saved = await savedImpact(root);
      const reportJson = () => {
        const db = openDatabase(root, { readOnly: true });
        try { return (db.prepare('SELECT json FROM reports WHERE id = ?').get(saved.id) as { json: string }).json; }
        finally { db.close(); }
      };
      const beforeJson = reportJson();
      if (git) assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
      const upgraded = await indexProject({ repoRoot: root });
      assert.equal(upgraded.mode, 'full', 'the new version must reject clean reuse and no-op carry');
      assert.ok(upgraded.indexRunId > indexed.indexRunId);
      const graph = snapshotGraph(root);
      const second = graph.entities.find(row => row.symbol === 'Second' && row.path === 'src/b.ts')?.id;
      assert.ok(second);
      assert.ok(graph.relations.some(row => row.kind === 'EXTENDS' && row.source_entity_id === child && row.target_entity_id === second));
      assert.ok(!graph.relations.some(row => row.kind === 'EXTENDS' && row.source_entity_id === child && row.target_entity_id === first));
      const method = graph.entities.find(row => row.symbol === 'Second.make' && row.path === 'src/b.ts')?.id;
      assert.ok(method);
      assert.ok(graph.relationEvidence.some(evidence => evidence.snippet === 'two.make()'
        && graph.relations.some(row => row.id === evidence.relation_id && row.kind === 'CALLS' && row.target_entity_id === method)));
      assert.equal((await indexProject({ repoRoot: root })).mode, 'incremental');
      write(fresh);
      await initProject({ repoRoot: fresh });
      await indexProject({ repoRoot: fresh });
      assert.deepEqual(snapshotGraph(root), snapshotGraph(fresh));
      const actual = await savedImpact(root);
      const expected = await savedImpact(fresh);
      assert.deepEqual(actual.semanticReport, expected.semanticReport);
      assert.deepEqual(actual.graph, expected.graph);
      assert.equal(reportJson(), beforeJson);
      const oldGraph = await exportImpactGraph({ repoRoot: root, reportId: saved.id, format: 'json' });
      assert.deepEqual({ nodes: oldGraph.nodes, edges: oldGraph.edges }, saved.graph);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fresh, { recursive: true, force: true });
    }
  });
}

const legacyTextFixture = JSON.parse(readFileSync(new URL('./fixtures/legacy-text-events.json', import.meta.url), 'utf8')) as {
  lanes: Array<{ adapterId: string; version: string; staleSnippetPrefix?: string; preservedRelationSource?: string;
    files: Array<{ relativePath: string; language: string; content: string }>;
    events: Record<string, IndexEvent[]> }>;
};

for (const lane of legacyTextFixture.lanes) {
  for (const git of [false, true]) {
    test(`${lane.adapterId} v${lane.version} legacy evidence upgrades unchanged ${git ? 'clean Git' : 'non-Git'} inputs without rewriting saved reports`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'parallax-offset-upgrade-'));
      const fresh = mkdtempSync(path.join(tmpdir(), 'parallax-offset-fresh-'));
      const write = (dir: string) => {
        for (const input of [...lane.files, { relativePath: 'src/a.ts', language: 'typescript', content: 'export const a = 1;\n' }]) {
          assert.ok(!path.posix.isAbsolute(input.relativePath) && !input.relativePath.split('/').includes('..'));
          const target = path.join(dir, input.relativePath);
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, input.content);
        }
        if (git) {
          writeFileSync(path.join(dir, '.gitignore'), '.parallax/\n');
          initOracleGitRepo(dir);
        }
      };
      try {
        write(root);
        await initProject({ repoRoot: root });
        const legacy = new AdapterRegistry();
        for (const adapter of createDefaultRegistry().list()) {
          if (adapter.id !== lane.adapterId) { legacy.register(adapter); continue; }
          const old: SemanticAdapter = Object.create(adapter);
          Object.defineProperty(old, 'version', { value: lane.version });
          Object.defineProperty(old, 'start', { value: () => ({
            async *process(file: ScannedFile) {
              for (const event of lane.events[file.relativePath] ?? []) yield structuredClone(event);
            }
          }) });
          legacy.register(old);
        }
        const old = await indexProjectWithRegistryForTest({ repoRoot: root }, legacy);
        const prior = snapshotGraph(root);
        const staleSnippetPrefix = lane.staleSnippetPrefix ?? 'sentinel';
        assert.ok(prior.relationEvidence.some((row) => String(row.snippet).startsWith(staleSnippetPrefix)));
        if (lane.adapterId === CONFIG_INFRA_SEMANTIC_ADAPTER_ID) {
          assert.ok(prior.relations.some((row) => row.source_entity_id === 'file:Dockerfile'));
        }
        const saved = await savedImpact(root);
        const reportJson = () => {
          const db = openDatabase(root, { readOnly: true });
          try { return (db.prepare('SELECT json FROM reports WHERE id = ?').get(saved.id) as { json: string }).json; }
          finally { db.close(); }
        };
        const beforeJson = reportJson();
        assert.ok(beforeJson.includes('"snippet":' + JSON.stringify(staleSnippetPrefix).slice(0, -1)));
        if (git) assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
        const upgraded = await indexProject({ repoRoot: root });
        assert.equal(upgraded.mode, 'full', 'the adapter version must invalidate both clean reuse and no-op carry');
        assert.ok(upgraded.indexRunId > old.indexRunId);
        const graph = snapshotGraph(root);
        assert.ok(graph.relationEvidence.length > 0);
        assert.ok(graph.relationEvidence.every((row) => !String(row.snippet).startsWith(staleSnippetPrefix)));
        const corrected = lane.adapterId === CONFIG_INFRA_SEMANTIC_ADAPTER_ID ? 'run: node src/a.ts' : 'path: src/a.ts';
        assert.ok(graph.relationEvidence.some((row) => row.snippet === corrected && row.start_line === 2 && row.end_line === 2));
        if (lane.adapterId === CONFIG_INFRA_SEMANTIC_ADAPTER_ID) {
          assert.ok(graph.relations.every((row) => row.source_entity_id !== 'file:Dockerfile'),
            'the old false stage-source relation must disappear');
        }
        if (lane.preservedRelationSource) {
          assert.ok(graph.relations.some((row) => row.source_entity_id === lane.preservedRelationSource && row.kind === 'CONFIGURES'),
            'the destination reference must survive source suppression');
        }
        write(fresh);
        await initProject({ repoRoot: fresh });
        await indexProject({ repoRoot: fresh });
        assert.deepEqual(graph, snapshotGraph(fresh));
        const actual = await savedImpact(root);
        const expected = await savedImpact(fresh);
        assert.deepEqual(actual.semanticReport, expected.semanticReport);
        assert.deepEqual(actual.graph, expected.graph);
        assert.equal(reportJson(), beforeJson);
        const oldGraph = await exportImpactGraph({ repoRoot: root, reportId: saved.id, format: 'json' });
        assert.deepEqual({ nodes: oldGraph.nodes, edges: oldGraph.edges }, saved.graph);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(fresh, { recursive: true, force: true });
      }
    });
  }
}

test('a completed config memo cannot hide publication failure and remains reusable after rollback', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-config-memo-rollback-'));
  const fresh = mkdtempSync(path.join(tmpdir(), 'parallax-config-memo-rollback-fresh-'));
  const edited = 'COPY a.ts /app/edited.ts\n';
  const lower = String.prototype.toLowerCase;
  let computed = 0;
  t.mock.method(String.prototype, 'toLowerCase', function (this: string) {
    if (String(this) === edited) computed++;
    return lower.call(this);
  });
  try {
    for (const dir of [root, fresh]) writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(root, 'Dockerfile'), 'COPY a.ts /app/a.ts\n');
    await indexProject({ repoRoot: root });
    const before = snapshotGraph(root);
    writeFileSync(path.join(root, 'Dockerfile'), edited);
    const db = openDatabase(root);
    try {
      db.exec(`CREATE TRIGGER fail_memo_publication BEFORE UPDATE OF status ON index_runs
        WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'forced memo publication failure'); END`);
      for (let attempt = 0; attempt < 2; attempt++) {
        computed = 0;
        await assert.rejects(indexProject({ repoRoot: root }), /forced memo publication failure/);
        assert.equal(computed, attempt === 0 ? 1 : 0,
          'a cache hit must still execute publication and propagate its failure');
        assert.deepEqual(snapshotGraph(root), before);
        const failed = db.prepare('SELECT status, input_snapshot_hash FROM index_runs ORDER BY id DESC LIMIT 1').get();
        assert.equal(failed?.status, 'failed');
        assert.equal(failed?.input_snapshot_hash, null);
      }
      db.exec('DROP TRIGGER fail_memo_publication');
    } finally { db.close(); }
    computed = 0;
    assert.equal((await indexProject({ repoRoot: root })).mode, 'full');
    assert.equal(computed, 0, 'a pure result is reusable independently of graph publication');
    writeFileSync(path.join(fresh, 'Dockerfile'), edited);
    computed = 0;
    await indexProject({ repoRoot: fresh });
    assert.equal(computed, 1, 'fresh reference must miss');
    assert.deepEqual(snapshotGraph(root), snapshotGraph(fresh));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});

test('a full reindex is byte-identical across runs (modulo run id) — the S1 oracle baseline', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-oracle-'));
  try {
    writeChain(root);
    await initProject({ repoRoot: root });

    await indexProject({ repoRoot: root });
    const first = snapshotGraph(root);

    // Re-index with zero source changes: the graph must be reproduced exactly.
    await indexProject({ repoRoot: root });
    const second = snapshotGraph(root);

    assert.deepEqual(second, first);
    assert.ok(first.relations.length > 0, 'fixture must produce relations to make the oracle meaningful');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The S1 oracle proper: a changed full-index adapter input must use full
// extraction, and the resulting graph must be byte-identical to a single full
// reindex of the same end state.
const EDITED_LEAF = 'export function foo() {\n  return 2;\n}\n';

test('a changed full-index file is fully re-extracted and byte-identical to a fresh index', async () => {
  const incrementalRoot = mkdtempSync(path.join(tmpdir(), 'parallax-oracle-incr-'));
  const fullRoot = mkdtempSync(path.join(tmpdir(), 'parallax-oracle-full-'));
  try {
    // Existing repo: full index, then edit leaf.ts body only and re-index.
    writeChain(incrementalRoot);
    await initProject({ repoRoot: incrementalRoot });
    await indexProject({ repoRoot: incrementalRoot });
    writeFileSync(path.join(incrementalRoot, 'src/leaf.ts'), EDITED_LEAF);
    const rerun = await indexProject({ repoRoot: incrementalRoot });
    assert.equal(
      rerun.mode,
      'full',
      'editing a full-index file must promote the rerun to full extraction'
    );
    const incrementalSnapshot = snapshotGraph(incrementalRoot);

    // Full repo: a single full index of the same end state.
    writeChain(fullRoot);
    writeFileSync(path.join(fullRoot, 'src/leaf.ts'), EDITED_LEAF);
    await initProject({ repoRoot: fullRoot });
    const full = await indexProject({ repoRoot: fullRoot });
    assert.equal(full.mode, 'full', 'a first index of a fresh repo is always full');
    const fullSnapshot = snapshotGraph(fullRoot);

    // The oracle is only meaningful if the carried-forward tables are non-empty;
    // otherwise the deepEqual is vacuously true. The import chain produces
    // cross-file edges + call relations, and the functions produce symbols.
    assert.ok(fullSnapshot.relations.length > 0, 'fixture must produce relations');
    assert.ok(fullSnapshot.edges.length > 0, 'fixture must produce cross-file edges');
    assert.ok(fullSnapshot.symbols.length > 0, 'fixture must produce symbols');
    assert.deepEqual(incrementalSnapshot, fullSnapshot);
  } finally {
    rmSync(incrementalRoot, { recursive: true, force: true });
    rmSync(fullRoot, { recursive: true, force: true });
  }
});

// A changed file with outgoing rows exercises the stale-row risk directly. Two
// consecutive edits pin that every promoted run reconstructs the complete graph.
const A_DROP_CALL = "import { foo } from './leaf.js';\nexport function bar() {\n  return 0;\n}\n";
const AA_EDIT = "import { bar } from './a.js';\nexport function baz() {\n  return bar() + 1;\n}\n";

test('consecutive full-index edits drop vanished relations and remain byte-identical to fresh', async () => {
  const incrementalRoot = mkdtempSync(path.join(tmpdir(), 'parallax-oracle-drop-incr-'));
  const fullRoot = mkdtempSync(path.join(tmpdir(), 'parallax-oracle-drop-full-'));
  try {
    // Full, then edit a.ts (drops its CALLS to foo, keeps the import), then edit
    // aa.ts. Both reruns must reconstruct all full-index output.
    writeChain(incrementalRoot);
    await initProject({ repoRoot: incrementalRoot });
    await indexProject({ repoRoot: incrementalRoot });
    writeFileSync(path.join(incrementalRoot, 'src/a.ts'), A_DROP_CALL);
    const hop1 = await indexProject({ repoRoot: incrementalRoot });
    assert.equal(hop1.mode, 'full', 'editing a full-index file must force full extraction');
    writeFileSync(path.join(incrementalRoot, 'src/aa.ts'), AA_EDIT);
    const hop2 = await indexProject({ repoRoot: incrementalRoot });
    assert.equal(hop2.mode, 'full', 'a second full-index edit must also force full extraction');
    const incrementalSnapshot = snapshotGraph(incrementalRoot);

    // Full reindex of the same end state.
    writeChain(fullRoot);
    writeFileSync(path.join(fullRoot, 'src/a.ts'), A_DROP_CALL);
    writeFileSync(path.join(fullRoot, 'src/aa.ts'), AA_EDIT);
    await initProject({ repoRoot: fullRoot });
    await indexProject({ repoRoot: fullRoot });
    const fullSnapshot = snapshotGraph(fullRoot);

    // The dropped a.ts->foo CALLS relation must be stranded on the prior run, not
    // carried forward into the new cohort.
    assert.ok(
      !incrementalSnapshot.relations.some(
        (row) => row.kind === 'CALLS' && row.source_entity_id === 'file:src/a.ts'
      ),
      'the dropped CALLS from a.ts must not survive in the new run cohort'
    );
    assert.deepEqual(incrementalSnapshot, fullSnapshot);
  } finally {
    rmSync(incrementalRoot, { recursive: true, force: true });
    rmSync(fullRoot, { recursive: true, force: true });
  }
});

function writeAliasProject(root: string, target: 'src' | 'other'): void {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'other'), { recursive: true });
  writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': [`${target}/*`] } } })
  );
  writeFileSync(path.join(root, 'src/app.ts'), "import { session } from '@app/session';\nsession();\n");
  writeFileSync(path.join(root, 'src/session.ts'), 'export function session() { return "src"; }\n');
  writeFileSync(path.join(root, 'other/session.ts'), 'export function session() { return "other"; }\n');
}

test('changing full-index context forces a full extraction and matches a fresh index', async () => {
  const incrementalRoot = mkdtempSync(path.join(tmpdir(), 'parallax-oracle-context-incr-'));
  const fullRoot = mkdtempSync(path.join(tmpdir(), 'parallax-oracle-context-full-'));
  try {
    writeAliasProject(incrementalRoot, 'src');
    await initProject({ repoRoot: incrementalRoot });
    await indexProject({ repoRoot: incrementalRoot });
    writeAliasProject(incrementalRoot, 'other');
    const rerun = await indexProject({ repoRoot: incrementalRoot });

    writeAliasProject(fullRoot, 'other');
    await initProject({ repoRoot: fullRoot });
    await indexProject({ repoRoot: fullRoot });

    const incrementalSnapshot = snapshotGraph(incrementalRoot);
    const fullSnapshot = snapshotGraph(fullRoot);
    assert.ok(
      incrementalSnapshot.edges.some(
        (row) => row.source_path === 'src/app.ts' && row.target_path_resolved === 'other/session.ts'
      ),
      'the final alias must resolve src/app.ts to other/session.ts'
    );
    assert.deepEqual(incrementalSnapshot, fullSnapshot);
    assert.equal(rerun.mode, 'full', 'full-index adapter context invalidates changed-only extraction');
  } finally {
    rmSync(incrementalRoot, { recursive: true, force: true });
    rmSync(fullRoot, { recursive: true, force: true });
  }
});

for (const output of ['entity', 'file diagnostic', 'global diagnostic', 'contract', 'foreign placeholder'] as const) {
  test(`skip changes rebuild ${output} before identical-input carry-forward`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'parallax-carry-parity-'));
    const fresh = mkdtempSync(path.join(tmpdir(), 'parallax-carry-fresh-'));
    try {
      const makeFiles = (dir: string, unsupported: string) => {
        writeFileSync(path.join(dir, 'a#diagnostic:literal.ts'), 'export const a = 1;\n');
        if (output === 'contract') writeFileSync(path.join(dir, 'schema.proto'), 'syntax = "proto3";\n');
        writeFileSync(path.join(dir, 'unsupported.py'), unsupported);
      };
      makeFiles(root, 'pass\n');
      makeFiles(fresh, 'x'.repeat(200));
      const registry = new AdapterRegistry();
      registry.register({
        id: 'carry-oracle', version: '1', capabilities: ['references'],
        ...(['global diagnostic', 'foreign placeholder'].includes(output) ? {} : { outputOwnership: 'processed-file' as const }),
        supports: (file) => file.language === 'typescript' || file.language === 'protobuf',
        start: () => ({ async *process(file) {
          if (output === 'contract') {
            if (file.language === 'protobuf') yield { kind: 'entity', entity: {
              kind: 'contract', path: file.relativePath, displayName: 'Custom contract',
              metadata: { serviceName: 'custom-service', schemaVersion: 'v2', compatibility: { marker: 'preserve' } }
            } };
            return;
          }
          if (output === 'foreign placeholder') {
            yield { kind: 'relation', relation: {
              source: { kind: 'file', path: file.relativePath },
              target: { kind: 'contract', path: 'external.proto' }, kind: 'DEPENDS_ON'
            } };
            return;
          }
          if (output === 'entity') {
            yield { kind: 'entity', entity: { kind: 'file', path: file.relativePath, metadata: { marker: 'preserve' } } };
          } else {
            yield { kind: 'diagnostic', level: 'warn', message: 'persistent warning',
              ...(output === 'file diagnostic' ? { file: file.relativePath } : {}) };
          }
        } })
      });
      await indexProjectWithRegistryForTest({ repoRoot: root, maxFileBytes: 100 }, registry);
      writeFileSync(path.join(root, 'unsupported.py'), 'x'.repeat(200));
      const rerun = await indexProjectWithRegistryForTest({ repoRoot: root, maxFileBytes: 100 }, registry);
      await indexProjectWithRegistryForTest({ repoRoot: fresh, maxFileBytes: 100 }, registry);
      assert.equal(rerun.mode, 'full');
      const warnings = (dir: string) => {
        const db = openDatabase(dir, { readOnly: true });
        try {
          return db.prepare(`SELECT adapter_id, error_summary FROM adapter_runs
            WHERE index_run_id = (SELECT max(id) FROM index_runs WHERE status = 'completed')
            ORDER BY adapter_id`).all();
        } finally { db.close(); }
      };
      assert.deepEqual(warnings(root), warnings(fresh));
      assert.deepEqual(snapshotGraph(root), snapshotGraph(fresh));
      const unchanged = await indexProjectWithRegistryForTest({ repoRoot: root, maxFileBytes: 100 }, registry);
      assert.equal(unchanged.mode, 'incremental');
      assert.deepEqual(warnings(root), warnings(fresh));
      assert.deepEqual(snapshotGraph(root), snapshotGraph(fresh), 'a second carry must preserve the same output');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fresh, { recursive: true, force: true });
    }
  });
}

test('legacy input rebuild requires SCIP reapply, then identical-input carry preserves it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-carry-scip-'));
  try {
    const source = 'const value = greet();\n';
    const target = 'export function greet() {}\n';
    writeFileSync(path.join(root, 'app.ts'), source);
    writeFileSync(path.join(root, 'api.ts'), target);
    writeFileSync(path.join(root, 'schema.proto'), 'syntax = "proto3";\n');
    await initProject({ repoRoot: root });
    await indexProject({ repoRoot: root });
    const symbol = 'test npm demo 1.0.0 api.ts/greet().';
    const file = path.join(root, '.parallax', 'fixture.scip.json');
    writeFileSync(file, JSON.stringify({ documents: [
      { relativePath: 'api.ts', language: 'typescript', text: target,
        occurrences: [{ range: [0, 16, 21], symbol, symbolRoles: 1 }],
        symbols: [{ symbol, displayName: 'greet', kind: 'Function' }] },
      { relativePath: 'app.ts', language: 'typescript', text: source,
        occurrences: [{ range: [0, 14, 19], symbol, symbolRoles: 8 }] }
    ] }));
    const imported = importScipJson({ repoRoot: root, file });
    assert.ok(imported.relationsImported > 0, 'fixture must import relations');
    const legacy = openDatabase(root);
    try {
      legacy.prepare('UPDATE index_runs SET input_snapshot_hash = NULL WHERE id = ?').run(imported.indexRunId);
    } finally { legacy.close(); }
    const rebuilt = await indexProject({ repoRoot: root });
    assert.equal(rebuilt.mode, 'full');
    assert.equal(snapshotGraph(root).relations.some((row) => String(row.provenance).startsWith('scip:')), false);
    assert.ok(importScipJson({ repoRoot: root, file }).relationsImported > 0,
      'the existing full-rebuild contract requires reapplying external augmentation');
    const before = snapshotGraph(root);
    const rerun = await indexProject({ repoRoot: root });
    assert.equal(rerun.mode, 'incremental');
    assert.deepEqual(snapshotGraph(root), before);
    const replacement = { documents: [
      { relativePath: 'api.ts', language: 'typescript', text: target, occurrences: [], symbols: [] },
      { relativePath: 'app.ts', language: 'typescript', text: source, occurrences: [] }
    ] };
    writeFileSync(file, JSON.stringify(replacement));
    const reimported = importScipJson({ repoRoot: root, file });
    assert.equal(reimported.relationsImported, 0);
    const db = openDatabase(root, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM relations WHERE adapter_run_id = ?')
        .get(reimported.adapterRunId)?.n, 0, 'reimport must remove vanished carried SCIP relations');
      assert.equal(db.prepare(`SELECT count(*) AS n FROM relations r JOIN adapter_runs a ON a.id = r.adapter_run_id
        WHERE a.adapter_id = 'scip-import'`).get()?.n, 0);
    } finally { db.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('overlapping no-op indexes preserve the published cohort and reject stale publication', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-overlapping-noop-'));
  try {
    writeChain(root);
    await indexProject({ repoRoot: root });
    const before = snapshotGraph(root);
    assert.ok(before.files.length > 0, 'fixture must have a nonempty published graph');
    const results = await Promise.allSettled([
      indexProject({ repoRoot: root }),
      indexProject({ repoRoot: root })
    ]);
    assert.deepEqual(snapshotGraph(root), before, 'a stale carry must not publish an empty cohort');
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    const rejected = results.find((r) => r.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof Error);
    assert.match(rejected.reason.message, /publication baseline changed.*retry/);
    assertFailedRunsUnpublished(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


function pausableRegistry() {
  let pauseNext = false;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const registry = new AdapterRegistry();
  registry.register({
    id: 'publication-oracle', version: '1', capabilities: [],
    supports: (file) => file.language === 'typescript',
    async start() {
      if (pauseNext) {
        pauseNext = false;
        entered();
        await released;
      }
      return { async *process(file: ScannedFile) {
        yield { kind: 'entity' as const, entity: {
          kind: 'file' as const, path: file.relativePath, metadata: { captured: file.content }
        } };
      } };
    }
  });
  return { registry, started, release, pause: () => { pauseNext = true; } };
}

for (const withBaseline of [false, true]) {
  test(`an older full index cannot overwrite a later completion (baseline=${withBaseline})`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'parallax-overlapping-full-'));
    const paused = pausableRegistry();
    let completion: Promise<unknown> | undefined;
    try {
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
      if (withBaseline) await indexProjectWithRegistryForTest({ repoRoot: root }, paused.registry);
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 2;\n');
      paused.pause();
      completion = indexProjectWithRegistryForTest({ repoRoot: root }, paused.registry)
        .then(() => null, (error: unknown) => error);
      await Promise.race([paused.started, completion.then((error) => {
        throw error ?? new Error('index finished before adapter start');
      })]);
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 3;\n');
      const newer = await indexProjectWithRegistryForTest({ repoRoot: root }, paused.registry);
      const published = snapshotGraph(root);
      assert.ok(published.files.length > 0);
      paused.release();
      const failure = await completion;
      assert.deepEqual(snapshotGraph(root), published, 'late completion must preserve the newer graph');
      assert.ok(failure instanceof Error);
      assert.match(failure.message, /publication baseline changed.*retry/);
      assertFailedRunsUnpublished(root);
      const db = openDatabase(root, { readOnly: true });
      try {
        assert.equal(latestCompletedIndexRun(db, getRepoId(db, root)), newer.indexRunId);
        assert.equal(db.prepare("SELECT count(*) AS n FROM index_runs WHERE status = 'running'").get()?.n, 0);
      } finally { db.close(); }
    } finally {
      paused.release();
      await completion;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('an index cannot discard a memory head published while its adapter is running', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-overlapping-memory-'));
  const paused = pausableRegistry();
  let completion: Promise<unknown> | undefined;
  try {
    writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    await indexProjectWithRegistryForTest({ repoRoot: root }, paused.registry);
    writeFileSync(path.join(root, 'a.ts'), 'export const a = 2;\n');
    paused.pause();
    completion = indexProjectWithRegistryForTest({ repoRoot: root }, paused.registry)
      .then(() => null, (error: unknown) => error);
    await Promise.race([paused.started, completion.then((error) => {
        throw error ?? new Error('index finished before adapter start');
      })]);
    const db = openDatabase(root);
    let memoryHead: string;
    try {
      memoryHead = remember(db, { entity: 'file:a.ts', attribute: 'observed', value: 'keep' }, null).txId;
    } finally { db.close(); }
    const published = snapshotGraph(root);
    paused.release();
    const failure = await completion;
    assert.deepEqual(snapshotGraph(root), published);
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /publication baseline changed.*retry/);
    assertFailedRunsUnpublished(root);
    const after = openDatabase(root, { readOnly: true });
    try {
      assert.equal(after.prepare("SELECT head_tx_id FROM branches WHERE name = 'main'").get()?.head_tx_id, memoryHead);
    } finally { after.close(); }
  } finally {
    paused.release();
    await completion;
    rmSync(root, { recursive: true, force: true });
  }
});


function assertFailedRunsUnpublished(root: string): void {
  const db = openDatabase(root, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM index_runs WHERE status = 'failed'").get()?.n, 1);
    for (const table of ['files', 'entity_versions', 'contract_versions', 'relations', 'transactions']) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}
        WHERE index_run_id IN (SELECT id FROM index_runs WHERE status = 'failed')`).get()?.n,
      0, `failed publication leaked ${table}`);
    }
  } finally { db.close(); }
}


function initOracleGitRepo(root: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Parallax Test', '-c', 'user.email=parallax@example.com',
    'commit', '-m', 'baseline'], { cwd: root, stdio: 'ignore' });
}

test('restoring clean HEAD after a dirty index rebuilds the current cohort before reuse', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-restored-head-'));
  const fresh = mkdtempSync(path.join(tmpdir(), 'parallax-restored-fresh-'));
  try {
    writeChain(root);
    writeChain(fresh);
    initOracleGitRepo(root);
    const first = await indexProject({ repoRoot: root });
    writeFileSync(path.join(root, 'src/leaf.ts'), 'export function foo() { return 2; }\n');
    const dirty = await indexProject({ repoRoot: root });
    assert.equal(dirty.mode, 'full');
    assert.notEqual(dirty.indexRunId, first.indexRunId);
    execFileSync('git', ['restore', 'src/leaf.ts'], { cwd: root });
    const restored = await indexProject({ repoRoot: root });
    assert.notEqual(restored.indexRunId, first.indexRunId, 'historical clean rows no longer own the current graph');
    assert.equal(restored.mode, 'full');
    assert.equal(restored.filesIndexed, first.filesIndexed);
    await indexProject({ repoRoot: fresh });
    assert.deepEqual(snapshotGraph(root), snapshotGraph(fresh));
    const reused = await indexProject({ repoRoot: root });
    assert.equal(reused.indexRunId, restored.indexRunId);
    assert.equal(reused.mode, 'incremental');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});

test('clean validation rescans after another process moves the candidate cohort', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-reuse-snapshot-'));
  try {
    writeChain(root);
    initOracleGitRepo(root);
    const first = await indexProject({ repoRoot: root });
    assert.ok(first.filesIndexed > 0);
    const original = childProcess.execFileSync;
    let moved = false;
    let childRunId: number | undefined;
    let childFailure: string | undefined;
    t.mock.method(childProcess, 'execFileSync', (...args: unknown[]) => {
      if (!moved && args[0] === 'git' && Array.isArray(args[1]) && args[1].join(' ') === 'ls-files -z') {
        moved = true;
        const child = indexWithChildCli(root);
        if (child.status !== 0) {
          childFailure = child.error?.message ?? child.stderr;
        } else {
          try { childRunId = JSON.parse(child.stdout).indexRunId as number; }
          catch (error) { childFailure = String(error); }
        }
      }
      return Reflect.apply(original, childProcess, args);
    });
    syncBuiltinESMExports();
    let scans = 0;
    const reused = await indexProject({ repoRoot: root, perfObserver: () => { scans++; } });
    assert.equal(moved, true, 'writer must run after candidate selection');
    assert.equal(childFailure, undefined);
    assert.ok(childRunId !== undefined && childRunId > first.indexRunId);
    assert.equal(scans, 2, 'cohort movement requires a new run and fresh capture after validation');
    assert.ok(reused.indexRunId > childRunId);
    assert.equal(reused.filesIndexed, first.filesIndexed, 'cohort movement must not mix an old ID with empty live rows');
    const db = openDatabase(root, { readOnly: true });
    try { assert.equal(latestCompletedIndexRun(db, getRepoId(db, root)), reused.indexRunId); }
    finally { db.close(); }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cache validation cannot retain A after a child publishes B and restores A', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-reuse-restored-input-'));
  const fresh = mkdtempSync(path.join(tmpdir(), 'parallax-reuse-restored-fresh-'));
  try {
    writeChain(root);
    writeChain(fresh);
    initOracleGitRepo(root);
    await indexProject({ repoRoot: root });
    const leaf = path.join(root, 'src/leaf.ts');
    const originalBody = readFileSync(leaf, 'utf8');
    execFileSync('git', ['update-index', '--assume-unchanged', 'src/leaf.ts'], { cwd: root });
    writeFileSync(leaf, originalBody.replace('return 1', 'return 2'));
    assert.equal(readGitSnapshot(root).isDirty, false);
    const original = childProcess.execFileSync;
    let child: ReturnType<typeof indexWithChildCli> | undefined;
    t.mock.method(childProcess, 'execFileSync', (...args: unknown[]) => {
      if (!child && args[0] === 'git' && Array.isArray(args[1]) && args[1].join(' ') === 'ls-files -z') {
        child = indexWithChildCli(root);
        writeFileSync(leaf, originalBody);
      }
      return Reflect.apply(original, childProcess, args);
    });
    syncBuiltinESMExports();
    const result = await indexProject({ repoRoot: root });
    assert.ok(child);
    assert.equal(child.status, 0, child.error?.message ?? child.stderr.slice(-1000));
    await indexProject({ repoRoot: fresh });
    assert.deepEqual(snapshotGraph(root), snapshotGraph(fresh),
      'latest graph must be restored A, not the completed child B hidden by the old reader snapshot');
    assert.ok(result.indexRunId > (JSON.parse(child.stdout) as { indexRunId: number }).indexRunId);
    const db = openDatabase(root, { readOnly: true });
    try { assert.equal(latestCompletedIndexRun(db, getRepoId(db, root)), result.indexRunId); }
    finally { db.close(); }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});


test('a fatal clean-reuse snapshot error closes the database before returning failure', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-reuse-failure-'));
  let failedDb: DatabaseSync | undefined;
  try {
    writeChain(root);
    initOracleGitRepo(root);
    const original = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) {
      if (sql === 'BEGIN DEFERRED') {
        failedDb = this;
        throw new Error('injected read snapshot failure');
      }
      return Reflect.apply(original, this, [sql]);
    });
    await assert.rejects(indexProject({ repoRoot: root }), /injected read snapshot failure/);
    assert.ok(failedDb);
    assert.equal(failedDb.isOpen, false, 'reuse fails before the normal failed-run catch');
  } finally {
    t.mock.restoreAll();
    if (failedDb?.isOpen) failedDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});


function indexWithChildCli(root: string) {
  return childProcess.spawnSync(process.execPath, [
    '--import', createRequire(import.meta.url).resolve('tsx'),
    fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
    'index', '--max-file-bytes', '1000000'
  ], { cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PARALLAX_EMBEDDING_MODEL: 'stub-sha256', PARALLAX_REFLECTION_MODEL: 'stub' } });
}

test('a run overtaken during scan cannot move a newer completed cohort to its older ID', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-preplan-overtake-'));
  let child: ReturnType<typeof indexWithChildCli> | undefined;
  try {
    writeChain(root);
    initOracleGitRepo(root);
    const failure = await indexProject({ repoRoot: root, perfObserver: () => {
      child = indexWithChildCli(root);
    } }).then(() => null, (error: unknown) => error);
    assert.ok(child);
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    const winner = JSON.parse(child.stdout) as { indexRunId: number; filesIndexed: number };
    assert.ok(winner.filesIndexed > 0);
    assert.ok(snapshotGraph(root).files.length > 0, 'pre-plan overtaking must not empty the latest cohort');
    assert.ok(failure instanceof Error, 'a lower-ID run cannot publish using a newer completed baseline');
    assert.match(failure.message, /publication baseline changed.*retry/);
    assertFailedRunsUnpublished(root);
    const reused = await indexProject({ repoRoot: root });
    assert.equal(reused.indexRunId, winner.indexRunId);
    assert.equal(reused.filesIndexed, winner.filesIndexed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


const hiddenGitInputs = [
  'assume-unchanged', 'skip-worktree', 'active-autocrlf', 'active-text-eol',
  'unsafe-baseline-then-clear', 'temporary-autocrlf', 'removed-same-length-filter'
] as const;

for (const hidden of hiddenGitInputs) {
  for (const forced of [false, true]) {
    test(`Git cache ${hidden}: ${forced ? 'explicit CLI byte limit revalidates' : 'default cache must revalidate'} bodies`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'parallax-hidden-git-'));
      const fresh = mkdtempSync(path.join(tmpdir(), 'parallax-hidden-fresh-'));
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
      try {
        writeChain(root);
        writeChain(fresh);
        if (hidden === 'active-text-eol') {
          for (const dir of [root, fresh]) writeFileSync(path.join(dir, '.gitattributes'), '*.ts text eol=lf\n');
        }
        initOracleGitRepo(root);
        git('config', 'core.autocrlf', 'false');
        const first = await indexProject({ repoRoot: root });
        const leaf = path.join(root, 'src/leaf.ts');
        const original = readFileSync(leaf, 'utf8');
        let priorId = first.indexRunId;
        const isEol = ['active-autocrlf', 'active-text-eol', 'temporary-autocrlf'].includes(hidden);
        const changed = isEol ? original.replace(/\n/g, '\r\n') : original.replace('return 1', 'return 2');
        if (hidden === 'assume-unchanged' || hidden === 'unsafe-baseline-then-clear') {
          git('update-index', '--assume-unchanged', 'src/leaf.ts');
        } else if (hidden === 'skip-worktree') {
          git('update-index', '--skip-worktree', 'src/leaf.ts');
        }
        writeFileSync(leaf, changed);
        if (hidden === 'active-autocrlf') git('config', 'core.autocrlf', 'true');
        if (isEol || hidden === 'removed-same-length-filter') {
          // Keep mtime older than the index so Git's racy-entry check is not the oracle.
          const old = new Date('2000-01-01T00:00:00Z');
          utimesSync(leaf, old, old);
          if (hidden === 'temporary-autocrlf') {
            git('-c', 'core.autocrlf=true', 'add', 'src/leaf.ts');
          } else if (hidden === 'removed-same-length-filter') {
            const attrs = path.join(root, '.git/info/attributes');
            writeFileSync(attrs, 'src/leaf.ts filter=probe\n');
            const filter = "node -e \"let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(s.replace(/return 2/g,'return 1')));\"";
            git('config', 'filter.probe.clean', filter);
            git('add', 'src/leaf.ts');
            git('config', '--unset', 'filter.probe.clean');
            rmSync(attrs);
          } else {
            git('add', 'src/leaf.ts');
          }
        }
        if (hidden === 'unsafe-baseline-then-clear') {
          const unsafe = await indexProject({ repoRoot: root, maxFileBytes: 1_000_000 });
          assert.equal(unsafe.mode, 'full');
          priorId = unsafe.indexRunId;
          writeFileSync(leaf, original);
          git('update-index', '--no-assume-unchanged', 'src/leaf.ts');
        }
        const observedGit = readGitSnapshot(root);
        assert.equal(observedGit.commitSha, git('rev-parse', 'HEAD').trim());
        assert.equal(observedGit.isDirty, false, 'fixture must hide its raw input change from Git status');
        assert.equal(git('write-tree').trim(), git('rev-parse', 'HEAD^{tree}').trim());
        writeFileSync(path.join(fresh, 'src/leaf.ts'), readFileSync(leaf));
        let result;
        if (forced) {
          const child = indexWithChildCli(root);
          assert.equal(child.status, 0, child.error?.message ?? child.stderr.slice(-1000));
          result = JSON.parse(child.stdout) as Awaited<ReturnType<typeof indexProject>>;
        } else {
          result = await indexProject({ repoRoot: root });
        }
        assert.notEqual(result.indexRunId, priorId, 'raw input changes require a new extraction cohort');
        assert.equal(result.mode, 'full');
        await indexProject({ repoRoot: fresh });
        assert.deepEqual(snapshotGraph(root), snapshotGraph(fresh));
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(fresh, { recursive: true, force: true });
      }
    });
  }
}

for (const forced of [false, true]) {
  test(`actual inputs survive mutable supports hashes (explicit byte limit=${forced})`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'parallax-input-binding-'));
    const fresh = mkdtempSync(path.join(tmpdir(), 'parallax-input-binding-fresh-'));
    const before = 'export const value = 1;\n';
    const after = 'export const value = 2;\n';
    const registry = new AdapterRegistry();
    registry.register({
      id: 'mutable-supports-input', version: '1', capabilities: [],
      supports: (file) => {
        file.hash = createHash('sha256').update(after).digest('hex');
        return file.language === 'typescript';
      },
      start: () => ({ async *process(file) {
        yield { kind: 'diagnostic', level: 'warn', file: file.relativePath, message: file.content };
      } })
    });
    try {
      writeFileSync(path.join(root, 'a.ts'), before);
      writeFileSync(path.join(root, '.gitignore'), '.parallax/\n');
      initOracleGitRepo(root);
      await indexProjectWithRegistryForTest({ repoRoot: root }, registry);
      execFileSync('git', ['update-index', '--assume-unchanged', 'a.ts'], { cwd: root });
      writeFileSync(path.join(root, 'a.ts'), after);
      assert.equal(readGitSnapshot(root).isDirty, false);
      writeFileSync(path.join(fresh, 'a.ts'), after);
      await indexProjectWithRegistryForTest({ repoRoot: fresh }, registry);
      const oracle = snapshotGraph(fresh);
      assert.ok(oracle.coverage.some((row) => String(row.reason).includes('value = 2')));
      const rerun = await indexProjectWithRegistryForTest({ repoRoot: root,
        ...(forced ? { maxFileBytes: 1_000_000 } : {}) }, registry);
      assert.deepEqual(snapshotGraph(root), oracle);
      assert.equal(rerun.mode, 'full');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fresh, { recursive: true, force: true });
    }
  });
}

for (const historyChange of ['deepen', 'shorten'] as const) {
  for (const forced of [false, true]) {
    test(`Git cache history ${historyChange}: ${forced ? 'explicit CLI byte limit refreshes' : 'default cache must refresh'} history-derived graph`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'parallax-hidden-history-'));
      const origin = path.join(root, 'origin');
      const clone = path.join(root, 'clone');
      const git = (cwd: string, ...args: string[]) => execFileSync('git', [
        '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args
      ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
      const commit = () => {
        git(origin, 'add', '.');
        git(origin, '-c', 'user.name=Parallax Test', '-c', 'user.email=parallax@example.invalid',
          'commit', '-m', 'synthetic co-change history');
      };
      try {
        mkdirSync(origin);
        git(origin, 'init', '-b', 'main');
        writeFileSync(path.join(origin, '.gitignore'), '.parallax/\n');
        for (const value of [1, 2, 3]) {
          writeFileSync(path.join(origin, 'a.ts'), `export const a = ${value};\n`);
          writeFileSync(path.join(origin, 'b.ts'), `export const b = ${value};\n`);
          commit();
        }
        writeFileSync(path.join(origin, 'note.txt'), 'latest commit changes neither source\n');
        commit();
        git(root, '-c', 'protocol.file.allow=always', 'clone',
          ...(historyChange === 'deepen' ? ['--depth=1'] : []), pathToFileURL(origin).href, clone);
        const beforeGit = readGitSnapshot(clone);
        const beforeTree = git(clone, 'rev-parse', 'HEAD^{tree}');
        const bodies = ['a.ts', 'b.ts'].map((name) => readFileSync(path.join(clone, name), 'utf8'));
        await indexProject({ repoRoot: clone });
        assert.equal(snapshotGraph(clone).relations.filter((row) => row.kind === 'CO_CHANGES').length,
          historyChange === 'deepen' ? 0 : 2);
        git(clone, '-c', 'protocol.file.allow=always', 'fetch', historyChange === 'deepen' ? '--unshallow' : '--depth=1');
        assert.equal(git(clone, 'rev-parse', '--is-shallow-repository').trim(), String(historyChange === 'shorten'));
        assert.equal(git(clone, 'status', '--porcelain').trim(), '');
        assert.equal(git(clone, 'rev-parse', 'HEAD^{tree}'), beforeTree);
        assert.deepEqual(readGitSnapshot(clone), beforeGit);
        assert.deepEqual(['a.ts', 'b.ts'].map((name) => readFileSync(path.join(clone, name), 'utf8')), bodies);

        const oracleRoot = historyChange === 'deepen' ? origin : path.join(root, 'fresh');
        if (historyChange === 'shorten') {
          git(root, '-c', 'protocol.file.allow=always', 'clone', '--depth=1', pathToFileURL(origin).href, oracleRoot);
        }
        await indexProject({ repoRoot: oracleRoot });
        const oracle = snapshotGraph(oracleRoot);
        assert.equal(oracle.relations.filter((row) => row.kind === 'CO_CHANGES').length,
          historyChange === 'deepen' ? 2 : 0, 'fresh full extraction must reflect the current history');
        if (forced) {
          const child = indexWithChildCli(clone);
          assert.equal(child.status, 0, child.error?.message ?? child.stderr.slice(-1000));
        } else {
          await indexProject({ repoRoot: clone });
        }
        assert.deepEqual(snapshotGraph(clone), oracle);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

for (const receipt of [null, 's1-input-v0:unverified']) {
  test(`an unverified input receipt rebuilds once before clean reuse (${receipt})`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'parallax-legacy-input-'));
    try {
      writeChain(root);
      initOracleGitRepo(root);
      const first = await indexProject({ repoRoot: root });
      const before = snapshotGraph(root);
      const db = openDatabase(root);
      try { db.prepare('UPDATE index_runs SET input_snapshot_hash = ? WHERE id = ?').run(receipt, first.indexRunId); }
      finally { db.close(); }
      const rebuilt = await indexProject({ repoRoot: root });
      assert.equal(rebuilt.mode, 'full');
      assert.notEqual(rebuilt.indexRunId, first.indexRunId);
      assert.deepEqual(snapshotGraph(root), before);
      const reader = openDatabase(root, { readOnly: true });
      try {
        assert.match(String(reader.prepare('SELECT input_snapshot_hash FROM index_runs WHERE id = ?')
          .get(rebuilt.indexRunId)?.input_snapshot_hash), /^s1-input-v1:[a-f0-9]{64}$/);
      } finally { reader.close(); }
      assert.equal((await indexProject({ repoRoot: root })).indexRunId, rebuilt.indexRunId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('co-change savepoint failure publishes no valid input receipt and retries fully', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-input-cochange-failure-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  try {
    git('init');
    git('config', 'user.name', 'Parallax Test');
    git('config', 'user.email', 'parallax@example.invalid');
    writeFileSync(path.join(root, '.gitignore'), '.parallax/\n');
    for (const value of [1, 2, 3]) {
      writeFileSync(path.join(root, 'a.ts'), `export const a = ${value};\n`);
      writeFileSync(path.join(root, 'b.ts'), `export const b = ${value};\n`);
      git('add', '.');
      git('-c', 'commit.gpgsign=false', 'commit', '-m', 'co-change fixture');
    }
    const first = await indexProject({ repoRoot: root });
    const db = openDatabase(root);
    try {
      db.prepare('UPDATE index_runs SET input_snapshot_hash = NULL WHERE id = ?').run(first.indexRunId);
      db.exec(`CREATE TRIGGER fail_cochange BEFORE INSERT ON relations
        WHEN NEW.kind = 'CO_CHANGES' BEGIN SELECT RAISE(ABORT, 'forced co-change failure'); END`);
      const incomplete = await indexProject({ repoRoot: root });
      assert.equal(incomplete.mode, 'full');
      assert.deepEqual({ ...db.prepare('SELECT status, input_snapshot_hash FROM index_runs WHERE id = ?').get(incomplete.indexRunId) },
        { status: 'completed', input_snapshot_hash: null });
      assert.equal(db.prepare("SELECT status FROM adapter_runs WHERE index_run_id = ? AND adapter_id = 'co-change'")
        .get(incomplete.indexRunId)?.status, 'failed');
      assert.equal(snapshotGraph(root).relations.filter((row) => row.kind === 'CO_CHANGES').length, 0);
      db.exec('DROP TRIGGER fail_cochange');
      const recovered = await indexProject({ repoRoot: root });
      assert.equal(recovered.mode, 'full');
      assert.equal(snapshotGraph(root).relations.filter((row) => row.kind === 'CO_CHANGES').length, 2);
      assert.equal((await indexProject({ repoRoot: root })).indexRunId, recovered.indexRunId);
    } finally { db.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a precheck miss publishes only the second scan and history and observes both reads', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-input-rescan-'));
  const fresh = mkdtempSync(path.join(tmpdir(), 'parallax-input-rescan-fresh-'));
  const firstBody = 'export const a = 1;\n';
  const precheckBody = 'export const a = 22;\n';
  const currentBody = 'export const a = 333;\n';
  const otherBody = 'export const b = 1;\n';
  try {
    for (const dir of [root, fresh]) {
      writeFileSync(path.join(dir, 'a.ts'), dir === root ? firstBody : currentBody);
      writeFileSync(path.join(dir, 'b.ts'), otherBody);
      initOracleGitRepo(dir);
      writeFileSync(path.join(dir, '.git/info/exclude'), '.parallax/\n');
    }
    await indexProject({ repoRoot: root });
    execFileSync('git', ['update-index', '--assume-unchanged', 'a.ts'], { cwd: root });
    writeFileSync(path.join(root, 'a.ts'), precheckBody);
    assert.equal(readGitSnapshot(root).isDirty, false);
    const original = childProcess.execFileSync;
    let historyReads = 0;
    t.mock.method(childProcess, 'execFileSync', (...args: unknown[]) => {
      if (args[0] === 'git' && Array.isArray(args[1]) && args[1][0] === 'log') {
        return '\0a.ts\nb.ts\n'.repeat(++historyReads === 1 ? 1 : 3);
      }
      return Reflect.apply(original, childProcess, args);
    });
    syncBuiltinESMExports();
    const reads: IndexScanReads[] = [];
    const result = await indexProject({ repoRoot: root, perfObserver: (_phase, _ms, observed) => {
      assert.ok(observed);
      reads.push({ ...observed });
      if (reads.length === 1) writeFileSync(path.join(root, 'a.ts'), currentBody);
    } });
    assert.equal(result.mode, 'full');
    assert.equal(historyReads, 2, 'validation history cannot be reused after the miss or read again during publication');
    assert.deepEqual(reads.map((item) => item.bodyReads), [2, 2]);
    assert.deepEqual(reads.map((item) => item.bodyBytes), [
      Buffer.byteLength(precheckBody + otherBody), Buffer.byteLength(currentBody + otherBody)
    ]);
    await indexProject({ repoRoot: fresh });
    const oracle = snapshotGraph(fresh);
    assert.equal(oracle.relations.filter((row) => row.kind === 'CO_CHANGES').length, 2);
    assert.deepEqual(snapshotGraph(root), oracle);
    const receipt = (dir: string) => {
      const db = openDatabase(dir, { readOnly: true });
      try { return db.prepare("SELECT input_snapshot_hash FROM index_runs WHERE status = 'completed' ORDER BY id DESC LIMIT 1").get()?.input_snapshot_hash; }
      finally { db.close(); }
    };
    assert.equal(receipt(root), receipt(fresh), 'publication receipt must bind the second captured input set');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});
