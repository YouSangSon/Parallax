import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildRepoMap, estimateRepoMapTokens, indexProject, initProject } from '../src/index.js';

const require = createRequire(import.meta.url);
const tsxImport = require.resolve('tsx');
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function runCli(repoRoot: string, args: string[]): string {
  return execFileSync(process.execPath, ['--import', tsxImport, cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
}

async function makeRepoMapFixture(options: { extraPrivateRoutes?: number } = {}): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-repo-map-'));
  await mkdir(path.join(repoRoot, 'src/auth'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src/routes'), { recursive: true });
  await mkdir(path.join(repoRoot, 'tests'), { recursive: true });
  await mkdir(path.join(repoRoot, 'policies'), { recursive: true });
  await mkdir(path.join(repoRoot, '.github/workflows'), { recursive: true });

  await writeFile(
    path.join(repoRoot, 'src/auth/session.ts'),
    [
      'export function validateSession(token: string) {',
      '  return token.length > 0;',
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
  for (let index = 0; index < (options.extraPrivateRoutes ?? 0); index += 1) {
    await writeFile(
      path.join(repoRoot, `src/routes/private-${index}.ts`),
      [
        'import { validateSession } from "../auth/session";',
        `export function privateRoute${index}(token: string) {`,
        '  return validateSession(token) ? "ok" : "no";',
        '}',
        ''
      ].join('\n')
    );
  }
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
    path.join(repoRoot, 'README.test.md'),
    'Call `validateSession` before rendering private routes.\n'
  );
  await writeFile(
    path.join(repoRoot, 'policies/security-auth.md'),
    [
      '---',
      'title: Security Auth Policy',
      'owner: security-platform',
      'status: approved',
      'updated: 2026-01-01',
      '---',
      '# Security Auth Policy',
      '',
      'Changes to src/auth/session.ts require security review.',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, '.github/workflows/ci.yml'),
    [
      'name: ci',
      'on: [push]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm test -- tests/session.test.ts',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test' } }, null, 2)
  );
  await initProject({ repoRoot });
  await indexProject({ repoRoot });
  return repoRoot;
}

test('buildRepoMap ranks changed roots and context sections into a token-estimated card', async () => {
  const repoRoot = await makeRepoMapFixture();
  try {
    const map = await buildRepoMap({
      repoRoot,
      changedFiles: ['src/auth/session.ts'],
      query: 'privateRoute',
      budgetTokens: 5_000
    });

    assert.equal(map.kind, 'repo_map');
    assert.equal(map.budget.requestedTokens, 5_000);
    assert.equal(map.budget.estimator, 'Math.ceil(text.length / 4)');
    assert.equal(map.budget.estimatedTokens, estimateRepoMapTokens({
      ...map,
      budget: { ...map.budget, estimatedTokens: 0 }
    }));
    assert.deepEqual(map.changedRoots, ['src/auth']);
    assert.deepEqual(map.changedFiles, ['src/auth/session.ts']);
    assert.ok(map.affectedFiles.some((item) => item.path === 'src/routes/private.ts'));
    assert.ok(map.tests.some((item) => item.path === 'tests/session.test.ts'));
    assert.ok(map.docs.some((item) => item.path === 'README.test.md'));
    assert.equal(map.tests.some((item) => item.path === 'README.test.md'), false);
    assert.ok(map.config.some((item) => item.path === '.github/workflows/ci.yml'));
    assert.ok(map.workArtifacts.some((item) => item.path === 'policies/security-auth.md'));
    assert.ok(map.evidenceRefs.length > 0);
    assert.ok(map.evidenceRefs.every((item) => item.snippet.length > 0));
    assert.ok(map.verificationActions.some((action) => action.command === 'npm'));
    const planGroup = map.verificationPlan.groups.find((group) => group.targetPaths.includes('tests/session.test.ts'));
    assert.ok(planGroup);
    assert.equal(planGroup.packageRoot, '.');
    assert.equal(planGroup.display, 'npm test -- tests/session.test.ts');
    assert.deepEqual(planGroup.coveredChangedFiles, ['src/auth/session.ts']);
    assert.ok(planGroup.coveredAffectedFiles.includes('src/routes/private.ts'));
    assert.equal(planGroup.confidence, 'proven');
    assert.equal(map.resources.coverage, 'parallax://coverage/latest');
    assert.ok(map.resources.entities.every((uri) => uri.startsWith('parallax://entities/')));
    assert.ok(map.confidence.provenance.some((item) => item.includes('buildContextPack')));
    assert.ok(map.confidence.provenance.some((item) => item.includes('verification plan')));
    assert.ok(map.confidence.provenance.some((item) => item.includes('searchContext')));
    assert.ok(map.knownGaps.some((item) => item.includes('compact planning card')));
    assert.ok(map.knownGaps.some((item) => item.includes('Nx/Bazel')));
    assert.equal(typeof map.omittedCounts.affectedFiles, 'number');
    assert.equal(typeof map.omittedCounts.workArtifacts, 'number');
    assert.equal(typeof map.omittedCounts.evidenceRefs, 'number');
    assert.ok(Array.isArray(map.queryMatches));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('buildRepoMap carries omitted query matches from searchContext', async () => {
  const repoRoot = await makeRepoMapFixture({ extraPrivateRoutes: 12 });
  try {
    const map = await buildRepoMap({
      repoRoot,
      changedFiles: ['src/auth/session.ts'],
      query: 'privateRoute',
      budgetTokens: 20_000
    });

    assert.ok((map.queryMatches?.length ?? 0) > 0);
    assert.ok((map.queryMatches?.length ?? 0) <= 8);
    assert.ok(map.omittedCounts.queryMatches > 0);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('repo-map human output exposes query matches, resources, and provenance', async () => {
  const repoRoot = await makeRepoMapFixture();
  try {
    const stdout = runCli(repoRoot, [
      'repo-map',
      '--changed',
      'src/auth/session.ts',
      '--query',
      'privateRoute',
      '--budget',
      '5000'
    ]);

    assert.match(stdout, /Query matches for "privateRoute":/);
    assert.match(stdout, /Verification plan:/);
    assert.match(stdout, /npm test -- tests\/session\.test\.ts \[proven\] package \./);
    assert.match(stdout, /targets: tests\/session\.test\.ts/);
    assert.match(stdout, /parallax:\/\/entities\//);
    assert.match(stdout, /coverage parallax:\/\/coverage\/latest/);
    assert.match(stdout, /buildContextPack/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('buildRepoMap trims low budgets and discloses budget omissions', async () => {
  const repoRoot = await makeRepoMapFixture();
  try {
    const map = await buildRepoMap({
      repoRoot,
      changedFiles: ['src/auth/session.ts'],
      query: 'validateSession',
      budgetTokens: 700
    });

    assert.equal(map.budget.requestedTokens, 700);
    assert.equal(map.budget.truncated, true);
    assert.ok(map.omittedCounts.budgetItems > 0);
    assert.ok(map.affectedFiles.length >= 1);
    assert.ok(map.budget.estimatedTokens > 0);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
