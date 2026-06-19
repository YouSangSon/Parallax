import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeCoChanges, parseGitLogNameOnly } from '../src/co-change.js';

// computeCoChanges derives heuristic file<->file coupling from git history:
// commits where two indexed files changed together. It is pure and
// deterministic so the coupling math is unit-testable without git I/O.

const included = (...paths: string[]) => new Set(paths);

test('emits both directions for a pair that co-changes at/above the thresholds', () => {
  // Arrange: a.ts and b.ts change together in 3 of a.ts's 3 commits.
  const commits = [
    ['src/a.ts', 'src/b.ts'],
    ['src/a.ts', 'src/b.ts'],
    ['src/a.ts', 'src/b.ts']
  ];

  // Act
  const pairs = computeCoChanges(commits, included('src/a.ts', 'src/b.ts'), {
    minCoChanges: 3,
    minCouplingScore: 0.3
  });

  // Assert: symmetric -> both directed relations so either change surfaces the other.
  assert.deepEqual(
    pairs.map((p) => [p.source, p.target, p.coChangeCount]),
    [
      ['src/a.ts', 'src/b.ts', 3],
      ['src/b.ts', 'src/a.ts', 3]
    ]
  );
});

test('drops pairs below the minimum co-change count', () => {
  const commits = [
    ['src/a.ts', 'src/b.ts'],
    ['src/a.ts', 'src/b.ts']
  ];

  const pairs = computeCoChanges(commits, included('src/a.ts', 'src/b.ts'), {
    minCoChanges: 3,
    minCouplingScore: 0
  });

  assert.deepEqual(pairs, []);
});

test('drops pairs below the coupling-score threshold', () => {
  // a.ts changes 10 times, b.ts rides along only 3 times -> coupling 3/10 = 0.3 for b's view,
  // but a's view is 3/10. min-based coupling = 3/min(10,3)=1.0; we use co/ max to be conservative:
  // here co=3, freq a=10, freq b=3 -> couplingScore = 3 / 10 = 0.3 (relative to the busier file).
  const commits = [
    ['src/a.ts', 'src/b.ts'],
    ['src/a.ts', 'src/b.ts'],
    ['src/a.ts', 'src/b.ts'],
    ['src/a.ts'],
    ['src/a.ts'],
    ['src/a.ts'],
    ['src/a.ts'],
    ['src/a.ts'],
    ['src/a.ts'],
    ['src/a.ts']
  ];

  const below = computeCoChanges(commits, included('src/a.ts', 'src/b.ts'), {
    minCoChanges: 3,
    minCouplingScore: 0.31
  });
  assert.deepEqual(below, []);

  const atThreshold = computeCoChanges(commits, included('src/a.ts', 'src/b.ts'), {
    minCoChanges: 3,
    minCouplingScore: 0.3
  });
  assert.equal(atThreshold.length, 2);
  assert.ok(atThreshold.every((p) => Math.abs(p.couplingScore - 0.3) < 1e-9));
});

test('skips noisy commits that touch more than maxFilesPerCommit files', () => {
  const noisy = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);
  const commits = [noisy, noisy, noisy];

  const pairs = computeCoChanges(commits, new Set(noisy), {
    minCoChanges: 1,
    minCouplingScore: 0,
    maxFilesPerCommit: 25
  });

  assert.deepEqual(pairs, []);
});

test('parses NUL-delimited git log --name-only into per-commit file lists', () => {
  // Two commits, NUL-delimited by --format=%x00, each followed by its files.
  const output = '\0\nsrc/a.ts\nsrc/b.ts\n\0\nsrc/a.ts\n';

  const commits = parseGitLogNameOnly(output);

  assert.deepEqual(commits, [['src/a.ts', 'src/b.ts'], ['src/a.ts']]);
});

test('only emits pairs among included (indexed) files', () => {
  const commits = [
    ['src/a.ts', 'README.md'],
    ['src/a.ts', 'README.md'],
    ['src/a.ts', 'README.md']
  ];

  // README.md is not indexed -> no pair, despite strong coupling.
  const pairs = computeCoChanges(commits, included('src/a.ts'), {
    minCoChanges: 3,
    minCouplingScore: 0.3
  });

  assert.deepEqual(pairs, []);
});
