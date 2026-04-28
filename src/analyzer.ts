import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ensureRepo, getRepoId, latestCompletedIndexRun, openDatabase } from './store.js';
import { normalizeRepoRoot, redactSecrets, resolveInsideRoot, toRelativePath } from './security.js';
import type { AnalyzeOptions, Confidence, EntityKind, EntityRef, Evidence, ImpactAction, ImpactReport, ImpactTarget } from './types.js';

type ImpactRow = {
  sourcePath: string;
  sourceEntity: EntityRef;
  reason: string;
  relationKind: string;
  confidence: Confidence;
  evidence: Evidence;
};

type CanonicalImpactRow = {
  relation_id: string;
  relation_kind: string;
  relation_confidence: string;
  provenance: string;
  source_entity_id: string;
  source_kind: string;
  source_path: string | null;
  source_symbol: string | null;
  source_language_id: string | null;
  source_display_name: string;
  evidence_id: string | null;
  evidence_file_path: string | null;
  evidence_kind: string | null;
  evidence_snippet: string | null;
  evidence_confidence: string | null;
};

type LegacyImpactRow = {
  source_path: string;
  kind: string;
  confidence: 'proven' | 'inferred' | 'heuristic';
  provenance: string;
};

export async function analyzeDiff(options: AnalyzeOptions): Promise<ImpactReport> {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const db = openDatabase(repoRoot, options.readOnly ? { readOnly: true } : {});
  const repoId = options.readOnly ? getRepoId(db, repoRoot) : ensureRepo(db, repoRoot);
  const indexRunId = latestCompletedIndexRun(db, repoId);
  const changedFiles = options.changedFiles.map((file) => {
    const resolved = resolveInsideRoot(repoRoot, file);
    return toRelativePath(repoRoot, resolved);
  }).sort();

  const affected = new Map<string, { path: string; reason: string; confidence: Confidence; target: EntityRef }>();
  const evidence: Evidence[] = [];

  for (const changedFile of changedFiles) {
    const changedEntityId = `file:${changedFile}`;
    const changedEntityRow = db
      .prepare('SELECT id FROM entities WHERE repo_id = ? AND id = ? AND updated_index_run_id = ?')
      .get(repoId, changedEntityId, indexRunId) as { id: string } | undefined;
    const changedFileRow = changedEntityRow
      ? undefined
      : db
        .prepare('SELECT id FROM files WHERE repo_id = ? AND path = ? AND index_run_id = ?')
        .get(repoId, changedFile, indexRunId) as { id: number } | undefined;

    if (!changedEntityRow && !changedFileRow) {
      affected.set(changedFile, {
        path: changedFile,
        reason: 'changed file not in index',
        confidence: 'unknown',
        target: entityForPath(changedFile)
      });
      continue;
    }

    const impactRows = changedEntityRow
      ? loadCanonicalImpactRows(db, repoId, indexRunId, changedEntityId, changedFile)
      : [];
    const rows = impactRows.length > 0
      ? impactRows
      : loadLegacyImpactRows(db, repoRoot, repoId, indexRunId, changedFile);

    for (const row of rows) {
      affected.set(row.sourcePath, {
        path: row.sourcePath,
        reason: row.reason,
        confidence: row.confidence,
        target: row.sourceEntity
      });
      evidence.push(row.evidence);
    }

    evidence.push(makeEvidence(repoRoot, changedFile, 'changed-file', 'proven'));
  }

  const affectedFiles = [...affected.values()].sort((a, b) => a.path.localeCompare(b.path));
  const changed = changedFiles.map((file) => entityForPath(file));
  const affectedTargets: ImpactTarget[] = affectedFiles.map((file) => ({
    target: file.target,
    relations: [file.reason],
    confidence: file.confidence
  }));
  const actions = affectedFiles
    .filter((file) => /(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\.[cm]?[tj]sx?$/.test(file.path))
    .map((file): ImpactAction => {
      const target = entityForPath(file.path);
      return {
        kind: 'verify',
        runnerId: 'npm',
        target,
        command: 'npm',
        args: ['test', '--', file.path],
        display: ['npm', 'test', '--', shellQuote(file.path)].join(' '),
        confidence: file.confidence
      };
    });
  const id = createHash('sha1').update(`${indexRunId}:${changedFiles.join(',')}`).digest('hex').slice(0, 12);
  const report: ImpactReport = {
    id,
    indexRunId,
    changedFiles,
    affectedFiles,
    changed,
    affected: affectedTargets,
    actions,
    testCommands: actions,
    evidence: dedupeEvidence(evidence)
  };

  if (options.writeReport) {
    const reportDir = path.join(repoRoot, '.impact-trace', 'reports');
    mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join('.impact-trace', 'reports', `${id}.md`);
    writeFileSync(path.join(repoRoot, reportPath), renderMarkdown(report), 'utf8');
    report.reportPath = reportPath.split(path.sep).join('/');
  }

  if (options.persistReport !== false && !options.readOnly) {
    db.prepare('INSERT OR REPLACE INTO reports (id, repo_id, index_run_id, json, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
      .run(report.id, repoId, indexRunId, JSON.stringify(report));
  }
  db.close();

  return report;
}

function loadCanonicalImpactRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  changedEntityId: string,
  changedFile: string
): ImpactRow[] {
  const rows = db
    .prepare(`
      SELECT
        r.id AS relation_id,
        r.kind AS relation_kind,
        r.confidence AS relation_confidence,
        r.provenance AS provenance,
        source.id AS source_entity_id,
        source.kind AS source_kind,
        source.path AS source_path,
        source.symbol AS source_symbol,
        source.language_id AS source_language_id,
        source.display_name AS source_display_name,
        evidence.id AS evidence_id,
        evidence.file_path AS evidence_file_path,
        evidence.kind AS evidence_kind,
        evidence.snippet AS evidence_snippet,
        evidence.confidence AS evidence_confidence
      FROM relations r
      JOIN entities source ON source.id = r.source_entity_id
      LEFT JOIN relation_evidence evidence ON evidence.relation_id = r.id
      WHERE r.repo_id = ?
        AND r.target_entity_id = ?
        AND r.index_run_id = ?
        AND source.path IS NOT NULL
      ORDER BY source.path, r.kind, r.id
    `)
    .all(repoId, changedEntityId, indexRunId) as CanonicalImpactRow[];

  return rows.map((row) => {
    const confidence = asConfidence(row.relation_confidence);
    const sourceEntity = entityFromCanonicalRow(row);
    const relationKind = row.relation_kind;
    return {
      sourcePath: row.source_path!,
      sourceEntity,
      reason: reasonForCanonicalRelation(relationKind, changedFile),
      relationKind,
      confidence,
      evidence: evidenceFromCanonicalRow(row, sourceEntity, relationKind, confidence)
    };
  });
}

function loadLegacyImpactRows(
  db: ReturnType<typeof openDatabase>,
  repoRoot: string,
  repoId: number,
  indexRunId: number,
  changedFile: string
): ImpactRow[] {
  const rows = db
    .prepare(`
      SELECT f.path AS source_path, e.kind, e.confidence, e.provenance
      FROM edges e
      JOIN files f ON f.id = e.source_file_id
      WHERE e.repo_id = ?
        AND e.target_path = ?
        AND e.index_run_id = ?
      ORDER BY f.path
    `)
    .all(repoId, changedFile, indexRunId) as LegacyImpactRow[];

  return rows.map((row) => {
    const sourceEntity = entityForPath(row.source_path);
    return {
      sourcePath: row.source_path,
      sourceEntity,
      reason: reasonForLegacyRelation(row.kind, changedFile),
      relationKind: row.kind,
      confidence: row.confidence,
      evidence: makeEvidence(repoRoot, row.source_path, row.kind, row.confidence)
    };
  });
}

function entityFromCanonicalRow(row: CanonicalImpactRow): EntityRef {
  const kind = isEntityKind(row.source_kind) ? row.source_kind : 'file';
  return {
    id: row.source_entity_id,
    kind,
    ...(row.source_path ? { path: row.source_path } : {}),
    ...(row.source_symbol ? { symbol: row.source_symbol } : {}),
    ...(row.source_language_id ? { languageId: row.source_language_id } : {}),
    displayName: row.source_display_name
  };
}

function evidenceFromCanonicalRow(
  row: CanonicalImpactRow,
  sourceEntity: EntityRef,
  relationKind: string,
  confidence: Confidence
): Evidence {
  return {
    id: row.evidence_id ?? createHash('sha1').update(`${row.relation_id}:${row.source_path}`).digest('hex').slice(0, 16),
    file: row.evidence_file_path ?? row.source_path ?? '',
    kind: row.evidence_kind ?? relationKind,
    snippet: row.evidence_snippet ?? '',
    confidence: asConfidence(row.evidence_confidence ?? confidence),
    subject: sourceEntity,
    relationKind,
    extractorId: 'canonical-entity-graph'
  };
}

function reasonForCanonicalRelation(kind: string, changedFile: string): string {
  if (kind === 'DEPENDS_ON') return `depends on ${changedFile}`;
  if (kind === 'VERIFIES') return `verifies ${changedFile}`;
  if (kind === 'DOCUMENTS') return `documents ${changedFile}`;
  if (kind === 'CONFIGURES') return `configures ${changedFile}`;
  if (kind === 'DEPLOYS') return `deploys ${changedFile}`;
  return `${kind.toLowerCase()} ${changedFile}`;
}

function reasonForLegacyRelation(kind: string, changedFile: string): string {
  if (kind === 'IMPORTS') return `imports ${changedFile}`;
  if (kind === 'TESTS') return `tests ${changedFile}`;
  if (kind === 'DOCUMENTS') return `documents ${changedFile}`;
  return `${kind.toLowerCase()} ${changedFile}`;
}

function asConfidence(value: string): Confidence {
  return value === 'proven' || value === 'inferred' || value === 'heuristic' || value === 'unknown'
    ? value
    : 'unknown';
}

function isEntityKind(value: string): value is EntityKind {
  return [
    'file',
    'symbol',
    'module',
    'package',
    'test',
    'doc',
    'config',
    'policy',
    'workflow',
    'resource',
    'endpoint',
    'contract',
    'event',
    'external_entity'
  ].includes(value);
}

function makeEvidence(repoRoot: string, relativePath: string, kind: string, confidence: Evidence['confidence']): Evidence {
  const id = createHash('sha1').update(`${kind}:${relativePath}`).digest('hex').slice(0, 16);
  const subject = entityForPath(relativePath);
  let content: string;
  try {
    const absolutePath = resolveInsideRoot(repoRoot, relativePath);
    content = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    return {
      id,
      file: relativePath,
      kind: 'evidence-unavailable',
      snippet: redactSecrets(error instanceof Error ? error.message : String(error)),
      confidence: 'unknown',
      subject,
      relationKind: kind,
      extractorId: 'mvp-file-edge'
    };
  }

  return {
    id,
    file: relativePath,
    kind,
    snippet: redactSecrets(content),
    confidence,
    subject,
    relationKind: kind,
    extractorId: 'mvp-file-edge'
  };
}

function dedupeEvidence(evidence: Evidence[]): Evidence[] {
  return [...new Map(evidence.map((item) => [item.id, item])).values()].sort((a, b) => a.file.localeCompare(b.file));
}

function renderMarkdown(report: ImpactReport): string {
  const affected = report.affectedFiles.map((file) => `- ${file.path} - ${file.reason} (${file.confidence})`).join('\n') || '- None';
  const tests = report.actions
    .filter((action) => action.kind === 'verify')
    .map((action) => `- \`${action.display}\``)
    .join('\n') || '- None';
  const evidence = report.evidence
    .map((item) => `### ${item.id}\n\nFile: \`${item.file}\`\n\nKind: ${item.kind}\n\nConfidence: ${item.confidence}\n\n\`\`\`text\n${item.snippet}\n\`\`\``)
    .join('\n\n');

  return `# Impact Trace Report

Report ID: ${report.id}

Index run: ${report.indexRunId}

## Changed Files

${report.changedFiles.map((file) => `- ${file}`).join('\n')}

## Affected Files

${affected}

## Test Commands

${tests}

## Evidence

${evidence}
`;
}

function entityForPath(relativePath: string): EntityRef {
  const languageId = languageIdForPath(relativePath);
  return {
    id: `file:${relativePath}`,
    kind: isTestPath(relativePath) ? 'test' : relativePath.toLowerCase().endsWith('.md') ? 'doc' : 'file',
    path: relativePath,
    displayName: relativePath,
    ...(languageId ? { languageId } : {})
  };
}

function languageIdForPath(relativePath: string): string | undefined {
  const ext = path.posix.extname(relativePath).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.md') return 'markdown';
  if (ext === '.py') return 'python';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rust';
  if (ext === '.java') return 'java';
  if (ext === '.kt' || ext === '.kts') return 'kotlin';
  if (ext === '.cs') return 'csharp';
  if (ext === '.c' || ext === '.h') return 'c';
  if (ext === '.cpp' || ext === '.cc' || ext === '.cxx' || ext === '.hpp' || ext === '.hh' || ext === '.hxx') return 'cpp';
  return undefined;
}

function isTestPath(relativePath: string): boolean {
  return /(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\.[cm]?[tj]sx?$/.test(relativePath);
}

function shellQuote(value: string): string {
  const displayValue = value
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  if (/^[A-Za-z0-9_./:-]+$/.test(displayValue) && !displayValue.startsWith('-')) return displayValue;
  return `'${displayValue.replace(/'/g, `'\\''`)}'`;
}
