import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { analyzeDiff, indexProject, initProject } from '../src/index.js';
import { buildContextPack, selectCoChangePartners } from '../src/context_pack.js';
import type { ContextPackCoChange, ImpactReport } from '../src/types.js';

// `context_for_change` should surface git co-change partners as a ranked,
// advisory section even though they couple via history, not structure. This
// proves the context pack carries the heuristic coupling signal (with its
// strength) as a first-class field, not just buried in the affected list.

function git(repoRoot: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'] });
}

test('context pack folds in ranked git co-change partners', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'parallax-cochange-ctx-'));
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

    const report = await analyzeDiff({ repoRoot, changedFiles: ['src/alpha.ts'] });

    // Act
    const partners = selectCoChangePartners(repoRoot, ['src/alpha.ts']);
    const pack = buildContextPack(report, 'standard', '2026-06-21T00:00:00.000Z', partners);

    // Assert: beta.ts surfaces as a ranked, heuristic co-change partner of alpha.ts.
    const beta = partners.find((partner) => partner.partner === 'src/beta.ts');
    assert.ok(beta, 'expected src/beta.ts as a co-change partner');
    assert.equal(beta.changedFile, 'src/alpha.ts');
    assert.equal(beta.confidence, 'heuristic');
    assert.ok(beta.couplingScore > 0);
    assert.equal(beta.resourceUri, `parallax://entities/${encodeURIComponent('file:src/beta.ts')}`);

    // A changed file is never its own co-change partner.
    assert.ok(!partners.some((partner) => partner.partner === 'src/alpha.ts'));

    // The pack carries the section and links the partner as a navigable resource.
    assert.ok(pack.coChanges && pack.coChanges.some((entry) => entry.partner === 'src/beta.ts'));
    assert.ok(pack.resources.entities.includes(beta.resourceUri));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('selectCoChangePartners returns [] safely without an index', () => {
  // Arrange: a non-indexed dir yields no partners; the call must stay safe and
  // return an empty list rather than throwing.
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'parallax-cochange-empty-'));
  try {
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    // Act / Assert: no index -> no partners, no throw.
    assert.deepEqual(selectCoChangePartners(repoRoot, ['src/alpha.ts']), []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('buildContextPack caps co-change partners by budget and discloses the omission', () => {
  // Arrange: an empty report plus more co-change candidates than the brief budget
  // (coChangeLimit = 3) allows. Honesty contract: a capped dimension must report
  // how many it dropped, like every other bounded section.
  const report: ImpactReport = {
    id: 'r1',
    indexRunId: 1,
    changedFiles: ['src/a.ts'],
    affectedFiles: [],
    changed: [],
    affected: [],
    actions: [],
    testCommands: [],
    evidence: []
  };
  const candidates: ContextPackCoChange[] = Array.from({ length: 7 }, (_unused, index) => ({
    changedFile: 'src/a.ts',
    partner: `src/partner-${index}.ts`,
    coChangeCount: 10 - index,
    couplingScore: 1 - index * 0.1,
    confidence: 'heuristic',
    resourceUri: `parallax://entities/${encodeURIComponent(`file:src/partner-${index}.ts`)}`
  }));

  // Act
  const pack = buildContextPack(report, 'brief', '2026-06-21T00:00:00.000Z', candidates);

  // Assert
  assert.equal(pack.coChanges?.length, 3);
  assert.equal(pack.omittedCounts.coChanges, 4);
  assert.equal(pack.limits.coChangeLimit, 3);
  assert.equal(pack.limits.coChangeTruncated, true);
});
