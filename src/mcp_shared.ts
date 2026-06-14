import { asConfidence } from './confidence.js';
import { evidenceResourceUri, truncateSnippet } from './context_pack.js';
import { normalizeRepoRoot, redactSecrets } from './security.js';
import { getRepoId, openDatabase } from './store.js';
import type { Confidence } from './types.js';
import type { McpContext } from './mcp.js';

export type ExplainEvidenceRow = {
  evidence_id: string;
  relation_id: string;
  evidence_file_path: string;
  evidence_kind: string;
  evidence_snippet: string;
  evidence_confidence: string;
  evidence_start_line: number | null;
  evidence_end_line: number | null;
  evidence_start_col: number | null;
  evidence_end_col: number | null;
};

export type CompactEvidenceResource = {
  id: string;
  file: string;
  kind: string;
  snippet: string;
  confidence: Confidence;
  resourceUri: string;
  startLine?: number;
  endLine?: number;
  startCol?: number;
  endCol?: number;
};

export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function compactEvidenceResource(row: ExplainEvidenceRow, snippetChars = 300): CompactEvidenceResource {
  return {
    id: row.evidence_id,
    file: row.evidence_file_path,
    kind: row.evidence_kind,
    snippet: truncateSnippet(redactSecrets(row.evidence_snippet), snippetChars),
    confidence: asConfidence(row.evidence_confidence),
    resourceUri: evidenceResourceUri(row.evidence_id),
    ...(row.evidence_start_line !== null ? { startLine: row.evidence_start_line } : {}),
    ...(row.evidence_end_line !== null ? { endLine: row.evidence_end_line } : {}),
    ...(row.evidence_start_col !== null ? { startCol: row.evidence_start_col } : {}),
    ...(row.evidence_end_col !== null ? { endCol: row.evidence_end_col } : {})
  };
}

export function evidenceSpanColumnSelect(db: ReturnType<typeof openDatabase>, alias: string): string {
  if (!mcpHasColumn(db, 'relation_evidence', 'start_line')) {
    return [
      'NULL AS evidence_start_line',
      'NULL AS evidence_end_line',
      'NULL AS evidence_start_col',
      'NULL AS evidence_end_col'
    ].join(',\n          ');
  }
  return [
    `${alias}.start_line AS evidence_start_line`,
    `${alias}.end_line AS evidence_end_line`,
    `${alias}.start_col AS evidence_start_col`,
    `${alias}.end_col AS evidence_end_col`
  ].join(',\n          ');
}

export function mcpHasColumn(db: ReturnType<typeof openDatabase>, table: string, column: string): boolean {
  return db
    .prepare('SELECT 1 AS one FROM pragma_table_info(?) WHERE name = ?')
    .get(table, column) !== undefined;
}

export function mcpHasTable(db: ReturnType<typeof openDatabase>, table: string): boolean {
  return db
    .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) !== undefined;
}

export function withReadOnlyDb<T>(context: McpContext, callback: (db: ReturnType<typeof openDatabase>, repoId: number) => T): T {
  const repoRoot = normalizeRepoRoot(context.repoRoot);
  const db = openDatabase(repoRoot, { readOnly: true });
  try {
    const repoId = getRepoId(db, repoRoot);
    return callback(db, repoId);
  } finally {
    db.close();
  }
}
