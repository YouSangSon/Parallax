import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  entityKindForPath,
  isBuildManifestPath,
  isObviousContractPath,
  isTestPath,
  languageIdForPath
} from '../src/entity_classification.js';

test('languageIdForPath recognizes file names and extensions used by scanners', () => {
  assert.equal(languageIdForPath('Dockerfile'), 'dockerfile');
  assert.equal(languageIdForPath('ops/Containerfile'), 'dockerfile');
  assert.equal(languageIdForPath('Makefile'), 'makefile');
  assert.equal(languageIdForPath('CODEOWNERS'), 'policy');
  assert.equal(languageIdForPath('package.json'), 'json');
  assert.equal(languageIdForPath('pnpm-workspace.yaml'), 'yaml');
  assert.equal(languageIdForPath('pom.xml'), 'xml');
  assert.equal(languageIdForPath('build.gradle.kts'), 'gradle');
  assert.equal(languageIdForPath('src/app.ts'), 'typescript');
  assert.equal(languageIdForPath('contracts/schema.graphql'), 'graphql');
  assert.equal(languageIdForPath('unknown.ext'), undefined);
});

test('isTestPath covers supported source test naming conventions', () => {
  assert.equal(isTestPath('tests/app.test.ts'), true);
  assert.equal(isTestPath('src/__tests__/app.ts'), true);
  assert.equal(isTestPath('src/test/AppTest.java'), true);
  assert.equal(isTestPath('test_service.py'), true);
  assert.equal(isTestPath('service_test.go'), true);
  assert.equal(isTestPath('parser_spec.rs'), true);
  assert.equal(isTestPath('src/app.ts'), false);
});

test('entityKindForPath centralizes policy, workflow, config, resource, and contract classification', () => {
  const cases = [
    ['tests/app.test.ts', 'test'],
    ['docs/architecture.md', 'doc'],
    ['CODEOWNERS', 'policy'],
    ['.github/workflows/ci.yml', 'workflow'],
    ['contracts/openapi.yaml', 'contract'],
    ['contracts/asyncapi.json', 'contract'],
    ['contracts/service.proto', 'contract'],
    ['contracts/schema.graphql', 'contract'],
    ['Dockerfile', 'resource'],
    ['infra/main.tf', 'resource'],
    ['package.json', 'config'],
    ['go.mod', 'config'],
    ['pyproject.toml', 'config'],
    ['config/app.properties', 'config'],
    ['scripts/build.sh', 'config'],
    ['src/app.ts', 'file']
  ] as const;

  for (const [relativePath, expected] of cases) {
    assert.equal(entityKindForPath(relativePath), expected, relativePath);
  }
});

test('build manifest and obvious contract predicates expose reusable policy', () => {
  assert.equal(isBuildManifestPath('package.json'), true);
  assert.equal(isBuildManifestPath('apps/web/package.json'), true);
  assert.equal(isBuildManifestPath('src/app.ts'), false);
  assert.equal(isObviousContractPath('contracts/openapi.yaml'), true);
  assert.equal(isObviousContractPath('contracts/swagger.json'), true);
  assert.equal(isObviousContractPath('docs/readme.md'), false);
});
