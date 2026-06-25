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
import type { ImpactReport } from '../src/types.js';

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
    assert.match(html, /aria-label="Impact triage"/);
    assert.match(html, /Impact Triage/);
    assert.match(html, /Changed root[\s\S]*src\/b\.ts[\s\S]*Affected targets[\s\S]*3 targets[\s\S]*Next verification[\s\S]*tests\/b\.test\.ts/);
    assert.match(html, /triage-step triage-step-affected selectable-impact" tabindex="0" role="button" data-impact-path="src\/a\.ts"/);
    assert.match(html, /triage-step triage-step-action selectable-impact" tabindex="0" role="button" data-impact-path="tests\/b\.test\.ts"/);
    assert.match(html, /src\/b\.ts · 3 total targets · 5 mapped paths/);
    assert.match(html, /Analysis Trust/);
    assert.match(html, /aria-label="Analysis trust signals"[\s\S]*Coverage[\s\S]*<strong>4\/4<\/strong>[\s\S]*No skipped paths/);
    assert.match(html, /aria-label="Analysis trust signals"[\s\S]*Adapters[\s\S]*<strong>2<\/strong>[\s\S]*2 heuristic\/unknown/);
    assert.match(html, /aria-label="Analysis trust signals"[\s\S]*trust-state-amber">Use with gaps/);
    assert.match(html, /aria-label="Analysis trust signals"[\s\S]*Known gaps[\s\S]*<strong>4<\/strong>[\s\S]*Open limitations/);
    assert.match(html, /\.trust-signals \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
    assert.match(html, /aria-label="Affected targets by product lane"/);
    assert.match(html, /\.lang-link \{[\s\S]*min-height: 34px;[\s\S]*text-decoration: none;/);
    assert.match(html, new RegExp(`href="/\\?report=${reportId}&amp;lang=ko"`));
    assert.match(html, /\.toolbar \{ min-width: 0; display: flex;/);
    assert.match(html, /\.copy-command \{[\s\S]*min-width: 44px;[\s\S]*min-height: 32px;/);
    assert.match(html, /@media \(max-width: 560px\)[\s\S]*\.toolbar \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\);/);
    assert.match(html, /@media \(max-width: 560px\)[\s\S]*\.toolbar \{[\s\S]*width: 100%;[\s\S]*max-width: 100%;/);
    assert.match(html, /@media \(max-width: 560px\)[\s\S]*\.lang-switcher \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
    assert.match(html, /@media \(max-width: 560px\)[\s\S]*\.toolbar input, \.toolbar select \{[\s\S]*min-height: 44px;/);
    assert.match(html, /@media \(max-width: 980px\)[\s\S]*\.map-content \{\s*grid-template-columns: minmax\(0, 1fr\);\s*height: auto;\s*\}/);
    assert.match(html, /@media \(max-width: 560px\)[\s\S]*\.metrics \{\s*grid-template-columns: none;\s*grid-auto-flow: column;\s*grid-auto-columns: minmax\(96px, 1fr\);/);
    assert.match(html, /@media \(max-width: 560px\)[\s\S]*scrollbar-width: none;/);
    assert.match(html, /@media \(max-width: 560px\)[\s\S]*\.triage-flow \{\s*grid-template-columns: 1fr;/);
    assert.match(html, /@media \(max-width: 560px\)[\s\S]*\.triage-step \{[\s\S]*grid-template-columns: minmax\(78px, 0\.34fr\) minmax\(0, 1fr\);/);
    assert.match(html, /@media \(max-width: 560px\)[\s\S]*\.triage-step:not\(:last-child\)::after \{[\s\S]*content: "↓";/);
    assert.match(html, /@media \(max-width: 560px\)[\s\S]*\.map-next-action \.copy-command, \.delta-preset \.copy-command \{[\s\S]*min-height: 44px;/);
    assert.match(html, /@media \(max-width: 560px\)[\s\S]*\.impact-svg \{ min-width: 640px; height: auto; \}/);
    assert.match(html, /impact-lane-green[\s\S]*Runtime code[\s\S]*<b>1<\/b>[\s\S]*src\/a\.ts/);
    assert.match(html, /impact-lane-amber[\s\S]*Tests to verify[\s\S]*<b>1<\/b>[\s\S]*tests\/b\.test\.ts/);
    assert.match(html, /impact-lane-teal[\s\S]*Docs &amp; policy[\s\S]*<b>1<\/b>[\s\S]*README\.md/);
    assert.match(html, /summary-section-top-impact[\s\S]*Top Impact[\s\S]*<b>1<\/b>[\s\S]*tests\/b\.test\.ts[\s\S]*summary-section-changed[\s\S]*Changed[\s\S]*src\/b\.ts/);
    assert.match(html, /\.summary-columns \{[\s\S]*grid-auto-rows: max-content;[\s\S]*align-content: start;/);
    assert.match(html, /Impact Map/);
    assert.match(html, /Impact Map[\s\S]*1 Changed[\s\S]*3 total affected[\s\S]*5 mapped paths/);
    assert.match(html, /\.impact-overview \{[\s\S]*align-items: start;/);
    assert.match(html, /\.map-content \{[\s\S]*grid-template-columns: minmax\(0, 1fr\);[\s\S]*min-height: 0;/);
    assert.match(html, /\.map-frame \{[\s\S]*grid-template-rows: auto auto auto;/);
    assert.match(html, /\.map-svg-scroll \{[\s\S]*overflow-x: auto;[\s\S]*overscroll-behavior-x: contain;/);
    assert.match(html, /\.map-legend \{[\s\S]*grid-template-columns: minmax\(270px, 1\.15fr\) minmax\(170px, 0\.55fr\) minmax\(210px, 0\.8fr\);/);
    assert.match(html, /\.inspector-evidence \{[\s\S]*max-height: 246px;[\s\S]*overflow: auto;/);
    assert.match(html, /Primary impact flow/);
    assert.match(html, /Primary impact flow[\s\S]*id="mapFlowPath">src\/b\.ts <em>&rarr;<\/em> tests\/b\.test\.ts/);
    assert.match(html, /Primary impact flow[\s\S]*VERIFY · 3 total targets · 5 mapped paths · proven confidence/);
    assert.match(html, /class="impact-route-strip" aria-label="Ranked impact route summary"[\s\S]*tests\/b\.test\.ts[\s\S]*Tests to verify[\s\S]*proven/);
    assert.match(html, /\.impact-route-strip \{[\s\S]*display: grid;[\s\S]*grid-template-columns: repeat\(auto-fit, minmax\(188px, 1fr\)\);/);
    assert.match(html, /@media \(max-width: 560px\)[\s\S]*\.impact-route-strip \{\s*grid-template-columns: 1fr;/);
    assert.match(html, /id="mapNextAction" class="map-next-action" aria-label="Next verification command"[\s\S]*<code>npm test -- tests\/b\.test\.ts<\/code>/);
    assert.match(html, /id="mapImpactVerdict" class="map-impact-verdict impact-verdict-green" aria-label="Selected impact verdict"/);
    assert.match(html, /id="mapImpactVerdictLabel">Ready to verify/);
    assert.match(html, /aria-label="Copy map verification command"/);
    assert.match(html, /function renderMapAction/);
    assert.match(html, /setText\('mapFlowMeta'[\s\S]*uiMessage\('totalTargets'[\s\S]*uiMessage\('mappedPaths'/);
    assert.match(html, /map-stage-changed/);
    assert.match(html, /map-node-lane-green[\s\S]*Runtime code[\s\S]*confidence-text-proven[\s\S]*proven/);
    assert.match(html, /map-node-lane-amber[\s\S]*Tests to verify[\s\S]*confidence-text-proven[\s\S]*proven/);
    assert.match(html, /map-node-lane-teal[\s\S]*Docs &amp; policy[\s\S]*confidence-text-heuristic[\s\S]*heuristic/);
    assert.match(html, /class="map-edge-group selectable-impact selected-impact"[\s\S]*data-impact-path="tests\/b\.test\.ts"[\s\S]*class="map-edge confidence-proven"/);
    assert.match(html, /marker-end="url\(#impactArrow\)"/);
    assert.match(html, /5 mapped paths/);
    assert.match(html, /class="impact-svg" width="760" height="\d+" viewBox="0 0 760 /);
    assert.match(html, /class="impact-svg"/);
    assert.match(html, /class="map-legend-edge selectable-impact selected-impact" tabindex="0" role="button" data-impact-path="tests\/b\.test\.ts"/);
    assert.match(html, /Impact Inspector/);
    assert.ok(html.indexOf('Impact Inspector') < html.indexOf('aria-label="Impact map symbols"'));
    assert.match(html, /id="inspectorVerdict" class="impact-verdict impact-verdict-green" aria-label="Selected impact verdict"/);
    assert.match(html, /Impact verdict[\s\S]*id="inspectorVerdictLabel">Ready to verify/);
    assert.match(html, /id="inspectorVerdictMeta">Tests to verify · proven · 2 Evidence hits · command ready/);
    assert.match(html, /function updateImpactVerdict/);
    assert.match(html, /mapImpactVerdictMeta/);
    assert.match(html, /laneLabelForImpact/);
    assert.match(html, /class="map-legend-key" aria-label="Impact map symbols"/);
    assert.match(html, /class="map-route-list" aria-label="Visible impact routes"/);
    assert.ok(html.indexOf('Impact Map') < html.indexOf('Impact Summary'));
    assert.match(html, /Next verification/);
    assert.match(html, /id="inspectorAction"[\s\S]*<code>npm test -- tests\/b\.test\.ts<\/code>/);
    assert.match(html, /id="inspectorEvidence">2<\/dd>/);
    assert.match(html, /id="inspectorSource"[\s\S]*Open source L1/);
    assert.match(html, /Top evidence/);
    assert.match(html, /id="inspectorEvidenceList"[\s\S]*tests\/b\.test\.ts/);
    assert.match(html, /function renderInspectorAction/);
    assert.match(html, /function renderInspectorEvidence/);
    assert.match(html, /function initialImpactPath/);
    assert.match(html, /data-impact-path="src\/a\.ts"/);
    assert.match(html, /class="impact-row impact-path-row selectable-impact"/);
    assert.match(html, /class="relation-trail"/);
    assert.match(html, /1 evidence/);
    assert.match(html, new RegExp(`/source\\?path=src%2Fa\\.ts&amp;line=1&amp;report=${reportId}&amp;lang=en`));
    assert.match(html, /Copy verify/);
    assert.match(html, /selectedImpactPath/);
    assert.match(html, /nextUrl\.searchParams\.set\('report', value\)/);
    assert.match(html, /window\.location\.href = nextUrl\.pathname \+ '\?' \+ nextUrl\.searchParams\.toString\(\)/);
    assert.match(html, /Verification Queue/);
    assert.match(html, /Verify tests\/b\.test\.ts/);
    assert.match(html, /class="copy-command"/);
    assert.match(html, /data-command="npm test -- tests\/b\.test\.ts"/);
    assert.match(html, /navigator\.clipboard\.writeText/);
    assert.match(html, new RegExp(`/source\\?path=tests%2Fb\\.test\\.ts&amp;line=1&amp;report=${reportId}&amp;lang=en`));
    assert.match(html, /Open source L\d+/);
    assert.match(html, new RegExp(`/source\\?path=src%2Fa\\.ts&amp;line=\\d+&amp;report=${reportId}&amp;lang=en`));
    assert.match(html, /Coverage Gaps/);
    assert.match(html, /Workspace Contracts/);
    assert.match(html, /overflow-wrap: anywhere/);
    assert.doesNotMatch(html, /landing/i);

    const koHtml = renderUiHtml(snapshot, 'ko');
    assert.match(koHtml, /<html lang="ko">/);
    assert.match(koHtml, /<script id="ui-messages" type="application\/json">/);
    assert.match(koHtml, /"copyCopied":"복사됨"/);
    assert.match(koHtml, /영향 판정[\s\S]*검증 준비됨[\s\S]*검증할 테스트 · proven · 2 증거 적중 · 명령 준비됨/);
    assert.match(koHtml, /영향 맵[\s\S]*1 변경됨[\s\S]*3 전체 영향[\s\S]*5 표시 경로/);
    assert.match(koHtml, /주요 영향 흐름[\s\S]*VERIFY · 3 전체 대상 · 5 표시 경로 · proven 신뢰도/);
    assert.match(koHtml, /uiMessage\('noVerificationActionRecorded'/);
    assert.match(koHtml, /uiMessage\('ariaOpenSourceLabel'/);

    const zhHtml = renderUiHtml(snapshot, 'zh');
    assert.match(zhHtml, /<html lang="zh">/);
    assert.match(zhHtml, /"copyFailed":"复制失败"/);
    assert.match(zhHtml, /影响图[\s\S]*3 总受影响[\s\S]*5 已绘制路径/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('UI snapshot and HTML render cross-repo consumer impacts', async () => {
  const { repoRoot, reportId } = await makeUiRepo();
  try {
    const crossRepoReportId = seedCrossRepoConsumerReport(repoRoot, reportId);

    const snapshot = await buildUiSnapshot({ repoRoot, reportId: crossRepoReportId });
    assert.equal(snapshot.selectedReportId, crossRepoReportId);
    assert.equal(snapshot.selectedReport?.crossRepoImpacts.length, 1);

    const html = renderUiHtml(snapshot);
    assert.match(html, /Cross-repo consumers/);
    assert.match(html, /web:src\/client\.ts/);
    assert.match(html, /parallax:\/\/workspaces\/platform\/cross-repo-links/);
    assert.doesNotMatch(html, /\/source\?path=web%3Asrc%2Fclient\.ts/);

    const koHtml = renderUiHtml(snapshot, 'ko');
    assert.match(koHtml, /교차 저장소 소비자/);

    const zhHtml = renderUiHtml(snapshot, 'zh');
    assert.match(zhHtml, /跨仓库消费者/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('UI snapshot and HTML compare the selected report to the previous saved report', async () => {
  const { repoRoot, reportId } = await makeUiRepo();
  try {
    const baselineId = seedPreviousReportBaseline(repoRoot, reportId);

    const snapshot = await buildUiSnapshot({ repoRoot });
    assert.equal(snapshot.selectedReportId, reportId);
    assert.equal(snapshot.comparison?.baseReportId, baselineId);
    assert.equal(snapshot.comparison?.summary, 'wider');
    assert.equal(snapshot.comparison?.affectedDelta, 2);
    assert.equal(snapshot.comparison?.actionDelta, 1);
    assert.equal(snapshot.comparison?.policy.source, 'default');
    assert.equal(snapshot.comparison?.reviewLoadDelta, 16);
    assert.ok(snapshot.comparison?.policyPresets.some((item) =>
      item.id === 'active' && item.summary === 'wider' && item.reviewLoadDelta === 16
    ));
    assert.ok(snapshot.comparison?.policyPresets.some((item) =>
      item.id === 'relaxed' && item.summary === 'unchanged'
    ));
    assert.ok(snapshot.comparison?.addedAffectedPaths.includes('README.md'));
    assert.ok(snapshot.comparison?.addedAffectedPaths.includes('tests/b.test.ts'));
    assert.ok(snapshot.comparison?.laneDeltas.some((item) =>
      item.label === 'Tests to verify' && item.current === 1 && item.previous === 0 && item.delta === 1
    ));

    const html = renderUiHtml(snapshot);
    assert.match(html, /Report Delta/);
    assert.ok(html.indexOf('aria-label="Impact overview"') < html.indexOf('class="panel report-delta-panel"'));
    assert.match(html, /Impact widened/);
    assert.match(html, /Saved report comparison/);
    assert.match(html, /policy default/);
    assert.match(html, /widen \+1/);
    assert.match(html, /Review load changed by \+16/);
    assert.match(html, /Report delta policy preset comparison/);
    assert.match(html, /Strict[\s\S]*wider/);
    assert.match(html, /Relaxed[\s\S]*unchanged/);
    assert.match(html, /Action-heavy[\s\S]*wider/);
    assert.match(html, /aria-label="Copy Strict"/);
    assert.match(html, /&quot;reportDeltaPolicy&quot;[\s\S]*&quot;actions&quot;: 7/);
    assert.match(html, /Copy config/);
    assert.match(html, /Affected paths[\s\S]*\+2/);
    assert.match(html, /Tests to verify[\s\S]*\+1[\s\S]*tests\/b\.test\.ts/);
    assert.match(html, /Added impact[\s\S]*README\.md/);
    assert.match(html, /class="delta-path-row selectable-impact"[\s\S]*data-impact-path="README\.md"/);
    assert.match(html, /Inspect impact/);
    assert.match(html, new RegExp(`/source\\?path=README\\.md&amp;line=1&amp;report=${reportId}&amp;lang=en`));
    assert.match(html, /document\.querySelectorAll\('\.selectable-impact a, \.selectable-impact button'\)/);
    assert.match(html, /bootstrap\.comparison/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('UI report delta honors configured team policy thresholds', async () => {
  const { repoRoot, reportId } = await makeUiRepo();
  try {
    seedPreviousReportBaseline(repoRoot, reportId);
    await writeReportDeltaPolicy(repoRoot, {
      widenThreshold: 20,
      narrowThreshold: 8,
      weights: { affected: 3, actions: 5, evidence: 1 }
    });

    const snapshot = await buildUiSnapshot({ repoRoot });
    assert.equal(snapshot.comparison?.summary, 'unchanged');
    assert.equal(snapshot.comparison?.policy.source, 'config');
    assert.equal(snapshot.comparison?.policy.widenThreshold, 20);
    assert.equal(snapshot.comparison?.policy.narrowThreshold, 8);
    assert.equal(snapshot.comparison?.reviewLoadDelta, 16);
    assert.ok(snapshot.comparison?.policyPresets.some((item) =>
      item.id === 'active' && item.summary === 'unchanged' && item.widenThreshold === 20
    ));
    assert.ok(snapshot.comparison?.policyPresets.some((item) =>
      item.id === 'strict' && item.summary === 'wider'
    ));

    const html = renderUiHtml(snapshot);
    assert.match(html, /Impact unchanged/);
    assert.match(html, /policy config/);
    assert.match(html, /widen \+20/);
    assert.match(html, /narrow -8/);
    assert.match(html, /inside \+20\/-8/);
    assert.match(html, /Affected weight 3/);
    assert.match(html, /Action weight 5/);
    assert.match(html, /Evidence weight 1/);
    assert.match(html, /aria-label="Copy Active"/);
    assert.match(html, /&quot;widenThreshold&quot;: 20/);
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

    const faviconResponse = await fetch(new URL('/favicon.ico', ui.url));
    assert.equal(faviconResponse.status, 204);

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

    const sourceResponse = await fetch(new URL(`/source?path=src/a.ts&line=1&report=${encodeURIComponent(reportId)}&lang=ko`, ui.url));
    assert.equal(sourceResponse.status, 200);
    const sourceHtml = await sourceResponse.text();
    assert.match(sourceHtml, /<html lang="ko">/);
    assert.match(sourceHtml, new RegExp(`href="/\\?report=${reportId}&amp;lang=ko"`));
    assert.match(sourceHtml, /Impact Workbench로 돌아가기/);
    assert.match(sourceHtml, /줄 1 · /);
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

test('UI graph JSON API rejects invalid pagination query params with structured JSON', async () => {
  const { repoRoot, reportId } = await makeUiRepo();
  const ui = await startUiServer({ repoRoot, port: 0 });
  try {
    const cases = [
      { query: 'limit=abc', messagePattern: /limit/ },
      { query: 'cursor=bad', messagePattern: /cursor/ },
      { query: 'cursor=9007199254740992%3A0', messagePattern: /safe non-negative integer/ },
      { query: 'cursor=999999%3A0', messagePattern: /outside/ }
    ];

    for (const item of cases) {
      const response = await fetch(
        new URL(`/api/reports/${encodeURIComponent(reportId)}/graph/json?${item.query}`, ui.url)
      );
      assert.equal(response.status, 400);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
      const body = await response.json() as {
        error?: {
          code?: string;
          message?: string;
        };
      };
      assert.ok(body.error);
      assert.equal(body.error.code, 'invalid_request');
      const message = body.error.message;
      assert.ok(typeof message === 'string');
      assert.match(message, item.messagePattern);
    }
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

function seedPreviousReportBaseline(repoRoot: string, currentReportId: string): string {
  const normalizedRepoRoot = normalizeRepoRoot(repoRoot);
  const db = openDatabase(normalizedRepoRoot);
  try {
    const repoId = getRepoId(db, normalizedRepoRoot);
    const currentRow = db
      .prepare('SELECT index_run_id, json FROM reports WHERE repo_id = ? AND id = ?')
      .get(repoId, currentReportId) as { index_run_id: number; json: string } | undefined;
    assert.ok(currentRow);
    const current = JSON.parse(currentRow.json) as ImpactReport;
    const baselineId = `${currentReportId}-baseline`;
    const baseline: ImpactReport = {
      ...current,
      id: baselineId,
      affectedFiles: current.affectedFiles.filter((item) => item.path === 'src/a.ts'),
      affected: current.affected.filter((item) => item.target.path === 'src/a.ts'),
      actions: [],
      testCommands: [],
      evidence: current.evidence.filter((item) =>
        item.file === 'src/a.ts' || item.subject?.path === 'src/a.ts'
      ),
      warnings: []
    };
    db.prepare('INSERT OR REPLACE INTO reports (id, repo_id, index_run_id, json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(baselineId, repoId, currentRow.index_run_id, JSON.stringify(baseline), '1999-01-01 00:00:00');
    return baselineId;
  } finally {
    db.close();
  }
}

function seedCrossRepoConsumerReport(repoRoot: string, currentReportId: string): string {
  const normalizedRepoRoot = normalizeRepoRoot(repoRoot);
  const db = openDatabase(normalizedRepoRoot);
  try {
    const repoId = getRepoId(db, normalizedRepoRoot);
    const currentRow = db
      .prepare('SELECT index_run_id, json FROM reports WHERE repo_id = ? AND id = ?')
      .get(repoId, currentReportId) as { index_run_id: number; json: string } | undefined;
    assert.ok(currentRow);
    const current = JSON.parse(currentRow.json) as ImpactReport;
    const crossRepoReportId = `${currentReportId}-cross-repo`;
    const consumerPath = 'web:src/client.ts';
    const providerPath = 'users-api:contracts/openapi.yaml';
    const relation = `${consumerPath} BREAKS_COMPATIBILITY_WITH ${providerPath}`;
    const crossRepoReport: ImpactReport = {
      ...current,
      id: crossRepoReportId,
      changedFiles: ['contracts/openapi.yaml'],
      changed: [{
        id: 'contract:openapi:users-api:contracts/openapi.yaml',
        kind: 'contract',
        path: 'contracts/openapi.yaml',
        displayName: providerPath
      }],
      affectedFiles: [{
        path: consumerPath,
        reason: 'breaks cross-repo consumer web via contracts/openapi.yaml',
        confidence: 'heuristic',
        depth: 1,
        relationPath: [relation]
      }],
      affected: [{
        target: {
          id: `cross-repo:platform:${consumerPath}`,
          kind: 'external_entity',
          path: consumerPath,
          displayName: consumerPath
        },
        relations: [relation],
        confidence: 'heuristic'
      }],
      actions: [],
      testCommands: [],
      evidence: [{
        id: `cross-repo-evidence:${consumerPath}`,
        file: consumerPath,
        kind: 'BREAKS_COMPATIBILITY_WITH',
        snippet: 'return fetch("https://users.example.test/api/users");',
        confidence: 'heuristic',
        startLine: 1,
        subject: {
          id: `cross-repo:platform:${consumerPath}`,
          kind: 'external_entity',
          path: consumerPath,
          displayName: consumerPath
        },
        target: {
          id: 'contract:openapi:users-api:contracts/openapi.yaml',
          kind: 'contract',
          path: 'contracts/openapi.yaml',
          displayName: providerPath
        },
        relationKind: 'BREAKS_COMPATIBILITY_WITH',
        relationConfidence: 'heuristic',
        extractorId: 'cross-repo-contract-impact'
      }],
      crossRepoImpacts: [{
        workspace: 'platform',
        provider: {
          serviceName: 'users-api',
          contractPath: 'contracts/openapi.yaml'
        },
        consumer: {
          serviceName: 'web',
          path: 'src/client.ts'
        },
        change: {
          kind: 'removed_endpoint',
          method: 'GET',
          path: '/api/users',
          previousEndpointId: 'endpoint:yaml:GET /api/users'
        },
        confidence: 'heuristic',
        evidence: {
          filePath: consumerPath,
          snippet: 'return fetch("https://users.example.test/api/users");'
        },
        resources: {
          workspace: 'parallax://workspaces/platform',
          crossRepoLinks: 'parallax://workspaces/platform/cross-repo-links'
        }
      }],
      warnings: []
    };
    db.prepare('INSERT OR REPLACE INTO reports (id, repo_id, index_run_id, json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(crossRepoReportId, repoId, currentRow.index_run_id, JSON.stringify(crossRepoReport), '1999-01-01 00:00:00');
    return crossRepoReportId;
  } finally {
    db.close();
  }
}

async function writeReportDeltaPolicy(
  repoRoot: string,
  policy: {
    widenThreshold: number;
    narrowThreshold: number;
    weights: { affected: number; actions: number; evidence: number };
  }
): Promise<void> {
  await writeFile(
    path.join(repoRoot, '.parallax/config.json'),
    `${JSON.stringify(
      {
        schemaVersion: 3,
        project: 'parallax',
        mcp: { readOnly: true },
        redaction: { enabled: true },
        ui: { reportDeltaPolicy: policy }
      },
      null,
      2
    )}\n`
  );
}

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
