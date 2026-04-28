import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ensureRepo, getRepoId, latestCompletedIndexRun, openDatabase } from './store.js';
import { normalizeRepoRoot, redactSecrets, resolveInsideRoot, toRelativePath } from './security.js';
import type { AnalyzeOptions, Confidence, EntityRef, Evidence, ImpactAction, ImpactReport, ImpactTarget } from './types.js';

export async function analyzeDiff(options: AnalyzeOptions): Promise<ImpactReport> {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const db = openDatabase(repoRoot, options.readOnly ? { readOnly: true } : {});
  const repoId = options.readOnly ? getRepoId(db, repoRoot) : ensureRepo(db, repoRoot);
  const indexRunId = latestCompletedIndexRun(db, repoId);
  const changedFiles = options.changedFiles.map((file) => {
    const resolved = resolveInsideRoot(repoRoot, file);
    return toRelativePath(repoRoot, resolved);
  }).sort();

  const affected = new Map<string, { path: string; reason: string; confidence: Confidence }>();
  const evidence: Evidence[] = [];

  for (const changedFile of changedFiles) {
    const changedFileRow = db
      .prepare('SELECT id FROM files WHERE repo_id = ? AND path = ? AND index_run_id = ?')
      .get(repoId, changedFile, indexRunId) as { id: number } | undefined;
    if (!changedFileRow) {
      affected.set(changedFile, { path: changedFile, reason: 'changed file not in index', confidence: 'unknown' });
      continue;
    }

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
      .all(repoId, changedFile, indexRunId) as Array<{
        source_path: string;
        kind: string;
        confidence: 'proven' | 'inferred' | 'heuristic';
        provenance: string;
      }>;

    for (const row of rows) {
      const reason = row.kind === 'IMPORTS'
        ? `imports ${changedFile}`
        : row.kind === 'TESTS'
          ? `tests ${changedFile}`
          : row.kind === 'DOCUMENTS'
            ? `documents ${changedFile}`
            : `${row.kind.toLowerCase()} ${changedFile}`;
      affected.set(row.source_path, { path: row.source_path, reason, confidence: row.confidence });
      evidence.push(makeEvidence(repoRoot, row.source_path, row.kind, row.confidence));
    }

    evidence.push(makeEvidence(repoRoot, changedFile, 'changed-file', 'proven'));
  }

  const affectedFiles = [...affected.values()].sort((a, b) => a.path.localeCompare(b.path));
  const changed = changedFiles.map((file) => entityForPath(file));
  const affectedTargets: ImpactTarget[] = affectedFiles.map((file) => ({
    target: entityForPath(file.path),
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
