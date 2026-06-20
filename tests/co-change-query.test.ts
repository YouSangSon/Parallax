import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { indexProject, initProject, queryCoChanges } from '../src/index.js';

// End-to-end: alpha.ts and beta.ts co-change 3x in git history but never import
// each other. queryCoChanges must rank beta as alpha's coupled partner, with
// the score/count parsed back from the stored CO_CHANGES provenance, and expose
// the partner as a navigable entity resource.

function git(repoRoot: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'] });
}

async function buildCoChangingRepo(): Promise<string> {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'parallax-cochange-query-'));
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
  return repoRoot;
}

test('queryCoChanges ranks coupled partners with parsed score and navigable resources', async () => {
  const repoRoot = await buildCoChangingRepo();
  try {
    const result = queryCoChanges(repoRoot, 'src/alpha.ts');

    assert.equal(result.file, 'src/alpha.ts');
    assert.equal(typeof result.indexRunId, 'number');
    assert.ok(result.indexRunId > 0);

    const beta = result.partners.find((partner) => partner.path === 'src/beta.ts');
    assert.ok(beta, `expected src/beta.ts as a coupled partner in ${JSON.stringify(result.partners)}`);
    assert.equal(beta.coChangeCount, 3);
    assert.equal(beta.couplingScore, 1);
    assert.equal(beta.confidence, 'heuristic');

    assert.ok(
      result.resources.entities.includes('file:src/beta.ts'),
      `expected a navigable beta entity resource in ${JSON.stringify(result.resources.entities)}`
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('queryCoChanges accepts a file: entity id and is symmetric', async () => {
  const repoRoot = await buildCoChangingRepo();
  try {
    const fromBeta = queryCoChanges(repoRoot, 'file:src/beta.ts');
    assert.equal(fromBeta.file, 'src/beta.ts');
    assert.ok(
      fromBeta.partners.some((partner) => partner.path === 'src/alpha.ts'),
      'co-change is symmetric: beta must surface alpha'
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('queryCoChanges returns no partners for an uncoupled file', async () => {
  const repoRoot = await buildCoChangingRepo();
  try {
    writeFileSync(path.join(repoRoot, 'src/lonely.ts'), 'export const lonely = 1;\n');
    git(repoRoot, ['add', '-A']);
    git(repoRoot, ['commit', '-m', 'add lonely']);
    await indexProject({ repoRoot });

    const result = queryCoChanges(repoRoot, 'src/lonely.ts');
    assert.deepEqual(result.partners, []);
    assert.deepEqual(result.resources.entities, []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
