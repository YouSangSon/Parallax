import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeIndexDelta } from '../src/index_delta.js';

// Pure classifier for incremental indexing (S1, slice 1). It decides whether a
// run can be incremental and, if so, which files are unchanged vs changed. It is
// deliberately conservative: anything that could shift cross-file resolution
// (a changed extractor, or any add/delete/rename) forces a full reindex.

const v = 'multi-language-regex-1';

test('no prior run forces a full reindex', () => {
  const delta = computeIndexDelta({
    prior: null,
    current: { extractorVersion: v, files: new Map([['src/a.ts', 'h1']]) }
  });
  assert.equal(delta.mode, 'full');
  assert.match(delta.reason, /no prior/i);
});

test('a changed extractor_version forces a full reindex', () => {
  const delta = computeIndexDelta({
    prior: { extractorVersion: 'old-0', files: new Map([['src/a.ts', 'h1']]) },
    current: { extractorVersion: v, files: new Map([['src/a.ts', 'h1']]) }
  });
  assert.equal(delta.mode, 'full');
  assert.match(delta.reason, /extractor_version/i);
});

test('an added file forces a full reindex (resolution may shift)', () => {
  const delta = computeIndexDelta({
    prior: { extractorVersion: v, files: new Map([['src/a.ts', 'h1']]) },
    current: { extractorVersion: v, files: new Map([['src/a.ts', 'h1'], ['src/b.ts', 'h2']]) }
  });
  assert.equal(delta.mode, 'full');
  assert.match(delta.reason, /file set/i);
  assert.deepEqual(delta.added, ['src/b.ts']);
});

test('a deleted file forces a full reindex', () => {
  const delta = computeIndexDelta({
    prior: { extractorVersion: v, files: new Map([['src/a.ts', 'h1'], ['src/b.ts', 'h2']]) },
    current: { extractorVersion: v, files: new Map([['src/a.ts', 'h1']]) }
  });
  assert.equal(delta.mode, 'full');
  assert.deepEqual(delta.deleted, ['src/b.ts']);
});

test('same paths with some content changes is incremental and partitions files', () => {
  const delta = computeIndexDelta({
    prior: {
      extractorVersion: v,
      files: new Map([['src/a.ts', 'h1'], ['src/b.ts', 'h2'], ['src/c.ts', 'h3']])
    },
    current: {
      extractorVersion: v,
      files: new Map([['src/a.ts', 'h1'], ['src/b.ts', 'CHANGED'], ['src/c.ts', 'h3']])
    }
  });
  assert.equal(delta.mode, 'incremental');
  assert.deepEqual(delta.changed, ['src/b.ts']);
  assert.deepEqual(delta.unchanged, ['src/a.ts', 'src/c.ts']);
  assert.deepEqual(delta.added, []);
  assert.deepEqual(delta.deleted, []);
});

test('identical inputs are incremental with nothing to re-extract', () => {
  const files = new Map([['src/a.ts', 'h1'], ['src/b.ts', 'h2']]);
  const delta = computeIndexDelta({
    prior: { extractorVersion: v, files: new Map(files) },
    current: { extractorVersion: v, files: new Map(files) }
  });
  assert.equal(delta.mode, 'incremental');
  assert.deepEqual(delta.changed, []);
  assert.deepEqual(delta.unchanged, ['src/a.ts', 'src/b.ts']);
});
