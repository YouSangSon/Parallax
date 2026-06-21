#!/usr/bin/env tsx
/**
 * S4 performance bench — measures index + analyze cost on a deterministic
 * synthetic repo at increasing scales. This is intentionally NOT part of
 * `npm run verify`: timing and peak RSS are non-deterministic, so they must not
 * reach the byte-identical `ImpactBenchReport`. Run it on demand to capture a
 * baseline or, in CI, with a generous `--max-ms-per-kfile` ceiling.
 *
 *   tsx bench/impact-perf.ts                          # default scales (200, 1000)
 *   tsx bench/impact-perf.ts --scales 1000,10000      # custom scales
 *   tsx bench/impact-perf.ts --max-ms-per-kfile 2000  # fail if index cost/kfile exceeds the ceiling
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { analyzeDiff, indexProject, initProject } from '../src/index.js';
import { generateSyntheticRepo } from './synthetic-repo.js';

type PerfRow = {
  files: number;
  indexMs: number;
  analyzeMs: number;
  affected: number;
  rssMb: number;
};

const DEFAULT_SCALES = [200, 1000];

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index !== -1 ? argv[index + 1] : undefined;
}

function parseScales(argv: string[]): number[] {
  const raw = flagValue(argv, '--scales');
  if (!raw) return DEFAULT_SCALES;
  const scales = raw
    .split(',')
    .map((part) => Math.trunc(Number(part)))
    .filter((value) => Number.isFinite(value) && value > 0);
  return scales.length > 0 ? scales : DEFAULT_SCALES;
}

async function measure(files: number): Promise<PerfRow> {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-perf-'));
  try {
    const info = await generateSyntheticRepo(root, { files });
    await initProject({ repoRoot: root });

    const indexStart = performance.now();
    await indexProject({ repoRoot: root });
    const indexMs = performance.now() - indexStart;

    const analyzeStart = performance.now();
    const report = await analyzeDiff({ repoRoot: root, changedFiles: [info.changedFile] });
    const analyzeMs = performance.now() - analyzeStart;

    return {
      files,
      indexMs,
      analyzeMs,
      affected: report.affectedFiles.length,
      rssMb: process.memoryUsage().rss / (1024 * 1024)
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const scales = parseScales(argv);
  const ceilingRaw = flagValue(argv, '--max-ms-per-kfile');
  const ceiling = ceilingRaw !== undefined ? Number(ceilingRaw) : null;

  const rows: PerfRow[] = [];
  for (const files of scales) {
    rows.push(await measure(files));
  }

  console.log('files\tindex_ms\tanalyze_ms\taffected\trss_mb\tindex_ms/kfile');
  let worstPerK = 0;
  for (const row of rows) {
    const perK = row.indexMs / (row.files / 1000);
    worstPerK = Math.max(worstPerK, perK);
    console.log(
      [
        row.files,
        row.indexMs.toFixed(0),
        row.analyzeMs.toFixed(1),
        row.affected,
        row.rssMb.toFixed(0),
        perK.toFixed(0)
      ].join('\t')
    );
  }

  if (ceiling !== null && Number.isFinite(ceiling) && worstPerK > ceiling) {
    console.error(
      `PERF GATE FAILED: worst index cost ${worstPerK.toFixed(0)} ms/kfile exceeds ceiling ${ceiling} ms/kfile`
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
