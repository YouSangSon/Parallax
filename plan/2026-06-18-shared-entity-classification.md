# Shared Entity Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make path-to-`EntityKind` classification consistent across indexing, impact analysis, and legacy graph export.

**Architecture:** Add one small utility module that owns language detection, test-path detection, build-manifest detection, and file entity kind classification. Existing callers keep their public behavior but stop carrying private copies of the same rules.

**Tech Stack:** TypeScript ESM, Node.js built-in `node:path`, `node:test`, existing `EntityKind` and `ScannedFile` types.

## Global Constraints

- Do not add a new `EntityKind`; reuse the current public type union.
- Keep `entityKindForMarkdownPath` as the source for Markdown artifact classification.
- Preserve existing indexing behavior for known source files, test files, Markdown files, policy files, workflow YAML, obvious OpenAPI/Swagger/AsyncAPI contracts, Dockerfiles, Terraform files, protobuf files, GraphQL files, and generic config files.
- Extend analyzer and legacy graph fallback behavior to match the indexer for build manifests and infrastructure/config/contract paths.
- Keep edits scoped to shared classification, its callers, focused tests, and plan/progress bookkeeping.
- Use package-visible source imports with `.js` extensions.

---

### Task 1: Add Shared Classification Utility

**Files:**
- Create: `src/entity_classification.ts`
- Create: `tests/entity_classification.test.ts`

**Interfaces:**
- Produces: `languageIdForPath(relativePath: string): string | undefined`
- Produces: `isTestPath(relativePath: string): boolean`
- Produces: `isBuildManifestPath(relativePath: string): boolean`
- Produces: `isObviousContractPath(relativePath: string): boolean`
- Produces: `entityKindForPath(relativePath: string, languageId?: string): EntityKind`

- [ ] **Step 1: Write the failing unit tests**

Create `tests/entity_classification.test.ts`:

```ts
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
```

Run: `npm test -- tests/entity_classification.test.ts`

Expected: FAIL because `src/entity_classification.ts` does not exist.

- [ ] **Step 2: Add the shared utility**

Create `src/entity_classification.ts`:

```ts
import path from 'node:path';

import { entityKindForMarkdownPath } from './artifacts.js';
import type { EntityKind } from './types.js';

const languageByExtension = new Map<string, string>([
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.md', 'markdown'],
  ['.py', 'python'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.java', 'java'],
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
  ['.cs', 'csharp'],
  ['.c', 'c'],
  ['.h', 'c'],
  ['.cpp', 'cpp'],
  ['.cc', 'cpp'],
  ['.cxx', 'cpp'],
  ['.hpp', 'cpp'],
  ['.hh', 'cpp'],
  ['.hxx', 'cpp'],
  ['.sh', 'shell'],
  ['.bash', 'shell'],
  ['.zsh', 'shell'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.json', 'json'],
  ['.toml', 'toml'],
  ['.properties', 'properties'],
  ['.tf', 'terraform'],
  ['.proto', 'protobuf'],
  ['.graphql', 'graphql'],
  ['.gql', 'graphql'],
  ['.gradle', 'gradle']
]);

const languageByFileName = new Map<string, string>([
  ['Dockerfile', 'dockerfile'],
  ['Containerfile', 'dockerfile'],
  ['Makefile', 'makefile'],
  ['CODEOWNERS', 'policy'],
  ['package.json', 'json'],
  ['pnpm-workspace.yaml', 'yaml'],
  ['pom.xml', 'xml'],
  ['settings.gradle', 'gradle'],
  ['settings.gradle.kts', 'gradle'],
  ['build.gradle', 'gradle'],
  ['build.gradle.kts', 'gradle'],
  ['go.mod', 'go'],
  ['go.work', 'go'],
  ['Cargo.toml', 'toml'],
  ['pyproject.toml', 'toml']
]);

const configLanguageIds = new Set(['yaml', 'json', 'toml', 'properties', 'shell', 'makefile', 'gradle', 'xml']);

export function languageIdForPath(relativePath: string): string | undefined {
  const basename = path.posix.basename(relativePath);
  const byName = languageByFileName.get(basename);
  if (byName) return byName;
  const ext = path.posix.extname(basename).toLowerCase();
  return languageByExtension.get(ext);
}

export function isTestPath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath);
  return (
    /(^|\/)(tests?|__tests__)\/|(^|\/)src\/test\//.test(relativePath) ||
    /(\.|-)(test|spec)\.[cm]?[tj]sx?$/.test(basename) ||
    /(?:Test|Tests|Spec)\.(?:java|kt)$/.test(basename) ||
    /(?:^test_.*|.*_test)\.py$/.test(basename) ||
    /_test\.go$/.test(basename) ||
    /(?:_test|_spec)\.rs$/.test(basename)
  );
}

export function isBuildManifestPath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath);
  return (
    basename === 'package.json' ||
    basename === 'pnpm-workspace.yaml' ||
    basename === 'pom.xml' ||
    basename === 'settings.gradle' ||
    basename === 'settings.gradle.kts' ||
    basename === 'build.gradle' ||
    basename === 'build.gradle.kts' ||
    basename === 'go.mod' ||
    basename === 'go.work' ||
    basename === 'Cargo.toml' ||
    basename === 'pyproject.toml'
  );
}

export function isObviousContractPath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath);
  const withoutExtension = basename.replace(/\.[^.]+$/, '').toLowerCase();
  return (
    withoutExtension.includes('openapi') ||
    withoutExtension.includes('swagger') ||
    withoutExtension.includes('asyncapi')
  );
}

export function entityKindForPath(relativePath: string, languageId = languageIdForPath(relativePath)): EntityKind {
  if (isTestPath(relativePath)) return 'test';
  if (languageId === 'markdown') return entityKindForMarkdownPath(relativePath);
  if (languageId === 'policy') return 'policy';
  if (languageId === 'yaml' && relativePath.startsWith('.github/workflows/')) return 'workflow';
  if ((languageId === 'yaml' || languageId === 'json') && isObviousContractPath(relativePath)) return 'contract';
  if (languageId === 'dockerfile' || languageId === 'terraform') return 'resource';
  if (isBuildManifestPath(relativePath)) return 'config';
  if (languageId === 'protobuf' || languageId === 'graphql') return 'contract';
  if (languageId !== undefined && configLanguageIds.has(languageId)) return 'config';
  return 'file';
}
```

Run: `npm test -- tests/entity_classification.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/entity_classification.ts tests/entity_classification.test.ts
git commit -m "refactor: share entity classification rules"
```

### Task 2: Wire Indexer, Analyzer, and Graph Export to Shared Utility

**Files:**
- Modify: `src/indexer.ts`
- Modify: `src/analyzer.ts`
- Modify: `src/graph.ts`
- Modify: `tests/parallax.test.ts`

**Interfaces:**
- Consumes: `entityKindForPath`, `languageIdForPath`, and `isTestPath` from `src/entity_classification.ts`
- Preserves: existing `ScannedFile.language` values and graph export JSON schema

- [ ] **Step 1: Replace duplicate imports and helpers**

In `src/indexer.ts`:

```ts
import {
  entityKindForPath,
  isTestPath as isSharedTestPath,
  languageIdForPath
} from './entity_classification.js';
```

Remove local `languageByExtension`, `languageByFileName`, `fileKind`, `isBuildManifestPath`, `isPathObviousContract`, and `languageForPath`. Replace `fileKind(file.relativePath, file.language)` with `entityKindForPath(file.relativePath, file.language)`. Replace `languageForPath(relativePath)` with `languageIdForPath(relativePath)`. Update the adapter import alias:

```ts
  isTestFile as isJavaScriptTestFile
```

Then replace the local wrapper body:

```ts
function isJavaScriptTestPath(relativePath: string): boolean {
  return isSharedTestPath(relativePath) && isJavaScriptTestFile(relativePath);
}
```

In `src/analyzer.ts`, import `entityKindForPath` and `languageIdForPath` from `./entity_classification.js`, then remove the local `entityKindForPath`, `isPathObviousContract`, `languageIdForPath`, and `isTestPath`.

In `src/graph.ts`, import `entityKindForPath` from `./entity_classification.js`, remove local `kindForPath`, and replace legacy graph fallback calls with `entityKindForPath(row.source_path)` and `entityKindForPath(row.target_path)`.

- [ ] **Step 2: Add integration coverage for consistent changed entity kinds**

Append to `tests/parallax.test.ts`:

```ts
test('analyzeDiff uses shared classification for build manifests', async () => {
  const repoRoot = await makeFixtureRepo();
  await writeFile(
    path.join(repoRoot, 'go.mod'),
    ['module example.com/parallax-fixture', '', 'go 1.24', ''].join('\n')
  );
  initGitRepo(repoRoot);
  await initProject({ repoRoot });
  await indexProject({ repoRoot });

  await writeFile(
    path.join(repoRoot, 'go.mod'),
    ['module example.com/parallax-fixture', '', 'go 1.25', ''].join('\n')
  );

  const report = await analyzeDiff({ repoRoot, changedFiles: ['go.mod'] });
  const goModuleEntity = report.changed.find((entity) => entity.path === 'go.mod');
  assert.equal(goModuleEntity?.kind, 'config');
});
```

Run: `npm test -- tests/entity_classification.test.ts tests/parallax.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/indexer.ts src/analyzer.ts src/graph.ts tests/parallax.test.ts
git commit -m "refactor: reuse shared entity classification"
```

### Task 3: Document the Classification Contract and Verify

**Files:**
- Modify: `docs/glossary.md`
- Modify: `docs/glossary.ko.md`
- Modify: `docs/glossary.zh.md`
- Modify: `plan/2026-06-18-shared-entity-classification.md`

**Interfaces:**
- Consumes: final implementation from Tasks 1-2
- Produces: public-facing kind classification explanation for maintainers

- [ ] **Step 1: Update glossary docs**

Add a short "Entity kind classification" paragraph to each glossary file. English text:

```md
### Entity kind classification

Parallax classifies file-backed entities through one shared path policy before writing reports or graph exports. Test naming wins first, Markdown work artifacts use their artifact-specific kind, `CODEOWNERS` is policy, GitHub workflow YAML is workflow, OpenAPI/Swagger/AsyncAPI files plus protobuf/GraphQL schemas are contracts, Dockerfile/Terraform files are resources, and package/build/config manifests are config.
```

Korean and Chinese translations should preserve the same policy without introducing new kind names.

Run: `npm run docs:lint`

Expected: PASS.

- [ ] **Step 2: Run focused and full verification**

Run:

```bash
npm test -- tests/entity_classification.test.ts tests/parallax.test.ts
npm run docs:lint
npm run lint
npm test
npm run test:dogfood
npm run bench
npm audit --audit-level=high
```

Expected: all PASS and audit reports 0 high vulnerabilities.

- [ ] **Step 3: Mark final status in this plan and commit**

After verification, append a "Final Verification Result" section with exact commands and outcomes.

```bash
git add docs/glossary.md docs/glossary.ko.md docs/glossary.zh.md plan/2026-06-18-shared-entity-classification.md
git commit -m "docs: document entity classification contract"
```

## Final Verification Result

Task 3 documented the shared entity kind classification contract in the English, Korean, and Chinese glossaries under the impact-axis `entity` definition.

Commands run:

- `npm run docs:lint` — PASS (`docs-lint: OK`)
- `npm test -- tests/entity_classification.test.ts tests/parallax.test.ts` — PASS (480 tests passed, 0 failed; the repository test script also expanded `tests/**/*.test.ts`)
- `npm run check` — PASS (`tsc -p tsconfig.json --noEmit`)
- `git diff --check -- docs/glossary.md docs/glossary.ko.md docs/glossary.zh.md plan/2026-06-18-shared-entity-classification.md` — PASS
- `npm run lint` — PASS (`npm run check` and `npm run docs:lint`)
- `npm test` — PASS (480 tests passed, 0 failed)
- `npm run test:dogfood` — PASS (2 tests passed, 0 failed)
- `npm run bench` — PASS (`passed: true`, score 0.9987, 76/76 expected relations matched)
- `npm audit --audit-level=high` — PASS (0 vulnerabilities)
