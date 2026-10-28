import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { TypeScriptJavaScriptSemanticAdapter } from '../src/adapters/multi-language-regex.js';
import type { IndexEvent } from '../src/adapters/types.js';
import type { ScannedFile } from '../src/types.js';

async function extract(sources: Record<string, string>) {
  const files: ScannedFile[] = Object.entries(sources).map(([relativePath, content]) => ({
    absolutePath: `/synthetic/exports/${relativePath}`, relativePath, content,
    language: 'typescript', hash: createHash('sha256').update(content).digest('hex')
  }));
  const input = files.find(file => file.relativePath === 'use.ts');
  assert.ok(input);
  const adapter = new TypeScriptJavaScriptSemanticAdapter();
  const run = await adapter.start({ repoRoot: '/synthetic/exports', indexRunId: 1,
    adapterRunId: 1, indexedFiles: files }, files);
  const events: IndexEvent[] = [];
  try {
    for await (const event of run.process(input)) events.push(event);
    return events.filter(event => event.kind === 'relation').map(event => event.relation);
  } finally {
    await run.dispose?.();
  }
}

const cycle = {
  'a.ts': 'export { Thing as default } from "./b.js";',
  'b.ts': 'export { default as Thing } from "./a.js";'
};

for (const binding of ['import Thing from "./a.js";', 'import { Thing } from "./b.js";']) {
  test(`mixed default/named export cycle terminates for ${binding}`, async () => {
    const relations = await extract({ ...cycle,
      'use.ts': `${binding}\nexport class Child extends Thing {}\nThing.make();`
    });
    assert.ok(relations.some(row => row.kind === 'DEPENDS_ON'), 'ordinary import evidence survives');
    assert.ok(!relations.some(row => row.kind === 'EXTENDS'), 'a cycle has no concrete base declaration');
    assert.ok(!relations.some(row => row.kind === 'CALLS' && row.target.path !== 'use.ts'),
      'a cycle has no concrete imported method declaration');
  });
}

test('mixed default/named export chain preserves heritage and method targets', async () => {
  const relations = await extract({
    'a.ts': 'export { Thing as default } from "./b.js";',
    'b.ts': 'export { default as Thing } from "./base.js";',
    'base.ts': 'export default interface Base { make(): number; }',
    'use.ts': 'import type Thing from "./a.js"; interface Child extends Thing {} export function call(value: Thing) { return value.make(); }'
  });
  assert.ok(relations.some(row => row.kind === 'EXTENDS' && row.target.path === 'base.ts' && row.target.symbol === 'Base'));
  assert.ok(relations.some(row => row.kind === 'CALLS' && row.target.path === 'base.ts' && row.target.symbol === 'Base.make'));
});

test('a cyclic re-export branch does not hide an independent concrete export', async () => {
  const relations = await extract({ ...cycle,
    'b.ts': 'export * from "./loop.js";\nexport * from "./base.js";',
    'loop.ts': 'export { default as Thing } from "./a.js";',
    'base.ts': 'export class Thing {}',
    'use.ts': 'import Thing from "./a.js"; export class Child extends Thing {}'
  });
  assert.ok(relations.some(row => row.kind === 'EXTENDS' && row.target.path === 'base.ts' && row.target.symbol === 'Thing'));
});

test('shared cycle keys distinguish string export names from colon-bearing paths', async () => {
  const relations = await extract({
    'entry.ts': 'export { "bridge.ts" as default } from "./types.js";',
    'types.ts': 'export { default as "bridge.ts" } from "./types.ts:bridge.js";',
    'types.ts:bridge.ts': 'export default class Base {}',
    'use.ts': 'import Thing from "./entry.js"; export class Child extends Thing {}'
  });
  assert.ok(relations.some(row => row.kind === 'EXTENDS' && row.target.path === 'types.ts:bridge.ts' && row.target.symbol === 'Base'));
});

for (const binding of ['import type Thing from "./a.js";', 'import type { Thing } from "./b.js";']) {
  test(`mixed export cycle terminates in receiver lookup for ${binding}`, async () => {
    const relations = await extract({ ...cycle,
      'use.ts': `${binding}\nexport function call(value: Thing) { return value.make(); }`
    });
    assert.ok(relations.some(row => row.kind === 'DEPENDS_ON'));
    assert.ok(!relations.some(row => row.kind === 'CALLS' && row.target.path !== 'use.ts'));
  });
}

for (const reversed of [false, true]) {
  test(`named export caches keep path/name pairs distinct (${reversed ? 'reversed' : 'forward'})`, async () => {
    const imports = [
      'import { "b.ts:Thing" as One } from "./a.js";',
      'import { Thing as Two } from "./a.ts:b.js";'
    ];
    const declarations = ['interface ChildOne extends One {}', 'interface ChildTwo extends Two {}'];
    if (reversed) { imports.reverse(); declarations.reverse(); }
    const relations = await extract({
      'a.ts': 'export { First as "b.ts:Thing" } from "./one.js";',
      'a.ts:b.ts': 'export { Second as Thing } from "./two.js";',
      'one.ts': 'export interface First { make(): number; }',
      'two.ts': 'export interface Second { make(): number; }',
      'use.ts': [...imports, ...declarations,
        'export function call(one: One, two: Two) { one.make(); two.make(); }'].join('\n')
    });
    assert.deepEqual(relations.filter(row => row.kind === 'EXTENDS')
      .map(row => [row.source.symbol, row.target.path, row.target.symbol]).sort(), [
      ['ChildOne', 'one.ts', 'First'], ['ChildTwo', 'two.ts', 'Second']
    ]);
    assert.deepEqual(relations.filter(row => row.kind === 'CALLS')
      .map(row => [row.target.path, row.target.symbol]).sort(), [
      ['one.ts', 'First.make'], ['two.ts', 'Second.make']
    ]);
  });
}

test('a cached non-type export does not hide a different imported type', async () => {
  const relations = await extract({
    'a.ts': 'const value = 1; export { value as "b.ts:Thing" };',
    'a.ts:b.ts': 'export { Second as Thing } from "./two.js";',
    'two.ts': 'export interface Second { make(): number; }',
    'use.ts': 'import { "b.ts:Thing" as value } from "./a.js"; import { Thing } from "./a.ts:b.js"; export function call(two: Thing) { return two.make() + value; }'
  });
  assert.deepEqual(relations.filter(row => row.kind === 'CALLS')
    .map(row => [row.target.path, row.target.symbol]), [['two.ts', 'Second.make']]);
});

test('namespace export caches preserve heritage, typed receivers and factory returns', async () => {
  const relations = await extract({
    'a.ts': 'export * as "b.ts:Space" from "./one.js";',
    'a.ts:b.ts': 'export * as Space from "./two.js";',
    'one.ts': 'export class Thing { make() { return 1; } } export function create(): Thing { return new Thing(); }',
    'two.ts': 'export class Thing { make() { return 2; } } export function create(): Thing { return new Thing(); }',
    'use.ts': [
      'import { "b.ts:Space" as One } from "./a.js"; import { Space as Two } from "./a.ts:b.js";',
      'interface ChildOne extends One.Thing {} interface ChildTwo extends Two.Thing {}',
      'export function call(one: One.Thing, two: Two.Thing) {',
      '  one.make(); two.make();',
      '  const first = One.create(); const second = Two.create();',
      '  first.make(); second.make();',
      '}'
    ].join('\n')
  });
  assert.deepEqual(relations.filter(row => row.kind === 'EXTENDS')
    .map(row => [row.source.symbol, row.target.path, row.target.symbol]).sort(), [
    ['ChildOne', 'one.ts', 'Thing'], ['ChildTwo', 'two.ts', 'Thing']
  ]);
  const methodCalls = relations.filter(row => row.kind === 'CALLS' && row.target.symbol === 'Thing.make');
  assert.deepEqual(methodCalls.map(row => [row.evidence?.[0]?.snippet, row.target.path]).sort(), [
    ['first.make()', 'one.ts'], ['one.make()', 'one.ts'],
    ['second.make()', 'two.ts'], ['two.make()', 'two.ts']
  ]);
});

test('namespace traversal does not mistake a colliding path/name pair for a cycle', async () => {
  const relations = await extract({
    'a.ts': 'export { Space as "b.ts:Space" } from "./a.ts:b.js";',
    'a.ts:b.ts': 'export * as Space from "./base.js";',
    'base.ts': 'export interface Thing { make(): number; }',
    'use.ts': 'import { "b.ts:Space" as API } from "./a.js"; interface Child extends API.Thing {} export function call(value: API.Thing) { return value.make(); }'
  });
  assert.ok(relations.some(row => row.kind === 'EXTENDS' && row.target.path === 'base.ts' && row.target.symbol === 'Thing'));
  assert.ok(relations.some(row => row.kind === 'CALLS' && row.target.path === 'base.ts' && row.target.symbol === 'Thing.make'));
});

for (const defaultEntry of [false, true]) {
  test(`factory traversal keeps export keys distinct (${defaultEntry ? 'default' : 'named'} entry)`, async () => {
    const relations = await extract({
      'a.ts': defaultEntry
        ? 'export { create as "b.ts:default" } from "./factory.js";'
        : 'export { create as "b.ts:create" } from "./a.ts:b.js";',
      'a.ts:b.ts': defaultEntry
        ? 'export { "b.ts:default" as default } from "./a.js";'
        : 'export { create } from "./factory.js";',
      'factory.ts': 'export class Thing { make() { return 1; } } export function create(): Thing { return new Thing(); }',
      'use.ts': (defaultEntry ? 'import create from "./a.ts:b.js";' : 'import { "b.ts:create" as create } from "./a.js";')
        + '\nexport function call() { const value = create(); return value.make(); }'
    });
    assert.ok(relations.some(row => row.kind === 'CALLS' && row.target.path === 'factory.ts' && row.target.symbol === 'Thing.make'));
  });
}
