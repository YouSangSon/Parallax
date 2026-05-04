import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

type PackageJson = {
  exports?: Record<string, string>;
  bin?: Record<string, string>;
};

test('package exports only the public module entrypoint and metadata', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as PackageJson;

  assert.deepEqual(packageJson.exports, {
    '.': './dist/src/index.js',
    './package.json': './package.json'
  });
  assert.equal(packageJson.bin?.['impact-trace'], './dist/src/cli.js');
});
