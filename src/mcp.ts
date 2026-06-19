import { randomUUID } from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createBranch, mergeBranches, recallOnRepo, rememberOnRepo, trace } from './agent_memory.js';
import type { RememberValue } from './agent_memory.js';
import { abandonBranch, gcBranches, restoreBranch } from './branch_gc.js';
import { envValue } from './branding.js';
import {
  buildContextPack,
  changedFileContentHash,
  contextBudgetPreset,
  contextPackReference,
  contextPackResourceUri,
  normalizeContextBudget,
  normalizeContextPackReusePolicy
} from './context_pack.js';
import type { PersistedContextPack } from './context_pack.js';
import { doctorProject, redactDoctorReportForMcp } from './doctor.js';
import { executeGraphQuery } from './graph_query.js';
import { readGitSnapshot } from './git-snapshot.js';
import { reflectFacts, repairReflections } from './reflection.js';
import { profileEntity } from './profile.js';
import { normalizeRepoRoot, redactSecrets } from './security.js';
import {
  byteLength,
  isRecord,
  mcpHasTable,
  parseJsonObject,
  typedMcpError,
  typedMcpErrorEnvelope,
  withReadOnlyDb
} from './mcp_shared.js';
import {
  explainEntity,
  graphFormatVariable,
  graphResourceText,
  listContextPackResources,
  listEntityResources,
  listEvidenceResources,
  listGraphResources,
  listReportResources,
  listWorkspaceContractResources,
  listWorkspaceCrossRepoLinkResources,
  listWorkspaceResources,
  parseGraphFormat,
  readContextPack,
  readEntity,
  readEvidence,
  readLatestCoverage,
  readReport,
  readWorkspaceContractsResource,
  readWorkspaceCrossRepoLinksResource,
  readWorkspaceResource,
  workspaceResources
} from './mcp_resources.js';
import { searchContext, searchContextSemanticEmbedding } from './mcp_search.js';
export { searchContextForRepo } from './mcp_search.js';
export type { SearchContextForRepoOptions } from './mcp_search.js';
import {
  contentHash,
  getRepoId,
  openDatabase
} from './store.js';
import type {
  ContextPack,
  Evidence,
  ImpactAction,
  ImpactReport
} from './types.js';

export type McpContext = {
  repoRoot: string;
};

export function createMcpServer(context: McpContext): McpServer {
  const server = new McpServer({
    name: 'parallax',
    version: '0.1.0'
  });
  patchToolErrorFactory(server);

  server.registerTool(
    'parallax_analyze_diff',
    {
      title: 'Analyze Parallax diff',
      description: 'Analyze changed files against the latest completed Parallax index.',
      inputSchema: {
        changedFiles: z.array(z.string()).min(1),
        maxDepth: z.number().int().min(1).max(8).optional(),
        maxFanout: z.number().int().min(1).max(2_000).optional()
      },
      annotations: {
        title: 'Analyze Parallax diff',
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
        return toolJsonResponse(context, 'parallax_analyze_diff', report, {
          indexRunId: report.indexRunId,
          changedFiles: report.changedFiles
        });
      } catch (error) {
        return typedToolErrorResponse(error);
      }
    }
  );

  server.registerTool(
    'parallax_context_for_change',
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
        const pack = buildContextPack(
          report,
          normalizedBudget,
          indexRunAsOfIso(context, report.indexRunId)
        );
        const persisted = persistContextPackForReuse(context, pack, {
          changedFiles: report.changedFiles,
          maxDepth: maxDepth ?? preset.maxDepth,
          maxFanout: maxFanout ?? preset.maxFanout
        });
        const response =
          normalizedReusePolicy === 'reference' || (normalizedReusePolicy === 'auto' && persisted.wasReused)
            ? contextPackReference(persisted.pack, report.changedFiles, persisted.fullBytes)
            : persisted.pack;
        return toolJsonResponse(context, 'parallax_context_for_change', response, {
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
    'parallax_search_context',
    {
      title: 'Search indexed context',
      description:
        'Search the latest Parallax index by keyword, path, symbol, relation provenance, or evidence snippet and return ranked entity context with resource links.',
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
        return toolJsonResponse(context, 'parallax_search_context', result, {
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
    'parallax_contract_diff',
    {
      title: 'Analyze workspace contract diff',
      description:
        'Compare a current OpenAPI contract file against the latest indexed workspace baseline and return compact breaking-change impact with workspace resource links.',
      inputSchema: {
        contractPath: z.string().trim().min(1),
        workspaceName: z.string().trim().min(1).optional(),
        providerServiceName: z.string().trim().min(1).optional(),
        providerRepoPath: z.string().trim().min(1).optional(),
        persist: z.boolean().optional()
      },
      annotations: {
        title: 'Analyze workspace contract diff',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ contractPath, workspaceName, providerServiceName, providerRepoPath, persist }) => {
      try {
        const { analyzeContractDiff } = await import('./contract_diff.js');
        const diff = analyzeContractDiff({
          repoRoot: context.repoRoot,
          contractPath,
          ...(workspaceName !== undefined ? { workspaceName } : {}),
          ...(providerServiceName !== undefined ? { providerServiceName } : {}),
          ...(providerRepoPath !== undefined ? { providerRepoPath } : {}),
          ...(persist !== undefined ? { persist } : {})
        });
        const response = {
          ...diff,
          resources: workspaceResources(diff.workspace.name)
        };
        return toolJsonResponse(context, 'parallax_contract_diff', response, {
          indexRunId: diff.contract.indexRunId,
          query: contractPath,
          resourceCount: resourceCountOf(response)
        });
      } catch (error) {
        return typedToolErrorResponse(error);
      }
    }
  );

  server.registerTool(
    'parallax_remember',
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
    'parallax_recall',
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
    'parallax_query',
    {
      title: 'Query the graph',
      description:
        'Run a read-only Cypher subset over the indexed entity/relation graph: a single optional relationship hop, node labels, WHERE equality/CONTAINS, projection, and LIMIT. Write, procedure, projection (WITH/UNWIND), and reverse-direction clauses are rejected.',
      inputSchema: {
        query: z.string().min(1)
      },
      annotations: {
        title: 'Query the graph',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ query }) => {
      const result = executeGraphQuery(context.repoRoot, query);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    'parallax_branch',
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
    'parallax_merge',
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
    'parallax_reflect',
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
    'parallax_abandon_branch',
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
    'parallax_gc_branches',
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
    'parallax_profile',
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
    'parallax_explain_entity',
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
        return toolJsonResponse(context, 'parallax_explain_entity', result, {
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
    'parallax_context_telemetry',
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
    'parallax_doctor',
    {
      title: 'Inspect Parallax health',
      description:
        'Return a read-only local health report covering database schema, latest index, coverage, adapter runs, vector state, and context telemetry availability.',
      inputSchema: {},
      annotations: {
        title: 'Inspect Parallax health',
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
    'parallax_repair_reflections',
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
    'parallax_restore_branch',
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
    'parallax_trace',
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
    'parallax_reports',
    new ResourceTemplate('parallax://reports/{reportId}', {
      list: () => ({ resources: listReportResources(context) })
    }),
    {
      title: 'Parallax Reports',
      description: 'Persisted Parallax report JSON documents.',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const reportId = String(variables.reportId);
      return telemetryJsonResource(context, uri.toString(), 'report', reportId, readReport(context, reportId));
    }
  );

  server.registerResource(
    'parallax_entities',
    new ResourceTemplate('parallax://entities/{entityId}', {
      list: () => ({ resources: listEntityResources(context) })
    }),
    {
      title: 'Parallax Entities',
      description: 'Canonical indexed entities from the latest completed index run.',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const entityId = decodeURIComponent(String(variables.entityId));
      return telemetryJsonResource(context, uri.toString(), 'entity', entityId, readEntity(context, entityId));
    }
  );

  server.registerResource(
    'parallax_evidence',
    new ResourceTemplate('parallax://evidence/{evidenceId}', {
      list: () => ({ resources: listEvidenceResources(context) })
    }),
    {
      title: 'Parallax Evidence',
      description: 'Relation evidence with source span, redacted snippet, and source/target relation context.',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const evidenceId = decodeURIComponent(String(variables.evidenceId));
      return telemetryJsonResource(context, uri.toString(), 'evidence', evidenceId, readEvidence(context, evidenceId));
    }
  );

  server.registerResource(
    'parallax_context_packs',
    new ResourceTemplate('parallax://context-packs/{contextPackId}', {
      list: () => ({ resources: listContextPackResources(context) })
    }),
    {
      title: 'Parallax Context Packs',
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
    'parallax_workspaces',
    new ResourceTemplate('parallax://workspaces/{workspaceName}', {
      list: () => ({ resources: listWorkspaceResources(context) })
    }),
    {
      title: 'Parallax Workspaces',
      description: 'Workspace catalog membership and compact links to contract and cross-repo impact resources.',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const workspaceName = decodeURIComponent(String(variables.workspaceName));
      return telemetryJsonResource(
        context,
        uri.toString(),
        'workspace',
        workspaceName,
        readWorkspaceResource(context, workspaceName)
      );
    }
  );

  server.registerResource(
    'parallax_workspace_contracts',
    new ResourceTemplate('parallax://workspaces/{workspaceName}/contracts', {
      list: () => ({ resources: listWorkspaceContractResources(context) })
    }),
    {
      title: 'Parallax Workspace Contracts',
      description: 'Latest indexed contract baselines across the local workspace catalog.',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const workspaceName = decodeURIComponent(String(variables.workspaceName));
      return telemetryJsonResource(
        context,
        uri.toString(),
        'workspace_contracts',
        workspaceName,
        readWorkspaceContractsResource(context, workspaceName)
      );
    }
  );

  server.registerResource(
    'parallax_workspace_cross_repo_links',
    new ResourceTemplate('parallax://workspaces/{workspaceName}/cross-repo-links', {
      list: () => ({ resources: listWorkspaceCrossRepoLinkResources(context) })
    }),
    {
      title: 'Parallax Workspace Cross-Repo Links',
      description: 'Workspace-scoped provider/consumer and breaking contract impact links.',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const workspaceName = decodeURIComponent(String(variables.workspaceName));
      return telemetryJsonResource(
        context,
        uri.toString(),
        'workspace_cross_repo_links',
        workspaceName,
        readWorkspaceCrossRepoLinksResource(context, workspaceName)
      );
    }
  );

  server.registerResource(
    'parallax_graphs',
    new ResourceTemplate('parallax://reports/{reportId}/graph/{format}', {
      list: () => ({ resources: listGraphResources(context) })
    }),
    {
      title: 'Parallax Graphs',
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
    'parallax_coverage_latest',
    'parallax://coverage/latest',
    {
      title: 'Parallax Latest Coverage',
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

function indexRunAsOfIso(context: McpContext, indexRunId: number): string {
  return withReadOnlyDb(context, (db, repoId) => {
    const row = db
      .prepare('SELECT started_at, finished_at FROM index_runs WHERE repo_id = ? AND id = ?')
      .get(repoId, indexRunId) as { started_at: string; finished_at: string | null } | undefined;
    return row?.finished_at ?? row?.started_at ?? '';
  });
}

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

const CONTEXT_PACK_CACHE_VERSION = 'context-pack-cache-v2';

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

type ToolResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
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
    if (envValue('TELEMETRY_FORCE_FAILURE') === '1') {
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

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
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
