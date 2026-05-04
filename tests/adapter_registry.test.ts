import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AdapterRegistry } from '../src/adapters/registry.js';
import type { AdapterRun, ExtractCtx, IndexEvent, SemanticAdapter } from '../src/adapters/types.js';
import type { ScannedFile } from '../src/types.js';

function makeAdapter(id: string, supportedLang: string): SemanticAdapter {
  return {
    id,
    version: '1',
    capabilities: ['imports'],
    supports: (file) => file.language === supportedLang,
    start: (_ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun => ({
      async *process(_file: ScannedFile): AsyncIterable<IndexEvent> {
        // intentionally empty — registry tests don't exercise the streaming path
      }
    })
  };
}

function makeFile(language: string, relativePath: string): ScannedFile {
  return {
    absolutePath: `/repo/${relativePath}`,
    relativePath,
    content: '',
    hash: 'h',
    language
  };
}

test('registry returns first matching adapter (priority by registration order)', () => {
  const registry = new AdapterRegistry();
  registry.register(makeAdapter('ts', 'typescript'));
  registry.register(makeAdapter('regex', 'typescript'));

  const picked = registry.pickAdapter(makeFile('typescript', 'a.ts'));
  assert.strictEqual(picked?.id, 'ts');
});

test('registry returns undefined when no adapter supports the file', () => {
  const registry = new AdapterRegistry();
  registry.register(makeAdapter('regex', 'typescript'));

  const picked = registry.pickAdapter(makeFile('python', 'a.py'));
  assert.strictEqual(picked, undefined);
});

test('registry rejects duplicate adapter id', () => {
  const registry = new AdapterRegistry();
  registry.register(makeAdapter('regex', 'typescript'));
  assert.throws(
    () => registry.register(makeAdapter('regex', 'javascript')),
    /already registered/
  );
});

test('classify groups files by their picked adapter and skips unsupported files', () => {
  const registry = new AdapterRegistry();
  registry.register(makeAdapter('ts', 'typescript'));
  registry.register(makeAdapter('py', 'python'));

  const files = [
    makeFile('typescript', 'a.ts'),
    makeFile('python', 'b.py'),
    makeFile('typescript', 'c.ts'),
    makeFile('rust', 'd.rs')
  ];
  const grouped = registry.classify(files);

  const tsBucket = [...grouped.entries()].find(([adapter]) => adapter.id === 'ts')?.[1];
  const pyBucket = [...grouped.entries()].find(([adapter]) => adapter.id === 'py')?.[1];

  assert.strictEqual(tsBucket?.length, 2);
  assert.strictEqual(pyBucket?.length, 1);
  assert.strictEqual(grouped.size, 2);
});

test('list returns adapters in registration order', () => {
  const registry = new AdapterRegistry();
  registry.register(makeAdapter('a', 'typescript'));
  registry.register(makeAdapter('b', 'python'));
  assert.deepStrictEqual(
    registry.list().map((a) => a.id),
    ['a', 'b']
  );
});
