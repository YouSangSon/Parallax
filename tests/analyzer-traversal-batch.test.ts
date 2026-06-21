import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { analyzeDiff, indexProject, initProject } from '../src/index.js';

// Characterization guard for the analyzer's reverse-dependency traversal. A
// two-level dependency graph forces a multi-node frontier at depth 2, and a
// fanout-limited hub exercises per-node truncation. Any future change to the
// traversal (batching, query restructuring, ordering) must keep this output
// byte-for-byte identical.

test('two-level reverse traversal yields a stable, depth-correct affected set', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-traversal-'));
  try {
    // leaf <- {a, b} (depth 1) <- {aa imports a, bb imports b} (depth 2)
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src/leaf.ts'), 'export const leaf = 0;\n');
    writeFileSync(path.join(root, 'src/a.ts'), "import { leaf } from './leaf.js';\nexport const a = leaf + 1;\n");
    writeFileSync(path.join(root, 'src/b.ts'), "import { leaf } from './leaf.js';\nexport const b = leaf + 2;\n");
    writeFileSync(path.join(root, 'src/aa.ts'), "import { a } from './a.js';\nexport const aa = a + 1;\n");
    writeFileSync(path.join(root, 'src/bb.ts'), "import { b } from './b.js';\nexport const bb = b + 1;\n");

    await initProject({ repoRoot: root });
    await indexProject({ repoRoot: root });

    const report = await analyzeDiff({ repoRoot: root, changedFiles: ['src/leaf.ts'], maxDepth: 5 });

    const affectedPaths = report.affectedFiles.map((file) => file.path).sort();
    assert.deepEqual(affectedPaths, ['src/a.ts', 'src/aa.ts', 'src/b.ts', 'src/bb.ts']);

    const depthByPath = new Map(report.affectedFiles.map((file) => [file.path, file.depth]));
    assert.equal(depthByPath.get('src/a.ts'), 1);
    assert.equal(depthByPath.get('src/b.ts'), 1);
    assert.equal(depthByPath.get('src/aa.ts'), 2);
    assert.equal(depthByPath.get('src/bb.ts'), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fanout limit truncates per node and warns', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallax-fanout-'));
  try {
    // One leaf imported by five modules; maxFanout=2 must keep exactly 2 and warn.
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src/leaf.ts'), 'export const leaf = 0;\n');
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(
        path.join(root, `src/dep${i}.ts`),
        `import { leaf } from './leaf.js';\nexport const dep${i} = leaf + ${i};\n`
      );
    }
    await initProject({ repoRoot: root });
    await indexProject({ repoRoot: root });

    const report = await analyzeDiff({
      repoRoot: root,
      changedFiles: ['src/leaf.ts'],
      maxDepth: 1,
      maxFanout: 2
    });

    assert.equal(report.affectedFiles.length, 2);
    assert.ok((report.warnings ?? []).some((warning) => warning.includes('fanout limit')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
