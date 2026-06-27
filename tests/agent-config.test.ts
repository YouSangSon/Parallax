import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  addParallaxMcpServer,
  installCopilotAgentPackage,
  installParallaxMcp,
  planCopilotAgentPackage
} from '../src/agent_config.js';

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

test('plans Copilot package files for a target repo without writing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'parallax-copilot-plan-'));
  try {
    const plan = planCopilotAgentPackage({ targetRepo: dir, config: '.mcp.json' });
    assert.deepEqual(
      plan.files.map((file) => ({ path: file.path, action: file.action })),
      [
        { path: '.github/copilot-instructions.md', action: 'create' },
        { path: '.github/agents/parallax-impact.agent.md', action: 'create' },
        { path: '.mcp.json', action: 'create' }
      ]
    );
    assert.equal(existsSync(path.join(dir, '.github/copilot-instructions.md')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not overwrite existing Copilot package files without force', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'parallax-copilot-existing-'));
  try {
    const instructionsPath = path.join(dir, '.github/copilot-instructions.md');
    mkdirSync(path.dirname(instructionsPath), { recursive: true });
    writeFileSync(instructionsPath, 'custom instructions\n');
    const plan = planCopilotAgentPackage({ targetRepo: dir });
    const instructions = plan.files.find((file) => file.path === '.github/copilot-instructions.md');
    assert.equal(instructions?.action, 'skip');

    const installed = installCopilotAgentPackage({ targetRepo: dir });
    assert.equal(installed.files.find((file) => file.path === '.github/copilot-instructions.md')?.action, 'skip');
    assert.equal(readFileSync(instructionsPath, 'utf8'), 'custom instructions\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skipped Copilot package MCP config does not parse invalid existing JSON', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'parallax-copilot-invalid-mcp-'));
  try {
    const configPath = path.join(dir, '.mcp.json');
    writeFileSync(configPath, '{not valid json\n');
    const plan = planCopilotAgentPackage({ targetRepo: dir, config: '.mcp.json', force: false });

    assert.deepEqual(
      plan.files
        .filter((file) => file.path === '.mcp.json')
        .map((file) => ({ path: file.path, action: file.action })),
      [{ path: '.mcp.json', action: 'skip' }]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('force marks existing Copilot package files for overwrite', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'parallax-copilot-force-'));
  try {
    const agentPath = path.join(dir, '.github/agents/parallax-impact.agent.md');
    mkdirSync(path.dirname(agentPath), { recursive: true });
    writeFileSync(agentPath, 'old agent\n');
    const plan = planCopilotAgentPackage({ targetRepo: dir, force: true });
    assert.equal(plan.files.find((file) => file.path === '.github/agents/parallax-impact.agent.md')?.action, 'overwrite');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generated Copilot agent has frontmatter and Parallax workflow guidance', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'parallax-copilot-content-'));
  try {
    const plan = planCopilotAgentPackage({ targetRepo: dir });
    const agent = plan.files.find((file) => file.path === '.github/agents/parallax-impact.agent.md');
    assert.ok(agent);
    assert.match(agent.content, /^---\nname: parallax-impact\ndescription: /);
    assert.match(agent.content, /\ntools:\n  - parallax_context_for_change\n  - parallax_search_context\n  - parallax_query_entities\n---\n/);

    const instructions = plan.files.find((file) => file.path === '.github/copilot-instructions.md');
    assert.ok(instructions);
    assert.match(instructions.content, /parallax_context_for_change/);
    assert.match(instructions.content, /parallax_search_context/);
    assert.match(instructions.content, /parallax_query_entities/);
    assert.match(instructions.content, /SARIF/);
    assert.match(instructions.content, /parallax analyze --changed "\$CHANGED_FILES" --sarif-output parallax\.sarif/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Copilot package MCP snippet preserves existing servers when forced', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'parallax-copilot-mcp-'));
  try {
    const configPath = path.join(dir, '.mcp.json');
    writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: 'other', args: [] } } }, null, 2));
    const plan = planCopilotAgentPackage({ targetRepo: dir, config: '.mcp.json', force: true });
    const config = plan.files.find((file) => file.path === '.mcp.json');
    assert.equal(config?.action, 'overwrite');
    const parsed = JSON.parse(config.content);
    assert.deepEqual(parsed.mcpServers.other, { command: 'other', args: [] });
    assert.deepEqual(parsed.mcpServers.parallax, { command: 'parallax', args: ['mcp', 'serve'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
