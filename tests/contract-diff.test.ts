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
  analyzeContractDiff,
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

async function writeConsumerClient(repoRoot: string, routePath: string): Promise<void> {
  await writeFile(
    path.join(repoRoot, 'src/client.ts'),
    [
      'export async function loadUsers() {',
      `  return fetch("https://users.example.test${routePath}");`,
      '}',
      ''
    ].join('\n')
  );
}

async function writeOpenApiContract(repoRoot: string, routes: string[]): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  const routeLines = routes.flatMap((route) => [
    `  ${route}:`,
    '    get:',
    `      operationId: ${route.replace(/[^a-z0-9]/gi, '') || 'root'}`,
    '      responses:',
    "        '200':",
    '          description: ok'
  ]);
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'info:',
      '  title: Users API',
      '  version: 1.0.0',
      'paths:',
      ...routeLines,
      ''
    ].join('\n')
  );
}

async function writeOpenApiYamlUserSchemaContract(
  repoRoot: string,
  options: {
    responseRequired?: string[];
    requestRequired?: string[];
  } = {}
): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  const responseRequired = options.responseRequired ?? ['id', 'name'];
  const requestRequired = options.requestRequired ?? ['name'];
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.yaml'),
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
      '          content:',
      '            application/json:',
      '              schema:',
      "                $ref: '#/components/schemas/User'",
      '    post:',
      '      operationId: createUser',
      '      requestBody:',
      '        required: true',
      '        content:',
      '          application/json:',
      '            schema:',
      '              type: object',
      '              required:',
      ...requestRequired.map((propertyName) => `                - ${propertyName}`),
      '              properties:',
      '                name:',
      '                  type: string',
      '                email:',
      '                  type: string',
      '      responses:',
      "        '201':",
      '          description: created',
      'components:',
      '  schemas:',
      '    User:',
      '      type: object',
      '      required:',
      ...responseRequired.map((propertyName) => `        - ${propertyName}`),
      '      properties:',
      '        id:',
      '          type: string',
      '        name:',
      '          type: string',
      ''
    ].join('\n')
  );
}

async function writeOpenApiJsonContract(repoRoot: string, routes: string[]): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.json'),
    `${JSON.stringify({
      openapi: '3.0.0',
      info: {
        title: 'Users API',
        version: '1.0.0'
      },
      paths: Object.fromEntries(
        routes.map((route) => [
          route,
          {
            get: {
              operationId: route.replace(/[^a-z0-9]/gi, '') || 'root',
              responses: {
                200: {
                  description: 'ok'
                }
              }
            }
          }
        ])
      )
    }, null, 2)}\n`
  );
}

async function writeOpenApiJsonUserSchemaContract(
  repoRoot: string,
  options: {
    responseRequired?: string[];
    requestRequired?: string[];
  } = {}
): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.json'),
    `${JSON.stringify({
      openapi: '3.0.0',
      info: {
        title: 'Users API',
        version: '1.0.0'
      },
      paths: {
        '/api/users': {
          get: {
            operationId: 'listUsers',
            responses: {
              200: {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      $ref: '#/components/schemas/User'
                    }
                  }
                }
              }
            }
          },
          post: {
            operationId: 'createUser',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: options.requestRequired ?? ['name'],
                    properties: {
                      name: { type: 'string' },
                      email: { type: 'string' }
                    }
                  }
                }
              }
            },
            responses: {
              201: {
                description: 'created'
              }
            }
          }
        }
      },
      components: {
        schemas: {
          User: {
            type: 'object',
            required: options.responseRequired ?? ['id', 'name'],
            properties: {
              id: { type: 'string' },
              name: { type: 'string' }
            }
          }
        }
      }
    }, null, 2)}\n`
  );
}

async function writeOpenApiJsonChainedRefContract(repoRoot: string, userIdType: 'string' | 'integer'): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.json'),
    `${JSON.stringify({
      openapi: '3.0.0',
      info: {
        title: 'Users API',
        version: '1.0.0'
      },
      paths: {
        '/api/users': {
          get: {
            operationId: 'listUsers',
            responses: {
              200: {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      $ref: '#/components/schemas/UserResponse'
                    }
                  }
                }
              }
            }
          },
          post: {
            operationId: 'createUser',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['userId'],
                    properties: {
                      userId: { $ref: '#/components/schemas/UserIdAlias' }
                    }
                  }
                }
              }
            },
            responses: {
              201: {
                description: 'created'
              }
            }
          }
        }
      },
      components: {
        schemas: {
          UserResponse: {
            type: 'object',
            required: ['id', 'alternateId'],
            properties: {
              id: { $ref: '#/components/schemas/UserIdAlias' },
              alternateId: { $ref: '#/components/schemas/UserIdAlias' }
            }
          },
          UserIdAlias: {
            $ref: '#/components/schemas/UserId'
          },
          UserId: {
            type: userIdType
          }
        }
      }
    }, null, 2)}\n`
  );
}

async function writeMalformedOpenApiContract(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'info:',
      '  title: Users API',
      'paths:',
      '  /api/users',
      '    get:',
      ''
    ].join('\n')
  );
}

async function writeMalformedMethodOpenApiContract(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'paths:',
      '  /api/users:',
      '    get',
      ''
    ].join('\n')
  );
}

async function writeMalformedInlineMethodOpenApiContract(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'paths:',
      '  /api/users:',
      '    get: []',
      ''
    ].join('\n')
  );
}

async function writeEmptyMethodOpenApiContract(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'paths:',
      '  /api/status:',
      '    get:',
      ''
    ].join('\n')
  );
}

async function writeListMethodOpenApiContract(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'paths:',
      '  /api/status:',
      '    get:',
      '      - operationId: status',
      ''
    ].join('\n')
  );
}

async function writeInlineObjectOpenApiContract(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'paths:',
      '  /api/users:',
      '    get: { responses: { "200": { description: ok } } }',
      ''
    ].join('\n')
  );
}

async function writeInlineHashObjectOpenApiContract(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'paths:',
      '  /api/users:',
      '    get: { summary: "#status", operationId: listUsers, responses: { "200": { description: ok } } }',
      ''
    ].join('\n')
  );
}

async function writeCommentedOpenApiContract(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'paths: # endpoint map',
      '  /api/users: # user collection',
      '    get: { operationId: listUsers, responses: { "200": { description: ok } } }',
      "  '/v1/{name}:cancel': # action-style path",
      '    post:',
      '      operationId: cancelUser',
      ''
    ].join('\n')
  );
}

async function writeMethodBeforePathOpenApiContract(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'paths:',
      '  get: {}',
      ''
    ].join('\n')
  );
}

async function writeCallbackOpenApiContract(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'paths:',
      '  /api/users:',
      '    post:',
      '      operationId: createUser',
      '      callbacks:',
      '        onData:',
      "          '{$request.body#/callbackUrl}':",
      '            get:',
      '              operationId: callbackGet',
      '  /api/status:',
      '    get:',
      '      operationId: status',
      '      responses:',
      "        '200':",
      '          description: ok',
      ''
    ].join('\n')
  );
}

async function writeTabIndentedOpenApiContract(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'paths:',
      '\t/api/users:',
      '\t\tget:',
      '\t\t\toperationId: listUsers',
      ''
    ].join('\n')
  );
}

async function writeNestedPathsOnlyOpenApiContract(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'components:',
      '  schemas:',
      '    Example:',
      '      properties:',
      '        paths:',
      '          /nested-only:',
      '            get:',
      '              operationId: nestedOnly',
      ''
    ].join('\n')
  );
}

async function writeParserMalformedSameSurfaceOpenApiContract(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.yaml'),
    [
      'openapi: 3.0.0',
      'paths:',
      '  /api/users:',
      '    get:',
      '      operationId: listUsers',
      '      responses:',
      "        '200':",
      '          description: ok',
      '  /api/status:',
      '    get:',
      '      operationId: status',
      '      responses:',
      "        '200':",
      '          description: ok',
      'components:',
      '  schemas:',
      '    Broken:',
      '      type: "object',
      ''
    ].join('\n')
  );
}

async function writeNonOpenApiJsonContract(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/openapi.json'),
    `${JSON.stringify({ name: 'not-openapi', paths: [] }, null, 2)}\n`
  );
}

async function removeConsumerFromWorkspaceCatalog(consumerRoot: string, providerRoot: string): Promise<void> {
  const catalogPath = path.join(consumerRoot, '.impact-trace/workspace.json');
  const providerRelativePath = path.relative(realpathSync(path.dirname(catalogPath)), realpathSync(providerRoot)).split(path.sep).join('/');
  await writeFile(
    catalogPath,
    `${JSON.stringify({
      schemaVersion: 1,
      name: 'platform',
      repos: [
        {
          localPath: providerRelativePath,
          serviceName: 'users-api',
          trustPolicy: {
            readOnly: true
          }
        }
      ]
    }, null, 2)}\n`
  );
}

async function setupWorkspaceWithResolvedContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
  consumerReal: string;
  providerReal: string;
}> {
  const consumerRoot = await makeRepo('impact-trace-diff-consumer-');
  const providerRoot = await makeRepo('impact-trace-diff-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiContract(providerRoot, ['/api/users', '/api/status']);

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
  const resolved = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });
  assert.equal(resolved.links.length, 1);

  return {
    consumerRoot,
    providerRoot,
    consumerReal: realpathSync(consumerRoot),
    providerReal: realpathSync(providerRoot)
  };
}

async function setupWorkspaceWithResolvedYamlSchemaContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
  consumerReal: string;
  providerReal: string;
}> {
  const consumerRoot = await makeRepo('impact-trace-diff-yaml-schema-consumer-');
  const providerRoot = await makeRepo('impact-trace-diff-yaml-schema-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiYamlUserSchemaContract(providerRoot);

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
  const resolved = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });
  assert.equal(resolved.links.length, 1);

  return {
    consumerRoot,
    providerRoot,
    consumerReal: realpathSync(consumerRoot),
    providerReal: realpathSync(providerRoot)
  };
}

async function setupWorkspaceWithResolvedJsonContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('impact-trace-diff-json-consumer-');
  const providerRoot = await makeRepo('impact-trace-diff-json-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiJsonContract(providerRoot, ['/api/users']);

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
  const resolved = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });
  assert.equal(resolved.links.length, 1);

  return {
    consumerRoot,
    providerRoot
  };
}

async function setupWorkspaceWithResolvedJsonSchemaContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
  consumerReal: string;
  providerReal: string;
}> {
  const consumerRoot = await makeRepo('impact-trace-diff-json-schema-consumer-');
  const providerRoot = await makeRepo('impact-trace-diff-json-schema-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiJsonUserSchemaContract(providerRoot);

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
  const resolved = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });
  assert.equal(resolved.links.length, 1);

  return {
    consumerRoot,
    providerRoot,
    consumerReal: realpathSync(consumerRoot),
    providerReal: realpathSync(providerRoot)
  };
}

async function setupWorkspaceWithResolvedJsonChainedRefContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('impact-trace-diff-json-chain-consumer-');
  const providerRoot = await makeRepo('impact-trace-diff-json-chain-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiJsonChainedRefContract(providerRoot, 'string');

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
  const resolved = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });
  assert.equal(resolved.links.length, 1);

  return {
    consumerRoot,
    providerRoot
  };
}

test('analyzeContractDiff classifies removed OpenAPI endpoints as breaking and links impacted consumers', async () => {
  const { consumerRoot, providerRoot, consumerReal, providerReal } = await setupWorkspaceWithResolvedContract();
  await writeOpenApiContract(providerRoot, ['/api/status', '/api/admin']);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.equal(result.summary.breakingChangeCount, 1);
  assert.equal(result.summary.nonBreakingChangeCount, 1);
  assert.equal(result.summary.impactedConsumerCount, 1);
  assert.deepEqual(
    result.changes.map((change) => ({
      kind: change.kind,
      classification: change.classification,
      httpMethod: change.httpMethod,
      routePath: change.routePath
    })),
    [
      {
        kind: 'added_endpoint',
        classification: 'non-breaking',
        httpMethod: 'GET',
        routePath: '/api/admin'
      },
      {
        kind: 'removed_endpoint',
        classification: 'breaking',
        httpMethod: 'GET',
        routePath: '/api/users'
      }
    ]
  );
  assert.deepEqual(result.impactedConsumers, [
    {
      consumerService: 'web',
      consumerRepoPath: consumerReal,
      consumerPath: 'src/client.ts',
      providerService: 'users-api',
      providerRepoPath: providerReal,
      providerContractPath: 'contracts/openapi.yaml',
      httpMethod: 'GET',
      routePath: '/api/users',
      evidenceSnippet: 'return fetch("https://users.example.test/api/users");'
    }
  ]);

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT kind, confidence, provenance
         FROM cross_repo_links
         WHERE kind = ?`
      )
      .get('BREAKS_COMPATIBILITY_WITH') as { kind: string; confidence: string; provenance: string };
    assert.equal(row.kind, 'BREAKS_COMPATIBILITY_WITH');
    assert.equal(row.confidence, 'heuristic');
    assert.deepEqual(JSON.parse(row.provenance), {
      schemaVersion: 1,
      analyzer: 'contract-diff-v0',
      classification: 'breaking',
      consumer: {
        serviceName: 'web',
        repoPath: consumerReal,
        path: 'src/client.ts'
      },
      provider: {
        serviceName: 'users-api',
        repoPath: providerReal,
        contractPath: 'contracts/openapi.yaml'
      },
      change: {
        kind: 'removed_endpoint',
        method: 'GET',
        path: '/api/users',
        previousEndpointId: 'endpoint:yaml:GET /api/users'
      },
      evidence: {
        filePath: 'src/client.ts',
        snippet: 'return fetch("https://users.example.test/api/users");'
      }
    });
  } finally {
    db.close();
  }

  const cliRun = runCli(consumerRoot, [
    'workspace',
    'contract-diff',
    '--name',
    'platform',
    '--provider',
    'users-api',
    '--contract',
    'contracts/openapi.yaml',
    '--json'
  ]);
  assert.equal(cliRun.status, 0, `workspace contract-diff failed: ${cliRun.stderr}`);
  assert.deepEqual(JSON.parse(cliRun.stdout), result);
});

test('analyzeContractDiff treats added OpenAPI endpoints as non-breaking without creating breaking links', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedContract();
  await writeOpenApiContract(providerRoot, ['/api/users', '/api/status', '/api/admin']);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(result.summary.classification, 'non-breaking');
  assert.equal(result.summary.breakingChangeCount, 0);
  assert.equal(result.summary.nonBreakingChangeCount, 1);
  assert.equal(result.impactedConsumers.length, 0);

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const count = db
      .prepare('SELECT count(*) AS count FROM cross_repo_links WHERE kind = ?')
      .get('BREAKS_COMPATIBILITY_WITH') as { count: number };
    assert.equal(count.count, 0);
  } finally {
    db.close();
  }
});

test('analyzeContractDiff treats malformed OpenAPI YAML as unknown and preserves existing breaking links', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedContract();
  await writeOpenApiContract(providerRoot, ['/api/status']);
  const breakingResult = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });
  assert.equal(breakingResult.summary.classification, 'breaking');

  await writeMalformedOpenApiContract(providerRoot);
  const unknownResult = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(unknownResult.summary.classification, 'unknown');
  assert.deepEqual(unknownResult.changes, [
    {
      kind: 'unparsed_current_contract',
      classification: 'unknown',
      reason: 'current OpenAPI YAML could not be parsed: malformed path entry under paths'
    }
  ]);
  assert.ok(
    unknownResult.warnings.some((warning) => warning.includes('current OpenAPI YAML could not be parsed')),
    `expected YAML parse warning, got ${JSON.stringify(unknownResult.warnings)}`
  );

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const count = db
      .prepare('SELECT count(*) AS count FROM cross_repo_links WHERE kind = ?')
      .get('BREAKS_COMPATIBILITY_WITH') as { count: number };
    assert.equal(count.count, 1, 'unparsed current contracts must not delete existing breaking links');
  } finally {
    db.close();
  }
});

test('analyzeContractDiff treats YAML parser errors after endpoint scan success as unknown and preserves links', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedContract();
  await writeOpenApiContract(providerRoot, ['/api/status']);
  const breakingResult = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });
  assert.equal(breakingResult.summary.classification, 'breaking');

  await writeParserMalformedSameSurfaceOpenApiContract(providerRoot);
  const unknownResult = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(unknownResult.summary.classification, 'unknown');
  assert.equal(unknownResult.summary.impactedConsumerCount, 0);
  assert.equal(unknownResult.changes.length, 1);
  assert.equal(unknownResult.changes[0]?.kind, 'unparsed_current_contract');
  assert.match(unknownResult.changes[0]?.reason ?? '', /current OpenAPI YAML could not be parsed/);
  assert.ok(
    unknownResult.warnings.some((warning) => warning.includes('current OpenAPI YAML could not be parsed')),
    `expected YAML parse warning, got ${JSON.stringify(unknownResult.warnings)}`
  );

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const count = db
      .prepare('SELECT count(*) AS count FROM cross_repo_links WHERE kind = ?')
      .get('BREAKS_COMPATIBILITY_WITH') as { count: number };
    assert.equal(count.count, 1, 'YAML parser errors must not delete existing breaking links');
  } finally {
    db.close();
  }
});

test('analyzeContractDiff treats malformed OpenAPI YAML method entries as unknown', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedContract();
  await writeMalformedMethodOpenApiContract(providerRoot);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(result.summary.classification, 'unknown');
  assert.deepEqual(result.changes, [
    {
      kind: 'unparsed_current_contract',
      classification: 'unknown',
      reason: 'current OpenAPI YAML could not be parsed: malformed method entry under paths'
    }
  ]);
});

test('analyzeContractDiff treats non-object inline OpenAPI YAML operations as unknown', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedContract();
  await writeMalformedInlineMethodOpenApiContract(providerRoot);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(result.summary.classification, 'unknown');
  assert.deepEqual(result.changes, [
    {
      kind: 'unparsed_current_contract',
      classification: 'unknown',
      reason: 'current OpenAPI YAML could not be parsed: operation must be an object under paths'
    }
  ]);
});

test('analyzeContractDiff treats empty OpenAPI YAML operations as unknown and preserves links', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedContract();
  await writeOpenApiContract(providerRoot, ['/api/status']);
  const breakingResult = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });
  assert.equal(breakingResult.summary.classification, 'breaking');

  await writeEmptyMethodOpenApiContract(providerRoot);
  const unknownResult = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(unknownResult.summary.classification, 'unknown');
  assert.deepEqual(unknownResult.changes, [
    {
      kind: 'unparsed_current_contract',
      classification: 'unknown',
      reason: 'current OpenAPI YAML could not be parsed: operation must be an object under paths'
    }
  ]);

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const count = db
      .prepare('SELECT count(*) AS count FROM cross_repo_links WHERE kind = ?')
      .get('BREAKS_COMPATIBILITY_WITH') as { count: number };
    assert.equal(count.count, 1, 'empty current YAML operations must not delete existing breaking links');
  } finally {
    db.close();
  }
});

test('analyzeContractDiff treats list-shaped OpenAPI YAML operations as unknown', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedContract();
  await writeListMethodOpenApiContract(providerRoot);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(result.summary.classification, 'unknown');
  assert.deepEqual(result.changes, [
    {
      kind: 'unparsed_current_contract',
      classification: 'unknown',
      reason: 'current OpenAPI YAML could not be parsed: operation must be an object under paths'
    }
  ]);
});

test('analyzeContractDiff recognizes inline OpenAPI YAML operation objects without false removals', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedContract();
  await writeInlineObjectOpenApiContract(providerRoot);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(
    result.changes.map((change) => ({
      kind: change.kind,
      classification: change.classification,
      httpMethod: change.httpMethod,
      routePath: change.routePath
    })),
    [
      {
        kind: 'removed_endpoint',
        classification: 'breaking',
        httpMethod: 'GET',
        routePath: '/api/status'
      }
    ]
  );
  assert.equal(
    result.changes.some((change) => change.routePath === '/api/users' && change.kind === 'removed_endpoint'),
    false
  );
});

test('analyzeContractDiff does not treat quoted hash in inline YAML operations as a comment', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedContract();
  await writeInlineHashObjectOpenApiContract(providerRoot);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(
    result.changes.map((change) => ({
      kind: change.kind,
      classification: change.classification,
      httpMethod: change.httpMethod,
      routePath: change.routePath
    })),
    [
      {
        kind: 'removed_endpoint',
        classification: 'breaking',
        httpMethod: 'GET',
        routePath: '/api/status'
      }
    ]
  );
});

test('analyzeContractDiff recognizes commented paths, colon paths, and inline operation objects', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedContract();
  await writeCommentedOpenApiContract(providerRoot);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(
    result.changes.map((change) => ({
      kind: change.kind,
      classification: change.classification,
      httpMethod: change.httpMethod,
      routePath: change.routePath
    })),
    [
      {
        kind: 'added_endpoint',
        classification: 'non-breaking',
        httpMethod: 'POST',
        routePath: '/v1/{name}:cancel'
      },
      {
        kind: 'removed_endpoint',
        classification: 'breaking',
        httpMethod: 'GET',
        routePath: '/api/status'
      }
    ]
  );
});

test('analyzeContractDiff treats inline method entries before any path as unknown', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedContract();
  await writeMethodBeforePathOpenApiContract(providerRoot);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(result.summary.classification, 'unknown');
  assert.deepEqual(result.changes, [
    {
      kind: 'unparsed_current_contract',
      classification: 'unknown',
      reason: 'current OpenAPI YAML could not be parsed: method entry appears before a path'
    }
  ]);
});

test('analyzeContractDiff ignores nested callback method keys when comparing endpoint surface', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedContract();
  await writeCallbackOpenApiContract(providerRoot);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.equal(result.summary.breakingChangeCount, 1);
  assert.equal(result.summary.nonBreakingChangeCount, 1);
  assert.equal(result.summary.impactedConsumerCount, 1);
  assert.deepEqual(
    result.changes.map((change) => ({
      kind: change.kind,
      classification: change.classification,
      httpMethod: change.httpMethod,
      routePath: change.routePath
    })),
    [
      {
        kind: 'added_endpoint',
        classification: 'non-breaking',
        httpMethod: 'POST',
        routePath: '/api/users'
      },
      {
        kind: 'removed_endpoint',
        classification: 'breaking',
        httpMethod: 'GET',
        routePath: '/api/users'
      }
    ]
  );
});

test('analyzeContractDiff treats tab-indented OpenAPI YAML as unknown without false removals', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedContract();
  await writeTabIndentedOpenApiContract(providerRoot);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(result.summary.classification, 'unknown');
  assert.deepEqual(result.changes, [
    {
      kind: 'unparsed_current_contract',
      classification: 'unknown',
      reason: 'current OpenAPI YAML could not be parsed: tabs are not supported for indentation'
    }
  ]);
});

test('analyzeContractDiff ignores nested schema paths blocks when finding OpenAPI surface', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedContract();
  await writeNestedPathsOnlyOpenApiContract(providerRoot);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(result.summary.classification, 'unknown');
  assert.deepEqual(result.changes, [
    {
      kind: 'unparsed_current_contract',
      classification: 'unknown',
      reason: 'current OpenAPI YAML could not be parsed: missing paths object'
    }
  ]);
});

test('analyzeContractDiff ignores stale consumer links whose repos are no longer in the workspace catalog', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedContract();
  await removeConsumerFromWorkspaceCatalog(consumerRoot, providerRoot);
  await writeOpenApiContract(providerRoot, ['/api/status']);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.equal(result.summary.breakingChangeCount, 1);
  assert.equal(result.summary.impactedConsumerCount, 0);
  assert.deepEqual(result.impactedConsumers, []);

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const count = db
      .prepare('SELECT count(*) AS count FROM cross_repo_links WHERE kind = ?')
      .get('BREAKS_COMPATIBILITY_WITH') as { count: number };
    assert.equal(count.count, 0);
  } finally {
    db.close();
  }
});

test('analyzeContractDiff classifies removed OpenAPI JSON endpoints as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedJsonContract();

  await writeOpenApiJsonContract(providerRoot, []);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.equal(result.summary.breakingChangeCount, 1);
  assert.equal(result.summary.impactedConsumerCount, 1);
  assert.deepEqual(result.changes, [
    {
      kind: 'removed_endpoint',
      classification: 'breaking',
      reason: 'endpoint removed from current contract',
      httpMethod: 'GET',
      routePath: '/api/users',
      previousEndpointId: 'endpoint:json:GET /api/users'
    }
  ]);
});

test('analyzeContractDiff classifies removed OpenAPI JSON response required properties as breaking', async () => {
  const { consumerRoot, providerRoot, consumerReal, providerReal } =
    await setupWorkspaceWithResolvedJsonSchemaContract();
  await writeOpenApiJsonUserSchemaContract(providerRoot, { responseRequired: ['id'] });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.equal(result.summary.breakingChangeCount, 1);
  assert.equal(result.summary.unknownChangeCount, 0);
  assert.equal(result.summary.impactedConsumerCount, 1);
  assert.deepEqual(result.changes, [
    {
      kind: 'removed_response_required_property',
      classification: 'breaking',
      reason: 'response required property removed from current contract',
      httpMethod: 'GET',
      routePath: '/api/users',
      statusCode: '200',
      propertyName: 'name',
      schemaPath: 'responses.200.body.required.name'
    }
  ]);
  assert.deepEqual(result.impactedConsumers, [
    {
      consumerService: 'web',
      consumerRepoPath: consumerReal,
      consumerPath: 'src/client.ts',
      providerService: 'users-api',
      providerRepoPath: providerReal,
      providerContractPath: 'contracts/openapi.json',
      httpMethod: 'GET',
      routePath: '/api/users',
      evidenceSnippet: 'return fetch("https://users.example.test/api/users");'
    }
  ]);

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT kind, confidence, provenance
         FROM cross_repo_links
         WHERE kind = ?`
      )
      .get('BREAKS_COMPATIBILITY_WITH') as { kind: string; confidence: string; provenance: string };
    assert.equal(row.kind, 'BREAKS_COMPATIBILITY_WITH');
    assert.equal(row.confidence, 'heuristic');
    assert.deepEqual(JSON.parse(row.provenance), {
      schemaVersion: 1,
      analyzer: 'contract-diff-v0',
      classification: 'breaking',
      consumer: {
        serviceName: 'web',
        repoPath: consumerReal,
        path: 'src/client.ts'
      },
      provider: {
        serviceName: 'users-api',
        repoPath: providerReal,
        contractPath: 'contracts/openapi.json'
      },
      change: {
        kind: 'removed_response_required_property',
        method: 'GET',
        path: '/api/users',
        statusCode: '200',
        propertyName: 'name',
        schemaPath: 'responses.200.body.required.name'
      },
      evidence: {
        filePath: 'src/client.ts',
        snippet: 'return fetch("https://users.example.test/api/users");'
      }
    });
  } finally {
    db.close();
  }
});

test('analyzeContractDiff classifies removed OpenAPI YAML response required properties as breaking', async () => {
  const { consumerRoot, providerRoot, consumerReal, providerReal } =
    await setupWorkspaceWithResolvedYamlSchemaContract();
  await writeOpenApiYamlUserSchemaContract(providerRoot, { responseRequired: ['id'] });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.equal(result.summary.breakingChangeCount, 1);
  assert.equal(result.summary.unknownChangeCount, 0);
  assert.equal(result.summary.impactedConsumerCount, 1);
  assert.deepEqual(result.changes, [
    {
      kind: 'removed_response_required_property',
      classification: 'breaking',
      reason: 'response required property removed from current contract',
      httpMethod: 'GET',
      routePath: '/api/users',
      statusCode: '200',
      propertyName: 'name',
      schemaPath: 'responses.200.body.required.name'
    }
  ]);
  assert.deepEqual(result.impactedConsumers, [
    {
      consumerService: 'web',
      consumerRepoPath: consumerReal,
      consumerPath: 'src/client.ts',
      providerService: 'users-api',
      providerRepoPath: providerReal,
      providerContractPath: 'contracts/openapi.yaml',
      httpMethod: 'GET',
      routePath: '/api/users',
      evidenceSnippet: 'return fetch("https://users.example.test/api/users");'
    }
  ]);
});

test('analyzeContractDiff classifies added OpenAPI JSON request required properties as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedJsonSchemaContract();
  await writeOpenApiJsonUserSchemaContract(providerRoot, { requestRequired: ['name', 'email'] });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(
    result.changes.filter((change) => change.kind === 'added_request_required_property'),
    [
      {
        kind: 'added_request_required_property',
        classification: 'breaking',
        reason: 'request required property added to current contract',
        httpMethod: 'POST',
        routePath: '/api/users',
        propertyName: 'email',
        schemaPath: 'requestBody.required.email'
      }
    ]
  );
});

test('analyzeContractDiff classifies added OpenAPI YAML request required properties as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedYamlSchemaContract();
  await writeOpenApiYamlUserSchemaContract(providerRoot, { requestRequired: ['name', 'email'] });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(
    result.changes.filter((change) => change.kind === 'added_request_required_property'),
    [
      {
        kind: 'added_request_required_property',
        classification: 'breaking',
        reason: 'request required property added to current contract',
        httpMethod: 'POST',
        routePath: '/api/users',
        propertyName: 'email',
        schemaPath: 'requestBody.required.email'
      }
    ]
  );
});

test('analyzeContractDiff follows chained duplicate OpenAPI JSON refs for request and response type changes', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedJsonChainedRefContract();
  await writeOpenApiJsonChainedRefContract(providerRoot, 'integer');

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.equal(result.summary.breakingChangeCount, 3);
  assert.equal(result.summary.unknownChangeCount, 0);
  assert.equal(result.summary.impactedConsumerCount, 1);
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'response property type changed in current contract',
      httpMethod: 'GET',
      routePath: '/api/users',
      statusCode: '200',
      propertyName: 'alternateId',
      schemaPath: 'responses.200.body.properties.alternateId',
      previousSchemaType: 'string',
      currentSchemaType: 'integer'
    },
    {
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'response property type changed in current contract',
      httpMethod: 'GET',
      routePath: '/api/users',
      statusCode: '200',
      propertyName: 'id',
      schemaPath: 'responses.200.body.properties.id',
      previousSchemaType: 'string',
      currentSchemaType: 'integer'
    },
    {
      kind: 'changed_request_property_type',
      classification: 'breaking',
      reason: 'request property type changed in current contract',
      httpMethod: 'POST',
      routePath: '/api/users',
      propertyName: 'userId',
      schemaPath: 'requestBody.properties.userId',
      previousSchemaType: 'string',
      currentSchemaType: 'integer'
    }
  ]);
});

test('analyzeContractDiff treats non-OpenAPI JSON as unknown and preserves existing breaking links', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedJsonContract();
  await writeOpenApiJsonContract(providerRoot, []);
  const breakingResult = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });
  assert.equal(breakingResult.summary.classification, 'breaking');

  await writeNonOpenApiJsonContract(providerRoot);
  const unknownResult = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });

  assert.equal(unknownResult.summary.classification, 'unknown');
  assert.deepEqual(unknownResult.changes, [
    {
      kind: 'unparsed_current_contract',
      classification: 'unknown',
      reason: 'current OpenAPI JSON could not be parsed: missing OpenAPI version marker'
    }
  ]);

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const count = db
      .prepare('SELECT count(*) AS count FROM cross_repo_links WHERE kind = ?')
      .get('BREAKS_COMPATIBILITY_WITH') as { count: number };
    assert.equal(count.count, 1, 'non-OpenAPI current JSON must not delete existing breaking links');
  } finally {
    db.close();
  }
});

test('analyzeContractDiff does not read post-index symlinked contracts outside the provider repo root', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedContract();
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-diff-outside-contract-'));
  await writeOpenApiContract(outsideRoot, ['/api/status']);
  await unlink(path.join(providerRoot, 'contracts/openapi.yaml'));
  await symlink(path.join(outsideRoot, 'contracts/openapi.yaml'), path.join(providerRoot, 'contracts/openapi.yaml'));

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(result.summary.classification, 'unknown');
  assert.equal(result.changes.length, 1);
  assert.equal(result.impactedConsumers.length, 0);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes('contract file skipped') && warning.includes('resolves outside repo root')
    ),
    `expected symlink warning, got ${JSON.stringify(result.warnings)}`
  );
});

test('CLI help lists workspace contract-diff flags', async () => {
  const repoRoot = await makeRepo('impact-trace-diff-help-');

  const cliRun = runCli(repoRoot, ['--help']);

  assert.equal(cliRun.status, 0);
  assert.match(cliRun.stdout, /workspace contract-diff --contract <path>/);
  assert.match(cliRun.stdout, /--provider-path <path>/);
});
