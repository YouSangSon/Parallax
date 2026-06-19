// Opt-in agent setup: register Parallax's read-only-first MCP server in an MCP
// client's config (the standard `mcpServers` JSON shape used by Claude Code,
// Cursor, Windsurf, and others). This is never automatic — it runs only via the
// explicit `parallax install-agent` command. The merge is pure and immutable;
// the file installer is the only side effect.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type McpServerEntry = { command: string; args: string[] };
export type McpClientConfig = {
  mcpServers?: Record<string, McpServerEntry>;
} & Record<string, unknown>;

export type ParallaxMcpOptions = {
  name?: string;
  command?: string;
  args?: string[];
};

const DEFAULT_NAME = 'parallax';
const DEFAULT_COMMAND = 'parallax';
const DEFAULT_ARGS = ['mcp', 'serve'];

export function addParallaxMcpServer(
  config: McpClientConfig | undefined,
  options: ParallaxMcpOptions = {}
): McpClientConfig {
  const name = options.name ?? DEFAULT_NAME;
  const entry: McpServerEntry = {
    command: options.command ?? DEFAULT_COMMAND,
    args: options.args ?? [...DEFAULT_ARGS]
  };
  const base = config ?? {};
  return {
    ...base,
    mcpServers: {
      ...(base.mcpServers ?? {}),
      [name]: entry
    }
  };
}

export type InstallResult = {
  path: string;
  created: boolean;
  config: McpClientConfig;
};

export function installParallaxMcp(
  configPath: string,
  options: ParallaxMcpOptions = {}
): InstallResult {
  const exists = existsSync(configPath);
  let existing: McpClientConfig | undefined;
  if (exists) {
    const raw = readFileSync(configPath, 'utf8').trim();
    if (raw.length > 0) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`existing MCP config is not a JSON object: ${configPath}`);
      }
      existing = parsed as McpClientConfig;
    }
  }
  const config = addParallaxMcpServer(existing, options);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { path: configPath, created: !exists, config };
}
