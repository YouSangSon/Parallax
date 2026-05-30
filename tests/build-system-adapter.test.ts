import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { analyzeDiff, indexProject, initProject } from '../src/index.js';
import { databasePath } from '../src/store.js';

type RelationRow = {
  kind: string;
  confidence: string;
  sourceKind: string;
  sourcePath: string | null;
  sourceLanguage: string | null;
  sourceName: string;
  targetKind: string;
  targetPath: string | null;
  targetLanguage: string | null;
  targetName: string;
  targetLocationJson: string | null;
  snippet: string | null;
  startLine: number | null;
  startCol: number | null;
};

async function makeRepo(prefix: string): Promise<string> {
  return await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(tmpdir(), prefix)));
}

function relationRows(repoRoot: string, indexRunId: number): RelationRow[] {
  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT
           relation.kind AS kind,
           relation.confidence AS confidence,
           source.kind AS sourceKind,
           source.path AS sourcePath,
           source.language_id AS sourceLanguage,
           source.display_name AS sourceName,
           target.kind AS targetKind,
           target.path AS targetPath,
           target.language_id AS targetLanguage,
           target.display_name AS targetName,
           target_version.location_json AS targetLocationJson,
           evidence.snippet AS snippet,
           evidence.start_line AS startLine,
           evidence.start_col AS startCol
         FROM relations relation
         INNER JOIN entities source ON source.id = relation.source_entity_id
         INNER JOIN entities target ON target.id = relation.target_entity_id
         LEFT JOIN entity_versions target_version
           ON target_version.entity_id = target.id
          AND target_version.index_run_id = relation.index_run_id
         LEFT JOIN relation_evidence evidence ON evidence.relation_id = relation.id
         WHERE relation.index_run_id = ?
         ORDER BY relation.kind, source.display_name, target.display_name`
      )
      .all(indexRunId) as RelationRow[];
  } finally {
    db.close();
  }
}

function targetMetadata(row: RelationRow): Readonly<Record<string, unknown>> {
  if (!row.targetLocationJson) return {};
  const parsed = JSON.parse(row.targetLocationJson) as { metadata?: Readonly<Record<string, unknown>> };
  return parsed.metadata ?? {};
}

test('indexProject extracts npm workspace package graph', async () => {
  const repoRoot = await makeRepo('parallax-build-npm-');
  await mkdir(path.join(repoRoot, 'apps/web'), { recursive: true });
  await mkdir(path.join(repoRoot, 'packages/core'), { recursive: true });
  await mkdir(path.join(repoRoot, 'packages/core/src'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({
      name: '@acme/platform',
      private: true,
      workspaces: ['apps/*', 'packages/*'],
      scripts: {
        'check:core': 'tsc --noEmit packages/core/src/index.ts',
        'check:app': 'tsc --noEmit src/app.tsx'
      }
    }, null, 2)
  );
  await writeFile(
    path.join(repoRoot, 'apps/web/package.json'),
    JSON.stringify({
      name: '@acme/web',
      version: '1.0.0',
      dependencies: {
        '@acme/core': 'workspace:*',
        react: '^18.2.0'
      },
      devDependencies: {
        vitest: '^1.5.0'
      }
    }, null, 2)
  );
  await writeFile(path.join(repoRoot, 'packages/core/src/index.ts'), 'export const core = true;\n');
  await writeFile(path.join(repoRoot, 'src/app.ts'), 'export const app = false;\n');
  await writeFile(path.join(repoRoot, 'src/app.tsx'), 'export const app = true;\n');
  await writeFile(
    path.join(repoRoot, 'packages/core/package.json'),
    JSON.stringify({
      name: '@acme/core',
      version: '1.0.0'
    }, null, 2)
  );

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const rows = relationRows(repoRoot, index.indexRunId);
  assert.ok(rows.some((row) =>
    row.kind === 'DECLARES' &&
    row.sourceKind === 'config' &&
    row.sourcePath === 'apps/web/package.json' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'npm' &&
    row.targetName === '@acme/web'
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceKind === 'package' &&
    row.sourceName === '@acme/web' &&
    row.targetKind === 'package' &&
    row.targetName === '@acme/core' &&
    row.snippet?.includes('"@acme/core": "workspace:*"')
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === '@acme/web' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'npm' &&
    row.targetName === 'react' &&
    row.snippet?.includes('"react": "^18.2.0"')
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === '@acme/web' &&
    row.targetKind === 'package' &&
    row.targetName === 'vitest' &&
    row.snippet?.includes('"vitest": "^1.5.0"')
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'CONFIGURES' &&
    row.sourcePath === 'package.json' &&
    row.targetKind === 'file' &&
    row.targetPath === 'packages/core/src/index.ts' &&
    row.snippet?.includes('packages/core/src/index.ts')
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'CONFIGURES' &&
    row.sourcePath === 'package.json' &&
    row.targetKind === 'file' &&
    row.targetPath === 'src/app.tsx' &&
    row.snippet?.includes('src/app.tsx')
  ));
  assert.equal(
    rows.some((row) =>
      row.kind === 'CONFIGURES' &&
      row.sourcePath === 'package.json' &&
      row.targetKind === 'file' &&
      row.targetPath === 'src/app.ts'
    ),
    false
  );
  assert.ok(index.adaptersUsed?.some((adapter) => adapter.id === 'build-system-package-resolver-v0'));

  const report = await analyzeDiff({
    repoRoot,
    changedFiles: ['packages/core/package.json'],
    maxDepth: 3
  });
  assert.ok(report.affectedFiles.some((file) => file.path === 'apps/web/package.json'));
});

test('indexProject extracts Maven Gradle Go Cargo and pyproject dependencies', async () => {
  const repoRoot = await makeRepo('parallax-build-polyglot-');
  await mkdir(path.join(repoRoot, 'service'), { recursive: true });
  await mkdir(path.join(repoRoot, 'app'), { recursive: true });
  await mkdir(path.join(repoRoot, 'core'), { recursive: true });
  await mkdir(path.join(repoRoot, 'crates/api'), { recursive: true });

  await writeFile(
    path.join(repoRoot, 'service/pom.xml'),
    [
      '<project>',
      '  <modelVersion>4.0.0</modelVersion>',
      '  <groupId>com.acme</groupId>',
      '  <artifactId>users-service</artifactId>',
      '  <version>1.0.0</version>',
      '  <dependencies>',
      '    <dependency>',
      '      <groupId>org.springframework.boot</groupId>',
      '      <artifactId>spring-boot-starter-web</artifactId>',
      '      <version>3.2.0</version>',
      '    </dependency>',
      '  </dependencies>',
      '</project>',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'settings.gradle'),
    [
      "rootProject.name = 'platform'",
      "include ':app', ':core'",
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'app/build.gradle'),
    [
      'plugins { id "java" }',
      'dependencies {',
      "  implementation project(':core')",
      "  implementation 'org.springframework.boot:spring-boot-starter-web:3.2.0'",
      '}',
      ''
    ].join('\n')
  );
  await writeFile(path.join(repoRoot, 'core/build.gradle'), 'plugins { id "java-library" }\n');
  await writeFile(
    path.join(repoRoot, 'go.mod'),
    [
      'module example.com/platform',
      '',
      'go 1.22',
      '',
      'require (',
      '  github.com/gin-gonic/gin v1.9.1',
      ')',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'crates/api/Cargo.toml'),
    [
      '[package]',
      'name = "api"',
      'version = "0.1.0"',
      'edition = "2021"',
      '',
      '[[bin]]',
      'name = "api-cli"',
      'path = "src/main.rs"',
      '',
      '[dependencies]',
      'serde = "1"',
      'tokio = { version = "1", features = ["rt"] }',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'pyproject.toml'),
    [
      '[project]',
      'name = "impact-api"',
      'version = "0.1.0"',
      'dependencies = [',
      '  "fastapi>=0.110",',
      '  "pydantic>=2",',
      ']',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const rows = relationRows(repoRoot, index.indexRunId);
  assert.ok(rows.some((row) =>
    row.kind === 'DECLARES' &&
    row.sourceKind === 'config' &&
    row.sourcePath === 'service/pom.xml' &&
    row.targetKind === 'package' &&
    row.targetName === 'com.acme:users-service'
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'DECLARES' &&
    row.sourceKind === 'config' &&
    row.sourcePath === 'app/build.gradle' &&
    row.targetKind === 'package' &&
    row.targetName === ':app'
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'DECLARES' &&
    row.sourceKind === 'config' &&
    row.sourcePath === 'go.mod' &&
    row.targetKind === 'package' &&
    row.targetName === 'example.com/platform'
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'DECLARES' &&
    row.sourceKind === 'config' &&
    row.sourcePath === 'crates/api/Cargo.toml' &&
    row.targetKind === 'package' &&
    row.targetName === 'api'
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'DECLARES' &&
    row.sourceKind === 'config' &&
    row.sourcePath === 'pyproject.toml' &&
    row.targetKind === 'package' &&
    row.targetName === 'impact-api'
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === 'com.acme:users-service' &&
    row.targetName === 'org.springframework.boot:spring-boot-starter-web' &&
    row.targetLanguage === 'maven'
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === ':app' &&
    row.targetKind === 'package' &&
    row.targetName === ':core' &&
    row.targetLanguage === 'gradle'
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === ':app' &&
    row.targetKind === 'package' &&
    row.targetName === 'org.springframework.boot:spring-boot-starter-web' &&
    row.targetLanguage === 'gradle'
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === 'example.com/platform' &&
    row.targetName === 'github.com/gin-gonic/gin' &&
    row.targetLanguage === 'go'
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === 'api' &&
    row.targetName === 'serde' &&
    row.targetLanguage === 'cargo'
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === 'impact-api' &&
    row.targetName === 'fastapi' &&
    row.targetLanguage === 'python'
  ));
});

test('indexProject extracts pyproject optional and dependency group dependencies', async () => {
  const repoRoot = await makeRepo('parallax-build-python-groups-');

  await writeFile(
    path.join(repoRoot, 'pyproject.toml'),
    [
      '[project]',
      'name = "impact-api"',
      'version = "0.1.0"',
      'dependencies = [',
      '  "FastAPI>=0.110",',
      ']',
      '',
      '[project.optional-dependencies]',
      'dev = [',
      '  "PyTest>=8",',
      '  "ruff>=0.5",',
      ']',
      'data = ["pandas>=2"]',
      '',
      '[dependency-groups]',
      'lint = [',
      '  "mypy>=1.10",',
      '  { include-group = "test" },',
      ']',
      'test = ["pytest-cov>=5"]',
      '',
      '[tool.poetry.group.docs.dependencies]',
      'mkdocs = "^1.6"',
      'mkdocs-material = { version = "^9.5" }',
      'python = ">=3.12"',
      '',
      '[tool.poetry.group.dev.dependencies]',
      'ipython = "^8"',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const rows = relationRows(repoRoot, index.indexRunId);
  const dependency = (targetName: string, dependencyType: string) => rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === 'impact-api' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'python' &&
    row.targetName === targetName &&
    targetMetadata(row).dependencyType === dependencyType
  );

  assert.ok(dependency('fastapi', 'dependencies')?.snippet?.includes('"FastAPI>=0.110"'));
  assert.ok(dependency('pytest', 'optional-dependencies:dev')?.snippet?.includes('"PyTest>=8"'));
  assert.ok(dependency('ruff', 'optional-dependencies:dev')?.snippet?.includes('"ruff>=0.5"'));
  assert.ok(dependency('pandas', 'optional-dependencies:data')?.snippet?.includes('data = ["pandas>=2"]'));
  assert.ok(dependency('mypy', 'dependency-groups:lint')?.snippet?.includes('"mypy>=1.10"'));
  assert.ok(dependency('pytest-cov', 'dependency-groups:test')?.snippet?.includes('test = ["pytest-cov>=5"]'));
  assert.ok(dependency('mkdocs', 'poetry-group:docs')?.snippet?.includes('mkdocs = "^1.6"'));
  assert.ok(dependency('mkdocs-material', 'poetry-group:docs')?.snippet?.includes('mkdocs-material'));
  assert.ok(dependency('ipython', 'poetry-group:dev')?.snippet?.includes('ipython = "^8"'));
  assert.deepEqual(
    rows
      .filter((row) =>
        row.kind === 'DEPENDS_ON' &&
        row.sourceName === 'impact-api' &&
        row.targetKind === 'package' &&
        row.targetLanguage === 'python' &&
        targetMetadata(row).dependencyType === 'dependency-groups:lint'
      )
      .map((row) => row.targetName)
      .sort(),
    ['mypy']
  );
  assert.equal(
    rows.some((row) =>
      row.kind === 'DEPENDS_ON' &&
      row.sourceName === 'impact-api' &&
      (row.targetName === 'include-group' || row.targetName === 'python')
    ),
    false
  );
});

test('indexProject extracts Poetry group dependencies from tool.poetry projects', async () => {
  const repoRoot = await makeRepo('parallax-build-poetry-groups-');

  await writeFile(
    path.join(repoRoot, 'pyproject.toml'),
    [
      '[tool.poetry]',
      'name = "legacy-api"',
      'version = "0.2.0"',
      '',
      '[tool.poetry.group.docs.dependencies]',
      'mkdocs = "^1.6"',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const rows = relationRows(repoRoot, index.indexRunId);
  assert.ok(rows.some((row) =>
    row.kind === 'DECLARES' &&
    row.sourcePath === 'pyproject.toml' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'python' &&
    row.targetName === 'legacy-api'
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === 'legacy-api' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'python' &&
    row.targetName === 'mkdocs' &&
    targetMetadata(row).dependencyType === 'poetry-group:docs' &&
    row.snippet?.includes('mkdocs = "^1.6"')
  ));
});

test('indexProject resolves Cargo workspace members and local path dependencies', async () => {
  const repoRoot = await makeRepo('parallax-build-cargo-workspace-');
  await mkdir(path.join(repoRoot, 'crates/api'), { recursive: true });
  await mkdir(path.join(repoRoot, 'crates/core'), { recursive: true });
  await mkdir(path.join(repoRoot, 'crates/support'), { recursive: true });
  await mkdir(path.join(repoRoot, 'tools/xtask'), { recursive: true });
  await mkdir(path.join(repoRoot, 'outside/helper'), { recursive: true });

  await writeFile(
    path.join(repoRoot, 'Cargo.toml'),
    [
      '[workspace]',
      'members = [',
      '  "crates/*",',
      '  "tools/xtask",',
      ']',
      '',
      '[workspace.dependencies]',
      'core-lib = { path = "crates/core", version = "0.1.0" }',
      'serde = "1"',
      'anyhow = { version = "1" }',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'crates/api/Cargo.toml'),
    [
      '[package]',
      'name = "api"',
      'version = "0.1.0"',
      'edition = "2021"',
      '',
      '[dependencies]',
      'core-lib = { workspace = true }',
      'api-support = { path = "../support", version = "0.1.0" }',
      'serde = { workspace = true, features = ["derive"] }',
      'outside-helper = { path = "../../outside/helper" }',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'crates/core/Cargo.toml'),
    [
      '[package]',
      'name = "core-lib"',
      'version = "0.1.0"',
      'edition = "2021"',
      '',
      '[dev-dependencies]',
      'anyhow.workspace = true',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'crates/support/Cargo.toml'),
    [
      '[package]',
      'name = "api-support"',
      'version = "0.1.0"',
      'edition = "2021"',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'tools/xtask/Cargo.toml'),
    [
      '[package]',
      'name = "xtask"',
      'version = "0.1.0"',
      'edition = "2021"',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'outside/helper/Cargo.toml'),
    [
      '[package]',
      'name = "outside-helper"',
      'version = "0.1.0"',
      'edition = "2021"',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const rows = relationRows(repoRoot, index.indexRunId);
  assert.ok(rows.some((row) =>
    row.kind === 'CONFIGURES' &&
    row.sourcePath === 'Cargo.toml' &&
    row.targetKind === 'config' &&
    row.targetPath === 'crates/api/Cargo.toml' &&
    row.snippet?.includes('"crates/*"')
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'CONFIGURES' &&
    row.sourcePath === 'Cargo.toml' &&
    row.targetKind === 'config' &&
    row.targetPath === 'crates/core/Cargo.toml' &&
    row.snippet?.includes('"crates/*"')
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'CONFIGURES' &&
    row.sourcePath === 'Cargo.toml' &&
    row.targetKind === 'config' &&
    row.targetPath === 'tools/xtask/Cargo.toml' &&
    row.snippet?.includes('"tools/xtask"')
  ));
  const localPathDependency = rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === 'api' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'cargo' &&
    row.targetName === 'api-support'
  );
  assert.ok(localPathDependency);
  assert.equal(localPathDependency.confidence, 'proven');
  assert.equal(localPathDependency.targetPath, 'crates/support/Cargo.toml');
  assert.ok(localPathDependency.snippet?.includes('api-support = { path = "../support"'));
  const workspacePathDependency = rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === 'api' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'cargo' &&
    row.targetName === 'core-lib'
  );
  assert.ok(workspacePathDependency);
  assert.equal(workspacePathDependency.confidence, 'proven');
  assert.equal(workspacePathDependency.targetPath, 'crates/core/Cargo.toml');
  assert.equal(targetMetadata(workspacePathDependency).version, '0.1.0');
  assert.ok(workspacePathDependency.snippet?.includes('core-lib = { workspace = true'));
  const outsidePathDependency = rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === 'api' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'cargo' &&
    row.targetName === 'outside-helper'
  );
  assert.ok(outsidePathDependency);
  assert.equal(outsidePathDependency.targetPath, 'outside/helper/Cargo.toml');
  assert.ok(outsidePathDependency.snippet?.includes('outside-helper = { path = "../../outside/helper"'));
  const workspaceDependency = rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === 'api' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'cargo' &&
    row.targetName === 'serde'
  );
  assert.ok(workspaceDependency);
  assert.equal(workspaceDependency.targetPath, null);
  assert.equal(targetMetadata(workspaceDependency).version, '1');
  assert.ok(workspaceDependency.snippet?.includes('serde = { workspace = true'));
  const workspaceInlineDependency = rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === 'core-lib' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'cargo' &&
    row.targetName === 'anyhow'
  );
  assert.ok(workspaceInlineDependency);
  assert.equal(targetMetadata(workspaceInlineDependency).version, '1');
  assert.ok(workspaceInlineDependency.snippet?.includes('anyhow.workspace = true'));
});

test('indexProject resolves Go workspace use directories and local replace modules', async () => {
  const repoRoot = await makeRepo('parallax-build-go-work-replace-');
  await mkdir(path.join(repoRoot, 'apps/api'), { recursive: true });
  await mkdir(path.join(repoRoot, 'apps/other'), { recursive: true });
  await mkdir(path.join(repoRoot, 'libs/shared'), { recursive: true });

  await writeFile(
    path.join(repoRoot, 'go.work'),
    [
      'go 1.22',
      '',
      '// apps/api/go.mod is mentioned before the directive but must not become evidence',
      'use (',
      '  ./apps/api',
      '  ./libs/shared',
      ')',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'apps/api/go.mod'),
    [
      'module example.com/api',
      '',
      'go 1.22',
      '',
      'require github.com/acme/shared v0.0.0',
      '',
      'replace github.com/acme/shared => ../../libs/shared',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'libs/shared/go.mod'),
    [
      'module example.com/internal/shared',
      '',
      'go 1.22',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'apps/other/go.mod'),
    [
      'module example.com/other',
      '',
      'go 1.22',
      '',
      'require github.com/acme/shared v0.0.0',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const rows = relationRows(repoRoot, index.indexRunId);
  assert.ok(rows.some((row) =>
    row.kind === 'CONFIGURES' &&
    row.sourcePath === 'go.work' &&
    row.targetKind === 'config' &&
    row.targetPath === 'apps/api/go.mod' &&
    row.snippet?.includes('./apps/api')
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'CONFIGURES' &&
    row.sourcePath === 'go.work' &&
    row.targetKind === 'config' &&
    row.targetPath === 'libs/shared/go.mod' &&
    row.snippet?.includes('./libs/shared')
  ));
  const localReplaceDependency = rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === 'example.com/api' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'go' &&
    row.targetName === 'example.com/internal/shared'
  );
  assert.ok(localReplaceDependency);
  assert.equal(localReplaceDependency.targetPath, 'libs/shared/go.mod');
  assert.ok(localReplaceDependency.snippet?.includes('require github.com/acme/shared v0.0.0'));
  assert.equal(
    rows.some((row) =>
      row.kind === 'DEPENDS_ON' &&
      row.sourceName === 'example.com/api' &&
      row.targetKind === 'package' &&
      row.targetLanguage === 'go' &&
      row.targetName === 'github.com/acme/shared'
    ),
    false
  );
  const unreplacedDependency = rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === 'example.com/other' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'go' &&
    row.targetName === 'github.com/acme/shared'
  );
  assert.ok(unreplacedDependency);
  assert.equal(unreplacedDependency.targetPath, null);
  assert.equal(
    rows.some((row) =>
      row.kind === 'DEPENDS_ON' &&
      row.sourceName === 'example.com/other' &&
      row.targetKind === 'package' &&
      row.targetLanguage === 'go' &&
      row.targetName === 'example.com/internal/shared'
    ),
    false
  );
});

test('indexProject resolves Maven POM properties in package and dependency coordinates', async () => {
  const repoRoot = await makeRepo('parallax-build-maven-properties-');
  await mkdir(path.join(repoRoot, 'service'), { recursive: true });

  await writeFile(
    path.join(repoRoot, 'service/pom.xml'),
    [
      '<project>',
      '  <modelVersion>4.0.0</modelVersion>',
      '  <parent>',
      '    <groupId>com.parent</groupId>',
      '    <artifactId>platform-parent</artifactId>',
      '    <version>${revision}</version>',
      '  </parent>',
      '  <properties>',
      '    <company.group>com.acme</company.group>',
      '    <revision>1.2.3</revision>',
      '    <spring.boot.version>3.2.0</spring.boot.version>',
      '    <internal.artifact>shared-api</internal.artifact>',
      '  </properties>',
      '  <build>',
      '    <plugins>',
      '      <plugin>',
      '        <groupId>org.apache.maven.plugins</groupId>',
      '        <artifactId>maven-checkstyle-plugin</artifactId>',
      '        <dependencies>',
      '          <dependency>',
      '            <groupId>com.false</groupId>',
      '            <artifactId>plugin-helper</artifactId>',
      '            <version>1.0.0</version>',
      '          </dependency>',
      '        </dependencies>',
      '      </plugin>',
      '    </plugins>',
      '  </build>',
      '  <!-- dependency declarations below must keep evidence offsets stable -->',
      '  <groupId>${company.group}</groupId>',
      '  <artifactId>orders-service</artifactId>',
      '  <version>${revision}</version>',
      '  <dependencies>',
      '    <dependency>',
      '      <groupId>${project.groupId}</groupId>',
      '      <artifactId>${internal.artifact}</artifactId>',
      '      <version>${project.version}</version>',
      '    </dependency>',
      '    <dependency>',
      '      <groupId>${project.parent.groupId}</groupId>',
      '      <artifactId>parent-managed</artifactId>',
      '      <version>${project.parent.version}</version>',
      '    </dependency>',
      '    <dependency>',
      '      <groupId>org.springframework.boot</groupId>',
      '      <artifactId>spring-boot-starter-web</artifactId>',
      '      <version>${spring.boot.version}</version>',
      '    </dependency>',
      '  </dependencies>',
      '  <profiles>',
      '    <profile>',
      '      <id>inactive</id>',
      '      <properties>',
      '        <company.group>com.false</company.group>',
      '        <profile.dep.version>9.9.9</profile.dep.version>',
      '      </properties>',
      '      <dependencies>',
      '        <dependency>',
      '          <groupId>com.false</groupId>',
      '          <artifactId>profile-only</artifactId>',
      '          <version>${profile.dep.version}</version>',
      '        </dependency>',
      '      </dependencies>',
      '    </profile>',
      '  </profiles>',
      '</project>',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const rows = relationRows(repoRoot, index.indexRunId);
  const declaredPackage = rows.find((row) =>
    row.kind === 'DECLARES' &&
    row.sourcePath === 'service/pom.xml' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'maven' &&
    row.targetName === 'com.acme:orders-service'
  );
  assert.ok(declaredPackage);
  assert.equal(targetMetadata(declaredPackage).version, '1.2.3');
  const internalDependency = rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === 'com.acme:orders-service' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'maven' &&
    row.targetName === 'com.acme:shared-api'
  );
  assert.ok(internalDependency);
  assert.equal(targetMetadata(internalDependency).version, '1.2.3');
  assert.ok(internalDependency.snippet?.includes('<dependency>'));
  assert.equal(internalDependency.startLine, 34);
  assert.equal(internalDependency.startCol, 1);
  const parentDependency = rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === 'com.acme:orders-service' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'maven' &&
    row.targetName === 'com.parent:parent-managed'
  );
  assert.ok(parentDependency);
  assert.equal(targetMetadata(parentDependency).version, '1.2.3');
  assert.ok(parentDependency.snippet?.includes('<dependency>'));
  assert.equal(parentDependency.startLine, 39);
  assert.equal(parentDependency.startCol, 1);
  const springDependency = rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === 'com.acme:orders-service' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'maven' &&
    row.targetName === 'org.springframework.boot:spring-boot-starter-web'
  );
  assert.ok(springDependency);
  assert.equal(targetMetadata(springDependency).version, '3.2.0');
  assert.ok(springDependency.snippet?.includes('<dependency>'));
  assert.equal(springDependency.startLine, 44);
  assert.equal(springDependency.startCol, 1);
  assert.equal(
    rows.some((row) => row.kind === 'DEPENDS_ON' && row.targetName.includes('${')),
    false
  );
  assert.equal(
    rows.some((row) =>
      row.kind === 'DEPENDS_ON' &&
      row.sourceName === 'com.acme:orders-service' &&
      (row.targetName === 'com.false:profile-only' ||
        row.targetName === 'com.false:plugin-helper')
    ),
    false
  );
});

test('indexProject resolves Gradle version catalog library and bundle aliases', async () => {
  const repoRoot = await makeRepo('parallax-build-gradle-catalog-');
  await mkdir(path.join(repoRoot, 'app'), { recursive: true });
  await mkdir(path.join(repoRoot, 'gradle'), { recursive: true });
  await mkdir(path.join(repoRoot, 'services/orders/gradle'), { recursive: true });

  await writeFile(
    path.join(repoRoot, 'gradle/libs.versions.toml'),
    [
      '[versions]',
      'springBoot = "3.2.0"',
      'jackson = "2.16.0"',
      'acme = "1.1.0"',
      '',
      '[libraries]',
      'spring-boot-starter-web = { module = "org.springframework.boot:spring-boot-starter-web", version.ref = "springBoot" }',
      'spring-boot-dependencies = { module = "org.springframework.boot:spring-boot-dependencies", version.ref = "springBoot" }',
      'jackson-kotlin = { group = "com.fasterxml.jackson.module", name = "jackson-module-kotlin", version.ref = "jackson" }',
      'acme-bom = { group = "com.acme", name = "platform-bom", version.ref = "acme" }',
      'junit-jupiter = "org.junit.jupiter:junit-jupiter:5.10.1"',
      'shared-lib = "com.root:shared-lib:1.0.0"',
      'comment-only = "com.false:comment-only:1.0.0"',
      'block-only = "com.false:block-only:1.0.0"',
      'string-only = "com.false:string-only:1.0.0"',
      '',
      '[bundles]',
      'web = ["spring-boot-starter-web", "jackson-kotlin"]',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'settings.gradle.kts'),
    [
      'rootProject.name = "platform"',
      'include(":app")',
      'includeBuild("services/orders")',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'app/build.gradle.kts'),
    [
      'plugins { java }',
      'dependencies {',
      '  implementation(libs.spring.boot.starter.web)',
      '  implementation(platform(libs.spring.boot.dependencies))',
      '  api(enforcedPlatform(libs.acme.bom))',
      '  implementation(libs.bundles.web)',
      '  testImplementation(libs.junit.jupiter)',
      '  runtimeOnly(libs.shared.lib)',
      '  // runtimeOnly(libs.comment.only)',
      '  /* runtimeOnly(libs.block.only) */',
      '  implementation("libs.string.only")',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'services/orders/gradle/libs.versions.toml'),
    [
      '[libraries]',
      'shared-lib = "com.orders:shared-lib:2.0.0"',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'services/orders/build.gradle.kts'),
    [
      'plugins { java }',
      'dependencies {',
      '  runtimeOnly(libs.shared.lib)',
      '}',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const rows = relationRows(repoRoot, index.indexRunId);
  assert.ok(rows.some((row) =>
    row.kind === 'DECLARES' &&
    row.sourceKind === 'config' &&
    row.sourcePath === 'app/build.gradle.kts' &&
    row.targetKind === 'package' &&
    row.targetName === ':app'
  ));
  const springWebDependency = rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === ':app' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'gradle' &&
    row.targetName === 'org.springframework.boot:spring-boot-starter-web' &&
    row.snippet?.includes('implementation(libs.spring.boot.starter.web)')
  );
  assert.ok(springWebDependency);
  assert.equal(targetMetadata(springWebDependency).version, '3.2.0');
  const springBomDependency = rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === ':app' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'gradle' &&
    row.targetName === 'org.springframework.boot:spring-boot-dependencies' &&
    row.snippet?.includes('implementation(platform(libs.spring.boot.dependencies))')
  );
  assert.ok(springBomDependency);
  assert.equal(targetMetadata(springBomDependency).version, '3.2.0');
  const acmeBomDependency = rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === ':app' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'gradle' &&
    row.targetName === 'com.acme:platform-bom' &&
    row.snippet?.includes('api(enforcedPlatform(libs.acme.bom))')
  );
  assert.ok(acmeBomDependency);
  assert.equal(targetMetadata(acmeBomDependency).version, '1.1.0');
  assert.ok(rows.some((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === ':app' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'gradle' &&
    row.targetName === 'com.fasterxml.jackson.module:jackson-module-kotlin' &&
    row.snippet?.includes('implementation(libs.bundles.web)')
  ));
  const junitDependency = rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === ':app' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'gradle' &&
    row.targetName === 'org.junit.jupiter:junit-jupiter' &&
    row.snippet?.includes('testImplementation(libs.junit.jupiter)')
  );
  assert.ok(junitDependency);
  assert.equal(targetMetadata(junitDependency).version, '5.10.1');
  assert.ok(rows.some((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === ':app' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'gradle' &&
    row.targetName === 'com.root:shared-lib' &&
    row.snippet?.includes('runtimeOnly(libs.shared.lib)')
  ));
  assert.ok(rows.some((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourceName === ':services:orders' &&
    row.targetKind === 'package' &&
    row.targetLanguage === 'gradle' &&
    row.targetName === 'com.orders:shared-lib' &&
    row.snippet?.includes('runtimeOnly(libs.shared.lib)')
  ));
  assert.equal(
    rows.some((row) =>
      row.kind === 'DEPENDS_ON' &&
      row.sourceName === ':services:orders' &&
      row.targetName === 'com.root:shared-lib'
    ),
    false
  );
  assert.equal(
    rows.some((row) =>
      row.kind === 'DEPENDS_ON' &&
      row.sourceName === ':app' &&
      (row.targetName === 'com.false:comment-only' ||
        row.targetName === 'com.false:block-only' ||
        row.targetName === 'com.false:string-only')
    ),
    false
  );
  assert.equal(
    rows.some((row) =>
      row.kind === 'DEPENDS_ON' &&
      row.sourceName === ':app' &&
      row.targetName.startsWith('libs.')
    ),
    false
  );
});

test('indexProject reports malformed build manifests without failing the index run', async () => {
  const repoRoot = await makeRepo('parallax-build-malformed-');
  await mkdir(path.join(repoRoot, 'service'), { recursive: true });
  await mkdir(path.join(repoRoot, 'app'), { recursive: true });
  await mkdir(path.join(repoRoot, 'crates/api'), { recursive: true });
  await writeFile(path.join(repoRoot, 'package.json'), '{ "name": ');
  await writeFile(path.join(repoRoot, 'service/pom.xml'), '<project><artifactId>broken</artifactId>\n');
  await writeFile(
    path.join(repoRoot, 'app/build.gradle'),
    [
      'plugins { id "java" }',
      'dependencies {',
      "  implementation project(':core')",
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'go.mod'),
    [
      'module example.com/broken',
      'require (',
      '  github.com/acme/lib v1.0.0',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'crates/api/Cargo.toml'),
    [
      '[package]',
      'name = "api',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'pyproject.toml'),
    [
      '[project]',
      'name = "impact-api',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const run = db
      .prepare('SELECT status FROM index_runs WHERE id = ?')
      .get(index.indexRunId) as { status: string };
    const diagnostics = db
      .prepare(
        `SELECT path, reason
         FROM index_coverage
         WHERE index_run_id = ?
           AND path LIKE 'package.json#diagnostic:warn:%'
           AND status = 'skipped'`
      )
      .all(index.indexRunId) as Array<{ path: string; reason: string }>;
    const allDiagnostics = db
      .prepare(
        `SELECT path, reason
         FROM index_coverage
         WHERE index_run_id = ?
           AND path LIKE '%#diagnostic:warn:%'
           AND status = 'skipped'
         ORDER BY path`
      )
      .all(index.indexRunId) as Array<{ path: string; reason: string }>;
    const diagnosticReasons = allDiagnostics.map((diagnostic) => diagnostic.reason).join('\n');
    assert.equal(run.status, 'completed');
    assert.equal(diagnostics.length, 1);
    assert.match(diagnosticReasons, /package\.json parse failed/);
    assert.match(diagnosticReasons, /pom\.xml parse failed/);
    assert.match(diagnosticReasons, /build\.gradle parse failed/);
    assert.match(diagnosticReasons, /go\.mod parse failed/);
    assert.match(diagnosticReasons, /Cargo\.toml parse failed/);
    assert.match(diagnosticReasons, /pyproject\.toml parse failed/);
  } finally {
    db.close();
  }
});
