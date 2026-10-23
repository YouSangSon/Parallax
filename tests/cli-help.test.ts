import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const cli = path.resolve('src/cli.ts');

function runCli(repoRoot: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', require.resolve('tsx'), cli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, PARALLAX_EMBEDDING_MODEL: 'stub-sha256' }
  });
}

test('CLI help exits before command side effects', async (t) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-cli-help-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  await writeFile(path.join(repoRoot, 'sentinel.txt'), 'unchanged\n');

  const cases = [
    [], ['--help'], ['-h'], ['index', '--help'], ['index', '-h'], ['init', '-h'],
    ['ui', '--help'], ['workspace', '--help'], ['workspace', 'init', '--help'],
    ['workspace', 'init', '-h'], ['install-agent', '--help'], ['install-hook', '-h'],
    ['scip', 'export', '--help'], ['pr', 'triage', '-h'], ['graph', 'export', '--help'],
    ['mcp', 'serve', '--help']
  ];
  for (const args of cases) {
    const result = runCli(repoRoot, args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}; signal=${result.signal}`);
    assert.match(result.stdout, /Commands:\n/, args.join(' '));
    assert.deepEqual(await readdir(repoRoot), ['sentinel.txt'], args.join(' '));
    assert.equal(await readFile(path.join(repoRoot, 'sentinel.txt'), 'utf8'), 'unchanged\n');
  }
});

test('CLI help-looking option values remain data or validation errors', async (t) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-cli-help-values-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const init = runCli(repoRoot, ['init']);
  assert.equal(init.status, 0, init.stderr);

  const remember = runCli(repoRoot, [
    'remember', '--entity', 'file:example.ts', '--attribute', 'flag', '--value', '-h',
    '--agent', '--help'
  ]);
  assert.equal(remember.status, 0, remember.stderr);
  assert.equal(typeof JSON.parse(remember.stdout).factId, 'string');

  const recall = runCli(repoRoot, ['recall', '--entity', 'file:example.ts']);
  assert.equal(recall.status, 0, recall.stderr);
  assert.equal(JSON.parse(recall.stdout).facts[0].value, '-h');

  const query = runCli(repoRoot, ['recall', '--query', '--help']);
  assert.equal(query.status, 0, query.stderr);
  assert.ok(Array.isArray(JSON.parse(query.stdout).facts));

  const invalid = runCli(repoRoot, [
    'remember', '--entity', 'file:example.ts', '--attribute', 'flag', '--value', '--help'
  ]);
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.match(invalid.stderr, /missing value for --value/);

  for (const [args, message] of [
    [['workspace', '--name', '--help'], /workspace requires/],
    [['scip', '--file', '-h'], /scip requires/],
    [['workspace', 'init', '--name', '--service', '--help'], /missing value for --name/],
    [['scip', 'import', '--file', '--help'], /missing value for --file/],
    [['index', '--max-file-bytes', '--help'], /--max-file-bytes must be a non-negative integer/]
  ] as const) {
    const result = runCli(repoRoot, [...args]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, message);
  }
});
