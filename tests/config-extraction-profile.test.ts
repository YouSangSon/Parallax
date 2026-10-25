import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { profileAdapter, profileConfigExtraction, type ExtractionSample } from '../bench/config-extraction-profile.js';
import type { AdapterRun, IndexEvent, SemanticAdapter } from '../src/adapters/types.js';
import type { ScannedFile } from '../src/types.js';

const file: ScannedFile = { absolutePath: '/synthetic/Dockerfile', relativePath: 'Dockerfile',
  language: 'dockerfile', content: 'COPY a /app/a', hash: 'synthetic' };
const ctx = { repoRoot: '/synthetic', indexRunId: 1, adapterRunId: 1, indexedFiles: [file] };

test('profile wrapper preserves event identity, receiver binding and early iterator cleanup', async () => {
  const samples: ExtractionSample[] = [];
  const calls: string[] = [];
  const event: IndexEvent = { kind: 'entity', entity: { kind: 'file', path: 'Dockerfile' } };
  const run: AdapterRun = {
    async *process() {
      assert.equal(this, run);
      try { yield event; yield event; } finally { calls.push('iterator closed'); }
    },
    dispose() { assert.equal(this, run); calls.push('disposed'); }
  };
  const adapter: SemanticAdapter = { id: 'profile-test', version: '1', capabilities: [],
    fileContentScope: 'target-only', outputOwnership: 'processed-file',
    supports() { assert.equal(this, adapter); return true; },
    start() { assert.equal(this, adapter); return run; } };
  Object.defineProperty(adapter, 'knownGaps', { get() { assert.equal(this, adapter); return ['preserved getter']; } });
  const wrapped = profileAdapter(adapter, samples);
  assert.equal(wrapped.supports(file), true);
  assert.equal(wrapped.outputOwnership, adapter.outputOwnership);
  assert.deepEqual(wrapped.knownGaps, ['preserved getter']);
  const observed = await wrapped.start(ctx, [file]);
  for await (const actual of observed.process(file)) { assert.equal(actual, event); break; }
  await observed.dispose?.();
  assert.deepEqual(calls, ['iterator closed', 'disposed']);
  assert.deepEqual(samples.map(({ phase, path, events }) => ({ phase, path, events })), [
    { phase: 'start', path: undefined, events: 0 },
    { phase: 'process', path: 'Dockerfile', events: 1 },
    { phase: 'dispose', path: undefined, events: 0 }
  ]);
  assert.ok(samples.every((sample) => Number.isFinite(sample.elapsedMs) && sample.elapsedMs >= 0));
});

test('profile wrapper records failed consumption and propagates the original error', async () => {
  const samples: ExtractionSample[] = [];
  const failure = new Error('original extraction failure');
  const wrapped = profileAdapter({ id: 'profile-failure', version: '1', capabilities: [], supports: () => true,
    start: () => ({ async *process() { throw failure; } }) }, samples);
  const run = await wrapped.start(ctx, [file]);
  await assert.rejects(async () => { for await (const _event of run.process(file)) {} }, (error) => error === failure);
  assert.equal(run.dispose, undefined);
  assert.deepEqual(samples.map((sample) => [sample.phase, sample.events]), [['start', 0], ['process', 0]]);
});

test('profile package guard rejects another package before loading a runtime', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-profile-package-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"another-package"}\n');
    await assert.rejects(profileConfigExtraction(root), /expected a built Parallax package root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('profile runner records actual full-index phases and scan counts without timing thresholds', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const report = await profileConfigExtraction(root);
  assert.equal(Object.keys(report.runtimeSha256).length, 5);
  assert.ok(Object.values(report.runtimeSha256).every((hash) => /^[0-9a-f]{64}$/.test(hash)));
  assert.deepEqual(report.observations.map((observation) => observation.phase), ['baseline', 'source-edit', 'config-edit']);
  for (const observation of report.observations) {
    assert.equal(observation.result.mode, 'full');
    assert.equal(observation.result.filesIndexed, 23);
    assert.equal(observation.scanCalls, 1);
    assert.equal(observation.scanReads.bodyReads, 23);
    assert.ok(observation.scanReads.bodyBytes > 0);
    const processed = observation.samples.filter((sample) => sample.phase === 'process');
    assert.deepEqual(processed.map((sample) => sample.path).sort(), ['.github/workflows/ci.yml', 'Dockerfile', 'infra/main.tf']);
    assert.ok(processed.every((sample) => sample.events > 0));
    assert.equal(observation.samples.filter((sample) => sample.phase === 'start').length, 1);
    assert.equal(observation.samples.filter((sample) => sample.phase === 'dispose').length, 0);
  }
});
