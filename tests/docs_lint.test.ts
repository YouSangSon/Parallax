import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { redactSecrets } from '../src/security.js';

const docsLintScript = fileURLToPath(new URL('../scripts/docs-lint.js', import.meta.url));
const docsLintModuleUrl = new URL('../scripts/docs-lint.js', import.meta.url).href;

type MarkdownFiles = Record<string, string>;
type SecretSample = {
  name: string;
  docsLabel: string;
  sample: string;
};

const runtimeSecretSamples: SecretSample[] = [
  { name: 'OpenAI API key', docsLabel: 'OpenAI API key', sample: `OpenAI key: sk-${'z'.repeat(20)}` },
  { name: 'Stripe live key', docsLabel: 'Stripe key', sample: `Stripe live key: sk_live_${'a'.repeat(20)}` },
  { name: 'Stripe test key', docsLabel: 'Stripe key', sample: `Stripe test key: sk_test_${'m'.repeat(20)}` },
  { name: 'Stripe restricted key', docsLabel: 'Stripe key', sample: `Stripe restricted key: rk_test_${'b'.repeat(20)}` },
  { name: 'GitHub gh token', docsLabel: 'GitHub gh token', sample: `GitHub gh token: ghp_${'c'.repeat(20)}` },
  {
    name: 'GitHub fine-grained PAT',
    docsLabel: 'GitHub fine-grained PAT',
    sample: `GitHub fine-grained token: github_pat_${'g'.repeat(20)}`
  },
  { name: 'Slack token', docsLabel: 'Slack token', sample: `Slack bot token: xoxb-${'1'.repeat(20)}` },
  { name: 'AWS access key', docsLabel: 'AWS access key', sample: `AWS access key: AKIA${'A'.repeat(16)}` },
  {
    name: 'AWS secret access key assignment',
    docsLabel: 'AWS secret access key assignment',
    sample: `AWS_SECRET_ACCESS_KEY=${'d'.repeat(32)}`
  },
  { name: 'Google API key', docsLabel: 'Google API key', sample: `Google API key: AIza${'E'.repeat(35)}` },
  { name: 'npm token', docsLabel: 'npm token', sample: `npm token: npm_${'f'.repeat(36)}` },
  {
    name: 'JWT',
    docsLabel: 'JWT',
    sample: `JWT in fenced code still fails:\n\n\`\`\`\nconst token = "eyJ${'h'.repeat(8)}.${'i'.repeat(8)}.${'j'.repeat(8)}";\n\`\`\``
  },
  { name: 'Bearer token', docsLabel: 'Bearer token', sample: `Authorization: Bearer ${'k'.repeat(24)}` },
  {
    name: 'database URL with credentials',
    docsLabel: 'database URL with credentials',
    sample: 'Database URL: postgres://impact_user:impact_password@localhost:5432/impact'
  },
  {
    name: 'generic private key',
    docsLabel: 'private key',
    sample: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'
  },
  {
    name: 'RSA private key',
    docsLabel: 'private key',
    sample: '-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----'
  },
  {
    name: 'OpenSSH private key',
    docsLabel: 'private key',
    sample: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----'
  },
  {
    name: 'EC private key',
    docsLabel: 'private key',
    sample: '-----BEGIN EC PRIVATE KEY-----\nsecret\n-----END EC PRIVATE KEY-----'
  },
  {
    name: 'DSA private key',
    docsLabel: 'private key',
    sample: '-----BEGIN DSA PRIVATE KEY-----\nsecret\n-----END DSA PRIVATE KEY-----'
  }
];

async function makeMarkdownRepo(files: MarkdownFiles, trackedFiles: string[]): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-docs-lint-'));
  execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });

  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repoRoot, file)), { recursive: true });
    await writeFile(path.join(repoRoot, file), content);
  }

  if (trackedFiles.length > 0) {
    execFileSync('git', ['add', ...trackedFiles], { cwd: repoRoot, stdio: 'ignore' });
  }

  return repoRoot;
}

function runDocsLint(repoRoot: string) {
  return spawnSync(process.execPath, [docsLintScript], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function secretSampleFile(index: number): string {
  return `${index % 2 === 0 ? 'tracked' : 'draft'}-${index}.md`;
}

test('docs-lint rejects the same representative secret corpus that runtime redacts', async () => {
  for (const { name, sample } of runtimeSecretSamples) {
    assert.notEqual(redactSecrets(sample, 5000), sample, `${name} should be redacted at runtime`);
  }

  const secretFiles = Object.fromEntries(
    runtimeSecretSamples.map(({ sample }, index) => [secretSampleFile(index), `# Secret ${index}\n\n${sample}\n`])
  );
  const trackedSecretFiles = runtimeSecretSamples
    .map((_, index) => secretSampleFile(index))
    .filter((_, index) => index % 2 === 0);
  const repoRoot = await makeMarkdownRepo(
    secretFiles,
    trackedSecretFiles
  );

  const result = runDocsLint(repoRoot);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0, output);
  for (const [index, { docsLabel, name }] of runtimeSecretSamples.entries()) {
    const file = secretSampleFile(index);
    assert.match(
      output,
      new RegExp(`docs-lint: ${escapeRegExp(file)}: .*${escapeRegExp(docsLabel)}`),
      `${name} should be reported by docs-lint`
    );
  }
});

test('tracked docs cannot satisfy trilingual parity with only untracked variants', async () => {
  const repoRoot = await makeMarkdownRepo(
    {
      'docs/topic.md': [
        '# Topic',
        '',
        '**English** · [한국어](topic.ko.md) · [中文](topic.zh.md)',
        ''
      ].join('\n'),
      'docs/topic.ko.md': [
        '# Topic',
        '',
        '[English](topic.md) · **한국어** · [中文](topic.zh.md)',
        ''
      ].join('\n'),
      'docs/topic.zh.md': [
        '# Topic',
        '',
        '[English](topic.md) · [한국어](topic.ko.md) · **中文**',
        ''
      ].join('\n')
    },
    ['docs/topic.md', 'docs/topic.ko.md']
  );

  const result = runDocsLint(repoRoot);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0, output);
  assert.match(output, /docs-lint: docs\/topic\.md:/);
  assert.match(output, /docs-lint: docs\/topic\.ko\.md:/);
  assert.match(output, /topic\.zh\.md exists only as untracked and must be staged\/tracked/);
});

test('package-visible docs cannot link to unpackaged skill Markdown', async () => {
  const repoRoot = await makeMarkdownRepo(
    {
      'README.md': '# Root\n\n**English** · [한국어](README.ko.md) · [中文](README.zh.md)\n',
      'README.ko.md': '# Root\n\n[English](README.md) · **한국어** · [中文](README.zh.md)\n',
      'README.zh.md': '# Root\n\n[English](README.md) · [한국어](README.ko.md) · **中文**\n',
      'docs/topic.md': [
        '# Topic',
        '',
        '**English** · [한국어](topic.ko.md) · [中文](topic.zh.md)',
        '',
        'See the private [skill](../skills/parallax/SKILL.md).',
        ''
      ].join('\n'),
      'docs/topic.ko.md': [
        '# Topic',
        '',
        '[English](topic.md) · **한국어** · [中文](topic.zh.md)',
        '',
        'See [root](../README.ko.md).',
        ''
      ].join('\n'),
      'docs/topic.zh.md': [
        '# Topic',
        '',
        '[English](topic.md) · [한국어](topic.ko.md) · **中文**',
        '',
        'See [root](../README.zh.md).',
        ''
      ].join('\n'),
      'skills/parallax/SKILL.md': '# Skill\n'
    },
    [
      'README.md',
      'README.ko.md',
      'README.zh.md',
      'docs/topic.md',
      'docs/topic.ko.md',
      'docs/topic.zh.md',
      'skills/parallax/SKILL.md'
    ]
  );

  const result = runDocsLint(repoRoot);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0, output);
  assert.match(output, /docs-lint: docs\/topic\.md:/);
  assert.match(output, /package-visible Markdown links to unpackaged target \.\.\/skills\/parallax\/SKILL\.md/);
});

test('repo-relative Markdown helpers keep POSIX paths for Windows-host-safe link checks', async () => {
  const { resolveRepoMarkdownTarget, siblingPaths } = await import(docsLintModuleUrl) as {
    resolveRepoMarkdownTarget: (file: string, target: string) => string;
    siblingPaths: (base: string) => { canonical: string; ko: string; zh: string };
  };

  assert.deepEqual(siblingPaths('docs/guides/topic.md'), {
    canonical: 'docs/guides/topic.md',
    ko: 'docs/guides/topic.ko.md',
    zh: 'docs/guides/topic.zh.md'
  });
  assert.deepEqual(siblingPaths('docs\\guides\\topic.md'), {
    canonical: 'docs/guides/topic.md',
    ko: 'docs/guides/topic.ko.md',
    zh: 'docs/guides/topic.zh.md'
  });
  assert.equal(resolveRepoMarkdownTarget('docs/guides/topic.ko.md', '../reference/api.md'), 'docs/reference/api.md');
  assert.equal(resolveRepoMarkdownTarget('docs\\guides\\topic.ko.md', '..\\reference\\api.md'), 'docs/reference/api.md');
  assert.equal(resolveRepoMarkdownTarget('docs/guides/topic.zh.md', './topic.md'), 'docs/guides/topic.md');
});

test('docs-lint flags missing local image targets (markdown and HTML <img>), not present ones', async () => {
  const repoRoot = await makeMarkdownRepo(
    {
      'README.md': [
        '# Root',
        '',
        '**English** · [한국어](README.ko.md) · [中文](README.zh.md)',
        '',
        '<img src="docs/assets/present.png" alt="ok" width="100%">',
        '<img src="docs/assets/missing-html.png" alt="broken">',
        '![badge](https://img.shields.io/badge/x-y-z)',
        '![shot](docs/assets/missing-md.png)',
        'Documenting syntax in code is ignored: `![](code-only.png)` and `<img src="code-only2.png">`.',
        ''
      ].join('\n'),
      'README.ko.md': '# Root\n\n[English](README.md) · **한국어** · [中文](README.zh.md)\n',
      'README.zh.md': '# Root\n\n[English](README.md) · [한국어](README.ko.md) · **中文**\n',
      'docs/assets/present.png': 'PNGDATA'
    },
    ['README.md', 'README.ko.md', 'README.zh.md', 'docs/assets/present.png']
  );

  const result = runDocsLint(repoRoot);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0, output);
  assert.match(output, /missing image target docs\/assets\/missing-html\.png/);
  assert.match(output, /missing image target docs\/assets\/missing-md\.png/);
  // present image and the external shields.io badge must NOT be reported.
  assert.doesNotMatch(output, /present\.png/);
  assert.doesNotMatch(output, /shields\.io/);
  // image syntax inside inline code is documentation, not a reference.
  assert.doesNotMatch(output, /code-only/);
});

test('docs-lint passes benign tracked and untracked Markdown', async () => {
  const repoRoot = await makeMarkdownRepo(
    {
      'notes.md': '# Notes\n\nThis document has no local links or credentials.\n',
      'draft.md': '# Draft\n\nUntracked Markdown is scanned but this content is safe.\n'
    },
    ['notes.md']
  );

  const result = runDocsLint(repoRoot);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /docs-lint: OK/);
});
