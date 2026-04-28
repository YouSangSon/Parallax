import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { analyzeDiff, indexProject, initProject } from '../src/index.js';

async function makeFixtureRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-'));
  await mkdir(path.join(repoRoot, 'src/auth'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src/routes'), { recursive: true });
  await mkdir(path.join(repoRoot, 'tests'), { recursive: true });

  await writeFile(
    path.join(repoRoot, 'src/auth/session.ts'),
    [
      'export function validateSession(token: string) {',
      '  const apiKey = "sk-test-secret-1234567890";',
      '  return token.length > 0 && apiKey.length > 0;',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/routes/private.ts'),
    [
      'import { validateSession } from "../auth/session";',
      'export function privateRoute(token: string) {',
      '  return validateSession(token) ? "ok" : "no";',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'tests/session.test.ts'),
    [
      'import { validateSession } from "../src/auth/session";',
      'test("validateSession accepts non-empty token", () => {',
      '  expect(validateSession("abc")).toBe(true);',
      '});',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'README.md'),
    'Call `validateSession` before rendering private routes.\n'
  );

  return repoRoot;
}

test('initProject creates config and SQLite database tables', async () => {
  const repoRoot = await makeFixtureRepo();

  const result = await initProject({ repoRoot });

  assert.equal(result.created, true);
  assert.equal(result.configPath.endsWith('.impact-trace/config.json'), true);
  assert.equal(result.databasePath.endsWith('.impact-trace/impact.db'), true);
  const config = JSON.parse(await readFile(result.configPath, 'utf8')) as { schemaVersion: number };
  assert.equal(config.schemaVersion, 1);
});

test('indexProject and analyzeDiff report direct importers, tests, docs, runnable commands, and redacted evidence', async () => {
  const repoRoot = await makeFixtureRepo();
  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const report = await analyzeDiff({
    repoRoot,
    changedFiles: ['src/auth/session.ts'],
    writeReport: true
  });

  assert.ok(index.filesIndexed >= 4);
  assert.deepEqual(report.changedFiles, ['src/auth/session.ts']);
  assert.ok(report.affectedFiles.some((file) => file.path === 'src/routes/private.ts'));
  assert.ok(report.affectedFiles.some((file) => file.path === 'tests/session.test.ts'));
  assert.ok(report.affectedFiles.some((file) => file.path === 'README.md'));
  assert.ok(report.testCommands.some((command) => command.command === 'npm' && command.args?.includes('tests/session.test.ts')));
  assert.ok(report.evidence.length > 0);
  assert.equal(report.evidence.some((item) => item.snippet.includes('sk-test-secret')), false);
  assert.ok(report.reportPath);
  const markdown = await readFile(path.join(repoRoot, report.reportPath), 'utf8');
  assert.match(markdown, /Impact Trace Report/);
  assert.doesNotMatch(markdown, /sk-test-secret/);
});

test('analyzeDiff returns structured test commands for repo-controlled filenames', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-command-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await mkdir(path.join(repoRoot, 'tests'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(repoRoot, 'tests/pwn$(touch_HACKED).test.ts'), 'import { a } from "../src/a"; test("a", () => a);\n');
  await initProject({ repoRoot });
  await indexProject({ repoRoot });

  const report = await analyzeDiff({ repoRoot, changedFiles: ['src/a.ts'], writeReport: true });

  const command = report.testCommands.find((item) => item.args?.includes('tests/pwn$(touch_HACKED).test.ts'));
  assert.ok(command);
  assert.deepEqual(command.args, ['test', '--', 'tests/pwn$(touch_HACKED).test.ts']);
  assert.ok(command.display.includes("'tests/pwn$(touch_HACKED).test.ts'"));
});
