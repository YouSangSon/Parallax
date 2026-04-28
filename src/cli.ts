#!/usr/bin/env node
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
    const result = await indexProject({ repoRoot });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'analyze') {
    const { analyzeDiff } = await import('./index.js');
    const changedFiles = parseChangedFiles(args);
    const report = await analyzeDiff({ repoRoot, changedFiles, writeReport: !args.includes('--json') });
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

  if (command === 'mcp' && args[0] === 'serve') {
    await serveMcp(repoRoot);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

function parseChangedFiles(args: string[]): string[] {
  const index = args.indexOf('--changed');
  if (index >= 0 && args[index + 1]) {
    return args[index + 1]!.split(',').map((item) => item.trim()).filter(Boolean);
  }
  const positional = args.filter((arg) => !arg.startsWith('--'));
  if (positional.length > 0) return positional;
  throw new Error('analyze requires --changed <file[,file]> for this MVP');
}

async function serveMcp(repoRoot: string): Promise<void> {
  const { handleMcpRequest } = await import('./mcp.js');
  process.stdin.setEncoding('utf8');
  let buffer = '';
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const response = await handleMcpRequest(JSON.parse(line), { repoRoot });
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
      newline = buffer.indexOf('\n');
    }
  }
}

function printHelp(): void {
  console.log(`impact-trace

Commands:
  impact-trace init
  impact-trace index
  impact-trace analyze --changed src/file.ts [--json]
  impact-trace mcp serve
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
