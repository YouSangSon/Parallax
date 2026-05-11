import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createBranch, mergeBranches, recallOnRepo, rememberOnRepo, trace } from './agent_memory.js';
import type { RememberValue } from './agent_memory.js';
import { abandonBranch, gcBranches, restoreBranch } from './branch_gc.js';
import { doctorProject, redactDoctorReportForMcp } from './doctor.js';
import { computeEmbedding, selectedEmbeddingModel } from './embeddings.js';
import type { EmbeddingResult } from './embeddings.js';
import { readGitSnapshot } from './git-snapshot.js';
import { reflectFacts, repairReflections } from './reflection.js';
import { profileEntity } from './profile.js';
import { normalizeRepoRoot, redactSecrets, resolveInsideRoot } from './security.js';
import {
  assertCurrentSchema,
  contentHash,
  getRepoId,
  hasVecTable,
  isVectorExtensionLoaded,
  latestCompletedIndexRun,
  openDatabase,
  vecTableName
} from './store.js';
import type {
  Confidence,
  ContextBudget,
  ContextPack,
  ContextPackEvidence,
  ContextPackItem,
  ContextPackReusePolicy,
  EntityRef,
  Evidence,
  GraphExport,
  GraphExportFormat,
  ImpactAction,
  ImpactReport
} from './types.js';

export type McpContext = {
  repoRoot: string;
};

export function createMcpServer(context: McpContext): McpServer {
  const server = new McpServer({
    name: 'impact-trace',
    version: '0.1.0'
  });
  patchToolErrorFactory(server);

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
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ changedFiles, maxDepth, maxFanout }) => {
      try {
        const { analyzeDiff } = await import('./analyzer.js');
        const report = await analyzeDiff({
          repoRoot: context.repoRoot,
          changedFiles,
          persistReport: false,
          readOnly: true,
          ...(maxDepth === undefined ? {} : { maxDepth }),
          ...(maxFanout === undefined ? {} : { maxFanout })
        });
        return toolJsonResponse(context, 'impact_trace_analyze_diff', report, {
          indexRunId: report.indexRunId,
          changedFiles: report.changedFiles
        });
      } catch (error) {
        return typedToolErrorResponse(error);
      }
    }
  );

  server.registerTool(
    'impact_trace_context_for_change',
    {
      title: 'Build compact context for a change',
      description:
        'Return a budgeted context pack for changed files so coding agents get ranked impact paths, evidence refs, and resource links without the full report payload.',
      inputSchema: {
        changedFiles: z.array(z.string()).min(1),
        budget: z.enum(['brief', 'standard', 'deep']).optional(),
        reusePolicy: z.enum(['auto', 'full', 'reference']).optional(),
        maxDepth: z.number().int().min(1).max(8).optional(),
        maxFanout: z.number().int().min(1).max(2_000).optional()
      },
      annotations: {
        title: 'Build compact context for a change',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ changedFiles, budget, reusePolicy, maxDepth, maxFanout }) => {
      try {
        const normalizedBudget = normalizeContextBudget(budget);
        const normalizedReusePolicy = normalizeContextPackReusePolicy(reusePolicy);
        const preset = contextBudgetPreset(normalizedBudget);
        const { analyzeDiff } = await import('./analyzer.js');
        const report = await analyzeDiff({
          repoRoot: context.repoRoot,
          changedFiles,
          persistReport: false,
          readOnly: true,
          maxDepth: maxDepth ?? preset.maxDepth,
          maxFanout: maxFanout ?? preset.maxFanout
        });
        const pack = buildContextPack(report, normalizedBudget);
        const persisted = persistContextPackForReuse(context, pack, {
          changedFiles: report.changedFiles,
          maxDepth: maxDepth ?? preset.maxDepth,
          maxFanout: maxFanout ?? preset.maxFanout
        });
        const response =
          normalizedReusePolicy === 'reference' || (normalizedReusePolicy === 'auto' && persisted.wasReused)
            ? contextPackReference(persisted.pack, report.changedFiles, persisted.fullBytes)
            : persisted.pack;
        return toolJsonResponse(context, 'impact_trace_context_for_change', response, {
          indexRunId: persisted.pack.indexRunId,
          budget: persisted.pack.budget,
          changedFiles: report.changedFiles,
          resourceCount: resourceCountOf(response),
          omitted: omittedCountsOf(response)
        });
      } catch (error) {
        return typedToolErrorResponse(error);
      }
    }
  );

  server.registerTool(
    'impact_trace_search_context',
    {
      title: 'Search indexed context',
      description:
        'Search the latest Impact Trace index by keyword, path, symbol, relation provenance, or evidence snippet and return ranked entity context with resource links.',
      inputSchema: {
        query: z.string().trim().min(1),
        k: z.number().int().min(1).max(50).optional(),
        includeEvidence: z.boolean().optional(),
        budget: z.enum(['brief', 'standard', 'deep']).optional()
      },
      annotations: {
        title: 'Search indexed context',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ query, k, includeEvidence, budget }) => {
      try {
        const normalizedBudget = budget === undefined ? null : normalizeContextBudget(budget);
        const semanticEmbedding = await searchContextSemanticEmbedding(context, query);
        const result = searchContext(context, {
          query,
          k: k ?? 10,
          includeEvidence: includeEvidence ?? true,
          budget: normalizedBudget,
          disabledStreams: new Set(),
          semanticEmbedding
        });
        const telemetry = searchContextTelemetry(result);
        return toolJsonResponse(context, 'impact_trace_search_context', result, {
          indexRunId: telemetry.indexRunId,
          query,
          budget: normalizedBudget,
          resourceCount: telemetry.resourceCount
        });
      } catch (error) {
        return typedToolErrorResponse(error);
      }
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
        supersedesFactIds: z.array(z.string()).optional(),
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
    async ({ entity, attribute, value, evidenceFactIds, supersedesFactIds, branch, agent, op }) => {
      const result = await rememberOnRepo(context.repoRoot, {
        entity,
        attribute,
        value: value as RememberValue,
        ...(evidenceFactIds !== undefined ? { evidenceFactIds } : {}),
        ...(supersedesFactIds !== undefined ? { supersedesFactIds } : {}),
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
    'impact_trace_explain_entity',
    {
      title: 'Explain an entity',
      description:
        'Return compact direct relation and evidence context for one indexed entity, with resource links for full evidence details.',
      inputSchema: {
        entity: z.string().min(1),
        relationLimit: z.number().int().min(1).max(100).optional(),
        evidenceLimit: z.number().int().min(0).max(50).optional()
      },
      annotations: {
        title: 'Explain an entity',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ entity, relationLimit, evidenceLimit }) => {
      try {
        const result = explainEntity(context, {
          entityId: entity,
          relationLimit: relationLimit ?? 20,
          evidenceLimit: evidenceLimit ?? 10
        });
        const telemetry = explainEntityTelemetry(result);
        return toolJsonResponse(context, 'impact_trace_explain_entity', result, {
          indexRunId: telemetry.indexRunId,
          query: entity,
          resourceCount: telemetry.resourceCount
        });
      } catch (error) {
        return typedToolErrorResponse(error);
      }
    }
  );

  server.registerTool(
    'impact_trace_context_telemetry',
    {
      title: 'Inspect context telemetry',
      description:
        'Return recent local MCP context tool runs and resource reads so agents and UI can measure which compact context was actually expanded.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional()
      },
      annotations: {
        title: 'Inspect context telemetry',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ limit }) => {
      const telemetry = contextTelemetry(context, limit ?? 20);
      return { content: [{ type: 'text', text: JSON.stringify(telemetry) }] };
    }
  );

  server.registerTool(
    'impact_trace_doctor',
    {
      title: 'Inspect Impact Trace health',
      description:
        'Return a read-only local health report covering database schema, latest index, coverage, adapter runs, vector state, and context telemetry availability.',
      inputSchema: {},
      annotations: {
        title: 'Inspect Impact Trace health',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const report = doctorProject({ repoRoot: context.repoRoot });
      return { content: [{ type: 'text', text: JSON.stringify(redactDoctorReportForMcp(report)) }] };
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
      return telemetryJsonResource(context, uri.toString(), 'report', reportId, readReport(context, reportId));
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
      return telemetryJsonResource(context, uri.toString(), 'entity', entityId, readEntity(context, entityId));
    }
  );

  server.registerResource(
    'impact_trace_evidence',
    new ResourceTemplate('impact-trace://evidence/{evidenceId}', {
      list: () => ({ resources: listEvidenceResources(context) })
    }),
    {
      title: 'Impact Trace Evidence',
      description: 'Relation evidence with source span, redacted snippet, and source/target relation context.',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const evidenceId = decodeURIComponent(String(variables.evidenceId));
      return telemetryJsonResource(context, uri.toString(), 'evidence', evidenceId, readEvidence(context, evidenceId));
    }
  );

  server.registerResource(
    'impact_trace_context_packs',
    new ResourceTemplate('impact-trace://context-packs/{contextPackId}', {
      list: () => ({ resources: listContextPackResources(context) })
    }),
    {
      title: 'Impact Trace Context Packs',
      description: 'Persisted compact context packs keyed by content hash for repeated MCP reuse.',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const contextPackId = decodeURIComponent(String(variables.contextPackId));
      return telemetryJsonResource(
        context,
        uri.toString(),
        'context_pack',
        contextPackId,
        readContextPack(context, contextPackId)
      );
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
      try {
        const format = parseGraphFormat(graphFormatVariable(String(variables.format)));
        const { exportImpactGraph } = await import('./graph.js');
        const graph = await exportImpactGraph({
          repoRoot: context.repoRoot,
          reportId,
          format
        });
        const text = graphResourceText(uri, graph, format);
        recordContextResourceAccess(context, {
          uri: uri.toString(),
          resourceKind: 'graph',
          resourceId: `${reportId}:${format}`,
          indexRunId: graph.indexRunId,
          returnedBytes: byteLength(text)
        });
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: format === 'json' ? 'application/json' : 'text/plain',
              text
            }
          ]
        };
      } catch (error) {
        throw typedMcpError(error);
      }
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
    async (uri) => {
      try {
        return telemetryJsonResource(context, uri.toString(), 'coverage', 'latest', readLatestCoverage(context));
      } catch (error) {
        throw typedMcpError(error);
      }
    }
  );

  return server;
}

export async function serveMcp(context: McpContext): Promise<void> {
  const server = createMcpServer(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

type ContextBudgetPreset = {
  maxDepth: number;
  maxFanout: number;
  affectedLimit: number;
  evidenceLimit: number;
  snippetChars: number;
};

const contextBudgetPresets: Record<ContextBudget, ContextBudgetPreset> = {
  brief: {
    maxDepth: 1,
    maxFanout: 50,
    affectedLimit: 5,
    evidenceLimit: 5,
    snippetChars: 300
  },
  standard: {
    maxDepth: 2,
    maxFanout: 200,
    affectedLimit: 15,
    evidenceLimit: 12,
    snippetChars: 800
  },
  deep: {
    maxDepth: 3,
    maxFanout: 500,
    affectedLimit: 50,
    evidenceLimit: 30,
    snippetChars: 1_500
  }
};

function normalizeContextBudget(value: unknown): ContextBudget {
  return value === 'brief' || value === 'standard' || value === 'deep' ? value : 'standard';
}

function normalizeContextPackReusePolicy(value: unknown): ContextPackReusePolicy {
  return value === 'full' || value === 'reference' || value === 'auto' ? value : 'auto';
}

function contextBudgetPreset(budget: ContextBudget): ContextBudgetPreset {
  return contextBudgetPresets[budget];
}

function buildContextPack(report: ImpactReport, budget: ContextBudget): ContextPack {
  const preset = contextBudgetPreset(budget);
  const affectedTargetsByPath = new Map(
    report.affected
      .filter((target) => target.target.path)
      .map((target) => [target.target.path!, target])
  );
  const rankedAffected = [...report.affectedFiles].sort(compareAffectedFiles);
  const selectedAffected = rankedAffected.slice(0, preset.affectedLimit);
  const selectedPaths = new Set([
    ...report.changedFiles,
    ...selectedAffected.map((file) => file.path)
  ]);
  const contextItems: ContextPackItem[] = selectedAffected.map((file) => {
    const affectedTarget = affectedTargetsByPath.get(file.path);
    const target = affectedTarget?.target ?? entityForContextPath(file.path);
    return {
      target,
      path: file.path,
      reason: file.reason,
      confidence: file.confidence,
      ...(file.depth !== undefined ? { depth: file.depth } : {}),
      relations: affectedTarget?.relations ?? file.relationPath ?? [file.reason],
      resourceUri: entityResourceUri(target)
    };
  });
  const selectedEvidence = dedupeEvidenceForContext(report.evidence)
    .sort((a, b) => compareEvidence(a, b, selectedPaths))
    .slice(0, preset.evidenceLimit)
    .map((evidence) => compactEvidence(evidence, preset.snippetChars));
  const selectedActionPaths = new Set(selectedAffected.map((file) => file.path));
  const actions = report.actions.filter((action) =>
    action.target.path ? selectedActionPaths.has(action.target.path) : false
  );
  const entityLinks = [
    ...report.changed.map(entityResourceUri),
    ...contextItems.map((item) => item.resourceUri)
  ];
  const evidenceLinks = selectedEvidence.flatMap((item) => item.resourceUri ? [item.resourceUri] : []);
  return {
    version: 0,
    budget,
    indexRunId: report.indexRunId,
    summary: contextSummary(report, selectedAffected.length, selectedEvidence.length),
    changed: report.changed.map((entity) => ({
      entity,
      resourceUri: entityResourceUri(entity)
    })),
    context: contextItems,
    actions,
    evidence: selectedEvidence,
    resources: {
      coverage: 'impact-trace://coverage/latest',
      entities: [...new Set(entityLinks)].sort(),
      evidence: [...new Set(evidenceLinks)].sort()
    },
    omittedCounts: {
      affected: Math.max(report.affectedFiles.length - selectedAffected.length, 0),
      evidence: Math.max(dedupeEvidenceForContext(report.evidence).length - selectedEvidence.length, 0),
      actions: Math.max(report.actions.length - actions.length, 0)
    },
    limits: {
      affectedLimit: preset.affectedLimit,
      evidenceLimit: preset.evidenceLimit,
      snippetChars: preset.snippetChars,
      affectedTruncated: report.affectedFiles.length > preset.affectedLimit,
      evidenceTruncated: dedupeEvidenceForContext(report.evidence).length > preset.evidenceLimit
    },
    ...(report.warnings && report.warnings.length > 0 ? { warnings: report.warnings } : {})
  };
}

type PersistedContextPack = ContextPack & {
  contextPackId: string;
  resourceUri: string;
  contentHash: string;
  reused: false;
  resources: ContextPack['resources'] & { contextPack: string };
};

type ContextPackReference = {
  version: 0;
  kind: 'context_pack_reference';
  contextPackId: string;
  resourceUri: string;
  contentHash: string;
  reused: true;
  budget: ContextBudget;
  indexRunId: number;
  summary: string[];
  changedFiles: string[];
  resources: {
    contextPack: string;
  };
  omittedCounts: {
    contextItems: number;
    evidence: number;
    actions: number;
    fullContextPackBytes: number;
  };
};

function persistContextPackForReuse(
  context: McpContext,
  pack: ContextPack,
  request: {
    changedFiles: string[];
    maxDepth: number;
    maxFanout: number;
  }
): { pack: PersistedContextPack; wasReused: boolean; fullBytes: number } {
  const packJsonForHash = JSON.stringify(pack);
  const hash = contentHash('context-pack-v0', packJsonForHash);
  const requestHash = contextPackRequestHash(context, pack, request);
  const contextPackId = `ctxpack:${requestHash.slice(0, 32)}`;
  const resourceUri = contextPackResourceUri(contextPackId);
  const persistedPack: PersistedContextPack = {
    ...pack,
    contextPackId,
    resourceUri,
    contentHash: hash,
    reused: false,
    resources: {
      contextPack: resourceUri,
      ...pack.resources
    }
  };
  const packJson = JSON.stringify(persistedPack);
  const fullBytes = byteLength(packJson);
  const wasReused = withWritableDb(context, (db, repoId) => {
    const now = new Date().toISOString();
    const result = db
      .prepare(`
        INSERT OR IGNORE INTO context_packs (
          id, repo_id, index_run_id, budget, request_hash, changed_files_json,
          content_hash, pack_json, returned_bytes, resource_count, omitted_json,
          created_at, last_accessed_at, hit_count
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `)
      .run(
        contextPackId,
        repoId,
        pack.indexRunId,
        pack.budget,
        requestHash,
        JSON.stringify(sanitizeTelemetryPaths(request.changedFiles)),
        hash,
        packJson,
        fullBytes,
        resourceCountOf(persistedPack),
        JSON.stringify(pack.omittedCounts),
        now,
        now
      ) as { changes?: number };
    if ((result.changes ?? 0) > 0) return false;
    db
      .prepare(`
        UPDATE context_packs
           SET last_accessed_at = ?,
               hit_count = hit_count + 1
         WHERE repo_id = ? AND id = ?
      `)
      .run(now, repoId, contextPackId);
    return true;
  }, { skipProjectionRepair: true });
  return { pack: persistedPack, wasReused, fullBytes };
}

const CONTEXT_PACK_CACHE_VERSION = 'context-pack-cache-v1';

function contextPackRequestHash(
  context: McpContext,
  pack: ContextPack,
  request: {
    changedFiles: string[];
    maxDepth: number;
    maxFanout: number;
  }
): string {
  const repoRoot = normalizeRepoRoot(context.repoRoot);
  const gitSnapshot = readGitSnapshot(repoRoot);
  const fileHashes = request.changedFiles
    .map((filePath) => ({
      path: filePath,
      hash: changedFileContentHash(repoRoot, filePath)
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return contentHash(
    CONTEXT_PACK_CACHE_VERSION,
    String(pack.indexRunId),
    pack.budget,
    String(request.maxDepth),
    String(request.maxFanout),
    JSON.stringify(fileHashes),
    JSON.stringify(gitSnapshot)
  );
}

function changedFileContentHash(repoRoot: string, filePath: string): string {
  const absolutePath = resolveInsideRoot(repoRoot, filePath);
  if (!existsSync(absolutePath)) return 'missing';
  const hash = createHash('sha256');
  hash.update(readFileSync(absolutePath));
  return hash.digest('hex');
}

function contextPackReference(
  pack: PersistedContextPack,
  changedFiles: string[],
  fullBytes: number
): ContextPackReference {
  return {
    version: 0,
    kind: 'context_pack_reference',
    contextPackId: pack.contextPackId,
    resourceUri: pack.resourceUri,
    contentHash: pack.contentHash,
    reused: true,
    budget: pack.budget,
    indexRunId: pack.indexRunId,
    summary: [
      `Reusing persisted context pack ${pack.contextPackId}.`,
      `Fetch ${pack.resourceUri} only if the full compact context is needed.`,
      `${pack.context.length} context item(s), ${pack.evidence.length} evidence item(s), and ${pack.actions.length} action(s) are stored in the resource.`
    ],
    changedFiles,
    resources: {
      contextPack: pack.resourceUri
    },
    omittedCounts: {
      contextItems: pack.context.length,
      evidence: pack.evidence.length,
      actions: pack.actions.length,
      fullContextPackBytes: fullBytes
    }
  };
}

function contextSummary(
  report: ImpactReport,
  selectedAffectedCount: number,
  selectedEvidenceCount: number
): string[] {
  return [
    `${report.changedFiles.length} changed file(s) analyzed against index run ${report.indexRunId}.`,
    `${report.affectedFiles.length} affected file(s) found; ${selectedAffectedCount} included in this context pack.`,
    `${selectedEvidenceCount} evidence item(s) included; fetch entity resources for more detail.`,
    `${report.actions.length} recommended action(s) available from the full impact analysis.`
  ];
}

function compareAffectedFiles(
  left: ImpactReport['affectedFiles'][number],
  right: ImpactReport['affectedFiles'][number]
): number {
  return numericCompare(left.depth ?? 99, right.depth ?? 99)
    || numericCompare(confidenceRank(right.confidence), confidenceRank(left.confidence))
    || numericCompare(pathPriority(left.path), pathPriority(right.path))
    || left.path.localeCompare(right.path);
}

function dedupeEvidenceForContext(evidence: readonly Evidence[]): Evidence[] {
  const byKey = new Map<string, Evidence>();
  for (const item of evidence) {
    const key = item.id || `${item.file}:${item.kind}:${item.snippet}`;
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()];
}

function compareEvidence(
  left: Evidence,
  right: Evidence,
  selectedPaths: ReadonlySet<string>
): number {
  return numericCompare(evidencePathRank(left, selectedPaths), evidencePathRank(right, selectedPaths))
    || numericCompare(confidenceRank(right.confidence), confidenceRank(left.confidence))
    || numericCompare(hasSpan(right), hasSpan(left))
    || numericCompare(left.snippet.length, right.snippet.length)
    || left.file.localeCompare(right.file)
    || left.kind.localeCompare(right.kind);
}

function compactEvidence(evidence: Evidence, snippetChars: number): ContextPackEvidence {
  const resourceUri = persistedEvidenceResourceUri(evidence);
  return {
    id: evidence.id,
    file: evidence.file,
    kind: evidence.kind,
    snippet: truncateSnippet(evidence.snippet, snippetChars),
    confidence: evidence.confidence,
    ...(resourceUri ? { resourceUri } : {}),
    ...(evidence.startLine !== undefined ? { startLine: evidence.startLine } : {}),
    ...(evidence.endLine !== undefined ? { endLine: evidence.endLine } : {}),
    ...(evidence.startCol !== undefined ? { startCol: evidence.startCol } : {}),
    ...(evidence.endCol !== undefined ? { endCol: evidence.endCol } : {}),
    ...(evidence.subject !== undefined ? { subject: evidence.subject } : {}),
    ...(evidence.relationKind !== undefined ? { relationKind: evidence.relationKind } : {})
  };
}

function truncateSnippet(snippet: string, limit: number): string {
  if (snippet.length <= limit) return snippet;
  return `${snippet.slice(0, Math.max(limit - 3, 0))}...`;
}

function evidencePathRank(evidence: Evidence, selectedPaths: ReadonlySet<string>): number {
  if (selectedPaths.has(evidence.file)) return 0;
  if (evidence.subject?.path && selectedPaths.has(evidence.subject.path)) return 1;
  return 2;
}

function hasSpan(evidence: Evidence): number {
  return evidence.startLine !== undefined ? 1 : 0;
}

function confidenceRank(confidence: Confidence): number {
  if (confidence === 'proven') return 4;
  if (confidence === 'inferred') return 3;
  if (confidence === 'heuristic') return 2;
  return 1;
}

function pathPriority(filePath: string): number {
  if (/(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\./.test(filePath)) return 0;
  if (filePath.endsWith('.md') || filePath.startsWith('docs/')) return 1;
  if (filePath.startsWith('.github/workflows/') || /\.(ya?ml|json|toml)$/.test(filePath)) return 2;
  return 3;
}

function entityForContextPath(filePath: string): EntityRef {
  return {
    id: `file:${filePath}`,
    kind: 'file',
    path: filePath,
    displayName: filePath
  };
}

function entityResourceUri(entity: EntityRef): string {
  return `impact-trace://entities/${encodeURIComponent(entity.id)}`;
}

function evidenceResourceUri(evidenceId: string): string {
  return `impact-trace://evidence/${encodeURIComponent(evidenceId)}`;
}

function contextPackResourceUri(contextPackId: string): string {
  return `impact-trace://context-packs/${encodeURIComponent(contextPackId)}`;
}

function persistedEvidenceResourceUri(evidence: Evidence): string | undefined {
  // Relation evidence IDs are produced by indexer relationEvidenceId().
  // Synthetic changed-file and legacy fallback evidence use shorter IDs and
  // are not individually readable through the relation_evidence resource.
  if (
    evidence.extractorId === 'canonical-entity-graph' &&
    evidence.relationKind &&
    /^[0-9a-f]{20}$/.test(evidence.id)
  ) {
    return evidenceResourceUri(evidence.id);
  }
  return undefined;
}

function numericCompare(left: number, right: number): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

type ToolResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

type TypedMcpErrorEnvelope = {
  error: {
    code: string;
    problem: string;
    cause: string;
    fix: string;
    evidence: Array<{ kind: string; id?: string; uri?: string }>;
  };
};

type ToolTelemetryInput = {
  indexRunId?: number | null;
  budget?: string | null;
  query?: string | null;
  changedFiles?: string[];
  resourceCount?: number;
  omitted?: unknown;
};

type ResourceTelemetryInput = {
  uri: string;
  resourceKind: string;
  resourceId?: string | null;
  indexRunId?: number | null;
  returnedBytes: number;
};

function patchToolErrorFactory(server: McpServer): void {
  const errorFactory = server as unknown as {
    createToolError?: (errorMessage: string) => ToolResponse;
  };
  errorFactory.createToolError = (errorMessage: string) => typedToolErrorResponse(new Error(errorMessage));
}

function toolJsonResponse(
  context: McpContext,
  toolName: string,
  value: unknown,
  telemetry: ToolTelemetryInput = {}
): ToolResponse {
  const text = JSON.stringify(value);
  recordContextToolRun(context, {
    toolName,
    indexRunId: telemetry.indexRunId ?? indexRunIdOf(value),
    budget: telemetry.budget ?? null,
    query: sanitizeTelemetryText(telemetry.query),
    changedFiles: telemetry.changedFiles ?? [],
    returnedBytes: byteLength(text),
    resourceCount: telemetry.resourceCount ?? resourceCountOf(value),
    omitted: telemetry.omitted ?? omittedCountsOf(value)
  });
  return {
    content: [
      {
        type: 'text',
        text
      }
    ]
  };
}

function typedToolErrorResponse(error: unknown): ToolResponse {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(typedMcpErrorEnvelope(error))
      }
    ]
  };
}

function typedMcpError(error: unknown, fallbackCode = 'impact_trace_error'): Error {
  return new Error(JSON.stringify(typedMcpErrorEnvelope(error, fallbackCode)));
}

function typedMcpErrorEnvelope(error: unknown, fallbackCode = 'impact_trace_error'): TypedMcpErrorEnvelope {
  const message = errorMessage(error);
  const existing = parseTypedMcpError(message);
  if (existing) return existing;

  const normalized = message.toLowerCase();
  let code = fallbackCode;
  let cause = 'Impact Trace could not complete the requested MCP operation.';
  let fix = 'Check the request arguments, refresh the local index if needed, then retry the MCP call.';

  if (normalized.includes('outside repo root') || normalized.includes('resolves outside')) {
    code = 'path_outside_repo';
    cause = 'A requested path resolves outside the current repository root.';
    fix = 'Use a repo-relative path inside the current repository and rerun the request.';
  } else if (normalized.includes('not found')) {
    code = 'resource_not_found';
    cause = 'The requested Impact Trace resource was not found in the local index or report store.';
    fix = 'Refresh resources/list, rerun index/analyze if needed, and use a current resource URI.';
  } else if (normalized.includes('graph resource format')) {
    code = 'invalid_resource_format';
    cause = 'The graph resource format is not one of the formats Impact Trace can render.';
    fix = 'Use one of: mermaid, json, dot.';
  } else if (normalized.includes('graph page limit') || normalized.includes('graph page cursor')) {
    code = 'invalid_pagination';
    cause = 'The graph JSON resource pagination query is malformed.';
    fix = 'Use a positive integer limit up to 500 and pass cursor values returned by the previous page.';
  } else if (
    normalized.includes('search query must not be empty') ||
    (normalized.includes('impact_trace_search_context') && normalized.includes('query') && normalized.includes('too small'))
  ) {
    code = 'empty_search_query';
    cause = 'The search context tool received an empty query after trimming whitespace.';
    fix = 'Provide a non-empty keyword, path, symbol, relation kind, or evidence snippet.';
  } else if (normalized.includes('no completed index found') || normalized.includes('repo is not indexed')) {
    code = 'index_not_ready';
    cause = 'The repository does not have a completed Impact Trace index yet.';
    fix = 'Run impact-trace init and impact-trace index, then retry the MCP request.';
  } else if (normalized.includes('requires impact trace schema v') || normalized.includes('database schema is v')) {
    code = 'schema_outdated';
    cause = 'The local Impact Trace database is older than the current tool contract.';
    fix = 'Run impact-trace init with the current build to apply additive migrations.';
  } else if (normalized.includes('must be') || normalized.includes('between')) {
    code = 'invalid_tool_input';
    cause = 'The MCP tool arguments do not match the Impact Trace input contract.';
    fix = 'Correct the argument type or allowed range, then retry the tool call.';
  }

  return {
    error: {
      code,
      problem: message,
      cause,
      fix,
      evidence: []
    }
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown Impact Trace MCP error';
}

function parseTypedMcpError(message: string): TypedMcpErrorEnvelope | null {
  try {
    const parsed = JSON.parse(message) as Partial<TypedMcpErrorEnvelope>;
    if (
      parsed.error &&
      typeof parsed.error.code === 'string' &&
      typeof parsed.error.problem === 'string' &&
      typeof parsed.error.cause === 'string' &&
      typeof parsed.error.fix === 'string' &&
      Array.isArray(parsed.error.evidence)
    ) {
      return parsed as TypedMcpErrorEnvelope;
    }
  } catch {
    return null;
  }
  return null;
}

function telemetryJsonResource(
  context: McpContext,
  uri: string,
  resourceKind: string,
  resourceId: string | null,
  value: unknown
): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
  const text = JSON.stringify(value, null, 2);
  recordContextResourceAccess(context, {
    uri,
    resourceKind,
    resourceId,
    indexRunId: indexRunIdOf(value),
    returnedBytes: byteLength(text)
  });
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text
      }
    ]
  };
}

function recordContextToolRun(
  context: McpContext,
  input: ToolTelemetryInput & {
    toolName: string;
    returnedBytes: number;
    resourceCount: number;
    omitted: unknown;
  }
): void {
  bestEffortTelemetry(() => withWritableDb(context, (db, repoId) => {
    const now = new Date().toISOString();
    db
      .prepare(`
        INSERT INTO context_tool_runs (
          id, repo_id, tool_name, index_run_id, budget, query, changed_files_json,
          returned_bytes, resource_count, omitted_json, started_at, finished_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        repoId,
        input.toolName,
        input.indexRunId ?? null,
        input.budget ?? null,
        input.query ?? null,
        JSON.stringify(sanitizeTelemetryPaths(input.changedFiles ?? [])),
        input.returnedBytes,
        input.resourceCount,
        JSON.stringify(input.omitted ?? {}),
        now,
        now
      );
  }, { skipProjectionRepair: true }));
}

function recordContextResourceAccess(context: McpContext, input: ResourceTelemetryInput): void {
  bestEffortTelemetry(() => withWritableDb(context, (db, repoId) => {
    db
      .prepare(`
        INSERT INTO context_resource_accesses (
          id, repo_id, uri, resource_kind, resource_id, index_run_id, returned_bytes, accessed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        repoId,
        sanitizeTelemetryText(input.uri) ?? input.uri,
        input.resourceKind,
        sanitizeTelemetryText(input.resourceId),
        input.indexRunId ?? null,
        input.returnedBytes,
        new Date().toISOString()
      );
  }, { skipProjectionRepair: true }));
}

function contextTelemetry(context: McpContext, limit: number): unknown {
  return withReadOnlyDb(context, (db, repoId) => {
    if (!hasContextTelemetryTables(db)) {
      return emptyContextTelemetry();
    }
    const summary = db
      .prepare(`
        SELECT
          (SELECT count(*) FROM context_tool_runs WHERE repo_id = ?) AS tool_runs,
          (SELECT count(*) FROM context_resource_accesses WHERE repo_id = ?) AS resource_accesses,
          (SELECT COALESCE(sum(returned_bytes), 0) FROM context_tool_runs WHERE repo_id = ?)
            + (SELECT COALESCE(sum(returned_bytes), 0) FROM context_resource_accesses WHERE repo_id = ?) AS returned_bytes,
          (SELECT COALESCE(sum(resource_count), 0) FROM context_tool_runs WHERE repo_id = ?) AS resources_advertised
      `)
      .get(repoId, repoId, repoId, repoId, repoId) as {
        tool_runs: number;
        resource_accesses: number;
        returned_bytes: number;
        resources_advertised: number;
      };
    const toolRows = db
      .prepare(`
        SELECT id, tool_name, index_run_id, budget, query, changed_files_json,
               returned_bytes, resource_count, omitted_json, started_at, finished_at
        FROM context_tool_runs
        WHERE repo_id = ?
        ORDER BY started_at DESC, id DESC
        LIMIT ?
      `)
      .all(repoId, limit) as Array<{
        id: string;
        tool_name: string;
        index_run_id: number | null;
        budget: string | null;
        query: string | null;
        changed_files_json: string;
        returned_bytes: number;
        resource_count: number;
        omitted_json: string;
        started_at: string;
        finished_at: string;
      }>;
    const resourceRows = db
      .prepare(`
        SELECT id, uri, resource_kind, resource_id, index_run_id, returned_bytes, accessed_at
        FROM context_resource_accesses
        WHERE repo_id = ?
        ORDER BY accessed_at DESC, id DESC
        LIMIT ?
      `)
      .all(repoId, limit) as Array<{
        id: string;
        uri: string;
        resource_kind: string;
        resource_id: string | null;
        index_run_id: number | null;
        returned_bytes: number;
        accessed_at: string;
      }>;

    return {
      version: 0,
      summary: {
        toolRuns: summary.tool_runs,
        resourceAccesses: summary.resource_accesses,
        returnedBytes: summary.returned_bytes,
        resourcesAdvertised: summary.resources_advertised
      },
      toolRuns: toolRows.map((row) => ({
        id: row.id,
        toolName: row.tool_name,
        indexRunId: row.index_run_id,
        budget: row.budget,
        query: row.query,
        changedFiles: parseJsonArray(row.changed_files_json),
        returnedBytes: row.returned_bytes,
        resourceCount: row.resource_count,
        omitted: parseJsonObject(row.omitted_json),
        startedAt: row.started_at,
        finishedAt: row.finished_at
      })),
      resourceAccesses: resourceRows.map((row) => ({
        id: row.id,
        uri: row.uri,
        resourceKind: row.resource_kind,
        resourceId: row.resource_id,
        indexRunId: row.index_run_id,
        returnedBytes: row.returned_bytes,
        accessedAt: row.accessed_at
      }))
    };
  });
}

function hasContextTelemetryTables(db: ReturnType<typeof openDatabase>): boolean {
  return mcpHasTable(db, 'context_tool_runs') && mcpHasTable(db, 'context_resource_accesses');
}

function emptyContextTelemetry(): unknown {
  return {
    version: 0,
    summary: {
      toolRuns: 0,
      resourceAccesses: 0,
      returnedBytes: 0,
      resourcesAdvertised: 0
    },
    toolRuns: [],
    resourceAccesses: []
  };
}

function bestEffortTelemetry(callback: () => void): void {
  try {
    if (process.env.IMPACT_TRACE_TELEMETRY_FORCE_FAILURE === '1') {
      throw new Error('forced telemetry failure');
    }
    callback();
  } catch {
    // Telemetry must never break the primary MCP result or resource read.
  }
}

function searchContextTelemetry(value: unknown): { indexRunId: number | null; resourceCount: number } {
  return {
    indexRunId: indexRunIdOf(value),
    resourceCount: resourceCountOf(value)
  };
}

function explainEntityTelemetry(value: unknown): { indexRunId: number | null; resourceCount: number } {
  return {
    indexRunId: indexRunIdOf(value),
    resourceCount: resourceCountOf(value)
  };
}

function indexRunIdOf(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const indexRunId = value.indexRunId;
  return typeof indexRunId === 'number' && Number.isFinite(indexRunId) ? indexRunId : null;
}

function resourceCountOf(value: unknown): number {
  if (!isRecord(value) || !isRecord(value.resources)) return 0;
  return Object.values(value.resources).reduce<number>((total, item) => {
    if (Array.isArray(item)) return total + item.length;
    return typeof item === 'string' && item.length > 0 ? total + 1 : total;
  }, 0);
}

function omittedCountsOf(value: unknown): unknown {
  if (!isRecord(value)) return {};
  return isRecord(value.omittedCounts) ? value.omittedCounts : {};
}

function sanitizeTelemetryText(value: string | null | undefined): string | null {
  return value === undefined || value === null ? null : redactSecrets(value);
}

function sanitizeTelemetryPaths(paths: string[]): string[] {
  return paths.map((item) => redactSecrets(item));
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function listEvidenceResources(context: McpContext): Array<{ uri: string; name: string; mimeType: string }> {
  return withReadOnlyDb(context, (db, repoId) => {
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const rows = db
      .prepare(`
        SELECT id, file_path, kind
        FROM relation_evidence
        WHERE repo_id = ? AND index_run_id = ?
        ORDER BY file_path, kind, id
        LIMIT 50
      `)
      .all(repoId, indexRunId) as Array<{ id: string; file_path: string; kind: string }>;
    return rows.map((row) => ({
      uri: evidenceResourceUri(row.id),
      name: `${row.kind} evidence in ${row.file_path}`,
      mimeType: 'application/json'
    }));
  });
}

function listContextPackResources(context: McpContext): Array<{ uri: string; name: string; mimeType: string }> {
  return withReadOnlyDb(context, (db, repoId) => {
    if (!mcpHasTable(db, 'context_packs')) return [];
    const rows = db
      .prepare(`
        SELECT id, budget, index_run_id
        FROM context_packs
        WHERE repo_id = ?
        ORDER BY last_accessed_at DESC, created_at DESC
        LIMIT 50
      `)
      .all(repoId) as Array<{ id: string; budget: string; index_run_id: number }>;
    return rows.map((row) => ({
      uri: contextPackResourceUri(row.id),
      name: `${row.budget} context pack for index run ${row.index_run_id}`,
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

function graphFormatVariable(value: string): string {
  return value.split(/[?#]/, 1)[0] ?? value;
}

type GraphPageCursor = {
  nodeOffset: number;
  edgeOffset: number;
};

function graphResourceText(uri: URL, graph: GraphExport, format: GraphExportFormat): string {
  if (format !== 'json') return graph.rendered;
  if (!uri.searchParams.has('limit') && !uri.searchParams.has('cursor')) return graph.rendered;

  const limit = parseGraphPageLimit(uri.searchParams.get('limit'));
  const cursorRaw = uri.searchParams.get('cursor');
  const cursor = parseGraphPageCursor(cursorRaw);
  validateGraphPageCursor(cursor, graph);
  const nodes = graph.nodes.slice(cursor.nodeOffset, cursor.nodeOffset + limit);
  const edges = graph.edges.slice(cursor.edgeOffset, cursor.edgeOffset + limit);
  const nextNodeOffset = cursor.nodeOffset + nodes.length;
  const nextEdgeOffset = cursor.edgeOffset + edges.length;
  const nextCursor =
    nextNodeOffset < graph.nodes.length || nextEdgeOffset < graph.edges.length
      ? `${nextNodeOffset}:${nextEdgeOffset}`
      : null;

  return JSON.stringify(
    {
      reportId: graph.reportId,
      indexRunId: graph.indexRunId,
      format: graph.format,
      nodes,
      edges,
      page: {
        cursor: cursorRaw,
        nextCursor,
        limit,
        totalNodes: graph.nodes.length,
        totalEdges: graph.edges.length,
        returnedNodes: nodes.length,
        returnedEdges: edges.length
      }
    },
    null,
    2
  );
}

function parseGraphPageLimit(value: string | null): number {
  if (value === null) return 100;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw typedMcpError(new Error('graph page limit must be an integer between 1 and 500'), 'invalid_pagination');
  }
  return limit;
}

function parseGraphPageCursor(value: string | null): GraphPageCursor {
  if (value === null) return { nodeOffset: 0, edgeOffset: 0 };
  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) {
    throw typedMcpError(new Error('graph page cursor must be returned by a previous graph JSON page'), 'invalid_pagination');
  }
  return {
    nodeOffset: parseGraphCursorOffset(match[1]!, 'node'),
    edgeOffset: parseGraphCursorOffset(match[2]!, 'edge')
  };
}

function parseGraphCursorOffset(value: string, label: 'node' | 'edge'): number {
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw typedMcpError(new Error(`graph page cursor ${label} offset must be a safe non-negative integer`), 'invalid_pagination');
  }
  return offset;
}

function validateGraphPageCursor(cursor: GraphPageCursor, graph: GraphExport): void {
  if (cursor.nodeOffset > graph.nodes.length || cursor.edgeOffset > graph.edges.length) {
    throw typedMcpError(new Error('graph page cursor is outside the current graph bounds'), 'invalid_pagination');
  }
}

function readReport(context: McpContext, reportId: string): unknown {
  return withReadOnlyDb(context, (db, repoId) => {
    const row = db.prepare('SELECT json FROM reports WHERE repo_id = ? AND id = ?').get(repoId, reportId) as { json: string } | undefined;
    if (!row) throw typedMcpError(new Error(`impact report not found: ${reportId}`), 'resource_not_found');
    return JSON.parse(row.json) as unknown;
  });
}

function readContextPack(context: McpContext, contextPackId: string): unknown {
  return withReadOnlyDb(context, (db, repoId) => {
    if (!mcpHasTable(db, 'context_packs')) {
      throw typedMcpError(new Error(`impact context pack not found: ${contextPackId}`), 'resource_not_found');
    }
    const row = db
      .prepare('SELECT pack_json FROM context_packs WHERE repo_id = ? AND id = ?')
      .get(repoId, contextPackId) as { pack_json: string } | undefined;
    if (!row) {
      throw typedMcpError(new Error(`impact context pack not found: ${contextPackId}`), 'resource_not_found');
    }
    return JSON.parse(row.pack_json) as unknown;
  });
}

function readEntity(context: McpContext, entityId: string): unknown {
  return withReadOnlyDb(context, (db, repoId) => {
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const relationLimit = 100;
    const entity = db
      .prepare('SELECT * FROM entities WHERE repo_id = ? AND id = ? AND updated_index_run_id = ?')
      .get(repoId, entityId, indexRunId) as Record<string, unknown> | undefined;
    if (!entity) throw typedMcpError(new Error(`impact entity not found: ${entityId}`), 'resource_not_found');
    const outgoing = db
      .prepare('SELECT id, target_entity_id, kind, confidence, provenance FROM relations WHERE repo_id = ? AND source_entity_id = ? AND index_run_id = ? ORDER BY kind, target_entity_id LIMIT ?')
      .all(repoId, entityId, indexRunId, relationLimit + 1);
    const incoming = db
      .prepare('SELECT id, source_entity_id, kind, confidence, provenance FROM relations WHERE repo_id = ? AND target_entity_id = ? AND index_run_id = ? ORDER BY kind, source_entity_id LIMIT ?')
      .all(repoId, entityId, indexRunId, relationLimit + 1);
    return {
      entity,
      indexRunId,
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

type EvidenceResourceRow = {
  evidence_id: string;
  evidence_file_path: string;
  evidence_kind: string;
  evidence_snippet: string;
  evidence_confidence: string;
  evidence_index_run_id: number;
  evidence_start_line: number | null;
  evidence_end_line: number | null;
  evidence_start_col: number | null;
  evidence_end_col: number | null;
  relation_id: string;
  relation_kind: string;
  relation_confidence: string;
  relation_provenance: string;
  source_id: string | null;
  source_kind: string | null;
  source_path: string | null;
  source_symbol: string | null;
  source_language_id: string | null;
  source_display_name: string | null;
  target_id: string | null;
  target_kind: string | null;
  target_path: string | null;
  target_symbol: string | null;
  target_language_id: string | null;
  target_display_name: string | null;
};

type EntityExplainOptions = {
  entityId: string;
  relationLimit: number;
  evidenceLimit: number;
};

type ExplainEntityRow = {
  id: string;
  kind: string;
  path: string | null;
  symbol: string | null;
  language_id: string | null;
  display_name: string;
};

type ExplainRelationRow = {
  relation_id: string;
  relation_kind: string;
  relation_confidence: string;
  relation_provenance: string;
  source_id: string;
  source_kind: string;
  source_path: string | null;
  source_symbol: string | null;
  source_language_id: string | null;
  source_display_name: string;
  target_id: string;
  target_kind: string;
  target_path: string | null;
  target_symbol: string | null;
  target_language_id: string | null;
  target_display_name: string;
};

type ExplainEvidenceRow = {
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

type CompactEvidenceResource = {
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

type SearchContextOptions = {
  query: string;
  k: number;
  includeEvidence: boolean;
  budget: ContextBudget | null;
  disabledStreams: ReadonlySet<SearchContextDisabledStream>;
  semanticEmbedding: EmbeddingResult | null;
};

type SearchContextDisabledStream = 'evidenceFts' | 'factsFts';

export type SearchContextForRepoOptions = {
  repoRoot: string;
  query: string;
  k?: number;
  includeEvidence?: boolean;
  budget?: ContextBudget | null;
  disabledStreams?: SearchContextDisabledStream[];
};

type SearchEntityRow = {
  entity_id: string;
  entity_kind: string;
  entity_path: string | null;
  entity_symbol: string | null;
  entity_language_id: string | null;
  entity_display_name: string;
  relation_kind_bucket: string | null;
  id_match: number;
  display_match: number;
  path_match: number;
  symbol_match: number;
  relation_match_count: number;
  evidence_match_count: number;
  fact_match_count: number;
};

type SearchEvidenceRow = ExplainEvidenceRow & {
  query_match: number;
};

type SearchRankSignals = {
  algorithm: 'rrf';
  keywordRank: number | null;
  relationRank: number | null;
  evidenceRank: number | null;
  semanticRank: number | null;
  graphProximityRank: number | null;
  rrfScore: number;
};

type RankedSearchEntity = {
  row: SearchEntityRow;
  score: number;
  rawScore: number;
  reasons: string[];
  rankSignals: SearchRankSignals;
};

type SearchRanking = {
  rankedRows: RankedSearchEntity[];
  matchedEntitiesLowerBound: number;
  truncated: boolean;
};

type SearchCandidate = {
  row: SearchEntityRow;
  keywordRank: number | null;
  relationRank: number | null;
  evidenceRank: number | null;
  semanticRank: number | null;
  graphProximityRank: number | null;
};

const searchContextEvidencePerEntity = 2;
const searchContextSnippetChars = 240;
const searchContextRrfK = 60;
const searchContextStreamLimit = 500;
const searchContextGraphSeedLimit = 25;
const searchContextSemanticOverFetchFactor = 5;
const searchContextSemanticOverFetchMin = 100;

type SearchContextBudgetPreset = {
  returnedBytesLimit: number;
  estimatedTokensLimit: number;
};

const searchContextBudgetPresets: Record<ContextBudget, SearchContextBudgetPreset> = {
  brief: { returnedBytesLimit: 5_000, estimatedTokensLimit: 1_250 },
  standard: { returnedBytesLimit: 12_000, estimatedTokensLimit: 3_000 },
  deep: { returnedBytesLimit: 30_000, estimatedTokensLimit: 7_500 }
};

async function searchContextSemanticEmbedding(context: McpContext, query: string): Promise<EmbeddingResult | null> {
  const model = selectedEmbeddingModel();
  const hasEmbeddings = withReadOnlyDb(context, (db, repoId) => {
    assertCurrentSchema(db, 'impact_trace_search_context');
    if (!mcpHasTable(db, 'fact_embeddings')) return false;
    const row = db
      .prepare(`
        SELECT 1 AS one
        FROM fact_embeddings fe
        INNER JOIN facts f ON f.id = fe.fact_id
        INNER JOIN transactions t ON t.id = f.tx_id
        INNER JOIN entities e ON e.id = f.entity_id
        WHERE fe.model = ?
          AND (
            (
              t.archived = 0
              AND t.branch_id = (SELECT id FROM branches WHERE name = 'main')
            )
            OR EXISTS (
              SELECT 1
              FROM fact_provenance visibility_fp
              INNER JOIN transactions visibility_tx
                ON visibility_tx.id = visibility_fp.tx_id
              WHERE visibility_fp.fact_id = f.id
                AND visibility_fp.kind = 'supersedes'
                AND visibility_tx.archived = 0
                AND visibility_tx.branch_id = (SELECT id FROM branches WHERE name = 'main')
            )
          )
          AND f.op = 'assert'
          AND f.redacted = 0
          AND e.repo_id = ?
        LIMIT 1
      `)
      .get(model, repoId) as { one: number } | undefined;
    return row !== undefined;
  });
  if (!hasEmbeddings) return null;
  try {
    return await computeEmbedding(query);
  } catch {
    return null;
  }
}

export async function searchContextForRepo(options: SearchContextForRepoOptions): Promise<unknown> {
  const context = { repoRoot: normalizeRepoRoot(options.repoRoot) };
  const semanticEmbedding = await searchContextSemanticEmbedding(context, options.query);
  return searchContext(context, {
    query: options.query,
    k: options.k ?? 10,
    includeEvidence: options.includeEvidence ?? true,
    budget: options.budget ?? null,
    disabledStreams: new Set(options.disabledStreams ?? []),
    semanticEmbedding
  });
}

function searchContext(context: McpContext, options: SearchContextOptions): unknown {
  const query = options.query.trim();
  if (!query) throw new Error('search query must not be empty');

  return withReadOnlyDb(context, (db, repoId) => {
    assertCurrentSchema(db, 'impact_trace_search_context');
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const likeQuery = `%${escapeLike(query)}%`;
    const ranking = searchRankedEntities(
      db,
      repoId,
      indexRunId,
      query,
      likeQuery,
      options.k,
      options.semanticEmbedding,
      options.disabledStreams
    );
    const selected = diversifyRankedRows(ranking.rankedRows, options.k).slice(0, options.k);
    const evidenceByEntity = new Map<string, CompactEvidenceResource[]>();
    const evidenceUris: string[] = [];

    if (options.includeEvidence) {
      for (const item of selected) {
        const evidenceRows = searchEvidenceRows(
          db,
          repoId,
          indexRunId,
          item.row.entity_id,
          likeQuery,
          searchContextEvidencePerEntity
        );
        const evidence = evidenceRows.map((row) => compactEvidenceResource(row, searchContextSnippetChars));
        evidenceByEntity.set(item.row.entity_id, evidence);
        evidenceUris.push(...evidence.map((row) => row.resourceUri));
      }
    }

    const unbudgetedResults = selected.map((item) => {
      const entity = entityFromSearchRow(item.row);
      return {
        entity,
        score: item.score,
        reasons: item.reasons,
        rankSignals: item.rankSignals,
        resourceUri: entityResourceUri(entity),
        evidence: evidenceByEntity.get(item.row.entity_id) ?? []
      };
    });
    const budgeted = applySearchContextBudget({
      query,
      indexRunId,
      results: unbudgetedResults,
      budget: options.budget,
      k: options.k,
      includeEvidence: options.includeEvidence,
      ranking,
      evidenceUris
    });

    return budgeted;
  });
}

function applySearchContextBudget(input: {
  query: string;
  indexRunId: number;
  results: Array<{
    entity: EntityRef;
    score: number;
    reasons: string[];
    rankSignals: SearchRankSignals;
    resourceUri: string;
    evidence: CompactEvidenceResource[];
  }>;
  budget: ContextBudget | null;
  k: number;
  includeEvidence: boolean;
  ranking: SearchRanking;
  evidenceUris: string[];
}): unknown {
  const preset = input.budget ? searchContextBudgetPresets[input.budget] : null;
  let results = input.results;
  let evidenceUris = input.evidenceUris;
  let omittedEntities = Math.max(input.ranking.matchedEntitiesLowerBound - results.length, 0);
  let omittedEvidence = 0;

  const build = (currentResults: typeof results, currentEvidenceUris: string[]) => ({
    query: input.query,
    indexRunId: input.indexRunId,
    results: currentResults,
    resources: {
      entities: currentResults.map((item) => item.resourceUri).sort(),
      evidence: [...new Set(currentEvidenceUris)].sort()
    },
    limits: {
      k: input.k,
      includeEvidence: input.includeEvidence,
      evidencePerEntity: searchContextEvidencePerEntity,
      snippetChars: searchContextSnippetChars,
      truncated: input.ranking.truncated || omittedEntities > 0,
      budget: input.budget,
      returnedBytes: 0,
      returnedBytesLimit: preset?.returnedBytesLimit ?? null,
      estimatedTokens: 0,
      estimatedTokensLimit: preset?.estimatedTokensLimit ?? null,
      budgetExceeded: false
    },
    counts: {
      returnedEntities: currentResults.length,
      matchedEntitiesLowerBound: input.ranking.matchedEntitiesLowerBound,
      evidence: new Set(currentEvidenceUris).size
    },
    omittedCounts: {
      entities: omittedEntities,
      evidence: omittedEvidence
    }
  });

  if (preset) {
    let current = build(results, evidenceUris);
    stabilizeSearchContextSize(current);
    let returnedBytes = current.limits.returnedBytes;
    while (returnedBytes > preset.returnedBytesLimit && results.some((item) => item.evidence.length > 0)) {
      for (let index = results.length - 1; index >= 0; index -= 1) {
        const item = results[index]!;
        if (item.evidence.length === 0) continue;
        omittedEvidence += item.evidence.length;
        results = results.map((result, resultIndex) =>
          resultIndex === index ? { ...result, evidence: [] } : result
        );
        break;
      }
      const keptEvidenceIds = new Set(results.flatMap((item) => item.evidence.map((evidence) => evidence.resourceUri)));
      evidenceUris = evidenceUris.filter((uri) => keptEvidenceIds.has(uri));
      current = build(results, evidenceUris);
      stabilizeSearchContextSize(current);
      returnedBytes = current.limits.returnedBytes;
    }
    while (returnedBytes > preset.returnedBytesLimit && results.length > 1) {
      const removed = results[results.length - 1]!;
      omittedEntities += 1;
      omittedEvidence += removed.evidence.length;
      results = results.slice(0, -1);
      const keptEvidenceIds = new Set(results.flatMap((item) => item.evidence.map((evidence) => evidence.resourceUri)));
      evidenceUris = evidenceUris.filter((uri) => keptEvidenceIds.has(uri));
      current = build(results, evidenceUris);
      stabilizeSearchContextSize(current);
      returnedBytes = current.limits.returnedBytes;
    }
  }

  const finalResult = build(results, evidenceUris);
  finalizeSearchContextSize(finalResult, preset);
  return finalResult;
}

function stabilizeSearchContextSize(result: { limits: { returnedBytes: number; estimatedTokens: number } }): void {
  for (let index = 0; index < 8; index += 1) {
    const returnedBytes = byteLength(JSON.stringify(result));
    const estimatedTokens = Math.ceil(returnedBytes / 4);
    if (result.limits.returnedBytes === returnedBytes && result.limits.estimatedTokens === estimatedTokens) {
      return;
    }
    result.limits.returnedBytes = returnedBytes;
    result.limits.estimatedTokens = estimatedTokens;
  }
}

function finalizeSearchContextSize(
  result: { limits: { returnedBytes: number; returnedBytesLimit: number | null; estimatedTokens: number; budgetExceeded: boolean } },
  preset: { returnedBytesLimit: number } | null
): void {
  stabilizeSearchContextSize(result);
  if (!preset) return;

  const withinBudgetRepresentationFits = result.limits.returnedBytes <= preset.returnedBytesLimit;
  if (withinBudgetRepresentationFits) return;

  result.limits.budgetExceeded = true;
  stabilizeSearchContextSize(result);
}

function diversifyRankedRows(rows: RankedSearchEntity[], k: number): RankedSearchEntity[] {
  if (k < 3 || rows.length <= 1) return rows;
  const buckets = new Map<string, RankedSearchEntity[]>();
  for (const row of rows) {
    const key = searchDiversityBucket(row.row);
    const bucket = buckets.get(key) ?? [];
    bucket.push(row);
    buckets.set(key, bucket);
  }
  if (buckets.size <= 1) return rows;

  const diversified: RankedSearchEntity[] = [];
  const queues = [...buckets.values()];
  while (diversified.length < rows.length) {
    let moved = false;
    for (const queue of queues) {
      const next = queue.shift();
      if (!next) continue;
      diversified.push(next);
      moved = true;
    }
    if (!moved) break;
  }
  return diversified;
}

function searchDiversityBucket(row: SearchEntityRow): string {
  return [
    pathPrefixBucket(row.entity_path),
    row.entity_kind,
    row.relation_kind_bucket ?? 'no-relation'
  ].join('|');
}

function pathPrefixBucket(filePath: string | null): string {
  if (!filePath) return '[no-path]';
  return filePath.split('/')[0] || filePath;
}

function searchRankedEntities(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  query: string,
  likeQuery: string,
  k: number,
  semanticEmbedding: EmbeddingResult | null,
  disabledStreams: ReadonlySet<SearchContextDisabledStream>
): SearchRanking {
  const keywordRows = searchKeywordEntityRows(db, repoId, indexRunId, query, likeQuery);
  const relationRows = searchRelationEntityRows(db, repoId, indexRunId, likeQuery);
  const evidenceRows = searchEvidenceEntityRows(db, repoId, indexRunId, query, likeQuery, disabledStreams);
  const factRows = searchFactEntityRows(db, repoId, indexRunId, query, disabledStreams);
  const contextEvidenceRows = [...evidenceRows, ...factRows];
  const semanticRows = semanticEmbedding
    ? searchSemanticEntityRows(db, repoId, indexRunId, semanticEmbedding)
    : [];
  const graphRows = searchGraphProximityEntityRows(
    db,
    repoId,
    indexRunId,
    [...keywordRows, ...relationRows, ...contextEvidenceRows, ...semanticRows],
    k
  );
  const candidates = new Map<string, SearchCandidate>();

  mergeSearchStream(candidates, keywordRows, 'keywordRank');
  mergeSearchStream(candidates, relationRows, 'relationRank');
  mergeSearchStream(candidates, contextEvidenceRows, 'evidenceRank');
  mergeSearchStream(candidates, semanticRows, 'semanticRank');
  mergeSearchStream(candidates, graphRows, 'graphProximityRank');

  const rankedRows = [...candidates.values()]
    .map((candidate) => {
      const rawScore = searchRawRrfScore(candidate);
      const rankSignals = searchRankSignals(candidate, rawScore);
      return {
        row: candidate.row,
        score: rankSignals.rrfScore,
        rawScore,
        reasons: searchEntityReasons(candidate),
        rankSignals
      };
    })
    .sort((left, right) =>
      numericCompare(right.rawScore, left.rawScore)
      || left.row.entity_display_name.localeCompare(right.row.entity_display_name)
      || left.row.entity_id.localeCompare(right.row.entity_id)
    );

  return {
    rankedRows,
    matchedEntitiesLowerBound: candidates.size,
    truncated: candidates.size > k
  };
}

function mergeSearchStream(
  candidates: Map<string, SearchCandidate>,
  rows: SearchEntityRow[],
  rankField: 'keywordRank' | 'relationRank' | 'evidenceRank' | 'semanticRank' | 'graphProximityRank'
): void {
  rows.forEach((row, index) => {
    const existing = candidates.get(row.entity_id);
    const candidate = existing ?? {
      row: { ...row },
      keywordRank: null,
      relationRank: null,
      evidenceRank: null,
      semanticRank: null,
      graphProximityRank: null
    };
    candidate.row.id_match = Math.max(candidate.row.id_match, row.id_match);
    candidate.row.display_match = Math.max(candidate.row.display_match, row.display_match);
    candidate.row.path_match = Math.max(candidate.row.path_match, row.path_match);
    candidate.row.symbol_match = Math.max(candidate.row.symbol_match, row.symbol_match);
    candidate.row.relation_match_count = Math.max(candidate.row.relation_match_count, row.relation_match_count);
    candidate.row.evidence_match_count = Math.max(candidate.row.evidence_match_count, row.evidence_match_count);
    candidate.row.fact_match_count = Math.max(candidate.row.fact_match_count, row.fact_match_count);
    candidate.row.relation_kind_bucket = candidate.row.relation_kind_bucket ?? row.relation_kind_bucket;
    candidate[rankField] = candidate[rankField] === null ? index + 1 : Math.min(candidate[rankField], index + 1);
    candidates.set(row.entity_id, candidate);
  });
}

function searchRawRrfScore(candidate: SearchCandidate): number {
  return reciprocalRank(candidate.keywordRank)
    + reciprocalRank(candidate.relationRank)
    + reciprocalRank(candidate.evidenceRank)
    + reciprocalRank(candidate.semanticRank)
    + reciprocalRank(candidate.graphProximityRank);
}

function searchRankSignals(candidate: SearchCandidate, rawScore: number): SearchRankSignals {
  return {
    algorithm: 'rrf',
    keywordRank: candidate.keywordRank,
    relationRank: candidate.relationRank,
    evidenceRank: candidate.evidenceRank,
    semanticRank: candidate.semanticRank,
    graphProximityRank: candidate.graphProximityRank,
    rrfScore: Number(rawScore.toFixed(8))
  };
}

function reciprocalRank(rank: number | null): number {
  return rank === null ? 0 : 1 / (searchContextRrfK + rank);
}

function searchKeywordEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  query: string,
  likeQuery: string
): SearchEntityRow[] {
  const ftsRows = searchFtsKeywordEntityRows(db, repoId, indexRunId, query, likeQuery);
  if (ftsRows.length > 0) return ftsRows;
  return searchLikeKeywordEntityRows(db, repoId, indexRunId, likeQuery);
}

function searchFtsKeywordEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  query: string,
  likeQuery: string
): SearchEntityRow[] {
  if (!mcpHasTable(db, 'search_entities_fts')) return [];
  const ftsQuery = ftsMatchExpression(query);
  if (!ftsQuery) return [];
  try {
    return db
      .prepare(`
        SELECT
          entities.id AS entity_id,
          entities.kind AS entity_kind,
          entities.path AS entity_path,
          entities.symbol AS entity_symbol,
          entities.language_id AS entity_language_id,
          entities.display_name AS entity_display_name,
          NULL AS relation_kind_bucket,
          CASE WHEN entities.id LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS id_match,
          CASE WHEN entities.display_name LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS display_match,
          CASE WHEN COALESCE(entities.path, '') LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS path_match,
          CASE WHEN COALESCE(entities.symbol, '') LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS symbol_match,
          0 AS relation_match_count,
          0 AS evidence_match_count,
          0 AS fact_match_count
        FROM search_entities_fts fts
        INNER JOIN entities
          ON entities.id = fts.entity_id
         AND entities.repo_id = ?
         AND entities.updated_index_run_id = ?
        WHERE search_entities_fts MATCH ?
        ORDER BY bm25(search_entities_fts), entities.display_name, entities.id
        LIMIT ?
      `)
      .all(
        likeQuery,
        likeQuery,
        likeQuery,
        likeQuery,
        repoId,
        indexRunId,
        ftsQuery,
        searchContextStreamLimit
      ) as SearchEntityRow[];
  } catch {
    return [];
  }
}

function searchLikeKeywordEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  likeQuery: string
): SearchEntityRow[] {
  return db
    .prepare(`
      SELECT
        entities.id AS entity_id,
        entities.kind AS entity_kind,
        entities.path AS entity_path,
        entities.symbol AS entity_symbol,
        entities.language_id AS entity_language_id,
        entities.display_name AS entity_display_name,
        NULL AS relation_kind_bucket,
        CASE WHEN entities.id LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS id_match,
        CASE WHEN entities.display_name LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS display_match,
        CASE WHEN COALESCE(entities.path, '') LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS path_match,
        CASE WHEN COALESCE(entities.symbol, '') LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS symbol_match,
        0 AS relation_match_count,
        0 AS evidence_match_count,
        0 AS fact_match_count
      FROM entities
      WHERE entities.repo_id = ?
        AND entities.updated_index_run_id = ?
        AND (
          entities.id LIKE ? ESCAPE '\\'
          OR entities.display_name LIKE ? ESCAPE '\\'
          OR COALESCE(entities.path, '') LIKE ? ESCAPE '\\'
          OR COALESCE(entities.symbol, '') LIKE ? ESCAPE '\\'
        )
      ORDER BY
        id_match DESC,
        path_match DESC,
        display_match DESC,
        symbol_match DESC,
        relation_match_count DESC,
        evidence_match_count DESC,
        CASE WHEN entities.kind = 'file' THEN 1 ELSE 0 END DESC,
        entities.display_name,
        entities.id
      LIMIT ?
    `)
    .all(
      likeQuery,
      likeQuery,
      likeQuery,
      likeQuery,
      repoId,
      indexRunId,
      likeQuery,
      likeQuery,
      likeQuery,
      likeQuery,
      searchContextStreamLimit
    ) as SearchEntityRow[];
}

function ftsMatchExpression(query: string): string | null {
  if (/[\\%_./:]/.test(query)) return null;
  const terms = query
    .toLocaleLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((term) => term.length > 0)
    .slice(0, 8);
  if (!terms || terms.length === 0) return null;
  return terms.map((term) => `${term}*`).join(' AND ');
}

function searchRelationEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  likeQuery: string
): SearchEntityRow[] {
  return db
    .prepare(`
      SELECT
        entities.id AS entity_id,
        entities.kind AS entity_kind,
        entities.path AS entity_path,
        entities.symbol AS entity_symbol,
        entities.language_id AS entity_language_id,
        entities.display_name AS entity_display_name,
        min(relations.kind) AS relation_kind_bucket,
        0 AS id_match,
        0 AS display_match,
        0 AS path_match,
        0 AS symbol_match,
        count(relations.id) AS relation_match_count,
        0 AS evidence_match_count,
        0 AS fact_match_count
      FROM entities
      INNER JOIN relations
        ON relations.repo_id = entities.repo_id
       AND relations.index_run_id = entities.updated_index_run_id
       AND (relations.source_entity_id = entities.id OR relations.target_entity_id = entities.id)
       AND (relations.kind LIKE ? ESCAPE '\\' OR relations.provenance LIKE ? ESCAPE '\\')
      WHERE entities.repo_id = ?
        AND entities.updated_index_run_id = ?
      GROUP BY entities.id
      ORDER BY relation_match_count DESC, entities.display_name, entities.id
      LIMIT ?
    `)
    .all(likeQuery, likeQuery, repoId, indexRunId, searchContextStreamLimit) as SearchEntityRow[];
}

function searchEvidenceEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  query: string,
  likeQuery: string,
  disabledStreams: ReadonlySet<SearchContextDisabledStream>
): SearchEntityRow[] {
  const ftsRows = disabledStreams.has('evidenceFts')
    ? []
    : searchEvidenceFtsEntityRows(db, repoId, indexRunId, query);
  if (ftsRows.length > 0) return ftsRows;
  return searchEvidenceLikeEntityRows(db, repoId, indexRunId, likeQuery);
}

function searchEvidenceFtsEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  query: string
): SearchEntityRow[] {
  if (!mcpHasTable(db, 'search_relation_evidence_fts')) return [];
  const ftsQuery = ftsMatchExpression(query);
  if (!ftsQuery) return [];
  try {
    return db
      .prepare(`
        WITH matches AS (
          SELECT evidence_id
          FROM search_relation_evidence_fts
          WHERE search_relation_evidence_fts MATCH ?
        )
        SELECT
          entities.id AS entity_id,
          entities.kind AS entity_kind,
          entities.path AS entity_path,
          entities.symbol AS entity_symbol,
          entities.language_id AS entity_language_id,
          entities.display_name AS entity_display_name,
          min(relations.kind) AS relation_kind_bucket,
          0 AS id_match,
          0 AS display_match,
          0 AS path_match,
          0 AS symbol_match,
          0 AS relation_match_count,
          count(DISTINCT evidence.id) AS evidence_match_count,
          0 AS fact_match_count
        FROM matches
        INNER JOIN relation_evidence evidence
          ON evidence.id = matches.evidence_id
        INNER JOIN relations
          ON relations.id = evidence.relation_id
         AND relations.repo_id = evidence.repo_id
         AND relations.index_run_id = evidence.index_run_id
        INNER JOIN entities
          ON entities.repo_id = relations.repo_id
         AND entities.updated_index_run_id = relations.index_run_id
         AND (entities.id = relations.source_entity_id OR entities.id = relations.target_entity_id)
        WHERE evidence.repo_id = ?
          AND evidence.index_run_id = ?
        GROUP BY entities.id
        ORDER BY evidence_match_count DESC, entities.display_name, entities.id
        LIMIT ?
      `)
      .all(ftsQuery, repoId, indexRunId, searchContextStreamLimit) as SearchEntityRow[];
  } catch {
    return [];
  }
}

function searchEvidenceLikeEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  likeQuery: string
): SearchEntityRow[] {
  return db
    .prepare(`
      SELECT
        entities.id AS entity_id,
        entities.kind AS entity_kind,
        entities.path AS entity_path,
        entities.symbol AS entity_symbol,
        entities.language_id AS entity_language_id,
        entities.display_name AS entity_display_name,
        min(relations.kind) AS relation_kind_bucket,
        0 AS id_match,
        0 AS display_match,
        0 AS path_match,
        0 AS symbol_match,
        0 AS relation_match_count,
        count(evidence.id) AS evidence_match_count,
        0 AS fact_match_count
      FROM entities
      INNER JOIN relations
        ON relations.repo_id = entities.repo_id
       AND relations.index_run_id = entities.updated_index_run_id
       AND (relations.source_entity_id = entities.id OR relations.target_entity_id = entities.id)
      INNER JOIN relation_evidence evidence
        ON evidence.relation_id = relations.id
       AND evidence.repo_id = relations.repo_id
       AND evidence.index_run_id = relations.index_run_id
       AND (
         evidence.file_path LIKE ? ESCAPE '\\'
         OR evidence.kind LIKE ? ESCAPE '\\'
         OR evidence.snippet LIKE ? ESCAPE '\\'
       )
      WHERE entities.repo_id = ?
        AND entities.updated_index_run_id = ?
      GROUP BY entities.id
      ORDER BY evidence_match_count DESC, entities.display_name, entities.id
      LIMIT ?
    `)
    .all(likeQuery, likeQuery, likeQuery, repoId, indexRunId, searchContextStreamLimit) as SearchEntityRow[];
}

function searchFactEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  query: string,
  disabledStreams: ReadonlySet<SearchContextDisabledStream>
): SearchEntityRow[] {
  if (disabledStreams.has('factsFts')) return [];
  if (!mcpHasTable(db, 'search_facts_fts')) return [];
  const ftsQuery = ftsMatchExpression(query);
  if (!ftsQuery) return [];
  try {
    return db
      .prepare(`
        WITH matches AS (
          SELECT fact_id
          FROM search_facts_fts
          WHERE search_facts_fts MATCH ?
        )
        SELECT
          entities.id AS entity_id,
          entities.kind AS entity_kind,
          entities.path AS entity_path,
          entities.symbol AS entity_symbol,
          entities.language_id AS entity_language_id,
          entities.display_name AS entity_display_name,
          NULL AS relation_kind_bucket,
          0 AS id_match,
          0 AS display_match,
          0 AS path_match,
          0 AS symbol_match,
          0 AS relation_match_count,
          0 AS evidence_match_count,
          count(DISTINCT facts.id) AS fact_match_count
        FROM matches
        INNER JOIN facts
          ON facts.id = matches.fact_id
        INNER JOIN transactions
          ON transactions.id = facts.tx_id
        INNER JOIN entities
          ON entities.id = facts.entity_id
         AND entities.repo_id = ?
         AND entities.updated_index_run_id = ?
        WHERE facts.op = 'assert'
          AND facts.redacted = 0
          AND (
            (
              transactions.archived = 0
              AND transactions.branch_id = (SELECT id FROM branches WHERE name = 'main')
            )
            OR EXISTS (
              SELECT 1
              FROM fact_provenance visibility_fp
              INNER JOIN transactions visibility_tx
                ON visibility_tx.id = visibility_fp.tx_id
              WHERE visibility_fp.fact_id = facts.id
                AND visibility_fp.kind = 'supersedes'
                AND visibility_tx.archived = 0
                AND visibility_tx.branch_id = (SELECT id FROM branches WHERE name = 'main')
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM fact_provenance supersession_fp
            INNER JOIN facts superseding_fact
              ON superseding_fact.id = supersession_fp.fact_id
            INNER JOIN transactions supersession_tx
              ON supersession_tx.id = supersession_fp.tx_id
            WHERE supersession_fp.source_fact_id = facts.id
              AND supersession_fp.kind = 'supersedes'
              AND superseding_fact.op = 'assert'
              AND supersession_tx.archived = 0
              AND supersession_tx.branch_id = (SELECT id FROM branches WHERE name = 'main')
          )
        GROUP BY entities.id
        ORDER BY fact_match_count DESC, entities.display_name, entities.id
        LIMIT ?
      `)
      .all(ftsQuery, repoId, indexRunId, searchContextStreamLimit) as SearchEntityRow[];
  } catch {
    return [];
  }
}

function searchSemanticEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  queryEmbedding: EmbeddingResult
): SearchEntityRow[] {
  const annRows = searchSemanticEntityRowsAnn(db, repoId, indexRunId, queryEmbedding);
  if (annRows !== null && annRows.length > 0) return annRows;
  return searchSemanticEntityRowsBruteForce(db, repoId, indexRunId, queryEmbedding);
}

function searchSemanticEntityRowsAnn(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  queryEmbedding: EmbeddingResult
): SearchEntityRow[] | null {
  if (!isVectorExtensionLoaded(db) || !hasVecTable(db, queryEmbedding.model)) return null;
  const tableName = vecTableName(queryEmbedding.model);
  const overFetch = Math.max(
    searchContextStreamLimit * searchContextSemanticOverFetchFactor,
    searchContextSemanticOverFetchMin
  );
  try {
    const rows = db
      .prepare(`
        WITH ranked AS (
          SELECT fact_id, distance
          FROM ${tableName}
          WHERE embedding MATCH vec_int8(?) AND k = ?
        )
        SELECT
          entities.id AS entity_id,
          entities.kind AS entity_kind,
          entities.path AS entity_path,
          entities.symbol AS entity_symbol,
          entities.language_id AS entity_language_id,
          entities.display_name AS entity_display_name,
          NULL AS relation_kind_bucket,
          min(ranked.distance) AS distance
        FROM ranked
        INNER JOIN facts
          ON facts.id = ranked.fact_id
        INNER JOIN transactions
          ON transactions.id = facts.tx_id
        INNER JOIN entities
          ON entities.id = facts.entity_id
         AND entities.repo_id = ?
         AND entities.updated_index_run_id = ?
        WHERE facts.op = 'assert'
          AND facts.redacted = 0
          AND (
            (
              transactions.archived = 0
              AND transactions.branch_id = (SELECT id FROM branches WHERE name = 'main')
            )
            OR EXISTS (
              SELECT 1
              FROM fact_provenance visibility_fp
              INNER JOIN transactions visibility_tx
                ON visibility_tx.id = visibility_fp.tx_id
              WHERE visibility_fp.fact_id = facts.id
                AND visibility_fp.kind = 'supersedes'
                AND visibility_tx.archived = 0
                AND visibility_tx.branch_id = (SELECT id FROM branches WHERE name = 'main')
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM fact_provenance supersession_fp
            INNER JOIN facts superseding_fact
              ON superseding_fact.id = supersession_fp.fact_id
            INNER JOIN transactions supersession_tx
              ON supersession_tx.id = supersession_fp.tx_id
            WHERE supersession_fp.source_fact_id = facts.id
              AND supersession_fp.kind = 'supersedes'
              AND superseding_fact.op = 'assert'
              AND supersession_tx.archived = 0
              AND supersession_tx.branch_id = (SELECT id FROM branches WHERE name = 'main')
          )
        GROUP BY entities.id
        ORDER BY distance ASC, entities.display_name, entities.id
        LIMIT ?
      `)
      .all(queryEmbedding.vector, overFetch, repoId, indexRunId, searchContextStreamLimit) as Array<
        SearchEntityRow & { distance: number }
      >;
    return rows.map((row) => ({
      entity_id: row.entity_id,
      entity_kind: row.entity_kind,
      entity_path: row.entity_path,
      entity_symbol: row.entity_symbol,
      entity_language_id: row.entity_language_id,
      entity_display_name: row.entity_display_name,
      relation_kind_bucket: null,
      id_match: 0,
      display_match: 0,
      path_match: 0,
      symbol_match: 0,
      relation_match_count: 0,
      evidence_match_count: 0,
      fact_match_count: 0
    }));
  } catch {
    return null;
  }
}

function searchSemanticEntityRowsBruteForce(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  queryEmbedding: EmbeddingResult
): SearchEntityRow[] {
  if (!mcpHasTable(db, 'fact_embeddings')) return [];
  const rows = db
    .prepare(`
      SELECT
        entities.id AS entity_id,
        entities.kind AS entity_kind,
        entities.path AS entity_path,
        entities.symbol AS entity_symbol,
        entities.language_id AS entity_language_id,
        entities.display_name AS entity_display_name,
        NULL AS relation_kind_bucket,
        fact_embeddings.vector AS vector
      FROM fact_embeddings
      INNER JOIN facts
        ON facts.id = fact_embeddings.fact_id
      INNER JOIN transactions
        ON transactions.id = facts.tx_id
      INNER JOIN entities
        ON entities.id = facts.entity_id
       AND entities.repo_id = ?
       AND entities.updated_index_run_id = ?
      WHERE fact_embeddings.model = ?
        AND fact_embeddings.dim = ?
        AND facts.op = 'assert'
        AND facts.redacted = 0
        AND (
          (
            transactions.archived = 0
            AND transactions.branch_id = (SELECT id FROM branches WHERE name = 'main')
          )
          OR EXISTS (
            SELECT 1
            FROM fact_provenance visibility_fp
            INNER JOIN transactions visibility_tx
              ON visibility_tx.id = visibility_fp.tx_id
            WHERE visibility_fp.fact_id = facts.id
              AND visibility_fp.kind = 'supersedes'
              AND visibility_tx.archived = 0
              AND visibility_tx.branch_id = (SELECT id FROM branches WHERE name = 'main')
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM fact_provenance supersession_fp
          INNER JOIN facts superseding_fact
            ON superseding_fact.id = supersession_fp.fact_id
          INNER JOIN transactions supersession_tx
            ON supersession_tx.id = supersession_fp.tx_id
          WHERE supersession_fp.source_fact_id = facts.id
            AND supersession_fp.kind = 'supersedes'
            AND superseding_fact.op = 'assert'
            AND supersession_tx.archived = 0
            AND supersession_tx.branch_id = (SELECT id FROM branches WHERE name = 'main')
        )
    `)
    .all(repoId, indexRunId, queryEmbedding.model, queryEmbedding.dim) as Array<
      SearchEntityRow & { vector: Buffer }
    >;

  const queryVector = int8Vector(queryEmbedding.vector);
  const bestByEntity = new Map<string, { row: SearchEntityRow; score: number }>();
  for (const row of rows) {
    const score = int8DotScore(queryVector, int8Vector(row.vector));
    const existing = bestByEntity.get(row.entity_id);
    if (!existing || score > existing.score) {
      bestByEntity.set(row.entity_id, {
        row: {
          entity_id: row.entity_id,
          entity_kind: row.entity_kind,
          entity_path: row.entity_path,
          entity_symbol: row.entity_symbol,
          entity_language_id: row.entity_language_id,
          entity_display_name: row.entity_display_name,
          relation_kind_bucket: null,
          id_match: 0,
          display_match: 0,
          path_match: 0,
          symbol_match: 0,
          relation_match_count: 0,
          evidence_match_count: 0,
          fact_match_count: 0
        },
        score
      });
    }
  }

  return [...bestByEntity.values()]
    .sort((left, right) =>
      numericCompare(right.score, left.score)
      || left.row.entity_display_name.localeCompare(right.row.entity_display_name)
      || left.row.entity_id.localeCompare(right.row.entity_id)
    )
    .slice(0, searchContextStreamLimit)
    .map((entry) => entry.row);
}

function searchGraphProximityEntityRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  seedRows: SearchEntityRow[],
  k: number
): SearchEntityRow[] {
  const seedIds = [...new Set(seedRows.map((row) => row.entity_id))].slice(0, searchContextGraphSeedLimit);
  if (seedIds.length === 0) return [];

  const best = new Map<string, { row: SearchEntityRow; seedRank: number; relationCount: number }>();
  const neighborRows = db
    .prepare(`
      SELECT
        relations.source_entity_id AS source_id,
        relations.target_entity_id AS target_id,
        neighbor.id AS entity_id,
        neighbor.kind AS entity_kind,
        neighbor.path AS entity_path,
        neighbor.symbol AS entity_symbol,
        neighbor.language_id AS entity_language_id,
        neighbor.display_name AS entity_display_name,
        min(relations.kind) AS relation_kind_bucket,
        count(relations.id) AS relation_match_count,
        0 AS evidence_match_count,
        0 AS fact_match_count
      FROM relations
      INNER JOIN entities seed
        ON seed.repo_id = relations.repo_id
       AND seed.updated_index_run_id = relations.index_run_id
       AND (seed.id = relations.source_entity_id OR seed.id = relations.target_entity_id)
      INNER JOIN entities neighbor
        ON neighbor.repo_id = relations.repo_id
       AND neighbor.updated_index_run_id = relations.index_run_id
       AND neighbor.id = CASE
         WHEN seed.id = relations.source_entity_id THEN relations.target_entity_id
         ELSE relations.source_entity_id
       END
      WHERE relations.repo_id = ?
        AND relations.index_run_id = ?
        AND seed.id = ?
        AND neighbor.id <> seed.id
      GROUP BY neighbor.id
      ORDER BY relation_match_count DESC, neighbor.display_name, neighbor.id
      LIMIT ?
    `);

  seedIds.forEach((seedId, index) => {
    const rows = neighborRows.all(repoId, indexRunId, seedId, Math.max(k * 3, 10)) as Array<SearchEntityRow>;
    for (const row of rows) {
      if (seedIds.includes(row.entity_id)) continue;
      const existing = best.get(row.entity_id);
      const relationCount = row.relation_match_count;
      if (
        !existing
        || index < existing.seedRank
        || (index === existing.seedRank && relationCount > existing.relationCount)
      ) {
        best.set(row.entity_id, {
          row: {
            ...row,
            id_match: 0,
            display_match: 0,
            path_match: 0,
            symbol_match: 0,
            evidence_match_count: 0,
            fact_match_count: 0
          },
          seedRank: index,
          relationCount
        });
      }
    }
  });

  return [...best.values()]
    .sort((left, right) =>
      numericCompare(left.seedRank, right.seedRank)
      || numericCompare(right.relationCount, left.relationCount)
      || left.row.entity_display_name.localeCompare(right.row.entity_display_name)
      || left.row.entity_id.localeCompare(right.row.entity_id)
    )
    .slice(0, searchContextStreamLimit)
    .map((entry) => entry.row);
}

function int8Vector(value: Buffer): Int8Array {
  return new Int8Array(value.buffer, value.byteOffset, value.byteLength);
}

function int8DotScore(left: Int8Array, right: Int8Array): number {
  const len = Math.min(left.length, right.length);
  let total = 0;
  for (let index = 0; index < len; index += 1) {
    total += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return total;
}

function searchEvidenceRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  entityId: string,
  likeQuery: string,
  limit: number
): SearchEvidenceRow[] {
  if (limit <= 0) return [];
  const spanColumns = evidenceSpanColumnSelect(db, 'evidence');
  return db
    .prepare(`
      SELECT
        evidence.id AS evidence_id,
        evidence.relation_id AS relation_id,
        evidence.file_path AS evidence_file_path,
        evidence.kind AS evidence_kind,
        evidence.snippet AS evidence_snippet,
        evidence.confidence AS evidence_confidence,
        ${spanColumns},
        CASE
          WHEN evidence.file_path LIKE ? ESCAPE '\\'
            OR evidence.kind LIKE ? ESCAPE '\\'
            OR evidence.snippet LIKE ? ESCAPE '\\'
          THEN 1 ELSE 0
        END AS query_match
      FROM relation_evidence evidence
      INNER JOIN relations
        ON relations.id = evidence.relation_id
       AND relations.repo_id = evidence.repo_id
       AND relations.index_run_id = evidence.index_run_id
      WHERE evidence.repo_id = ?
        AND evidence.index_run_id = ?
        AND (relations.source_entity_id = ? OR relations.target_entity_id = ?)
      ORDER BY query_match DESC, evidence.file_path, evidence.kind, evidence.id
      LIMIT ?
    `)
    .all(likeQuery, likeQuery, likeQuery, repoId, indexRunId, entityId, entityId, limit) as SearchEvidenceRow[];
}

function searchEntityReasons(candidate: SearchCandidate): string[] {
  const row = candidate.row;
  const reasons: string[] = [];
  if (candidate.keywordRank !== null) reasons.push('keyword');
  if (row.id_match > 0) reasons.push('entity-id');
  if (row.path_match > 0) reasons.push('path');
  if (row.display_match > 0) reasons.push('display-name');
  if (row.symbol_match > 0) reasons.push('symbol');
  if (row.relation_match_count > 0) reasons.push(`relations:${row.relation_match_count}`);
  if (row.evidence_match_count > 0) reasons.push(`evidence:${row.evidence_match_count}`);
  if (row.fact_match_count > 0) reasons.push(`facts:${row.fact_match_count}`);
  if (candidate.semanticRank !== null) reasons.push('semantic');
  if (candidate.graphProximityRank !== null) reasons.push('graph-proximity');
  return reasons;
}

function entityFromSearchRow(row: SearchEntityRow): EntityRef {
  return {
    id: row.entity_id,
    kind: row.entity_kind as EntityRef['kind'],
    ...(row.entity_path !== null ? { path: row.entity_path } : {}),
    ...(row.entity_symbol !== null ? { symbol: row.entity_symbol } : {}),
    ...(row.entity_language_id !== null ? { languageId: row.entity_language_id } : {}),
    displayName: row.entity_display_name
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function explainEntity(context: McpContext, options: EntityExplainOptions): unknown {
  return withReadOnlyDb(context, (db, repoId) => {
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const entity = db
      .prepare(`
        SELECT id, kind, path, symbol, language_id, display_name
        FROM entities
        WHERE repo_id = ? AND id = ? AND updated_index_run_id = ?
      `)
      .get(repoId, options.entityId, indexRunId) as ExplainEntityRow | undefined;
    if (!entity) throw typedMcpError(new Error(`impact entity not found: ${options.entityId}`), 'resource_not_found');

    const incomingCount = relationCount(db, repoId, indexRunId, 'target_entity_id', options.entityId);
    const outgoingCount = relationCount(db, repoId, indexRunId, 'source_entity_id', options.entityId);
    const incomingRows = explainRelationRows(db, repoId, indexRunId, 'target_entity_id', options.entityId, options.relationLimit);
    const outgoingRows = explainRelationRows(db, repoId, indexRunId, 'source_entity_id', options.entityId, options.relationLimit);
    const selectedRelationIds = [...incomingRows, ...outgoingRows].map((row) => row.relation_id);
    const evidenceRows = explainEvidenceRows(db, repoId, indexRunId, selectedRelationIds, options.evidenceLimit + 1);
    const evidenceCount = explainEvidenceCount(db, repoId, indexRunId, selectedRelationIds);
    const selectedEvidenceRows = evidenceRows.slice(0, options.evidenceLimit);
    const evidenceByRelation = new Map<string, CompactEvidenceResource[]>();
    for (const row of selectedEvidenceRows) {
      const item = compactEvidenceResource(row);
      const bucket = evidenceByRelation.get(row.relation_id) ?? [];
      bucket.push(item);
      evidenceByRelation.set(row.relation_id, bucket);
    }
    const evidenceUris = selectedEvidenceRows.map((row) => evidenceResourceUri(row.evidence_id));

    return {
      entity: entityFromExplainRow(entity),
      indexRunId,
      relations: {
        incoming: incomingRows.map((row) => explainRelation(row, evidenceByRelation)),
        outgoing: outgoingRows.map((row) => explainRelation(row, evidenceByRelation))
      },
      resources: {
        entity: entityResourceUri(entityFromExplainRow(entity)),
        evidence: [...new Set(evidenceUris)].sort()
      },
      limits: {
        relationLimit: options.relationLimit,
        evidenceLimit: options.evidenceLimit,
        snippetChars: 300,
        incomingTruncated: incomingCount > options.relationLimit,
        outgoingTruncated: outgoingCount > options.relationLimit,
        evidenceTruncated: evidenceCount > options.evidenceLimit
      },
      counts: {
        incoming: incomingCount,
        outgoing: outgoingCount,
        evidence: evidenceCount
      }
    };
  });
}

function relationCount(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  column: 'source_entity_id' | 'target_entity_id',
  entityId: string
): number {
  const row = db
    .prepare(`SELECT count(*) AS count FROM relations WHERE repo_id = ? AND index_run_id = ? AND ${column} = ?`)
    .get(repoId, indexRunId, entityId) as { count: number };
  return row.count;
}

function explainRelationRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  column: 'source_entity_id' | 'target_entity_id',
  entityId: string,
  limit: number
): ExplainRelationRow[] {
  return db
    .prepare(`
      SELECT
        relations.id AS relation_id,
        relations.kind AS relation_kind,
        relations.confidence AS relation_confidence,
        relations.provenance AS relation_provenance,
        source.id AS source_id,
        source.kind AS source_kind,
        source.path AS source_path,
        source.symbol AS source_symbol,
        source.language_id AS source_language_id,
        source.display_name AS source_display_name,
        target.id AS target_id,
        target.kind AS target_kind,
        target.path AS target_path,
        target.symbol AS target_symbol,
        target.language_id AS target_language_id,
        target.display_name AS target_display_name
      FROM relations
      INNER JOIN entities source ON source.id = relations.source_entity_id AND source.repo_id = relations.repo_id
      INNER JOIN entities target ON target.id = relations.target_entity_id AND target.repo_id = relations.repo_id
      WHERE relations.repo_id = ?
        AND relations.index_run_id = ?
        AND relations.${column} = ?
      ORDER BY relations.kind, source.display_name, target.display_name, relations.id
      LIMIT ?
    `)
    .all(repoId, indexRunId, entityId, limit) as ExplainRelationRow[];
}

function explainEvidenceRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  relationIds: string[],
  limit: number
): ExplainEvidenceRow[] {
  if (relationIds.length === 0 || limit <= 0) return [];
  const placeholders = relationIds.map(() => '?').join(', ');
  const spanColumns = evidenceSpanColumnSelect(db, 'evidence');
  return db
    .prepare(`
      SELECT
        evidence.id AS evidence_id,
        evidence.relation_id AS relation_id,
        evidence.file_path AS evidence_file_path,
        evidence.kind AS evidence_kind,
        evidence.snippet AS evidence_snippet,
        evidence.confidence AS evidence_confidence,
        ${spanColumns}
      FROM relation_evidence evidence
      WHERE evidence.repo_id = ?
        AND evidence.index_run_id = ?
        AND evidence.relation_id IN (${placeholders})
      ORDER BY evidence.file_path, evidence.kind, evidence.id
      LIMIT ?
    `)
    .all(repoId, indexRunId, ...relationIds, limit) as ExplainEvidenceRow[];
}

function explainEvidenceCount(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  relationIds: string[]
): number {
  if (relationIds.length === 0) return 0;
  const placeholders = relationIds.map(() => '?').join(', ');
  const row = db
    .prepare(`
      SELECT count(*) AS count
      FROM relation_evidence
      WHERE repo_id = ?
        AND index_run_id = ?
        AND relation_id IN (${placeholders})
    `)
    .get(repoId, indexRunId, ...relationIds) as { count: number };
  return row.count;
}

function explainRelation(
  row: ExplainRelationRow,
  evidenceByRelation: ReadonlyMap<string, CompactEvidenceResource[]>
): unknown {
  return {
    id: row.relation_id,
    kind: row.relation_kind,
    confidence: asConfidence(row.relation_confidence),
    provenance: row.relation_provenance,
    sourceEntity: entityFromExplainRelationRow(row, 'source'),
    targetEntity: entityFromExplainRelationRow(row, 'target'),
    evidence: evidenceByRelation.get(row.relation_id) ?? []
  };
}

function compactEvidenceResource(row: ExplainEvidenceRow, snippetChars = 300): CompactEvidenceResource {
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

function entityFromExplainRow(row: ExplainEntityRow): EntityRef {
  return {
    id: row.id,
    kind: row.kind as EntityRef['kind'],
    ...(row.path !== null ? { path: row.path } : {}),
    ...(row.symbol !== null ? { symbol: row.symbol } : {}),
    ...(row.language_id !== null ? { languageId: row.language_id } : {}),
    displayName: row.display_name
  };
}

function entityFromExplainRelationRow(row: ExplainRelationRow, prefix: 'source' | 'target'): EntityRef {
  const id = prefix === 'source' ? row.source_id : row.target_id;
  const kind = prefix === 'source' ? row.source_kind : row.target_kind;
  const filePath = prefix === 'source' ? row.source_path : row.target_path;
  const symbol = prefix === 'source' ? row.source_symbol : row.target_symbol;
  const languageId = prefix === 'source' ? row.source_language_id : row.target_language_id;
  const displayName = prefix === 'source' ? row.source_display_name : row.target_display_name;
  return {
    id,
    kind: kind as EntityRef['kind'],
    ...(filePath !== null ? { path: filePath } : {}),
    ...(symbol !== null ? { symbol } : {}),
    ...(languageId !== null ? { languageId } : {}),
    displayName
  };
}

function readEvidence(context: McpContext, evidenceId: string): unknown {
  return withReadOnlyDb(context, (db, repoId) => {
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const spanColumns = evidenceSpanColumnSelect(db, 'evidence');
    const row = db
      .prepare(`
        SELECT
          evidence.id AS evidence_id,
          evidence.file_path AS evidence_file_path,
          evidence.kind AS evidence_kind,
          evidence.snippet AS evidence_snippet,
          evidence.confidence AS evidence_confidence,
          evidence.index_run_id AS evidence_index_run_id,
          ${spanColumns},
          relations.id AS relation_id,
          relations.kind AS relation_kind,
          relations.confidence AS relation_confidence,
          relations.provenance AS relation_provenance,
          source.id AS source_id,
          source.kind AS source_kind,
          source.path AS source_path,
          source.symbol AS source_symbol,
          source.language_id AS source_language_id,
          source.display_name AS source_display_name,
          target.id AS target_id,
          target.kind AS target_kind,
          target.path AS target_path,
          target.symbol AS target_symbol,
          target.language_id AS target_language_id,
          target.display_name AS target_display_name
        FROM relation_evidence evidence
        INNER JOIN relations
          ON relations.id = evidence.relation_id
         AND relations.repo_id = evidence.repo_id
         AND relations.index_run_id = evidence.index_run_id
        INNER JOIN entities source
          ON source.id = relations.source_entity_id
         AND source.repo_id = evidence.repo_id
         AND source.updated_index_run_id = evidence.index_run_id
        INNER JOIN entities target
          ON target.id = relations.target_entity_id
         AND target.repo_id = evidence.repo_id
         AND target.updated_index_run_id = evidence.index_run_id
        WHERE evidence.repo_id = ? AND evidence.id = ? AND evidence.index_run_id = ?
      `)
      .get(repoId, evidenceId, indexRunId) as EvidenceResourceRow | undefined;
    if (!row) throw typedMcpError(new Error(`impact evidence not found: ${evidenceId}`), 'resource_not_found');
    return {
      id: row.evidence_id,
      file: row.evidence_file_path,
      kind: row.evidence_kind,
      snippet: redactSecrets(row.evidence_snippet),
      confidence: asConfidence(row.evidence_confidence),
      ...(row.evidence_start_line !== null ? { startLine: row.evidence_start_line } : {}),
      ...(row.evidence_end_line !== null ? { endLine: row.evidence_end_line } : {}),
      ...(row.evidence_start_col !== null ? { startCol: row.evidence_start_col } : {}),
      ...(row.evidence_end_col !== null ? { endCol: row.evidence_end_col } : {}),
      relation: {
        id: row.relation_id,
        kind: row.relation_kind,
        confidence: asConfidence(row.relation_confidence),
        provenance: row.relation_provenance
      },
      sourceEntity: row.source_id ? entityFromEvidenceRow(row, 'source') : null,
      targetEntity: row.target_id ? entityFromEvidenceRow(row, 'target') : null,
      indexRunId: row.evidence_index_run_id
    };
  });
}

function evidenceSpanColumnSelect(db: ReturnType<typeof openDatabase>, alias: string): string {
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

function mcpHasColumn(db: ReturnType<typeof openDatabase>, table: string, column: string): boolean {
  return db
    .prepare('SELECT 1 AS one FROM pragma_table_info(?) WHERE name = ?')
    .get(table, column) !== undefined;
}

function mcpHasTable(db: ReturnType<typeof openDatabase>, table: string): boolean {
  return db
    .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) !== undefined;
}

function entityFromEvidenceRow(row: EvidenceResourceRow, prefix: 'source' | 'target'): EntityRef {
  const id = prefix === 'source' ? row.source_id! : row.target_id!;
  const kind = prefix === 'source' ? row.source_kind! : row.target_kind!;
  const path = prefix === 'source' ? row.source_path : row.target_path;
  const symbol = prefix === 'source' ? row.source_symbol : row.target_symbol;
  const languageId = prefix === 'source' ? row.source_language_id : row.target_language_id;
  const displayName = prefix === 'source' ? row.source_display_name : row.target_display_name;
  return {
    id,
    kind: kind as EntityRef['kind'],
    ...(path !== null ? { path } : {}),
    ...(symbol !== null ? { symbol } : {}),
    ...(languageId !== null ? { languageId } : {}),
    displayName: displayName ?? id
  };
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

function withWritableDb<T>(
  context: McpContext,
  callback: (db: ReturnType<typeof openDatabase>, repoId: number) => T,
  options: { skipProjectionRepair?: boolean } = {}
): T {
  const repoRoot = normalizeRepoRoot(context.repoRoot);
  const db = openDatabase(repoRoot, { readOnly: false, skipProjectionRepair: options.skipProjectionRepair === true });
  try {
    const repoId = getRepoId(db, repoRoot);
    return callback(db, repoId);
  } finally {
    db.close();
  }
}

function parseGraphFormat(value: string): GraphExportFormat {
  if (value === 'json' || value === 'mermaid' || value === 'dot') return value;
  throw typedMcpError(new Error('graph resource format must be mermaid, json, or dot'), 'invalid_resource_format');
}

function asConfidence(value: string): Confidence {
  if (value === 'proven' || value === 'inferred' || value === 'heuristic' || value === 'unknown') return value;
  return 'unknown';
}
