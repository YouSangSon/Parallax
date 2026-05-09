import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createBranch, mergeBranches, recallOnRepo, rememberOnRepo, trace } from './agent_memory.js';
import type { RememberValue } from './agent_memory.js';
import { abandonBranch, gcBranches, restoreBranch } from './branch_gc.js';
import { reflectFacts, repairReflections } from './reflection.js';
import { profileEntity } from './profile.js';
import { normalizeRepoRoot } from './security.js';
import { getRepoId, latestCompletedIndexRun, openDatabase } from './store.js';
import type { GraphExportFormat } from './types.js';

export type McpContext = {
  repoRoot: string;
};

export function createMcpServer(context: McpContext): McpServer {
  const server = new McpServer({
    name: 'impact-trace',
    version: '0.1.0'
  });

  server.registerTool(
    'impact_trace_analyze_diff',
    {
      title: 'Analyze Impact Trace diff',
      description: 'Analyze changed files against the latest completed Impact Trace index.',
      inputSchema: {
        changedFiles: z.array(z.string()).min(1),
        maxDepth: z.number().int().min(1).max(8).optional(),
        maxFanout: z.number().int().min(1).max(2_000).optional()
      },
      annotations: {
        title: 'Analyze Impact Trace diff',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ changedFiles, maxDepth, maxFanout }) => {
      const { analyzeDiff } = await import('./analyzer.js');
      const report = await analyzeDiff({
        repoRoot: context.repoRoot,
        changedFiles,
        persistReport: false,
        readOnly: true,
        ...(maxDepth === undefined ? {} : { maxDepth }),
        ...(maxFanout === undefined ? {} : { maxFanout })
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(report)
          }
        ]
      };
    }
  );

  server.registerTool(
    'impact_trace_remember',
    {
      title: 'Remember a fact',
      description:
        'Persist an agent observation as a content-addressable fact on the given branch (default main).',
      inputSchema: {
        entity: z.string().min(1),
        attribute: z.string().min(1),
        value: z.unknown(),
        evidenceFactIds: z.array(z.string()).optional(),
        branch: z.string().optional(),
        agent: z.string().optional(),
        op: z.enum(['assert', 'retract']).optional()
      },
      annotations: {
        title: 'Remember a fact',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ entity, attribute, value, evidenceFactIds, branch, agent, op }) => {
      const result = await rememberOnRepo(context.repoRoot, {
        entity,
        attribute,
        value: value as RememberValue,
        ...(evidenceFactIds !== undefined ? { evidenceFactIds } : {}),
        ...(branch !== undefined ? { branch } : {}),
        ...(agent !== undefined ? { agent } : {}),
        ...(op !== undefined ? { op } : {})
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    'impact_trace_recall',
    {
      title: 'Recall facts',
      description:
        'Query facts by entity, attribute, and branch. Phase 1 returns structured filter results only.',
      inputSchema: {
        query: z.string().optional(),
        entity: z.string().optional(),
        attribute: z.string().optional(),
        branch: z.string().optional(),
        k: z.number().int().min(1).max(100).optional(),
        asOfTx: z.string().optional(),
        currentOnly: z.boolean().optional(),
        semantic: z.boolean().optional()
      },
      annotations: {
        title: 'Recall facts',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ query, entity, attribute, branch, k, asOfTx, currentOnly, semantic }) => {
      const result = await recallOnRepo(context.repoRoot, {
        ...(query !== undefined ? { query } : {}),
        ...(entity !== undefined ? { entity } : {}),
        ...(attribute !== undefined ? { attribute } : {}),
        ...(branch !== undefined ? { branch } : {}),
        ...(k !== undefined ? { k } : {}),
        ...(asOfTx !== undefined ? { asOfTx } : {}),
        ...(currentOnly !== undefined ? { currentOnly } : {}),
        ...(semantic !== undefined ? { semantic } : {})
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    'impact_trace_branch',
    {
      title: 'Create a branch',
      description: 'Create a new branch forking from an existing branch (default main). No data copied.',
      inputSchema: {
        name: z.string().min(1),
        from: z.string().optional()
      },
      annotations: {
        title: 'Create a branch',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ name, from }) => {
      const result = withWritableDb(context, (db) =>
        createBranch(db, {
          name,
          ...(from !== undefined ? { from } : {})
        })
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    'impact_trace_merge',
    {
      title: 'Merge a branch into another',
      description:
        'Create a merge transaction on the target branch with both branch heads as parents. No fact copy needed (content-addressable); recall on target now walks both DAGs.',
      inputSchema: {
        target: z.string().min(1),
        source: z.string().min(1),
        agent: z.string().optional()
      },
      annotations: {
        title: 'Merge a branch into another',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ target, source, agent }) => {
      const result = withWritableDb(context, (db) =>
        mergeBranches(db, {
          target,
          source,
          ...(agent !== undefined ? { agent } : {})
        })
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    'impact_trace_reflect',
    {
      title: 'Reflect facts into a summary',
      description:
        'Group older facts on a branch by entity and ask the configured LLM to summarize each group. Original facts are preserved; a new summary fact is added with provenance edges marked kind=summary.',
      inputSchema: {
        branch: z.string().optional(),
        olderThanDays: z.number().int().min(1).max(3_650).optional(),
        entity: z.string().optional(),
        agent: z.string().optional(),
        dryRun: z.boolean().optional()
      },
      annotations: {
        title: 'Reflect facts into a summary',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ branch, olderThanDays, entity, agent, dryRun }) => {
      const result = await reflectFacts(context.repoRoot, {
        ...(branch !== undefined ? { branch } : {}),
        ...(olderThanDays !== undefined ? { olderThanDays } : {}),
        ...(entity !== undefined ? { entity } : {}),
        ...(agent !== undefined ? { agent } : {}),
        ...(dryRun !== undefined ? { dryRun } : {})
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    'impact_trace_abandon_branch',
    {
      title: 'Abandon a branch',
      description:
        'Mark a branch as abandoned. Subsequent gc-branches passes will archive its transactions. The main branch cannot be abandoned.',
      inputSchema: {
        name: z.string().min(1)
      },
      annotations: {
        title: 'Abandon a branch',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ name }) => {
      const result = withWritableDb(context, (db) => abandonBranch(db, { name }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    'impact_trace_gc_branches',
    {
      title: 'GC abandoned branches',
      description:
        'Archive transactions of all abandoned branches so recall and recallSemantic stop surfacing their facts. Facts themselves are never deleted (content-addressable). dryRun reports without writing. When maxAgeDays is set, the pass first auto-abandons every active non-main branch with no activity newer than now − maxAgeDays days (Phase 4 P4 / ADR D-017).',
      inputSchema: {
        dryRun: z.boolean().optional(),
        maxAgeDays: z.number().int().min(0).optional()
      },
      annotations: {
        title: 'GC abandoned branches',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ dryRun, maxAgeDays }) => {
      const result = withWritableDb(context, (db) =>
        gcBranches(db, {
          ...(dryRun !== undefined ? { dryRun } : {}),
          ...(maxAgeDays !== undefined ? { maxAgeDays } : {})
        })
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    'impact_trace_profile',
    {
      title: 'Profile an entity',
      description:
        'Aggregate facts about an entity into a three-bucket profile (staticFacts from indexer code relations, dynamicFacts from agent activity, summaryFacts from Phase 3 reflective consolidation). Branch-scoped (default main); archived transactions excluded. Use as an agent prompt-context primer to inject "what does the system know about X" in one call.',
      inputSchema: {
        entity: z.string().min(1),
        branch: z.string().optional(),
        k: z.number().int().min(1).max(200).optional(),
        asOfTx: z.string().optional()
      },
      annotations: {
        title: 'Profile an entity',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ entity, branch, k, asOfTx }) => {
      const result = await profileEntity(context.repoRoot, {
        entity,
        ...(branch !== undefined ? { branch } : {}),
        ...(k !== undefined ? { k } : {}),
        ...(asOfTx !== undefined ? { asOfTx } : {})
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    'impact_trace_repair_reflections',
    {
      title: 'Repair orphan reflection facts',
      description:
        'Sweep reflection facts on a branch and restore the provenance kind=summary edges and reflections audit row for any that lost them mid-write. Idempotent. dryRun reports orphans without writing.',
      inputSchema: {
        branch: z.string().optional(),
        dryRun: z.boolean().optional()
      },
      annotations: {
        title: 'Repair orphan reflection facts',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ branch, dryRun }) => {
      const result = await repairReflections(context.repoRoot, {
        ...(branch !== undefined ? { branch } : {}),
        ...(dryRun !== undefined ? { dryRun } : {})
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    'impact_trace_restore_branch',
    {
      title: 'Restore an abandoned branch',
      description:
        'Move an abandoned branch back to active state and un-archive its transactions so recall surfaces its facts again. Idempotent on already-active branches.',
      inputSchema: {
        name: z.string().min(1)
      },
      annotations: {
        title: 'Restore an abandoned branch',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ name }) => {
      const result = withWritableDb(context, (db) => restoreBranch(db, { name }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    'impact_trace_trace',
    {
      title: 'Trace causal chain',
      description: 'Walk fact_provenance edges from the given fact back through its evidence chain.',
      inputSchema: {
        factId: z.string().min(1),
        depth: z.number().int().min(1).max(20).optional()
      },
      annotations: {
        title: 'Trace causal chain',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ factId, depth }) => {
      const result = withReadOnlyDb(context, (db) =>
        trace(db, {
          factId,
          ...(depth !== undefined ? { depth } : {})
        })
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.registerResource(
    'impact_trace_reports',
    new ResourceTemplate('impact-trace://reports/{reportId}', {
      list: () => ({ resources: listReportResources(context) })
    }),
    {
      title: 'Impact Trace Reports',
      description: 'Persisted Impact Trace report JSON documents.',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const reportId = String(variables.reportId);
      return jsonResource(uri.toString(), readReport(context, reportId));
    }
  );

  server.registerResource(
    'impact_trace_entities',
    new ResourceTemplate('impact-trace://entities/{entityId}', {
      list: () => ({ resources: listEntityResources(context) })
    }),
    {
      title: 'Impact Trace Entities',
      description: 'Canonical indexed entities from the latest completed index run.',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const entityId = decodeURIComponent(String(variables.entityId));
      return jsonResource(uri.toString(), readEntity(context, entityId));
    }
  );

  server.registerResource(
    'impact_trace_graphs',
    new ResourceTemplate('impact-trace://reports/{reportId}/graph/{format}', {
      list: () => ({ resources: listGraphResources(context) })
    }),
    {
      title: 'Impact Trace Graphs',
      description: 'Report-scoped relationship graph projections in Mermaid, JSON, or DOT.',
      mimeType: 'text/plain'
    },
    async (uri, variables) => {
      const reportId = String(variables.reportId);
      const format = parseGraphFormat(String(variables.format));
      const { exportImpactGraph } = await import('./graph.js');
      const graph = await exportImpactGraph({
        repoRoot: context.repoRoot,
        reportId,
        format
      });
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: format === 'json' ? 'application/json' : 'text/plain',
            text: graph.rendered
          }
        ]
      };
    }
  );

  server.registerResource(
    'impact_trace_coverage_latest',
    'impact-trace://coverage/latest',
    {
      title: 'Impact Trace Latest Coverage',
      description: 'Index coverage rows for the latest completed index run.',
      mimeType: 'application/json'
    },
    async (uri) => jsonResource(uri.toString(), readLatestCoverage(context))
  );

  return server;
}

export async function serveMcp(context: McpContext): Promise<void> {
  const server = createMcpServer(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function listReportResources(context: McpContext): Array<{ uri: string; name: string; mimeType: string }> {
  return withReadOnlyDb(context, (db, repoId) => {
    const rows = db
      .prepare('SELECT id FROM reports WHERE repo_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(repoId) as Array<{ id: string }>;
    return rows.map((row) => ({
      uri: `impact-trace://reports/${row.id}`,
      name: `Impact report ${row.id}`,
      mimeType: 'application/json'
    }));
  });
}

function listEntityResources(context: McpContext): Array<{ uri: string; name: string; mimeType: string }> {
  return withReadOnlyDb(context, (db, repoId) => {
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const rows = db
      .prepare(`
        SELECT id, display_name
        FROM entities
        WHERE repo_id = ? AND updated_index_run_id = ?
        ORDER BY display_name
        LIMIT 50
      `)
      .all(repoId, indexRunId) as Array<{ id: string; display_name: string }>;
    return rows.map((row) => ({
      uri: `impact-trace://entities/${encodeURIComponent(row.id)}`,
      name: row.display_name,
      mimeType: 'application/json'
    }));
  });
}

function listGraphResources(context: McpContext): Array<{ uri: string; name: string; mimeType: string }> {
  return withReadOnlyDb(context, (db, repoId) => {
    const rows = db
      .prepare('SELECT id FROM reports WHERE repo_id = ? ORDER BY created_at DESC LIMIT 10')
      .all(repoId) as Array<{ id: string }>;
    return rows.flatMap((row) => (['mermaid', 'json', 'dot'] as const).map((format) => ({
      uri: `impact-trace://reports/${row.id}/graph/${format}`,
      name: `Impact report ${row.id} graph (${format})`,
      mimeType: format === 'json' ? 'application/json' : 'text/plain'
    })));
  });
}

function readReport(context: McpContext, reportId: string): unknown {
  return withReadOnlyDb(context, (db, repoId) => {
    const row = db.prepare('SELECT json FROM reports WHERE repo_id = ? AND id = ?').get(repoId, reportId) as { json: string } | undefined;
    if (!row) throw new Error(`impact report not found: ${reportId}`);
    return JSON.parse(row.json) as unknown;
  });
}

function readEntity(context: McpContext, entityId: string): unknown {
  return withReadOnlyDb(context, (db, repoId) => {
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const relationLimit = 100;
    const entity = db
      .prepare('SELECT * FROM entities WHERE repo_id = ? AND id = ? AND updated_index_run_id = ?')
      .get(repoId, entityId, indexRunId) as Record<string, unknown> | undefined;
    if (!entity) throw new Error(`impact entity not found: ${entityId}`);
    const outgoing = db
      .prepare('SELECT id, target_entity_id, kind, confidence, provenance FROM relations WHERE repo_id = ? AND source_entity_id = ? AND index_run_id = ? ORDER BY kind, target_entity_id LIMIT ?')
      .all(repoId, entityId, indexRunId, relationLimit + 1);
    const incoming = db
      .prepare('SELECT id, source_entity_id, kind, confidence, provenance FROM relations WHERE repo_id = ? AND target_entity_id = ? AND index_run_id = ? ORDER BY kind, source_entity_id LIMIT ?')
      .all(repoId, entityId, indexRunId, relationLimit + 1);
    return {
      entity,
      outgoing: outgoing.slice(0, relationLimit),
      incoming: incoming.slice(0, relationLimit),
      limits: {
        relations: relationLimit,
        outgoingTruncated: outgoing.length > relationLimit,
        incomingTruncated: incoming.length > relationLimit
      }
    };
  });
}

function readLatestCoverage(context: McpContext): unknown {
  return withReadOnlyDb(context, (db, repoId) => {
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const coverageLimit = 500;
    const coverage = db
      .prepare('SELECT path, language_id, status, reason FROM index_coverage WHERE index_run_id = ? ORDER BY path LIMIT ?')
      .all(indexRunId, coverageLimit + 1);
    return {
      indexRunId,
      coverage: coverage.slice(0, coverageLimit),
      limit: coverageLimit,
      truncated: coverage.length > coverageLimit
    };
  });
}

function withReadOnlyDb<T>(context: McpContext, callback: (db: ReturnType<typeof openDatabase>, repoId: number) => T): T {
  const repoRoot = normalizeRepoRoot(context.repoRoot);
  const db = openDatabase(repoRoot, { readOnly: true });
  try {
    const repoId = getRepoId(db, repoRoot);
    return callback(db, repoId);
  } finally {
    db.close();
  }
}

function withWritableDb<T>(context: McpContext, callback: (db: ReturnType<typeof openDatabase>, repoId: number) => T): T {
  const repoRoot = normalizeRepoRoot(context.repoRoot);
  const db = openDatabase(repoRoot, { readOnly: false });
  try {
    const repoId = getRepoId(db, repoRoot);
    return callback(db, repoId);
  } finally {
    db.close();
  }
}

function jsonResource(uri: string, value: unknown): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function parseGraphFormat(value: string): GraphExportFormat {
  if (value === 'json' || value === 'mermaid' || value === 'dot') return value;
  throw new Error('graph resource format must be mermaid, json, or dot');
}
