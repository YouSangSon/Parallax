import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  installParallaxGitHooks,
  planParallaxGitHooks
} from '../src/git_hooks.js';

function tempGitRepo(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

test('plans a pre-commit impact gate without writing files', () => {
  const dir = tempGitRepo('parallax-hook-plan-');
  try {
    const plan = planParallaxGitHooks({ repoRoot: dir });
    const hook = plan.hooks[0];

    assert.equal(hook?.hook, 'pre-commit');
    assert.equal(hook.action, 'create');
    assert.equal(hook.path, path.join(dir, '.git/hooks/pre-commit'));
    assert.equal(existsSync(hook.path), false);
    assert.match(hook.content, /parallax-managed-hook: pre-commit/);
    assert.match(hook.content, /PARALLAX_BIN=\$\{PARALLAX_BIN:-'parallax'\}/);
    assert.match(hook.content, /PARALLAX_FAIL_ON=\$\{PARALLAX_FAIL_ON:-'proven'\}/);
    assert.match(hook.content, /git diff --cached --name-only --diff-filter=ACMR/);
    assert.match(hook.content, /"\$PARALLAX_BIN" init >\/dev\/null/);
    assert.match(hook.content, /"\$PARALLAX_BIN" index >\/dev\/null/);
    assert.match(hook.content, /"\$PARALLAX_BIN" analyze --changed "\$changed_files" --fail-on "\$PARALLAX_FAIL_ON"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installs executable managed hooks and skips existing unmanaged hooks', () => {
  const dir = tempGitRepo('parallax-hook-install-');
  try {
    const first = installParallaxGitHooks({ repoRoot: dir, hooks: ['pre-commit'] });
    const preCommit = first.hooks[0];
    assert.equal(preCommit?.action, 'create');
    assert.equal(existsSync(preCommit.path), true);
    assert.notEqual(statSync(preCommit.path).mode & 0o111, 0);

    const prePushPath = path.join(dir, '.git/hooks/pre-push');
    writeFileSync(prePushPath, '#!/bin/sh\necho custom\n');
    const second = installParallaxGitHooks({ repoRoot: dir, hooks: ['pre-commit', 'pre-push'] });
    assert.equal(second.hooks.find((hook) => hook.hook === 'pre-commit')?.action, 'overwrite');
    assert.equal(second.hooks.find((hook) => hook.hook === 'pre-push')?.action, 'skip');
    assert.equal(readFileSync(prePushPath, 'utf8'), '#!/bin/sh\necho custom\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('honors core.hooksPath when planning hook installation', () => {
  const dir = tempGitRepo('parallax-hook-path-');
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: dir, stdio: 'ignore' });
    const plan = planParallaxGitHooks({
      repoRoot: dir,
      hooks: ['pre-push'],
      command: 'parallax-local',
      failOn: 'inferred'
    });
    const hook = plan.hooks[0];

    assert.equal(hook?.hook, 'pre-push');
    assert.equal(hook.path, path.join(dir, '.githooks/pre-push'));
    assert.match(hook.content, /parallax-managed-hook: pre-push/);
    assert.match(hook.content, /PARALLAX_BIN=\$\{PARALLAX_BIN:-'parallax-local'\}/);
    assert.match(hook.content, /PARALLAX_FAIL_ON=\$\{PARALLAX_FAIL_ON:-'inferred'\}/);
    assert.match(hook.content, /remote_oid/);
    assert.match(hook.content, /PARALLAX_BASE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
