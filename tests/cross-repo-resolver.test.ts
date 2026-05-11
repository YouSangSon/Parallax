import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, symlink, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  addWorkspaceRepo,
  indexProject,
  initProject,
  initWorkspace,
  resolveCrossRepoContracts
} from '../src/index.js';
import { databasePath } from '../src/store.js';

const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve('tsx');

async function makeRepo(prefix: string): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'README.md'), `${prefix}\n`);
  return repoRoot;
}

function runCli(repoRoot: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', tsxLoaderPath, path.resolve('src/cli.ts'), ...args],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('resolveCrossRepoContracts links workspace consumer files to provider OpenAPI endpoints', async () => {
  const consumerRoot = await makeRepo('impact-trace-consumer-');
  const providerRoot = await makeRepo('impact-trace-provider-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/client.ts'),
    [
      'export async function loadUsers() {',
      '  return fetch("https://users.example.test/api/users");',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'info:',
      '  title: Users API',
      '  version: 1.0.0',
      'paths:',
      '  /api/users:',
      '    get:',
      '      operationId: listUsers',
      '      responses:',
      "        '200':",
      '          description: ok',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });
  initWorkspace({ repoRoot: consumerRoot, name: 'platform', serviceName: 'web' });
  addWorkspaceRepo({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    localPath: providerRoot,
    serviceName: 'users-api'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.workspace.name, 'platform');
  assert.equal(result.links.length, 1);
  assert.deepEqual(result.links[0], {
    kind: 'CONSUMES_HTTP_ENDPOINT',
    confidence: 'heuristic',
    consumerService: 'web',
    consumerRepoPath: consumerReal,
    consumerPath: 'src/client.ts',
    providerService: 'users-api',
    providerRepoPath: providerReal,
    providerContractPath: 'contracts/openapi.yaml',
    providerEndpointId: 'endpoint:yaml:GET /api/users',
    httpMethod: 'GET',
    routePath: '/api/users'
  });

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT kind, confidence, provenance
         FROM cross_repo_links`
      )
      .get() as { kind: string; confidence: string; provenance: string };
    assert.equal(row.kind, 'CONSUMES_HTTP_ENDPOINT');
    assert.equal(row.confidence, 'heuristic');
    assert.deepEqual(JSON.parse(row.provenance), {
      schemaVersion: 1,
      resolver: 'cross-repo-contracts-v0',
      consumer: {
        serviceName: 'web',
        repoPath: consumerReal,
        path: 'src/client.ts'
      },
      provider: {
        serviceName: 'users-api',
        repoPath: providerReal,
        contractPath: 'contracts/openapi.yaml',
        endpointId: 'endpoint:yaml:GET /api/users'
      },
      http: {
        method: 'GET',
        path: '/api/users'
      },
      evidence: {
        filePath: 'src/client.ts',
        snippet: 'return fetch("https://users.example.test/api/users");'
      }
    });
  } finally {
    db.close();
  }

  const cliRun = runCli(consumerRoot, ['workspace', 'resolve-contracts', '--name', 'platform', '--json']);
  assert.equal(cliRun.status, 0, `workspace resolve-contracts failed: ${cliRun.stderr}`);
  assert.deepEqual(JSON.parse(cliRun.stdout), result);
});

test('resolveCrossRepoContracts skips stale consumer files instead of linking unindexed edits', async () => {
  const consumerRoot = await makeRepo('impact-trace-consumer-stale-');
  const providerRoot = await makeRepo('impact-trace-provider-stale-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/client.ts'),
    [
      'export async function loadUsers() {',
      '  return fetch("https://users.example.test/health");',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'info:',
      '  title: Users API',
      '  version: 1.0.0',
      'paths:',
      '  /api/users:',
      '    get:',
      '      operationId: listUsers',
      '      responses:',
      "        '200':",
      '          description: ok',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });
  initWorkspace({ repoRoot: consumerRoot, name: 'platform', serviceName: 'web' });
  addWorkspaceRepo({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    localPath: providerRoot,
    serviceName: 'users-api'
  });

  await writeFile(
    path.join(consumerRoot, 'src/client.ts'),
    [
      'export async function loadUsers() {',
      '  return fetch("https://users.example.test/api/users");',
      '}',
      ''
    ].join('\n')
  );

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes('stale index') && warning.includes('web:src/client.ts')
    ),
    `expected stale warning, got ${JSON.stringify(result.warnings)}`
  );

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const count = db.prepare('SELECT count(*) AS count FROM cross_repo_links').get() as { count: number };
    assert.equal(count.count, 0);
  } finally {
    db.close();
  }
});

test('resolveCrossRepoContracts skips stale provider contracts instead of linking old endpoints', async () => {
  const consumerRoot = await makeRepo('impact-trace-consumer-provider-stale-');
  const providerRoot = await makeRepo('impact-trace-provider-provider-stale-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/client.ts'),
    [
      'export async function loadUsers() {',
      '  return fetch("https://users.example.test/api/users");',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'info:',
      '  title: Users API',
      '  version: 1.0.0',
      'paths:',
      '  /api/users:',
      '    get:',
      '      operationId: listUsers',
      '      responses:',
      "        '200':",
      '          description: ok',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });
  initWorkspace({ repoRoot: consumerRoot, name: 'platform', serviceName: 'web' });
  addWorkspaceRepo({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    localPath: providerRoot,
    serviceName: 'users-api'
  });

  await writeFile(
    path.join(providerRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'info:',
      '  title: Users API',
      '  version: 1.0.1',
      'paths:',
      '  /api/admin:',
      '    get:',
      '      operationId: listAdmins',
      '      responses:',
      "        '200':",
      '          description: ok',
      ''
    ].join('\n')
  );

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes('stale index') && warning.includes('users-api:contracts/openapi.yaml')
    ),
    `expected provider stale warning, got ${JSON.stringify(result.warnings)}`
  );
});

test('resolveCrossRepoContracts warns when an indexed consumer file was deleted', async () => {
  const consumerRoot = await makeRepo('impact-trace-consumer-deleted-');
  const providerRoot = await makeRepo('impact-trace-provider-deleted-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/client.ts'),
    [
      'export async function loadUsers() {',
      '  return fetch("https://users.example.test/api/users");',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'info:',
      '  title: Users API',
      '  version: 1.0.0',
      'paths:',
      '  /api/users:',
      '    get:',
      '      operationId: listUsers',
      '      responses:',
      "        '200':",
      '          description: ok',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });
  initWorkspace({ repoRoot: consumerRoot, name: 'platform', serviceName: 'web' });
  addWorkspaceRepo({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    localPath: providerRoot,
    serviceName: 'users-api'
  });
  await unlink(path.join(consumerRoot, 'src/client.ts'));

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes('consumer file skipped') && warning.includes('web:src/client.ts')
    ),
    `expected deleted consumer warning, got ${JSON.stringify(result.warnings)}`
  );
});

test('resolveCrossRepoContracts does not read post-index symlink consumer files outside repo root', async () => {
  const consumerRoot = await makeRepo('impact-trace-consumer-symlink-');
  const providerRoot = await makeRepo('impact-trace-provider-symlink-');
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-outside-consumer-'));
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  const clientContent = [
    'export async function loadUsers() {',
    '  return fetch("https://users.example.test/api/users");',
    '}',
    ''
  ].join('\n');
  await writeFile(path.join(consumerRoot, 'src/client.ts'), clientContent);
  await writeFile(path.join(outsideRoot, 'client.ts'), clientContent);
  await writeFile(
    path.join(providerRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'info:',
      '  title: Users API',
      '  version: 1.0.0',
      'paths:',
      '  /api/users:',
      '    get:',
      '      operationId: listUsers',
      '      responses:',
      "        '200':",
      '          description: ok',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });
  initWorkspace({ repoRoot: consumerRoot, name: 'platform', serviceName: 'web' });
  addWorkspaceRepo({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    localPath: providerRoot,
    serviceName: 'users-api'
  });

  await unlink(path.join(consumerRoot, 'src/client.ts'));
  await symlink(path.join(outsideRoot, 'client.ts'), path.join(consumerRoot, 'src/client.ts'));

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes('consumer file skipped') && warning.includes('web:src/client.ts')
    ),
    `expected symlink warning, got ${JSON.stringify(result.warnings)}`
  );
});

test('resolveCrossRepoContracts rejects tampered indexed file paths that escape repo root', async () => {
  const consumerRoot = await makeRepo('impact-trace-consumer-path-escape-');
  const providerRoot = await makeRepo('impact-trace-provider-path-escape-');
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-outside-path-'));
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  const clientContent = [
    'export async function loadUsers() {',
    '  return fetch("https://users.example.test/api/users");',
    '}',
    ''
  ].join('\n');
  const outsidePath = path.join(outsideRoot, 'client.ts');
  await writeFile(path.join(consumerRoot, 'src/client.ts'), clientContent);
  await writeFile(outsidePath, clientContent);
  await writeFile(
    path.join(providerRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'info:',
      '  title: Users API',
      '  version: 1.0.0',
      'paths:',
      '  /api/users:',
      '    get:',
      '      operationId: listUsers',
      '      responses:',
      "        '200':",
      '          description: ok',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });
  initWorkspace({ repoRoot: consumerRoot, name: 'platform', serviceName: 'web' });
  addWorkspaceRepo({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    localPath: providerRoot,
    serviceName: 'users-api'
  });

  const consumerDb = new DatabaseSync(databasePath(consumerRoot));
  try {
    consumerDb
      .prepare('UPDATE files SET path = ? WHERE path = ?')
      .run(path.relative(consumerRoot, outsidePath), 'src/client.ts');
  } finally {
    consumerDb.close();
  }

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes('consumer file skipped') && warning.includes('resolves outside repo root')
    ),
    `expected path escape warning, got ${JSON.stringify(result.warnings)}`
  );
});
