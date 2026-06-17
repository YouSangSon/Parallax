import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';

type PackageJson = {
  exports?: Record<string, string>;
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
  files?: string[];
};

type GitHubActionsWorkflow = {
  jobs?: Record<
    string,
    {
      steps?: Array<{
        run?: string;
      }>;
    }
  >;
};

test('package exports only the public module entrypoint and metadata', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as PackageJson;

  assert.deepEqual(packageJson.exports, {
    '.': './dist/src/index.js',
    './package.json': './package.json'
  });
  assert.equal(packageJson.bin?.['parallax'], './dist/src/cli.js');
  assert.equal(packageJson.scripts?.prepack, 'npm run build');
  assert.equal(
    packageJson.scripts?.verify,
    'npm run lint && npm run test:install-smoke && npm test && npm run test:dogfood && npm run bench && npm audit --audit-level=high'
  );
  assert.equal(
    packageJson.scripts?.['test:install-smoke'],
    'npm run build && node dist/src/cli.js --help'
  );
  assert.deepEqual(packageJson.files, ['dist/src', 'README.md', 'docs']);
  assert.equal(packageJson.files?.includes('dist'), false);
});

test('CI verify job delegates to the canonical release gate', async () => {
  const workflow = parseYaml(
    await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  ) as GitHubActionsWorkflow;

  assert.equal(
    workflow.jobs?.verify?.steps?.some((step) => step.run === 'npm run verify') ?? false,
    true
  );
});
