import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  addWorkspaceRepo,
  analyzeContractDiff,
  analyzeDiff,
  indexProject,
  initProject,
  initWorkspace,
  resolveCrossRepoContracts
} from '../src/index.js';
import { normalizeRepoRoot } from '../src/security.js';
import { getRepoId, openDatabase } from '../src/store.js';
import { buildUiSnapshot, renderUiHtml, startUiServer } from '../src/ui.js';

const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve('tsx');

async function makeUiRepo(): Promise<{ repoRoot: string; reportId: string }> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ui-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await mkdir(path.join(repoRoot, 'tests'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/a.ts'), 'import { b } from "./b";\nexport const a = b + 1;\n');
  await writeFile(path.join(repoRoot, 'src/b.ts'), 'export const b = 1;\n');
  await writeFile(path.join(repoRoot, 'tests/b.test.ts'), 'import { b } from "../src/b";\nif (b !== 1) throw new Error("bad fixture");\n');
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

async function makeUiWorkArtifactRepo(): Promise<{ repoRoot: string; reportId: string }> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ui-artifacts-'));
  await mkdir(path.join(repoRoot, 'src/auth'), { recursive: true });
  await mkdir(path.join(repoRoot, 'policies'), { recursive: true });
  await mkdir(path.join(repoRoot, 'docs/proposals'), { recursive: true });
  await mkdir(path.join(repoRoot, 'docs/prd'), { recursive: true });
  await mkdir(path.join(repoRoot, 'docs/requirements'), { recursive: true });
  await mkdir(path.join(repoRoot, 'docs/decisions'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/auth/session.ts'), 'export function rotateSession() { return "ok"; }\n');
  await writeFile(
    path.join(repoRoot, 'policies/security-auth.md'),
    [
      '---',
      'title: Security Auth Policy',
      'owner: security-platform',
      'status: approved',
      'updated: 2000-01-01',
      '---',
      '# Security auth policy',
      '',
      'Changes to src/auth/session.ts require security review.',
      '',
      'PRIVATE BODY SENTENCE should stay behind resource expansion.',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'docs/proposals/payment-retry.md'),
    [
      'The proposed retry flow updates src/auth/session.ts.',
      '',
      '```md',
      '# SECRET CUSTOMER INCIDENT NOTES',
      '```',
      '',
      '# Customer Acme incident notes',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'docs/prd/auth-context.md'),
    '# Auth context PRD\n\nThe auth context depends on src/auth/session.ts.\n'
  );
  await writeFile(
    path.join(repoRoot, 'docs/requirements/session-hardening.md'),
    '# Session hardening requirement\n\nThe requirement depends on src/auth/session.ts.\n'
  );
  await writeFile(
    path.join(repoRoot, 'docs/decisions/auth-session.md'),
    [
      '---',
      'title: Auth session decision',
      'updated: 2026-02-30',
      '---',
      '# Auth session decision',
      '',
      'This decision governs src/auth/session.ts.',
      ''
    ].join('\n')
  );
  await initProject({ repoRoot });
  await indexProject({ repoRoot });
  const report = await analyzeDiff({
    repoRoot,
    changedFiles: ['src/auth/session.ts'],
    writeReport: true
  });
  return { repoRoot, reportId: report.id };
}

async function makeUiWorkspaceRepo(): Promise<{ consumerRoot: string; providerRoot: string }> {
  const consumerRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ui-workspace-consumer-'));
  const providerRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ui-workspace-provider-'));
  await mkdir(path.join(consumerRoot, 'src'), { recursive: true });
  await writeFile(
    path.join(consumerRoot, 'src/orders-consumer.ts'),
    [
      'export function startOrdersConsumer(bus: { subscribe(topic: string, handler: () => void): void }) {',
      '  bus.subscribe("orders.submitted", () => undefined);',
      '}',
      ''
    ].join('\n')
  );
  await writeUiAsyncApiContract(providerRoot);

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
  assert.equal(resolved.links[0]?.eventTopology?.pattern, 'subscriber-call');

  await writeUiAsyncApiContract(providerRoot, { includeOrderSubmittedOperation: false });
  const diff = analyzeContractDiff({
    repoRoot: consumerRoot,
    workspaceName: 'platform',
    providerServiceName: 'orders-events',
    contractPath: 'contracts/asyncapi.yaml'
  });
  assert.equal(diff.summary.classification, 'breaking');
  assert.equal(diff.summary.eventTopologyCount, 1);

  return { consumerRoot, providerRoot };
}

async function writeUiAsyncApiContract(
  repoRoot: string,
  options: { includeOrderSubmittedOperation?: boolean } = {}
): Promise<void> {
  await mkdir(path.join(repoRoot, 'contracts'), { recursive: true });
  const includeOrderSubmittedOperation = options.includeOrderSubmittedOperation ?? true;
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
          "        $ref: '#/components/messages/OrderSubmitted'",
          'operations:',
          '  publishOrderSubmitted:',
          '    action: send',
          '    channel:',
          "      $ref: '#/channels/orderSubmitted'",
          '    messages:',
          "      - $ref: '#/channels/orderSubmitted/messages/OrderSubmitted'"
        ]
        : [
          'channels: {}',
          'operations: {}'
        ]),
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

test('UI snapshot and HTML render a list-first report workbench', async () => {
  const { repoRoot, reportId } = await makeUiRepo();
  try {
    const snapshot = await buildUiSnapshot({ repoRoot });
    assert.equal(snapshot.selectedReportId, reportId);
    assert.equal(snapshot.reports.length, 1);
    assert.equal(snapshot.selectedReport?.affectedCount, snapshot.selectedReport?.affectedFiles.length);
    assert.ok(snapshot.selectedReport?.affectedFiles.some((item) => item.path === 'src/a.ts'));
    assert.ok(snapshot.selectedReport?.actions.some((item) => item.target.path === 'tests/b.test.ts'));
    assert.ok((snapshot.graph?.nodes.length ?? 0) > 0);
    assert.ok(snapshot.coverage?.coverage.some((item) => item.path === 'src/a.ts'));

    const html = renderUiHtml(snapshot);
    assert.match(html, /Impact Workbench/);
    assert.match(html, /Change Set/);
    assert.match(html, /Impact Paths/);
    assert.match(html, /Evidence/);
    assert.match(html, /Impact Summary/);
    assert.match(html, /Impact Map/);
    assert.match(html, /class="impact-svg"/);
    assert.match(html, /Impact Inspector/);
    assert.match(html, /data-impact-path="src\/a\.ts"/);
    assert.match(html, /selectedImpactPath/);
    assert.match(html, /Verification Queue/);
    assert.match(html, /Verify tests\/b\.test\.ts/);
    assert.match(html, /class="copy-command"/);
    assert.match(html, /data-command="npm test -- tests\/b\.test\.ts"/);
    assert.match(html, /navigator\.clipboard\.writeText/);
    assert.match(html, /\/source\?path=tests%2Fb\.test\.ts&amp;line=1/);
    assert.match(html, /Open source L\d+/);
    assert.match(html, /\/source\?path=src%2Fa\.ts&amp;line=\d+/);
    assert.match(html, /Coverage Gaps/);
    assert.match(html, /Workspace Contracts/);
    assert.match(html, /overflow-wrap: anywhere/);
    assert.doesNotMatch(html, /landing/i);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('UI snapshot and HTML expose work artifact impact', async () => {
  const { repoRoot, reportId } = await makeUiWorkArtifactRepo();
  try {
    const snapshot = await buildUiSnapshot({ repoRoot });
    assert.equal(snapshot.selectedReportId, reportId);
    assert.deepEqual(snapshot.workArtifacts.map((item) => item.kind), ['policy', 'decision', 'prd', 'requirement', 'proposal']);
    assert.ok(snapshot.workArtifacts.some((item) =>
      item.path === 'policies/security-auth.md' && item.reason === 'governs src/auth/session.ts'
    ));
    const policy = snapshot.workArtifacts.find((item) => item.path === 'policies/security-auth.md');
    assert.equal(policy?.displayName, 'Security Auth Policy');
    assert.deepEqual(policy?.metadata, {
      title: 'Security Auth Policy',
      owner: 'security-platform',
      status: 'approved',
      updatedAt: '2000-01-01',
      source: 'frontmatter'
    });
    assert.equal(policy?.freshness.state, 'stale');
    assert.equal(policy?.freshness.thresholdDays, 90);
    assert.ok((policy?.freshness.ageDays ?? 0) > 90);
    assert.match(policy?.freshness.label ?? '', /^stale \d+d$/);
    const decision = snapshot.workArtifacts.find((item) => item.path === 'docs/decisions/auth-session.md');
    assert.equal(decision?.metadata?.updatedAt, '2026-02-30');
    assert.equal(decision?.freshness.state, 'unknown');
    assert.equal(decision?.freshness.label, 'review date unknown');
    assert.ok(snapshot.workArtifacts.some((item) =>
      item.path === 'docs/requirements/session-hardening.md' && item.reason === 'requires src/auth/session.ts'
    ));
    const requirement = snapshot.workArtifacts.find((item) => item.path === 'docs/requirements/session-hardening.md');
    assert.equal(requirement?.displayName, 'Session hardening requirement');
    assert.equal(requirement?.metadata?.source, 'heading');
    assert.equal(requirement?.freshness.state, 'unknown');
    assert.equal(requirement?.freshness.label, 'review date unknown');
    const proposal = snapshot.workArtifacts.find((item) => item.path === 'docs/proposals/payment-retry.md');
    assert.equal(proposal?.displayName, 'docs/proposals/payment-retry.md');
    assert.equal(proposal?.metadata, undefined);
    assert.ok(snapshot.workArtifacts.every((item) => item.resourceUri.startsWith('parallax://entities/')));
    assert.ok(snapshot.selectedReport?.evidence.some((item) => item.snippetOmitted === true));
    assert.equal(JSON.stringify(snapshot).includes('PRIVATE BODY SENTENCE'), false);
    assert.equal(JSON.stringify(snapshot).includes('SECRET CUSTOMER INCIDENT NOTES'), false);
    assert.equal(JSON.stringify(snapshot).includes('Customer Acme incident notes'), false);

    const html = renderUiHtml(snapshot);
    assert.match(html, /Work Artifacts/);
    assert.match(html, /Security Auth Policy/);
    assert.match(html, /stale \d+d/);
    assert.match(html, /review date unknown/);
    assert.match(html, /owner security-platform/);
    assert.match(html, /status approved/);
    assert.match(html, /updated 2000-01-01/);
    assert.match(html, /policies\/security-auth\.md/);
    assert.match(html, /docs\/requirements\/session-hardening\.md/);
    assert.match(html, /docs\/proposals\/payment-retry\.md/);
    assert.match(html, /bootstrap\.workArtifacts/);
    assert.doesNotMatch(html, /PRIVATE BODY SENTENCE/);
    assert.doesNotMatch(html, /SECRET CUSTOMER INCIDENT NOTES/);
    assert.doesNotMatch(html, /Customer Acme incident notes/);
    assert.match(html, /Work artifact evidence omitted from UI bootstrap/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('UI snapshot exposes typed empty states before reports exist', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ui-empty-'));
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

test('UI snapshot and API expose workspace contract topology', async () => {
  const { consumerRoot, providerRoot } = await makeUiWorkspaceRepo();
  let ui: Awaited<ReturnType<typeof startUiServer>> | undefined;
  try {
    const snapshot = await buildUiSnapshot({ repoRoot: consumerRoot });
    const workspace = snapshot.workspaces.find((item) => item.name === 'platform');
    assert.ok(workspace);
    assert.equal(workspace.repoCount, 2);
    assert.ok(workspace.contracts.some((contract) => contract.path === 'contracts/asyncapi.yaml'));
    const topologyLink = workspace.links.find((link) => link.routeLabel === 'SEND orders.submitted');
    assert.equal(topologyLink?.eventTopology?.providerAction, 'SEND');
    assert.equal(topologyLink?.eventTopology?.counterpartyRole, 'consumer');
    assert.equal(topologyLink?.eventTopology?.pattern, 'subscriber-call');
    assert.equal(topologyLink?.consumerPath, 'src/orders-consumer.ts');

    const html = renderUiHtml(snapshot);
    assert.match(html, /Workspace Contracts/);
    assert.match(html, /orders\.submitted/);
    assert.match(html, /subscriber-call/);
    assert.match(html, /parallax:\/\/workspaces\/platform\/cross-repo-links/);

    ui = await startUiServer({ repoRoot: consumerRoot, port: 0 });
    const workspaceJson = await (await fetch(new URL('/api/workspaces/platform', ui.url))).json() as {
      name: string;
      contracts: Array<{ path: string }>;
      links: Array<{ routeLabel?: string; eventTopology?: { pattern: string } }>;
    };
    assert.equal(workspaceJson.name, 'platform');
    assert.ok(workspaceJson.contracts.some((contract) => contract.path === 'contracts/asyncapi.yaml'));
    assert.ok(workspaceJson.links.some((link) =>
      link.routeLabel === 'SEND orders.submitted' && link.eventTopology?.pattern === 'subscriber-call'
    ));
  } finally {
    await ui?.close();
    await rm(consumerRoot, { recursive: true, force: true });
    await rm(providerRoot, { recursive: true, force: true });
  }
});

test('UI workspace snapshot tolerates legacy link provenance and unindexed repos', async () => {
  const { consumerRoot, providerRoot } = await makeUiWorkspaceRepo();
  const unindexedRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ui-workspace-unindexed-'));
  try {
    addWorkspaceRepo({
      repoRoot: consumerRoot,
      workspaceName: 'platform',
      localPath: unindexedRoot,
      serviceName: 'unindexed'
    });
    const db = openDatabase(consumerRoot);
    try {
      db.prepare('UPDATE cross_repo_links SET provenance = ?').run('legacy-provenance');
    } finally {
      db.close();
    }

    const snapshot = await buildUiSnapshot({ repoRoot: consumerRoot });
    const workspace = snapshot.workspaces.find((item) => item.name === 'platform');
    assert.ok(workspace);
    assert.equal(workspace.repoCount, 3);
    assert.ok(workspace.warnings.some((warning) =>
      warning.includes('unindexed') && warning.includes('parallax database not found')
    ));
    assert.ok(workspace.links.length > 0);
    assert.ok(workspace.links.every((link) => link.eventTopology === undefined));
    assert.ok(workspace.links.every((link) => link.routeLabel === undefined));

    const html = renderUiHtml(snapshot);
    assert.match(html, /confidence-heuristic/);
    assert.doesNotMatch(html, /legacy-provenance/);
  } finally {
    await rm(consumerRoot, { recursive: true, force: true });
    await rm(providerRoot, { recursive: true, force: true });
    await rm(unindexedRoot, { recursive: true, force: true });
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
      workspaces: unknown[];
      workArtifacts: unknown[];
    };
    assert.equal(bootstrap.selectedReportId, reportId);
    assert.ok(bootstrap.selectedReport.affectedFiles.length > 0);
    assert.ok(bootstrap.graph.nodes.length > 0);
    assert.ok(bootstrap.coverage.coverage.length > 0);
    assert.ok(Array.isArray(bootstrap.workspaces));
    assert.ok(Array.isArray(bootstrap.workArtifacts));

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

    const sourceResponse = await fetch(new URL('/source?path=src/a.ts&line=1', ui.url));
    assert.equal(sourceResponse.status, 200);
    const sourceHtml = await sourceResponse.text();
    assert.match(sourceHtml, /src\/a\.ts/);
    assert.match(sourceHtml, /source-line-active/);
    assert.match(sourceHtml, /export const a/);

    const outsideSource = await fetch(new URL('/source?path=../package.json&line=1', ui.url));
    assert.equal(outsideSource.status, 400);

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
      const match = /Parallax UI: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
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
      if (!/Parallax UI: /.test(output)) {
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
