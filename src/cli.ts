#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import process from 'node:process';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const repoRoot = process.cwd();

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'init') {
    const { initProject } = await import('./index.js');
    const result = await initProject({ repoRoot });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'index') {
    const { indexProject } = await import('./index.js');
    const maxFileBytes = parseIntegerArg(args, '--max-file-bytes');
    const result = await indexProject({ repoRoot, ...(maxFileBytes === undefined ? {} : { maxFileBytes }) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'analyze') {
    const { analyzeDiff } = await import('./index.js');
    const changedFiles = parseChangedFiles(args, repoRoot);
    const maxDepth = parseIntegerArg(args, '--depth');
    const maxFanout = parseIntegerArg(args, '--max-fanout');
    const report = await analyzeDiff({
      repoRoot,
      changedFiles,
      writeReport: !args.includes('--json'),
      ...(maxDepth === undefined ? {} : { maxDepth }),
      ...(maxFanout === undefined ? {} : { maxFanout })
    });
    if (args.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Impact report ${report.id}`);
      console.log(`Affected files: ${report.affectedFiles.length}`);
      if (report.reportPath) console.log(`Report: ${report.reportPath}`);
    }
    process.exitCode = report.affectedFiles.length > 0 ? 1 : 0;
    return;
  }

  if (command === 'graph' && args[0] === 'export') {
    const { exportImpactGraph } = await import('./graph.js');
    const graph = await exportImpactGraph({
      repoRoot,
      reportId: parseRequiredArg(args, '--report'),
      format: parseGraphFormat(args)
    });
    console.log(graph.rendered);
    return;
  }

  if (command === 'mcp' && args[0] === 'serve') {
    const { serveMcp } = await import('./mcp.js');
    await serveMcp({ repoRoot });
    return;
  }

  if (command === 'remember' || command === 'retract') {
    const { remember, withAgentMemoryDb } = await import('./index.js');
    const entity = parseRequiredArg(args, '--entity');
    const attribute = parseRequiredArg(args, '--attribute');
    const value = parseAgentMemoryValue(parseRequiredArg(args, '--value'));
    const branch = parseOptionalArg(args, '--branch');
    const agent = parseOptionalArg(args, '--agent');
    const opFlag = parseOptionalArg(args, '--op');
    const op = command === 'retract' ? 'retract' : opFlag === 'retract' ? 'retract' : 'assert';
    const evidenceRaw = parseOptionalArg(args, '--evidence-fact-ids');
    const evidenceFactIds = evidenceRaw
      ? evidenceRaw.split(',').map((item) => item.trim()).filter(Boolean)
      : undefined;
    const result = withAgentMemoryDb(repoRoot, false, (db) =>
      remember(db, {
        entity,
        attribute,
        value: value as never,
        op,
        ...(branch !== undefined ? { branch } : {}),
        ...(agent !== undefined ? { agent } : {}),
        ...(evidenceFactIds !== undefined ? { evidenceFactIds } : {})
      })
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'recall') {
    const { recall, withAgentMemoryDb } = await import('./index.js');
    const entity = parseOptionalArg(args, '--entity');
    const attribute = parseOptionalArg(args, '--attribute');
    const branch = parseOptionalArg(args, '--branch');
    const k = parseIntegerArg(args, '--k');
    const asOfTx = parseOptionalArg(args, '--as-of-tx');
    const currentOnly = args.includes('--current-only') ? true : undefined;
    const result = withAgentMemoryDb(repoRoot, true, (db) =>
      recall(db, {
        ...(entity !== undefined ? { entity } : {}),
        ...(attribute !== undefined ? { attribute } : {}),
        ...(branch !== undefined ? { branch } : {}),
        ...(k !== undefined ? { k } : {}),
        ...(asOfTx !== undefined ? { asOfTx } : {}),
        ...(currentOnly !== undefined ? { currentOnly } : {})
      })
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'branch') {
    const { createBranch, withAgentMemoryDb } = await import('./index.js');
    const name = parseRequiredArg(args, '--name');
    const from = parseOptionalArg(args, '--from');
    const result = withAgentMemoryDb(repoRoot, false, (db) =>
      createBranch(db, {
        name,
        ...(from !== undefined ? { from } : {})
      })
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'trace') {
    const { trace, withAgentMemoryDb } = await import('./index.js');
    const factId = parseRequiredArg(args, '--fact-id');
    const depth = parseIntegerArg(args, '--depth');
    const result = withAgentMemoryDb(repoRoot, true, (db) =>
      trace(db, {
        factId,
        ...(depth !== undefined ? { depth } : {})
      })
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

function parseChangedFiles(args: string[], repoRoot: string): string[] {
  const index = args.indexOf('--changed');
  if (index >= 0 && args[index + 1]) {
    return args[index + 1]!.split(',').map((item) => item.trim()).filter(Boolean);
  }
  const base = parseOptionalArg(args, '--base');
  const head = parseOptionalArg(args, '--head');
  if (base) {
    const diffArgs = ['diff', '--name-only', '--diff-filter=ACMR', `${base}...${head ?? 'HEAD'}`];
    return execFileSync('git', diffArgs, { cwd: repoRoot, encoding: 'utf8' })
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (head) {
    throw new Error('analyze --head requires --base');
  }
  const positional = parsePositionals(args);
  if (positional.length > 0) return positional;
  throw new Error('analyze requires --changed <file[,file]> or --base <ref> [--head <ref>]');
}

function parseRequiredArg(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1]!;
  throw new Error(`missing required ${name}`);
}

function parseOptionalArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1]!;
  return undefined;
}

function parseIntegerArg(args: string[], name: string): number | undefined {
  const value = parseOptionalArg(args, name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function parsePositionals(args: string[]): string[] {
  const valueFlags = new Set([
    '--changed', '--base', '--head', '--depth', '--max-fanout', '--max-file-bytes',
    '--report', '--format',
    '--entity', '--attribute', '--value', '--branch', '--agent', '--evidence-fact-ids',
    '--name', '--from', '--fact-id', '--k', '--op', '--as-of-tx'
  ]);
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (valueFlags.has(arg)) {
      index++;
      continue;
    }
    if (!arg.startsWith('--')) positionals.push(arg);
  }
  return positionals;
}

function parseGraphFormat(args: string[]): 'json' | 'mermaid' | 'dot' {
  const index = args.indexOf('--format');
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value === 'mermaid') return 'mermaid';
  if (value === 'json') return 'json';
  if (value === 'dot') return 'dot';
  throw new Error('graph export --format must be mermaid, json, or dot');
}

function printHelp(): void {
  console.log(`impact-trace

Commands:
  impact-trace init
  impact-trace index [--max-file-bytes 1000000]
  impact-trace analyze --changed src/file.ts [--depth 2] [--json]
  impact-trace analyze --base main [--head HEAD] [--depth 2] [--json]
  impact-trace graph export --report <id> [--format mermaid|json|dot]
  impact-trace mcp serve

Agent memory:
  impact-trace remember --entity <id> --attribute <name> --value <json|string>
                        [--branch <name>] [--agent <id>] [--op assert|retract]
                        [--evidence-fact-ids id1,id2]
  impact-trace retract  --entity <id> --attribute <name> --value <json|string>
                        [--branch <name>] [--agent <id>]
  impact-trace recall   [--entity <id>] [--attribute <name>] [--branch <name>]
                        [--k 20] [--as-of-tx <tx-id>] [--current-only]
  impact-trace branch   --name <name> [--from <name>]
  impact-trace trace    --fact-id <id> [--depth 5]
`);
}

function parseAgentMemoryValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
