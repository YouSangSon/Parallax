import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AdapterRegistry } from '../src/adapters/registry.js';
import { indexProjectWithRegistryForTest } from '../src/indexer.js';
import type { IndexOptions } from '../src/types.js';

function registry(): AdapterRegistry {
  const result = new AdapterRegistry();
  result.register({
    id: 'scan-metrics-test', version: '1', capabilities: ['references'],
    supports: (file) => file.language === 'typescript',
    start: () => ({ async *process() {} })
  });
  return result;
}

test('scan counters measure returned bytes including unsupported bodies and bounded samples', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-scan-metrics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = Buffer.from('// 한글\n');
  const unsupported = Buffer.from([0xff, 0xfe, 0x61]);
  await writeFile(path.join(root, 'app.ts'), body);
  await writeFile(path.join(root, 'unsupported.py'), unsupported);
  await writeFile(path.join(root, 'large.ts'), Buffer.alloc(5000, 0x61));
  await writeFile(path.join(root, 'unknown.blob'), 'not a recognized language');
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'node_modules/ignored.ts'), 'ignored');
  await symlink('app.ts', path.join(root, 'linked.ts'));
  const observations: unknown[] = [];
  const options: IndexOptions = {
    repoRoot: root, maxFileBytes: 100,
    perfObserver: (_phase, _ms, reads) => observations.push(reads)
  };
  const adapters = registry();
  const first = await indexProjectWithRegistryForTest(options, adapters);
  const noop = await indexProjectWithRegistryForTest(options, adapters);
  await writeFile(path.join(root, 'app.ts'), Buffer.concat([body, Buffer.from('// edit\n')]));
  const edited = await indexProjectWithRegistryForTest(options, adapters);

  const expected = {
    bodyReads: 2, bodyBytes: body.length + unsupported.length,
    sampleReads: 1, sampleBytes: 4096
  };
  assert.deepEqual(observations, [expected, expected, { ...expected, bodyBytes: expected.bodyBytes + 8 }]);
  assert.equal(first.mode, 'full');
  assert.equal(noop.mode, 'incremental');
  assert.equal(edited.mode, 'full');
  assert.equal(first.filesIndexed, 1);
  assert.equal('scanReads' in first, false);
});

test('clean same-HEAD reuse does not run the scan observer', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-scan-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'app.ts'), 'export const value = 1;\n');
  await writeFile(path.join(root, '.gitignore'), '.parallax/\n');
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['init']);
  git(['add', 'app.ts', '.gitignore']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  let scans = 0;
  const options: IndexOptions = { repoRoot: root, perfObserver: () => { scans++; } };
  const adapters = registry();
  const first = await indexProjectWithRegistryForTest(options, adapters);
  const second = await indexProjectWithRegistryForTest(options, adapters);
  assert.equal(scans, 1);
  assert.equal(second.mode, 'incremental');
  assert.equal(second.indexRunId, first.indexRunId);
});
