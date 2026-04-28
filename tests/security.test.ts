import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { analyzeDiff, indexProject, initProject, redactSecrets, resolveInsideRoot } from '../src/index.js';

test('resolveInsideRoot rejects absolute path escapes', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-security-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/file.ts'), 'export const ok = true;\n');

  assert.equal(resolveInsideRoot(repoRoot, 'src/file.ts').endsWith('src/file.ts'), true);
  assert.throws(() => resolveInsideRoot(repoRoot, '../outside.ts'), /outside repo root/);
  assert.throws(() => resolveInsideRoot(repoRoot, '/etc/passwd'), /outside repo root/);
});

test('resolveInsideRoot rejects symlinks that escape the repo root', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-symlink-path-'));
  await mkdir(path.join(repoRoot, 'safe'), { recursive: true });
  await writeFile(path.join(repoRoot, 'safe/file.ts'), 'export const ok = true;\n');
  await symlink(path.join(repoRoot, 'safe/file.ts'), path.join(repoRoot, 'safe-link.ts'));
  await symlink('/etc/passwd', path.join(repoRoot, 'outside-link.ts'));

  assert.equal(resolveInsideRoot(repoRoot, 'safe-link.ts'), resolveInsideRoot(repoRoot, 'safe/file.ts'));
  assert.throws(() => resolveInsideRoot(repoRoot, 'outside-link.ts'), /outside repo root/);
});

test('analyzeDiff does not read post-index symlink evidence outside repo root', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-symlink-'));
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
  assert.ok(report.evidence.some((item) => item.kind === 'evidence-unavailable'));
});

test('redactSecrets removes common token and private key shapes', () => {
  const openAiKey = ['sk-', 'live-', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
  const githubToken = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('');
  const slackToken = ['xox', 'b-', '123456789012-123456789012-abcdefghijklmnopqrstuvwxyz'].join('');
  const awsAccessKey = ['AKIA', '1234567890ABCDEF'].join('');
  const awsSecretKey = ['abcdefghijklmnopqrstuvwxyz', '1234567890ABCD'].join('');
  const bearerToken = ['Bearer ', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('');
  const input = [
    `OPENAI_API_KEY=${openAiKey}`,
    `GITHUB_TOKEN=${githubToken}`,
    `SLACK_BOT_TOKEN=${slackToken}`,
    `AWS_ACCESS_KEY_ID=${awsAccessKey}`,
    `AWS_SECRET_ACCESS_KEY=${awsSecretKey}`,
    `Authorization: ${bearerToken}`,
    '-----BEGIN PRIVATE KEY-----',
    'abc',
    '-----END PRIVATE KEY-----'
  ].join('\n');

  const redacted = redactSecrets(input);

  assert.doesNotMatch(redacted, /sk-live/);
  assert.doesNotMatch(redacted, /ghp_/);
  assert.doesNotMatch(redacted, /xoxb-/);
  assert.equal(redacted.includes(awsAccessKey), false);
  assert.equal(redacted.includes(awsSecretKey), false);
  assert.equal(redacted.includes(bearerToken), false);
  assert.doesNotMatch(redacted, /BEGIN PRIVATE KEY/);
  assert.match(redacted, /\[REDACTED/);
});

test('redactSecrets redacts before truncation', () => {
  const input = `${'a'.repeat(490)}-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----`;
  const redacted = redactSecrets(input);

  assert.doesNotMatch(redacted, /BEGIN PRIVATE KEY|secret/);
  assert.match(redacted, /\[REDACTED_PRIVATE_KEY\]/);
});
