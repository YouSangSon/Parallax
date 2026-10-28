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
