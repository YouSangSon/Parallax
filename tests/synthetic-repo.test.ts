import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { analyzeDiff, indexProject, initProject } from '../src/index.js';
import { generateSyntheticRepo } from '../bench/synthetic-repo.js';

// The S4 perf bench needs a deterministic synthetic repo so a baseline is
// reproducible. These tests guard the generator itself (it runs in the verify
// gate even though the perf measurement does not).

test('generateSyntheticRepo is deterministic for a given size', async () => {
  const a = mkdtempSync(path.join(tmpdir(), 'parallax-synth-a-'));
  const b = mkdtempSync(path.join(tmpdir(), 'parallax-synth-b-'));
  try {
    const infoA = await generateSyntheticRepo(a, { files: 12 });
    const infoB = await generateSyntheticRepo(b, { files: 12 });

    assert.equal(infoA.fileCount, 12);
    assert.deepEqual(infoA, infoB);
    // Same size -> byte-identical module content.
    assert.equal(
      readFileSync(path.join(a, 'src/mod5.ts'), 'utf8'),
      readFileSync(path.join(b, 'src/mod5.ts'), 'utf8')
    );
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('the synthetic repo yields a real blast radius when its leaf changes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-synth-impact-'));
  try {
    const info = await generateSyntheticRepo(root, { files: 8 });
    await initProject({ repoRoot: root });
    await indexProject({ repoRoot: root });

    // Changing the leaf module should ripple to the modules that import it.
    const report = await analyzeDiff({ repoRoot: root, changedFiles: [info.changedFile] });
    assert.ok(
      report.affectedFiles.length >= 3,
      `expected a multi-file blast radius, got ${report.affectedFiles.length}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
