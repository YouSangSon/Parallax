import assert from 'node:assert/strict';
import { test } from 'node:test';

import { failsImpactGate } from '../src/confidence.js';

// failsImpactGate decides whether `analyze` exits non-zero. It is the pure
// primitive behind the confidence-aware CI gate (`analyze --fail-on=<level>`).

test('with no gate, any affected file fails (historical behavior)', () => {
  assert.equal(failsImpactGate(['heuristic'], undefined), true);
  assert.equal(failsImpactGate([], undefined), false);
});

test("'any' fails iff there is any affected file", () => {
  assert.equal(failsImpactGate(['unknown'], 'any'), true);
  assert.equal(failsImpactGate([], 'any'), false);
});

test("'none' never fails", () => {
  assert.equal(failsImpactGate(['proven', 'proven'], 'none'), false);
});

test('a confidence threshold fails only when an affected file meets or exceeds it', () => {
  // proven gate: only proven affected fails.
  assert.equal(failsImpactGate(['heuristic', 'inferred'], 'proven'), false);
  assert.equal(failsImpactGate(['heuristic', 'proven'], 'proven'), true);
  // inferred gate: inferred or proven fails; heuristic alone does not.
  assert.equal(failsImpactGate(['heuristic'], 'inferred'), false);
  assert.equal(failsImpactGate(['inferred'], 'inferred'), true);
  // heuristic gate: any real (non-unknown) confidence fails.
  assert.equal(failsImpactGate(['unknown'], 'heuristic'), false);
  assert.equal(failsImpactGate(['heuristic'], 'heuristic'), true);
});

test('rejects an invalid gate value', () => {
  assert.throws(() => failsImpactGate(['proven'], 'bogus'), /fail-on/i);
});
