// Shared UI presentation vocabulary used by ui.ts and the extracted ui/ panel
// modules (impact_map.ts, report_delta.ts). Functions here depend only on Node,
// each other, and ui.ts types (type-only import — erased at compile time, so no
// runtime import cycle). Moved verbatim from ui.ts.

import type {
  ImpactReport,
  ImpactAction
} from '../types.js';
import type { ImpactLane, UiReportPreview, UiEvidencePreview } from '../ui.js';

type SourceLocation = {
  href: string;
  label: string;
  line: number;
};

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function shortenMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 5) return value.slice(0, maxLength);
  const prefixLength = Math.ceil((maxLength - 1) / 2);
  const suffixLength = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, prefixLength)}…${value.slice(value.length - suffixLength)}`;
}

export function sourceHref(file: string, line: number): string {
  return `/source?path=${encodeURIComponent(file)}&line=${line}`;
}

export function entityLabel(entity: ImpactReport['changed'][number]): string {
  return entity.displayName ?? entity.path ?? entity.symbol ?? entity.id;
}

export function confidenceSortRank(confidence: string): number {
  if (confidence === 'proven') return 0;
  if (confidence === 'inferred') return 1;
  if (confidence === 'heuristic') return 2;
  return 3;
}

export function compareAffectedFilesForUi(left: UiReportPreview['affectedFiles'][number], right: UiReportPreview['affectedFiles'][number]): number {
  return confidenceSortRank(left.confidence) - confidenceSortRank(right.confidence)
    || (left.depth ?? 99) - (right.depth ?? 99)
    || left.path.localeCompare(right.path);
}

export function topAffectedFilesForSummary(report: UiReportPreview): UiReportPreview['affectedFiles'] {
  const actionTargets = new Set(report.actions.map((action) => action.target.path).filter((pathValue): pathValue is string => Boolean(pathValue)));
  return [...report.affectedFiles].sort((left, right) => {
    const leftActionable = actionTargets.has(left.path) ? 0 : 1;
    const rightActionable = actionTargets.has(right.path) ? 0 : 1;
    return leftActionable - rightActionable || compareAffectedFilesForUi(left, right);
  });
}

export function classifyImpactLane(pathValue: string, reason: string, actionTargets: ReadonlySet<string>): ImpactLane['id'] {
  const pathLower = pathValue.toLowerCase();
  const reasonLower = reason.toLowerCase();
  if (actionTargets.has(pathValue) || isUiTestPath(pathLower)) return 'tests';
  if (isUiKnowledgePath(pathLower) || /\b(governs|documents|requires|proposes)\b/.test(reasonLower)) return 'knowledge';
  if (isUiContractPath(pathLower) || /\bcontract|endpoint|asyncapi|openapi|graphql|protobuf\b/.test(reasonLower)) return 'contracts';
  if (isUiConfigPath(pathLower) || /\bconfigures|workflow|infra\b/.test(reasonLower)) return 'config';
  return 'code';
}

function isUiTestPath(pathLower: string): boolean {
  return /(^|\/)(tests?|__tests__)\/|(^|\/)src\/test\//.test(pathLower)
    || /(\.|-)(test|spec)\.[cm]?[tj]sx?$/.test(pathLower);
}

function isUiKnowledgePath(pathLower: string): boolean {
  return pathLower.endsWith('.md')
    || /(^|\/)(docs|doc|policies|policy|proposals|prd|requirements|decisions|adr)\//.test(pathLower);
}

function isUiContractPath(pathLower: string): boolean {
  return /(^|\/)(contracts?|apis?)\//.test(pathLower)
    || /(^|[-_.])(openapi|asyncapi)([-_.]|$)/.test(pathLower)
    || /\.(proto|graphql|gql|avsc)$/.test(pathLower);
}

function isUiConfigPath(pathLower: string): boolean {
  return /(^|\/)(\.github\/workflows|terraform|infra|deploy|k8s|helm)\//.test(pathLower)
    || /(^|\/)(dockerfile|makefile|compose\.ya?ml)$/.test(pathLower)
    || /\.(ya?ml|toml|json|jsonc|env|tf|tfvars|hcl|ini)$/.test(pathLower)
    || /(^|\/)(package\.json|pom\.xml|build\.gradle(?:\.kts)?|go\.mod|cargo\.toml|pyproject\.toml)$/.test(pathLower);
}

export function actionByTargetPath(actions: readonly ImpactAction[]): Map<string, ImpactAction> {
  const byPath = new Map<string, ImpactAction>();
  for (const action of actions) {
    const targetPath = action.target.path;
    if (!targetPath || byPath.has(targetPath)) continue;
    byPath.set(targetPath, action);
  }
  return byPath;
}

export function actionCommandText(item: ImpactAction): string | undefined {
  if (!item.command) return undefined;
  return [item.command, ...(item.args ?? [])].map(shellQuoteForUi).join(' ');
}

function shellQuoteForUi(value: string): string {
  const displayValue = value
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  if (displayValue === '--') return displayValue;
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(displayValue) && !displayValue.startsWith('-')) return displayValue;
  return `'${displayValue.replaceAll("'", `'\\''`)}'`;
}

export function impactEvidenceMatchesPath(item: UiEvidencePreview, pathValue: string): boolean {
  return item.file === pathValue || item.subject?.path === pathValue || item.snippet.includes(pathValue);
}

export function evidenceSourceLocation(item: UiEvidencePreview): SourceLocation | undefined {
  if (!item.file || item.file.includes('\0')) return undefined;
  const line = item.startLine ?? 1;
  if (!Number.isInteger(line) || line < 1) return undefined;
  const endLine = item.endLine && item.endLine > line ? item.endLine : undefined;
  return {
    href: sourceHref(item.file, line),
    label: endLine ? `L${line}-L${endLine}` : `L${line}`,
    line
  };
}

export function objectAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

export function stringAt(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return typeof child === 'string' && child.length > 0 ? child : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}
