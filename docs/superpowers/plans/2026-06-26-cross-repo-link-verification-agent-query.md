# Cross-Repo Link Verification And Agent Query Implementation Plan

**English** · [한국어](2026-06-26-cross-repo-link-verification-agent-query.ko.md) · [中文](2026-06-26-cross-repo-link-verification-agent-query.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build W2+W6 so Parallax can verify persisted cross-repo link consistency and answer provider/consumer reverse queries through CLI and MCP.

**Architecture:** Add one shared `src/cross_repo_links.ts` read model over the existing `cross_repo_links` table. Keep canonical link writes directional; expose bidirectional traversal through `verifyCrossRepoLinks`, `consumersOf`, and `providersFor`. Refactor `resolveCrossRepoContracts` with a `persist?: boolean` option so CLI keeps its persisted workflow while MCP gets a non-persisting preview.

**Tech Stack:** TypeScript, Node.js `node:test`, SQLite `node:sqlite`, existing Parallax workspace/catalog APIs, MCP SDK with Zod input schemas, Markdown docs.

## Global Constraints

- Do not add a schema migration; this slice reads existing `cross_repo_links`, `workspaces`, `workspace_repos`, and `repos`.
- Do not write duplicate inverse rows to `cross_repo_links`.
- "Bidirectional" means provider-to-consumer and consumer-to-provider traversal from one canonical directional row.
- `workspace verify`, `workspace consumers`, and `workspace providers` must not run resolution or contract diff.
- `parallax_cross_repo_consumers` and `parallax_cross_repo_providers` must set `readOnlyHint: true`.
- `parallax_resolve_cross_repo_contracts` must be a non-persisting MCP preview and must not clear or insert `cross_repo_links`.
- Existing CLI `parallax workspace resolve-contracts` keeps persisted behavior.
- MCP compact results should prefer service names, contract paths, consumer paths, and `parallax://` resources over absolute local paths.
- Keep English, Korean, and Chinese public docs meaning-equivalent when touching translated docs.
- Final acceptance requires `npm run verify`.

---

## Scope Check

The approved spec covers one cohesive subsystem: cross-repo link verification and persisted-link queryability. The implementation can be one plan because all tasks share the same read model and can be reviewed in sequence.

## File Structure

- Create `src/cross_repo_links.ts`: normalized read model, provenance parsing, diagnostics, `verifyCrossRepoLinks`, `consumersOf`, `providersFor`.
- Modify `src/cross_repo_resolver.ts`: add `persist?: boolean` option and skip DB writes when `persist === false`.
- Modify `src/index.ts`: export the new public APIs and updated resolver types.
- Modify `src/cli.ts`: add `workspace verify`, `workspace consumers`, and `workspace providers`.
- Modify `src/mcp.ts`: add `parallax_cross_repo_consumers`, `parallax_cross_repo_providers`, and read-only preview `parallax_resolve_cross_repo_contracts`.
- Modify `tests/cross-repo-resolver.test.ts`: cover resolver preview non-mutation.
- Create `tests/cross-repo-links.test.ts`: focused read-model and CLI coverage.
- Modify `tests/mcp.test.ts`: tools/list/docs parity, read-only annotations, query tool behavior, preview non-mutation.
- Modify `docs/cli-reference*.md`, `docs/mcp*.md`, `skills/parallax/SKILL*.md`, `docs/roadmap*.md`, `IMPROVEMENT_OPPORTUNITIES.md`: public docs and backlog status.
- Optionally update `docs/verification*.md` only if the implementation wires a new command into `npm run verify`; this plan does not require changing the verify script.

---

### Task 1: Shared Cross-Repo Link Read Model

**Files:**
- Create: `src/cross_repo_links.ts`
- Create: `tests/cross-repo-links.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces:
  - `verifyCrossRepoLinks(options: CrossRepoLinkVerifyOptions): CrossRepoLinkVerifyResult`
  - `consumersOf(options: CrossRepoConsumersOptions): CrossRepoConsumersResult`
  - `providersFor(options: CrossRepoProvidersOptions): CrossRepoProvidersResult`
  - `CrossRepoLinkRecord`, `CrossRepoDiagnostic`, `CrossRepoConsumer`, `CrossRepoProvider`
- Consumes:
  - `openDatabase`, `listWorkspaces`, `workspaceResources`, `parseJsonObject`, `asConfidence`

- [ ] **Step 1: Write failing read-model tests**

Create `tests/cross-repo-links.test.ts` with this structure:

```ts
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
```

Append these initial tests:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --import tsx --test tests/cross-repo-links.test.ts
```

Expected: TypeScript/runtime failure because `consumersOf`, `providersFor`, and `verifyCrossRepoLinks` are not exported.

- [ ] **Step 3: Implement `src/cross_repo_links.ts` types and public functions**

Create `src/cross_repo_links.ts`. Use this shape exactly; helper function internals may be split for clarity, but the exported names and return fields must remain stable:

```ts
import { asConfidence } from './confidence.js';
import { endpointKey, parseJsonObject } from './contract_diff/shared.js';
import { openDatabase } from './store.js';
import type { Confidence } from './types.js';
import { listWorkspaces, type WorkspaceSummary } from './workspace.js';
import { workspaceResources, type WorkspaceResourceUris } from './workspace_resources.js';

export type CrossRepoLinkKind = 'CONSUMES_HTTP_ENDPOINT' | 'BREAKS_COMPATIBILITY_WITH';
export type CrossRepoDiagnosticKind = 'malformed_link' | 'stale_workspace_link' | 'orphan_breaking_link';

export type CrossRepoEndpoint = {
  method: string;
  path: string;
};

export type CrossRepoLinkRecord = {
  id: string;
  workspace: string;
  kind: CrossRepoLinkKind;
  confidence: Confidence;
  source: {
    serviceName?: string;
    repoPath?: string;
    path?: string;
    inWorkspace: boolean;
  };
  target: {
    serviceName?: string;
    repoPath?: string;
    contractPath?: string;
    inWorkspace: boolean;
  };
  endpoint?: CrossRepoEndpoint;
  change?: {
    kind: string;
    method?: string;
    path?: string;
  };
  evidence?: {
    filePath?: string;
    snippet?: string;
  };
  provenance: unknown;
};

export type CrossRepoDiagnostic = {
  kind: CrossRepoDiagnosticKind;
  id: string;
  linkKind?: string;
  message: string;
};

export type CrossRepoLinkVerifyOptions = {
  repoRoot: string;
  workspaceName?: string;
};

export type CrossRepoLinkVerifyResult = {
  version: 0;
  workspace: WorkspaceSummary;
  summary: {
    passed: boolean;
    totalLinks: number;
    consumesLinks: number;
    breakingLinks: number;
    malformedLinks: number;
    staleWorkspaceLinks: number;
    orphanBreakingLinks: number;
  };
  diagnostics: {
    malformedLinks: CrossRepoDiagnostic[];
    staleWorkspaceLinks: CrossRepoDiagnostic[];
    orphanBreakingLinks: CrossRepoDiagnostic[];
  };
  resources: WorkspaceResourceUris;
};

export type CrossRepoConsumersOptions = {
  repoRoot: string;
  workspaceName?: string;
  providerServiceName: string;
  providerContractPath?: string;
  method?: string;
  routePath?: string;
};

export type CrossRepoProvidersOptions = {
  repoRoot: string;
  workspaceName?: string;
  consumerServiceName: string;
  consumerPath?: string;
};

export type CrossRepoConsumer = {
  linkId: string;
  kind: CrossRepoLinkKind;
  confidence: Confidence;
  consumerService: string;
  consumerRepoPath?: string;
  consumerPath: string;
  providerService: string;
  providerRepoPath?: string;
  providerContractPath: string;
  httpMethod: string;
  routePath: string;
};

export type CrossRepoProvider = CrossRepoConsumer;

export type CrossRepoConsumersResult = {
  version: 0;
  workspace: WorkspaceSummary;
  consumers: CrossRepoConsumer[];
  warnings: string[];
  resources: WorkspaceResourceUris;
};

export type CrossRepoProvidersResult = {
  version: 0;
  workspace: WorkspaceSummary;
  providers: CrossRepoProvider[];
  warnings: string[];
  resources: WorkspaceResourceUris;
};
```

Implement the public functions with these rules:

```ts
export function verifyCrossRepoLinks(options: CrossRepoLinkVerifyOptions): CrossRepoLinkVerifyResult {
  const workspace = selectWorkspace(options.repoRoot, options.workspaceName);
  const db = openDatabase(options.repoRoot, { readOnly: true });
  try {
    const loaded = loadWorkspaceLinkRecords(db, workspace.name);
    const malformedLinks = loaded.malformed;
    const staleWorkspaceLinks = loaded.records
      .filter((record) => !record.source.inWorkspace || !record.target.inWorkspace)
      .map((record) => staleDiagnostic(record));
    const orphanBreakingLinks = orphanBreakingDiagnostics(loaded.records);
    return {
      version: 0,
      workspace,
      summary: {
        passed: malformedLinks.length === 0 && staleWorkspaceLinks.length === 0 && orphanBreakingLinks.length === 0,
        totalLinks: loaded.rowsSeen,
        consumesLinks: loaded.records.filter((record) => record.kind === 'CONSUMES_HTTP_ENDPOINT').length,
        breakingLinks: loaded.records.filter((record) => record.kind === 'BREAKS_COMPATIBILITY_WITH').length,
        malformedLinks: malformedLinks.length,
        staleWorkspaceLinks: staleWorkspaceLinks.length,
        orphanBreakingLinks: orphanBreakingLinks.length
      },
      diagnostics: { malformedLinks, staleWorkspaceLinks, orphanBreakingLinks },
      resources: workspaceResources(workspace.name)
    };
  } finally {
    db.close();
  }
}
```

```ts
export function consumersOf(options: CrossRepoConsumersOptions): CrossRepoConsumersResult {
  const workspace = selectWorkspace(options.repoRoot, options.workspaceName);
  const db = openDatabase(options.repoRoot, { readOnly: true });
  try {
    const loaded = loadWorkspaceLinkRecords(db, workspace.name);
    const method = options.method?.toUpperCase();
    const consumers = loaded.records
      .filter((record) => record.kind === 'CONSUMES_HTTP_ENDPOINT')
      .filter((record) => record.target.serviceName === options.providerServiceName)
      .filter((record) => options.providerContractPath === undefined || record.target.contractPath === options.providerContractPath)
      .filter((record) => method === undefined || record.endpoint?.method.toUpperCase() === method)
      .filter((record) => options.routePath === undefined || record.endpoint?.path === options.routePath)
      .map(recordToConsumer)
      .sort(compareConsumerRows);
    return {
      version: 0,
      workspace,
      consumers,
      warnings: consumers.length === 0 ? ['no persisted cross-repo consumers matched; run parallax workspace resolve-contracts if links are stale'] : [],
      resources: workspaceResources(workspace.name)
    };
  } finally {
    db.close();
  }
}
```

```ts
export function providersFor(options: CrossRepoProvidersOptions): CrossRepoProvidersResult {
  const workspace = selectWorkspace(options.repoRoot, options.workspaceName);
  const db = openDatabase(options.repoRoot, { readOnly: true });
  try {
    const loaded = loadWorkspaceLinkRecords(db, workspace.name);
    const providers = loaded.records
      .filter((record) => record.kind === 'CONSUMES_HTTP_ENDPOINT')
      .filter((record) => record.source.serviceName === options.consumerServiceName)
      .filter((record) => options.consumerPath === undefined || record.source.path === options.consumerPath)
      .map(recordToConsumer)
      .sort(compareConsumerRows);
    return {
      version: 0,
      workspace,
      providers,
      warnings: providers.length === 0 ? ['no persisted cross-repo providers matched; run parallax workspace resolve-contracts if links are stale'] : [],
      resources: workspaceResources(workspace.name)
    };
  } finally {
    db.close();
  }
}
```

Use one internal SQL loader with `LEFT JOIN` for workspace membership:

```sql
SELECT
  link.id, link.kind, link.confidence, link.provenance,
  workspace.name AS workspace_name,
  source_repo.root AS source_repo_root,
  target_repo.root AS target_repo_root,
  source_member.local_path AS source_member_path,
  source_member.service_name AS source_service_name,
  target_member.local_path AS target_member_path,
  target_member.service_name AS target_service_name
FROM cross_repo_links link
LEFT JOIN workspaces workspace ON workspace.id = link.workspace_id
LEFT JOIN repos source_repo ON source_repo.id = link.source_repo_id
LEFT JOIN repos target_repo ON target_repo.id = link.target_repo_id
LEFT JOIN workspace_repos source_member
  ON source_member.workspace_id = link.workspace_id
 AND source_member.repo_id = link.source_repo_id
LEFT JOIN workspace_repos target_member
  ON target_member.workspace_id = link.workspace_id
 AND target_member.repo_id = link.target_repo_id
WHERE workspace.name = ?
ORDER BY link.kind, link.id
```

Parsing requirements:

- `CONSUMES_HTTP_ENDPOINT` provenance requires `consumer.serviceName`, `consumer.path`, `provider.serviceName`, `provider.contractPath`, `http.method`, and `http.path`.
- `BREAKS_COMPATIBILITY_WITH` provenance requires `consumer.serviceName`, `consumer.path`, `provider.serviceName`, `provider.contractPath`, `change.kind`, `change.method`, and `change.path`.
- `repoPath` fields are optional in normalized records, but if present and different from the joined workspace member path, classify the row as stale.
- Orphan matching key is `consumer repo/path + provider repo/contract + METHOD route`. Use `endpointKey(method, routePath)` to normalize method case.

Implement helper names exactly so later tasks can use them:

```ts
function selectWorkspace(repoRoot: string, workspaceName?: string): WorkspaceSummary;
function loadWorkspaceLinkRecords(db: ReturnType<typeof openDatabase>, workspaceName: string): {
  rowsSeen: number;
  records: CrossRepoLinkRecord[];
  malformed: CrossRepoDiagnostic[];
};
function recordToConsumer(record: CrossRepoLinkRecord): CrossRepoConsumer;
```

- [ ] **Step 4: Export new APIs from `src/index.ts`**

Add:

```ts
export {
  consumersOf,
  providersFor,
  verifyCrossRepoLinks
} from './cross_repo_links.js';
export type {
  CrossRepoConsumer,
  CrossRepoConsumersOptions,
  CrossRepoConsumersResult,
  CrossRepoDiagnostic,
  CrossRepoLinkRecord,
  CrossRepoLinkVerifyOptions,
  CrossRepoLinkVerifyResult,
  CrossRepoProvider,
  CrossRepoProvidersOptions,
  CrossRepoProvidersResult
} from './cross_repo_links.js';
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --import tsx --test tests/cross-repo-links.test.ts
```

Expected: all read-model tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/cross_repo_links.ts src/index.ts tests/cross-repo-links.test.ts
git commit -m "feat(workspace): verify cross-repo links"
```

---

### Task 2: CLI Workspace Verification And Reverse Query Commands

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/cross-repo-links.test.ts`

**Interfaces:**
- Consumes: `verifyCrossRepoLinks`, `consumersOf`, `providersFor` from Task 1.
- Produces:
  - `parallax workspace verify [--name <name>] [--json]`
  - `parallax workspace consumers --provider <service> [--contract <path>] [--method <method>] [--path <route>] [--name <name>] [--json]`
  - `parallax workspace providers --consumer <service> [--file <path>] [--name <name>] [--json]`

- [ ] **Step 1: Add failing CLI tests**

Append to `tests/cross-repo-links.test.ts`:

```ts
test('CLI workspace verify prints JSON and exits non-zero for orphan diagnostics', async () => {
  const { consumerRoot } = await makeLinkedWorkspace();
  const ok = runCli(consumerRoot, ['workspace', 'verify', '--name', 'platform', '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  const okJson = JSON.parse(ok.stdout) as { summary: { passed: boolean; totalLinks: number } };
  assert.equal(okJson.summary.passed, true);
  assert.equal(okJson.summary.totalLinks, 2);

  const db = new DatabaseSync(databasePath(consumerRoot));
  try {
    db.prepare("DELETE FROM cross_repo_links WHERE kind = 'CONSUMES_HTTP_ENDPOINT'").run();
  } finally {
    db.close();
  }

  const bad = runCli(consumerRoot, ['workspace', 'verify', '--name', 'platform']);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /Workspace platform cross-repo links: failed/);
  assert.match(bad.stdout, /Orphan breaking links: 1/);
});

test('CLI workspace consumers and providers return persisted reverse queries', async () => {
  const { consumerRoot } = await makeLinkedWorkspace();

  const consumers = runCli(consumerRoot, [
    'workspace',
    'consumers',
    '--name',
    'platform',
    '--provider',
    'users-api',
    '--contract',
    'contracts/openapi.yaml',
    '--method',
    'get',
    '--path',
    '/api/users',
    '--json'
  ]);
  assert.equal(consumers.status, 0, consumers.stderr);
  const consumersJson = JSON.parse(consumers.stdout) as { consumers: Array<{ consumerService: string; consumerPath: string }> };
  assert.deepEqual(consumersJson.consumers.map((consumer) => [consumer.consumerService, consumer.consumerPath]), [
    ['web', 'src/client.ts']
  ]);

  const providers = runCli(consumerRoot, [
    'workspace',
    'providers',
    '--name',
    'platform',
    '--consumer',
    'web',
    '--file',
    'src/client.ts'
  ]);
  assert.equal(providers.status, 0, providers.stderr);
  assert.match(providers.stdout, /web:src\/client\.ts <- users-api:GET \/api\/users \(contracts\/openapi\.yaml\)/);
});
```

- [ ] **Step 2: Run CLI tests to verify they fail**

Run:

```bash
node --import tsx --test tests/cross-repo-links.test.ts --test-name-pattern "CLI workspace"
```

Expected: unknown workspace subcommand failure.

- [ ] **Step 3: Add CLI command handlers**

In the `if (command === 'workspace')` block in `src/cli.ts`, add these branches after `contract-diff`:

```ts
    if (subcommand === 'verify') {
      const { verifyCrossRepoLinks } = await import('./index.js');
      const name = parseOptionalWorkspaceArg(workspaceArgs, '--name');
      const result = verifyCrossRepoLinks({
        repoRoot,
        ...(name !== undefined ? { workspaceName: name } : {})
      });
      if (workspaceArgs.includes('--json')) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Workspace ${result.workspace.name} cross-repo links: ${result.summary.passed ? 'passed' : 'failed'}`);
        console.log(`Links: ${result.summary.totalLinks} total, ${result.summary.consumesLinks} consumes, ${result.summary.breakingLinks} breaking`);
        console.log(`Malformed links: ${result.summary.malformedLinks}`);
        console.log(`Stale workspace links: ${result.summary.staleWorkspaceLinks}`);
        console.log(`Orphan breaking links: ${result.summary.orphanBreakingLinks}`);
        for (const diagnostic of [
          ...result.diagnostics.malformedLinks,
          ...result.diagnostics.staleWorkspaceLinks,
          ...result.diagnostics.orphanBreakingLinks
        ]) {
          console.log(`diagnostic: ${diagnostic.id}: ${diagnostic.message}`);
        }
      }
      process.exitCode = result.summary.passed ? 0 : 1;
      return;
    }
    if (subcommand === 'consumers') {
      const { consumersOf } = await import('./index.js');
      const name = parseOptionalWorkspaceArg(workspaceArgs, '--name');
      const providerServiceName = parseRequiredArg(workspaceArgs, '--provider');
      const providerContractPath = parseOptionalWorkspaceArg(workspaceArgs, '--contract');
      const method = parseOptionalWorkspaceArg(workspaceArgs, '--method');
      const routePath = parseOptionalWorkspaceArg(workspaceArgs, '--path');
      const result = consumersOf({
        repoRoot,
        providerServiceName,
        ...(name !== undefined ? { workspaceName: name } : {}),
        ...(providerContractPath !== undefined ? { providerContractPath } : {}),
        ...(method !== undefined ? { method } : {}),
        ...(routePath !== undefined ? { routePath } : {})
      });
      if (workspaceArgs.includes('--json')) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const consumer of result.consumers) {
          console.log(`${consumer.consumerService}:${consumer.consumerPath} -> ${consumer.providerService}:${consumer.httpMethod} ${consumer.routePath} (${consumer.providerContractPath})`);
        }
        for (const warning of result.warnings) console.error(`warning: ${warning}`);
      }
      return;
    }
    if (subcommand === 'providers') {
      const { providersFor } = await import('./index.js');
      const name = parseOptionalWorkspaceArg(workspaceArgs, '--name');
      const consumerServiceName = parseRequiredArg(workspaceArgs, '--consumer');
      const consumerPath = parseOptionalWorkspaceArg(workspaceArgs, '--file');
      const result = providersFor({
        repoRoot,
        consumerServiceName,
        ...(name !== undefined ? { workspaceName: name } : {}),
        ...(consumerPath !== undefined ? { consumerPath } : {})
      });
      if (workspaceArgs.includes('--json')) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const provider of result.providers) {
          console.log(`${provider.consumerService}:${provider.consumerPath} <- ${provider.providerService}:${provider.httpMethod} ${provider.routePath} (${provider.providerContractPath})`);
        }
        for (const warning of result.warnings) console.error(`warning: ${warning}`);
      }
      return;
    }
```

Update the workspace error string to:

```ts
throw new Error('workspace requires init, add-repo, list, resolve-contracts, contract-diff, verify, consumers, or providers');
```

Update `printHelp()` with:

```text
  parallax workspace verify [--name <name>] [--json]
  parallax workspace consumers --provider <service> [--contract <path>] [--method <method>] [--path <route>] [--name <name>] [--json]
  parallax workspace providers --consumer <service> [--file <path>] [--name <name>] [--json]
```

Add `--provider`, `--provider-path`, `--contract`, `--method`, `--path`, `--consumer`, and `--file` to `parsePositionals` value flags if needed so positional parsing does not misread workspace options.

- [ ] **Step 4: Run focused CLI tests**

Run:

```bash
node --import tsx --test tests/cross-repo-links.test.ts --test-name-pattern "CLI workspace"
```

Expected: both CLI tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cross-repo-links.test.ts
git commit -m "feat(cli): query cross-repo workspace links"
```

---

### Task 3: MCP Cross-Repo Query Tools And Resolution Preview

**Files:**
- Modify: `src/cross_repo_resolver.ts`
- Modify: `src/index.ts`
- Modify: `src/mcp.ts`
- Modify: `tests/cross-repo-resolver.test.ts`
- Modify: `tests/mcp.test.ts`
- Modify: `docs/mcp*.md`
- Modify: `skills/parallax/SKILL*.md`

**Interfaces:**
- Consumes: Task 1 `consumersOf`, `providersFor`; existing `resolveCrossRepoContracts`.
- Produces:
  - `ResolveCrossRepoContractsOptions.persist?: boolean`
  - `parallax_cross_repo_consumers` with `readOnlyHint: true`
  - `parallax_cross_repo_providers` with `readOnlyHint: true`
  - `parallax_resolve_cross_repo_contracts` with `readOnlyHint: true` and non-persisting behavior

- [ ] **Step 1: Add failing resolver preview test**

Append to `tests/cross-repo-resolver.test.ts`:

```ts
test('resolveCrossRepoContracts persist false previews links without mutating cross_repo_links', async () => {
  const consumerRoot = await makeRepo('parallax-preview-consumer-');
  const providerRoot = await makeRepo('parallax-preview-provider-');
  await mkdir(path.join(providerRoot, 'contracts'), { recursive: true });
  await writeFile(path.join(consumerRoot, 'src/client.ts'), [
    'export async function loadUsers() {',
    '  return fetch("https://users.example.test/api/users");',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(providerRoot, 'contracts/openapi.yaml'), [
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
  ].join('\n'));
  await initProject({ repoRoot: consumerRoot });
  await initProject({ repoRoot: providerRoot });
  await indexProject({ repoRoot: consumerRoot });
  await indexProject({ repoRoot: providerRoot });
  initWorkspace({ repoRoot: consumerRoot, name: 'platform', serviceName: 'web' });
  addWorkspaceRepo({ repoRoot: consumerRoot, workspaceName: 'platform', localPath: providerRoot, serviceName: 'users-api' });

  const preview = resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform', persist: false });
  assert.equal(preview.links.length, 1);

  const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
  try {
    const row = db.prepare('SELECT count(*) AS count FROM cross_repo_links').get() as { count: number };
    assert.equal(row.count, 0);
  } finally {
    db.close();
  }
});
```

- [ ] **Step 2: Refactor resolver `persist` option**

In `src/cross_repo_resolver.ts`, update:

```ts
export type ResolveCrossRepoContractsOptions = {
  repoRoot: string;
  workspaceName?: string;
  persist?: boolean;
};
```

In `resolveCrossRepoContracts`, replace:

```ts
persistCrossRepoLinks(repoRoot, workspace.name, links);
```

with:

```ts
if (options.persist !== false) {
  persistCrossRepoLinks(repoRoot, workspace.name, links);
}
```

No existing CLI behavior changes because omitted `persist` still writes.

- [ ] **Step 3: Add failing MCP tests**

Update the `expectedTools` array in `tests/mcp.test.ts` to include:

```ts
      'parallax_cross_repo_consumers',
      'parallax_cross_repo_providers',
      'parallax_resolve_cross_repo_contracts',
```

Add annotation assertions in the tools/list test:

```ts
    assert.equal(toolByName.get('parallax_cross_repo_consumers')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('parallax_cross_repo_consumers')!.annotations?.idempotentHint, true);
    assert.equal(toolByName.get('parallax_cross_repo_providers')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('parallax_cross_repo_providers')!.annotations?.idempotentHint, true);
    assert.equal(toolByName.get('parallax_resolve_cross_repo_contracts')!.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('parallax_resolve_cross_repo_contracts')!.annotations?.idempotentHint, true);
```

Append behavior tests near the existing MCP contract-diff tests:

```ts
test('MCP cross-repo consumers and providers query persisted workspace links', async () => {
  const { consumerRoot } = await makeContractWorkspaceRepo();
  const client = new McpProcessClient(consumerRoot);
  try {
    await client.initialize();

    const consumers = await client.request('tools/call', {
      name: 'parallax_cross_repo_consumers',
      arguments: {
        workspaceName: 'platform',
        providerServiceName: 'users-api',
        providerContractPath: 'contracts/openapi.yaml',
        method: 'get',
        routePath: '/api/users'
      }
    });
    assert.equal(consumers.error, undefined);
    const consumersJson = JSON.parse(consumers.result.content[0].text) as {
      consumers: Array<{ consumerService: string; consumerPath: string; providerService: string }>;
      resources: { crossRepoLinks: string };
    };
    assert.deepEqual(consumersJson.consumers.map((consumer) => ({
      consumerService: consumer.consumerService,
      consumerPath: consumer.consumerPath,
      providerService: consumer.providerService
    })), [{
      consumerService: 'web',
      consumerPath: 'src/client.ts',
      providerService: 'users-api'
    }]);
    assert.equal(consumersJson.resources.crossRepoLinks, 'parallax://workspaces/platform/cross-repo-links');

    const providers = await client.request('tools/call', {
      name: 'parallax_cross_repo_providers',
      arguments: {
        workspaceName: 'platform',
        consumerServiceName: 'web',
        consumerPath: 'src/client.ts'
      }
    });
    assert.equal(providers.error, undefined);
    const providersJson = JSON.parse(providers.result.content[0].text) as {
      providers: Array<{ providerService: string; providerContractPath: string; httpMethod: string; routePath: string }>;
    };
    assert.deepEqual(providersJson.providers.map((provider) => ({
      providerService: provider.providerService,
      providerContractPath: provider.providerContractPath,
      httpMethod: provider.httpMethod,
      routePath: provider.routePath
    })), [{
      providerService: 'users-api',
      providerContractPath: 'contracts/openapi.yaml',
      httpMethod: 'GET',
      routePath: '/api/users'
    }]);
  } finally {
    await client.close();
  }
});

test('MCP resolve_cross_repo_contracts previews links without mutating persisted links', async () => {
  const { consumerRoot } = await makeContractWorkspaceRepo({ skipResolve: true });
  const client = new McpProcessClient(consumerRoot);
  try {
    await client.initialize();
    const response = await client.request('tools/call', {
      name: 'parallax_resolve_cross_repo_contracts',
      arguments: { workspaceName: 'platform' }
    });
    assert.equal(response.error, undefined);
    const preview = JSON.parse(response.result.content[0].text) as {
      links: Array<{ consumerService: string; providerService: string; routePath: string }>;
      resources: { crossRepoLinks: string };
    };
    assert.deepEqual(preview.links.map((link) => ({
      consumerService: link.consumerService,
      providerService: link.providerService,
      routePath: link.routePath
    })), [{
      consumerService: 'web',
      providerService: 'users-api',
      routePath: '/api/users'
    }]);

    const db = new DatabaseSync(databasePath(consumerRoot), { readOnly: true });
    try {
      const row = db.prepare('SELECT count(*) AS count FROM cross_repo_links').get() as { count: number };
      assert.equal(row.count, 0);
    } finally {
      db.close();
    }
  } finally {
    await client.close();
  }
});
```

If `makeContractWorkspaceRepo` currently always resolves links, update its signature to:

```ts
async function makeContractWorkspaceRepo(options: { skipResolve?: boolean } = {}): Promise<{ consumerRoot: string; providerRoot: string }> {
  // existing setup...
  if (options.skipResolve !== true) {
    resolveCrossRepoContracts({ repoRoot: consumerRoot, workspaceName: 'platform' });
  }
  return { consumerRoot, providerRoot };
}
```

- [ ] **Step 4: Register MCP tools**

In `src/mcp.ts`, add three `server.registerTool` blocks after `parallax_contract_diff`:

```ts
  server.registerTool(
    'parallax_cross_repo_consumers',
    {
      title: 'Find cross-repo consumers',
      description:
        'Query persisted workspace cross-repo links and return consumers of a provider service, contract, method, or route without mutating workspace links.',
      inputSchema: {
        workspaceName: z.string().trim().min(1).optional(),
        providerServiceName: z.string().trim().min(1),
        providerContractPath: z.string().trim().min(1).optional(),
        method: z.string().trim().min(1).optional(),
        routePath: z.string().trim().min(1).optional()
      },
      annotations: {
        title: 'Find cross-repo consumers',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ workspaceName, providerServiceName, providerContractPath, method, routePath }) => {
      try {
        const { consumersOf } = await import('./cross_repo_links.js');
        const result = consumersOf({
          repoRoot: context.repoRoot,
          providerServiceName,
          ...(workspaceName !== undefined ? { workspaceName } : {}),
          ...(providerContractPath !== undefined ? { providerContractPath } : {}),
          ...(method !== undefined ? { method } : {}),
          ...(routePath !== undefined ? { routePath } : {})
        });
        return toolJsonResponse(context, 'parallax_cross_repo_consumers', result, {
          query: providerServiceName,
          resourceCount: resourceCountOf(result)
        });
      } catch (error) {
        return typedToolErrorResponse(error);
      }
    }
  );
```

Add the analogous providers block:

```ts
  server.registerTool(
    'parallax_cross_repo_providers',
    {
      title: 'Find cross-repo providers',
      description:
        'Query persisted workspace cross-repo links and return providers used by a consumer service or file without mutating workspace links.',
      inputSchema: {
        workspaceName: z.string().trim().min(1).optional(),
        consumerServiceName: z.string().trim().min(1),
        consumerPath: z.string().trim().min(1).optional()
      },
      annotations: {
        title: 'Find cross-repo providers',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ workspaceName, consumerServiceName, consumerPath }) => {
      try {
        const { providersFor } = await import('./cross_repo_links.js');
        const result = providersFor({
          repoRoot: context.repoRoot,
          consumerServiceName,
          ...(workspaceName !== undefined ? { workspaceName } : {}),
          ...(consumerPath !== undefined ? { consumerPath } : {})
        });
        return toolJsonResponse(context, 'parallax_cross_repo_providers', result, {
          query: consumerServiceName,
          resourceCount: resourceCountOf(result)
        });
      } catch (error) {
        return typedToolErrorResponse(error);
      }
    }
  );
```

Add the preview block:

```ts
  server.registerTool(
    'parallax_resolve_cross_repo_contracts',
    {
      title: 'Preview cross-repo contract links',
      description:
        'Preview cross-repo provider/consumer contract links for a workspace without clearing or inserting cross_repo_links rows.',
      inputSchema: {
        workspaceName: z.string().trim().min(1).optional()
      },
      annotations: {
        title: 'Preview cross-repo contract links',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ workspaceName }) => {
      try {
        const { resolveCrossRepoContracts } = await import('./cross_repo_resolver.js');
        const result = resolveCrossRepoContracts({
          repoRoot: context.repoRoot,
          ...(workspaceName !== undefined ? { workspaceName } : {}),
          persist: false
        });
        const response = {
          ...result,
          resources: workspaceResources(result.workspace.name)
        };
        return toolJsonResponse(context, 'parallax_resolve_cross_repo_contracts', response, {
          query: result.workspace.name,
          resourceCount: resourceCountOf(response)
        });
      } catch (error) {
        return typedToolErrorResponse(error);
      }
    }
  );
```

- [ ] **Step 5: Update MCP docs and skill tables**

In all of these files:

- `docs/mcp.md`
- `docs/mcp.ko.md`
- `docs/mcp.zh.md`
- `skills/parallax/SKILL.md`
- `skills/parallax/SKILL.ko.md`
- `skills/parallax/SKILL.zh.md`

Add the three new tools to the tables, and update skill headings from `MCP tools surfaced (20)` to `MCP tools surfaced (23)`.

English rows:

```md
| `parallax_cross_repo_consumers` | Query persisted workspace links for consumers of a provider service/contract/route | Yes |
| `parallax_cross_repo_providers` | Query persisted workspace links for providers used by a consumer service/file | Yes |
| `parallax_resolve_cross_repo_contracts` | Preview cross-repo provider/consumer contract links without persisting workspace link rows | Yes |
```

For `skills/parallax/SKILL*.md`, use ✅ in the read-only column.

- [ ] **Step 6: Run MCP tests**

Run:

```bash
node --import tsx --test tests/cross-repo-resolver.test.ts --test-name-pattern "persist false"
npm run test:mcp -- --test-name-pattern "stdio server initializes|cross-repo consumers|resolve_cross_repo"
```

Expected: resolver preview, tools/list/docs parity, and MCP behavior tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/cross_repo_resolver.ts src/index.ts src/mcp.ts tests/cross-repo-resolver.test.ts tests/mcp.test.ts docs/mcp.md docs/mcp.ko.md docs/mcp.zh.md skills/parallax/SKILL.md skills/parallax/SKILL.ko.md skills/parallax/SKILL.zh.md
git commit -m "feat(mcp): preview and query cross-repo links"
```

---

### Task 4: Public Docs, Backlog Status, And Verification

**Files:**
- Modify: `docs/cli-reference.md`
- Modify: `docs/cli-reference.ko.md`
- Modify: `docs/cli-reference.zh.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/roadmap.ko.md`
- Modify: `docs/roadmap.zh.md`
- Modify: `IMPROVEMENT_OPPORTUNITIES.md`
- Optional modify: `docs/verification.md`, `docs/verification.ko.md`, `docs/verification.zh.md`

**Interfaces:**
- Consumes: CLI and MCP surfaces from Tasks 2 and 3.
- Produces: public docs and backlog status for W2/W6 implementation.

- [ ] **Step 1: Update CLI reference docs**

In `docs/cli-reference.md`, add rows under `## Workspace`:

```md
| `parallax workspace verify [--name <name>] [--json]` | Verify persisted cross-repo links and flag malformed, stale, or orphan rows |
| `parallax workspace consumers --provider <service> [--contract <path>] [--method <method>] [--path <route>] [--name <name>] [--json]` | List consumers of a provider from persisted workspace links |
| `parallax workspace providers --consumer <service> [--file <path>] [--name <name>] [--json]` | List providers used by a consumer from persisted workspace links |
```

Add this paragraph after the workspace table:

```md
`workspace verify`, `workspace consumers`, and `workspace providers` read persisted links only. They do not run resolution or contract diff. Use `workspace resolve-contracts` to refresh `CONSUMES_HTTP_ENDPOINT` links and `workspace contract-diff` to refresh `BREAKS_COMPATIBILITY_WITH` links.
```

Apply meaning-equivalent updates to `docs/cli-reference.ko.md` and `docs/cli-reference.zh.md`.

- [ ] **Step 2: Update roadmap and improvement backlog**

In `docs/roadmap*.md`, change the cross-repo consistency checkbox from unchecked to checked, with wording equivalent to:

```md
- [x] Keep cross-repo links queryable in both directions and verify malformed, stale, or orphan workspace rows
```

In `IMPROVEMENT_OPPORTUNITIES.md`, update W2 and W6:

```md
| W2 | ✅ **shipped** — cross-repo link consistency now has a shared read model plus `parallax workspace verify`, flagging malformed provenance, stale workspace membership, and orphan `BREAKS_COMPATIBILITY_WITH` rows without duplicate inverse storage. | M | HIGH |
| W6 | ✅ **shipped** — agents can query provider consumers/providers through read-only MCP tools and preview cross-repo resolution without mutating `cross_repo_links`; CLI persistence remains the explicit write workflow. | S | MED |
```

- [ ] **Step 3: Run docs and focused verification**

Run:

```bash
npm run docs:lint
node --import tsx --test tests/cross-repo-links.test.ts
node --import tsx --test tests/cross-repo-resolver.test.ts --test-name-pattern "persist false"
npm run test:mcp -- --test-name-pattern "stdio server initializes|cross-repo consumers|resolve_cross_repo"
```

Expected: all commands pass.

- [ ] **Step 4: Commit docs**

```bash
git add docs/cli-reference.md docs/cli-reference.ko.md docs/cli-reference.zh.md docs/roadmap.md docs/roadmap.ko.md docs/roadmap.zh.md IMPROVEMENT_OPPORTUNITIES.md docs/verification.md docs/verification.ko.md docs/verification.zh.md
git commit -m "docs: document cross-repo link verification"
```

If `docs/verification*.md` were not changed, omit those paths from `git add`.

- [ ] **Step 5: Final verification**

Run:

```bash
npm run lint
npm test -- --test-name-pattern "workspace|cross-repo|MCP"
npm run test:mcp
npm run bench
npm run verify
```

Expected:

- `npm run lint` passes.
- Focused test command passes.
- `npm run test:mcp` passes.
- `npm run bench` passes with `summary.passed: true`.
- `npm run verify` passes, including high-severity `npm audit`.

- [ ] **Step 6: Final commit if verification fixes were needed**

If final verification required fixes, commit them:

```bash
git status --short
git add src/cross_repo_links.ts src/cross_repo_resolver.ts src/index.ts src/cli.ts src/mcp.ts tests/cross-repo-links.test.ts tests/cross-repo-resolver.test.ts tests/mcp.test.ts docs/cli-reference.md docs/cli-reference.ko.md docs/cli-reference.zh.md docs/mcp.md docs/mcp.ko.md docs/mcp.zh.md docs/roadmap.md docs/roadmap.ko.md docs/roadmap.zh.md IMPROVEMENT_OPPORTUNITIES.md skills/parallax/SKILL.md skills/parallax/SKILL.ko.md skills/parallax/SKILL.zh.md
git commit -m "fix(workspace): stabilize cross-repo link verification"
```

If no files changed after final verification, do not create an empty commit.

---

## Plan Self-Review

**Spec coverage:** The plan covers the shared read model, malformed/stale/orphan diagnostics, CLI `verify/consumers/providers`, MCP query tools, MCP non-persisting resolution preview, docs/backlog updates, and final verification gate.

**Placeholder scan:** No `TBD`, `TODO`, `implement later`, or unnamed tool/function remains. Optional `docs/verification*.md` handling is conditional because the approved spec made it conditional on changing `npm run verify`.

**Type consistency:** Public names are consistent across tasks: `verifyCrossRepoLinks`, `consumersOf`, `providersFor`, `parallax_cross_repo_consumers`, `parallax_cross_repo_providers`, `parallax_resolve_cross_repo_contracts`, and `persist?: boolean`.

**Execution boundary:** This plan does not add repair, duplicate inverse rows, automatic `analyzeDiff` contract diff, remote discovery, monorepo cataloging, or permissioned MCP write tools.
