import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseTraceInput } from '../src/trace_promotion.js';

// parseTraceInput validates an untrusted runtime-trace payload into observed
// source->target edges. Pure, so the validation is testable without the DB.

test('parses a bare array of source/target edges', () => {
  const edges = parseTraceInput([
    { source: 'src/a.ts', target: 'src/b.ts' },
    { source: 'src/a.ts', target: 'src/c.ts' }
  ]);

  assert.deepEqual(edges, [
    { source: 'src/a.ts', target: 'src/b.ts' },
    { source: 'src/a.ts', target: 'src/c.ts' }
  ]);
});

test('parses an object with an edges array', () => {
  const edges = parseTraceInput({ edges: [{ source: 'src/a.ts', target: 'src/b.ts' }] });
  assert.deepEqual(edges, [{ source: 'src/a.ts', target: 'src/b.ts' }]);
});

test('throws on a non-array / non-edges payload', () => {
  assert.throws(() => parseTraceInput(42), /trace/i);
  assert.throws(() => parseTraceInput({ nope: true }), /trace/i);
});

test('throws when an edge is missing source or target', () => {
  assert.throws(() => parseTraceInput([{ source: 'src/a.ts' }]), /source.*target|target/i);
  assert.throws(() => parseTraceInput([{ source: '', target: 'src/b.ts' }]), /source/i);
});
