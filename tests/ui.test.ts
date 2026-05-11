import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { analyzeDiff, indexProject, initProject } from '../src/index.js';
import { normalizeRepoRoot } from '../src/security.js';
import { getRepoId, openDatabase } from '../src/store.js';
import { buildUiSnapshot, renderUiHtml, startUiServer } from '../src/ui.js';

const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve('tsx');

async function makeUiRepo(): Promise<{ repoRoot: string; reportId: string }> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-ui-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/a.ts'), 'import { b } from "./b";\nexport const a = b + 1;\n');
  await writeFile(path.join(repoRoot, 'src/b.ts'), 'export const b = 1;\n');
  await writeFile(path.join(repoRoot, 'README.md'), 'The UI fixture documents src/b.ts.\n');
  await initProject({ repoRoot });
  await indexProject({ repoRoot });
  const report = await analyzeDiff({
    repoRoot,
    changedFiles: ['src/b.ts'],
    writeReport: true
  });
  return { repoRoot, reportId: report.id };
}

test('UI snapshot and HTML render a list-first report workbench', async () => {
  const { repoRoot, reportId } = await makeUiRepo();
  try {
    const snapshot = await buildUiSnapshot({ repoRoot });
    assert.equal(snapshot.selectedReportId, reportId);
    assert.equal(snapshot.reports.length, 1);
    assert.equal(snapshot.selectedReport?.affectedCount, snapshot.selectedReport?.affectedFiles.length);
    assert.ok(snapshot.selectedReport?.affectedFiles.some((item) => item.path === 'src/a.ts'));
    assert.ok((snapshot.graph?.nodes.length ?? 0) > 0);
    assert.ok(snapshot.coverage?.coverage.some((item) => item.path === 'src/a.ts'));

    const html = renderUiHtml(snapshot);
    assert.match(html, /Impact Workbench/);
    assert.match(html, /Change Set/);
    assert.match(html, /Impact Paths/);
    assert.match(html, /Evidence/);
    assert.match(html, /Focused Graph/);
    assert.match(html, /Coverage Gaps/);
    assert.match(html, /overflow-wrap: anywhere/);
    assert.doesNotMatch(html, /landing/i);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('UI snapshot exposes typed empty states before reports exist', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-ui-empty-'));
  try {
    const missingDb = await buildUiSnapshot({ repoRoot });
    assert.equal(missingDb.selectedReportId, null);
    assert.ok(missingDb.errors.some((error) => error.code === 'database_missing'));

    await initProject({ repoRoot });
    await indexProject({ repoRoot });
    const noReports = await buildUiSnapshot({ repoRoot });
    assert.equal(noReports.selectedReportId, null);
    assert.ok(noReports.errors.some((error) => error.code === 'report_missing'));
    const html = renderUiHtml(noReports);
    assert.match(html, /report_missing/);
    assert.match(html, /value="">No reports/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('UI snapshot can select an older explicit report outside the latest selector window', async () => {
  const { repoRoot, reportId } = await makeUiRepo();
  try {
    seedRecentReportRows(repoRoot, reportId, 21);

    const snapshot = await buildUiSnapshot({ repoRoot, reportId });
    assert.equal(snapshot.selectedReportId, reportId);
    assert.equal(snapshot.selectedReport?.id, reportId);
    assert.ok(snapshot.reports.some((item) => item.id === reportId));
    assert.ok(snapshot.reports.length <= 20);
    assert.equal(snapshot.errors.length, 0);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('UI server exposes bootstrap and resource-shaped JSON endpoints', async () => {
  const { repoRoot, reportId } = await makeUiRepo();
  const ui = await startUiServer({ repoRoot, port: 0 });
  try {
    const htmlResponse = await fetch(ui.url);
    assert.equal(htmlResponse.status, 200);
    assert.match(htmlResponse.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    const html = await htmlResponse.text();
    assert.match(html, /Impact Workbench/);
    assert.ok(html.length > 5_000);

    const bootstrap = await (await fetch(new URL('/api/bootstrap', ui.url))).json() as {
      selectedReportId: string;
      selectedReport: { affectedFiles: unknown[] };
      graph: { nodes: unknown[] };
      coverage: { coverage: unknown[] };
    };
    assert.equal(bootstrap.selectedReportId, reportId);
    assert.ok(bootstrap.selectedReport.affectedFiles.length > 0);
    assert.ok(bootstrap.graph.nodes.length > 0);
    assert.ok(bootstrap.coverage.coverage.length > 0);

    const reportJson = await (await fetch(new URL(`/api/reports/${encodeURIComponent(reportId)}`, ui.url))).json() as {
      id: string;
      affectedFiles: unknown[];
    };
    assert.equal(reportJson.id, reportId);
    assert.ok(reportJson.affectedFiles.length > 0);

    const graphJson = await (await fetch(new URL(`/api/reports/${encodeURIComponent(reportId)}/graph/json?limit=1`, ui.url))).json() as {
      nodes: unknown[];
      edges: unknown[];
      rendered?: unknown;
      page: { limit: number; returnedNodes: number; nextCursor: string | null };
    };
    assert.equal(graphJson.page.limit, 1);
    assert.equal(graphJson.nodes.length, 1);
    assert.equal(graphJson.page.returnedNodes, 1);
    assert.ok(graphJson.page.nextCursor);
    assert.equal('rendered' in graphJson, false);

    const nextGraphJson = await (await fetch(new URL(`/api/reports/${encodeURIComponent(reportId)}/graph/json?limit=1&cursor=${encodeURIComponent(graphJson.page.nextCursor!)}`, ui.url))).json() as {
      page: { cursor: string | null; limit: number };
    };
    assert.equal(nextGraphJson.page.cursor, graphJson.page.nextCursor);
    assert.equal(nextGraphJson.page.limit, 1);

    const coverageJson = await (await fetch(new URL('/api/coverage/latest', ui.url))).json() as {
      coverage: Array<{ path: string }>;
    };
    assert.ok(coverageJson.coverage.some((item) => item.path === 'src/a.ts'));

    const missingPack = await (await fetch(new URL('/api/context-packs/missing-pack', ui.url))).json() as {
      error: { code: string };
    };
    assert.equal(missingPack.error.code, 'context_pack_not_found');
  } finally {
    await ui.close();
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('CLI ui prints a localhost URL and shuts down cleanly', async () => {
  const { repoRoot } = await makeUiRepo();
  let child: ChildProcess | null = null;
  try {
    child = spawn(process.execPath, ['--import', tsxLoaderPath, path.resolve('src/cli.ts'), 'ui', '--port', '0'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const runningChild = child;
    const url = await waitForUiUrl(runningChild);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const health = await (await fetch(new URL('/healthz', url))).json() as { ok: boolean };
    assert.equal(health.ok, true);
    runningChild.kill('SIGTERM');
    const code = await waitForExit(runningChild);
    assert.equal(code, 0);
  } finally {
    if (child && !child.killed) child.kill('SIGTERM');
    await rm(repoRoot, { recursive: true, force: true });
  }
});

function seedRecentReportRows(repoRoot: string, oldReportId: string, count: number): void {
  const normalizedRepoRoot = normalizeRepoRoot(repoRoot);
  const db = openDatabase(normalizedRepoRoot);
  try {
    const repoId = getRepoId(db, normalizedRepoRoot);
    const oldReport = db
      .prepare('SELECT index_run_id, json FROM reports WHERE repo_id = ? AND id = ?')
      .get(repoId, oldReportId) as { index_run_id: number; json: string } | undefined;
    assert.ok(oldReport);
    db.prepare("UPDATE reports SET created_at = '2000-01-01 00:00:00' WHERE repo_id = ? AND id = ?")
      .run(repoId, oldReportId);
    const insert = db.prepare('INSERT OR REPLACE INTO reports (id, repo_id, index_run_id, json, created_at) VALUES (?, ?, ?, ?, ?)');
    for (let index = 0; index < count; index += 1) {
      const id = `ui-recent-${index}`;
      const json = JSON.stringify({ ...JSON.parse(oldReport.json), id });
      insert.run(id, repoId, oldReport.index_run_id, json, `2030-01-01 00:00:${String(index).padStart(2, '0')}`);
    }
  } finally {
    db.close();
  }
}

function waitForUiUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for UI URL; output=${output}`)), 10_000);
    if (!child.stdout || !child.stderr) {
      clearTimeout(timer);
      reject(new Error('UI process did not expose stdout/stderr pipes'));
      return;
    }
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = /Impact Trace UI: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (!/Impact Trace UI: /.test(output)) {
        clearTimeout(timer);
        reject(new Error(`UI process exited before URL; code=${code}; output=${output}`));
      }
    });
  });
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}
