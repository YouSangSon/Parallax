import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { addParallaxMcpServer, installParallaxMcp } from '../src/agent_config.js';

// Opt-in agent setup: write the Parallax (read-only-first) MCP server into a
// client's mcpServers config. Pure merge is unit-tested; the file installer is
// integration-tested against a temp config.

test('adds the parallax server to an empty/undefined config', () => {
  const config = addParallaxMcpServer(undefined);
  assert.deepEqual(config, {
    mcpServers: { parallax: { command: 'parallax', args: ['mcp', 'serve'] } }
  });
});

test('preserves existing servers and other top-level keys', () => {
  const existing = {
    theme: 'dark',
    mcpServers: { other: { command: 'other', args: [] } }
  };
  const config = addParallaxMcpServer(existing);
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.mcpServers?.other, { command: 'other', args: [] });
  assert.deepEqual(config.mcpServers?.parallax, { command: 'parallax', args: ['mcp', 'serve'] });
  // immutability: input is untouched
  assert.equal((existing.mcpServers as Record<string, unknown>).parallax, undefined);
});

test('is idempotent and updates only the parallax entry', () => {
  const once = addParallaxMcpServer(undefined);
  const twice = addParallaxMcpServer(once, { command: 'node', args: ['dist/src/cli.js', 'mcp', 'serve'] });
  assert.deepEqual(twice.mcpServers?.parallax, {
    command: 'node',
    args: ['dist/src/cli.js', 'mcp', 'serve']
  });
  assert.equal(Object.keys(twice.mcpServers ?? {}).length, 1);
});

test('honors a custom server name', () => {
  const config = addParallaxMcpServer(undefined, { name: 'parallax-impact' });
  assert.ok(config.mcpServers?.['parallax-impact']);
});

test('installParallaxMcp creates then idempotently updates a config file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'parallax-agent-'));
  try {
    const configPath = path.join(dir, '.mcp.json');

    const first = installParallaxMcp(configPath, { command: 'parallax' });
    assert.equal(first.created, true);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(written.mcpServers.parallax, { command: 'parallax', args: ['mcp', 'serve'] });

    // Existing unrelated content is preserved across a re-install.
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { other: { command: 'x', args: [] }, parallax: written.mcpServers.parallax } }, null, 2)
    );
    const second = installParallaxMcp(configPath, { command: 'parallax' });
    assert.equal(second.created, false);
    const merged = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.ok(merged.mcpServers.other, 'other server preserved');
    assert.equal(Object.keys(merged.mcpServers).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
