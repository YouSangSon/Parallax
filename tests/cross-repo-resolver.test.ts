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
  const consumerRoot = await makeRepo('parallax-consumer-');
  const providerRoot = await makeRepo('parallax-provider-');
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

test('resolveCrossRepoContracts links OpenAPI HTTP consumers through same-file Java route constants', async () => {
  const consumerRoot = await makeRepo('parallax-http-alias-consumer-');
  const providerRoot = await makeRepo('parallax-http-alias-provider-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/UsersClient.java'),
    [
      'package app;',
      '',
      'import org.springframework.web.reactive.function.client.WebClient;',
      'import reactor.core.publisher.Mono;',
      '',
      'public class UsersClient {',
      '  private static final String USERS_PATH = "/api/users";',
      '',
      '  Mono<Void> createUser(WebClient webClient) {',
      '    return webClient.post().uri(USERS_PATH).retrieve().bodyToMono(Void.class);',
      '  }',
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
      '    post:',
      '      operationId: createUser',
      '      responses:',
      "        '204':",
      '          description: created',
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

  assert.equal(result.links.length, 1);
  assert.deepEqual(result.links[0], {
    kind: 'CONSUMES_HTTP_ENDPOINT',
    confidence: 'heuristic',
    consumerService: 'web',
    consumerRepoPath: consumerReal,
    consumerPath: 'src/UsersClient.java',
    providerService: 'users-api',
    providerRepoPath: providerReal,
    providerContractPath: 'contracts/openapi.yaml',
    providerEndpointId: 'endpoint:yaml:POST /api/users',
    httpMethod: 'POST',
    routePath: '/api/users'
  });

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const row = db
      .prepare('SELECT provenance FROM cross_repo_links')
      .get() as { provenance: string };
    assert.equal(
      JSON.parse(row.provenance).evidence.snippet,
      'return webClient.post().uri(USERS_PATH).retrieve().bodyToMono(Void.class);'
    );
  } finally {
    db.close();
  }
});

test('resolveCrossRepoContracts does not use OpenAPI HTTP route declarations as consumer evidence', async () => {
  const consumerRoot = await makeRepo('parallax-http-declaration-consumer-');
  const providerRoot = await makeRepo('parallax-http-declaration-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/Routes.java'),
    [
      'package app;',
      '',
      'public class Routes {',
      '  private static final String USERS_PATH = "/api/users";',
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

  assert.equal(result.links.length, 0);
  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS count FROM cross_repo_links')
      .get() as { count: number };
    assert.equal(row.count, 0);
  } finally {
    db.close();
  }
});

test('resolveCrossRepoContracts does not treat Spring controller mappings as OpenAPI HTTP consumers', async () => {
  const consumerRoot = await makeRepo('parallax-http-controller-consumer-');
  const providerRoot = await makeRepo('parallax-http-controller-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/UsersController.java'),
    [
      'package app;',
      '',
      'import org.springframework.web.bind.annotation.GetMapping;',
      'import org.springframework.web.bind.annotation.RestController;',
      '',
      '@RestController',
      'public class UsersController {',
      '  @GetMapping("/api/users")',
      '  String listUsers() { return "ok"; }',
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

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts treats Feign mapping annotations as OpenAPI HTTP consumers', async () => {
  const consumerRoot = await makeRepo('parallax-http-feign-consumer-');
  const providerRoot = await makeRepo('parallax-http-feign-provider-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/UsersClient.java'),
    [
      'package app;',
      '',
      'import org.springframework.cloud.openfeign.FeignClient;',
      'import org.springframework.web.bind.annotation.GetMapping;',
      '',
      '@FeignClient(name = "users")',
      'public interface UsersClient {',
      '  @GetMapping("/api/users")',
      '  String listUsers();',
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

  assert.equal(result.links.length, 1);
  assert.deepEqual(result.links[0], {
    kind: 'CONSUMES_HTTP_ENDPOINT',
    confidence: 'heuristic',
    consumerService: 'web',
    consumerRepoPath: consumerReal,
    consumerPath: 'src/UsersClient.java',
    providerService: 'users-api',
    providerRepoPath: providerReal,
    providerContractPath: 'contracts/openapi.yaml',
    providerEndpointId: 'endpoint:yaml:GET /api/users',
    httpMethod: 'GET',
    routePath: '/api/users'
  });
});

test('resolveCrossRepoContracts ignores ordinary dotted methods that reuse HTTP route constants', async () => {
  const consumerRoot = await makeRepo('parallax-http-ordinary-method-consumer-');
  const providerRoot = await makeRepo('parallax-http-ordinary-method-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/CacheRoutes.java'),
    [
      'package app;',
      '',
      'import java.util.Map;',
      '',
      'public class CacheRoutes {',
      '  private static final String USERS_PATH = "/api/users";',
      '',
      '  void remember(Map<String, String> cache) {',
      '    cache.put(USERS_PATH, "cached");',
      '  }',
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
      '    put:',
      '      operationId: replaceUsers',
      '      responses:',
      "        '204':",
      '          description: replaced',
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

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts ignores commented Feign annotations when classifying Spring mappings', async () => {
  const consumerRoot = await makeRepo('parallax-http-commented-feign-consumer-');
  const providerRoot = await makeRepo('parallax-http-commented-feign-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/UsersController.java'),
    [
      'package app;',
      '',
      'import org.springframework.web.bind.annotation.GetMapping;',
      'import org.springframework.web.bind.annotation.RestController;',
      '',
      '// @FeignClient(name = "users")',
      '@RestController',
      'public class UsersController {',
      '  @GetMapping("/api/users")',
      '  String listUsers() { return "ok"; }',
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

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts scopes Feign mapping consumers to the Feign interface', async () => {
  const consumerRoot = await makeRepo('parallax-http-mixed-feign-consumer-');
  const providerRoot = await makeRepo('parallax-http-mixed-feign-provider-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/MixedUsers.java'),
    [
      'package app;',
      '',
      'import org.springframework.cloud.openfeign.FeignClient;',
      'import org.springframework.web.bind.annotation.GetMapping;',
      'import org.springframework.web.bind.annotation.RestController;',
      '',
      '@RestController',
      'class LocalUsersController {',
      '  @GetMapping("/api/admin")',
      '  String admin() { return "ok"; }',
      '}',
      '',
      '@FeignClient(name = "users")',
      'interface UsersClient {',
      '  @GetMapping("/api/users")',
      '  String listUsers();',
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
      '  /api/admin:',
      '    get:',
      '      operationId: admin',
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

  assert.equal(result.links.length, 1);
  assert.deepEqual(result.links[0], {
    kind: 'CONSUMES_HTTP_ENDPOINT',
    confidence: 'heuristic',
    consumerService: 'web',
    consumerRepoPath: consumerReal,
    consumerPath: 'src/MixedUsers.java',
    providerService: 'users-api',
    providerRepoPath: providerReal,
    providerContractPath: 'contracts/openapi.yaml',
    providerEndpointId: 'endpoint:yaml:GET /api/users',
    httpMethod: 'GET',
    routePath: '/api/users'
  });
});

test('resolveCrossRepoContracts ignores computed OpenAPI HTTP route constants', async () => {
  const consumerRoot = await makeRepo('parallax-http-computed-consumer-');
  const providerRoot = await makeRepo('parallax-http-computed-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/UsersClient.java'),
    [
      'package app;',
      '',
      'import org.springframework.web.reactive.function.client.WebClient;',
      'import reactor.core.publisher.Mono;',
      '',
      'public class UsersClient {',
      '  private static final String USERS_PATH = "/api" + "/users";',
      '',
      '  Mono<Void> createUser(WebClient webClient) {',
      '    return webClient.post().uri(USERS_PATH).retrieve().bodyToMono(Void.class);',
      '  }',
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
      '    post:',
      '      operationId: createUser',
      '      responses:',
      "        '204':",
      '          description: created',
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

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts links GraphQL operation consumers to provider root fields', async () => {
  const consumerRoot = await makeRepo('parallax-graphql-consumer-');
  const providerRoot = await makeRepo('parallax-graphql-provider-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/users-query.ts'),
    [
      'export const usersQuery = `',
      '  query UsersScreen {',
      '    users {',
      '      id',
      '    }',
      '  }',
      '`;',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/schema.graphql'),
    [
      'type Query {',
      '  users: [User!]!',
      '}',
      '',
      'type User {',
      '  id: ID!',
      '  name: String!',
      '}',
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
    serviceName: 'users-graphql'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.workspace.name, 'platform');
  assert.equal(result.links.length, 1);
  assert.deepEqual(result.links[0], {
    kind: 'CONSUMES_HTTP_ENDPOINT',
    confidence: 'heuristic',
    consumerService: 'web',
    consumerRepoPath: consumerReal,
    consumerPath: 'src/users-query.ts',
    providerService: 'users-graphql',
    providerRepoPath: providerReal,
    providerContractPath: 'contracts/schema.graphql',
    providerEndpointId: 'endpoint:graphql:Query.users',
    httpMethod: 'GRAPHQL',
    routePath: 'Query.users'
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
        path: 'src/users-query.ts'
      },
      provider: {
        serviceName: 'users-graphql',
        repoPath: providerReal,
        contractPath: 'contracts/schema.graphql',
        endpointId: 'endpoint:graphql:Query.users'
      },
      http: {
        method: 'GRAPHQL',
        path: 'Query.users'
      },
      evidence: {
        filePath: 'src/users-query.ts',
        snippet: 'users {'
      }
    });
  } finally {
    db.close();
  }
});

test('resolveCrossRepoContracts ignores GraphQL operation examples in non-consumer files', async () => {
  const consumerRoot = await makeRepo('parallax-graphql-doc-consumer-');
  const providerRoot = await makeRepo('parallax-graphql-doc-provider-');
  await mkdir(path.join(consumerRoot, 'docs'), { recursive: true });
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'README.md'),
    [
      '# Example query',
      '',
      '```graphql',
      'query UsersScreen {',
      '  users {',
      '    id',
      '  }',
      '}',
      '```',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(consumerRoot, 'docs/example.graphql'),
    [
      'query UsersScreen {',
      '  users {',
      '    id',
      '  }',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/schema.graphql'),
    [
      'type Query {',
      '  users: [User!]!',
      '}',
      '',
      'type User {',
      '  id: ID!',
      '}',
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
    serviceName: 'users-graphql'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts does not treat ordinary TS blocks as anonymous GraphQL consumers', async () => {
  const consumerRoot = await makeRepo('parallax-graphql-ts-false-consumer-');
  const providerRoot = await makeRepo('parallax-graphql-ts-false-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/component.ts'),
    [
      'export function renderUsersList() {',
      '  users();',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/schema.graphql'),
    [
      'type Query {',
      '  users: [User!]!',
      '}',
      '',
      'type User {',
      '  id: ID!',
      '}',
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
    serviceName: 'users-graphql'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts does not treat TS functions named query as GraphQL operations', async () => {
  const consumerRoot = await makeRepo('parallax-graphql-ts-query-function-consumer-');
  const providerRoot = await makeRepo('parallax-graphql-ts-query-function-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/component.ts'),
    [
      'export function query() {',
      '  users();',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/schema.graphql'),
    [
      'type Query {',
      '  users: [User!]!',
      '}',
      '',
      'type User {',
      '  id: ID!',
      '}',
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
    serviceName: 'users-graphql'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts does not treat protobuf Query services as GraphQL providers', async () => {
  const consumerRoot = await makeRepo('parallax-graphql-protobuf-consumer-');
  const providerRoot = await makeRepo('parallax-graphql-protobuf-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/users-query.ts'),
    [
      'export const usersQuery = `',
      '  query UsersScreen {',
      '    users {',
      '      id',
      '    }',
      '  }',
      '`;',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/service.proto'),
    [
      'syntax = "proto3";',
      '',
      'service Query {',
      '  rpc users (UsersRequest) returns (UsersResponse);',
      '}',
      '',
      'message UsersRequest {}',
      'message UsersResponse {',
      '  string id = 1;',
      '}',
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
    serviceName: 'users-protobuf'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts ignores TS comment backticks when detecting GraphQL templates', async () => {
  const consumerRoot = await makeRepo('parallax-graphql-ts-comment-backtick-consumer-');
  const providerRoot = await makeRepo('parallax-graphql-ts-comment-backtick-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/component.ts'),
    [
      '// copied from docs: `',
      'export function query() {',
      '  users();',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/schema.graphql'),
    [
      'type Query {',
      '  users: [User!]!',
      '}',
      '',
      'type User {',
      '  id: ID!',
      '}',
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
    serviceName: 'users-graphql'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts links Protobuf RPC consumers to provider service methods', async () => {
  const consumerRoot = await makeRepo('parallax-protobuf-consumer-');
  const providerRoot = await makeRepo('parallax-protobuf-provider-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/users-client.ts'),
    [
      'import { createPromiseClient } from "@connectrpc/connect";',
      'import { UserService } from "./gen/users_connect";',
      '',
      'export async function loadUsers(transport: unknown) {',
      '  const client = createPromiseClient(UserService, transport);',
      '  return client.listUsers({ pageSize: 50 });',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/users.proto'),
    [
      'syntax = "proto3";',
      '',
      'service UserService {',
      '  rpc ListUsers (ListUsersRequest) returns (ListUsersResponse);',
      '}',
      '',
      'message ListUsersRequest {',
      '  int32 page_size = 1;',
      '}',
      '',
      'message ListUsersResponse {',
      '  repeated string ids = 1;',
      '}',
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
    serviceName: 'users-grpc'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 1);
  assert.deepEqual(result.links[0], {
    kind: 'CONSUMES_HTTP_ENDPOINT',
    confidence: 'heuristic',
    consumerService: 'web',
    consumerRepoPath: consumerReal,
    consumerPath: 'src/users-client.ts',
    providerService: 'users-grpc',
    providerRepoPath: providerReal,
    providerContractPath: 'contracts/users.proto',
    providerEndpointId: 'endpoint:protobuf:UserService.ListUsers',
    httpMethod: 'RPC',
    routePath: 'UserService/ListUsers'
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
        path: 'src/users-client.ts'
      },
      provider: {
        serviceName: 'users-grpc',
        repoPath: providerReal,
        contractPath: 'contracts/users.proto',
        endpointId: 'endpoint:protobuf:UserService.ListUsers'
      },
      http: {
        method: 'RPC',
        path: 'UserService/ListUsers'
      },
      evidence: {
        filePath: 'src/users-client.ts',
        snippet: 'return client.listUsers({ pageSize: 50 });'
      }
    });
  } finally {
    db.close();
  }
});

test('resolveCrossRepoContracts does not link Protobuf RPC names without service context', async () => {
  const consumerRoot = await makeRepo('parallax-protobuf-false-consumer-');
  const providerRoot = await makeRepo('parallax-protobuf-false-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/users.ts'),
    [
      'export function listUsers() {',
      '  return ["local-only"];',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/users.proto'),
    [
      'syntax = "proto3";',
      '',
      'service UserService {',
      '  rpc ListUsers (ListUsersRequest) returns (ListUsersResponse);',
      '}',
      '',
      'message ListUsersRequest {}',
      'message ListUsersResponse {}',
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
    serviceName: 'users-grpc'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts does not link Protobuf helper declarations with service context', async () => {
  const consumerRoot = await makeRepo('parallax-protobuf-helper-consumer-');
  const providerRoot = await makeRepo('parallax-protobuf-helper-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/users.ts'),
    [
      'import { UserService } from "./gen/users_connect";',
      '',
      'export function listUsers() {',
      '  return { service: UserService, source: "local-only" };',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/users.proto'),
    [
      'syntax = "proto3";',
      '',
      'service UserService {',
      '  rpc ListUsers (ListUsersRequest) returns (ListUsersResponse);',
      '}',
      '',
      'message ListUsersRequest {}',
      'message ListUsersResponse {}',
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
    serviceName: 'users-grpc'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts ignores generated Protobuf client descriptors', async () => {
  const consumerRoot = await makeRepo('parallax-protobuf-generated-consumer-');
  const providerRoot = await makeRepo('parallax-protobuf-generated-provider-');
  await mkdir(path.join(consumerRoot, 'src/gen'), { recursive: true });
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/gen/users_pb.ts'),
    [
      '// @generated by protoc-gen-es',
      'export const UserService = {',
      '  methods: {',
      '    listUsers: { name: "ListUsers" }',
      '  }',
      '};',
      'export function listUsers(input: unknown) {',
      '  return input;',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(consumerRoot, 'src/users-client.ts'),
    [
      '// @generated by protoc-gen-connect-es',
      'import { UserService } from "./gen/users_connect";',
      '',
      'export function listUsers(client: { listUsers(input: unknown): unknown }) {',
      '  return client.listUsers({});',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/users.proto'),
    [
      'syntax = "proto3";',
      '',
      'service UserService {',
      '  rpc ListUsers (ListUsersRequest) returns (ListUsersResponse);',
      '}',
      '',
      'message ListUsersRequest {}',
      'message ListUsersResponse {}',
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
    serviceName: 'users-grpc'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts links Connect-ES createClient generated client calls', async () => {
  const consumerRoot = await makeRepo('parallax-connect-es-consumer-');
  const providerRoot = await makeRepo('parallax-connect-es-provider-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/users-client.ts'),
    [
      'import { createClient } from "@connectrpc/connect";',
      'import { UserService } from "./gen/users_connect";',
      '',
      'export async function loadUsers(transport: unknown) {',
      '  const client = createClient(UserService, transport);',
      '  return client.listUsers({ pageSize: 50 });',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/users.proto'),
    [
      'syntax = "proto3";',
      '',
      'service UserService {',
      '  rpc ListUsers (ListUsersRequest) returns (ListUsersResponse);',
      '}',
      '',
      'message ListUsersRequest {}',
      'message ListUsersResponse {}',
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
    serviceName: 'users-grpc'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 1);
  assert.deepEqual(result.links[0], {
    kind: 'CONSUMES_HTTP_ENDPOINT',
    confidence: 'heuristic',
    consumerService: 'web',
    consumerRepoPath: consumerReal,
    consumerPath: 'src/users-client.ts',
    providerService: 'users-grpc',
    providerRepoPath: providerReal,
    providerContractPath: 'contracts/users.proto',
    providerEndpointId: 'endpoint:protobuf:UserService.ListUsers',
    httpMethod: 'RPC',
    routePath: 'UserService/ListUsers'
  });
});

test('resolveCrossRepoContracts links Protobuf RPC full path strings without a leading slash', async () => {
  const consumerRoot = await makeRepo('parallax-protobuf-fullpath-consumer-');
  const providerRoot = await makeRepo('parallax-protobuf-fullpath-provider-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/users-client.ts'),
    [
      'export const listUsersRpcPath = "users.v1.UserService/ListUsers";',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/users.proto'),
    [
      'syntax = "proto3";',
      '',
      'package users.v1;',
      '',
      'service UserService {',
      '  rpc ListUsers (ListUsersRequest) returns (ListUsersResponse);',
      '}',
      '',
      'message ListUsersRequest {}',
      'message ListUsersResponse {}',
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
    serviceName: 'users-grpc'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 1);
  assert.deepEqual(result.links[0], {
    kind: 'CONSUMES_HTTP_ENDPOINT',
    confidence: 'heuristic',
    consumerService: 'web',
    consumerRepoPath: consumerReal,
    consumerPath: 'src/users-client.ts',
    providerService: 'users-grpc',
    providerRepoPath: providerReal,
    providerContractPath: 'contracts/users.proto',
    providerEndpointId: 'endpoint:protobuf:UserService.ListUsers',
    httpMethod: 'RPC',
    routePath: 'UserService/ListUsers'
  });
});

test('resolveCrossRepoContracts ignores Protobuf RPC full path strings in source comments', async () => {
  const consumerRoot = await makeRepo('parallax-protobuf-comment-consumer-');
  const providerRoot = await makeRepo('parallax-protobuf-comment-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/users-client.ts'),
    [
      '// Docs mention users.v1.UserService/ListUsers but this file does not call it.',
      'export const localOnly = true;',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/users.proto'),
    [
      'syntax = "proto3";',
      '',
      'package users.v1;',
      '',
      'service UserService {',
      '  rpc ListUsers (ListUsersRequest) returns (ListUsersResponse);',
      '}',
      '',
      'message ListUsersRequest {}',
      'message ListUsersResponse {}',
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
    serviceName: 'users-grpc'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts ignores Protobuf RPC matches inside inline and block comments', async () => {
  const consumerRoot = await makeRepo('parallax-protobuf-inline-comment-consumer-');
  const providerRoot = await makeRepo('parallax-protobuf-inline-comment-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/users-client.ts'),
    [
      'import { UserService } from "./gen/users_connect";',
      'const localOnly = true; // users.v1.UserService/ListUsers',
      'const alsoLocal = true; /* client.listUsers({}); */',
      '/*',
      'client.listUsers({});',
      '*/',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/users.proto'),
    [
      'syntax = "proto3";',
      '',
      'package users.v1;',
      '',
      'service UserService {',
      '  rpc ListUsers (ListUsersRequest) returns (ListUsersResponse);',
      '}',
      '',
      'message ListUsersRequest {}',
      'message ListUsersResponse {}',
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
    serviceName: 'users-grpc'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts ignores Protobuf service context from comments', async () => {
  const consumerRoot = await makeRepo('parallax-protobuf-comment-context-consumer-');
  const providerRoot = await makeRepo('parallax-protobuf-comment-context-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/users-client.ts'),
    [
      '// import { UserService } from "./gen/users_connect";',
      'const localOnly = true; // UserService',
      'export function loadUsers(client: { listUsers(input: unknown): unknown }) {',
      '  return client.listUsers({});',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/users.proto'),
    [
      'syntax = "proto3";',
      '',
      'service UserService {',
      '  rpc ListUsers (ListUsersRequest) returns (ListUsersResponse);',
      '}',
      '',
      'message ListUsersRequest {}',
      'message ListUsersResponse {}',
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
    serviceName: 'users-grpc'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts links AsyncAPI event consumers to provider operations', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-consumer-');
  const providerRoot = await makeRepo('parallax-asyncapi-provider-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      'export function startOrdersConsumer(bus: { subscribe(topic: string, handler: () => void): void }) {',
      '  bus.subscribe("orders.submitted", () => undefined);',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      '          required: [orderId]',
      '          properties:',
      '            orderId:',
      '              type: string',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
      '    messages:',
      '      - $ref: "#/channels/orderSubmitted/messages/OrderSubmitted"',
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
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 1);
  assert.deepEqual(result.links[0], {
    kind: 'CONSUMES_HTTP_ENDPOINT',
    confidence: 'heuristic',
    consumerService: 'web',
    consumerRepoPath: consumerReal,
    consumerPath: 'src/orders-consumer.ts',
    providerService: 'orders-events',
    providerRepoPath: providerReal,
    providerContractPath: 'contracts/asyncapi.yaml',
    providerEndpointId: 'endpoint:asyncapi:SEND orders.submitted',
    httpMethod: 'SEND',
    routePath: 'orders.submitted',
    eventTopology: {
      providerAction: 'SEND',
      counterpartyRole: 'consumer',
      pattern: 'subscriber-call'
    }
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
        path: 'src/orders-consumer.ts'
      },
      provider: {
        serviceName: 'orders-events',
        repoPath: providerReal,
        contractPath: 'contracts/asyncapi.yaml',
        endpointId: 'endpoint:asyncapi:SEND orders.submitted'
      },
      http: {
        method: 'SEND',
        path: 'orders.submitted'
      },
      eventTopology: {
        counterpartyRole: 'consumer',
        pattern: 'subscriber-call',
        providerAction: 'SEND'
      },
      evidence: {
        filePath: 'src/orders-consumer.ts',
        snippet: 'bus.subscribe("orders.submitted", () => undefined);'
      }
    });
  } finally {
    db.close();
  }
});

test('resolveCrossRepoContracts ignores AsyncAPI examples and partial topic matches', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-false-consumer-');
  const providerRoot = await makeRepo('parallax-asyncapi-false-provider-');
  await mkdir(path.join(consumerRoot, 'docs'), { recursive: true });
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'docs/example.ts'),
    [
      'export const example = "orders.submitted";',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      'export const topic = "orders.submitted.v2";',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
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
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts links AsyncAPI event consumers through same-file topic aliases', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-consumer-alias-');
  const providerRoot = await makeRepo('parallax-asyncapi-provider-alias-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      'const ORDER_TOPIC = "orders.submitted";',
      'export function startOrdersConsumer(bus: { subscribe(topic: string, handler: () => void): void }) {',
      '  bus.subscribe(ORDER_TOPIC, () => undefined);',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
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
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 1);
  assert.deepEqual(result.links[0], {
    kind: 'CONSUMES_HTTP_ENDPOINT',
    confidence: 'heuristic',
    consumerService: 'web',
    consumerRepoPath: consumerReal,
    consumerPath: 'src/orders-consumer.ts',
    providerService: 'orders-events',
    providerRepoPath: providerReal,
    providerContractPath: 'contracts/asyncapi.yaml',
    providerEndpointId: 'endpoint:asyncapi:SEND orders.submitted',
    httpMethod: 'SEND',
    routePath: 'orders.submitted',
    eventTopology: {
      providerAction: 'SEND',
      counterpartyRole: 'consumer',
      pattern: 'subscriber-call'
    }
  });

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT provenance
         FROM cross_repo_links`
      )
      .get() as { provenance: string };
    assert.equal(JSON.parse(row.provenance).evidence.snippet, 'bus.subscribe(ORDER_TOPIC, () => undefined);');
  } finally {
    db.close();
  }
});

test('resolveCrossRepoContracts links AsyncAPI SEND operations to Spring Kafka listeners', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-spring-consumer-');
  const providerRoot = await makeRepo('parallax-asyncapi-spring-provider-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await mkdir(path.join(consumerRoot, 'src/main/java/com/example/orders'), { recursive: true });
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/main/java/com/example/orders/OrdersListener.java'),
    [
      'package com.example.orders;',
      '',
      'class OrdersListener {',
      '  @KafkaListener(topics = "orders.submitted")',
      '  void onOrderSubmitted(String payload) {}',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });
  initWorkspace({ repoRoot: consumerRoot, name: 'platform', serviceName: 'fulfillment' });
  addWorkspaceRepo({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    localPath: providerRoot,
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 1);
  assert.deepEqual(result.links[0], {
    kind: 'CONSUMES_HTTP_ENDPOINT',
    confidence: 'heuristic',
    consumerService: 'fulfillment',
    consumerRepoPath: consumerReal,
    consumerPath: 'src/main/java/com/example/orders/OrdersListener.java',
    providerService: 'orders-events',
    providerRepoPath: providerReal,
    providerContractPath: 'contracts/asyncapi.yaml',
    providerEndpointId: 'endpoint:asyncapi:SEND orders.submitted',
    httpMethod: 'SEND',
    routePath: 'orders.submitted',
    eventTopology: {
      providerAction: 'SEND',
      counterpartyRole: 'consumer',
      pattern: 'spring-kafka-listener'
    }
  });
});

test('resolveCrossRepoContracts links AsyncAPI SEND operations through Java topic constants', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-java-constant-consumer-');
  const providerRoot = await makeRepo('parallax-asyncapi-java-constant-provider-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await mkdir(path.join(consumerRoot, 'src/main/java/com/example/orders'), { recursive: true });
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/main/java/com/example/orders/OrdersListener.java'),
    [
      'package com.example.orders;',
      '',
      'class OrdersListener {',
      '  private static final String ORDER_TOPIC = "orders.submitted";',
      '',
      '  @KafkaListener(topics = ORDER_TOPIC)',
      '  void onOrderSubmitted(String payload) {}',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });
  initWorkspace({ repoRoot: consumerRoot, name: 'platform', serviceName: 'fulfillment' });
  addWorkspaceRepo({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    localPath: providerRoot,
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 1);
  assert.deepEqual(result.links[0], {
    kind: 'CONSUMES_HTTP_ENDPOINT',
    confidence: 'heuristic',
    consumerService: 'fulfillment',
    consumerRepoPath: consumerReal,
    consumerPath: 'src/main/java/com/example/orders/OrdersListener.java',
    providerService: 'orders-events',
    providerRepoPath: providerReal,
    providerContractPath: 'contracts/asyncapi.yaml',
    providerEndpointId: 'endpoint:asyncapi:SEND orders.submitted',
    httpMethod: 'SEND',
    routePath: 'orders.submitted',
    eventTopology: {
      providerAction: 'SEND',
      counterpartyRole: 'consumer',
      pattern: 'spring-kafka-listener'
    }
  });
});

test('resolveCrossRepoContracts links AsyncAPI RECEIVE operations to event producers', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-receive-producer-');
  const providerRoot = await makeRepo('parallax-asyncapi-receive-provider-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-producer.ts'),
    [
      'export async function publishOrderCommand(producer: { send(input: unknown): Promise<void> }) {',
      '  await producer.send({ topic: "orders.commanded", messages: [] });',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderCommanded:',
      '    address: orders.commanded',
      '    messages:',
      '      OrderCommanded:',
      '        payload:',
      '          type: object',
      'operations:',
      '  receiveOrderCommanded:',
      '    action: receive',
      '    channel:',
      '      $ref: "#/channels/orderCommanded"',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });
  initWorkspace({ repoRoot: consumerRoot, name: 'platform', serviceName: 'checkout' });
  addWorkspaceRepo({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    localPath: providerRoot,
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 1);
  assert.deepEqual(result.links[0], {
    kind: 'CONSUMES_HTTP_ENDPOINT',
    confidence: 'heuristic',
    consumerService: 'checkout',
    consumerRepoPath: consumerReal,
    consumerPath: 'src/orders-producer.ts',
    providerService: 'orders-events',
    providerRepoPath: providerReal,
    providerContractPath: 'contracts/asyncapi.yaml',
    providerEndpointId: 'endpoint:asyncapi:RECEIVE orders.commanded',
    httpMethod: 'RECEIVE',
    routePath: 'orders.commanded',
    eventTopology: {
      providerAction: 'RECEIVE',
      counterpartyRole: 'producer',
      pattern: 'producer-send'
    }
  });
});

test('resolveCrossRepoContracts links AsyncAPI RECEIVE operations through Kotlin topic constants', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-kotlin-constant-producer-');
  const providerRoot = await makeRepo('parallax-asyncapi-kotlin-constant-provider-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await mkdir(path.join(consumerRoot, 'src/main/kotlin/com/example/orders'), { recursive: true });
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/main/kotlin/com/example/orders/OrdersProducer.kt'),
    [
      'package com.example.orders',
      '',
      'private const val ORDER_COMMAND = "orders.commanded"',
      '',
      'class OrdersProducer(private val kafkaTemplate: KafkaTemplate<String, String>) {',
      '  fun publish(payload: String) {',
      '    kafkaTemplate.send(ORDER_COMMAND, payload)',
      '  }',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderCommanded:',
      '    address: orders.commanded',
      '    messages:',
      '      OrderCommanded:',
      '        payload:',
      '          type: object',
      'operations:',
      '  receiveOrderCommanded:',
      '    action: receive',
      '    channel:',
      '      $ref: "#/channels/orderCommanded"',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });
  initWorkspace({ repoRoot: consumerRoot, name: 'platform', serviceName: 'checkout' });
  addWorkspaceRepo({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    localPath: providerRoot,
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 1);
  assert.deepEqual(result.links[0], {
    kind: 'CONSUMES_HTTP_ENDPOINT',
    confidence: 'heuristic',
    consumerService: 'checkout',
    consumerRepoPath: consumerReal,
    consumerPath: 'src/main/kotlin/com/example/orders/OrdersProducer.kt',
    providerService: 'orders-events',
    providerRepoPath: providerReal,
    providerContractPath: 'contracts/asyncapi.yaml',
    providerEndpointId: 'endpoint:asyncapi:RECEIVE orders.commanded',
    httpMethod: 'RECEIVE',
    routePath: 'orders.commanded',
    eventTopology: {
      providerAction: 'RECEIVE',
      counterpartyRole: 'producer',
      pattern: 'spring-kafka-template-send'
    }
  });
});

test('resolveCrossRepoContracts links AsyncAPI RECEIVE operations through same-file producer aliases', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-receive-producer-alias-');
  const providerRoot = await makeRepo('parallax-asyncapi-receive-provider-alias-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-producer.ts'),
    [
      'const ORDER_COMMAND = "orders.commanded";',
      'export async function publishOrderCommand(producer: { send(input: unknown): Promise<void> }) {',
      '  await producer.send({ topic: ORDER_COMMAND, messages: [] });',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderCommanded:',
      '    address: orders.commanded',
      '    messages:',
      '      OrderCommanded:',
      '        payload:',
      '          type: object',
      'operations:',
      '  receiveOrderCommanded:',
      '    action: receive',
      '    channel:',
      '      $ref: "#/channels/orderCommanded"',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });
  initWorkspace({ repoRoot: consumerRoot, name: 'platform', serviceName: 'checkout' });
  addWorkspaceRepo({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    localPath: providerRoot,
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 1);
  assert.deepEqual(result.links[0], {
    kind: 'CONSUMES_HTTP_ENDPOINT',
    confidence: 'heuristic',
    consumerService: 'checkout',
    consumerRepoPath: consumerReal,
    consumerPath: 'src/orders-producer.ts',
    providerService: 'orders-events',
    providerRepoPath: providerReal,
    providerContractPath: 'contracts/asyncapi.yaml',
    providerEndpointId: 'endpoint:asyncapi:RECEIVE orders.commanded',
    httpMethod: 'RECEIVE',
    routePath: 'orders.commanded',
    eventTopology: {
      providerAction: 'RECEIVE',
      counterpartyRole: 'producer',
      pattern: 'producer-send'
    }
  });
});

test('resolveCrossRepoContracts links AsyncAPI event consumers through assignment aliases', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-assignment-alias-');
  const providerRoot = await makeRepo('parallax-asyncapi-assignment-provider-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      'let ORDER_TOPIC: string;',
      'ORDER_TOPIC = "orders.submitted";',
      'export function startOrdersConsumer(bus: { subscribe(topic: string, handler: () => void): void }) {',
      '  bus.subscribe(ORDER_TOPIC, () => undefined);',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
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
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 1);
  assert.deepEqual(result.links[0], {
    kind: 'CONSUMES_HTTP_ENDPOINT',
    confidence: 'heuristic',
    consumerService: 'web',
    consumerRepoPath: consumerReal,
    consumerPath: 'src/orders-consumer.ts',
    providerService: 'orders-events',
    providerRepoPath: providerReal,
    providerContractPath: 'contracts/asyncapi.yaml',
    providerEndpointId: 'endpoint:asyncapi:SEND orders.submitted',
    httpMethod: 'SEND',
    routePath: 'orders.submitted',
    eventTopology: {
      providerAction: 'SEND',
      counterpartyRole: 'consumer',
      pattern: 'subscriber-call'
    }
  });
});

test('resolveCrossRepoContracts does not link AsyncAPI SEND operations to producer-only call sites', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-producer-false-');
  const providerRoot = await makeRepo('parallax-asyncapi-producer-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-producer.ts'),
    [
      'export async function publishOrderSubmitted(producer: { send(input: unknown): Promise<void> }) {',
      '  await producer.send({ topic: "orders.submitted", messages: [] });',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });
  initWorkspace({ repoRoot: consumerRoot, name: 'platform', serviceName: 'checkout' });
  addWorkspaceRepo({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    localPath: providerRoot,
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts ignores AsyncAPI alias evidence in comments', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-alias-comment-false-');
  const providerRoot = await makeRepo('parallax-asyncapi-alias-comment-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      '// const ORDER_TOPIC = "orders.submitted";',
      '/* bus.subscribe(ORDER_TOPIC, () => undefined); */',
      'const localOnly = true;',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
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
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts ignores AsyncAPI partial literal aliases', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-partial-alias-false-');
  const providerRoot = await makeRepo('parallax-asyncapi-partial-alias-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      'const ORDER_TOPIC = "orders.submitted.v2";',
      'export function startOrdersConsumer(bus: { subscribe(topic: string, handler: () => void): void }) {',
      '  bus.subscribe(ORDER_TOPIC, () => undefined);',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
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
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts ignores AsyncAPI direct concatenated event literals', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-direct-concat-false-');
  const providerRoot = await makeRepo('parallax-asyncapi-direct-concat-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      'export function startOrdersConsumer(bus: { subscribe(topic: string, handler: () => void): void }) {',
      '  bus.subscribe("orders.submitted" + ".v2", () => undefined);',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
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
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts ignores AsyncAPI source member and grouped computed literals', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-source-expression-false-');
  const providerRoot = await makeRepo('parallax-asyncapi-source-expression-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      'export function startOrdersConsumer(bus: { subscribe(topic: string, handler: () => void): void }, orders: { submitted: string }) {',
      '  bus.subscribe(orders.submitted, () => undefined);',
      '  bus.subscribe(prefix + "orders.submitted", () => undefined);',
      '  bus.subscribe(getTopic() ?? "orders.submitted", () => undefined);',
      '  bus.subscribe(("orders.submitted") + ".v2", () => undefined);',
      '  bus.subscribe("orders.submitted" as string + ".v2", () => undefined);',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
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
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts does not use AsyncAPI alias declarations as call-site evidence', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-alias-declaration-false-');
  const providerRoot = await makeRepo('parallax-asyncapi-alias-declaration-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      'const consumer = "orders.submitted";',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
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
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts does not use AsyncAPI property alias declarations as exact evidence', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-property-alias-declaration-false-');
  const providerRoot = await makeRepo('parallax-asyncapi-property-alias-declaration-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      'const consumer = { topic: "orders.submitted" };',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
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
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts does not treat AsyncAPI object property keys as bare aliases', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-property-bare-alias-false-');
  const providerRoot = await makeRepo('parallax-asyncapi-property-bare-alias-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      'const defaults = { topic: "orders.submitted" };',
      'export function startOrdersConsumer(bus: { subscribe(topic: string, handler: () => void): void }, topic: string) {',
      '  bus.subscribe(topic, () => undefined);',
      '  return defaults;',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
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
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts does not treat AsyncAPI member assignments as bare aliases', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-member-assignment-false-');
  const providerRoot = await makeRepo('parallax-asyncapi-member-assignment-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      'consumer.topic = "orders.submitted";',
      'export function startOrdersConsumer(bus: { subscribe(topic: string, handler: () => void): void }, topic: string) {',
      '  bus.subscribe(topic, () => undefined);',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
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
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts ignores AsyncAPI alias interpolation and placeholders', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-alias-placeholder-false-');
  const providerRoot = await makeRepo('parallax-asyncapi-alias-placeholder-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      'const ORDER_TOPIC = "orders.submitted";',
      'export function startOrdersConsumer(bus: { subscribe(topic: string, handler: () => void): void }) {',
      '  bus.subscribe(`${ORDER_TOPIC}.v2`, () => undefined);',
      '  bus.subscribe(`${ORDER_TOPIC}.*`, () => undefined);',
      '  const configLine = "consumer.topic=${ORDER_TOPIC}";',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
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
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts ignores AsyncAPI concatenated topic aliases', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-alias-concat-false-');
  const providerRoot = await makeRepo('parallax-asyncapi-alias-concat-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      'const ORDER_TOPIC = "orders.submitted" + ".v2";',
      'export function startOrdersConsumer(bus: { subscribe(topic: string, handler: () => void): void }) {',
      '  bus.subscribe(ORDER_TOPIC, () => undefined);',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
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
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts ignores computed JVM AsyncAPI topic constants', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-jvm-computed-constant-false-');
  const providerRoot = await makeRepo('parallax-asyncapi-jvm-computed-constant-provider-');
  await mkdir(path.join(consumerRoot, 'src/main/java/com/example/orders'), { recursive: true });
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/main/java/com/example/orders/OrdersListener.java'),
    [
      'package com.example.orders;',
      '',
      'class OrdersListener {',
      '  private static final String ORDER_TOPIC = "orders.submitted" + ".v2";',
      '',
      '  @KafkaListener(topics = ORDER_TOPIC)',
      '  void onOrderSubmitted(String payload) {}',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
      ''
    ].join('\n')
  );

  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });
  initWorkspace({ repoRoot: consumerRoot, name: 'platform', serviceName: 'fulfillment' });
  addWorkspaceRepo({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    localPath: providerRoot,
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts ignores AsyncAPI event addresses in source comments', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-comment-false-');
  const providerRoot = await makeRepo('parallax-asyncapi-comment-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      '// Example topic from docs: orders.submitted',
      'export const localOnly = true;',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
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
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts ignores AsyncAPI event addresses inside inline and block comments', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-inline-comment-false-');
  const providerRoot = await makeRepo('parallax-asyncapi-inline-comment-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      'export const localOnly = true; // orders.submitted',
      'export const alsoLocal = true; /* bus.subscribe("orders.submitted", () => undefined); */',
      '/*',
      'bus.subscribe("orders.submitted", () => undefined);',
      '*/',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
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
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts ignores AsyncAPI exact addresses without direction-bearing code', async () => {
  const consumerRoot = await makeRepo('parallax-asyncapi-unknown-direction-false-');
  const providerRoot = await makeRepo('parallax-asyncapi-unknown-direction-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });

  await writeFile(
    path.join(consumerRoot, 'src/orders-topic.ts'),
    [
      'export const topic = "orders.submitted";',
      'export const topicWithComment = "orders.submitted"; // bus.subscribe("orders.submitted")',
      'export const topicWithBlockComment = "orders.submitted"; /* producer.send({ topic: "orders.submitted" }) */',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(providerRoot, 'contracts/asyncapi.yaml'),
    [
      'asyncapi: 3.0.0',
      'info:',
      '  title: Orders events',
      '  version: 1.0.0',
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      '    messages:',
      '      OrderSubmitted:',
      '        payload:',
      '          type: object',
      'operations:',
      '  sendOrderSubmitted:',
      '    action: send',
      '    channel:',
      '      $ref: "#/channels/orderSubmitted"',
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
    serviceName: 'orders-events'
  });

  const result = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });

  assert.equal(result.links.length, 0);
});

test('resolveCrossRepoContracts skips stale consumer files instead of linking unindexed edits', async () => {
  const consumerRoot = await makeRepo('parallax-consumer-stale-');
  const providerRoot = await makeRepo('parallax-provider-stale-');
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
  const consumerRoot = await makeRepo('parallax-consumer-provider-stale-');
  const providerRoot = await makeRepo('parallax-provider-provider-stale-');
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
  const consumerRoot = await makeRepo('parallax-consumer-deleted-');
  const providerRoot = await makeRepo('parallax-provider-deleted-');
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
  const consumerRoot = await makeRepo('parallax-consumer-symlink-');
  const providerRoot = await makeRepo('parallax-provider-symlink-');
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'parallax-outside-consumer-'));
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
  const consumerRoot = await makeRepo('parallax-consumer-path-escape-');
  const providerRoot = await makeRepo('parallax-provider-path-escape-');
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'parallax-outside-path-'));
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
