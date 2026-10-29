// Temporary current-runtime CI diagnostic; removed before product landing.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const [packageRoot, root, manifestPath] = process.argv.slice(2);
assert.equal(process.argv.length, 5);
assert.ok(packageRoot && root && manifestPath);
const emit = (stage, value = {}) => writeSync(1, JSON.stringify({ stage, ...value }) + '\n');
const selectedPath = 'src/adapters/multi-language-regex.ts';
const load = file => import(pathToFileURL(path.join(packageRoot, 'dist', file + '.js')).href);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.length, 287);
assert.equal(manifest.reduce((total, file) => total + file.bytes, 0), 5013975);
assert.equal(new Set(manifest.map(file => file.path)).size, manifest.length);
for (const file of manifest) {
  assert.ok(!path.isAbsolute(file.path) && !file.path.split('/').includes('..'));
}
const { profileAdapter } = await load('bench/config-extraction-profile');
const { initProject } = await load('src/init');
const { createDefaultRegistry, indexProjectWithRegistryForTest } = await load('src/indexer');
const { AdapterRegistry } = await load('src/adapters/registry');

emit('init-start');
await initProject({ repoRoot: root });
emit('init-end', { memory: process.memoryUsage() });
const reader = new DatabaseSync(path.join(root, '.parallax/impact.db'), { readOnly: true });
try {
  for (const [table, column] of [['search_entities_fts', 'entity_id'],
    ['search_relation_evidence_fts', 'evidence_id'], ['search_facts_fts', 'fact_id']]) {
    emit('fts-lookup-plan', { table,
      byId: reader.prepare(`EXPLAIN QUERY PLAN SELECT rowid FROM ${table} WHERE ${column} = ?`).all('diagnostic'),
      byRowid: reader.prepare(`EXPLAIN QUERY PLAN SELECT rowid FROM ${table} WHERE rowid = ?`).all(1) });
  }
} finally {
  reader.close();
}
const sqlObservations = new Map();
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql, ...args) {
  const statement = prepare.call(this, sql, ...args);
  for (const method of ['run', 'get', 'all']) {
    const invoke = statement[method];
    statement[method] = function (...bindings) {
      const started = performance.now();
      const key = method + ' ' + sql.replace(/\s+/g, ' ').trim();
      const observation = sqlObservations.get(key) ?? { statement: key, calls: 0, failures: 0, elapsedMs: 0 };
      sqlObservations.set(key, observation);
      observation.calls += 1;
      try {
        return invoke.apply(this, bindings);
      } catch (error) {
        observation.failures += 1;
        throw error;
      } finally {
        observation.elapsedMs += performance.now() - started;
      }
    };
  }
  return statement;
};
const registry = new AdapterRegistry();
const states = [];
let selectedFiles = 0;
const adapters = createDefaultRegistry().list();
emit('runtime-adapters', { adapters: adapters.map(({ id, version }) => ({ id, version })) });
for (const original of adapters) {
  const samples = [];
  samples.push = (...items) => {
    for (const item of items) {
      emit('adapter-observation', { adapter: original.id, ...item, outcome: 'settled', memory: process.memoryUsage() });
    }
    return Array.prototype.push.apply(samples, items);
  };
  const adapter = profileAdapter(original, samples);
  adapter.version = original.version + '-diagnostic-one-file';
  const start = adapter.start.bind(adapter);
  adapter.start = async (ctx, files) => {
    const state = { adapter: adapter.id, expectedFiles: files.length, completedFiles: 0, failed: false,
      started: false, disposeRequired: false, disposed: false, lastCompletionMs: null };
    states.push(state);
    emit('adapter-start', { adapter: adapter.id, version: adapter.version, files: files.length });
    let run;
    try {
      run = await start(ctx, files);
      state.started = true;
    } catch (error) {
      state.failed = true;
      emit('adapter-start-failed', { adapter: adapter.id, error: error instanceof Error ? error.name : typeof error });
      throw error;
    }
    const processFile = run.process.bind(run);
    run.process = async function* (file) {
      emit('file-start', { adapter: adapter.id, path: file.relativePath });
      let completed = false;
      try {
        if (file.relativePath === selectedPath) {
          selectedFiles += 1;
          yield* processFile(file);
        }
        completed = true;
        state.completedFiles += 1;
        state.lastCompletionMs = performance.now();
      } finally {
        if (!completed) state.failed = true;
        emit('file-settled', { adapter: adapter.id, path: file.relativePath, completed,
          extracted: file.relativePath === selectedPath });
      }
    };
    if (run.dispose) {
      state.disposeRequired = true;
      const dispose = run.dispose.bind(run);
      run.dispose = async () => {
        emit('dispose-start', { adapter: adapter.id });
        try {
          await dispose();
          state.disposed = true;
          state.lastCompletionMs = performance.now();
        } finally {
          if (!state.disposed) state.failed = true;
          emit('dispose-settled', { adapter: adapter.id, completed: state.disposed });
        }
      };
    }
    return run;
  };
  registry.register(adapter);
}

let scanCalls = 0;
let scanReads = null;
emit('index-start', { runtimeSource: '582d400b4a65b28a3512e643d2c99d314fb24e5a', corpusSource: '23ec770595292f27bc363a6746f935c782d3f0cb', phases: 1, selectedPath,
  boundary: 'One-file extraction with all startup inputs, body reads, metadata and redaction. Timed SQL calls include triggers and observation overhead; this is a partial graph, not a full-index benchmark.' });
const started = performance.now();
let result;
try {
  result = await indexProjectWithRegistryForTest({ repoRoot: root, perfObserver(phase, elapsedMs, reads) {
    scanCalls += 1;
    scanReads = reads;
    assert.equal(phase, 'scan');
    assert.equal(reads.bodyReads, 284);
    assert.equal(reads.bodyBytes, 4698579);
    assert.equal(reads.sampleReads, 0);
    assert.equal(reads.sampleBytes, 0);
    emit('scan-settled', { phase, elapsedMs, reads, memory: process.memoryUsage() });
  } }, registry);
} finally {
  DatabaseSync.prototype.prepare = prepare;
  emit('sql-observations', { statements: [...sqlObservations.values()].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 20),
    boundary: 'Observed statement windows include triggers and instrumentation; sample size is one partial graph.' });
}
const ended = performance.now();
const collectionCompleted = states.length > 0 && states.every(state => state.started && !state.failed
  && state.completedFiles === state.expectedFiles && (!state.disposeRequired || state.disposed));
const last = states.at(-1);
emit('index-end', { elapsedMs: ended - started, result, collectionCompleted, states,
  postCollectionWindowMs: collectionCompleted && last.lastCompletionMs !== null ? ended - last.lastCompletionMs : null,
  memory: process.memoryUsage(),
  boundary: 'Current-runtime one-file event publication plus all-file input/metadata/redaction work. Other wrappers omit extraction deliberately. Post-collection includes SQL, bookkeeping and instrumentation. Not full-graph performance, an uninstrumented timing or the earlier VM execution.' });
assert.equal(result.mode, 'full');
assert.equal(scanCalls, 1);
assert.equal(result.filesIndexed, 284);
assert.equal(selectedFiles, 1);
assert.ok(collectionCompleted);
assert.ok(sqlObservations.size > 0);
assert.ok([...sqlObservations.values()].every(observation => observation.failures === 0));
for (const file of manifest) {
  const absolute = path.join(root, file.path);
  assert.equal((await stat(absolute)).size, file.bytes);
  assert.equal(createHash('sha256').update(await readFile(absolute)).digest('hex'), file.sha256);
}
emit('diagnostic-end', { sourceFilesUnchanged: manifest.length, scanCalls, scanReads, phases: 1 });
