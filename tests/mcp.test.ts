import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { handleMcpRequest, indexProject, initProject } from '../src/index.js';

async function makeRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-mcp-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(repoRoot, 'src/b.ts'), 'import { a } from "./a"; export const b = a;\n');
  await initProject({ repoRoot });
  await indexProject({ repoRoot });
  return repoRoot;
}

test('MCP tools/list exposes only read-only tools by default', async () => {
  const repoRoot = await makeRepo();
  const response = await handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    { repoRoot }
  );

  assert.equal(response.id, 1);
  assert.equal(response.error, undefined);
  assert.ok(response.result.tools.some((tool: { name: string }) => tool.name === 'impact_trace_analyze_diff'));
  assert.equal(response.result.tools.some((tool: { name: string }) => tool.name.includes('obsidian')), false);
});

test('MCP analyze_diff validates paths and returns affected files', async () => {
  const repoRoot = await makeRepo();

  const response = await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 'analyze',
      method: 'tools/call',
      params: {
        name: 'impact_trace_analyze_diff',
        arguments: { changedFiles: ['src/a.ts'] }
      }
    },
    { repoRoot }
  );

  assert.equal(response.error, undefined);
  assert.equal(response.result.content[0].type, 'text');
  const report = JSON.parse(response.result.content[0].text) as { affectedFiles: Array<{ path: string }> };
  assert.ok(report.affectedFiles.some((file) => file.path === 'src/b.ts'));

  const bad = await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 'bad',
      method: 'tools/call',
      params: {
        name: 'impact_trace_analyze_diff',
        arguments: { changedFiles: ['../outside.ts'] }
      }
    },
    { repoRoot }
  );

  assert.ok(bad.error);
  assert.equal(bad.error.code, -32602);
  assert.match(bad.error.message, /outside repo root/);
});
