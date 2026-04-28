import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ensureRepo, latestCompletedIndexRun, openDatabase } from './store.js';
import { redactSecrets, resolveInsideRoot, toRelativePath } from './security.js';
import type { AnalyzeOptions, Confidence, Evidence, ImpactReport } from './types.js';

export async function analyzeDiff(options: AnalyzeOptions): Promise<ImpactReport> {
  const repoRoot = path.resolve(options.repoRoot);
  const db = openDatabase(repoRoot);
  const repoId = ensureRepo(db, repoRoot);
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
  const testCommands = affectedFiles
    .filter((file) => /(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\.[cm]?[tj]sx?$/.test(file.path))
    .map((file) => `npm test -- ${file.path}`);
  const id = createHash('sha1').update(`${indexRunId}:${changedFiles.join(',')}`).digest('hex').slice(0, 12);
  const report: ImpactReport = {
    id,
    indexRunId,
    changedFiles,
    affectedFiles,
    testCommands,
    evidence: dedupeEvidence(evidence)
  };

  if (options.writeReport) {
    const reportDir = path.join(repoRoot, '.impact-trace', 'reports');
    mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join('.impact-trace', 'reports', `${id}.md`);
    writeFileSync(path.join(repoRoot, reportPath), renderMarkdown(report), 'utf8');
    report.reportPath = reportPath.split(path.sep).join('/');
  }

  db.prepare('INSERT OR REPLACE INTO reports (id, repo_id, index_run_id, json, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
    .run(report.id, repoId, indexRunId, JSON.stringify(report));
  db.close();

  return report;
}

function makeEvidence(repoRoot: string, relativePath: string, kind: string, confidence: Evidence['confidence']): Evidence {
  const absolutePath = resolveInsideRoot(repoRoot, relativePath);
  const content = readFileSync(absolutePath, 'utf8');
  return {
    id: createHash('sha1').update(`${kind}:${relativePath}`).digest('hex').slice(0, 16),
    file: relativePath,
    kind,
    snippet: redactSecrets(content.slice(0, 500)),
    confidence
  };
}

function dedupeEvidence(evidence: Evidence[]): Evidence[] {
  return [...new Map(evidence.map((item) => [item.id, item])).values()].sort((a, b) => a.file.localeCompare(b.file));
}

function renderMarkdown(report: ImpactReport): string {
  const affected = report.affectedFiles.map((file) => `- ${file.path} - ${file.reason} (${file.confidence})`).join('\n') || '- None';
  const tests = report.testCommands.map((command) => `- \`${command}\``).join('\n') || '- None';
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
