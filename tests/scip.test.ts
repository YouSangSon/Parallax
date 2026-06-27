import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeDiff, importScipJson, indexProject, initProject } from '../src/index.js';
import { openDatabase } from '../src/store.js';

const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve('tsx');

async function makeScipRepo(): Promise<{ repoRoot: string; scipJsonPath: string }> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-scip-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/api.foo'), 'export function greet() {}\n', 'utf8');
  await writeFile(path.join(repoRoot, 'src/app.foo'), 'const value = greet();\n', 'utf8');
  const symbol = 'test npm demo 1.0.0 src/api.foo/greet().';
  const scipJsonPath = path.join(repoRoot, 'index.scip.json');
  await writeFile(
    scipJsonPath,
    `${JSON.stringify({
      metadata: {
        toolInfo: { name: 'fixture-scip', version: '1.0.0' }
      },
      documents: [
        {
          relativePath: 'src/api.foo',
          language: 'testlang',
          occurrences: [
            { range: [0, 16, 21], symbol, symbolRoles: 1 }
          ],
          symbols: [
            { symbol, displayName: 'greet', kind: 'Function' }
          ]
        },
        {
          relativePath: 'src/app.foo',
          language: 'testlang',
          occurrences: [
            { range: [0, 14, 19], symbol, symbolRoles: 8 }
          ]
        }
      ]
    }, null, 2)}\n`,
    'utf8'
  );
  await initProject({ repoRoot });
  await indexProject({ repoRoot });
  return { repoRoot, scipJsonPath };
}

test('SCIP JSON import promotes reference edges into impact analysis', async () => {
  const { repoRoot, scipJsonPath } = await makeScipRepo();
  try {
    const result = importScipJson({ repoRoot, file: scipJsonPath });
    assert.equal(result.documentsImported, 2);
    assert.equal(result.definitionsImported, 1);
    assert.equal(result.referencesSeen, 1);
    assert.equal(result.relationsImported, 1);
    assert.deepEqual(result.warnings, []);

    const db = openDatabase(repoRoot, { readOnly: true });
    try {
      const relation = db.prepare(`
        SELECT
          adapter_runs.adapter_id,
          source.path AS source_path,
          target.path AS target_path,
          evidence.snippet,
          evidence.start_line,
          evidence.start_col
        FROM relations
        INNER JOIN adapter_runs ON adapter_runs.id = relations.adapter_run_id
        INNER JOIN entities source ON source.id = relations.source_entity_id
        INNER JOIN entities target ON target.id = relations.target_entity_id
        INNER JOIN relation_evidence evidence ON evidence.relation_id = relations.id
        WHERE relations.index_run_id = ?
          AND relations.kind = 'REFERENCES'
      `).get(result.indexRunId) as {
        adapter_id: string;
        source_path: string;
        target_path: string;
        snippet: string;
        start_line: number;
        start_col: number;
      } | undefined;
      assert.ok(relation);
      assert.equal(relation.adapter_id, 'scip-import');
      assert.equal(relation.source_path, 'src/app.foo');
      assert.equal(relation.target_path, 'src/api.foo');
      assert.equal(relation.snippet, 'const value = greet();');
      assert.equal(relation.start_line, 1);
      assert.equal(relation.start_col, 15);
    } finally {
      db.close();
    }

    const report = await analyzeDiff({
      repoRoot,
      changedFiles: ['src/api.foo'],
      persistReport: false
    });
    assert.ok(report.affectedFiles.some((file) =>
      file.path === 'src/app.foo' &&
      file.reason === 'references src/api.foo' &&
      file.confidence === 'proven'
    ));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('CLI scip import prints the import summary as JSON', async () => {
  const { repoRoot, scipJsonPath } = await makeScipRepo();
  try {
    const result = spawnSync(
      process.execPath,
      ['--import', tsxLoaderPath, path.resolve('src/cli.ts'), 'scip', 'import', '--file', scipJsonPath],
      { cwd: repoRoot, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout) as { documentsImported: number; relationsImported: number };
    assert.equal(json.documentsImported, 2);
    assert.equal(json.relationsImported, 1);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
