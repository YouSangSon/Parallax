import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { indexProject, initProject } from '../src/index.js';
import { databasePath } from '../src/store.js';

type RelationRow = {
  kind: string;
  sourcePath: string | null;
  targetPath: string | null;
  snippet: string | null;
  adapterId: string | null;
};

async function makeRepo(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(tmpdir(), prefix));
}

function relationRows(repoRoot: string, indexRunId: number): RelationRow[] {
  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT
           relation.kind AS kind,
           source.path AS sourcePath,
           target.path AS targetPath,
           evidence.snippet AS snippet,
           adapter_runs.adapter_id AS adapterId
         FROM relations relation
         INNER JOIN entities source ON source.id = relation.source_entity_id
         INNER JOIN entities target ON target.id = relation.target_entity_id
         LEFT JOIN relation_evidence evidence ON evidence.relation_id = relation.id
         LEFT JOIN adapter_runs ON adapter_runs.id = relation.adapter_run_id
         WHERE relation.index_run_id = ?
         ORDER BY source.path, relation.kind, target.path`
      )
      .all(indexRunId) as RelationRow[];
  } finally {
    db.close();
  }
}

test('indexProject attributes GitHub Actions Dockerfile and Terraform relations to config infra adapter', async () => {
  const repoRoot = await makeRepo('parallax-config-infra-');
  await mkdir(path.join(repoRoot, '.github/workflows'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src/ts'), { recursive: true });
  await mkdir(path.join(repoRoot, 'infra'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/ts/session.ts'), 'export const session = "ok";\n');
  await writeFile(path.join(repoRoot, 'src/ts/container.ts'), 'export const container = "ok";\n');
  await writeFile(path.join(repoRoot, 'src/ts/container-extra.ts'), 'export const containerExtra = "ok";\n');
  await writeFile(path.join(repoRoot, 'src/ts/compact-a.ts'), 'export const compactA = "ok";\n');
  await writeFile(path.join(repoRoot, 'src/ts/compact-b.ts'), 'export const compactB = "ok";\n');
  await writeFile(path.join(repoRoot, 'src/ts/multi-a.ts'), 'export const multiA = "ok";\n');
  await writeFile(path.join(repoRoot, 'src/ts/multi-b.ts'), 'export const multiB = "ok";\n');
  await writeFile(path.join(repoRoot, 'src/ts/prefix.ts'), 'export const prefix = "ok";\n');
  await writeFile(path.join(repoRoot, 'src/ts/prefix.tsx'), 'export const prefixTsx = "ok";\n');
  await writeFile(path.join(repoRoot, 'src/ts/stage-only.ts'), 'export const stageOnly = "ok";\n');
  await writeFile(
    path.join(repoRoot, '.github/workflows/ci.yml'),
    [
      'name: ci',
      'on: [push]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm test -- src/ts/session.ts',
      '      - run: npm test -- src/ts/prefix.tsx',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'Dockerfile'),
    [
      'FROM node:24',
      'COPY src/ts/session.ts /app/session.ts',
      'COPY src/ts/multi-a.ts src/ts/multi-b.ts /app/multi/',
      'COPY ["src/ts/compact-a.ts","src/ts/compact-b.ts","/app/compact/"]',
      'COPY src/ts/prefix.tsx /app/prefix.tsx',
      'COPY --from=builder src/ts/stage-only.ts /app/stage-only.ts',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'Containerfile'),
    [
      'FROM node:24',
      'ADD ["src/ts/container.ts", "src/ts/container-extra.ts", "/app/container/"]',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'infra/main.tf'),
    [
      'resource "local_file" "session_manifest" {',
      '  filename = "src/ts/session.ts"',
      '  source = "src/ts/prefix.tsx"',
      '}',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });
  const rows = relationRows(repoRoot, index.indexRunId);

  const workflowRelation = rows.find((row) =>
    row.kind === 'CONFIGURES' &&
    row.sourcePath === '.github/workflows/ci.yml' &&
    row.targetPath === 'src/ts/session.ts'
  );
  assert.ok(workflowRelation);
  assert.equal(workflowRelation.adapterId, 'config-infra-semantic-v0');
  assert.ok(workflowRelation.snippet?.includes('npm test -- src/ts/session.ts'));

  const dockerCopyDependency = rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourcePath === 'Dockerfile' &&
    row.targetPath === 'src/ts/session.ts'
  );
  assert.ok(dockerCopyDependency);
  assert.equal(dockerCopyDependency.adapterId, 'config-infra-semantic-v0');
  assert.ok(dockerCopyDependency.snippet?.includes('COPY src/ts/session.ts'));

  for (const targetPath of ['src/ts/multi-a.ts', 'src/ts/multi-b.ts']) {
    const dockerMultiSourceDependency = rows.find((row) =>
      row.kind === 'DEPENDS_ON' &&
      row.sourcePath === 'Dockerfile' &&
      row.targetPath === targetPath
    );
    assert.ok(dockerMultiSourceDependency);
    assert.equal(dockerMultiSourceDependency.adapterId, 'config-infra-semantic-v0');
  }

  for (const targetPath of ['src/ts/compact-a.ts', 'src/ts/compact-b.ts']) {
    const dockerCompactJsonDependency = rows.find((row) =>
      row.kind === 'DEPENDS_ON' &&
      row.sourcePath === 'Dockerfile' &&
      row.targetPath === targetPath
    );
    assert.ok(dockerCompactJsonDependency);
    assert.equal(dockerCompactJsonDependency.adapterId, 'config-infra-semantic-v0');
  }

  const dockerConfigRelation = rows.find((row) =>
    row.kind === 'CONFIGURES' &&
    row.sourcePath === 'Dockerfile' &&
    row.targetPath === 'src/ts/session.ts'
  );
  assert.ok(dockerConfigRelation);
  assert.equal(dockerConfigRelation.adapterId, 'config-infra-semantic-v0');

  for (const sourcePath of ['.github/workflows/ci.yml', 'Dockerfile', 'infra/main.tf']) {
    const prefixFalsePositive = rows.find((row) =>
      row.kind === 'CONFIGURES' &&
      row.sourcePath === sourcePath &&
      row.targetPath === 'src/ts/prefix.ts'
    );
    assert.equal(prefixFalsePositive, undefined);
  }

  const dockerMultistageRelation = rows.find((row) =>
    row.sourcePath === 'Dockerfile' &&
    row.targetPath === 'src/ts/stage-only.ts'
  );
  assert.equal(dockerMultistageRelation, undefined);

  const containerCopyDependency = rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourcePath === 'Containerfile' &&
    row.targetPath === 'src/ts/container.ts'
  );
  assert.ok(containerCopyDependency);
  assert.equal(containerCopyDependency.adapterId, 'config-infra-semantic-v0');
  assert.ok(containerCopyDependency.snippet?.includes('ADD ["src/ts/container.ts"'));

  const containerExtraDependency = rows.find((row) =>
    row.kind === 'DEPENDS_ON' &&
    row.sourcePath === 'Containerfile' &&
    row.targetPath === 'src/ts/container-extra.ts'
  );
  assert.ok(containerExtraDependency);
  assert.equal(containerExtraDependency.adapterId, 'config-infra-semantic-v0');

  const containerConfigRelation = rows.find((row) =>
    row.kind === 'CONFIGURES' &&
    row.sourcePath === 'Containerfile' &&
    row.targetPath === 'src/ts/container.ts'
  );
  assert.ok(containerConfigRelation);
  assert.equal(containerConfigRelation.adapterId, 'config-infra-semantic-v0');

  const terraformRelation = rows.find((row) =>
    row.kind === 'CONFIGURES' &&
    row.sourcePath === 'infra/main.tf' &&
    row.targetPath === 'src/ts/session.ts'
  );
  assert.ok(terraformRelation);
  assert.equal(terraformRelation.adapterId, 'config-infra-semantic-v0');
  assert.ok(terraformRelation.snippet?.includes('filename = "src/ts/session.ts"'));
});
