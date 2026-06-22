import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { analyzeDiff, indexProject, initProject } from '../src/index.js';
import { formatPerfTable } from '../bench/impact-perf.js';
import { editSyntheticChangedFile, generateSyntheticRepo } from '../bench/synthetic-repo.js';

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

test('formatPerfTable renders full, incremental, analyze, RSS, affected, and per-kfile columns', () => {
  const output = formatPerfTable([
    {
      files: 200,
      fullIndexMs: 1000,
      noopIncrementalMs: 20,
      editIncrementalMs: 35,
      analyzeNoPersistMs: 12.5,
      analyzePersistMs: 15.5,
      affected: 199,
      rssMb: 128.4
    }
  ]);

  assert.equal(
    output,
    [
      'files\tfull_index_ms\tnoop_incremental_ms\tedit_incremental_ms\tanalyze_no_persist_ms\tanalyze_persist_ms\taffected\trss_mb\tfull_index_ms/kfile\tnoop_incremental_ms/kfile\tedit_incremental_ms/kfile\tanalyze_no_persist_ms/kfile\tanalyze_persist_ms/kfile',
      '200\t1000\t20.0\t35.0\t12.5\t15.5\t199\t128\t5000\t100\t175\t63\t78'
    ].join('\n')
  );
});

test('editSyntheticChangedFile deterministically edits the benchmark leaf', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-synth-edit-'));
  try {
    const info = await generateSyntheticRepo(root, { files: 3 });
    const before = readFileSync(path.join(root, info.changedFile), 'utf8');

    await editSyntheticChangedFile(root, info);
    const after = readFileSync(path.join(root, info.changedFile), 'utf8');

    assert.equal(before, 'export const v0 = 0;\n');
    assert.equal(after, 'export const v0 = 1;\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
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
