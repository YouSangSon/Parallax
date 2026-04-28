import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { redactSecrets, resolveInsideRoot } from '../src/index.js';

test('resolveInsideRoot rejects absolute path escapes', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-security-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/file.ts'), 'export const ok = true;\n');

  assert.equal(resolveInsideRoot(repoRoot, 'src/file.ts').endsWith('src/file.ts'), true);
  assert.throws(() => resolveInsideRoot(repoRoot, '../outside.ts'), /outside repo root/);
  assert.throws(() => resolveInsideRoot(repoRoot, '/etc/passwd'), /outside repo root/);
});

test('redactSecrets removes common token and private key shapes', () => {
  const input = [
    'OPENAI_API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz123456',
    'AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF',
    '-----BEGIN PRIVATE KEY-----',
    'abc',
    '-----END PRIVATE KEY-----'
  ].join('\n');

  const redacted = redactSecrets(input);

  assert.doesNotMatch(redacted, /sk-live/);
  assert.doesNotMatch(redacted, /AKIA1234567890ABCDEF/);
  assert.doesNotMatch(redacted, /BEGIN PRIVATE KEY/);
  assert.match(redacted, /\[REDACTED/);
});

