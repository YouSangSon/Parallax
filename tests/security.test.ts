import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// @ts-expect-error The audit gate is intentionally runnable by plain Node.js.
import { gateDependencyAudit } from '../scripts/dependency-audit.js';
import { analyzeDiff, indexProject, initProject, redactSecrets, resolveInsideRoot } from '../src/index.js';

const knownAuditReport = {
  auditReportVersion: 2,
  vulnerabilities: {
    '@huggingface/transformers': {
      name: '@huggingface/transformers', severity: 'high', isDirect: true,
      via: ['onnxruntime-node', 'sharp'], effects: [], range: '*',
      nodes: ['node_modules/@huggingface/transformers'], fixAvailable: false
    },
    'adm-zip': {
      name: 'adm-zip', severity: 'high', isDirect: false,
      via: [{
        source: 1123686, name: 'adm-zip', dependency: 'adm-zip',
        title: 'adm-zip: Crafted ZIP file triggers 4GB memory allocation',
        url: 'https://github.com/advisories/GHSA-xcpc-8h2w-3j85', severity: 'high',
        cwe: ['CWE-400', 'CWE-789'],
        cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' },
        range: '<0.6.0'
      }],
      effects: ['onnxruntime-node'], range: '<0.6.0', nodes: ['node_modules/adm-zip'], fixAvailable: false
    },
    'onnxruntime-node': {
      name: 'onnxruntime-node', severity: 'high', isDirect: false,
      via: ['adm-zip'], effects: ['@huggingface/transformers'],
      range: '1.22.0-dev.20250415-c18e06d5e3 - 1.29.0-dev.20260811-e415ef9afd',
      nodes: ['node_modules/onnxruntime-node'], fixAvailable: false
    },
    sharp: {
      name: 'sharp', severity: 'high', isDirect: false,
      via: [{
        source: 1124066, name: 'sharp', dependency: 'sharp',
        title: 'sharp inherited vulnerabilities in libvips: CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591',
        url: 'https://github.com/advisories/GHSA-f88m-g3jw-g9cj', severity: 'high',
        cwe: ['CWE-1395'], cvss: { score: 0, vectorString: null }, range: '<0.35.0'
      }],
      effects: ['@huggingface/transformers'], range: '<0.35.0', nodes: ['node_modules/sharp'], fixAvailable: false
    }
  },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 4, critical: 0, total: 4 },
    dependencies: { prod: 142, dev: 29, optional: 58, peer: 0, peerOptional: 0, total: 201 }
  }
};

const knownLockfile = {
  packages: {
    '': { dependencies: { '@huggingface/transformers': '^4.2.0' } },
    'node_modules/@huggingface/transformers': {
      version: '4.2.0', dependencies: { 'onnxruntime-node': '1.24.3', sharp: '^0.34.5' }
    },
    'node_modules/onnxruntime-node': { version: '1.24.3', dependencies: { 'adm-zip': '^0.5.16' } },
    'node_modules/adm-zip': { version: '0.5.18' },
    'node_modules/sharp': { version: '0.34.5' }
  }
};

function auditResult(report: unknown = knownAuditReport, status = 1) {
  return { status, signal: null, stdout: JSON.stringify(report), stderr: '' };
}

test('dependency audit gate accepts only the pinned exception before expiry', () => {
  assert.deepEqual(gateDependencyAudit({
    auditResult: auditResult(),
    lockfileText: JSON.stringify(knownLockfile),
    now: new Date('2026-09-30T23:59:59.999Z')
  }), { acceptedException: true });

  const unrelatedMetadataChange = structuredClone(knownAuditReport);
  unrelatedMetadataChange.metadata.dependencies.total = 999;
  assert.deepEqual(gateDependencyAudit({
    auditResult: auditResult(unrelatedMetadataChange),
    lockfileText: JSON.stringify(knownLockfile),
    now: new Date('2026-09-30T23:59:59.999Z')
  }), { acceptedException: true });

  const clean = structuredClone(knownAuditReport);
  clean.vulnerabilities = {} as typeof clean.vulnerabilities;
  clean.metadata.vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  assert.deepEqual(gateDependencyAudit({
    auditResult: auditResult(clean, 0),
    lockfileText: '{}',
    now: new Date('2027-01-01T00:00:00.000Z')
  }), { acceptedException: false });

  const moderateVulnerability = {
    name: 'example', severity: 'moderate', isDirect: false, via: [], effects: [],
    range: '*', nodes: ['node_modules/example'], fixAvailable: false
  };
  const moderateOnly = {
    ...structuredClone(clean),
    vulnerabilities: { example: moderateVulnerability },
    metadata: {
      ...structuredClone(clean.metadata),
      vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 }
    }
  };
  assert.deepEqual(gateDependencyAudit({
    auditResult: auditResult(moderateOnly, 0),
    lockfileText: '{}',
    now: new Date('2027-01-01T00:00:00.000Z')
  }), { acceptedException: false });

  const pinnedWithModerate = {
    ...structuredClone(knownAuditReport),
    vulnerabilities: {
      ...structuredClone(knownAuditReport.vulnerabilities),
      example: moderateVulnerability
    },
    metadata: {
      ...structuredClone(knownAuditReport.metadata),
      vulnerabilities: { info: 0, low: 0, moderate: 1, high: 4, critical: 0, total: 5 }
    }
  };
  assert.deepEqual(gateDependencyAudit({
    auditResult: auditResult(pinnedWithModerate),
    lockfileText: JSON.stringify(knownLockfile),
    now: new Date('2026-09-30T23:59:59.999Z')
  }), { acceptedException: true });
});

test('dependency audit gate fails closed when the report, exception, or lock drifts', () => {
  const cases: Array<[string, (report: typeof knownAuditReport, lock: typeof knownLockfile) => void]> = [
    ['advisory', (report) => { report.vulnerabilities['adm-zip'].via[0]!.source = 1; }],
    ['path', (report) => { report.vulnerabilities.sharp.nodes = ['node_modules/other/sharp']; }],
    ['severity', (report) => { report.vulnerabilities.sharp.severity = 'critical'; }],
    ['node set', (report) => { report.vulnerabilities.sharp.nodes.push('node_modules/other/sharp'); }],
    ['onnxruntime-node range', (report) => { report.vulnerabilities['onnxruntime-node'].range = '<1.25.0'; }],
    ['version', (_report, lock) => { lock.packages['node_modules/sharp'].version = '0.34.6'; }],
    ['dependency edge', (_report, lock) => { lock.packages['node_modules/onnxruntime-node'].dependencies['adm-zip'] = '^0.6.0'; }]
  ];

  for (const [label, mutate] of cases) {
    const report = structuredClone(knownAuditReport);
    const lock = structuredClone(knownLockfile);
    mutate(report, lock);
    assert.throws(() => gateDependencyAudit({
      auditResult: auditResult(report),
      lockfileText: JSON.stringify(lock),
      now: new Date('2026-09-30T23:59:59.999Z')
    }), label);
  }

  assert.throws(() => gateDependencyAudit({
    auditResult: auditResult(),
    lockfileText: JSON.stringify(knownLockfile),
    now: new Date('2026-10-01T00:00:00.000Z')
  }), /expired/);
});

test('dependency audit gate fails closed on command and JSON failures', () => {
  const input = { lockfileText: JSON.stringify(knownLockfile), now: new Date('2026-09-01T00:00:00.000Z') };

  const secret = 'https://user:ghp_supersecret@registry.example.test/';
  assert.throws(() => gateDependencyAudit({
    ...input,
    auditResult: { ...auditResult(), error: new Error(`spawn failed: ${secret}`) }
  }), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /npm audit could not start/);
    assert.doesNotMatch(error.message, /ghp_supersecret/);
    return true;
  });
  assert.throws(() => gateDependencyAudit({ ...input, auditResult: auditResult(knownAuditReport, 2) }), /exit status 2/);
  assert.throws(() => gateDependencyAudit({
    ...input,
    auditResult: { ...auditResult(), status: null, signal: 'SIGTERM' }
  }), /signal SIGTERM/);
  assert.throws(() => gateDependencyAudit({
    ...input,
    auditResult: auditResult({ error: { code: 'ENETWORK', summary: `registry unavailable: ${secret}` } })
  }), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /audit error code ENETWORK/);
    assert.doesNotMatch(error.message, /ghp_supersecret|registry\.example/);
    return true;
  });
  assert.throws(() => gateDependencyAudit({ ...input, auditResult: { ...auditResult(), stdout: '{' } }), /valid JSON/);
  assert.throws(() => gateDependencyAudit({ ...input, auditResult: { ...auditResult(), stdout: '' } }), /no JSON/);

  const malformedReports = [
    { ...knownAuditReport, vulnerabilities: [] },
    { ...knownAuditReport, vulnerabilities: { example: null } },
    { ...knownAuditReport, vulnerabilities: { example: 'bad' } },
    { ...knownAuditReport, vulnerabilities: { example: { name: 'example' } } },
    {
      ...knownAuditReport,
      vulnerabilities: {},
      metadata: { ...knownAuditReport.metadata, vulnerabilities: { ...knownAuditReport.metadata.vulnerabilities, total: 0 } }
    },
    {
      ...knownAuditReport,
      vulnerabilities: { example: { name: 'example', severity: 'moderate' } },
      metadata: { ...knownAuditReport.metadata, vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } }
    },
    {
      ...knownAuditReport,
      vulnerabilities: {},
      metadata: { ...knownAuditReport.metadata, vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 } }
    },
    {
      ...knownAuditReport,
      vulnerabilities: {},
      metadata: { ...knownAuditReport.metadata, vulnerabilities: { info: 0, low: 9007199254740992, moderate: 0, high: 0, critical: 0, total: 9007199254740992 } }
    }
  ];
  for (const report of malformedReports) {
    assert.throws(() => gateDependencyAudit({
      ...input,
      auditResult: auditResult(report as typeof knownAuditReport, 0)
    }), /malformed/);
  }
});

test('resolveInsideRoot rejects absolute path escapes', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-security-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/file.ts'), 'export const ok = true;\n');

  assert.equal(resolveInsideRoot(repoRoot, 'src/file.ts').endsWith('src/file.ts'), true);
  assert.throws(() => resolveInsideRoot(repoRoot, '../outside.ts'), /outside repo root/);
  assert.throws(() => resolveInsideRoot(repoRoot, '/etc/passwd'), /outside repo root/);
});

test('resolveInsideRoot rejects symlinks that escape the repo root', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-symlink-path-'));
  await mkdir(path.join(repoRoot, 'safe'), { recursive: true });
  await writeFile(path.join(repoRoot, 'safe/file.ts'), 'export const ok = true;\n');
  await symlink(path.join(repoRoot, 'safe/file.ts'), path.join(repoRoot, 'safe-link.ts'));
  await symlink('/etc/passwd', path.join(repoRoot, 'outside-link.ts'));

  assert.equal(resolveInsideRoot(repoRoot, 'safe-link.ts'), resolveInsideRoot(repoRoot, 'safe/file.ts'));
  assert.throws(() => resolveInsideRoot(repoRoot, 'outside-link.ts'), /outside repo root/);
});

test('analyzeDiff does not read post-index symlink evidence outside repo root', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-symlink-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/target.ts'), 'export const target = "safe";\n');
  await writeFile(path.join(repoRoot, 'src/importer.ts'), 'import { target } from "./target"; export const importer = target;\n');
  await initProject({ repoRoot });
  await indexProject({ repoRoot });

  await unlink(path.join(repoRoot, 'src/importer.ts'));
  await symlink('/etc/passwd', path.join(repoRoot, 'src/importer.ts'));

  const report = await analyzeDiff({ repoRoot, changedFiles: ['src/target.ts'] });

  const evidenceText = report.evidence.map((item) => item.snippet).join('\n');
  assert.doesNotMatch(evidenceText, /# User Database|root:[^\s]/);
  assert.ok(report.evidence.some((item) => item.extractorId === 'canonical-entity-graph'));
  assert.equal(report.evidence.some((item) => item.file === 'src/importer.ts'), true);
});

test('redactSecrets removes common token and private key shapes', () => {
  const openAiKey = ['sk-', 'live-', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
  const openAiProjectKey = ['sk-proj-', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('');
  const githubToken = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('');
  const githubServerToken = ['gh', 's_', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('');
  const githubUserToken = ['gh', 'u_', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('');
  const slackToken = ['xox', 'b-', '123456789012-123456789012-abcdefghijklmnopqrstuvwxyz'].join('');
  const awsAccessKey = ['AKIA', '1234567890ABCDEF'].join('');
  const awsSecretKey = ['abcdefghijklmnopqrstuvwxyz', '1234567890ABCD'].join('');
  const bearerToken = ['Bearer ', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('');
  const dbUrl = 'postgres://impact_user:impact_password@localhost:5432/impact';
  const input = [
    `OPENAI_API_KEY=${openAiKey}`,
    `OPENAI_PROJECT_KEY=${openAiProjectKey}`,
    `GITHUB_TOKEN=${githubToken}`,
    `GITHUB_SERVER_TOKEN=${githubServerToken}`,
    `GITHUB_USER_TOKEN=${githubUserToken}`,
    `SLACK_BOT_TOKEN=${slackToken}`,
    `AWS_ACCESS_KEY_ID=${awsAccessKey}`,
    `AWS_SECRET_ACCESS_KEY=${awsSecretKey}`,
    `Authorization: ${bearerToken}`,
    `DATABASE_URL=${dbUrl}`,
    '-----BEGIN PRIVATE KEY-----',
    'abc',
    '-----END PRIVATE KEY-----'
  ].join('\n');

  const redacted = redactSecrets(input);

  assert.doesNotMatch(redacted, /sk-live/);
  assert.doesNotMatch(redacted, /sk-proj/);
  assert.doesNotMatch(redacted, /ghp_/);
  assert.doesNotMatch(redacted, /ghs_/);
  assert.doesNotMatch(redacted, /ghu_/);
  assert.doesNotMatch(redacted, /xoxb-/);
  assert.equal(redacted.includes(awsAccessKey), false);
  assert.equal(redacted.includes(awsSecretKey), false);
  assert.equal(redacted.includes(bearerToken), false);
  assert.equal(redacted.includes(dbUrl), false);
  assert.doesNotMatch(redacted, /BEGIN PRIVATE KEY/);
  assert.match(redacted, /\[REDACTED/);
});

test('redactSecrets redacts before truncation', () => {
  const input = `${'a'.repeat(490)}-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----`;
  const redacted = redactSecrets(input);

  assert.doesNotMatch(redacted, /BEGIN PRIVATE KEY|secret/);
  assert.match(redacted, /\[REDACTED_PRIVATE_KEY\]/);
});

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(fullPath));
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

test('core src does not introduce an implicit HTTP daemon or websocket listener', async () => {
  const srcRoot = path.resolve('src');
  const explicitLocalServerModules = new Set([
    path.resolve('src/ui.ts')
  ]);
  const forbiddenPatterns: Array<[RegExp, string]> = [
    [/\bnode:http\b/, 'node:http'],
    [/\bnode:https\b/, 'node:https'],
    [/\bcreateServer\s*\(/, 'createServer('],
    [/\blisten\s*\(/, 'listen('],
    [/\bWebSocket\b/, 'WebSocket']
  ];

  for (const file of await listSourceFiles(srcRoot)) {
    const text = await readFile(file, 'utf8');
    if (explicitLocalServerModules.has(file)) {
      assert.match(text, /options\.host\s*\?\?\s*'127\.0\.0\.1'/, `${path.relative(process.cwd(), file)} must bind to loopback by default`);
      continue;
    }
    for (const [pattern, label] of forbiddenPatterns) {
      assert.doesNotMatch(text, pattern, `${path.relative(process.cwd(), file)} must not use ${label}`);
    }
  }
});
