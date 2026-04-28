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
  depth: number;
  relationPath: string[];
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

type IndexedFileRow = {
  id: number;
  content_hash: string;
};

type TraversalNode = {
  entityId: string;
  label: string;
  relationPath: string[];
  trail: string[];
};

export async function analyzeDiff(options: AnalyzeOptions): Promise<ImpactReport> {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const db = openDatabase(repoRoot, options.readOnly ? { readOnly: true } : {});
  const repoId = options.readOnly ? getRepoId(db, repoRoot) : ensureRepo(db, repoRoot);
  const indexRunId = latestCompletedIndexRun(db, repoId);
  const maxDepth = normalizeBoundedInteger(options.maxDepth, 2, 1, 8);
  const maxFanout = normalizeBoundedInteger(options.maxFanout, 200, 1, 2_000);
  const changedFiles = options.changedFiles.map((file) => {
    const resolved = resolveInsideRoot(repoRoot, file);
    return toRelativePath(repoRoot, resolved);
  }).sort();

  const affected = new Map<string, {
    path: string;
    reason: string;
    confidence: Confidence;
    target: EntityRef;
    depth: number;
    relationPath: string[];
  }>();
  const evidence: Evidence[] = [];
  const warnings: string[] = [];

  for (const changedFile of changedFiles) {
    const changedEntityId = `file:${changedFile}`;
    const changedEntityRow = db
      .prepare('SELECT id FROM entities WHERE repo_id = ? AND id = ? AND updated_index_run_id = ?')
      .get(repoId, changedEntityId, indexRunId) as { id: string } | undefined;
    const indexedFileRow = db
      .prepare('SELECT id, content_hash FROM files WHERE repo_id = ? AND path = ? AND index_run_id = ?')
      .get(repoId, changedFile, indexRunId) as IndexedFileRow | undefined;

    if (indexedFileRow) {
      const liveHash = currentFileHash(repoRoot, changedFile);
      if (liveHash && liveHash !== indexedFileRow.content_hash) {
        warnings.push(`stale index: ${changedFile} differs from latest completed index run ${indexRunId}`);
      } else if (!liveHash) {
        warnings.push(`stale index: ${changedFile} is indexed but cannot be read from the working tree`);
      }
    }

    if (!changedEntityRow && !indexedFileRow) {
      affected.set(changedFile, {
        path: changedFile,
        reason: 'changed file not in index',
        confidence: 'unknown',
        target: entityForPath(changedFile),
        depth: 0,
        relationPath: []
      });
      warnings.push(`coverage gap: changed file is not present in index run ${indexRunId}: ${changedFile}`);
      continue;
    }

    const impactRows = changedEntityRow
      ? loadCanonicalImpactRows(db, repoId, indexRunId, changedEntityId, changedFile, maxDepth, maxFanout, warnings)
      : [];
    const rows = impactRows.length > 0
      ? impactRows
      : loadLegacyImpactRows(db, repoRoot, repoId, indexRunId, changedFile);

    for (const row of rows) {
      const next = {
        path: row.sourcePath,
        reason: row.reason,
        confidence: row.confidence,
        target: row.sourceEntity,
        depth: row.depth,
        relationPath: row.relationPath
      };
      const current = affected.get(row.sourcePath);
      if (!current || isBetterImpact(next, current)) {
        affected.set(row.sourcePath, next);
      }
      evidence.push(row.evidence);
    }

    evidence.push(makeEvidence(repoRoot, changedFile, 'changed-file', 'proven'));
  }

  const affectedFiles = [...affected.values()].sort((a, b) => a.path.localeCompare(b.path));
  const changed = changedFiles.map((file) => entityForPath(file));
  const affectedTargets: ImpactTarget[] = affectedFiles.map((file) => ({
    target: file.target,
    relations: file.relationPath.length > 0 ? file.relationPath : [file.reason],
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
  const id = createHash('sha1').update(`${indexRunId}:${maxDepth}:${maxFanout}:${changedFiles.join(',')}`).digest('hex').slice(0, 12);
  const report: ImpactReport = {
    id,
    indexRunId,
    changedFiles,
    affectedFiles,
    changed,
    affected: affectedTargets,
    actions,
    testCommands: actions,
    evidence: dedupeEvidence(evidence),
    ...(warnings.length > 0 ? { warnings: [...new Set(warnings)].sort() } : {})
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
  changedFile: string,
  maxDepth: number,
  maxFanout: number,
  warnings: string[]
): ImpactRow[] {
  const out: ImpactRow[] = [];
  const visitedRelations = new Set<string>();
  const bestEntityDepth = new Map<string, number>([[changedEntityId, 0]]);
  let frontier: TraversalNode[] = [{
    entityId: changedEntityId,
    label: changedFile,
    relationPath: [],
    trail: [changedEntityId]
  }];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: TraversalNode[] = [];
    for (const node of frontier) {
      const rows = loadCanonicalReverseRows(db, repoId, indexRunId, node.entityId, maxFanout + 1);
      if (rows.length > maxFanout) {
        warnings.push(`fanout limit: ${node.label} has more than ${maxFanout} inbound relations; analysis truncated at depth ${depth}`);
      }

      for (const row of rows.slice(0, maxFanout)) {
        if (visitedRelations.has(row.relation_id)) continue;
        visitedRelations.add(row.relation_id);
        const confidence = asConfidence(row.relation_confidence);
        const sourceEntity = entityFromCanonicalRow(row);
        const relationKind = row.relation_kind;
        const relationPath = [
          relationStep(sourceEntity, relationKind, node.label),
          ...node.relationPath
        ];
        out.push({
          sourcePath: row.source_path!,
          sourceEntity,
          reason: depth === 1 ? reasonForCanonicalRelation(relationKind, changedFile) : relationPath.join(' -> '),
          relationKind,
          confidence,
          evidence: evidenceFromCanonicalRow(row, sourceEntity, relationKind, confidence),
          depth,
          relationPath
        });

        if (node.trail.includes(row.source_entity_id)) {
          warnings.push(`cycle avoided: ${row.source_display_name} already appears in the traversal path`);
          continue;
        }
        const previousDepth = bestEntityDepth.get(row.source_entity_id);
        if (previousDepth !== undefined && previousDepth <= depth) continue;
        bestEntityDepth.set(row.source_entity_id, depth);
        nextFrontier.push({
          entityId: row.source_entity_id,
          label: sourceEntity.displayName ?? sourceEntity.path ?? sourceEntity.id,
          relationPath,
          trail: [...node.trail, row.source_entity_id]
        });
      }
    }
    frontier = nextFrontier;
  }

  return out;
}

function loadCanonicalReverseRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  targetEntityId: string,
  limit: number
): CanonicalImpactRow[] {
  return db
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
      LIMIT ?
    `)
    .all(repoId, targetEntityId, indexRunId, limit) as CanonicalImpactRow[];
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
      evidence: makeEvidence(repoRoot, row.source_path, row.kind, row.confidence),
      depth: 1,
      relationPath: [reasonForLegacyRelation(row.kind, changedFile)]
    };
  });
}

function relationStep(sourceEntity: EntityRef, relationKind: string, targetLabel: string): string {
  const sourceLabel = sourceEntity.displayName ?? sourceEntity.path ?? sourceEntity.id;
  const verb = relationVerb(relationKind);
  return `${sourceLabel} ${verb} ${targetLabel}`;
}

function relationVerb(kind: string): string {
  if (kind === 'DEPENDS_ON') return 'depends on';
  if (kind === 'VERIFIES') return 'verifies';
  if (kind === 'DOCUMENTS') return 'documents';
  if (kind === 'CONFIGURES') return 'configures';
  if (kind === 'DEPLOYS') return 'deploys';
  if (kind === 'CALLS') return 'calls';
  if (kind === 'REFERENCES') return 'references';
  if (kind === 'CONSUMES') return 'consumes';
  if (kind === 'IMPLEMENTS') return 'implements';
  if (kind === 'PRODUCES') return 'produces';
  return kind.toLowerCase();
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
  if (kind === 'REFERENCES') return `references ${changedFile}`;
  if (kind === 'CALLS') return `calls ${changedFile}`;
  if (kind === 'GOVERNS') return `governs ${changedFile}`;
  if (kind === 'IMPLEMENTS') return `implements ${changedFile}`;
  if (kind === 'CONSUMES') return `consumes ${changedFile}`;
  if (kind === 'PRODUCES') return `produces ${changedFile}`;
  return `${kind.toLowerCase()} ${changedFile}`;
}

function reasonForLegacyRelation(kind: string, changedFile: string): string {
  if (kind === 'IMPORTS') return `imports ${changedFile}`;
  if (kind === 'TESTS') return `tests ${changedFile}`;
  if (kind === 'DOCUMENTS') return `documents ${changedFile}`;
  if (kind === 'REFERENCES') return `references ${changedFile}`;
  if (kind === 'CONFIGURES') return `configures ${changedFile}`;
  if (kind === 'CALLS') return `calls ${changedFile}`;
  if (kind === 'GOVERNS') return `governs ${changedFile}`;
  if (kind === 'IMPLEMENTS') return `implements ${changedFile}`;
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
    'business_plan',
    'requirement',
    'decision',
    'meeting_note',
    'metric',
    'customer_artifact',
    'task',
    'external_entity'
  ].includes(value);
}

function currentFileHash(repoRoot: string, relativePath: string): string | undefined {
  try {
    const absolutePath = resolveInsideRoot(repoRoot, relativePath);
    return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
  } catch {
    return undefined;
  }
}

function normalizeBoundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const normalized = Math.trunc(value);
  if (normalized < min) return min;
  if (normalized > max) return max;
  return normalized;
}

function isBetterImpact(
  next: { confidence: Confidence; depth: number },
  current: { confidence: Confidence; depth: number }
): boolean {
  if (next.depth !== current.depth) return next.depth < current.depth;
  return confidenceRank(next.confidence) > confidenceRank(current.confidence);
}

function confidenceRank(confidence: Confidence): number {
  if (confidence === 'proven') return 3;
  if (confidence === 'inferred') return 2;
  if (confidence === 'heuristic') return 1;
  return 0;
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
  const affected = report.affectedFiles
    .map((file) => `- ${file.path} - ${file.reason} (${file.confidence}${file.depth ? `, depth ${file.depth}` : ''})`)
    .join('\n') || '- None';
  const warnings = report.warnings?.map((warning) => `- ${warning}`).join('\n') ?? '- None';
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

## Warnings

${warnings}

## Evidence

${evidence}
`;
}

function entityForPath(relativePath: string): EntityRef {
  const languageId = languageIdForPath(relativePath);
  return {
    id: `file:${relativePath}`,
    kind: entityKindForPath(relativePath, languageId),
    path: relativePath,
    displayName: relativePath,
    ...(languageId ? { languageId } : {})
  };
}

function entityKindForPath(relativePath: string, languageId: string | undefined): EntityKind {
  if (isTestPath(relativePath)) return 'test';
  if (languageId === 'markdown') return 'doc';
  if (path.posix.basename(relativePath) === 'CODEOWNERS') return 'policy';
  if (languageId === 'yaml' && relativePath.startsWith('.github/workflows/')) return 'workflow';
  if (languageId === 'dockerfile' || languageId === 'terraform') return 'resource';
  if (languageId === 'yaml' || languageId === 'json' || languageId === 'toml' || languageId === 'shell' || languageId === 'makefile') return 'config';
  if (languageId === 'protobuf' || languageId === 'graphql') return 'contract';
  return 'file';
}

function languageIdForPath(relativePath: string): string | undefined {
  const basename = path.posix.basename(relativePath);
  if (basename === 'Dockerfile' || basename === 'Containerfile') return 'dockerfile';
  if (basename === 'Makefile') return 'makefile';
  if (basename === 'CODEOWNERS') return 'policy';
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
  if (ext === '.sh' || ext === '.bash' || ext === '.zsh') return 'shell';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  if (ext === '.json') return 'json';
  if (ext === '.toml') return 'toml';
  if (ext === '.tf') return 'terraform';
  if (ext === '.proto') return 'protobuf';
  if (ext === '.graphql' || ext === '.gql') return 'graphql';
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
