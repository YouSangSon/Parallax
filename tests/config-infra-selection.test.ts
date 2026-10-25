import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
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

let coldRuns = 0;
async function collect(order: readonly ScannedFile[], paths: readonly ScannedFile[], repoRoot = `/synthetic/cold-${++coldRuns}`) {
  const adapter = new ConfigInfraSemanticAdapter();
  const context = paths.map((input) => Object.freeze({
    ...input,
    get content(): string { throw new Error(`unexpected context body read: ${input.relativePath}`); },
    get hash(): string { throw new Error(`unexpected context hash read: ${input.relativePath}`); }
  }));
  const run: AdapterRun = adapter.start({ repoRoot, indexRunId: 1, adapterRunId: 1,
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

test('config memo skips matching across instances but uses actual body and current ordered paths', async (t) => {
  const input = file('Dockerfile', 'dockerfile', 'COPY memo/a.ts /app/a.ts\n');
  const a = file('memo/a.ts', 'typescript', '');
  const b = file('memo/b.ts', 'typescript', '');
  const normalize = path.posix.normalize;
  let matches = 0;
  t.mock.method(path.posix, 'normalize', (value: string) => {
    if (value === 'memo/a.ts' || value === 'memo/b.ts') matches++;
    return normalize(value);
  });
  const paths = [input, a, b];
  const full = await collect([input], paths, '/memo-actual-input');
  assert.ok(matches > 0);
  matches = 0;
  assert.deepEqual(await collect([input], paths, '/memo-actual-input'), full);
  assert.equal(matches, 0, 'a new adapter instance must reuse the completed pure computation');

  const edited = { ...input, content: 'COPY memo/b.ts /app/b.ts\n' };
  const changed = await collect([edited], paths, '/memo-actual-input');
  assert.ok(matches > 0, 'an unchanged supplied hash cannot hide a body edit');
  assert.notDeepEqual(changed, full);
  matches = 0;
  await collect([edited], [input, b, a], '/memo-actual-input');
  assert.ok(matches > 0, 'ordered startup paths belong to the computation identity');
  matches = 0;
  await collect([input], paths, '/memo-other-repo');
  assert.ok(matches > 0, 'fresh repositories must have a cold namespace');
});

test('config memo isolates yielded mutations and never admits partial or failed computations', async (t) => {
  const input = file('Dockerfile', 'dockerfile', 'COPY memo-isolation.ts /app/a.ts\n');
  const paths = [input, file('memo-isolation.ts', 'typescript', '')];
  const normalize = path.posix.normalize;
  let matches = 0;
  let fail = false;
  t.mock.method(path.posix, 'normalize', (value: string) => {
    if (value === 'memo-isolation.ts') {
      matches++;
      if (fail) throw new Error('memo extraction failed');
    }
    return normalize(value);
  });
  const expected = (await collect([input], paths, '/memo-isolation-oracle')).get(input.relativePath)!;
  assert.equal(expected.length, 2);
  const adapter = new ConfigInfraSemanticAdapter();
  const run = adapter.start({ repoRoot: '/memo-isolation', indexRunId: 1, adapterRunId: 1, indexedFiles: paths }, paths);
  const partial = run.process(input)[Symbol.asyncIterator]();
  await partial.next();
  await partial.return?.();
  matches = 0;
  const iterator = run.process(input)[Symbol.asyncIterator]();
  const first = (await iterator.next()).value as IndexEvent;
  assert.ok(matches > 0, 'partial consumption must not fill the memo');
  assert.equal(first.kind, 'relation');
  if (first.kind === 'relation') {
    Object.assign(first.relation.source, { displayName: 'poisoned', metadata: { cycle: first.relation.source } });
    Object.assign(first.relation.target, { path: 'poisoned' });
    Object.assign(first.relation.evidence![0]!, { snippet: 'poisoned' });
  }
  const second = (await iterator.next()).value;
  assert.deepEqual(second, expected[1], 'mutations must not reach shared generator descriptors');
  assert.equal((await iterator.next()).done, true);
  matches = 0;
  const cached = (await collect([input], paths, '/memo-isolation')).get(input.relativePath)!;
  assert.equal(matches, 0);
  assert.deepEqual(cached, expected);
  if (cached[0]?.kind === 'relation') Object.assign(cached[0].relation.source, { displayName: 'poisoned hit' });
  assert.deepEqual((await collect([input], paths, '/memo-isolation')).get(input.relativePath), expected);

  fail = true;
  await assert.rejects(collect([input], paths, '/memo-failure'), /memo extraction failed/);
  fail = false;
  matches = 0;
  assert.deepEqual((await collect([input], paths, '/memo-failure')).get(input.relativePath), expected);
  assert.ok(matches > 0, 'a failed computation must be retried');
});

test('config memo distinguishes language, source path and exact UTF-16 body, including empty output', async (t) => {
  const body = 'run: echo memo-signature.ts # \ud800\n';
  const input = file('.github/workflows/memo.yml', 'yaml', body);
  const target = file('memo-signature.ts', 'typescript', '');
  const lower = String.prototype.toLowerCase;
  let matches = 0;
  t.mock.method(String.prototype, 'toLowerCase', function (this: string) {
    if (String(this).startsWith('run: ')) matches++;
    return lower.call(this);
  });
  const paths = [input, target];
  const first = await collect([input], paths, '/memo-signature');
  matches = 0;
  assert.deepEqual(await collect([input], paths, '/memo-signature'), first);
  assert.equal(matches, 0);
  for (const variant of [{ ...input, language: 'terraform' },
    { ...input, relativePath: 'infra/memo.tf' }, { ...input, content: body.replace('\ud800', '\ud801') }]) {
    matches = 0;
    assert.notDeepEqual(await collect([variant], paths, '/memo-signature'), first);
    assert.ok(matches > 0);
  }
  const empty = { ...input, content: 'run: true # memo-empty\n' };
  assert.deepEqual((await collect([empty], paths, '/memo-signature')).get(input.relativePath), []);
  matches = 0;
  assert.deepEqual((await collect([empty], paths, '/memo-signature')).get(input.relativePath), []);
  assert.equal(matches, 0, 'an empty completed output is a cache hit');
});

test('config memo evicts bounded payloads and bypasses oversized entries', async (t) => {
  const target = file('memo-budget.ts', 'typescript', '');
  const normalize = path.posix.normalize;
  let matches = 0;
  t.mock.method(path.posix, 'normalize', (value: string) => {
    if (value === target.relativePath) matches++;
    return normalize(value);
  });
  const medium = file('Dockerfile', 'dockerfile', `COPY memo-budget.ts /app/a # ${'x'.repeat(180_000)}\n`);
  const paths = [medium, target];
  const first = await collect([medium], paths, '/memo-budget-a');
  await collect([medium], paths, '/memo-budget-b');
  matches = 0;
  assert.deepEqual(await collect([medium], paths, '/memo-budget-a'), first);
  assert.ok(matches > 0, 'two large entries cannot retain more than the payload budget');
  const oversized = { ...medium, content: `COPY memo-budget.ts /app/a # ${'x'.repeat(600_000)}\n` };
  const large = await collect([oversized], paths, '/memo-budget-large');
  matches = 0;
  assert.deepEqual(await collect([oversized], paths, '/memo-budget-large'), large);
  assert.ok(matches > 0, 'oversized results keep computing without growing the memo');
});

test('config memo bounds empty entries as well as their payloads', async (t) => {
  const input = file('Dockerfile', 'dockerfile', 'COPY memo-missing.ts /app/a.ts\n');
  const normalize = path.posix.normalize;
  let matches = 0;
  t.mock.method(path.posix, 'normalize', (value: string) => {
    if (value === 'memo-missing.ts') matches++;
    return normalize(value);
  });
  for (let index = 0; index <= 256; index++) {
    assert.deepEqual((await collect([input], [input], `/memo-empty-limit-${index}`)).get('Dockerfile'), []);
  }
  matches = 0;
  assert.deepEqual((await collect([input], [input], '/memo-empty-limit-0')).get('Dockerfile'), []);
  assert.ok(matches > 0, 'entry count is bounded even for empty outputs');
});

test('interleaved config runs keep their captured paths and reuse a completed memo key', async (t) => {
  const input = file('Dockerfile', 'dockerfile', 'COPY memo-interleaved.ts /app/a.ts\n');
  const paths = [input, file('memo-interleaved.ts', 'typescript', '')];
  const normalize = path.posix.normalize;
  let matches = 0;
  t.mock.method(path.posix, 'normalize', (value: string) => {
    if (value === 'memo-interleaved.ts') matches++;
    return normalize(value);
  });
  const iterator = () => new ConfigInfraSemanticAdapter().start({ repoRoot: '/memo-interleaved',
    indexRunId: 1, adapterRunId: 1, indexedFiles: paths }, paths).process(input)[Symbol.asyncIterator]();
  const left = iterator();
  const right = iterator();
  const a: IndexEvent[] = [(await left.next()).value as IndexEvent];
  const b: IndexEvent[] = [(await right.next()).value as IndexEvent];
  assert.deepEqual((await collect([input], [input], '/memo-interleaved')).get('Dockerfile'), []);
  for (const [pending, events] of [[left, a], [right, b]] as const) {
    for (let next = await pending.next(); !next.done; next = await pending.next()) events.push(next.value);
  }
  assert.equal(a.length, 2);
  assert.deepEqual(a, b);
  matches = 0;
  assert.deepEqual((await collect([input], paths, '/memo-interleaved')).get('Dockerfile'), a);
  assert.equal(matches, 0);
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
  const reverseTies = (await collect([input], [input, ...[...tiedPaths].reverse().map((name) => file(name, 'typescript', ''))])).get(input.relativePath)!;
  assert.deepEqual(reverseTies.filter((event) => event.kind === 'relation').map((event) => event.relation.target.path), [...tiedPaths].reverse());

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
