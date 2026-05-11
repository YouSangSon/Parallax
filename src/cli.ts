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

  if (command === 'doctor') {
    const { doctorProject, hasDoctorErrors } = await import('./index.js');
    const report = doctorProject({ repoRoot });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = hasDoctorErrors(report) ? 1 : 0;
    return;
  }

  if (command === 'ui') {
    const { startUiServer } = await import('./ui.js');
    const reportId = parseOptionalArg(args, '--report');
    const port = parseIntegerArg(args, '--port');
    const ui = await startUiServer({
      repoRoot,
      ...(reportId !== undefined ? { reportId } : {}),
      ...(port !== undefined ? { port } : {})
    });
    console.log(`Impact Trace UI: ${ui.url}`);
    await waitForShutdown(ui.close);
    return;
  }

  if (command === 'import-session') {
    const { importSession } = await import('./index.js');
    const file = parseRequiredArg(args, '--file');
    const format = parseSessionImportFormat(parseRequiredArg(args, '--format'));
    const branch = parseOptionalArg(args, '--branch');
    const agent = parseOptionalArg(args, '--agent');
    const result = await importSession({
      repoRoot,
      file,
      format,
      ...(branch !== undefined ? { branch } : {}),
      ...(agent !== undefined ? { agent } : {})
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'workspace') {
    const [subcommand, ...workspaceArgs] = args;
    if (subcommand === 'init') {
      const { initWorkspace } = await import('./index.js');
      const name = parseOptionalWorkspaceArg(workspaceArgs, '--name');
      const serviceName = parseOptionalWorkspaceArg(workspaceArgs, '--service');
      const result = initWorkspace({
        repoRoot,
        ...(name !== undefined ? { name } : {}),
        ...(serviceName !== undefined ? { serviceName } : {}),
        ...(workspaceArgs.includes('--force') ? { force: true } : {})
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (subcommand === 'add-repo') {
      const { addWorkspaceRepo } = await import('./index.js');
      const localPath = workspaceArgs[0];
      if (!localPath || localPath.startsWith('--')) {
        throw new Error('workspace add-repo requires <path>');
      }
      const workspaceName = parseOptionalWorkspaceArg(workspaceArgs, '--name');
      const serviceName = parseOptionalWorkspaceArg(workspaceArgs, '--service');
      const remoteUrl = parseOptionalWorkspaceArg(workspaceArgs, '--remote');
      const result = addWorkspaceRepo({
        repoRoot,
        localPath,
        ...(workspaceName !== undefined ? { workspaceName } : {}),
        ...(serviceName !== undefined ? { serviceName } : {}),
        ...(remoteUrl !== undefined ? { remoteUrl } : {})
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (subcommand === 'list') {
      const { listWorkspaces } = await import('./index.js');
      const name = parseOptionalWorkspaceArg(workspaceArgs, '--name');
      const result = listWorkspaces({
        repoRoot,
        ...(name !== undefined ? { name } : {})
      });
      if (workspaceArgs.includes('--json')) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const workspace of result.workspaces) {
          console.log(workspace.name);
          for (const repo of workspace.repos) {
            const label = repo.serviceName ? ` (${repo.serviceName})` : '';
            console.log(`  ${repo.localPath}${label}`);
          }
        }
      }
      return;
    }
    throw new Error('workspace requires init, add-repo, or list');
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
    const { rememberOnRepo } = await import('./index.js');
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
    const supersedesRaw = parseOptionalArg(args, '--supersedes-fact-ids');
    const supersedesFactIds = supersedesRaw
      ? supersedesRaw.split(',').map((item) => item.trim()).filter(Boolean)
      : undefined;
    const result = await rememberOnRepo(repoRoot, {
      entity,
      attribute,
      value: value as never,
      op,
      ...(branch !== undefined ? { branch } : {}),
      ...(agent !== undefined ? { agent } : {}),
      ...(evidenceFactIds !== undefined ? { evidenceFactIds } : {}),
      ...(supersedesFactIds !== undefined ? { supersedesFactIds } : {})
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'recall') {
    const { recallOnRepo } = await import('./index.js');
    const query = parseOptionalArg(args, '--query');
    const entity = parseOptionalArg(args, '--entity');
    const attribute = parseOptionalArg(args, '--attribute');
    const branch = parseOptionalArg(args, '--branch');
    const k = parseIntegerArg(args, '--k');
    const asOfTx = parseOptionalArg(args, '--as-of-tx');
    const currentOnly = args.includes('--current-only') ? true : undefined;
    const semantic = args.includes('--semantic') ? true : undefined;
    const result = await recallOnRepo(repoRoot, {
      ...(query !== undefined ? { query } : {}),
      ...(entity !== undefined ? { entity } : {}),
      ...(attribute !== undefined ? { attribute } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(k !== undefined ? { k } : {}),
      ...(asOfTx !== undefined ? { asOfTx } : {}),
      ...(currentOnly !== undefined ? { currentOnly } : {}),
      ...(semantic !== undefined ? { semantic } : {})
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'branch') {
    const abandonName = parseOptionalArg(args, '--abandon');
    if (abandonName !== undefined) {
      const { abandonBranch, withAgentMemoryDb } = await import('./index.js');
      const result = withAgentMemoryDb(repoRoot, false, (db) =>
        abandonBranch(db, { name: abandonName })
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const restoreName = parseOptionalArg(args, '--restore');
    if (restoreName !== undefined) {
      const { restoreBranch, withAgentMemoryDb } = await import('./index.js');
      const result = withAgentMemoryDb(repoRoot, false, (db) =>
        restoreBranch(db, { name: restoreName })
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }
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

  if (command === 'profile') {
    const { profileEntity } = await import('./index.js');
    const entity = parseRequiredArg(args, '--entity');
    const branch = parseOptionalArg(args, '--branch');
    const k = parseIntegerArg(args, '--k');
    const asOfTx = parseOptionalArg(args, '--as-of-tx');
    const result = await profileEntity(repoRoot, {
      entity,
      ...(branch !== undefined ? { branch } : {}),
      ...(k !== undefined ? { k } : {}),
      ...(asOfTx !== undefined ? { asOfTx } : {})
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'reindex-vec') {
    const { reindexVecOnRepo } = await import('./index.js');
    const model = parseOptionalArg(args, '--model');
    const result = reindexVecOnRepo(repoRoot, {
      ...(model !== undefined ? { model } : {})
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'gc-branches') {
    const { gcBranches, withAgentMemoryDb } = await import('./index.js');
    const dryRun = args.includes('--dry-run') ? true : undefined;
    const maxAgeRaw = parseOptionalArg(args, '--max-age');
    let maxAgeDays: number | undefined;
    if (maxAgeRaw !== undefined) {
      const parsed = Number.parseInt(maxAgeRaw, 10);
      if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== maxAgeRaw) {
        throw new Error(`gc-branches --max-age must be a non-negative integer; got '${maxAgeRaw}'`);
      }
      maxAgeDays = parsed;
    }
    const result = withAgentMemoryDb(repoRoot, false, (db) =>
      gcBranches(db, {
        ...(dryRun !== undefined ? { dryRun } : {}),
        ...(maxAgeDays !== undefined ? { maxAgeDays } : {})
      })
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'reflect') {
    if (args.includes('--repair')) {
      const { repairReflections } = await import('./index.js');
      const branch = parseOptionalArg(args, '--branch');
      const dryRun = args.includes('--dry-run') ? true : undefined;
      const result = await repairReflections(repoRoot, {
        ...(branch !== undefined ? { branch } : {}),
        ...(dryRun !== undefined ? { dryRun } : {})
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const { reflectFacts } = await import('./index.js');
    const branch = parseOptionalArg(args, '--branch');
    const olderThanDays = parseIntegerArg(args, '--older-than-days');
    const entity = parseOptionalArg(args, '--entity');
    const agent = parseOptionalArg(args, '--agent');
    const model = parseOptionalArg(args, '--model');
    const dryRun = args.includes('--dry-run') ? true : undefined;
    const previousEnv = process.env.IMPACT_TRACE_REFLECTION_MODEL;
    if (model !== undefined) {
      process.env.IMPACT_TRACE_REFLECTION_MODEL = model;
    }
    try {
      const result = await reflectFacts(repoRoot, {
        ...(branch !== undefined ? { branch } : {}),
        ...(olderThanDays !== undefined ? { olderThanDays } : {}),
        ...(entity !== undefined ? { entity } : {}),
        ...(agent !== undefined ? { agent } : {}),
        ...(dryRun !== undefined ? { dryRun } : {})
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      if (model !== undefined) {
        if (previousEnv === undefined) {
          delete process.env.IMPACT_TRACE_REFLECTION_MODEL;
        } else {
          process.env.IMPACT_TRACE_REFLECTION_MODEL = previousEnv;
        }
      }
    }
    return;
  }

  if (command === 'reembed') {
    const { reembedFacts } = await import('./index.js');
    const model = parseOptionalArg(args, '--model');
    const all = args.includes('--all') ? true : undefined;
    const result = await reembedFacts(repoRoot, {
      ...(model !== undefined ? { model } : {}),
      ...(all !== undefined ? { all } : {})
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'merge') {
    const { mergeBranches, withAgentMemoryDb } = await import('./index.js');
    const target = parseRequiredArg(args, '--target');
    const source = parseRequiredArg(args, '--source');
    const agent = parseOptionalArg(args, '--agent');
    const result = withAgentMemoryDb(repoRoot, false, (db) =>
      mergeBranches(db, {
        target,
        source,
        ...(agent !== undefined ? { agent } : {})
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

function parseOptionalWorkspaceArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`missing value for ${name}`);
  }
  return value;
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
    '--report', '--format', '--file', '--port', '--service', '--remote',
    '--entity', '--attribute', '--value', '--branch', '--agent', '--evidence-fact-ids',
    '--name', '--from', '--fact-id', '--k', '--op', '--as-of-tx',
    '--target', '--source', '--query', '--model',
    '--older-than-days', '--abandon', '--restore', '--max-age'
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
  impact-trace doctor
  impact-trace ui [--report <id>] [--port <n>]
  impact-trace import-session --file <path> --format codex|claude [--branch <name>]
  impact-trace workspace init [--name <name>] [--service <service>] [--force]
  impact-trace workspace add-repo <path> [--name <name>] [--service <service>] [--remote <url>]
  impact-trace workspace list [--name <name>] [--json]
  impact-trace analyze --changed src/file.ts [--depth 2] [--json]
  impact-trace analyze --base main [--head HEAD] [--depth 2] [--json]
  impact-trace graph export --report <id> [--format mermaid|json|dot]
  impact-trace mcp serve

Agent memory:
  impact-trace remember --entity <id> --attribute <name> --value <json|string>
                        [--branch <name>] [--agent <id>] [--op assert|retract]
                        [--evidence-fact-ids id1,id2] [--supersedes-fact-ids id1,id2]
  impact-trace retract  --entity <id> --attribute <name> --value <json|string>
                        [--branch <name>] [--agent <id>]
  impact-trace recall   [--query <text>] [--semantic] [--entity <id>]
                        [--attribute <name>] [--branch <name>] [--k 20]
                        [--as-of-tx <tx-id>] [--current-only]
  impact-trace branch   --name <name> [--from <name>]
  impact-trace branch   --abandon <name>
  impact-trace branch   --restore <name>
  impact-trace merge    --target <branch> --source <branch> [--agent <id>]
  impact-trace reembed  [--model <hf-model>] [--all]
  impact-trace reflect  [--branch <name>] [--older-than-days 30] [--entity <id>]
                        [--model <provider:id>] [--agent <id>] [--dry-run]
  impact-trace reflect  --repair [--branch <name>] [--dry-run]
  impact-trace gc-branches [--dry-run] [--max-age <days>]
  impact-trace reindex-vec [--model <hf-model>]
  impact-trace profile  --entity <id> [--branch <name>] [--k 50] [--as-of-tx <tx-id>]
  impact-trace trace    --fact-id <id> [--depth 5]
`);
}

function waitForShutdown(close: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let closing = false;
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      close().then(resolve, reject);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

function parseAgentMemoryValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseSessionImportFormat(raw: string): 'codex' | 'claude' {
  if (raw === 'codex' || raw === 'claude') return raw;
  throw new Error('import-session --format must be codex or claude');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
