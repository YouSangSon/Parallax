import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Deterministic synthetic-repo generator for the S4 performance bench. Emits a
// hub of TypeScript modules: `mod0` is a leaf and every other `modK` imports it,
// so changing the leaf ripples to all importers in one high-fan-in frontier — a
// worst-case blast radius that stresses the analyzer's reverse-dependency query
// independently of traversal depth. Generation is purely index-driven (no
// randomness, no clock), so a given `files` count always produces a
// byte-identical repo and a reproducible perf baseline.

export type SyntheticRepoOptions = {
  files: number;
};

export type SyntheticRepoInfo = {
  fileCount: number;
  // The leaf module; changing it yields the maximum blast radius.
  changedFile: string;
};

function moduleSource(index: number): string {
  if (index === 0) {
    return 'export const v0 = 0;\n';
  }
  return `import { v0 } from './mod0.js';\nexport const v${index} = v0 + ${index};\n`;
}

export async function generateSyntheticRepo(
  root: string,
  options: SyntheticRepoOptions
): Promise<SyntheticRepoInfo> {
  const fileCount = Math.max(Math.trunc(options.files), 1);
  const srcDir = path.join(root, 'src');
  await mkdir(srcDir, { recursive: true });
  for (let index = 0; index < fileCount; index += 1) {
    await writeFile(path.join(srcDir, `mod${index}.ts`), moduleSource(index), 'utf8');
  }
  return { fileCount, changedFile: 'src/mod0.ts' };
}

export async function editSyntheticChangedFile(
  root: string,
  info: SyntheticRepoInfo
): Promise<void> {
  await writeFile(path.join(root, info.changedFile), 'export const v0 = 1;\n', 'utf8');
}
