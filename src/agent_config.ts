// Opt-in agent setup: register Parallax's read-only-first MCP server in an MCP
// client's config (the standard `mcpServers` JSON shape used by Claude Code,
// Cursor, Windsurf, and others). This is never automatic — it runs only via the
// explicit `parallax install-agent` command. The merge is pure and immutable;
// the file installer is the only side effect.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';

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

export type CopilotPackageFileAction = 'create' | 'overwrite' | 'skip';

export type PlannedCopilotPackageFile = {
  path: string;
  content: string;
  action: CopilotPackageFileAction;
};

export type CopilotAgentPackageOptions = ParallaxMcpOptions & {
  targetRepo: string;
  config?: string;
  force?: boolean;
};

export type CopilotAgentPackagePlan = {
  targetRepo: string;
  files: PlannedCopilotPackageFile[];
};

const COPILOT_INSTRUCTIONS_PATH = '.github/copilot-instructions.md';
const COPILOT_AGENT_PATH = '.github/agents/parallax-impact.agent.md';

export function planCopilotAgentPackage(options: CopilotAgentPackageOptions): CopilotAgentPackagePlan {
  const targetRepo = resolve(options.targetRepo);
  const files: PlannedCopilotPackageFile[] = [
    plannedCopilotFile(targetRepo, COPILOT_INSTRUCTIONS_PATH, copilotInstructionsTemplate(), options.force ?? false),
    plannedCopilotFile(targetRepo, COPILOT_AGENT_PATH, copilotAgentTemplate(), options.force ?? false)
  ];

  if (options.config !== undefined) {
    const configPath = normalizeTargetRelativePath(options.config);
    files.push(
      plannedCopilotFile(
        targetRepo,
        configPath,
        `${JSON.stringify(addParallaxMcpServer(readExistingMcpConfig(resolveTargetPath(targetRepo, configPath)), options), null, 2)}\n`,
        options.force ?? false
      )
    );
  }

  return { targetRepo, files };
}

export function installCopilotAgentPackage(options: CopilotAgentPackageOptions): CopilotAgentPackagePlan {
  const plan = planCopilotAgentPackage(options);
  for (const file of plan.files) {
    if (file.action === 'skip') continue;
    const destination = resolveTargetPath(plan.targetRepo, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.content);
  }
  return plan;
}

function plannedCopilotFile(targetRepo: string, path: string, content: string, force: boolean): PlannedCopilotPackageFile {
  const relativePath = normalizeTargetRelativePath(path);
  const destination = resolveTargetPath(targetRepo, relativePath);
  const exists = existsSync(destination);
  const action: CopilotPackageFileAction = exists ? (force ? 'overwrite' : 'skip') : 'create';
  return { path: relativePath, content, action };
}

function normalizeTargetRelativePath(path: string): string {
  if (isAbsolute(path)) {
    throw new Error(`Copilot package file path must be relative to the target repo: ${path}`);
  }
  const normalized = normalize(path).replaceAll(sep, '/');
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    throw new Error(`Copilot package file path must stay inside the target repo: ${path}`);
  }
  return normalized;
}

function resolveTargetPath(targetRepo: string, path: string): string {
  const destination = resolve(targetRepo, path);
  const rel = relative(targetRepo, destination);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Copilot package file path escapes the target repo: ${path}`);
  }
  return destination;
}

function readExistingMcpConfig(configPath: string): McpClientConfig | undefined {
  if (!existsSync(configPath)) return undefined;
  const raw = readFileSync(configPath, 'utf8').trim();
  if (raw.length === 0) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`existing MCP config is not a JSON object: ${configPath}`);
  }
  return parsed as McpClientConfig;
}

function copilotInstructionsTemplate(): string {
  return `# Parallax Agent Instructions

Before editing PR-impactful code, ask Parallax for impact context from the target repository.

- Run Parallax from the repository root after dependencies are available.
- Use \`parallax_context_for_change\` for changed files before broad edits.
- Use \`parallax_search_context\` when you need symbol, path, relation, or evidence context.
- Use \`parallax_query_entities\` to inspect directly connected indexed entities before changing callers, providers, or contracts.
- Prefer proven evidence over inferred or heuristic evidence, and mention known gaps when Parallax reports them.
- Treat Parallax actions as recommendations. Verify with the repository's normal tests, typecheck, and review flow.

For CI or pull-request annotation, generate SARIF and upload it with GitHub Code Scanning:

\`\`\`bash
parallax analyze --changed "$CHANGED_FILES" --sarif-output parallax.sarif --sarif-category parallax-pr --fail-on none
\`\`\`

Upload \`parallax.sarif\` separately, for example with \`github/codeql-action/upload-sarif\`.
`;
}

function copilotAgentTemplate(): string {
  return `---
name: parallax-impact
description: Use Parallax impact analysis before editing code that may affect callers, contracts, tests, or PR review scope.
tools:
  - parallax_context_for_change
  - parallax_search_context
  - parallax_query_entities
---

Start by identifying the changed files or intended edit targets. Request Parallax context for those paths, inspect related entities, and summarize high-confidence impacted files, contracts, tests, known gaps, and recommended verification before making changes.

When CI feedback is useful, ask for SARIF generation with \`parallax analyze --changed "$CHANGED_FILES" --sarif-output parallax.sarif --sarif-category parallax-pr --fail-on none\` so GitHub Code Scanning can annotate the pull request.
`;
}
