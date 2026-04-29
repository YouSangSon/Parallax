import { computeEmbedding } from './embeddings.js';
import type { EmbeddingResult } from './embeddings.js';
import { remember, withAgentMemoryDb } from './agent_memory.js';
import { summarize } from './llm.js';
import type { ReflectionResult } from './llm.js';
import { redactSecrets } from './security.js';
import { contentHash } from './store.js';
import type { Db } from './store.js';

export interface ReflectOptions {
  branch?: string;
  olderThanDays?: number;
  entity?: string;
  agent?: string;
  dryRun?: boolean;
}

export interface ReflectedEntity {
  entity: string;
  summaryFactId: string;
  sourceCount: number;
}

export interface ReflectResult {
  branch: string;
  model: string;
  summarized: number;
  skippedEntities: number;
  reflections: ReflectedEntity[];
}

const DEFAULT_OLDER_THAN_DAYS = 30;
const REFLECTION_ATTRIBUTE = 'reflection';
const MIN_FACTS_PER_ENTITY = 2;
const SYSTEM_PROMPT =
  'You summarize an entity\'s observed history into one or two sentences.\n' +
  'Describe only what was observed across the bullet list. Do not invent details.\n' +
  'If observations contradict each other, mention the contradiction.';

interface FactRow {
  id: string;
  entity_id: string;
  attribute: string;
  value_blob: string;
  ts: string;
}

interface BranchRow {
  id: string;
  name: string;
}

/**
 * Reflective consolidation pass. Reads facts older than the cutoff on a
 * branch, groups them by entity, asks the configured LLM to summarize
 * each group with at least MIN_FACTS_PER_ENTITY facts, then writes one
 * summary fact per group whose fact_provenance edges back to the
 * sources are marked kind='summary'. The original facts are preserved
 * (decision D3 = preserve). A reflections audit row records each pass.
 *
 * LLM I/O happens entirely outside the SQLite transaction, mirroring
 * rememberOnRepo / reembedFacts. Redaction is enforced at three points:
 *   1. Source facts with redacted=1 are excluded at SELECT time.
 *   2. summarize() runs redactSecrets on both prompts and on the output.
 *   3. The summary is redacted again before being written as a fact.
 */
export async function reflectFacts(
  repoRoot: string,
  options: ReflectOptions = {}
): Promise<ReflectResult> {
  const branchName = options.branch ?? 'main';
  const olderThanDays = options.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS;
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();

  const collected = withAgentMemoryDb(repoRoot, true, (db) => {
    const branch = db
      .prepare('SELECT id, name FROM branches WHERE name = ?')
      .get(branchName) as BranchRow | undefined;
    if (!branch) {
      throw new Error(`branch not found: ${branchName}`);
    }
    return collectCandidates(db, branch.id, cutoff, options.entity);
  });

  if (collected.size === 0) {
    return { branch: branchName, model: 'none', summarized: 0, skippedEntities: 0, reflections: [] };
  }

  let skippedEntities = 0;
  const drafts: ReflectionDraft[] = [];
  for (const [entity, facts] of collected) {
    if (facts.length < MIN_FACTS_PER_ENTITY) {
      skippedEntities += 1;
      continue;
    }
    const userPrompt = renderUserPrompt(entity, facts);
    let summaryResult: ReflectionResult;
    try {
      summaryResult = await summarize({ systemPrompt: SYSTEM_PROMPT, userPrompt });
    } catch (error: unknown) {
      throw new Error(
        `summarize failed for ${entity}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const safeSummary = redactSecrets(summaryResult.summary).trim();
    if (!safeSummary) {
      skippedEntities += 1;
      continue;
    }
    let embedding: EmbeddingResult | null = null;
    if (!options.dryRun) {
      try {
        embedding = await computeEmbedding(
          `${entity}|${REFLECTION_ATTRIBUTE}|${JSON.stringify(safeSummary)}`
        );
      } catch (error: unknown) {
        throw new Error(
          `embedding failed for ${entity}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    drafts.push({
      entity,
      sourceFactIds: facts.map((row) => row.id),
      summary: safeSummary,
      model: summaryResult.model,
      embedding
    });
  }

  if (drafts.length === 0) {
    return {
      branch: branchName,
      model: 'none',
      summarized: 0,
      skippedEntities,
      reflections: []
    };
  }

  if (options.dryRun) {
    return {
      branch: branchName,
      model: drafts[0]?.model ?? 'none',
      summarized: drafts.length,
      skippedEntities,
      reflections: drafts.map((draft) => ({
        entity: draft.entity,
        summaryFactId: '<dry-run>',
        sourceCount: draft.sourceFactIds.length
      }))
    };
  }

  const written = withAgentMemoryDb(repoRoot, false, (db) =>
    persistReflections(db, branchName, drafts, options.agent, olderThanDays)
  );

  return {
    branch: branchName,
    model: drafts[0]?.model ?? 'unknown',
    summarized: written.length,
    skippedEntities,
    reflections: written
  };
}

function collectCandidates(
  db: Db,
  branchId: string,
  cutoff: string,
  entityFilter?: string
): Map<string, FactRow[]> {
  const conditions = [
    't.branch_id = ?',
    't.archived = 0',
    't.ts < ?',
    'f.redacted = 0',
    "f.op = 'assert'",
    'f.attribute != ?'
  ];
  const params: Array<string | number> = [branchId, cutoff, REFLECTION_ATTRIBUTE];
  if (entityFilter) {
    conditions.push('f.entity_id = ?');
    params.push(entityFilter);
  }
  const sql = `
    SELECT f.id, f.entity_id, f.attribute, f.value_blob, t.ts
    FROM facts f
    INNER JOIN transactions t ON f.tx_id = t.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY f.entity_id, t.ts ASC
  `;
  const rows = db.prepare(sql).all(...params) as unknown as FactRow[];
  const grouped = new Map<string, FactRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.entity_id);
    if (list) {
      list.push(row);
    } else {
      grouped.set(row.entity_id, [row]);
    }
  }
  return grouped;
}

function renderUserPrompt(entity: string, facts: FactRow[]): string {
  const lines = facts.map((row) => {
    const compactValue = redactSecrets(row.value_blob, 200);
    return `- [${row.ts}] ${row.attribute}: ${compactValue}`;
  });
  return `Entity: ${entity}\nObservations:\n${lines.join('\n')}`;
}

interface ReflectionDraft {
  entity: string;
  sourceFactIds: string[];
  summary: string;
  model: string;
  embedding: EmbeddingResult | null;
}

function persistReflections(
  db: Db,
  branchName: string,
  drafts: ReflectionDraft[],
  agentOverride: string | undefined,
  olderThanDays: number
): ReflectedEntity[] {
  const branch = db
    .prepare('SELECT id, name FROM branches WHERE name = ?')
    .get(branchName) as BranchRow | undefined;
  if (!branch) {
    throw new Error(`branch not found: ${branchName}`);
  }

  const reflectionInsert = db.prepare(
    `INSERT OR IGNORE INTO reflections
       (id, branch_id, model, summary_fact_id, source_fact_count, criteria_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  const provenanceMark = db.prepare(
    "UPDATE fact_provenance SET kind = 'summary' WHERE fact_id = ? AND source_fact_id = ?"
  );
  const savepointStart = db.prepare("SAVEPOINT reflection_mark");
  const savepointRelease = db.prepare("RELEASE reflection_mark");
  const savepointRollback = db.prepare("ROLLBACK TO reflection_mark");

  // Per-draft atomicity: remember() runs its own BEGIN/COMMIT internally
  // (autocommit returns control here). After it commits, we open a
  // SAVEPOINT for the provenance UPDATE + reflections audit INSERT so a
  // crash mid-way rolls those back together. The summary fact stays
  // (remember already committed it); orphan summary facts are detectable
  // by lacking a matching reflections row and can be repaired by a
  // follow-up reflect --repair pass (out of scope here). The async-
  // outside-tx invariant is preserved because all embeddings were
  // pre-computed before reaching this function.
  const written: ReflectedEntity[] = [];
  for (const draft of drafts) {
    const remembered = remember(
      db,
      {
        entity: draft.entity,
        attribute: REFLECTION_ATTRIBUTE,
        value: draft.summary,
        evidenceFactIds: draft.sourceFactIds,
        branch: branchName,
        agent: agentOverride ?? `reflect:${draft.model}`
      },
      draft.embedding
    );

    savepointStart.run();
    try {
      for (const sourceFactId of draft.sourceFactIds) {
        provenanceMark.run(remembered.factId, sourceFactId);
      }
      const reflectionId = contentHash(
        'reflection',
        remembered.factId,
        draft.model,
        String(draft.sourceFactIds.length)
      );
      reflectionInsert.run(
        reflectionId,
        branch.id,
        draft.model,
        remembered.factId,
        draft.sourceFactIds.length,
        JSON.stringify({ olderThanDays, entity: draft.entity })
      );
      savepointRelease.run();
    } catch (error: unknown) {
      savepointRollback.run();
      savepointRelease.run();
      throw error;
    }

    written.push({
      entity: draft.entity,
      summaryFactId: remembered.factId,
      sourceCount: draft.sourceFactIds.length
    });
  }
  return written;
}
