// Temporary historical-source CI diagnostic; removed before product landing.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const [packageRoot, root, manifestPath] = process.argv.slice(2);
assert.equal(process.argv.length, 5);
assert.ok(packageRoot && root && manifestPath);
const emit = (stage, value = {}) => writeSync(1, JSON.stringify({ stage, ...value }) + '\n');
const load = file => import(pathToFileURL(path.join(packageRoot, 'dist', file + '.js')).href);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const selectedPath = 'src/adapters/multi-language-regex.ts';
assert.equal(manifest.length, 287);
assert.equal(manifest.reduce((total, file) => total + file.bytes, 0), 5013975);
assert.equal(new Set(manifest.map(file => file.path)).size, manifest.length);
assert.ok(manifest.some(file => file.path === selectedPath));
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
const registry = new AdapterRegistry();
const states = [];
for (const original of createDefaultRegistry().list()) {
  const samples = [];
  samples.push = (...items) => {
    for (const item of items) {
      emit('adapter-observation', { adapter: original.id, ...item, outcome: 'settled', memory: process.memoryUsage() });
    }
    return Array.prototype.push.apply(samples, items);
  };
  const adapter = profileAdapter(original, samples);
  adapter.version += '-diagnostic-single-file';
  const start = adapter.start.bind(adapter);
  adapter.start = async (ctx, files) => {
    const state = { adapter: adapter.id, expectedFiles: files.length, completedFiles: 0, failed: false,
      started: false, disposeRequired: false, disposed: false, lastCompletionMs: null };
    states.push(state);
    emit('adapter-start', { adapter: adapter.id, files: files.length });
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
      const selected = file.relativePath === selectedPath;
      emit('file-start', { adapter: adapter.id, path: file.relativePath, selected });
      let completed = false;
      try {
        if (selected) {
          const digest = createHash('sha256');
          let events = 0;
          let encodedBytes = 0;
          for await (const event of processFile(file)) {
            const encoded = JSON.stringify(event) + '\n';
            digest.update(encoded);
            events += 1;
            encodedBytes += Buffer.byteLength(encoded);
            assert.ok(events <= 2070 && encodedBytes <= 1541387);
            yield event;
          }
          const sha256 = digest.digest('hex');
          // The indexer rethrows adapter errors before entering publication.
          assert.equal(events, 2070);
          assert.equal(encodedBytes, 1541387);
          assert.equal(sha256, 'c5d0f66d198d7b230c720fd62a38ddc10a11a9d5dae2ac28a73568cb7939fa4c');
          emit('selected-events-verified', { path: selectedPath, events, encodedBytes, sha256 });
        }
        completed = true;
        state.completedFiles += 1;
        state.lastCompletionMs = performance.now();
      } finally {
        if (!completed) state.failed = true;
        emit('file-settled', { adapter: adapter.id, path: file.relativePath, selected, completed });
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
emit('index-start', { source: '23ec770595292f27bc363a6746f935c782d3f0cb', phases: 1, selectedPath,
  boundary: '283 wrapper calls intentionally omit extraction. Startup context, file metadata, all-body redaction and scan-evidence writes remain. Adapter versions identify diagnostic-only outputs.' });
const started = performance.now();
const result = await indexProjectWithRegistryForTest({ repoRoot: root, perfObserver(phase, elapsedMs, reads) {
  scanCalls += 1;
  scanReads = reads;
  emit('scan-settled', { phase, elapsedMs, reads, memory: process.memoryUsage() });
} }, registry);
const ended = performance.now();
const collectionCompleted = states.length > 0 && states.every(state => state.started && !state.failed
  && state.completedFiles === state.expectedFiles && (!state.disposeRequired || state.disposed));
const last = states.at(-1);
emit('index-end', { elapsedMs: ended - started, result, collectionCompleted, states,
  postCollectionWindowMs: collectionCompleted && last.lastCompletionMs !== null ? ended - last.lastCompletionMs : null,
  memory: process.memoryUsage(),
  boundary: 'One-file real-event publication with full startup context and all-file metadata/body-redaction/scan-evidence writes. This is an intentionally partial graph, not a full-corpus index. Post-collection includes SQL and bookkeeping, not isolated SQL CPU. CI is not the earlier three-phase VM execution.' });
assert.equal(result.mode, 'full');
assert.equal(scanCalls, 1);
assert.ok(scanReads.bodyReads > 0 && scanReads.bodyBytes > 0);
assert.ok(collectionCompleted);
for (const file of manifest) {
  const absolute = path.join(root, file.path);
  assert.equal((await stat(absolute)).size, file.bytes);
  assert.equal(createHash('sha256').update(await readFile(absolute)).digest('hex'), file.sha256);
}
emit('diagnostic-end', { sourceFilesUnchanged: manifest.length, scanCalls, scanReads, phases: 1 });
