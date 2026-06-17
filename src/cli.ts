#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import process from 'node:process';

import { PACKAGE_NAME, PRODUCT_NAME, envValue } from './branding.js';
import { GraphPaginationInputError, paginateGraph } from './graph_pagination.js';

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
    console.log(`${PRODUCT_NAME} UI: ${ui.url}`);
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
    if (subcommand === 'resolve-contracts') {
      const { resolveCrossRepoContracts } = await import('./index.js');
      const name = parseOptionalWorkspaceArg(workspaceArgs, '--name');
      const result = resolveCrossRepoContracts({
        repoRoot,
        ...(name !== undefined ? { workspaceName: name } : {})
      });
      if (workspaceArgs.includes('--json')) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Resolved cross-repo contract links: ${result.links.length}`);
        for (const link of result.links) {
          console.log(`${link.consumerService}:${link.consumerPath} -> ${link.providerService}:${link.httpMethod} ${link.routePath}`);
        }
        for (const warning of result.warnings) {
          console.error(`warning: ${warning}`);
        }
      }
      return;
    }
    if (subcommand === 'contract-diff') {
      const { analyzeContractDiff } = await import('./index.js');
      const name = parseOptionalWorkspaceArg(workspaceArgs, '--name');
      const providerServiceName = parseOptionalWorkspaceArg(workspaceArgs, '--provider');
      const providerRepoPath = parseOptionalWorkspaceArg(workspaceArgs, '--provider-path');
      const contractPath = parseRequiredArg(workspaceArgs, '--contract');
      const result = analyzeContractDiff({
        repoRoot,
        contractPath,
        ...(name !== undefined ? { workspaceName: name } : {}),
        ...(providerServiceName !== undefined ? { providerServiceName } : {}),
        ...(providerRepoPath !== undefined ? { providerRepoPath } : {})
      });
      if (workspaceArgs.includes('--json')) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Contract diff: ${result.summary.classification}`);
        console.log(`Breaking changes: ${result.summary.breakingChangeCount}`);
        console.log(`Impacted consumers: ${result.summary.impactedConsumerCount}`);
        for (const change of result.changes) {
          const endpoint = change.httpMethod && change.routePath ? ` ${change.httpMethod} ${change.routePath}` : '';
          console.log(`${change.classification}: ${change.kind}${endpoint}`);
        }
        for (const consumer of result.impactedConsumers) {
          const topology = formatEventTopology(consumer.eventTopology);
          console.log(
            `consumer: ${consumer.consumerService}:${consumer.consumerPath} -> ${consumer.providerService}:${consumer.httpMethod} ${consumer.routePath}${topology ? ` [topology: ${topology}]` : ''}`
          );
        }
        for (const warning of result.warnings) {
          console.error(`warning: ${warning}`);
        }
      }
      return;
    }
    throw new Error('workspace requires init, add-repo, list, resolve-contracts, or contract-diff');
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
    const reportId = parseRequiredArg(args, '--report');
    const format = parseGraphFormat(args);
    const limit = parseOptionalValueArg(args, '--limit');
    const cursor = parseOptionalValueArg(args, '--cursor');
    const requirePagination = limit !== undefined || cursor !== undefined;
    const graph = await exportImpactGraph({
      repoRoot,
      reportId,
      format
    });
    if (graph.format === 'json' && requirePagination) {
      try {
        console.log(JSON.stringify(
          paginateGraph(graph, { limit: limit ?? null, cursor: cursor ?? null, requirePagination: true }),
          null,
          2
        ));
      } catch (error) {
        if (error instanceof GraphPaginationInputError) throw error;
        throw error;
      }
      return;
    }
    if (requirePagination) {
      throw new Error('graph export --limit/--cursor require --format json');
    }
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
    const previousEnv = envValue('REFLECTION_MODEL');
    if (model !== undefined) {
      process.env.PARALLAX_REFLECTION_MODEL = model;
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
          delete process.env.PARALLAX_REFLECTION_MODEL;
        } else {
          process.env.PARALLAX_REFLECTION_MODEL = previousEnv;
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

function formatEventTopology(topology: {
  providerAction: string;
  counterpartyRole: 'consumer' | 'producer' | 'unknown';
  pattern: string;
} | undefined): string | undefined {
  if (topology === undefined) return undefined;
  return `${topology.providerAction} -> ${topology.counterpartyRole} via ${topology.pattern}`;
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

function parseOptionalValueArg(args: string[], name: string): string | undefined {
  let parsed: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for ${name}`);
    }
    parsed ??= value;
  }
  return parsed;
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
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1] ?? '';
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error(`${name} must be a non-negative integer; got '${value}'`);
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
    '--older-than-days', '--abandon', '--restore', '--max-age', '--limit', '--cursor'
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
  console.log(`${PACKAGE_NAME}

Commands:
  ${PACKAGE_NAME} init
  ${PACKAGE_NAME} index [--max-file-bytes 1000000]
  ${PACKAGE_NAME} doctor
  ${PACKAGE_NAME} ui [--report <id>] [--port <n>]
  ${PACKAGE_NAME} import-session --file <path> --format codex|claude [--branch <name>]
  ${PACKAGE_NAME} workspace init [--name <name>] [--service <service>] [--force]
  ${PACKAGE_NAME} workspace add-repo <path> [--name <name>] [--service <service>] [--remote <url>]
  ${PACKAGE_NAME} workspace list [--name <name>] [--json]
  ${PACKAGE_NAME} workspace resolve-contracts [--name <name>] [--json]
  ${PACKAGE_NAME} workspace contract-diff --contract <path> [--name <name>]
                                      [--provider <service>] [--provider-path <path>] [--json]
  ${PACKAGE_NAME} analyze --changed src/file.ts [--depth 2] [--json]
  ${PACKAGE_NAME} analyze --base main [--head HEAD] [--depth 2] [--json]
  ${PACKAGE_NAME} graph export --report <id> [--format mermaid|json|dot]
                              [--limit 100] [--cursor nodeOffset:edgeOffset]
  ${PACKAGE_NAME} mcp serve

Agent memory:
  ${PACKAGE_NAME} remember --entity <id> --attribute <name> --value <json|string>
                        [--branch <name>] [--agent <id>] [--op assert|retract]
                        [--evidence-fact-ids id1,id2] [--supersedes-fact-ids id1,id2]
  ${PACKAGE_NAME} retract  --entity <id> --attribute <name> --value <json|string>
                        [--branch <name>] [--agent <id>]
  ${PACKAGE_NAME} recall   [--query <text>] [--semantic] [--entity <id>]
                        [--attribute <name>] [--branch <name>] [--k 20]
                        [--as-of-tx <tx-id>] [--current-only]
  ${PACKAGE_NAME} branch   --name <name> [--from <name>]
  ${PACKAGE_NAME} branch   --abandon <name>
  ${PACKAGE_NAME} branch   --restore <name>
  ${PACKAGE_NAME} merge    --target <branch> --source <branch> [--agent <id>]
  ${PACKAGE_NAME} reembed  [--model <hf-model>] [--all]
  ${PACKAGE_NAME} reflect  [--branch <name>] [--older-than-days 30] [--entity <id>]
                        [--model <provider:id>] [--agent <id>] [--dry-run]
  ${PACKAGE_NAME} reflect  --repair [--branch <name>] [--dry-run]
  ${PACKAGE_NAME} gc-branches [--dry-run] [--max-age <days>]
  ${PACKAGE_NAME} reindex-vec [--model <hf-model>]
  ${PACKAGE_NAME} profile  --entity <id> [--branch <name>] [--k 50] [--as-of-tx <tx-id>]
  ${PACKAGE_NAME} trace    --fact-id <id> [--depth 5]
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
