import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  addWorkspaceRepo,
  analyzeContractDiff,
  analyzeDiff,
  exportImpactGraph,
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

async function makeRepoAt(repoRoot: string, label: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'README.md'), `${label}\n`);
}

function assertPublicJsonExcludesPath(publicJson: string, privatePath: string): void {
  const escapedPrivatePath = JSON.stringify(privatePath).slice(1, -1);
  assert.ok(!publicJson.includes(privatePath), `public JSON leaked private path: ${privatePath}`);
  assert.ok(!publicJson.includes(escapedPrivatePath), `public JSON leaked escaped private path: ${privatePath}`);
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

async function writeConsumerClientForRoutes(repoRoot: string, routePaths: string[]): Promise<void> {
  await writeFile(
    path.join(repoRoot, 'src/client.ts'),
    [
      'export async function loadResources() {',
      '  return Promise.all([',
      ...routePaths.map((routePath) => `    fetch("https://users.example.test${routePath}"),`),
      '  ]);',
      '}',
      ''
    ].join('\n')
  );
}

async function writeProtobufContract(
  repoRoot: string,
  options: {
    includeListUsers?: boolean;
    includeCommentedLegacyRpc?: boolean;
    includeNestedUserDetails?: boolean;
    includeNestedUserNickname?: boolean;
    includeUserContactOneof?: boolean;
    includeUserEmailOneofField?: boolean;
    userEmailOneofFieldType?: 'string' | 'int64';
    userNameFieldType?: 'string' | 'int64';
    includeUserNameField?: boolean;
  } = {}
): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  const includeListUsers = options.includeListUsers ?? true;
  const includeNestedUserDetails = options.includeNestedUserDetails ?? false;
  const includeNestedUserNickname = options.includeNestedUserNickname ?? true;
  const includeUserContactOneof = options.includeUserContactOneof ?? false;
  const includeUserEmailOneofField = options.includeUserEmailOneofField ?? true;
  const includeUserNameField = options.includeUserNameField ?? true;
  await writeFile(
    path.join(repoRoot, 'contracts/users.proto'),
    [
      'syntax = "proto3";',
      '',
      'package users.v1;',
      '',
      'service UserService {',
      '  rpc GetUser (GetUserRequest) returns (User);',
      ...(options.includeCommentedLegacyRpc ? ['  // rpc LegacyUser (GetUserRequest) returns (User);'] : []),
      ...(includeListUsers ? ['  rpc ListUsers (ListUsersRequest) returns (ListUsersResponse);'] : []),
      '}',
      '',
      'message GetUserRequest {',
      '  string id = 1;',
      '}',
      '',
      'message ListUsersRequest {',
      '  string cursor = 1;',
      '}',
      '',
      'message ListUsersResponse {',
      '  repeated User users = 1;',
      '}',
      '',
      'message User {',
      '  string id = 1;',
      ...(includeUserNameField ? [`  ${options.userNameFieldType ?? 'string'} name = 2;`] : []),
      ...(includeNestedUserDetails
        ? [
          '  message Details {',
          ...(includeNestedUserNickname ? ['    string nickname = 1;'] : []),
          '  }',
          '  Details details = 3;'
        ]
        : []),
      ...(includeUserContactOneof
        ? [
          '  oneof contact {',
          ...(includeUserEmailOneofField ? [`    ${options.userEmailOneofFieldType ?? 'string'} email = 4;`] : []),
          '    string phone = 5;',
          '  }'
        ]
        : []),
      '}',
      ''
    ].join('\n')
  );
}

async function writeGraphqlContract(
  repoRoot: string,
  options: {
    includeUsersField?: boolean;
    includeMutation?: boolean;
    includeUserNameField?: boolean;
    userNameFieldType?: 'String!' | 'Int!';
    userQueryReturnType?: 'User' | 'User!';
    defaultUserIdArg?: boolean;
    includeUserProfileField?: boolean;
    includeProfileBioField?: boolean;
    profileBioFieldType?: 'String!' | 'Int!';
    includeRequiredInputEmail?: boolean;
    includeDefaultedInputEmail?: boolean;
  } = {}
): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  const includeUsersField = options.includeUsersField ?? true;
  const includeMutation = options.includeMutation ?? false;
  const includeUserNameField = options.includeUserNameField ?? true;
  const includeUserProfileField = options.includeUserProfileField ?? false;
  const includeProfileBioField = options.includeProfileBioField ?? true;
  const userIdArg = options.defaultUserIdArg ? 'id: ID! = "default-user"' : 'id: ID!';
  await writeFile(
    path.join(repoRoot, 'contracts/schema.graphql'),
    [
      'type Query {',
      `  user(${userIdArg}): ${options.userQueryReturnType ?? 'User'}`,
      ...(includeUsersField ? ['  users: [User!]!'] : []),
      '}',
      '',
      ...(includeMutation
        ? [
          'type Mutation {',
          '  createUser(input: CreateUserInput!): User',
          '}',
          ''
        ]
        : []),
      'type User {',
      '  id: ID!',
      ...(includeUserNameField ? [`  name: ${options.userNameFieldType ?? 'String!'}`] : []),
      ...(includeUserProfileField ? ['  profile: Profile'] : []),
      '}',
      ...(includeUserProfileField
        ? [
          '',
          'type Profile {',
          ...(includeProfileBioField ? [`  bio: ${options.profileBioFieldType ?? 'String!'}`] : []),
          '}'
        ]
        : []),
      '',
      'input CreateUserInput {',
      '  name: String!',
      ...(options.includeRequiredInputEmail
        ? ['  email: String!']
        : options.includeDefaultedInputEmail
          ? ['  email: String! = ""']
          : []),
      '}',
      ''
    ].join('\n')
  );
}

type AsyncApiContractOptions = {
  includeOrderSubmittedOperation?: boolean;
  operationAction?: string;
  includeCustomerEmailField?: boolean;
  customerEmailFieldType?: 'string' | 'integer';
  includeRequiredCustomerEmail?: boolean;
  includeRequiredCurrency?: boolean;
};

async function writeAsyncApiContract(
  repoRoot: string,
  options: AsyncApiContractOptions = {}
): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  const includeOrderSubmittedOperation = options.includeOrderSubmittedOperation ?? true;
  const includeCustomerEmailField = options.includeCustomerEmailField ?? true;
  const includeRequiredCustomerEmail = options.includeRequiredCustomerEmail ?? true;
  await writeFile(
    path.join(repoRoot, 'contracts/asyncapi.yaml'),
    [
      "asyncapi: '3.0.0'",
      'info:',
      '  title: Orders Events',
      "  version: '1.0.0'",
      ...(includeOrderSubmittedOperation
        ? [
          'channels:',
          '  orderSubmitted:',
          '    address: orders.submitted',
          '    messages:',
          '      OrderSubmitted:',
          "        $ref: '#/components/messages/OrderSubmitted'"
        ]
        : ['channels: {}']),
      ...(includeOrderSubmittedOperation
        ? [
          'operations:',
          '  publishOrderSubmitted:',
          `    action: ${options.operationAction ?? 'send'}`,
          '    channel:',
          "      $ref: '#/channels/orderSubmitted'",
          '    messages:',
          "      - $ref: '#/channels/orderSubmitted/messages/OrderSubmitted'"
        ]
        : ['operations: {}']),
      'components:',
      '  messages:',
      '    OrderSubmitted:',
      '      payload:',
      '        type: object',
      '        required:',
      '          - orderId',
      ...(includeRequiredCustomerEmail && includeCustomerEmailField ? ['          - customerEmail'] : []),
      ...(options.includeRequiredCurrency ? ['          - currency'] : []),
      '        properties:',
      '          orderId:',
      '            type: string',
      ...(includeCustomerEmailField
        ? [
          '          customerEmail:',
          `            type: ${options.customerEmailFieldType ?? 'string'}`
        ]
        : []),
      ...(options.includeRequiredCurrency
        ? [
          '          currency:',
          '            type: string'
        ]
        : []),
      ''
    ].join('\n')
  );
}

async function writeAsyncApiJsonContract(
  repoRoot: string,
  options: AsyncApiContractOptions = {}
): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  const includeOrderSubmittedOperation = options.includeOrderSubmittedOperation ?? true;
  const includeCustomerEmailField = options.includeCustomerEmailField ?? true;
  const includeRequiredCustomerEmail = options.includeRequiredCustomerEmail ?? true;
  const required = [
    'orderId',
    ...(includeRequiredCustomerEmail && includeCustomerEmailField ? ['customerEmail'] : []),
    ...(options.includeRequiredCurrency ? ['currency'] : [])
  ];
  const properties: Record<string, { type: string }> = {
    orderId: { type: 'string' },
    ...(includeCustomerEmailField
      ? { customerEmail: { type: options.customerEmailFieldType ?? 'string' } }
      : {}),
    ...(options.includeRequiredCurrency ? { currency: { type: 'string' } } : {})
  };
  const document = {
    asyncapi: '3.0.0',
    info: {
      title: 'Orders Events',
      version: '1.0.0'
    },
    ...(includeOrderSubmittedOperation
      ? {
          channels: {
            orderSubmitted: {
              address: 'orders.submitted',
              messages: {
                OrderSubmitted: {
                  $ref: '#/components/messages/OrderSubmitted'
                }
              }
            }
          },
          operations: {
            publishOrderSubmitted: {
              action: options.operationAction ?? 'send',
              channel: {
                $ref: '#/channels/orderSubmitted'
              },
              messages: [
                {
                  $ref: '#/channels/orderSubmitted/messages/OrderSubmitted'
                }
              ]
            }
          }
        }
      : {
          channels: {},
          operations: {}
        }),
    components: {
      messages: {
        OrderSubmitted: {
          payload: {
            type: 'object',
            required,
            properties
          }
        }
      }
    }
  };
  await writeFile(path.join(repoRoot, 'contracts/asyncapi.json'), `${JSON.stringify(document, null, 2)}\n`);
}

async function writeMalformedAsyncApiYamlOperationsContract(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/asyncapi.yaml'),
    [
      "asyncapi: '3.0.0'",
      'info:',
      '  title: Orders Events',
      "  version: '1.0.0'",
      'channels:',
      '  orderSubmitted:',
      '    address: orders.submitted',
      'operations: []',
      'components:',
      '  messages:',
      '    OrderSubmitted:',
      '      payload:',
      '        type: object',
      '        required:',
      '          - orderId',
      '        properties:',
      '          orderId:',
      '            type: string',
      ''
    ].join('\n')
  );
}

async function writeMalformedAsyncApiJsonOperationContract(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'contracts/asyncapi.json'),
    `${JSON.stringify({
      asyncapi: '3.0.0',
      info: {
        title: 'Orders Events',
        version: '1.0.0'
      },
      channels: {
        orderSubmitted: {
          address: 'orders.submitted'
        }
      },
      operations: {
        publishOrderSubmitted: {
          action: 'send'
        }
      },
      components: {
        messages: {
          OrderSubmitted: {
            payload: {
              type: 'object',
              required: ['orderId'],
              properties: {
                orderId: { type: 'string' }
              }
            }
          }
        }
      }
    }, null, 2)}\n`
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

async function writeOpenApiJsonNestedSchemaContract(
  repoRoot: string,
  options: {
    responseProfileRequired?: string[];
    responseMemberIdType?: 'string' | 'integer';
    requestProfileRequired?: string[];
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
                      type: 'object',
                      required: ['id', 'profile', 'members'],
                      properties: {
                        id: { type: 'string' },
                        profile: {
                          type: 'object',
                          required: options.responseProfileRequired ?? ['displayName'],
                          properties: {
                            displayName: { type: 'string' }
                          }
                        },
                        members: {
                          type: 'array',
                          items: {
                            type: 'object',
                            required: ['id'],
                            properties: {
                              id: { type: options.responseMemberIdType ?? 'string' }
                            }
                          }
                        }
                      }
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
                    required: ['profile'],
                    properties: {
                      profile: {
                        type: 'object',
                        required: options.requestProfileRequired ?? ['displayName'],
                        properties: {
                          displayName: { type: 'string' },
                          locale: { type: 'string' }
                        }
                      }
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
      }
    }, null, 2)}\n`
  );
}

async function writeOpenApiYamlNestedSchemaContract(
  repoRoot: string,
  options: {
    responseProfileRequired?: string[];
    responseMemberIdType?: 'string' | 'integer';
    requestProfileRequired?: string[];
  } = {}
): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  const responseProfileRequired = options.responseProfileRequired ?? ['displayName'];
  const requestProfileRequired = options.requestProfileRequired ?? ['displayName'];
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
      '                type: object',
      '                required:',
      '                  - id',
      '                  - profile',
      '                  - members',
      '                properties:',
      '                  id:',
      '                    type: string',
      '                  profile:',
      '                    type: object',
      '                    required:',
      ...responseProfileRequired.map((propertyName) => `                      - ${propertyName}`),
      '                    properties:',
      '                      displayName:',
      '                        type: string',
      '                  members:',
      '                    type: array',
      '                    items:',
      '                      type: object',
      '                      required:',
      '                        - id',
      '                      properties:',
      '                        id:',
      `                          type: ${options.responseMemberIdType ?? 'string'}`,
      '    post:',
      '      operationId: createUser',
      '      requestBody:',
      '        required: true',
      '        content:',
      '          application/json:',
      '            schema:',
      '              type: object',
      '              required:',
      '                - profile',
      '              properties:',
      '                profile:',
      '                  type: object',
      '                  required:',
      ...requestProfileRequired.map((propertyName) => `                    - ${propertyName}`),
      '                  properties:',
      '                    displayName:',
      '                      type: string',
      '                    locale:',
      '                      type: string',
      '      responses:',
      "        '201':",
      '          description: created',
      ''
    ].join('\n')
  );
}

async function writeOpenApiJsonAllOfSchemaContract(repoRoot: string, displayNameType: 'string' | 'integer'): Promise<void> {
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
          }
        }
      },
      components: {
        schemas: {
          UserResponse: {
            allOf: [
              { $ref: '#/components/schemas/BaseUser' },
              {
                type: 'object',
                required: ['profile'],
                properties: {
                  profile: { $ref: '#/components/schemas/UserProfile' }
                }
              }
            ]
          },
          BaseUser: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string' }
            }
          },
          UserProfile: {
            type: 'object',
            required: ['displayName'],
            properties: {
              displayName: { type: displayNameType }
            }
          }
        }
      }
    }, null, 2)}\n`
  );
}

async function writeOpenApiJsonOneOfSchemaContract(repoRoot: string, includeIntegerAlternative: boolean): Promise<void> {
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
                      type: 'object',
                      required: ['externalId'],
                      properties: {
                        externalId: {
                          oneOf: [
                            { type: 'string' },
                            ...(includeIntegerAlternative ? [{ type: 'integer' }] : [])
                          ]
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }, null, 2)}\n`
  );
}

async function writeOpenApiJsonAnyOfSchemaContract(repoRoot: string, includeIntegerAlternative: boolean): Promise<void> {
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
                      type: 'object',
                      required: ['externalId'],
                      properties: {
                        externalId: {
                          anyOf: [
                            { type: 'string' },
                            ...(includeIntegerAlternative ? [{ type: 'integer' }] : [])
                          ]
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }, null, 2)}\n`
  );
}

async function writeOpenApiJsonRootArraySchemaContract(repoRoot: string, itemIdType: 'string' | 'integer'): Promise<void> {
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
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['id'],
                        properties: {
                          id: { type: itemIdType }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }, null, 2)}\n`
  );
}

async function writeOpenApiJsonRootOneOfSchemaContract(repoRoot: string, includeIntegerAlternative: boolean): Promise<void> {
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
                      oneOf: [
                        {
                          type: 'object',
                          required: ['id'],
                          properties: {
                            id: { type: 'string' }
                          }
                        },
                        ...(includeIntegerAlternative
                          ? [{
                              type: 'object',
                              required: ['id'],
                              properties: {
                                id: { type: 'integer' }
                              }
                            }]
                          : [])
                      ]
                    }
                  }
                }
              }
            }
          }
        }
      }
    }, null, 2)}\n`
  );
}

async function writeOpenApiJsonRootOneOfRequiredResponseContract(repoRoot: string, required: string[]): Promise<void> {
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
                      oneOf: [
                        {
                          type: 'object',
                          required,
                          properties: {
                            id: { type: 'string' },
                            name: { type: 'string' }
                          }
                        }
                      ]
                    }
                  }
                }
              }
            }
          }
        }
      }
    }, null, 2)}\n`
  );
}

async function writeOpenApiJsonRootOneOfRequiredOnlyResponseContract(
  repoRoot: string,
  required: string[]
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
                      oneOf: [
                        {
                          type: 'object',
                          required
                        }
                      ]
                    }
                  }
                }
              }
            }
          }
        }
      }
    }, null, 2)}\n`
  );
}

async function writeOpenApiJsonRootAnyOfRequiredRequestContract(repoRoot: string, required: string[]): Promise<void> {
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
          post: {
            operationId: 'createUser',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    anyOf: [
                      {
                        type: 'object',
                        required,
                        properties: {
                          id: { type: 'string' },
                          name: { type: 'string' }
                        }
                      }
                    ]
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
      }
    }, null, 2)}\n`
  );
}

async function writeOpenApiJsonRootAnyOfRequiredOnlyRequestContract(
  repoRoot: string,
  required: string[]
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
          post: {
            operationId: 'createUser',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    anyOf: [
                      {
                        type: 'object',
                        required
                      }
                    ]
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
      }
    }, null, 2)}\n`
  );
}

async function writeOpenApiJsonArrayPointerRefContract(repoRoot: string, idType: 'string' | 'integer'): Promise<void> {
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
                      $ref: '#/components/schemas/UserEnvelope/allOf/0'
                    }
                  }
                }
              }
            }
          }
        }
      },
      components: {
        schemas: {
          UserEnvelope: {
            allOf: [
              {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: idType }
                }
              }
            ]
          }
        }
      }
    }, null, 2)}\n`
  );
}

async function writeOpenApiJsonOverlappingAllOfContract(
  repoRoot: string,
  order: 'string-then-enum' | 'enum-then-string'
): Promise<void> {
  const stringBranch = {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string' }
    }
  };
  const enumBranch = {
    type: 'object',
    properties: {
      id: { enum: ['a', 'b'] }
    }
  };
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
                      allOf: order === 'string-then-enum'
                        ? [stringBranch, enumBranch]
                        : [enumBranch, stringBranch]
                    }
                  }
                }
              }
            }
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
  const catalogPath = path.join(consumerRoot, '.parallax/workspace.json');
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

function downgradeOpenApiCompatibilityBaseline(repoRoot: string, schemaVersion: number): void {
  const db = new DatabaseSync(databasePath(repoRoot));
  try {
    const row = db
      .prepare(
        `SELECT contract_id, index_run_id, compatibility_json
         FROM contract_versions
         WHERE compatibility_json <> '{}'
         LIMIT 1`
      )
      .get() as { contract_id: string; index_run_id: number; compatibility_json: string };
    const compatibility = JSON.parse(row.compatibility_json) as { schemaVersion?: number };
    compatibility.schemaVersion = schemaVersion;
    db
      .prepare(
        `UPDATE contract_versions
         SET compatibility_json = ?
         WHERE contract_id = ?
           AND index_run_id = ?`
      )
      .run(JSON.stringify(compatibility), row.contract_id, row.index_run_id);
  } finally {
    db.close();
  }
}

async function setupWorkspaceWithResolvedContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
  consumerReal: string;
  providerReal: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-consumer-');
  const providerRoot = await makeRepo('parallax-diff-provider-');
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

async function setupProviderOwnedWorkspaceWithBreakingOpenApiLink(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-primary-impact-consumer-');
  const providerRoot = await makeRepo('parallax-primary-impact-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiContract(providerRoot, ['/api/users', '/api/status']);

  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });

  initWorkspace({ repoRoot: providerRoot, name: 'platform', serviceName: 'users-api' });
  addWorkspaceRepo({
    repoRoot: providerRoot,
    workspaceName: 'platform',
    localPath: consumerRoot,
    serviceName: 'web'
  });
  const resolved = resolveCrossRepoContracts({ repoRoot: providerRoot, workspaceName: 'platform' });
  assert.equal(resolved.links.length, 1);

  await writeOpenApiContract(providerRoot, ['/api/status']);
  const diff = analyzeContractDiff({
    repoRoot: providerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });
  assert.equal(diff.summary.classification, 'breaking');
  assert.equal(diff.summary.impactedConsumerCount, 1);

  return { consumerRoot, providerRoot };
}

async function setupProviderOwnedWorkspaceWithBreakingOpenApiLinks(routePaths: string[]): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-primary-impact-consumer-');
  const providerRoot = await makeRepo('parallax-primary-impact-provider-');
  await writeConsumerClientForRoutes(consumerRoot, routePaths);
  await writeOpenApiContract(providerRoot, [...routePaths, '/api/status']);

  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });

  initWorkspace({ repoRoot: providerRoot, name: 'platform', serviceName: 'users-api' });
  addWorkspaceRepo({
    repoRoot: providerRoot,
    workspaceName: 'platform',
    localPath: consumerRoot,
    serviceName: 'web'
  });
  const resolved = resolveCrossRepoContracts({ repoRoot: providerRoot, workspaceName: 'platform' });
  assert.equal(resolved.links.length, routePaths.length);

  await writeOpenApiContract(providerRoot, ['/api/status']);
  const diff = analyzeContractDiff({
    repoRoot: providerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });
  assert.equal(diff.summary.classification, 'breaking');
  assert.equal(diff.summary.breakingChangeCount, routePaths.length);
  assert.equal(diff.summary.impactedConsumerCount, routePaths.length);

  return { consumerRoot, providerRoot };
}

async function setupWorkspaceWithResolvedYamlSchemaContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
  consumerReal: string;
  providerReal: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-yaml-schema-consumer-');
  const providerRoot = await makeRepo('parallax-diff-yaml-schema-provider-');
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
  const consumerRoot = await makeRepo('parallax-diff-json-consumer-');
  const providerRoot = await makeRepo('parallax-diff-json-provider-');
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

async function setupWorkspaceWithProtobufContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-protobuf-consumer-');
  const providerRoot = await makeRepo('parallax-diff-protobuf-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeProtobufContract(providerRoot);

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

  return {
    consumerRoot,
    providerRoot
  };
}

async function setupWorkspaceWithGraphqlContract(options: Parameters<typeof writeGraphqlContract>[1] = {}): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-graphql-consumer-');
  const providerRoot = await makeRepo('parallax-diff-graphql-provider-');
  await writeConsumerClient(consumerRoot, '/graphql');
  await writeGraphqlContract(providerRoot, options);

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

  return {
    consumerRoot,
    providerRoot
  };
}

async function setupWorkspaceWithAsyncApiContract(options: Parameters<typeof writeAsyncApiContract>[1] = {}): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-asyncapi-consumer-');
  const providerRoot = await makeRepo('parallax-diff-asyncapi-provider-');
  await writeConsumerClient(consumerRoot, '/events/orders');
  await writeAsyncApiContract(providerRoot, options);

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

  return {
    consumerRoot,
    providerRoot
  };
}

async function setupWorkspaceWithAsyncApiJsonContract(options: AsyncApiContractOptions = {}): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-asyncapi-json-consumer-');
  const providerRoot = await makeRepo('parallax-diff-asyncapi-json-provider-');
  await writeConsumerClient(consumerRoot, '/events/orders');
  await writeAsyncApiJsonContract(providerRoot, options);

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

  return {
    consumerRoot,
    providerRoot
  };
}

function seedAsyncApiConsumesLink(
  consumerRoot: string,
  providerRoot: string,
  contractPath: string
): void {
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  const db = new DatabaseSync(databasePath(consumerRoot));
  try {
    const workspace = db
      .prepare('SELECT id FROM workspaces WHERE name = ?')
      .get('platform') as { id: number };
    const consumerRepo = db
      .prepare('SELECT id FROM repos WHERE root = ?')
      .get(consumerReal) as { id: number };
    const providerRepo = db
      .prepare('SELECT id FROM repos WHERE root = ?')
      .get(providerReal) as { id: number };
    db
      .prepare(
        `INSERT OR REPLACE INTO cross_repo_links (
           id, workspace_id, source_repo_id, target_repo_id, source_entity_id,
           target_entity_id, kind, confidence, provenance, index_run_id
         )
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`
      )
      .run(
        `test-asyncapi-consumes-${contractPath}`,
        workspace.id,
        consumerRepo.id,
        providerRepo.id,
        'CONSUMES_HTTP_ENDPOINT',
        'heuristic',
        JSON.stringify({
          schemaVersion: 1,
          analyzer: 'test-seed',
          consumer: {
            serviceName: 'web',
            repoPath: consumerReal,
            path: 'src/client.ts'
          },
          provider: {
            serviceName: 'orders-events',
            repoPath: providerReal,
            contractPath
          },
          http: {
            method: 'SEND',
            path: 'orders.submitted'
          },
          evidence: {
            snippet: 'orders.submitted consumer'
          }
        })
      );
  } finally {
    db.close();
  }
}

async function setupWorkspaceWithResolvedJsonSchemaContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
  consumerReal: string;
  providerReal: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-json-schema-consumer-');
  const providerRoot = await makeRepo('parallax-diff-json-schema-provider-');
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
  const consumerRoot = await makeRepo('parallax-diff-json-chain-consumer-');
  const providerRoot = await makeRepo('parallax-diff-json-chain-provider-');
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

async function setupWorkspaceWithResolvedJsonNestedSchemaContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-json-nested-consumer-');
  const providerRoot = await makeRepo('parallax-diff-json-nested-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiJsonNestedSchemaContract(providerRoot);

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

async function setupWorkspaceWithResolvedYamlNestedSchemaContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-yaml-nested-consumer-');
  const providerRoot = await makeRepo('parallax-diff-yaml-nested-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiYamlNestedSchemaContract(providerRoot);

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

async function setupWorkspaceWithResolvedJsonAllOfSchemaContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-json-allof-consumer-');
  const providerRoot = await makeRepo('parallax-diff-json-allof-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiJsonAllOfSchemaContract(providerRoot, 'string');

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

async function setupWorkspaceWithResolvedJsonOneOfSchemaContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-json-oneof-consumer-');
  const providerRoot = await makeRepo('parallax-diff-json-oneof-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiJsonOneOfSchemaContract(providerRoot, true);

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

async function setupWorkspaceWithResolvedJsonAnyOfSchemaContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-json-anyof-consumer-');
  const providerRoot = await makeRepo('parallax-diff-json-anyof-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiJsonAnyOfSchemaContract(providerRoot, true);

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

async function setupWorkspaceWithResolvedJsonRootArraySchemaContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-json-root-array-consumer-');
  const providerRoot = await makeRepo('parallax-diff-json-root-array-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiJsonRootArraySchemaContract(providerRoot, 'string');

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

async function setupWorkspaceWithResolvedJsonRootOneOfSchemaContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-json-root-oneof-consumer-');
  const providerRoot = await makeRepo('parallax-diff-json-root-oneof-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiJsonRootOneOfSchemaContract(providerRoot, true);

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

async function setupWorkspaceWithResolvedJsonRootOneOfRequiredResponseContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-json-root-oneof-required-consumer-');
  const providerRoot = await makeRepo('parallax-diff-json-root-oneof-required-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiJsonRootOneOfRequiredResponseContract(providerRoot, ['id', 'name']);

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

async function setupWorkspaceWithResolvedJsonRootOneOfRequiredOnlyResponseContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-json-root-oneof-required-only-consumer-');
  const providerRoot = await makeRepo('parallax-diff-json-root-oneof-required-only-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiJsonRootOneOfRequiredOnlyResponseContract(providerRoot, ['id', 'name']);

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

async function setupWorkspaceWithJsonRootAnyOfRequiredRequestContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-json-root-anyof-required-consumer-');
  const providerRoot = await makeRepo('parallax-diff-json-root-anyof-required-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiJsonRootAnyOfRequiredRequestContract(providerRoot, ['id']);

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

  return {
    consumerRoot,
    providerRoot
  };
}

async function setupWorkspaceWithJsonRootAnyOfRequiredOnlyRequestContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-json-root-anyof-required-only-consumer-');
  const providerRoot = await makeRepo('parallax-diff-json-root-anyof-required-only-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiJsonRootAnyOfRequiredOnlyRequestContract(providerRoot, ['id']);

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

  return {
    consumerRoot,
    providerRoot
  };
}

async function setupWorkspaceWithResolvedJsonArrayPointerRefContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-json-array-pointer-ref-consumer-');
  const providerRoot = await makeRepo('parallax-diff-json-array-pointer-ref-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiJsonArrayPointerRefContract(providerRoot, 'string');

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

async function setupWorkspaceWithResolvedJsonOverlappingAllOfContract(): Promise<{
  consumerRoot: string;
  providerRoot: string;
}> {
  const consumerRoot = await makeRepo('parallax-diff-json-overlap-allof-consumer-');
  const providerRoot = await makeRepo('parallax-diff-json-overlap-allof-provider-');
  await writeConsumerClient(consumerRoot, '/api/users');
  await writeOpenApiJsonOverlappingAllOfContract(providerRoot, 'string-then-enum');

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

test('analyzeDiff surfaces persisted cross-repo breaking consumers for changed provider contracts', async () => {
  const { consumerRoot, providerRoot } = await setupProviderOwnedWorkspaceWithBreakingOpenApiLink();
  try {
    const report = await analyzeDiff({
      repoRoot: providerRoot,
      changedFiles: ['contracts/openapi.yaml'],
      writeReport: true
    });

    assert.equal(report.crossRepoImpacts?.length, 1);
    const impact = report.crossRepoImpacts?.[0];
    assert.equal(impact?.workspace, 'platform');
    assert.equal(impact?.provider.serviceName, 'users-api');
    assert.equal(impact?.provider.contractPath, 'contracts/openapi.yaml');
    assert.equal(impact?.provider.repoPath, undefined);
    assert.equal(impact?.consumer.serviceName, 'web');
    assert.equal(impact?.consumer.path, 'src/client.ts');
    assert.equal(impact?.consumer.repoPath, undefined);
    assert.deepEqual(impact?.change, {
      kind: 'removed_endpoint',
      method: 'GET',
      path: '/api/users',
      previousEndpointId: 'endpoint:yaml:GET /api/users'
    });
    assert.equal(impact?.resources?.workspace, 'parallax://workspaces/platform');
    assert.equal(impact?.resources?.crossRepoLinks, 'parallax://workspaces/platform/cross-repo-links');

    const affected = report.affectedFiles.find((item) => item.path === 'web:src/client.ts');
    assert.ok(affected);
    assert.equal(affected.reason, 'breaks cross-repo consumer web via contracts/openapi.yaml');
    assert.equal(affected.confidence, 'heuristic');
    assert.equal(affected.depth, 1);
    assert.deepEqual(affected.relationPath, [
      'web:src/client.ts BREAKS_COMPATIBILITY_WITH users-api:contracts/openapi.yaml'
    ]);

    const target = report.affected.find((item) => item.target.path === 'web:src/client.ts');
    assert.equal(target?.target.kind, 'external_entity');
    assert.equal(target?.confidence, 'heuristic');

    const evidence = report.evidence.find((item) => item.extractorId === 'cross-repo-contract-impact');
    assert.ok(evidence);
    assert.equal(evidence.file, 'web:src/client.ts');
    assert.equal(evidence.kind, 'BREAKS_COMPATIBILITY_WITH');
    assert.equal(evidence.confidence, 'heuristic');
    assert.equal(evidence.relationKind, 'BREAKS_COMPATIBILITY_WITH');
    assert.equal(evidence.relationConfidence, 'heuristic');
    assert.equal(evidence.subject?.kind, 'external_entity');
    assert.equal(evidence.subject?.path, 'web:src/client.ts');
    assert.equal(evidence.target?.kind, 'contract');
    assert.equal(evidence.target?.path, 'contracts/openapi.yaml');
    assert.match(evidence.snippet, /users\.example\.test\/api\/users/);

    const graph = await exportImpactGraph({ repoRoot: providerRoot, reportId: report.id, format: 'json' });
    const parsed = JSON.parse(graph.rendered) as {
      edges: Array<{ source: string; target: string; kind: string; confidence: string }>;
    };
    assert.ok(parsed.edges.some((edge) =>
      edge.kind === 'BREAKS_COMPATIBILITY_WITH'
      && edge.confidence === 'heuristic'
      && edge.source.includes('cross-repo')
      && edge.target.includes('openapi')
    ));
  } finally {
    await unlink(path.join(consumerRoot, '.parallax', 'workspace.json')).catch(() => undefined);
  }
});

test('analyzeDiff preserves multiple cross-repo breaking changes in the same consumer file', async () => {
  const { consumerRoot, providerRoot } = await setupProviderOwnedWorkspaceWithBreakingOpenApiLinks([
    '/api/admin',
    '/api/users'
  ]);
  try {
    const report = await analyzeDiff({
      repoRoot: providerRoot,
      changedFiles: ['contracts/openapi.yaml']
    });

    assert.equal(report.crossRepoImpacts?.length, 2);
    assert.deepEqual(
      report.crossRepoImpacts?.map((impact) => impact.consumer.path),
      ['src/client.ts', 'src/client.ts']
    );
    assert.deepEqual(
      new Set(report.crossRepoImpacts?.map((impact) => impact.change.path)),
      new Set(['/api/admin', '/api/users'])
    );
    assert.equal(
      report.evidence.filter((item) => item.extractorId === 'cross-repo-contract-impact').length,
      2
    );
  } finally {
    await unlink(path.join(consumerRoot, '.parallax', 'workspace.json')).catch(() => undefined);
  }
});

test('analyzeDiff sanitizes absolute evidence file paths from legacy cross-repo provenance', async () => {
  const { consumerRoot, providerRoot } = await setupProviderOwnedWorkspaceWithBreakingOpenApiLink();
  const absoluteEvidencePath = path.join(consumerRoot, 'src/client.ts');
  const db = new DatabaseSync(databasePath(providerRoot));
  try {
    const rows = db
      .prepare("SELECT id, provenance FROM cross_repo_links WHERE kind = 'BREAKS_COMPATIBILITY_WITH'")
      .all() as Array<{ id: string; provenance: string }>;
    const update = db.prepare('UPDATE cross_repo_links SET provenance = ? WHERE id = ?');
    for (const row of rows) {
      const provenance = JSON.parse(row.provenance) as { evidence: { filePath: string } };
      provenance.evidence.filePath = absoluteEvidencePath;
      update.run(JSON.stringify(provenance), row.id);
    }
  } finally {
    db.close();
  }

  try {
    const report = await analyzeDiff({
      repoRoot: providerRoot,
      changedFiles: ['contracts/openapi.yaml']
    });

    assert.equal(report.crossRepoImpacts?.length, 1);
    assert.equal(report.crossRepoImpacts?.[0]?.evidence.filePath, 'web:src/client.ts');
    assert.ok(!path.isAbsolute(report.crossRepoImpacts?.[0]?.evidence.filePath ?? ''));
    const publicJson = JSON.stringify(report);
    assert.ok(!publicJson.includes(consumerRoot));
    assert.ok(!publicJson.includes(realpathSync(consumerRoot)));
  } finally {
    await unlink(path.join(consumerRoot, '.parallax', 'workspace.json')).catch(() => undefined);
  }
});

test('analyzeDiff sanitizes Windows absolute cross-repo paths from public report JSON', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'parallax-windows-cross-repo-'));
  const fakeWindowsProviderRepoPath = String.raw`C:\Users\alice\repo`;
  const windowsConsumerRepoPath = String.raw`C:\Users\alice\consumer`;
  const windowsEvidenceFilePath = String.raw`C:\Users\alice\consumer\src\client.ts`;

  const providerRoot = path.join(tempRoot, 'provider');
  const consumerRoot = path.join(tempRoot, 'consumer');
  const windowsProviderRepoPath = process.platform === 'win32'
    ? providerRoot
    : fakeWindowsProviderRepoPath;
  assert.ok(path.win32.isAbsolute(windowsProviderRepoPath));
  assert.ok(path.win32.isAbsolute(windowsConsumerRepoPath));
  assert.ok(path.win32.isAbsolute(windowsEvidenceFilePath));
  assert.equal(path.relative(tempRoot, providerRoot), 'provider');
  assert.equal(path.relative(tempRoot, consumerRoot), 'consumer');

  try {
    await makeRepoAt(consumerRoot, 'windows-consumer');
    await makeRepoAt(providerRoot, 'windows-provider');
    if (process.platform !== 'win32') {
      // Let the provider provenance stay Windows-looking while resolving to the portable temp repo.
      await symlink(providerRoot, path.join(tempRoot, windowsProviderRepoPath), 'dir');
    }
    await writeConsumerClient(consumerRoot, '/api/users');
    await writeOpenApiContract(providerRoot, ['/api/users', '/api/status']);

    await initProject({ repoRoot: consumerRoot });
    await initProject({ repoRoot: providerRoot });
    await indexProject({ repoRoot: consumerRoot });
    await indexProject({ repoRoot: providerRoot });

    initWorkspace({ repoRoot: providerRoot, name: 'platform', serviceName: 'users-api' });
    addWorkspaceRepo({
      repoRoot: providerRoot,
      workspaceName: 'platform',
      localPath: consumerRoot,
      serviceName: 'web'
    });
    const resolved = resolveCrossRepoContracts({ repoRoot: providerRoot, workspaceName: 'platform' });
    assert.equal(resolved.links.length, 1);

    await writeOpenApiContract(providerRoot, ['/api/status']);
    const diff = analyzeContractDiff({
      repoRoot: providerRoot,
      workspaceName: 'platform',
      providerServiceName: 'users-api',
      contractPath: 'contracts/openapi.yaml'
    });
    assert.equal(diff.summary.classification, 'breaking');
    assert.equal(diff.summary.impactedConsumerCount, 1);

    const db = new DatabaseSync(databasePath(providerRoot));
    try {
      const rows = db
        .prepare("SELECT id, provenance FROM cross_repo_links WHERE kind = 'BREAKS_COMPATIBILITY_WITH'")
        .all() as Array<{ id: string; provenance: string }>;
      const update = db.prepare('UPDATE cross_repo_links SET provenance = ? WHERE id = ?');
      for (const row of rows) {
        const provenance = JSON.parse(row.provenance) as {
          consumer: { repoPath?: string };
          provider: { repoPath?: string };
          evidence: { filePath: string };
        };
        provenance.consumer.repoPath = windowsConsumerRepoPath;
        provenance.provider.repoPath = windowsProviderRepoPath;
        provenance.evidence.filePath = windowsEvidenceFilePath;
        update.run(JSON.stringify(provenance), row.id);
      }
    } finally {
      db.close();
    }

    const originalCwd = process.cwd();
    const report = await (async () => {
      try {
        process.chdir(tempRoot);
        return await analyzeDiff({
          repoRoot: providerRoot,
          changedFiles: ['contracts/openapi.yaml']
        });
      } finally {
        process.chdir(originalCwd);
      }
    })();

    assert.equal(report.crossRepoImpacts?.length, 1);
    const impact = report.crossRepoImpacts?.[0];
    assert.equal(impact?.provider.repoPath, undefined);
    assert.equal(impact?.consumer.repoPath, undefined);
    assert.equal(impact?.evidence.filePath, 'web:src/client.ts');

    const publicJson = JSON.stringify(report);
    assertPublicJsonExcludesPath(publicJson, windowsProviderRepoPath);
    assertPublicJsonExcludesPath(publicJson, windowsConsumerRepoPath);
    assertPublicJsonExcludesPath(publicJson, windowsEvidenceFilePath);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('analyzeDiff skips malformed cross-repo breaking provenance with one warning', async () => {
  const { providerRoot } = await setupProviderOwnedWorkspaceWithBreakingOpenApiLink();
  const db = new DatabaseSync(databasePath(providerRoot));
  try {
    db.prepare("UPDATE cross_repo_links SET provenance = '{not-json' WHERE kind = 'BREAKS_COMPATIBILITY_WITH'").run();
  } finally {
    db.close();
  }

  const report = await analyzeDiff({
    repoRoot: providerRoot,
    changedFiles: ['contracts/openapi.yaml']
  });

  assert.equal(report.crossRepoImpacts, undefined);
  assert.deepEqual(
    report.warnings?.filter((warning) => warning.includes('malformed BREAKS_COMPATIBILITY_WITH')),
    ['cross-repo impact: skipped 1 malformed BREAKS_COMPATIBILITY_WITH link']
  );
});

test('analyzeDiff leaves non-contract changed files on the existing local path', async () => {
  const { providerRoot } = await setupProviderOwnedWorkspaceWithBreakingOpenApiLink();
  const report = await analyzeDiff({
    repoRoot: providerRoot,
    changedFiles: ['README.md']
  });

  assert.equal(report.crossRepoImpacts, undefined);
  assert.ok(report.affectedFiles.every((item) => !item.path.startsWith('web:')));
  assert.ok((report.warnings ?? []).every((warning) => !warning.includes('cross-repo impact')));
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

test('analyzeContractDiff classifies nested OpenAPI JSON object and array schema changes as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedJsonNestedSchemaContract();
  await writeOpenApiJsonNestedSchemaContract(providerRoot, {
    responseProfileRequired: [],
    responseMemberIdType: 'integer',
    requestProfileRequired: ['displayName', 'locale']
  });

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
      kind: 'removed_response_required_property',
      classification: 'breaking',
      reason: 'response required property removed from current contract',
      httpMethod: 'GET',
      routePath: '/api/users',
      statusCode: '200',
      propertyName: 'profile.displayName',
      schemaPath: 'responses.200.body.required.profile.displayName'
    },
    {
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'response property type changed in current contract',
      httpMethod: 'GET',
      routePath: '/api/users',
      statusCode: '200',
      propertyName: 'members[].id',
      schemaPath: 'responses.200.body.properties.members[].id',
      previousSchemaType: 'string',
      currentSchemaType: 'integer'
    },
    {
      kind: 'added_request_required_property',
      classification: 'breaking',
      reason: 'request required property added to current contract',
      httpMethod: 'POST',
      routePath: '/api/users',
      propertyName: 'profile.locale',
      schemaPath: 'requestBody.required.profile.locale'
    }
  ]);

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT provenance
         FROM cross_repo_links
         WHERE kind = ?
         ORDER BY provenance`
      )
      .all('BREAKS_COMPATIBILITY_WITH') as Array<{ provenance: string }>;
    assert.deepEqual(
      rows.map((row) => {
        const provenance = JSON.parse(row.provenance) as {
          change: {
            kind: string;
            path: string;
            schemaPath?: string;
            propertyName?: string;
            previousSchemaType?: string;
            currentSchemaType?: string;
          };
        };
        return provenance.change;
      }),
      [
        {
          kind: 'changed_response_property_type',
          method: 'GET',
          path: '/api/users',
          statusCode: '200',
          schemaPath: 'responses.200.body.properties.members[].id',
          propertyName: 'members[].id',
          previousSchemaType: 'string',
          currentSchemaType: 'integer'
        },
        {
          kind: 'removed_response_required_property',
          method: 'GET',
          path: '/api/users',
          statusCode: '200',
          schemaPath: 'responses.200.body.required.profile.displayName',
          propertyName: 'profile.displayName'
        }
      ]
    );
  } finally {
    db.close();
  }
});

test('analyzeContractDiff classifies nested OpenAPI YAML object and array schema changes as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedYamlNestedSchemaContract();
  await writeOpenApiYamlNestedSchemaContract(providerRoot, {
    responseProfileRequired: [],
    responseMemberIdType: 'integer',
    requestProfileRequired: ['displayName', 'locale']
  });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.yaml'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.equal(result.summary.breakingChangeCount, 3);
  assert.equal(result.summary.unknownChangeCount, 0);
  assert.equal(result.summary.impactedConsumerCount, 1);
  assert.deepEqual(
    result.changes.map((change) => ({
      kind: change.kind,
      propertyName: change.propertyName,
      schemaPath: change.schemaPath,
      previousSchemaType: change.previousSchemaType,
      currentSchemaType: change.currentSchemaType
    })),
    [
      {
        kind: 'removed_response_required_property',
        propertyName: 'profile.displayName',
        schemaPath: 'responses.200.body.required.profile.displayName',
        previousSchemaType: undefined,
        currentSchemaType: undefined
      },
      {
        kind: 'changed_response_property_type',
        propertyName: 'members[].id',
        schemaPath: 'responses.200.body.properties.members[].id',
        previousSchemaType: 'string',
        currentSchemaType: 'integer'
      },
      {
        kind: 'added_request_required_property',
        propertyName: 'profile.locale',
        schemaPath: 'requestBody.required.profile.locale',
        previousSchemaType: undefined,
        currentSchemaType: undefined
      }
    ]
  );
});

test('analyzeContractDiff merges OpenAPI JSON allOf schemas before comparing nested property types', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedJsonAllOfSchemaContract();
  await writeOpenApiJsonAllOfSchemaContract(providerRoot, 'integer');

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'response property type changed in current contract',
      httpMethod: 'GET',
      routePath: '/api/users',
      statusCode: '200',
      propertyName: 'profile.displayName',
      schemaPath: 'responses.200.body.properties.profile.displayName',
      previousSchemaType: 'string',
      currentSchemaType: 'integer'
    }
  ]);
});

test('analyzeContractDiff fingerprints OpenAPI JSON oneOf alternatives as response property type changes', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedJsonOneOfSchemaContract();
  await writeOpenApiJsonOneOfSchemaContract(providerRoot, false);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'response property type changed in current contract',
      httpMethod: 'GET',
      routePath: '/api/users',
      statusCode: '200',
      propertyName: 'externalId',
      schemaPath: 'responses.200.body.properties.externalId',
      previousSchemaType: 'oneOf<integer|string>',
      currentSchemaType: 'oneOf<string>'
    }
  ]);
});

test('analyzeContractDiff fingerprints OpenAPI JSON anyOf alternatives as response property type changes', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedJsonAnyOfSchemaContract();
  await writeOpenApiJsonAnyOfSchemaContract(providerRoot, false);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'response property type changed in current contract',
      httpMethod: 'GET',
      routePath: '/api/users',
      statusCode: '200',
      propertyName: 'externalId',
      schemaPath: 'responses.200.body.properties.externalId',
      previousSchemaType: 'anyOf<integer|string>',
      currentSchemaType: 'anyOf<string>'
    }
  ]);
});

test('analyzeContractDiff classifies OpenAPI JSON root array item property changes as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedJsonRootArraySchemaContract();
  await writeOpenApiJsonRootArraySchemaContract(providerRoot, 'integer');

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'response property type changed in current contract',
      httpMethod: 'GET',
      routePath: '/api/users',
      statusCode: '200',
      propertyName: '[].id',
      schemaPath: 'responses.200.body.properties.[].id',
      previousSchemaType: 'string',
      currentSchemaType: 'integer'
    }
  ]);
});

test('analyzeContractDiff fingerprints OpenAPI JSON root oneOf response bodies as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedJsonRootOneOfSchemaContract();
  await writeOpenApiJsonRootOneOfSchemaContract(providerRoot, false);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'response property type changed in current contract',
      httpMethod: 'GET',
      routePath: '/api/users',
      statusCode: '200',
      propertyName: '$',
      schemaPath: 'responses.200.body.properties.$',
      previousSchemaType: 'oneOf<object{required:id;properties:id:integer}|object{required:id;properties:id:string}>',
      currentSchemaType: 'oneOf<object{required:id;properties:id:string}>'
    }
  ]);
});

test('analyzeContractDiff fingerprints OpenAPI JSON root oneOf response required-only changes as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedJsonRootOneOfRequiredResponseContract();
  await writeOpenApiJsonRootOneOfRequiredResponseContract(providerRoot, ['id']);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'response property type changed in current contract',
      httpMethod: 'GET',
      routePath: '/api/users',
      statusCode: '200',
      propertyName: '$',
      schemaPath: 'responses.200.body.properties.$',
      previousSchemaType: 'oneOf<object{required:id|name;properties:id:string,name:string}>',
      currentSchemaType: 'oneOf<object{required:id;properties:id:string,name:string}>'
    }
  ]);
});

test('analyzeContractDiff fingerprints OpenAPI JSON root oneOf required-only response bodies without properties', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedJsonRootOneOfRequiredOnlyResponseContract();
  await writeOpenApiJsonRootOneOfRequiredOnlyResponseContract(providerRoot, ['id']);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'response property type changed in current contract',
      httpMethod: 'GET',
      routePath: '/api/users',
      statusCode: '200',
      propertyName: '$',
      schemaPath: 'responses.200.body.properties.$',
      previousSchemaType: 'oneOf<object{required:id|name;properties:}>',
      currentSchemaType: 'oneOf<object{required:id;properties:}>'
    }
  ]);
});

test('analyzeContractDiff fingerprints OpenAPI JSON root anyOf request required-only changes as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithJsonRootAnyOfRequiredRequestContract();
  await writeOpenApiJsonRootAnyOfRequiredRequestContract(providerRoot, ['id', 'name']);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_request_property_type',
      classification: 'breaking',
      reason: 'request property type changed in current contract',
      httpMethod: 'POST',
      routePath: '/api/users',
      propertyName: '$',
      schemaPath: 'requestBody.properties.$',
      previousSchemaType: 'anyOf<object{required:id;properties:id:string,name:string}>',
      currentSchemaType: 'anyOf<object{required:id|name;properties:id:string,name:string}>'
    }
  ]);
});

test('analyzeContractDiff fingerprints OpenAPI JSON root anyOf required-only request bodies without properties', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithJsonRootAnyOfRequiredOnlyRequestContract();
  await writeOpenApiJsonRootAnyOfRequiredOnlyRequestContract(providerRoot, ['id', 'name']);

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_request_property_type',
      classification: 'breaking',
      reason: 'request property type changed in current contract',
      httpMethod: 'POST',
      routePath: '/api/users',
      propertyName: '$',
      schemaPath: 'requestBody.properties.$',
      previousSchemaType: 'anyOf<object{required:id;properties:}>',
      currentSchemaType: 'anyOf<object{required:id|name;properties:}>'
    }
  ]);
});

test('analyzeContractDiff follows OpenAPI JSON pointer refs through array indices', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedJsonArrayPointerRefContract();
  await writeOpenApiJsonArrayPointerRefContract(providerRoot, 'integer');

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
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
    }
  ]);
});

test('analyzeContractDiff classifies removed Protobuf RPCs as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithProtobufContract();
  await writeProtobufContract(providerRoot, { includeListUsers: false });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/users.proto'
  });

  assert.equal(result.contract.kind, 'protobuf');
  assert.equal(result.summary.classification, 'breaking');
  assert.equal(result.summary.impactedConsumerCount, 0);
  const db = new DatabaseSync(databasePath(providerRoot), { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT compatibility_json
         FROM contracts c
         INNER JOIN contract_versions v ON v.contract_id = c.id
         INNER JOIN index_runs r ON r.id = v.index_run_id
         WHERE c.path = ?
           AND r.status = 'completed'
         ORDER BY v.index_run_id DESC
         LIMIT 1`
      )
      .get('contracts/users.proto') as { compatibility_json: string };
    const compatibility = JSON.parse(row.compatibility_json) as {
      analyzer: string;
      contractKind: string;
      operations: Array<{ service: string; rpc: string; path: string }>;
      messages: Array<{ name: string; fields: Array<{ number: number; name: string; type: string }> }>;
    };
    assert.equal(compatibility.analyzer, 'protobuf-compat-v0');
    assert.equal(compatibility.contractKind, 'protobuf');
    assert.deepEqual(
      compatibility.operations.map((operation) => `${operation.service}/${operation.rpc}`),
      ['UserService/GetUser', 'UserService/ListUsers']
    );
    assert.deepEqual(
      compatibility.messages.find((message) => message.name === 'users.v1.User')?.fields,
      [
        { number: 1, name: 'id', type: 'string', label: 'singular' },
        { number: 2, name: 'name', type: 'string', label: 'singular' }
      ]
    );
    assert.deepEqual(
      compatibility.messages.find((message) => message.name === 'users.v1.ListUsersResponse')?.fields,
      [{ number: 1, name: 'users', type: 'users.v1.User', label: 'repeated' }]
    );
  } finally {
    db.close();
  }
  assert.deepEqual(result.changes, [
    {
      kind: 'removed_endpoint',
      classification: 'breaking',
      reason: 'endpoint removed from current contract',
      httpMethod: 'RPC',
      routePath: 'UserService/ListUsers',
      previousEndpointId: 'endpoint:protobuf:UserService.ListUsers'
    }
  ]);
});

test('analyzeContractDiff links removed Protobuf RPCs to resolved consumers', async () => {
  const consumerRoot = await makeRepo('parallax-diff-protobuf-resolved-consumer-');
  const providerRoot = await makeRepo('parallax-diff-protobuf-resolved-provider-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
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
  await writeProtobufContract(providerRoot);

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

  await writeProtobufContract(providerRoot, { includeListUsers: false });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/users.proto'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.equal(result.summary.impactedConsumerCount, 1);
  assert.deepEqual(result.impactedConsumers, [
    {
      consumerService: 'web',
      consumerRepoPath: consumerReal,
      consumerPath: 'src/users-client.ts',
      providerService: 'users-api',
      providerRepoPath: providerReal,
      providerContractPath: 'contracts/users.proto',
      httpMethod: 'RPC',
      routePath: 'UserService/ListUsers',
      evidenceSnippet: 'return client.listUsers({ pageSize: 50 });'
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
    const provenance = JSON.parse(row.provenance) as {
      change: { kind: string; method: string; path: string; previousEndpointId: string };
      evidence: { filePath: string; snippet: string };
    };
    assert.deepEqual(provenance.change, {
      kind: 'removed_endpoint',
      method: 'RPC',
      path: 'UserService/ListUsers',
      previousEndpointId: 'endpoint:protobuf:UserService.ListUsers'
    });
    assert.deepEqual(provenance.evidence, {
      filePath: 'src/users-client.ts',
      snippet: 'return client.listUsers({ pageSize: 50 });'
    });
  } finally {
    db.close();
  }
});

test('analyzeContractDiff classifies Protobuf response field type changes as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithProtobufContract();
  await writeProtobufContract(providerRoot, { userNameFieldType: 'int64' });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/users.proto'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'protobuf response field type changed in current contract',
      httpMethod: 'RPC',
      routePath: 'UserService/GetUser',
      propertyName: 'User.name#2',
      schemaPath: 'response.User.fields.2',
      previousSchemaType: 'string',
      currentSchemaType: 'int64'
    }
  ]);
});

test('analyzeContractDiff classifies removed Protobuf response fields as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithProtobufContract();
  await writeProtobufContract(providerRoot, { includeUserNameField: false });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/users.proto'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'removed_response_required_property',
      classification: 'breaking',
      reason: 'protobuf response field removed from current contract',
      httpMethod: 'RPC',
      routePath: 'UserService/GetUser',
      propertyName: 'User.name#2',
      schemaPath: 'response.User.fields.2'
    }
  ]);
});

test('analyzeContractDiff ignores commented Protobuf RPC declarations in indexed baselines', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithProtobufContract();
  await writeProtobufContract(providerRoot, { includeCommentedLegacyRpc: true });
  await indexProject({ repoRoot: providerRoot });

  const db = new DatabaseSync(databasePath(providerRoot), { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT compatibility_json
         FROM contracts c
         INNER JOIN contract_versions v ON v.contract_id = c.id
         INNER JOIN index_runs r ON r.id = v.index_run_id
         WHERE c.path = ?
           AND r.status = 'completed'
         ORDER BY v.index_run_id DESC
         LIMIT 1`
      )
      .get('contracts/users.proto') as { compatibility_json: string };
    const compatibility = JSON.parse(row.compatibility_json) as {
      operations: Array<{ service: string; rpc: string }>;
    };
    assert.deepEqual(
      compatibility.operations.map((operation) => `${operation.service}/${operation.rpc}`),
      ['UserService/GetUser', 'UserService/ListUsers']
    );
  } finally {
    db.close();
  }

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/users.proto'
  });

  assert.equal(result.summary.classification, 'unchanged');
  assert.deepEqual(result.changes, []);
});

test('analyzeContractDiff ignores nested Protobuf message fields when comparing parent responses', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithProtobufContract();
  await writeProtobufContract(providerRoot, { includeNestedUserDetails: true, includeNestedUserNickname: true });
  await indexProject({ repoRoot: providerRoot });
  await writeProtobufContract(providerRoot, { includeNestedUserDetails: true, includeNestedUserNickname: false });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/users.proto'
  });

  assert.equal(result.summary.classification, 'unknown');
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_contract_without_endpoint_delta',
      classification: 'unknown',
      reason: 'contract content changed but endpoint surface is unchanged in the v0 analyzer'
    }
  ]);
});

test('analyzeContractDiff classifies Protobuf oneof response field type changes as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithProtobufContract();
  await writeProtobufContract(providerRoot, { includeUserContactOneof: true });
  await indexProject({ repoRoot: providerRoot });
  await writeProtobufContract(providerRoot, { includeUserContactOneof: true, userEmailOneofFieldType: 'int64' });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/users.proto'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'protobuf response field type changed in current contract',
      httpMethod: 'RPC',
      routePath: 'UserService/GetUser',
      propertyName: 'User.email#4',
      schemaPath: 'response.User.fields.4',
      previousSchemaType: 'string',
      currentSchemaType: 'int64'
    }
  ]);
});

test('analyzeContractDiff classifies removed GraphQL root fields as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithGraphqlContract({ includeUsersField: true });
  await writeGraphqlContract(providerRoot, { includeUsersField: false });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/schema.graphql'
  });

  assert.equal(result.contract.kind, 'graphql');
  assert.equal(result.summary.classification, 'breaking');
  assert.equal(result.summary.impactedConsumerCount, 0);
  const db = new DatabaseSync(databasePath(providerRoot), { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT compatibility_json
         FROM contracts c
         INNER JOIN contract_versions v ON v.contract_id = c.id
         INNER JOIN index_runs r ON r.id = v.index_run_id
         WHERE c.path = ?
           AND r.status = 'completed'
         ORDER BY v.index_run_id DESC
         LIMIT 1`
      )
      .get('contracts/schema.graphql') as { compatibility_json: string };
    const compatibility = JSON.parse(row.compatibility_json) as {
      analyzer: string;
      contractKind: string;
      operations: Array<{ rootType: string; field: string; path: string }>;
      objectTypes: Array<{ name: string; fields: Array<{ name: string; type: string }> }>;
      inputTypes: Array<{ name: string; fields: Array<{ name: string; type: string; required: boolean }> }>;
    };
    assert.equal(compatibility.analyzer, 'graphql-compat-v0');
    assert.equal(compatibility.contractKind, 'graphql');
    assert.deepEqual(
      compatibility.operations.map((operation) => `${operation.rootType}/${operation.field}`),
      ['Query/user', 'Query/users']
    );
    assert.deepEqual(
      compatibility.objectTypes.find((type) => type.name === 'User')?.fields,
      [
        { name: 'id', type: 'ID!' },
        { name: 'name', type: 'String!' }
      ]
    );
    assert.deepEqual(
      compatibility.inputTypes.find((type) => type.name === 'CreateUserInput')?.fields,
      [{ name: 'name', type: 'String!', required: true }]
    );
  } finally {
    db.close();
  }
  assert.deepEqual(result.changes, [
    {
      kind: 'removed_endpoint',
      classification: 'breaking',
      reason: 'endpoint removed from current contract',
      httpMethod: 'GRAPHQL',
      routePath: 'Query.users',
      previousEndpointId: 'endpoint:graphql:Query.users'
    }
  ]);
});

test('analyzeContractDiff classifies removed GraphQL response fields as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithGraphqlContract({ includeUsersField: false });
  await writeGraphqlContract(providerRoot, { includeUsersField: false, includeUserNameField: false });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/schema.graphql'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'removed_response_required_property',
      classification: 'breaking',
      reason: 'graphql response field removed from current schema',
      httpMethod: 'GRAPHQL',
      routePath: 'Query.user',
      propertyName: 'User.name',
      schemaPath: 'response.User.fields.name'
    }
  ]);
});

test('analyzeContractDiff classifies GraphQL response field type changes as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithGraphqlContract({ includeUsersField: false });
  await writeGraphqlContract(providerRoot, { includeUsersField: false, userNameFieldType: 'Int!' });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/schema.graphql'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'graphql response field type changed in current schema',
      httpMethod: 'GRAPHQL',
      routePath: 'Query.user',
      propertyName: 'User.name',
      schemaPath: 'response.User.fields.name',
      previousSchemaType: 'String!',
      currentSchemaType: 'Int!'
    }
  ]);
});

test('analyzeContractDiff classifies added GraphQL required input fields as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithGraphqlContract({
    includeUsersField: false,
    includeMutation: true
  });
  await writeGraphqlContract(providerRoot, {
    includeUsersField: false,
    includeMutation: true,
    includeRequiredInputEmail: true
  });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/schema.graphql'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'added_request_required_property',
      classification: 'breaking',
      reason: 'graphql required input field added to current schema',
      httpMethod: 'GRAPHQL',
      routePath: 'Mutation.createUser',
      propertyName: 'CreateUserInput.email',
      schemaPath: 'request.Mutation.createUser.args.input.CreateUserInput.fields.email',
      currentSchemaType: 'String!'
    }
  ]);
});

test('analyzeContractDiff classifies existing GraphQL arguments becoming required as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithGraphqlContract({
    includeUsersField: false,
    defaultUserIdArg: true
  });
  await writeGraphqlContract(providerRoot, { includeUsersField: false });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/schema.graphql'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'added_request_required_property',
      classification: 'breaking',
      reason: 'graphql argument became required in current schema',
      httpMethod: 'GRAPHQL',
      routePath: 'Query.user',
      propertyName: 'id',
      schemaPath: 'request.Query.user.args.id',
      previousSchemaType: 'ID!',
      currentSchemaType: 'ID!'
    }
  ]);
});

test('analyzeContractDiff classifies existing GraphQL input fields becoming required as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithGraphqlContract({
    includeUsersField: false,
    includeMutation: true,
    includeDefaultedInputEmail: true
  });
  await writeGraphqlContract(providerRoot, {
    includeUsersField: false,
    includeMutation: true,
    includeRequiredInputEmail: true
  });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/schema.graphql'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'added_request_required_property',
      classification: 'breaking',
      reason: 'graphql input field became required in current schema',
      httpMethod: 'GRAPHQL',
      routePath: 'Mutation.createUser',
      propertyName: 'CreateUserInput.email',
      schemaPath: 'request.Mutation.createUser.args.input.CreateUserInput.fields.email',
      previousSchemaType: 'String!',
      currentSchemaType: 'String!'
    }
  ]);
});

test('analyzeContractDiff does not classify defaulted GraphQL non-null input fields as required', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithGraphqlContract({
    includeUsersField: false,
    includeMutation: true
  });
  await writeGraphqlContract(providerRoot, {
    includeUsersField: false,
    includeMutation: true,
    includeDefaultedInputEmail: true
  });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/schema.graphql'
  });

  assert.equal(result.summary.classification, 'unknown');
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_contract_without_endpoint_delta',
      classification: 'unknown',
      reason: 'contract content changed but endpoint surface is unchanged in the v0 analyzer'
    }
  ]);
});

test('analyzeContractDiff classifies nested GraphQL response field removals as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithGraphqlContract({
    includeUsersField: false,
    includeUserProfileField: true
  });
  await writeGraphqlContract(providerRoot, {
    includeUsersField: false,
    includeUserProfileField: true,
    includeProfileBioField: false
  });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/schema.graphql'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'removed_response_required_property',
      classification: 'breaking',
      reason: 'graphql response field removed from current schema',
      httpMethod: 'GRAPHQL',
      routePath: 'Query.user',
      propertyName: 'Profile.bio',
      schemaPath: 'response.Profile.fields.bio'
    }
  ]);
});

test('analyzeContractDiff classifies removed AsyncAPI operations as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithAsyncApiContract();
  await writeAsyncApiContract(providerRoot, { includeOrderSubmittedOperation: false });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'orders-events',
    contractPath: 'contracts/asyncapi.yaml'
  });

  assert.equal(result.contract.kind, 'asyncapi');
  assert.equal(result.summary.classification, 'breaking');
  assert.equal(result.summary.impactedConsumerCount, 0);
  const db = new DatabaseSync(databasePath(providerRoot), { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT compatibility_json
         FROM contracts c
         INNER JOIN contract_versions v ON v.contract_id = c.id
         INNER JOIN index_runs r ON r.id = v.index_run_id
         WHERE c.path = ?
           AND r.status = 'completed'
         ORDER BY v.index_run_id DESC
         LIMIT 1`
      )
      .get('contracts/asyncapi.yaml') as { compatibility_json: string };
    const compatibility = JSON.parse(row.compatibility_json) as {
      analyzer: string;
      contractKind: string;
      operations: Array<{ action: string; channelId: string; address: string; messageIds: string[] }>;
      messages: Array<{ id: string; payload?: { required: string[]; properties: Record<string, { type: string }> } }>;
    };
    assert.equal(compatibility.analyzer, 'asyncapi-compat-v0');
    assert.equal(compatibility.contractKind, 'asyncapi');
    assert.deepEqual(compatibility.operations, [
      {
        action: 'send',
        channelId: 'orderSubmitted',
        address: 'orders.submitted',
        messageIds: ['OrderSubmitted']
      }
    ]);
    assert.deepEqual(compatibility.messages.find((message) => message.id === 'OrderSubmitted')?.payload, {
      required: ['customerEmail', 'orderId'],
      properties: {
        customerEmail: { type: 'string' },
        orderId: { type: 'string' }
      }
    });
  } finally {
    db.close();
  }
  assert.deepEqual(result.changes, [
    {
      kind: 'removed_endpoint',
      classification: 'breaking',
      reason: 'endpoint removed from current contract',
      httpMethod: 'SEND',
      routePath: 'orders.submitted',
      previousEndpointId: 'endpoint:asyncapi:SEND orders.submitted'
    }
  ]);
});

test('analyzeContractDiff links removed AsyncAPI operations to resolved event consumers', async () => {
  const consumerRoot = await makeRepo('parallax-diff-asyncapi-resolved-consumer-');
  const providerRoot = await makeRepo('parallax-diff-asyncapi-resolved-provider-');
  const consumerReal = realpathSync(consumerRoot);
  const providerReal = realpathSync(providerRoot);
  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      'export function startOrdersConsumer(bus: { subscribe(topic: string, handler: () => void): void }) {',
      '  bus.subscribe("orders.submitted", () => undefined);',
      '}',
      ''
    ].join('\n')
  );
  await writeAsyncApiContract(providerRoot);

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
  const resolved = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });
  assert.equal(resolved.links.length, 1);

  await writeAsyncApiContract(providerRoot, { includeOrderSubmittedOperation: false });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'orders-events',
    contractPath: 'contracts/asyncapi.yaml'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.equal(result.summary.impactedConsumerCount, 1);
  assert.equal(result.summary.eventTopologyCount, 1);
  assert.deepEqual(result.summary.eventTopologyBreakdown, [
    {
      providerAction: 'SEND',
      counterpartyRole: 'consumer',
      pattern: 'subscriber-call',
      count: 1
    }
  ]);
  assert.deepEqual(result.impactedConsumers, [
    {
      consumerService: 'web',
      consumerRepoPath: consumerReal,
      consumerPath: 'src/orders-consumer.ts',
      providerService: 'orders-events',
      providerRepoPath: providerReal,
      providerContractPath: 'contracts/asyncapi.yaml',
      httpMethod: 'SEND',
      routePath: 'orders.submitted',
      evidenceSnippet: 'bus.subscribe("orders.submitted", () => undefined);',
      eventTopology: {
        providerAction: 'SEND',
        counterpartyRole: 'consumer',
        pattern: 'subscriber-call'
      }
    }
  ]);

  const cliRun = runCli(consumerRoot, [
    'workspace',
    'contract-diff',
    '--name',
    'platform',
    '--provider',
    'orders-events',
    '--contract',
    'contracts/asyncapi.yaml'
  ]);
  assert.equal(cliRun.status, 0, `workspace contract-diff failed: ${cliRun.stderr}`);
  assert.match(
    cliRun.stdout,
    /consumer: web:src\/orders-consumer\.ts -> orders-events:SEND orders\.submitted \[topology: SEND -> consumer via subscriber-call\]/
  );

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
    const provenance = JSON.parse(row.provenance) as {
      change: { kind: string; method: string; path: string; previousEndpointId: string };
      evidence: { filePath: string; snippet: string };
      eventTopology: { providerAction: string; counterpartyRole: string; pattern: string };
    };
    assert.deepEqual(provenance.change, {
      kind: 'removed_endpoint',
      method: 'SEND',
      path: 'orders.submitted',
      previousEndpointId: 'endpoint:asyncapi:SEND orders.submitted'
    });
    assert.deepEqual(provenance.evidence, {
      filePath: 'src/orders-consumer.ts',
      snippet: 'bus.subscribe("orders.submitted", () => undefined);'
    });
    assert.deepEqual(provenance.eventTopology, {
      providerAction: 'SEND',
      counterpartyRole: 'consumer',
      pattern: 'subscriber-call'
    });
  } finally {
    db.close();
  }
});

test('analyzeContractDiff classifies removed AsyncAPI JSON operations as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithAsyncApiJsonContract();
  await writeAsyncApiJsonContract(providerRoot, { includeOrderSubmittedOperation: false });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'orders-events',
    contractPath: 'contracts/asyncapi.json'
  });

  assert.equal(result.contract.kind, 'asyncapi');
  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'removed_endpoint',
      classification: 'breaking',
      reason: 'endpoint removed from current contract',
      httpMethod: 'SEND',
      routePath: 'orders.submitted',
      previousEndpointId: 'endpoint:asyncapi:SEND orders.submitted'
    }
  ]);
});

test('analyzeContractDiff classifies removed AsyncAPI payload fields as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithAsyncApiContract();
  await writeAsyncApiContract(providerRoot, { includeCustomerEmailField: false });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'orders-events',
    contractPath: 'contracts/asyncapi.yaml'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'removed_response_required_property',
      classification: 'breaking',
      reason: 'asyncapi message payload field removed from current contract',
      httpMethod: 'SEND',
      routePath: 'orders.submitted',
      propertyName: 'OrderSubmitted.customerEmail',
      schemaPath: 'messages.OrderSubmitted.payload.properties.customerEmail'
    }
  ]);
});

test('analyzeContractDiff classifies AsyncAPI payload field type changes as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithAsyncApiContract();
  await writeAsyncApiContract(providerRoot, { customerEmailFieldType: 'integer' });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'orders-events',
    contractPath: 'contracts/asyncapi.yaml'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'asyncapi message payload field type changed in current contract',
      httpMethod: 'SEND',
      routePath: 'orders.submitted',
      propertyName: 'OrderSubmitted.customerEmail',
      schemaPath: 'messages.OrderSubmitted.payload.properties.customerEmail',
      previousSchemaType: 'string',
      currentSchemaType: 'integer'
    }
  ]);
});

test('analyzeContractDiff classifies added AsyncAPI required payload fields as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithAsyncApiContract();
  await writeAsyncApiContract(providerRoot, { includeRequiredCurrency: true });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'orders-events',
    contractPath: 'contracts/asyncapi.yaml'
  });

  assert.equal(result.summary.classification, 'breaking');
  assert.deepEqual(result.changes, [
    {
      kind: 'added_request_required_property',
      classification: 'breaking',
      reason: 'asyncapi message required payload field added to current contract',
      httpMethod: 'SEND',
      routePath: 'orders.submitted',
      propertyName: 'OrderSubmitted.currency',
      schemaPath: 'messages.OrderSubmitted.payload.required.currency',
      currentSchemaType: 'string'
    }
  ]);
});

test('analyzeContractDiff treats malformed AsyncAPI YAML operations as unknown and preserves existing breaking links', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithAsyncApiContract();
  seedAsyncApiConsumesLink(consumerRoot, providerRoot, 'contracts/asyncapi.yaml');
  await writeAsyncApiContract(providerRoot, { includeOrderSubmittedOperation: false });
  const breakingResult = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'orders-events',
    contractPath: 'contracts/asyncapi.yaml'
  });
  assert.equal(breakingResult.summary.classification, 'breaking');
  assert.equal(breakingResult.summary.impactedConsumerCount, 1);

  await writeMalformedAsyncApiYamlOperationsContract(providerRoot);
  const unknownResult = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'orders-events',
    contractPath: 'contracts/asyncapi.yaml'
  });

  assert.equal(unknownResult.summary.classification, 'unknown');
  assert.deepEqual(unknownResult.changes, [
    {
      kind: 'unparsed_current_contract',
      classification: 'unknown',
      reason: 'current AsyncAPI YAML could not be parsed: operations must be an object'
    }
  ]);

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const count = db
      .prepare('SELECT count(*) AS count FROM cross_repo_links WHERE kind = ?')
      .get('BREAKS_COMPATIBILITY_WITH') as { count: number };
    assert.equal(count.count, 1, 'malformed AsyncAPI YAML must not delete existing breaking links');
  } finally {
    db.close();
  }
});

test('analyzeContractDiff treats malformed AsyncAPI JSON operations as unknown and preserves existing breaking links', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithAsyncApiJsonContract();
  seedAsyncApiConsumesLink(consumerRoot, providerRoot, 'contracts/asyncapi.json');
  await writeAsyncApiJsonContract(providerRoot, { includeOrderSubmittedOperation: false });
  const breakingResult = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'orders-events',
    contractPath: 'contracts/asyncapi.json'
  });
  assert.equal(breakingResult.summary.classification, 'breaking');
  assert.equal(breakingResult.summary.impactedConsumerCount, 1);

  await writeMalformedAsyncApiJsonOperationContract(providerRoot);
  const unknownResult = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'orders-events',
    contractPath: 'contracts/asyncapi.json'
  });

  assert.equal(unknownResult.summary.classification, 'unknown');
  assert.deepEqual(unknownResult.changes, [
    {
      kind: 'unparsed_current_contract',
      classification: 'unknown',
      reason: 'current AsyncAPI JSON could not be parsed: operation channel must resolve to an object for publishOrderSubmitted'
    }
  ]);

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const count = db
      .prepare('SELECT count(*) AS count FROM cross_repo_links WHERE kind = ?')
      .get('BREAKS_COMPATIBILITY_WITH') as { count: number };
    assert.equal(count.count, 1, 'malformed AsyncAPI JSON must not delete existing breaking links');
  } finally {
    db.close();
  }
});

test('analyzeContractDiff treats invalid AsyncAPI YAML v3 actions as unknown and preserves existing breaking links', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithAsyncApiContract();
  seedAsyncApiConsumesLink(consumerRoot, providerRoot, 'contracts/asyncapi.yaml');
  await writeAsyncApiContract(providerRoot, { includeOrderSubmittedOperation: false });
  const breakingResult = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'orders-events',
    contractPath: 'contracts/asyncapi.yaml'
  });
  assert.equal(breakingResult.summary.classification, 'breaking');
  assert.equal(breakingResult.summary.impactedConsumerCount, 1);

  await writeAsyncApiContract(providerRoot, { operationAction: 'publish' });
  const unknownResult = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'orders-events',
    contractPath: 'contracts/asyncapi.yaml'
  });

  assert.equal(unknownResult.summary.classification, 'unknown');
  assert.deepEqual(unknownResult.changes, [
    {
      kind: 'unparsed_current_contract',
      classification: 'unknown',
      reason: 'current AsyncAPI YAML could not be parsed: operation action must be send or receive for publishOrderSubmitted'
    }
  ]);

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const count = db
      .prepare('SELECT count(*) AS count FROM cross_repo_links WHERE kind = ?')
      .get('BREAKS_COMPATIBILITY_WITH') as { count: number };
    assert.equal(count.count, 1, 'invalid AsyncAPI YAML actions must not delete existing breaking links');
  } finally {
    db.close();
  }
});

test('analyzeContractDiff treats invalid AsyncAPI JSON v3 actions as unknown and preserves existing breaking links', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithAsyncApiJsonContract();
  seedAsyncApiConsumesLink(consumerRoot, providerRoot, 'contracts/asyncapi.json');
  await writeAsyncApiJsonContract(providerRoot, { includeOrderSubmittedOperation: false });
  const breakingResult = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'orders-events',
    contractPath: 'contracts/asyncapi.json'
  });
  assert.equal(breakingResult.summary.classification, 'breaking');
  assert.equal(breakingResult.summary.impactedConsumerCount, 1);

  await writeAsyncApiJsonContract(providerRoot, { operationAction: 'publish' });
  const unknownResult = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'orders-events',
    contractPath: 'contracts/asyncapi.json'
  });

  assert.equal(unknownResult.summary.classification, 'unknown');
  assert.deepEqual(unknownResult.changes, [
    {
      kind: 'unparsed_current_contract',
      classification: 'unknown',
      reason: 'current AsyncAPI JSON could not be parsed: operation action must be send or receive for publishOrderSubmitted'
    }
  ]);

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const count = db
      .prepare('SELECT count(*) AS count FROM cross_repo_links WHERE kind = ?')
      .get('BREAKS_COMPATIBILITY_WITH') as { count: number };
    assert.equal(count.count, 1, 'invalid AsyncAPI JSON actions must not delete existing breaking links');
  } finally {
    db.close();
  }
});

test('analyzeContractDiff does not treat overlapping OpenAPI JSON allOf branch reordering as breaking', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedJsonOverlappingAllOfContract();
  await writeOpenApiJsonOverlappingAllOfContract(providerRoot, 'enum-then-string');

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });

  assert.equal(result.summary.breakingChangeCount, 0);
  assert.equal(
    result.changes.some((change) => change.kind === 'changed_response_property_type'),
    false
  );
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_contract_without_endpoint_delta',
      classification: 'unknown',
      reason: 'contract content changed but endpoint surface is unchanged in the v0 analyzer'
    }
  ]);
});

test('analyzeContractDiff warns when indexed OpenAPI compatibility baseline is stale', async () => {
  const { consumerRoot, providerRoot } = await setupWorkspaceWithResolvedJsonNestedSchemaContract();
  downgradeOpenApiCompatibilityBaseline(providerRoot, 1);
  await writeOpenApiJsonNestedSchemaContract(providerRoot, { responseMemberIdType: 'integer' });

  const result = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'users-api',
    contractPath: 'contracts/openapi.json'
  });

  assert.equal(result.summary.classification, 'unknown');
  assert.equal(
    result.changes.some((change) => change.kind === 'changed_response_property_type'),
    false
  );
  assert.deepEqual(result.changes, [
    {
      kind: 'changed_contract_without_endpoint_delta',
      classification: 'unknown',
      reason: 'contract content changed but endpoint surface is unchanged in the v0 analyzer'
    }
  ]);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes('indexed OpenAPI compatibility baseline uses schemaVersion 1') &&
      warning.includes('reindex provider contract')
    ),
    `expected stale compatibility warning, got ${JSON.stringify(result.warnings)}`
  );
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
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'parallax-diff-outside-contract-'));
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
  const repoRoot = await makeRepo('parallax-diff-help-');

  const cliRun = runCli(repoRoot, ['--help']);

  assert.equal(cliRun.status, 0);
  assert.match(cliRun.stdout, /workspace contract-diff --contract <path>/);
  assert.match(cliRun.stdout, /--provider-path <path>/);
});
