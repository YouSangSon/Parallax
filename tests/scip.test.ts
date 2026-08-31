import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeDiff, exportScipJson, importScipJson, indexProject, initProject } from '../src/index.js';
import { openDatabase } from '../src/store.js';

const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve('tsx');

type ScipRepoOptions = {
  extension?: string;
  includeText?: boolean;
  appContent?: string;
  documentAppContent?: string;
};

async function makeScipRepo(options: ScipRepoOptions = {}): Promise<{
  repoRoot: string;
  scipJsonPath: string;
  apiPath: string;
  appPath: string;
  symbol: string;
}> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-scip-'));
  const extension = options.extension ?? 'foo';
  const includeText = options.includeText ?? true;
  const apiPath = `src/api.${extension}`;
  const appPath = `src/app.${extension}`;
  const apiContent = 'export function greet() {}\n';
  const appContent = options.appContent ?? 'const value = greet();\n';
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, apiPath), apiContent, 'utf8');
  await writeFile(path.join(repoRoot, appPath), appContent, 'utf8');
  const symbol = `test npm demo 1.0.0 ${apiPath}/greet().`;
  const scipJsonPath = path.join(repoRoot, 'index.scip.json');
  await writeFile(
    scipJsonPath,
    `${JSON.stringify({
      metadata: {
        toolInfo: { name: 'fixture-scip', version: '1.0.0' }
      },
      documents: [
        {
          relativePath: apiPath,
          language: 'testlang',
          ...(includeText ? { text: apiContent } : {}),
          occurrences: [
            { range: [0, 16, 21], symbol, symbolRoles: 1 }
          ],
          symbols: [
            { symbol, displayName: 'greet', kind: 'Function' }
          ]
        },
        {
          relativePath: appPath,
          language: 'testlang',
          ...(includeText ? { text: options.documentAppContent ?? appContent } : {}),
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
  return { repoRoot, scipJsonPath, apiPath, appPath, symbol };
}

function git(repoRoot: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoRoot, stdio: 'ignore' });
}

function initGitRepo(repoRoot: string): void {
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'parallax@example.com']);
  git(repoRoot, ['config', 'user.name', 'Parallax Test']);
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'base']);
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function childResult(child: ReturnType<typeof spawn>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

async function makeScipExportRepo(): Promise<{ repoRoot: string }> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-scip-export-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'src/api.ts'),
    'export interface Greeter { greet(): string }\nexport function greet() { return "hi"; }\n',
    'utf8'
  );
  await writeFile(
    path.join(repoRoot, 'src/app.ts'),
    'import { Greeter, greet } from "./api";\nexport class App implements Greeter { greet() { return greet(); } }\n',
    'utf8'
  );
  await initProject({ repoRoot });
  await indexProject({ repoRoot });
  return { repoRoot };
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

test('SCIP embedded text is immutable across leaf and ancestor replacement', async () => {
  for (const replacement of ['leaf', 'ancestor'] as const) {
    const { repoRoot, scipJsonPath, appPath } = await makeScipRepo();
    const outsideRoot = await mkdtemp(path.join(tmpdir(), `parallax-scip-${replacement}-`));
    try {
      await mkdir(path.join(outsideRoot, 'src'), { recursive: true });
      await writeFile(path.join(outsideRoot, 'outside.foo'), 'outside content must not be imported\n', 'utf8');
      if (replacement === 'leaf') {
        await unlink(path.join(repoRoot, appPath));
        await symlink(path.join(outsideRoot, 'outside.foo'), path.join(repoRoot, appPath));
      } else {
        await writeFile(path.join(outsideRoot, 'src/api.foo'), 'outside api\n', 'utf8');
        await writeFile(path.join(outsideRoot, 'src/app.foo'), 'outside app\n', 'utf8');
        await rm(path.join(repoRoot, 'src'), { recursive: true, force: true });
        await symlink(path.join(outsideRoot, 'src'), path.join(repoRoot, 'src'), 'dir');
      }

      const result = importScipJson({ repoRoot, file: scipJsonPath });
      assert.equal(result.documentsImported, 2, replacement);
      assert.deepEqual(result.warnings, [], replacement);
      const db = openDatabase(repoRoot, { readOnly: true });
      try {
        const evidence = db.prepare("SELECT snippet FROM relation_evidence WHERE kind = 'REFERENCES'")
          .get() as { snippet: string } | undefined;
        assert.equal(evidence?.snippet, 'const value = greet();', replacement);
      } finally {
        db.close();
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  }
});

test('SCIP textless indexed documents preserve indexed rows and use symbol snippets', async () => {
  const { repoRoot, scipJsonPath, symbol } = await makeScipRepo({ extension: 'ts', includeText: false });
  try {
    const beforeDb = openDatabase(repoRoot, { readOnly: true });
    const before = beforeDb.prepare(`
      SELECT files.path, files.language, files.content_hash, entity_versions.content_hash AS entity_hash,
             entity_versions.location_json
      FROM files
      INNER JOIN entity_versions
        ON entity_versions.entity_id = 'file:' || files.path
       AND entity_versions.index_run_id = files.index_run_id
      ORDER BY files.path
    `).all();
    beforeDb.close();

    const result = importScipJson({ repoRoot, file: scipJsonPath });
    assert.equal(result.documentsImported, 2);
    assert.deepEqual(result.warnings, []);

    const afterDb = openDatabase(repoRoot, { readOnly: true });
    try {
      const after = afterDb.prepare(`
        SELECT files.path, files.language, files.content_hash, entity_versions.content_hash AS entity_hash,
               entity_versions.location_json
        FROM files
        INNER JOIN entity_versions
          ON entity_versions.entity_id = 'file:' || files.path
         AND entity_versions.index_run_id = files.index_run_id
        ORDER BY files.path
      `).all();
      assert.deepEqual(after, before);
      const evidence = afterDb.prepare("SELECT snippet FROM relation_evidence WHERE kind = 'REFERENCES'")
        .get() as { snippet: string } | undefined;
      assert.equal(evidence?.snippet, symbol);
    } finally {
      afterDb.close();
    }
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('SCIP textless unindexed documents load blobs from the clean indexed commit', async () => {
  const { repoRoot, scipJsonPath } = await makeScipRepo({ includeText: false });
  try {
    initGitRepo(repoRoot);
    await indexProject({ repoRoot });
    await rm(path.join(repoRoot, 'src'), { recursive: true, force: true });

    const result = importScipJson({ repoRoot, file: scipJsonPath });
    assert.equal(result.documentsImported, 2);
    assert.deepEqual(result.warnings, []);
    const db = openDatabase(repoRoot, { readOnly: true });
    try {
      const evidence = db.prepare("SELECT snippet FROM relation_evidence WHERE kind = 'REFERENCES'")
        .get() as { snippet: string } | undefined;
      assert.equal(evidence?.snippet, 'const value = greet();');
    } finally {
      db.close();
    }
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('SCIP import locks its index snapshot before reading Git blobs', async () => {
  const { repoRoot, scipJsonPath } = await makeScipRepo({ includeText: false });
  const marker = path.join(repoRoot, 'git-started');
  const release = path.join(repoRoot, 'git-release');
  let importer: ReturnType<typeof spawn> | undefined;
  let indexer: ReturnType<typeof spawn> | undefined;
  try {
    initGitRepo(repoRoot);
    await indexProject({ repoRoot });
    const binDir = path.join(repoRoot, 'bin');
    await mkdir(binDir);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const fakeGit = path.join(binDir, 'git');
    await writeFile(fakeGit, [
      '#!/bin/sh',
      `: > ${JSON.stringify(marker)}`,
      `while [ ! -e ${JSON.stringify(release)} ]; do sleep 0.02; done`,
      `exec ${JSON.stringify(realGit)} "$@"`
    ].join('\n'), 'utf8');
    await chmod(fakeGit, 0o755);

    importer = spawn(
      process.execPath,
      ['--import', tsxLoaderPath, path.resolve('src/cli.ts'), 'scip', 'import', '--file', scipJsonPath],
      { cwd: repoRoot, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` } }
    );
    const importerDone = childResult(importer);
    await waitForFile(marker);

    const indexStarted = path.join(repoRoot, 'index-started');
    const moduleUrl = pathToFileURL(path.resolve('src/index.ts')).href;
    indexer = spawn(process.execPath, [
      '--import', tsxLoaderPath,
      '--input-type=module',
      '--eval',
      `import { writeFileSync } from 'node:fs'; import { indexProject } from ${JSON.stringify(moduleUrl)}; writeFileSync(${JSON.stringify(indexStarted)}, ''); await indexProject({ repoRoot: ${JSON.stringify(repoRoot)} });`
    ], { cwd: repoRoot });
    const indexerDone = childResult(indexer);
    await waitForFile(indexStarted);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const indexWasBlocked = indexer.exitCode === null;

    await writeFile(release, '', 'utf8');
    const [importResult, indexResult] = await Promise.all([importerDone, indexerDone]);
    assert.equal(indexWasBlocked, true, 'concurrent index completed before SCIP released its snapshot lock');
    assert.equal(importResult.status, 0, importResult.stderr);
    assert.equal(indexResult.status, 0, indexResult.stderr);
  } finally {
    await writeFile(release, '', 'utf8').catch(() => undefined);
    importer?.kill();
    indexer?.kill();
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('SCIP import accepts an explicitly selected local JSON file outside the repository', async () => {
  const { repoRoot, scipJsonPath } = await makeScipRepo();
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'parallax-scip-input-'));
  try {
    const outsideInput = path.join(outsideRoot, 'index.scip.json');
    await writeFile(outsideInput, await readFile(scipJsonPath));
    const result = importScipJson({ repoRoot, file: outsideInput });
    assert.equal(result.documentsImported, 2);
    assert.equal(result.relationsImported, 1);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test('SCIP textless unindexed documents skip dirty and non-Git snapshots', async () => {
  for (const snapshot of ['dirty', 'non-git'] as const) {
    const { repoRoot, scipJsonPath } = await makeScipRepo({ includeText: false });
    try {
      if (snapshot === 'dirty') {
        initGitRepo(repoRoot);
        await writeFile(path.join(repoRoot, 'dirty.txt'), 'dirty\n', 'utf8');
        await indexProject({ repoRoot });
      }
      const result = importScipJson({ repoRoot, file: scipJsonPath });
      assert.equal(result.documentsImported, 0, snapshot);
      assert.equal(result.warnings.length, 2, snapshot);
      assert.ok(result.warnings.every((warning) => warning.includes('content unavailable')), snapshot);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  }
});

test('SCIP inline hash mismatches do not mutate indexed file rows', async () => {
  const { repoRoot, scipJsonPath, appPath } = await makeScipRepo({
    extension: 'ts',
    documentAppContent: 'const changed = greet();\n'
  });
  try {
    const beforeDb = openDatabase(repoRoot, { readOnly: true });
    const before = beforeDb.prepare('SELECT content_hash FROM files WHERE path = ?')
      .get(appPath) as { content_hash: string };
    beforeDb.close();

    const result = importScipJson({ repoRoot, file: scipJsonPath });
    assert.equal(result.documentsImported, 1);
    assert.ok(result.warnings.some((warning) => warning.includes(`${appPath}: embedded text hash mismatch`)));
    const afterDb = openDatabase(repoRoot, { readOnly: true });
    try {
      const after = afterDb.prepare('SELECT content_hash FROM files WHERE path = ?')
        .get(appPath) as { content_hash: string };
      assert.equal(after.content_hash, before.content_hash);
    } finally {
      afterDb.close();
    }
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('SCIP imports empty embedded text without consulting the worktree', async () => {
  const { repoRoot, scipJsonPath, appPath } = await makeScipRepo({ documentAppContent: '' });
  try {
    const result = importScipJson({ repoRoot, file: scipJsonPath });
    assert.equal(result.documentsImported, 2);
    const db = openDatabase(repoRoot, { readOnly: true });
    try {
      const row = db.prepare('SELECT content_hash FROM files WHERE path = ?')
        .get(appPath) as { content_hash: string };
      assert.equal(row.content_hash, createHash('sha256').update('').digest('hex'));
    } finally {
      db.close();
    }
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('SCIP rejects backslashes and newlines in document relative paths', async () => {
  const { repoRoot, scipJsonPath } = await makeScipRepo();
  try {
    const fixture = JSON.parse(await readFile(scipJsonPath, 'utf8')) as { documents: Array<Record<string, unknown>> };
    fixture.documents.push(
      { relativePath: 'src\\bad.foo', text: 'bad' },
      { relativePath: 'src/bad\n.foo', text: 'bad' }
    );
    await writeFile(scipJsonPath, `${JSON.stringify(fixture)}\n`, 'utf8');

    const result = importScipJson({ repoRoot, file: scipJsonPath });
    assert.equal(result.documentsImported, 2);
    assert.equal(result.warnings.filter((warning) => warning.includes('relativePath must be canonical')).length, 2);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('SCIP evidence IDs use SHA-256 for redacted source snippets', async () => {
  const { repoRoot, scipJsonPath } = await makeScipRepo({
    appContent: 'const token = "sk-abcdefghijklmnopqrstuvwxyz123456"; greet();\n'
  });
  try {
    const result = importScipJson({ repoRoot, file: scipJsonPath });
    const db = openDatabase(repoRoot, { readOnly: true });
    try {
      const evidence = db.prepare(`
        SELECT id, relation_id, snippet, start_line, end_line, start_col, end_col
        FROM relation_evidence
        WHERE index_run_id = ? AND kind = 'REFERENCES'
      `).get(result.indexRunId) as {
        id: string;
        relation_id: string;
        snippet: string;
        start_line: number;
        end_line: number;
        start_col: number;
        end_col: number;
      } | undefined;
      assert.ok(evidence);
      assert.doesNotMatch(evidence.snippet, /sk-/);
      const expectedId = createHash('sha256')
        .update(JSON.stringify([
          evidence.relation_id,
          'src/app.foo',
          evidence.snippet,
          evidence.start_line,
          evidence.end_line,
          evidence.start_col,
          evidence.end_col
        ]))
        .digest('hex')
        .slice(0, 20);
      assert.equal(evidence.id, expectedId);
    } finally {
      db.close();
    }
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('SCIP binary import converts through the official scip CLI printer', async () => {
  const { repoRoot, scipJsonPath } = await makeScipRepo();
  const previousPath = process.env.PATH;
  const previousFixture = process.env.PARALLAX_TEST_SCIP_JSON;
  try {
    const binDir = path.join(repoRoot, 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(repoRoot, 'index.scip'), 'not-json\n', 'utf8');
    const fakeScip = path.join(binDir, 'scip');
    await writeFile(
      fakeScip,
      [
        '#!/usr/bin/env node',
        "import { readFileSync } from 'node:fs';",
        "if (process.argv[2] !== 'print' || process.argv[3] !== '--json' || !process.argv[4]?.endsWith('index.scip')) {",
        "  console.error(`unexpected args: ${process.argv.slice(2).join(' ')}`);",
        '  process.exit(2);',
        '}',
        "process.stdout.write(readFileSync(process.env.PARALLAX_TEST_SCIP_JSON, 'utf8'));"
      ].join('\n'),
      'utf8'
    );
    await chmod(fakeScip, 0o755);

    process.env.PARALLAX_TEST_SCIP_JSON = scipJsonPath;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;

    const result = importScipJson({ repoRoot, file: 'index.scip' });
    assert.equal(result.file, 'index.scip');
    assert.equal(result.documentsImported, 2);
    assert.equal(result.definitionsImported, 1);
    assert.equal(result.referencesSeen, 1);
    assert.equal(result.relationsImported, 1);
    assert.deepEqual(result.warnings, []);
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousFixture === undefined) {
      delete process.env.PARALLAX_TEST_SCIP_JSON;
    } else {
      process.env.PARALLAX_TEST_SCIP_JSON = previousFixture;
    }
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

test('SCIP JSON export emits latest index documents, symbols, and reference occurrences', async () => {
  const { repoRoot } = await makeScipExportRepo();
  try {
    const result = exportScipJson({ repoRoot });
    assert.equal(result.documentsExported, 2);
    assert.ok(result.symbolsExported >= 2);
    assert.ok(result.occurrencesExported >= 1);
    assert.equal(result.index.metadata.toolInfo.name, 'parallax');

    const api = result.index.documents.find((document) => document.relativePath === 'src/api.ts');
    const app = result.index.documents.find((document) => document.relativePath === 'src/app.ts');
    assert.ok(api);
    assert.ok(app);
    const apiSymbols = new Set(api.symbols.map((symbol) => symbol.symbol));
    const greeter = api.symbols.find((symbol) => symbol.displayName === 'Greeter');
    assert.ok(greeter);
    assert.ok(greeter.symbol.endsWith('#'), `expected interface symbol suffix, got ${greeter.symbol}`);
    assert.ok(app.occurrences.some((occurrence) => occurrence.symbol === greeter.symbol));
    assert.ok(app.occurrences.some((occurrence) => apiSymbols.has(occurrence.symbol)));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('CLI scip export writes SCIP JSON and prints a summary', async () => {
  const { repoRoot } = await makeScipExportRepo();
  try {
    const output = path.join(repoRoot, 'index.scip.json');
    const result = spawnSync(
      process.execPath,
      ['--import', tsxLoaderPath, path.resolve('src/cli.ts'), 'scip', 'export', '--file', output],
      { cwd: repoRoot, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout) as { documentsExported: number; file: string };
    assert.equal(summary.documentsExported, 2);
    assert.equal(summary.file, output);
    const exported = JSON.parse(await readFile(output, 'utf8')) as ReturnType<typeof exportScipJson>['index'];
    assert.equal(exported.metadata.toolInfo.name, 'parallax');
    assert.equal(exported.documents.length, 2);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
