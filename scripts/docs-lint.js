#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);

const forbidden = [
  /\/Users\/[^\s)]+/,
  /\.gstack/,
  /restore point/i,
  /BEGIN (RSA|OPENSSH|PRIVATE) KEY/,
  /github_pat_[A-Za-z0-9_]+/,
  /gho_[A-Za-z0-9_]+/,
  /sk-[A-Za-z0-9]{20,}/
];

for (const file of files) {
  if (!existsSync(file)) continue;
  const content = readFileSync(file, 'utf8');
  for (const pattern of forbidden) {
    if (pattern.test(content)) {
      console.error(`${file}: forbidden local metadata or secret-like content matched ${pattern}`);
      process.exit(1);
    }
  }
}
