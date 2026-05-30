import { execFileSync } from 'node:child_process';

import { DATA_DIR } from './branding.js';

export type GitSnapshot = {
  commitSha: string | null;
  branchName: string | null;
  isDirty: boolean;
};

const emptySnapshot: GitSnapshot = {
  commitSha: null,
  branchName: null,
  isDirty: false
};

export function readGitSnapshot(repoRoot: string): GitSnapshot {
  try {
    const inside = git(repoRoot, ['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') return emptySnapshot;

    const commitSha = readCommitSha(repoRoot);
    const branchName = readBranchName(repoRoot);
    const isDirty = readDirtyState(repoRoot);
    return { commitSha, branchName, isDirty };
  } catch {
    return emptySnapshot;
  }
}

function readCommitSha(repoRoot: string): string | null {
  try {
    return git(repoRoot, ['rev-parse', 'HEAD']) || null;
  } catch {
    return null;
  }
}

function readBranchName(repoRoot: string): string | null {
  try {
    return git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null;
  } catch {
    try {
      const name = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
      return name && name !== 'HEAD' ? name : null;
    } catch {
      return null;
    }
  }
}

function readDirtyState(repoRoot: string): boolean {
  const status = gitRaw(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return statusRecords(status).some((paths) =>
    paths.some((filePath) => !isImpactTracePath(filePath))
  );
}

function statusRecords(status: string): string[][] {
  const parts = status.split('\0');
  const records: string[][] = [];
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index];
    if (!entry) continue;
    const statusCode = entry.slice(0, 2);
    const payload = entry.slice(3);
    if (!payload) continue;
    if (statusCode.includes('R') || statusCode.includes('C')) {
      const otherPath = parts[index + 1];
      if (otherPath) index++;
      records.push(otherPath ? [payload, otherPath] : [payload]);
    } else {
      records.push([payload]);
    }
  }
  return records;
}

function isImpactTracePath(filePath: string): boolean {
  const normalized = filePath.replace(/^"|"$/g, '').replaceAll('\\', '/');
  return (
    normalized === DATA_DIR ||
    normalized.startsWith(`${DATA_DIR}/`)
  );
}

function git(repoRoot: string, args: string[]): string {
  return gitRaw(repoRoot, args).trim();
}

function gitRaw(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
}
