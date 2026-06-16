import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AdapterRegistry } from '../src/adapters/registry.js';
import type {
  AdapterCapability,
  AdapterManifestEntry,
  AdapterRun,
  ExtractCtx,
  IndexEvent,
  SemanticAdapter
} from '../src/adapters/types.js';
import {
  MULTI_LANG_REGEX_ADAPTER_ID,
  MULTI_LANG_REGEX_ADAPTER_VERSION,
  TS_JS_SEMANTIC_ADAPTER_ID
} from '../src/adapters/multi-language-regex.js';
import { createDefaultRegistry } from '../src/indexer.js';
import type { ScannedFile } from '../src/types.js';

type AdapterOptions = {
  readonly version?: string;
  readonly capabilities?: readonly AdapterCapability[];
  readonly confidence?: SemanticAdapter['confidence'];
  readonly knownGaps?: readonly string[];
  readonly selectionMode?: SemanticAdapter['selectionMode'];
};

function makeAdapter(id: string, supportedLang: string, options: AdapterOptions = {}): SemanticAdapter {
  return {
    id,
    version: options.version ?? '1',
    capabilities: options.capabilities ?? ['imports'],
    ...(options.confidence !== undefined ? { confidence: options.confidence } : {}),
    ...(options.knownGaps !== undefined ? { knownGaps: options.knownGaps } : {}),
    ...(options.selectionMode !== undefined ? { selectionMode: options.selectionMode } : {}),
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

test('registry rejects registering adapters after a catch-all adapter', () => {
  const registry = new AdapterRegistry();
  registry.register(makeAdapter('fallback', 'typescript', { selectionMode: 'catch-all' }));

  assert.throws(
    () => registry.register(makeAdapter('future-python', 'python')),
    /cannot register adapter future-python after catch-all adapter fallback/
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

test('manifest returns adapter defaults, metadata, order, and immutable snapshots', () => {
  const registry = new AdapterRegistry();
  registry.register(makeAdapter('targeted', 'typescript'));
  registry.register(makeAdapter('fallback', 'python', {
    version: '2',
    capabilities: ['calls', 'symbols'],
    confidence: 'heuristic',
    knownGaps: ['does not resolve dynamic imports'],
    selectionMode: 'catch-all'
  }));

  const manifest = registry.manifest();

  assert.deepStrictEqual(manifest, [
    {
      order: 0,
      id: 'targeted',
      version: '1',
      capabilities: ['imports'],
      confidence: 'unknown',
      knownGaps: [],
      selectionMode: 'targeted'
    },
    {
      order: 1,
      id: 'fallback',
      version: '2',
      capabilities: ['calls', 'symbols'],
      confidence: 'heuristic',
      knownGaps: ['does not resolve dynamic imports'],
      selectionMode: 'catch-all'
    }
  ]);

  assert.throws(() => {
    (manifest as unknown as AdapterManifestEntry[]).push(manifest[0]!);
  });
  assert.throws(() => {
    (manifest[0]!.capabilities as unknown as AdapterCapability[]).push('calls');
  });
  assert.throws(() => {
    (manifest[0] as unknown as { id: string }).id = 'mutated';
  });
  assert.deepStrictEqual(registry.manifest()[0], {
    order: 0,
    id: 'targeted',
    version: '1',
    capabilities: ['imports'],
    confidence: 'unknown',
    knownGaps: [],
    selectionMode: 'targeted'
  });
});

test('default registry keeps the catch-all adapter registered last', () => {
  const registry = createDefaultRegistry();
  assert.strictEqual(registry.list().at(-1)?.id, MULTI_LANG_REGEX_ADAPTER_ID);
  assert.deepStrictEqual(registry.manifest().at(-1), {
    order: registry.manifest().length - 1,
    id: MULTI_LANG_REGEX_ADAPTER_ID,
    version: MULTI_LANG_REGEX_ADAPTER_VERSION,
    capabilities: ['imports', 'symbols', 'calls', 'types', 'docrefs', 'tests'],
    confidence: 'heuristic',
    knownGaps: [
      'fallback extraction is broad but shallow and should be treated as coverage guidance, not semantic proof',
      'language-specific parser adapters should replace this path for high-risk changes'
    ],
    selectionMode: 'catch-all'
  });
});

test('default registry rejects adapters after its production catch-all', () => {
  const registry = createDefaultRegistry();

  assert.throws(
    () => registry.register(makeAdapter('future-adapter', 'example')),
    new RegExp(
      `cannot register adapter future-adapter after catch-all adapter ${MULTI_LANG_REGEX_ADAPTER_ID}`
    )
  );
});

test('default registry picks the parser-backed adapter over the catch-all for TypeScript', () => {
  const registry = createDefaultRegistry();
  const picked = registry.pickAdapter(makeFile('typescript', 'a.ts'));
  assert.strictEqual(picked?.id, TS_JS_SEMANTIC_ADAPTER_ID);
});
