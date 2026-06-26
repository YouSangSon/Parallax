import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ImpactBenchReport } from './impact-bench.js';

const defaultReportPath = '.parallax/bench/impact-bench-report.json';

type FormatOptions = {
  baseline?: ImpactBenchReport | undefined;
};

export type GenerateBenchSummaryOptions = {
  reportPath?: string;
  baselinePath?: string | undefined;
  allowMissing?: boolean;
};

type WriteBenchSummaryOptions = GenerateBenchSummaryOptions & {
  outputPath?: string | undefined;
  githubStepSummary?: boolean;
  env?: NodeJS.ProcessEnv;
};

export async function generateBenchSummaryMarkdown(
  options: GenerateBenchSummaryOptions = {}
): Promise<string> {
  const reportPath = options.reportPath ?? defaultReportPath;
  let report: ImpactBenchReport;
  try {
    report = await loadBenchReport(reportPath);
  } catch (error) {
    if (options.allowMissing && isMissingFileError(error)) {
      return formatMissingBenchReportMarkdown(reportPath);
    }
    throw error;
  }

  const baseline = options.baselinePath
    ? await loadOptionalBenchReport(options.baselinePath)
    : undefined;
  return formatBenchSummaryMarkdown(report, { baseline });
}

export async function writeBenchSummary(
  options: WriteBenchSummaryOptions = {}
): Promise<string> {
  const markdown = await generateBenchSummaryMarkdown(options);
  const output = ensureTrailingNewline(markdown);
  if (options.githubStepSummary) {
    const summaryPath = options.env?.GITHUB_STEP_SUMMARY;
    if (!summaryPath) {
      throw new Error('GITHUB_STEP_SUMMARY is not set');
    }
    await appendFile(summaryPath, output, 'utf8');
  } else if (options.outputPath) {
    await writeFile(options.outputPath, output, 'utf8');
  } else {
    process.stdout.write(output);
  }
  return markdown;
}

export async function loadBenchReport(filePath: string): Promise<ImpactBenchReport> {
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  assertBenchReport(parsed, filePath);
  return parsed;
}

export function formatBenchSummaryMarkdown(
  report: ImpactBenchReport,
  options: FormatOptions = {}
): string {
  const baseline = options.baseline;
  const metricRows = [
    metricRow('Overall score', report.summary.score, baseline?.summary.score),
    metricRow('Relation recall', report.scores.relationRecall, baseline?.scores.relationRecall),
    metricRow('Relation precision', report.scores.relationPrecision, baseline?.scores.relationPrecision),
    metricRow('Affected-file recall', report.scores.affectedFileRecall, baseline?.scores.affectedFileRecall),
    metricRow('Evidence presence', report.scores.evidencePresence, baseline?.scores.evidencePresence),
    metricRow('Span completeness', report.scores.spanCompleteness, baseline?.scores.spanCompleteness),
    metricRow('Adapter attribution', report.scores.adapterAttribution, baseline?.scores.adapterAttribution),
    metricRow(
      'Context-pack readiness',
      report.scores.contextPackReadiness,
      baseline?.scores.contextPackReadiness
    ),
    metricRow(
      'Cross-repo contract impact',
      report.crossRepoContracts.summary.score,
      baseline?.crossRepoContracts?.summary.score
    ),
    metricRow('Retrieval recall@5', report.retrieval.summary.recallAt5, baseline?.retrieval.summary.recallAt5),
    metricRow('Retrieval MRR', report.retrieval.summary.mrr, baseline?.retrieval.summary.mrr),
    metricRow('Retrieval nDCG@10', report.retrieval.summary.ndcgAt10, baseline?.retrieval.summary.ndcgAt10),
    ...semanticMetricRows(report, baseline)
  ];

  const lines = [
    '## Impact Bench',
    '',
    `**Status:** ${report.summary.passed ? 'passed' : 'failed'}${baseline ? ` (baseline: ${baseline.summary.passed ? 'passed' : 'failed'})` : ''}`,
    '',
    `Fixture: \`${report.fixtureId}\``,
    `Report: \`${report.outputPath}\``,
    '',
    '| Metric | Current | Delta |',
    '| :--- | ---: | ---: |',
    ...metricRows,
    '',
    '| Coverage | Current | Delta |',
    '| :--- | ---: | ---: |',
    countRow(
      'Matched relations',
      `${report.summary.matchedRelations}/${report.summary.expectedRelations}`,
      report.summary.matchedRelations,
      baseline?.summary.matchedRelations
    ),
    countRow(
      'Unexpected relations',
      String(report.summary.unexpectedRelations),
      report.summary.unexpectedRelations,
      baseline?.summary.unexpectedRelations,
      { lowerIsBetter: true }
    ),
    countRow(
      'Matched affected files',
      `${report.analyzeDiff.matchedAffectedFiles.length}/${report.analyzeDiff.expectedAffectedFiles.length}`,
      report.analyzeDiff.matchedAffectedFiles.length,
      baseline?.analyzeDiff.matchedAffectedFiles.length
    ),
    countRow(
      'Cross-repo impacts',
      `${report.crossRepoContracts.summary.matchedImpacts}/${report.crossRepoContracts.summary.expectedImpacts}`,
      report.crossRepoContracts.summary.matchedImpacts,
      baseline?.crossRepoContracts?.summary.matchedImpacts
    ),
    countRow(
      'Cross-repo graph edges',
      `${report.crossRepoContracts.summary.matchedGraphEdges}/${report.crossRepoContracts.summary.expectedGraphEdges}`,
      report.crossRepoContracts.summary.matchedGraphEdges,
      baseline?.crossRepoContracts?.summary.matchedGraphEdges
    ),
    '',
    '| Retrieval query | Recall@5 | MRR | Returned bytes | Budget exceeded |',
    '| :--- | ---: | ---: | ---: | :--- |',
    ...report.retrieval.queries.map((query) => [
      `| \`${escapeTableCell(query.id)}\``,
      formatDecimal(query.recallAt5),
      formatDecimal(query.mrr),
      String(query.returnedBytes),
      query.budgetExceeded ? 'yes' : 'no'
    ].join(' | ') + ' |'),
    '',
    ...semanticModelTableRows(report),
    '',
    listSection('Missing cross-repo consumers', report.crossRepoContracts.missingConsumerPaths),
    '',
    listSection('Missing relations', report.missingRelations),
    '',
    listSection('Unexpected relations', report.unexpectedRelations)
  ];

  return ensureTrailingNewline(lines.join('\n'));
}

function semanticMetricRows(
  report: ImpactBenchReport,
  baseline: ImpactBenchReport | undefined
): string[] {
  const current = report.retrieval.semanticModels?.summary;
  if (!current) return [];
  const previous = baseline?.retrieval.semanticModels?.summary;
  return [
    metricRow('Semantic recall@1', current.recallAt1, previous?.recallAt1),
    metricRow('Semantic model isolation', current.isolation, previous?.isolation)
  ];
}

function semanticModelTableRows(report: ImpactBenchReport): string[] {
  const semanticModels = report.retrieval.semanticModels;
  if (!semanticModels) return [];
  return [
    '| Semantic model | Recall@1 | Isolated | Top fact |',
    '| :--- | ---: | :--- | :--- |',
    ...semanticModels.models.map((model) => [
      `| \`${escapeTableCell(model.model)}\``,
      formatDecimal(model.recallAt1),
      model.isolated ? 'yes' : 'no',
      model.topFactId ? `\`${escapeTableCell(model.topFactId)}\`` : 'none'
    ].join(' | ') + ' |')
  ];
}

function formatMissingBenchReportMarkdown(reportPath: string): string {
  return ensureTrailingNewline([
    '## Impact Bench',
    '',
    `No bench report was found at \`${reportPath}\`.`,
    '',
    'Run `npm run bench` before generating the summary.'
  ].join('\n'));
}

async function loadOptionalBenchReport(filePath: string): Promise<ImpactBenchReport | undefined> {
  try {
    return await loadBenchReport(filePath);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function metricRow(
  label: string,
  current: number,
  baseline: number | undefined
): string {
  return `| ${label} | ${formatDecimal(current)} | ${deltaCell(current, baseline)} |`;
}

function countRow(
  label: string,
  currentText: string,
  current: number,
  baseline: number | undefined,
  options: { lowerIsBetter?: boolean } = {}
): string {
  const delta = baseline === undefined
    ? 'n/a'
    : formatSignedInteger(current - baseline, options.lowerIsBetter);
  return `| ${label} | ${currentText} | ${delta} |`;
}

function deltaCell(current: number, baseline: number | undefined): string {
  return baseline === undefined ? 'n/a' : formatSignedDecimal(current - baseline);
}

function formatDecimal(value: number): string {
  return value.toFixed(4);
}

function formatSignedDecimal(value: number): string {
  if (Object.is(value, -0)) value = 0;
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
}

function formatSignedInteger(value: number, lowerIsBetter = false): string {
  if (Object.is(value, -0)) value = 0;
  const prefix = value >= 0 ? '+' : '';
  const suffix = lowerIsBetter && value > 0 ? ' worse' : lowerIsBetter && value < 0 ? ' better' : '';
  return `${prefix}${value}${suffix}`;
}

function listSection(title: string, values: readonly string[]): string {
  if (values.length === 0) return `### ${title}\n\nNone.`;
  const visible = values.slice(0, 20);
  const remainder = values.length - visible.length;
  return [
    `### ${title}`,
    '',
    ...visible.map((value) => `- ${value}`),
    ...(remainder > 0 ? [`- ... ${remainder} more`] : [])
  ].join('\n');
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function assertBenchReport(value: unknown, label: string): asserts value is ImpactBenchReport {
  if (!isRecord(value)) throw new Error(`invalid bench report ${label}: expected object`);
  assertNumber(value.schemaVersion, label, 'schemaVersion');
  assertString(value.fixtureId, label, 'fixtureId');
  assertRecord(value.summary, label, 'summary');
  assertBoolean(value.summary.passed, label, 'summary.passed');
  for (const key of ['score', 'expectedRelations', 'matchedRelations', 'unexpectedRelations']) {
    assertNumber(value.summary[key], label, `summary.${key}`);
  }
  assertRecord(value.scores, label, 'scores');
  for (const key of [
    'relationRecall',
    'relationPrecision',
    'affectedFileRecall',
    'evidencePresence',
    'spanCompleteness',
    'adapterAttribution',
    'contextPackReadiness'
  ]) {
    assertNumber(value.scores[key], label, `scores.${key}`);
  }
  assertStringArray(value.missingRelations, label, 'missingRelations');
  assertStringArray(value.unexpectedRelations, label, 'unexpectedRelations');
  assertRecord(value.analyzeDiff, label, 'analyzeDiff');
  assertStringArray(value.analyzeDiff.expectedAffectedFiles, label, 'analyzeDiff.expectedAffectedFiles');
  assertStringArray(value.analyzeDiff.matchedAffectedFiles, label, 'analyzeDiff.matchedAffectedFiles');
  if (value.schemaVersion >= 4 || value.crossRepoContracts !== undefined) {
    assertRecord(value.crossRepoContracts, label, 'crossRepoContracts');
    assertString(value.crossRepoContracts.fixtureId, label, 'crossRepoContracts.fixtureId');
    assertRecord(value.crossRepoContracts.summary, label, 'crossRepoContracts.summary');
    assertBoolean(value.crossRepoContracts.summary.passed, label, 'crossRepoContracts.summary.passed');
    for (const key of [
      'score',
      'expectedImpacts',
      'matchedImpacts',
      'expectedGraphEdges',
      'matchedGraphEdges'
    ]) {
      assertNumber(value.crossRepoContracts.summary[key], label, `crossRepoContracts.summary.${key}`);
    }
    assertStringArray(
      value.crossRepoContracts.expectedConsumerPaths,
      label,
      'crossRepoContracts.expectedConsumerPaths'
    );
    assertStringArray(
      value.crossRepoContracts.matchedConsumerPaths,
      label,
      'crossRepoContracts.matchedConsumerPaths'
    );
    assertStringArray(
      value.crossRepoContracts.missingConsumerPaths,
      label,
      'crossRepoContracts.missingConsumerPaths'
    );
    assertStringArray(
      value.crossRepoContracts.expectedEvidenceKinds,
      label,
      'crossRepoContracts.expectedEvidenceKinds'
    );
    assertStringArray(
      value.crossRepoContracts.matchedEvidenceKinds,
      label,
      'crossRepoContracts.matchedEvidenceKinds'
    );
    assertRecord(value.crossRepoContracts.graphEdges, label, 'crossRepoContracts.graphEdges');
    assertNumber(
      value.crossRepoContracts.graphEdges.expected,
      label,
      'crossRepoContracts.graphEdges.expected'
    );
    assertNumber(
      value.crossRepoContracts.graphEdges.matched,
      label,
      'crossRepoContracts.graphEdges.matched'
    );
  }
  assertRecord(value.retrieval, label, 'retrieval');
  assertRecord(value.retrieval.summary, label, 'retrieval.summary');
  for (const key of ['recallAt5', 'recallAt10', 'precisionAt5', 'mrr', 'ndcgAt10']) {
    assertNumber(value.retrieval.summary[key], label, `retrieval.summary.${key}`);
  }
  if (!Array.isArray(value.retrieval.queries)) {
    throw new Error(`invalid bench report ${label}: expected retrieval.queries array`);
  }
  for (const [index, query] of value.retrieval.queries.entries()) {
    assertRecord(query, label, `retrieval.queries[${index}]`);
    assertString(query.id, label, `retrieval.queries[${index}].id`);
    assertNumber(query.recallAt5, label, `retrieval.queries[${index}].recallAt5`);
    assertNumber(query.mrr, label, `retrieval.queries[${index}].mrr`);
    assertNumber(query.returnedBytes, label, `retrieval.queries[${index}].returnedBytes`);
    assertBoolean(query.budgetExceeded, label, `retrieval.queries[${index}].budgetExceeded`);
  }
  if (value.schemaVersion >= 3 || value.retrieval.semanticModels !== undefined) {
    assertRecord(value.retrieval.semanticModels, label, 'retrieval.semanticModels');
    assertRecord(value.retrieval.semanticModels.summary, label, 'retrieval.semanticModels.summary');
    assertBoolean(
      value.retrieval.semanticModels.summary.passed,
      label,
      'retrieval.semanticModels.summary.passed'
    );
    for (const key of ['modelCount', 'recallAt1', 'isolation']) {
      assertNumber(
        value.retrieval.semanticModels.summary[key],
        label,
        `retrieval.semanticModels.summary.${key}`
      );
    }
    if (!Array.isArray(value.retrieval.semanticModels.models)) {
      throw new Error(`invalid bench report ${label}: expected retrieval.semanticModels.models array`);
    }
    for (const [index, model] of value.retrieval.semanticModels.models.entries()) {
      assertRecord(model, label, `retrieval.semanticModels.models[${index}]`);
      assertString(model.model, label, `retrieval.semanticModels.models[${index}].model`);
      assertString(
        model.expectedFactId,
        label,
        `retrieval.semanticModels.models[${index}].expectedFactId`
      );
      assertString(
        model.disallowedFactId,
        label,
        `retrieval.semanticModels.models[${index}].disallowedFactId`
      );
      assertNullableString(
        model.topFactId,
        label,
        `retrieval.semanticModels.models[${index}].topFactId`
      );
      assertStringArray(
        model.returnedFactIds,
        label,
        `retrieval.semanticModels.models[${index}].returnedFactIds`
      );
      assertNumber(model.recallAt1, label, `retrieval.semanticModels.models[${index}].recallAt1`);
      assertBoolean(model.isolated, label, `retrieval.semanticModels.models[${index}].isolated`);
    }
  }
  assertString(value.outputPath, label, 'outputPath');
}

function assertRecord(value: unknown, label: string, key: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`invalid bench report ${label}: expected ${key} object`);
}

function assertString(value: unknown, label: string, key: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`invalid bench report ${label}: expected ${key} string`);
  }
}

function assertNullableString(
  value: unknown,
  label: string,
  key: string
): asserts value is string | null {
  if (typeof value !== 'string' && value !== null) {
    throw new Error(`invalid bench report ${label}: expected ${key} string or null`);
  }
}

function assertNumber(value: unknown, label: string, key: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid bench report ${label}: expected ${key} number`);
  }
}

function assertBoolean(value: unknown, label: string, key: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`invalid bench report ${label}: expected ${key} boolean`);
  }
}

function assertStringArray(value: unknown, label: string, key: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`invalid bench report ${label}: expected ${key} string array`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function parseCliArgs(argv: readonly string[]): WriteBenchSummaryOptions {
  const options: WriteBenchSummaryOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--report') {
      options.reportPath = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === '--baseline') {
      options.baselinePath = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === '--output') {
      options.outputPath = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === '--github-step-summary') {
      options.githubStepSummary = true;
    } else if (arg === '--allow-missing') {
      options.allowMissing = true;
    } else if (arg === '--help') {
      printHelp();
      process.exitCode = 0;
      return options;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp(): void {
  process.stdout.write([
    'Usage: npm run bench:report -- [--report <json>] [--baseline <json>] [--output <md>]',
    '',
    'Options:',
    '  --report <json>           Bench report path. Defaults to .parallax/bench/impact-bench-report.json',
    '  --baseline <json>         Optional baseline report for delta columns',
    '  --output <md>             Write Markdown to a file instead of stdout',
    '  --github-step-summary     Append Markdown to GITHUB_STEP_SUMMARY',
    '  --allow-missing           Emit a non-failing missing-report summary when the report is absent'
  ].join('\n') + '\n');
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (process.exitCode === 0 && process.argv.includes('--help')) return;
  await writeBenchSummary({ ...options, env: process.env });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  await main();
}
