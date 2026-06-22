#!/usr/bin/env tsx
/**
 * S4 performance bench — measures full index, incremental index, and analyze
 * costs on a deterministic synthetic repo at increasing scales. This is
 * intentionally NOT part of `npm run verify`: timing and peak RSS are
 * non-deterministic, so they must not reach the byte-identical
 * `ImpactBenchReport`. Run it on demand to capture a baseline or, in CI, with a
 * generous `--max-ms-per-kfile` ceiling.
 *
 *   tsx bench/impact-perf.ts                          # default scales (200, 1000)
 *   tsx bench/impact-perf.ts --scales 1000,10000      # custom scales
 *   tsx bench/impact-perf.ts --max-ms-per-kfile 2000  # fail if index cost/kfile exceeds the ceiling
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { analyzeDiff, indexProject, initProject } from '../src/index.js';
import type { IndexResult } from '../src/index.js';
import { editSyntheticChangedFile, generateSyntheticRepo } from './synthetic-repo.js';

export type PerfRow = {
  files: number;
  fullIndexMs: number;
  noopIncrementalMs: number;
  editIncrementalMs: number;
  analyzeNoPersistMs: number;
  analyzePersistMs: number;
  affected: number;
  rssMb: number;
};

type Timed<T> = {
  value: T;
  ms: number;
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

async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

function assertIncremental(result: IndexResult, label: string): void {
  if (result.mode !== 'incremental') {
    throw new Error(`${label} reindex expected mode === 'incremental', got ${result.mode}`);
  }
}

async function measure(files: number): Promise<PerfRow> {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-perf-'));
  try {
    const info = await generateSyntheticRepo(root, { files });
    await initProject({ repoRoot: root });

    const fullIndex = await timed(() => indexProject({ repoRoot: root }));
    if (fullIndex.value.mode !== 'full') {
      throw new Error(`initial index expected mode === 'full', got ${fullIndex.value.mode}`);
    }

    const noopIncremental = await timed(() => indexProject({ repoRoot: root }));
    assertIncremental(noopIncremental.value, 'no-op');

    await editSyntheticChangedFile(root, info);
    const editIncremental = await timed(() => indexProject({ repoRoot: root }));
    assertIncremental(editIncremental.value, 'single-file edit');

    const analyzeNoPersist = await timed(() =>
      analyzeDiff({ repoRoot: root, changedFiles: [info.changedFile], persistReport: false })
    );
    const analyzePersist = await timed(() =>
      analyzeDiff({ repoRoot: root, changedFiles: [info.changedFile] })
    );

    return {
      files,
      fullIndexMs: fullIndex.ms,
      noopIncrementalMs: noopIncremental.ms,
      editIncrementalMs: editIncremental.ms,
      analyzeNoPersistMs: analyzeNoPersist.ms,
      analyzePersistMs: analyzePersist.ms,
      affected: analyzePersist.value.affectedFiles.length,
      rssMb: process.memoryUsage().rss / (1024 * 1024)
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function msPerKfile(ms: number, files: number): number {
  return ms / (files / 1000);
}

export function formatPerfTable(rows: readonly PerfRow[]): string {
  const lines = [
    [
      'files',
      'full_index_ms',
      'noop_incremental_ms',
      'edit_incremental_ms',
      'analyze_no_persist_ms',
      'analyze_persist_ms',
      'affected',
      'rss_mb',
      'full_index_ms/kfile',
      'noop_incremental_ms/kfile',
      'edit_incremental_ms/kfile',
      'analyze_no_persist_ms/kfile',
      'analyze_persist_ms/kfile'
    ].join('\t')
  ];

  for (const row of rows) {
    lines.push(
      [
        row.files,
        row.fullIndexMs.toFixed(0),
        row.noopIncrementalMs.toFixed(1),
        row.editIncrementalMs.toFixed(1),
        row.analyzeNoPersistMs.toFixed(1),
        row.analyzePersistMs.toFixed(1),
        row.affected,
        row.rssMb.toFixed(0),
        msPerKfile(row.fullIndexMs, row.files).toFixed(0),
        msPerKfile(row.noopIncrementalMs, row.files).toFixed(0),
        msPerKfile(row.editIncrementalMs, row.files).toFixed(0),
        msPerKfile(row.analyzeNoPersistMs, row.files).toFixed(0),
        msPerKfile(row.analyzePersistMs, row.files).toFixed(0)
      ].join('\t')
    );
  }

  return lines.join('\n');
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

  console.log(formatPerfTable(rows));

  let worstIndexPerK = 0;
  for (const row of rows) {
    worstIndexPerK = Math.max(
      worstIndexPerK,
      msPerKfile(row.fullIndexMs, row.files),
      msPerKfile(row.noopIncrementalMs, row.files),
      msPerKfile(row.editIncrementalMs, row.files)
    );
  }

  if (ceiling !== null && Number.isFinite(ceiling) && worstIndexPerK > ceiling) {
    console.error(
      `PERF GATE FAILED: worst index cost ${worstIndexPerK.toFixed(0)} ms/kfile exceeds ceiling ${ceiling} ms/kfile`
    );
    process.exit(1);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  await main();
}
