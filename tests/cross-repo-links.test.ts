import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  addWorkspaceRepo,
  analyzeContractDiff,
  consumersOf,
  indexProject,
  initProject,
  initWorkspace,
  providersFor,
  resolveCrossRepoContracts,
  verifyCrossRepoLinks,
  workspaceCatalogPath
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

async function makeLinkedWorkspace(): Promise<{ consumerRoot: string; providerRoot: string; consumerReal: string; providerReal: string }> {
  const consumerRoot = await makeRepo('parallax-link-consumer-');
  const providerRoot = await makeRepo('parallax-link-provider-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });
  await writeFile(path.join(consumerRoot, 'src/client.ts'), [
    'export async function loadUsers() {',
    '  return fetch("https://users.example.test/api/users");',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(providerRoot, 'contracts/openapi.yaml'), openApiContract(['/api/users', '/api/status']));
  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });
  initWorkspace({ repoRoot: consumerRoot, name: 'platform', serviceName: 'web' });
  addWorkspaceRepo({ repoRoot: consumerRoot, workspaceName: 'platform', localPath: providerRoot, serviceName: 'users-api' });
  resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });
  await writeFile(path.join(providerRoot, 'contracts/openapi.yaml'), openApiContract(['/api/status']));
  analyzeContractDiff({ repoRoot: consumerRoot, workspaceName: 'platform', providerServiceName: 'users-api', contractPath: 'contracts/openapi.yaml' });
  return { consumerRoot, providerRoot, consumerReal, providerReal };
}

function openApiContract(routes: string[]): string {
  return [
    'openapi: 3.0.0',
    'info:',
    '  title: Users API',
    '  version: 1.0.0',
    'paths:',
    ...routes.flatMap((route) => [
      `  ${route}:`,
      '    get:',
      `      operationId: ${route === '/api/users' ? 'listUsers' : 'status'}`,
      '      responses:',
      "        '200':",
      '          description: ok'
    ]),
    ''
  ].join('\n');
}

test('verifyCrossRepoLinks passes for matching consume and break links', async () => {
  const { consumerRoot } = await makeLinkedWorkspace();
  const result = verifyCrossRepoLinks({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.workspace.name, 'platform');
  assert.equal(result.summary.passed, true);
  assert.equal(result.summary.totalLinks, 2);
  assert.equal(result.summary.consumesLinks, 1);
  assert.equal(result.summary.breakingLinks, 1);
  assert.deepEqual(result.diagnostics.malformedLinks, []);
  assert.deepEqual(result.diagnostics.staleWorkspaceLinks, []);
  assert.deepEqual(result.diagnostics.orphanBreakingLinks, []);
  assert.equal(result.resources.crossRepoLinks, 'parallax://workspaces/platform/cross-repo-links');
});

test('verifyCrossRepoLinks flags orphan breaking links when the parent consume link is missing', async () => {
  const { consumerRoot } = await makeLinkedWorkspace();
  const db = new DatabaseSync(databasePath(consumerRoot));
  try {
    db.prepare("DELETE FROM cross_repo_links WHERE kind = 'CONSUMES_HTTP_ENDPOINT'").run();
  } finally {
    db.close();
  }

  const result = verifyCrossRepoLinks({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.summary.passed, false);
  assert.equal(result.summary.orphanBreakingLinks, 1);
  assert.equal(result.diagnostics.orphanBreakingLinks.length, 1);
  assert.equal(result.diagnostics.orphanBreakingLinks[0]?.kind, 'orphan_breaking_link');
  assert.match(result.diagnostics.orphanBreakingLinks[0]?.message ?? '', /no matching CONSUMES_HTTP_ENDPOINT/);
});

test('verifyCrossRepoLinks flags stale links whose repo membership left the workspace', async () => {
  const { consumerRoot, consumerReal } = await makeLinkedWorkspace();
  const catalogPath = workspaceCatalogPath(consumerRoot);
  await writeFile(catalogPath, `${JSON.stringify({
    schemaVersion: 1,
    name: 'platform',
    repos: [{
      localPath: path.relative(path.dirname(catalogPath), consumerReal),
      serviceName: 'web',
      remoteUrl: null,
      trustPolicy: { readOnly: true }
    }]
  }, null, 2)}\n`);

  const result = verifyCrossRepoLinks({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.summary.passed, false);
  assert.ok(result.summary.staleWorkspaceLinks >= 1);
  assert.ok(result.diagnostics.staleWorkspaceLinks.some((diagnostic) =>
    diagnostic.kind === 'stale_workspace_link' && diagnostic.message.includes('target repo is not a current workspace member')
  ));
});

test('verifyCrossRepoLinks counts malformed provenance without crashing', async () => {
  const { consumerRoot } = await makeLinkedWorkspace();
  const db = new DatabaseSync(databasePath(consumerRoot));
  try {
    const workspace = db.prepare("SELECT id FROM workspaces WHERE name = 'platform'").get() as { id: number };
    db.prepare(`
      INSERT INTO cross_repo_links (
        id, workspace_id, source_repo_id, target_repo_id, source_entity_id,
        target_entity_id, kind, confidence, provenance, index_run_id
      )
      VALUES ('malformed-cross-repo-link', ?, NULL, NULL, NULL, NULL, 'CONSUMES_HTTP_ENDPOINT', 'heuristic', '{bad json', NULL)
    `).run(workspace.id);
  } finally {
    db.close();
  }

  const result = verifyCrossRepoLinks({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.summary.passed, false);
  assert.equal(result.summary.malformedLinks, 1);
  assert.equal(result.diagnostics.malformedLinks[0]?.id, 'malformed-cross-repo-link');
});

test('consumersOf and providersFor expose bidirectional views from canonical rows', async () => {
  const { consumerRoot, consumerReal, providerReal } = await makeLinkedWorkspace();

  const consumers = consumersOf({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    providerContractPath: 'contracts/openapi.yaml',
    method: 'get',
    routePath: '/api/users'
  });
  assert.equal(consumers.workspace.name, 'platform');
  assert.deepEqual(consumers.consumers.map((consumer) => ({
    consumerService: consumer.consumerService,
    consumerRepoPath: consumer.consumerRepoPath,
    consumerPath: consumer.consumerPath,
    providerService: consumer.providerService,
    providerRepoPath: consumer.providerRepoPath,
    providerContractPath: consumer.providerContractPath,
    httpMethod: consumer.httpMethod,
    routePath: consumer.routePath
  })), [{
    consumerService: 'web',
    consumerRepoPath: consumerReal,
    consumerPath: 'src/client.ts',
    providerService: 'users-api',
    providerRepoPath: providerReal,
    providerContractPath: 'contracts/openapi.yaml',
    httpMethod: 'GET',
    routePath: '/api/users'
  }]);

  const providers = providersFor({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    consumerServiceName: 'web',
    consumerPath: 'src/client.ts'
  });
  assert.deepEqual(providers.providers.map((provider) => ({
    consumerService: provider.consumerService,
    consumerPath: provider.consumerPath,
    providerService: provider.providerService,
    providerContractPath: provider.providerContractPath,
    httpMethod: provider.httpMethod,
    routePath: provider.routePath
  })), [{
    consumerService: 'web',
    consumerPath: 'src/client.ts',
    providerService: 'users-api',
    providerContractPath: 'contracts/openapi.yaml',
    httpMethod: 'GET',
    routePath: '/api/users'
  }]);
});
