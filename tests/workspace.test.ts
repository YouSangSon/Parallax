import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { databasePath } from '../src/store.js';
import {
  addWorkspaceRepo,
  initWorkspace,
  listWorkspaces,
  syncWorkspaceCatalog,
  workspaceCatalogPath
} from '../src/workspace.js';

const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve('tsx');

async function makeRepo(prefix: string): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/app.ts'), 'export const app = 1;\n');
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

test('initWorkspace creates catalog and idempotent database rows', async () => {
  const repoRoot = await makeRepo('parallax-workspace-init-');
  const repoReal = realpathSync(repoRoot);

  const first = initWorkspace({ repoRoot, name: 'parallax', serviceName: 'api' });

  assert.equal(first.created, true);
  assert.equal(first.catalogPath, workspaceCatalogPath(repoRoot));
  const catalog = JSON.parse(await readFile(first.catalogPath, 'utf8')) as {
    schemaVersion: number;
    name: string;
    repos: Array<{
      localPath: string;
      serviceName: string;
      remoteUrl: string | null;
      trustPolicy: { readOnly: boolean };
    }>;
  };
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.name, 'parallax');
  assert.equal(catalog.repos.length, 1);
  assert.equal(realpathSync(path.resolve(path.dirname(first.catalogPath), catalog.repos[0]!.localPath)), repoReal);
  assert.deepEqual(catalog.repos[0]!.trustPolicy, { readOnly: true });

  const second = initWorkspace({ repoRoot, name: 'parallax', serviceName: 'api' });
  assert.equal(second.created, false);

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    assert.equal((db.prepare('SELECT count(*) AS count FROM workspaces').get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT count(*) AS count FROM repos').get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT count(*) AS count FROM workspace_repos').get() as { count: number }).count, 1);
    const row = db
      .prepare(
        `SELECT workspaces.name, workspace_repos.local_path, workspace_repos.service_name,
                workspace_repos.remote_url, workspace_repos.trust_policy_json
           FROM workspace_repos
           INNER JOIN workspaces ON workspaces.id = workspace_repos.workspace_id`
      )
      .get() as {
      name: string;
      local_path: string;
      service_name: string;
      remote_url: string | null;
      trust_policy_json: string;
    };
    assert.equal(row.name, 'parallax');
    assert.equal(row.local_path, repoReal);
    assert.equal(row.service_name, 'api');
    assert.equal(row.remote_url, null);
    assert.equal(row.trust_policy_json, '{"readOnly":true}');
  } finally {
    db.close();
  }
});

test('workspace CLI adds sibling repos, lists deterministic JSON, and updates on re-add', async () => {
  const repoRoot = await makeRepo('parallax-workspace-cli-');
  const siblingRepo = await makeRepo('parallax-workspace-sibling-');
  const repoReal = realpathSync(repoRoot);
  const siblingReal = realpathSync(siblingRepo);

  const initRun = runCli(repoRoot, ['workspace', 'init', '--name', 'platform', '--service', 'core']);
  assert.equal(initRun.status, 0, `workspace init failed: ${initRun.stderr}`);

  const siblingRelative = path.relative(repoRoot, siblingRepo);
  const firstAdd = runCli(repoRoot, [
    'workspace',
    'add-repo',
    siblingRelative,
    '--name',
    'platform',
    '--service',
    'worker',
    '--remote',
    'https://example.invalid/worker.git'
  ]);
  assert.equal(firstAdd.status, 0, `workspace add-repo failed: ${firstAdd.stderr}`);

  const updateAdd = runCli(repoRoot, [
    'workspace',
    'add-repo',
    siblingRelative,
    '--name',
    'platform',
    '--service',
    'jobs',
    '--remote',
    'https://example.invalid/jobs.git'
  ]);
  assert.equal(updateAdd.status, 0, `workspace add-repo update failed: ${updateAdd.stderr}`);

  const listRun = runCli(repoRoot, ['workspace', 'list', '--name', 'platform', '--json']);
  assert.equal(listRun.status, 0, `workspace list failed: ${listRun.stderr}`);
  assert.deepEqual(JSON.parse(listRun.stdout), {
    workspaces: [
      {
        name: 'platform',
        repos: [
          {
            localPath: repoReal,
            serviceName: 'core',
            remoteUrl: null,
            trustPolicy: { readOnly: true }
          },
          {
            localPath: siblingReal,
            serviceName: 'jobs',
            remoteUrl: 'https://example.invalid/jobs.git',
            trustPolicy: { readOnly: true }
          }
        ]
      }
    ]
  });

  const listed = listWorkspaces({ repoRoot, name: 'platform' });
  assert.deepEqual(listed, JSON.parse(listRun.stdout));

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    assert.equal((db.prepare('SELECT count(*) AS count FROM workspace_repos').get() as { count: number }).count, 2);
  } finally {
    db.close();
  }
});

test('workspace catalog rejects invalid local paths and duplicate resolved catalog paths', async () => {
  const repoRoot = await makeRepo('parallax-workspace-validation-');
  await initWorkspace({ repoRoot });
  const filePath = path.join(repoRoot, 'src/app.ts');

  for (const badPath of ['', 'nested\0repo', 'http://example.invalid/repo.git', 'https://example.invalid/repo.git', 'ssh://example.invalid/repo.git', 'git@example.invalid:repo.git']) {
    assert.throws(
      () => addWorkspaceRepo({ repoRoot, localPath: badPath }),
      /invalid|URL-like|git-style/,
      `expected ${badPath} to be rejected`
    );
  }

  assert.throws(
    () => addWorkspaceRepo({ repoRoot, localPath: path.join(repoRoot, 'missing') }),
    /does not exist/
  );
  assert.throws(
    () => addWorkspaceRepo({ repoRoot, localPath: filePath }),
    /not a directory/
  );

  const catalogPath = workspaceCatalogPath(repoRoot);
  await writeFile(
    catalogPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        name: 'parallax',
        repos: [
          { localPath: '..', serviceName: 'api', remoteUrl: null, trustPolicy: { readOnly: true } },
          { localPath: '../.', serviceName: 'api-copy', remoteUrl: null, trustPolicy: { readOnly: true } }
        ]
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  assert.throws(
    () => syncWorkspaceCatalog({ repoRoot }),
    /duplicate resolved local path/
  );
});

test('workspace init --force refuses symlinked catalog without overwriting target', async () => {
  const repoRoot = await makeRepo('parallax-workspace-symlink-');
  await mkdir(path.join(repoRoot, '.parallax'), { recursive: true });
  const targetPath = path.join(await mkdtemp(path.join(tmpdir(), 'parallax-workspace-target-')), 'target.json');
  await writeFile(targetPath, 'do not overwrite\n', 'utf8');
  await symlink(targetPath, workspaceCatalogPath(repoRoot));

  assert.throws(
    () => initWorkspace({ repoRoot, name: 'unsafe', force: true }),
    /workspace catalog must not be a symlink/
  );
  assert.equal(await readFile(targetPath, 'utf8'), 'do not overwrite\n');
});

test('workspace catalog sync rejects non-default catalog file overrides', async () => {
  const repoRoot = await makeRepo('parallax-workspace-file-override-');
  await initWorkspace({ repoRoot, name: 'default' });
  const altFile = path.join(repoRoot, 'alt-workspace.json');
  await writeFile(
    altFile,
    JSON.stringify({ schemaVersion: 1, name: 'alt', repos: [{ localPath: '.' }] }),
    'utf8'
  );

  assert.throws(
    () => syncWorkspaceCatalog({ repoRoot, file: altFile }),
    /workspace catalog file must be \.parallax\/workspace\.json/
  );
});

test('workspace catalog rename replaces the prior default workspace rows', async () => {
  const repoRoot = await makeRepo('parallax-workspace-rename-');
  const catalogPath = workspaceCatalogPath(repoRoot);

  initWorkspace({ repoRoot, name: 'one', serviceName: 'api' });
  initWorkspace({ repoRoot, name: 'two', serviceName: 'api', force: true });

  const listed = listWorkspaces({ repoRoot });
  assert.deepEqual(
    listed.workspaces.map((workspace) => workspace.name),
    ['two']
  );

  const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as { name: string };
  assert.equal(catalog.name, 'two');
});

test('workspace list syncs manual catalog edits before reading database rows', async () => {
  const repoRoot = await makeRepo('parallax-workspace-manual-sync-');
  const siblingRepo = await makeRepo('parallax-workspace-manual-sibling-');
  const repoReal = realpathSync(repoRoot);

  initWorkspace({ repoRoot, name: 'one', serviceName: 'api' });
  addWorkspaceRepo({ repoRoot, localPath: siblingRepo, serviceName: 'worker' });
  await writeFile(
    workspaceCatalogPath(repoRoot),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        name: 'two',
        repos: [
          {
            localPath: '..',
            serviceName: 'core',
            remoteUrl: null,
            trustPolicy: { readOnly: true }
          }
        ]
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  const listed = listWorkspaces({ repoRoot });
  assert.deepEqual(listed, {
    workspaces: [
      {
        name: 'two',
        repos: [
          {
            localPath: repoReal,
            serviceName: 'core',
            remoteUrl: null,
            trustPolicy: { readOnly: true }
          }
        ]
      }
    ]
  });

  const oldName = listWorkspaces({ repoRoot, name: 'one' });
  assert.deepEqual(oldName, { workspaces: [] });

  const listRun = runCli(repoRoot, ['workspace', 'list', '--name', 'two', '--json']);
  assert.equal(listRun.status, 0, `workspace list failed: ${listRun.stderr}`);
  assert.deepEqual(JSON.parse(listRun.stdout), listed);

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    assert.equal((db.prepare('SELECT count(*) AS count FROM workspaces').get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT count(*) AS count FROM workspace_repos').get() as { count: number }).count, 1);
  } finally {
    db.close();
  }
});

test('workspace CLI rejects missing flag values', async () => {
  const repoRoot = await makeRepo('parallax-workspace-cli-flags-');
  const initRun = runCli(repoRoot, ['workspace', 'init', '--name', '--service', 'api']);
  assert.notEqual(initRun.status, 0);
  assert.match(initRun.stderr, /missing value for --name/);

  const addRun = runCli(repoRoot, ['workspace', 'add-repo', '.', '--service', '--remote', 'https://example.invalid/repo.git']);
  assert.notEqual(addRun.status, 0);
  assert.match(addRun.stderr, /missing value for --service/);
});
