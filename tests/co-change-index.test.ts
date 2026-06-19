import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { analyzeDiff, indexProject, initProject } from '../src/index.js';

// End-to-end: two files with NO structural relation (no import between them)
// that repeatedly change together in git history must surface each other as
// heuristic CO_CHANGES dependents in the impact report. This proves the
// indexer's git co-change pass writes traversable relations.

function git(repoRoot: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'] });
}

function commitRound(repoRoot: string, round: number): void {
  // Touch both unrelated files in the same commit, repeatedly.
  writeFileSync(path.join(repoRoot, 'src/alpha.ts'), `export const alpha = ${round};\n`);
  writeFileSync(path.join(repoRoot, 'src/beta.ts'), `export const beta = ${round};\n`);
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-m', `round ${round}`]);
}

test('analyzeDiff surfaces a git co-change dependent with heuristic confidence', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'parallax-co-change-'));
  try {
    // Arrange: a fresh git repo where alpha.ts and beta.ts co-change 3x but never import each other.
    git(repoRoot, ['init']);
    git(repoRoot, ['config', 'user.email', 'test@example.com']);
    git(repoRoot, ['config', 'user.name', 'Test']);
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    for (let round = 1; round <= 3; round++) commitRound(repoRoot, round);

    await initProject({ repoRoot });
    await indexProject({ repoRoot });

    // Act: analyze a change to alpha.ts.
    const report = await analyzeDiff({ repoRoot, changedFiles: ['src/alpha.ts'] });

    // Assert: beta.ts is reachable ONLY via co-change, at heuristic confidence.
    const beta = report.affectedFiles.find((file) => file.path === 'src/beta.ts');
    assert.ok(beta, 'expected src/beta.ts to surface as a co-change dependent of src/alpha.ts');
    assert.equal(beta.confidence, 'heuristic');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('no co-change relations are emitted outside a git work tree', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'parallax-no-git-'));
  try {
    // Arrange: plain dir, not a git repo.
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'src/alpha.ts'), 'export const alpha = 1;\n');
    writeFileSync(path.join(repoRoot, 'src/beta.ts'), 'export const beta = 1;\n');

    await initProject({ repoRoot });
    await indexProject({ repoRoot });

    // Act + Assert: no git history -> beta is not a co-change dependent of alpha.
    const report = await analyzeDiff({ repoRoot, changedFiles: ['src/alpha.ts'] });
    assert.ok(
      !report.affectedFiles.some((file) => file.path === 'src/beta.ts'),
      'unrelated file must not appear as affected without git co-change history'
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
