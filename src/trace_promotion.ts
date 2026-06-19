// Trace-driven confidence promotion: observed runtime edges are ground truth
// that a relation is real, so a matching heuristic/inferred relation is upgraded
// to `proven`. This reinforces the confidence-first model — runtime evidence
// only ever raises confidence, never lowers it. Ingestion is a write surface,
// kept off the read-only MCP and exposed via the CLI (invariant I-8).

import { createHash } from 'node:crypto';

import { ensureRepo, latestCompletedIndexRun, openDatabase } from './store.js';
import { normalizeRepoRoot } from './security.js';

export type ObservedEdge = { source: string; target: string };

export type TraceIngestSummary = {
  // Relations upgraded from heuristic/inferred to proven.
  promoted: number;
  // Matched relations that were already proven (no change).
  alreadyProven: number;
  // Observed edges with no matching relation in the current index.
  unmatched: ObservedEdge[];
};

export function parseTraceInput(raw: unknown): ObservedEdge[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { edges?: unknown }).edges)
    ? (raw as { edges: unknown[] }).edges
    : null;
  if (!list) {
    throw new Error(
      'invalid trace payload: expected an array of {source, target} edges or { edges: [...] }'
    );
  }
  return list.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`invalid trace edge at index ${index}: expected an object with source and target`);
    }
    const { source, target } = entry as { source?: unknown; target?: unknown };
    if (typeof source !== 'string' || source.length === 0) {
      throw new Error(`invalid trace edge at index ${index}: source must be a non-empty string`);
    }
    if (typeof target !== 'string' || target.length === 0) {
      throw new Error(`invalid trace edge at index ${index}: target must be a non-empty string`);
    }
    return { source, target };
  });
}

export function ingestTraces(repoRoot: string, edges: readonly ObservedEdge[]): TraceIngestSummary {
  const root = normalizeRepoRoot(repoRoot);
  const db = openDatabase(root, {});
  try {
    const repoId = ensureRepo(db, root);
    const indexRunId = latestCompletedIndexRun(db, repoId);

    const selectRelations = db.prepare(
      `SELECT id, kind, confidence, source_entity_id, target_entity_id
       FROM relations
       WHERE repo_id = ? AND index_run_id = ? AND source_entity_id = ? AND target_entity_id = ?`
    );
    const promoteRelation = db.prepare(`UPDATE relations SET confidence = 'proven' WHERE id = ?`);
    const insertEvidence = db.prepare(
      `INSERT OR IGNORE INTO relation_evidence
         (id, relation_id, repo_id, file_path, kind, snippet, confidence, index_run_id,
          start_line, end_line, start_col, end_col)
       VALUES (?, ?, ?, ?, ?, ?, 'proven', ?, NULL, NULL, NULL, NULL)`
    );

    let promoted = 0;
    let alreadyProven = 0;
    const unmatched: ObservedEdge[] = [];

    for (const edge of edges) {
      const rows = selectRelations.all(
        repoId,
        indexRunId,
        `file:${edge.source}`,
        `file:${edge.target}`
      ) as Array<{ id: string; kind: string; confidence: string }>;
      if (rows.length === 0) {
        unmatched.push(edge);
        continue;
      }
      for (const row of rows) {
        if (row.confidence === 'proven') {
          alreadyProven++;
          continue;
        }
        promoteRelation.run(row.id);
        const evidenceId = createHash('sha1').update(`${row.id}:trace`).digest('hex').slice(0, 16);
        insertEvidence.run(
          evidenceId,
          row.id,
          repoId,
          edge.source,
          row.kind,
          `confirmed by runtime trace: ${edge.source} -> ${edge.target}`,
          indexRunId
        );
        promoted++;
      }
    }
    return { promoted, alreadyProven, unmatched };
  } finally {
    db.close();
  }
}
