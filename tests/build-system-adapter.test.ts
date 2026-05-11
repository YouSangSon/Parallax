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
  sourceKind: string;
  sourcePath: string | null;
  sourceLanguage: string | null;
  sourceName: string;
  targetKind: string;
  targetPath: string | null;
  targetLanguage: string | null;
  targetName: string;
  snippet: string | null;
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
           source.kind AS sourceKind,
           source.path AS sourcePath,
           source.language_id AS sourceLanguage,
           source.display_name AS sourceName,
           target.kind AS targetKind,
           target.path AS targetPath,
           target.language_id AS targetLanguage,
           target.display_name AS targetName,
           evidence.snippet AS snippet
         FROM relations relation
         INNER JOIN entities source ON source.id = relation.source_entity_id
         INNER JOIN entities target ON target.id = relation.target_entity_id
         LEFT JOIN relation_evidence evidence ON evidence.relation_id = relation.id
         WHERE relation.index_run_id = ?
         ORDER BY relation.kind, source.display_name, target.display_name`
      )
      .all(indexRunId) as RelationRow[];
  } finally {
    db.close();
  }
}

test('indexProject extracts npm workspace package graph', async () => {
  const repoRoot = await makeRepo('impact-trace-build-npm-');
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
  const repoRoot = await makeRepo('impact-trace-build-polyglot-');
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

test('indexProject reports malformed build manifests without failing the index run', async () => {
  const repoRoot = await makeRepo('impact-trace-build-malformed-');
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
