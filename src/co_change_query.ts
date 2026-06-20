// Read-only view over the git co-change coupling the indexer materializes as
// CO_CHANGES relations. The indexer encodes count + score in each relation's
// provenance (`co-change:<count>:<score>`); this module reads them back for a
// given file, ranked by coupling strength, and exposes partners as navigable
// entity resources — the agent-facing surface for couplings the static graph
// structurally misses (config<->code, test<->impl).

import { getRepoId, latestCompletedIndexRun, openDatabase } from './store.js';
import { normalizeRepoRoot } from './security.js';

export type CoChangePartner = {
  path: string;
  coChangeCount: number;
  couplingScore: number;
  confidence: string;
};

export type CoChangeQueryResult = {
  file: string;
  indexRunId: number;
  partners: CoChangePartner[];
  // Partner entity ids, navigable via the `parallax://entities/{id}` template.
  resources: { entities: string[] };
};

export type CoChangeQueryOptions = {
  // Cap on partners returned, ranked by coupling strength.
  limit?: number;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const FILE_PREFIX = 'file:';

// Matches the provenance the indexer writes: `co-change:<count>:<score>`.
const PROVENANCE = /^co-change:(\d+):(\d+(?:\.\d+)?)$/;

function parseCoChangeProvenance(
  provenance: string
): { coChangeCount: number; couplingScore: number } | null {
  const match = PROVENANCE.exec(provenance);
  if (!match) return null;
  return { coChangeCount: Number(match[1]), couplingScore: Number(match[2]) };
}

export function queryCoChanges(
  repoRoot: string,
  file: string,
  options: CoChangeQueryOptions = {}
): CoChangeQueryResult {
  const target = file.startsWith(FILE_PREFIX) ? file.slice(FILE_PREFIX.length) : file;
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const root = normalizeRepoRoot(repoRoot);
  const db = openDatabase(root, { readOnly: true });
  try {
    const repoId = getRepoId(db, root);
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const rows = db
      .prepare(
        `SELECT tgt.path AS path, r.provenance AS provenance, r.confidence AS confidence
         FROM relations r
         JOIN entities src ON src.id = r.source_entity_id
         JOIN entities tgt ON tgt.id = r.target_entity_id
         WHERE r.repo_id = ? AND r.index_run_id = ? AND r.kind = 'CO_CHANGES' AND src.path = ?`
      )
      .all(repoId, indexRunId, target) as Array<{
      path: string;
      provenance: string;
      confidence: string;
    }>;

    const partners: CoChangePartner[] = [];
    for (const row of rows) {
      const parsed = parseCoChangeProvenance(row.provenance);
      if (!parsed) continue;
      partners.push({
        path: row.path,
        coChangeCount: parsed.coChangeCount,
        couplingScore: parsed.couplingScore,
        confidence: row.confidence
      });
    }
    // Strongest coupling first; ties broken deterministically by count then path.
    partners.sort(
      (a, b) =>
        b.couplingScore - a.couplingScore ||
        b.coChangeCount - a.coChangeCount ||
        a.path.localeCompare(b.path)
    );
    const limited = partners.slice(0, limit);
    return {
      file: target,
      indexRunId,
      partners: limited,
      resources: { entities: limited.map((partner) => `${FILE_PREFIX}${partner.path}`) }
    };
  } finally {
    db.close();
  }
}
