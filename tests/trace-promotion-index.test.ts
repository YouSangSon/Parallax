import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { analyzeDiff, indexProject, initProject } from '../src/index.js';
import { ingestTraces } from '../src/trace_promotion.js';

// End-to-end: a heuristic git co-change relation is upgraded to `proven` once a
// runtime trace confirms the edge. Proves trace ingestion raises confidence and
// composes with the co-change pass.

function git(repoRoot: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'] });
}

test('ingestTraces promotes a heuristic co-change relation to proven', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'parallax-trace-'));
  try {
    // Arrange: alpha.ts and beta.ts co-change 3x but never import each other.
    git(repoRoot, ['init']);
    git(repoRoot, ['config', 'user.email', 'test@example.com']);
    git(repoRoot, ['config', 'user.name', 'Test']);
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    for (let round = 1; round <= 3; round++) {
      writeFileSync(path.join(repoRoot, 'src/alpha.ts'), `export const alpha = ${round};\n`);
      writeFileSync(path.join(repoRoot, 'src/beta.ts'), `export const beta = ${round};\n`);
      git(repoRoot, ['add', '-A']);
      git(repoRoot, ['commit', '-m', `round ${round}`]);
    }
    await initProject({ repoRoot });
    await indexProject({ repoRoot });

    // Baseline: beta surfaces for an alpha change only as a heuristic co-change.
    const before = await analyzeDiff({ repoRoot, changedFiles: ['src/alpha.ts'] });
    const betaBefore = before.affectedFiles.find((file) => file.path === 'src/beta.ts');
    assert.ok(betaBefore, 'expected beta as a co-change dependent before ingestion');
    assert.equal(betaBefore.confidence, 'heuristic');

    // Act: a runtime trace confirms the beta -> alpha edge.
    const summary = ingestTraces(repoRoot, [{ source: 'src/beta.ts', target: 'src/alpha.ts' }]);
    assert.equal(summary.promoted, 1);
    assert.equal(summary.unmatched.length, 0);

    // Assert: the same dependency is now proven.
    const after = await analyzeDiff({ repoRoot, changedFiles: ['src/alpha.ts'] });
    const betaAfter = after.affectedFiles.find((file) => file.path === 'src/beta.ts');
    assert.ok(betaAfter, 'expected beta as a dependent after ingestion');
    assert.equal(betaAfter.confidence, 'proven');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('ingestTraces reports unmatched edges without error', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'parallax-trace-miss-'));
  try {
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'src/alpha.ts'), 'export const alpha = 1;\n');
    await initProject({ repoRoot });
    await indexProject({ repoRoot });

    const summary = ingestTraces(repoRoot, [{ source: 'src/ghost.ts', target: 'src/nowhere.ts' }]);

    assert.equal(summary.promoted, 0);
    assert.deepEqual(summary.unmatched, [{ source: 'src/ghost.ts', target: 'src/nowhere.ts' }]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
