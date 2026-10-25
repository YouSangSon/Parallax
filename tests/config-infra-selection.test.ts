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

test('config infra explicit paths retain boundaries, case variants and original evidence', async () => {
  const lines = [
    'name: path-boundaries',
    '  run: echo xsrc/a.ts src/a.tsx ./src/a.ts @src/a.ts -src/a.ts src/a.ts/ src/a.ts. src/a.ts_ src/a.ts@',
    '  run: echo (SRC/A.TS), SRC/A.TS',
    '  run: echo İsrc/unicode.ts src/東京.ts "src/has space.ts" src/bracket[x].ts',
    '  run: echo .github/workflows/ci.yml'
  ];
  const input = file('.github/workflows/ci.yml', 'yaml', lines.join('\r\n') + '\r\n');
  const paths = [input, ...['src/a.ts', 'src/A.ts', 'src/unicode.ts', 'src/東京.ts',
    'src/has space.ts', 'src/bracket', 'src/bracket[x].ts'].map((name) => file(name, 'typescript', ''))];
  const events = (await collect([input], paths)).get(input.relativePath)!;
  assert.ok(events.every((event) => event.kind === 'relation'));
  const relations = events.filter((event) => event.kind === 'relation').map((event) => event.relation);
  assert.deepEqual(relations.map((relation) => relation.target.path), paths.slice(1).map((target) => target.relativePath).sort((a, b) => a.localeCompare(b)));
  for (const relation of relations) {
    const ascii = relation.target.path === 'src/a.ts' || relation.target.path === 'src/A.ts';
    const line = ascii ? 3 : 4;
    assert.deepEqual(relation.evidence, [{ file: input.relativePath, confidence: 'heuristic',
      snippet: lines[line - 1]!.slice(2) + '\r', startLine: line, endLine: line,
      startCol: 3, endCol: lines[line - 1]!.length + 2 }]);
  }
});

test('config infra preserves stable path ties and first nonignored Docker reference', async () => {
  const tiedPaths = ['\u200ba.ts', 'a.ts'];
  assert.equal(tiedPaths[0]!.localeCompare(tiedPaths[1]!), 0);
  const input = file('.github/workflows/ties.yml', 'yaml', '\u200ba.ts\n');
  const tied = (await collect([input], [input, ...tiedPaths.map((name) => file(name, 'typescript', ''))])).get(input.relativePath)!;
  assert.deepEqual(tied.filter((event) => event.kind === 'relation').map((event) => event.relation.target.path), tiedPaths);

  const content = 'COPY --from=builder src/a.ts /ignored\nCOPY src/a.ts /app/a.ts\nCOPY src/a.ts /app/again.ts\n';
  const inputDocker = file('Dockerfile', 'dockerfile', content);
  const events = (await collect([inputDocker], [inputDocker, ...sources])).get(inputDocker.relativePath)!;
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.kind, 'relation');
    if (event.kind === 'relation') {
      assert.equal(event.relation.target.path, 'src/a.ts');
      assert.equal(event.relation.evidence?.[0]?.startLine, 2);
      assert.equal(event.relation.evidence?.[0]?.snippet, 'COPY src/a.ts /app/a.ts');
    }
  }
});
