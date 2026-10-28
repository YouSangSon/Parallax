import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { languageIdForPath } from './baseline/dist/src/entity_classification.js';
import { AdapterRegistry } from './baseline/dist/src/adapters/registry.js';
import { BuildSystemPackageAdapter } from './baseline/dist/src/adapters/build-system-package.js';
import { ConfigInfraSemanticAdapter } from './baseline/dist/src/adapters/config-infra.js';
import {
  TypeScriptJavaScriptSemanticAdapter, JvmSpringSemanticAdapter, PythonSemanticAdapter,
  GoSemanticAdapter, RustSemanticAdapter, MultiLanguageRegexAdapter
} from './baseline/dist/src/adapters/multi-language-regex.js';

const root = path.resolve(process.argv[2]);
const selfCheck = process.argv[3] === '--self-check';
const started = performance.now();
const emit = (stage, data) => writeSync(1, JSON.stringify({
  stage, ...data, elapsedMs: performance.now() - started, memory: process.memoryUsage()
}) + '\n');
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) {
      const relativePath = path.relative(root, full).split(path.sep).join('/');
      const language = languageIdForPath(relativePath);
      if (!language) continue;
      const body = readFileSync(full);
      assert.ok(body.length < 1_000_000);
      const content = body.toString('utf8');
      files.push(Object.freeze({ relativePath, absolutePath: full, language, content,
        hash: createHash('sha256').update(content).digest('hex') }));
    } else assert.fail('nonregular corpus entry');
  }
}
walk(root);
files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
Object.freeze(files);
assert.equal(files.length, selfCheck ? 3 : 284);
const registry = new AdapterRegistry();
for (const Adapter of [BuildSystemPackageAdapter, ConfigInfraSemanticAdapter,
  TypeScriptJavaScriptSemanticAdapter, JvmSpringSemanticAdapter, PythonSemanticAdapter,
  GoSemanticAdapter, RustSemanticAdapter, MultiLanguageRegexAdapter]) registry.register(new Adapter());
assert.equal(new TypeScriptJavaScriptSemanticAdapter().version, '39');
emit('inputs', { files: files.length, bytes: files.reduce((n, f) => n + Buffer.byteLength(f.content), 0),
  manifest: registry.manifest(), boundary: 'Independent immutable-source loader, not production scanner read/timing evidence. No DB, publication, models or application servers.' });
const groups = registry.classify(files);
const selected = [], completed = [];
let bounded = false;
for (const adapter of registry.list()) {
  const group = Object.freeze(groups.get(adapter) ?? []);
  const limit = adapter.id === 'config-infra-semantic-v0' ? 0 : adapter.id === 'typescript-javascript-semantic-v0' ? 6 : 3;
  const targets = [...group].sort((a, b) => Buffer.byteLength(b.content) - Buffer.byteLength(a.content)
    || a.relativePath.localeCompare(b.relativePath)).slice(0, limit);
  if (!targets.length) continue;
  if (performance.now() - started > 50_000) { bounded = true; break; }
  selected.push(...targets.map(f => f.relativePath));
  emit('adapter-start', { adapter: adapter.id, startupFiles: group.length, targets: targets.map(f => f.relativePath) });
  const run = await adapter.start({ repoRoot: root, indexRunId: 1, adapterRunId: 1, indexedFiles: files }, group);
  try {
    for (const file of targets) {
      if (performance.now() - started > 50_000) { bounded = true; break; }
      const before = performance.now();
      emit('file-start', { adapter: adapter.id, path: file.relativePath, bytes: Buffer.byteLength(file.content) });
      const digest = createHash('sha256');
      let events = 0, encodedBytes = 0;
      const kinds = {};
      for await (const event of run.process(file)) {
        const encoded = JSON.stringify(event) + '\n';
        digest.update(encoded);
        encodedBytes += Buffer.byteLength(encoded);
        events++;
        kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
        assert.ok(events <= 100_000 && encodedBytes <= 32 * 1024 * 1024, 'bounded event output');
      }
      completed.push(file.relativePath);
      emit('file-end', { adapter: adapter.id, path: file.relativePath, windowMs: performance.now() - before,
        events, encodedBytes, kinds, sha256: digest.digest('hex') });
    }
  } finally { await run.dispose?.(); }
  emit('adapter-end', { adapter: adapter.id, bounded });
  if (bounded) break;
}
if (selfCheck) {
  assert.deepEqual(new Set(completed), new Set(['package.json', 'a.ts', 'README.md']));
  assert.equal(bounded, false);
}
emit('diagnostic-end', { selected, completed, bounded,
  boundary: 'Largest-file sample with full startup context, one historical v39 extraction observation. Event hash consumption excludes retained collection and SQL publication. Sampling profiler and observer add overhead. No whole-index cost, capacity or speedup claim.' });
