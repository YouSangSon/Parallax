import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { ConfigInfraSemanticAdapter } from '../src/adapters/config-infra.js';
import type { AdapterRun, IndexEvent } from '../src/adapters/types.js';
import type { ScannedFile } from '../src/types.js';

function file(relativePath: string, language: string, content: string): ScannedFile {
  return {
    absolutePath: `/synthetic/${relativePath}`, relativePath, language, content,
    hash: createHash('sha256').update(content).digest('hex')
  };
}

const workflow = file('.github/workflows/ci.yml', 'yaml', 'steps:\n  - run: node src/a.ts\n');
const docker = file('Dockerfile', 'dockerfile', 'COPY src/a.ts /app/a.ts\nCOPY src/b.ts /app/b.ts\n');
const terraform = file('infra/main.tf', 'terraform', 'source = "src/b.ts"\n');
const targets = [workflow, docker, terraform];
const sources = [file('src/a.ts', 'typescript', 'export const a = 1;\n'),
  file('src/b.ts', 'typescript', 'export const b = 2;\n')];

async function collect(order: readonly ScannedFile[], paths: readonly ScannedFile[]) {
  const adapter = new ConfigInfraSemanticAdapter();
  const context = paths.map((input) => Object.freeze({
    ...input,
    get content(): string { throw new Error(`unexpected context body read: ${input.relativePath}`); },
    get hash(): string { throw new Error(`unexpected context hash read: ${input.relativePath}`); }
  }));
  const run: AdapterRun = adapter.start({ repoRoot: '/synthetic', indexRunId: 1, adapterRunId: 1,
    indexedFiles: context }, context);
  try {
    const result = new Map<string, IndexEvent[]>();
    for (const target of order) {
      const events: IndexEvent[] = [];
      for await (const event of run.process(Object.freeze({ ...target }))) events.push(event);
      result.set(target.relativePath, events);
    }
    return result;
  } finally {
    await run.dispose?.();
  }
}

test('config infra selected and reordered processing matches full per-file events', async () => {
  const paths = [...targets, ...sources];
  const full = await collect(targets, paths);
  const reversed = await collect([...targets].reverse(), [...paths].reverse());
  for (const target of targets) {
    const expected = full.get(target.relativePath);
    assert.ok(expected && expected.length > 0, `${target.relativePath} must emit relations`);
    assert.deepEqual(reversed.get(target.relativePath), expected);
    assert.deepEqual((await collect([target], paths)).get(target.relativePath), expected);
    for (const event of expected) {
      assert.equal(event.kind, 'relation');
      if (event.kind === 'relation') {
        assert.equal(event.relation.source.path, target.relativePath);
        assert.ok(event.relation.evidence && event.relation.evidence.length > 0);
        assert.ok(event.relation.evidence.every((item) => item.file === target.relativePath));
      }
    }
  }
});

test('config infra edited target matches fresh full processing without other context bodies', async () => {
  const edited = { ...docker, content: 'COPY src/b.ts /app/only-b.ts\n' };
  edited.hash = createHash('sha256').update(edited.content).digest('hex');
  const current = [workflow, edited, terraform];
  const paths = [...current, ...sources];
  const full = (await collect(current, paths)).get(edited.relativePath)!;
  const selected = (await collect([edited], paths)).get(edited.relativePath);
  assert.ok(full.some((event) => event.kind === 'relation' && event.relation.target.path === 'src/b.ts'));
  assert.ok(full.every((event) => event.kind !== 'relation' || event.relation.target.path !== 'src/a.ts'));
  assert.deepEqual(selected, full);
  assert.notDeepEqual(selected, (await collect([docker], [...targets, ...sources])).get(docker.relativePath));
});

test('config infra unchanged body depends on the current indexed path set', async () => {
  const before = (await collect([docker], [...targets, ...sources])).get(docker.relativePath)!;
  const pathsWithoutB = [...targets, sources[0]!];
  const after = (await collect([docker], pathsWithoutB)).get(docker.relativePath)!;
  assert.ok(before.some((event) => event.kind === 'relation' && event.relation.target.path === 'src/b.ts'));
  assert.ok(after.some((event) => event.kind === 'relation' && event.relation.target.path === 'src/a.ts'));
  assert.ok(after.every((event) => event.kind !== 'relation' || event.relation.target.path !== 'src/b.ts'));
  assert.notDeepEqual(after, before);
  assert.deepEqual((await collect([...targets].reverse(), pathsWithoutB)).get(docker.relativePath), after);
});
