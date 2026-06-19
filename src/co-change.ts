// Heuristic file<->file coupling derived from git history: pairs of indexed
// files that repeatedly change in the same commit. This recovers couplings the
// static graph structurally misses (config<->code, test<->impl) and is emitted
// as low-confidence CO_CHANGES relations. The math is pure and deterministic so
// it is unit-testable without git I/O; the thin git reader is the only side
// effect and degrades to an empty history outside a git work tree.

import { execFileSync } from 'node:child_process';

export type CommitHistoryOptions = {
  // Only consider commits newer than this many months.
  sinceMonths: number;
  // Hard cap on commits scanned, newest first, to bound work on large repos.
  maxCommits: number;
};

export const DEFAULT_HISTORY_OPTIONS: CommitHistoryOptions = {
  sinceMonths: 12,
  maxCommits: 1500
};

export type CoChangePair = {
  source: string;
  target: string;
  coChangeCount: number;
  couplingScore: number;
};

export type CoChangeOptions = {
  // Minimum commits in which two files must co-change to be coupled.
  minCoChanges: number;
  // Minimum coChangeCount / max(changeFreq) ratio, relative to the busier file.
  minCouplingScore: number;
  // Commits touching more files than this are treated as noise (sweeping
  // refactors, formatting, generated bumps) and skipped.
  maxFilesPerCommit: number;
};

export const DEFAULT_CO_CHANGE_OPTIONS: CoChangeOptions = {
  minCoChanges: 3,
  minCouplingScore: 0.3,
  maxFilesPerCommit: 25
};

// NUL joins pair keys: file paths may contain spaces but never a NUL byte.
const PAIR_SEP = '\u0000';

export function computeCoChanges(
  commits: readonly (readonly string[])[],
  includedFiles: ReadonlySet<string>,
  options: Partial<CoChangeOptions> = {}
): CoChangePair[] {
  const opts = { ...DEFAULT_CO_CHANGE_OPTIONS, ...options };
  const changeFreq = new Map<string, number>();
  const pairCounts = new Map<string, { a: string; b: string; count: number }>();

  for (const commit of commits) {
    const unique = [...new Set(commit)];
    if (unique.length > opts.maxFilesPerCommit) continue;
    const files = unique.filter((file) => includedFiles.has(file)).sort();
    for (const file of files) {
      changeFreq.set(file, (changeFreq.get(file) ?? 0) + 1);
    }
    for (let i = 0; i < files.length; i++) {
      const a = files[i]!;
      for (let j = i + 1; j < files.length; j++) {
        const b = files[j]!;
        const key = `${a}${PAIR_SEP}${b}`;
        const existing = pairCounts.get(key);
        if (existing) existing.count++;
        else pairCounts.set(key, { a, b, count: 1 });
      }
    }
  }

  const pairs: CoChangePair[] = [];
  for (const { a, b, count } of pairCounts.values()) {
    if (count < opts.minCoChanges) continue;
    const couplingScore =
      count / Math.max(changeFreq.get(a) ?? 0, changeFreq.get(b) ?? 0);
    if (couplingScore < opts.minCouplingScore) continue;
    // Co-change is symmetric; emit both directed relations so changing either
    // file surfaces the other as affected during blast-radius traversal.
    pairs.push({ source: a, target: b, coChangeCount: count, couplingScore });
    pairs.push({ source: b, target: a, coChangeCount: count, couplingScore });
  }
  pairs.sort(
    (x, y) => x.source.localeCompare(y.source) || x.target.localeCompare(y.target)
  );
  return pairs;
}

// Parses `git log --name-only --format=%x00` output into one file-path list per
// commit. Commits are NUL-delimited; each commit's chunk is its changed paths,
// one per line. Pure so it can be tested without invoking git.
export function parseGitLogNameOnly(output: string): string[][] {
  return output
    .split('\u0000')
    .map((chunk) =>
      chunk
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    )
    .filter((files) => files.length > 0);
}

export function readCommitHistory(
  repoRoot: string,
  options: Partial<CommitHistoryOptions> = {}
): string[][] {
  const opts = { ...DEFAULT_HISTORY_OPTIONS, ...options };
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (inside !== 'true') return [];

    const output = execFileSync(
      'git',
      [
        'log',
        `--since=${opts.sinceMonths}.months`,
        `--max-count=${opts.maxCommits}`,
        '--no-merges',
        '--name-only',
        '--format=%x00'
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024
      }
    );
    return parseGitLogNameOnly(output);
  } catch {
    return [];
  }
}
