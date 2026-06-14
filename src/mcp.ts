import { randomUUID } from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createBranch, mergeBranches, recallOnRepo, rememberOnRepo, trace } from './agent_memory.js';
import type { RememberValue } from './agent_memory.js';
import { abandonBranch, gcBranches, restoreBranch } from './branch_gc.js';
import { envValue } from './branding.js';
import { asConfidence } from './confidence.js';
import {
  buildContextPack,
  changedFileContentHash,
  contextBudgetPreset,
  contextPackReference,
  contextPackResourceUri,
  entityResourceUri,
  evidenceResourceUri,
  normalizeContextBudget,
  normalizeContextPackReusePolicy
} from './context_pack.js';
import type { PersistedContextPack } from './context_pack.js';
import type { EventTopologyProvenance } from './contract_diff.js';
import { doctorProject, redactDoctorReportForMcp } from './doctor.js';
import { readGitSnapshot } from './git-snapshot.js';
import { reflectFacts, repairReflections } from './reflection.js';
import { profileEntity } from './profile.js';
import { normalizeRepoRoot, redactSecrets } from './security.js';
import {
  byteLength,
  compactEvidenceResource,
  evidenceSpanColumnSelect,
  mcpHasTable,
  withReadOnlyDb
} from './mcp_shared.js';
import type { CompactEvidenceResource, ExplainEvidenceRow } from './mcp_shared.js';
import { searchContext, searchContextSemanticEmbedding } from './mcp_search.js';
export { searchContextForRepo } from './mcp_search.js';
export type { SearchContextForRepoOptions } from './mcp_search.js';
import {
  contentHash,
  getRepoId,
  latestCompletedIndexRun,
  openDatabase
} from './store.js';
import type {
  ContextPack,
  EntityRef,
  Evidence,
  GraphExport,
  GraphExportFormat,
  ImpactAction,
  ImpactReport
} from './types.js';
import { listWorkspaces } from './workspace.js';

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

function typedMcpError(error: unknown, fallbackCode = 'parallax_error'): Error {
  return new Error(JSON.stringify(typedMcpErrorEnvelope(error, fallbackCode)));
}

function typedMcpErrorEnvelope(error: unknown, fallbackCode = 'parallax_error'): TypedMcpErrorEnvelope {
  const message = errorMessage(error);
  const existing = parseTypedMcpError(message);
  if (existing) return existing;

  const normalized = message.toLowerCase();
  let code = fallbackCode;
  let cause = 'Parallax could not complete the requested MCP operation.';
  let fix = 'Check the request arguments, refresh the local index if needed, then retry the MCP call.';

  if (normalized.includes('outside repo root') || normalized.includes('resolves outside')) {
    code = 'path_outside_repo';
    cause = 'A requested path resolves outside the current repository root.';
    fix = 'Use a repo-relative path inside the current repository and rerun the request.';
  } else if (normalized.includes('not found')) {
    code = 'resource_not_found';
    cause = 'The requested Parallax resource was not found in the local index or report store.';
    fix = 'Refresh resources/list, rerun index/analyze if needed, and use a current resource URI.';
  } else if (normalized.includes('graph resource format')) {
    code = 'invalid_resource_format';
    cause = 'The graph resource format is not one of the formats Parallax can render.';
    fix = 'Use one of: mermaid, json, dot.';
  } else if (normalized.includes('graph page limit') || normalized.includes('graph page cursor')) {
    code = 'invalid_pagination';
    cause = 'The graph JSON resource pagination query is malformed.';
    fix = 'Use a positive integer limit up to 500 and pass cursor values returned by the previous page.';
  } else if (
    normalized.includes('search query must not be empty') ||
    (normalized.includes('parallax_search_context') && normalized.includes('query') && normalized.includes('too small'))
  ) {
    code = 'empty_search_query';
    cause = 'The search context tool received an empty query after trimming whitespace.';
    fix = 'Provide a non-empty keyword, path, symbol, relation kind, or evidence snippet.';
  } else if (normalized.includes('no completed index found') || normalized.includes('repo is not indexed')) {
    code = 'index_not_ready';
    cause = 'The repository does not have a completed Parallax index yet.';
    fix = 'Run parallax init and parallax index, then retry the MCP request.';
  } else if (normalized.includes('requires parallax schema v') || normalized.includes('database schema is v')) {
    code = 'schema_outdated';
    cause = 'The local Parallax database is older than the current tool contract.';
    fix = 'Run parallax init with the current build to apply additive migrations.';
  } else if (normalized.includes('must be') || normalized.includes('between')) {
    code = 'invalid_tool_input';
    cause = 'The MCP tool arguments do not match the Parallax input contract.';
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
  return 'unknown Parallax MCP error';
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

type McpResourceListItem = { uri: string; name: string; mimeType: string };

type WorkspaceContractRow = {
  id: string;
  kind: string;
  service_name: string | null;
  path: string;
  schema_version: string | null;
  content_hash: string;
  endpoint_count: number;
};

type WorkspaceCrossRepoLinkRow = {
  id: string;
  kind: string;
  confidence: string;
  provenance: string;
  index_run_id: number | null;
  source_repo_path: string;
  source_service: string;
  target_repo_path: string;
  target_service: string;
};

function workspaceResourceUri(workspaceName: string): string {
  return `parallax://workspaces/${encodeURIComponent(workspaceName)}`;
}

function workspaceContractsResourceUri(workspaceName: string): string {
  return `${workspaceResourceUri(workspaceName)}/contracts`;
}

function workspaceCrossRepoLinksResourceUri(workspaceName: string): string {
  return `${workspaceResourceUri(workspaceName)}/cross-repo-links`;
}

function workspaceResources(workspaceName: string): { workspace: string; contracts: string; crossRepoLinks: string } {
  return {
    workspace: workspaceResourceUri(workspaceName),
    contracts: workspaceContractsResourceUri(workspaceName),
    crossRepoLinks: workspaceCrossRepoLinksResourceUri(workspaceName)
  };
}

function selectMcpWorkspace(context: McpContext, workspaceName: string): ReturnType<typeof listWorkspaces>['workspaces'][number] {
  const workspace = listWorkspaces({ repoRoot: context.repoRoot, name: workspaceName }).workspaces[0];
  if (!workspace) throw typedMcpError(new Error(`impact workspace not found: ${workspaceName}`), 'resource_not_found');
  return workspace;
}

function listMcpWorkspaces(context: McpContext): ReturnType<typeof listWorkspaces>['workspaces'] {
  return listWorkspaces({ repoRoot: context.repoRoot }).workspaces;
}

function listWorkspaceResources(context: McpContext): McpResourceListItem[] {
  return listMcpWorkspaces(context).map((workspace) => ({
    uri: workspaceResourceUri(workspace.name),
    name: `Workspace ${workspace.name}`,
    mimeType: 'application/json'
  }));
}

function listWorkspaceContractResources(context: McpContext): McpResourceListItem[] {
  return listMcpWorkspaces(context).map((workspace) => ({
    uri: workspaceContractsResourceUri(workspace.name),
    name: `Workspace ${workspace.name} contracts`,
    mimeType: 'application/json'
  }));
}

function listWorkspaceCrossRepoLinkResources(context: McpContext): McpResourceListItem[] {
  return listMcpWorkspaces(context).map((workspace) => ({
    uri: workspaceCrossRepoLinksResourceUri(workspace.name),
    name: `Workspace ${workspace.name} cross-repo links`,
    mimeType: 'application/json'
  }));
}

function readWorkspaceResource(context: McpContext, workspaceName: string): unknown {
  const workspace = selectMcpWorkspace(context, workspaceName);
  return {
    version: 0,
    workspace,
    resources: workspaceResources(workspace.name)
  };
}

function readWorkspaceContractsResource(context: McpContext, workspaceName: string): unknown {
  const workspace = selectMcpWorkspace(context, workspaceName);
  const warnings: string[] = [];
  const contracts = workspace.repos.flatMap((repo) => {
    let db: ReturnType<typeof openDatabase> | undefined;
    try {
      db = openDatabase(repo.localPath, { readOnly: true });
      const repoId = getRepoId(db, repo.localPath);
      const indexRunId = latestCompletedIndexRun(db, repoId);
      const rows = db
        .prepare(`
          SELECT
            c.id,
            c.kind,
            c.service_name,
            c.path,
            v.schema_version,
            v.content_hash,
            (
              SELECT count(*)
              FROM relations r
              INNER JOIN entities target
                 ON target.id = r.target_entity_id
                AND target.repo_id = r.repo_id
              WHERE r.repo_id = c.repo_id
                AND r.index_run_id = ?
                AND r.source_entity_id = c.id
                AND r.kind = 'DECLARES'
                AND target.kind = 'endpoint'
            ) AS endpoint_count
          FROM contracts c
          INNER JOIN contract_versions v
             ON v.contract_id = c.id
            AND v.index_run_id = ?
          WHERE c.repo_id = ?
          ORDER BY COALESCE(c.service_name, ''), c.path, c.id
        `)
        .all(indexRunId, indexRunId, repoId) as WorkspaceContractRow[];
      return rows.map((row) => ({
        id: row.id,
        serviceName: row.service_name ?? repo.serviceName,
        repoPath: repo.localPath,
        path: row.path,
        kind: row.kind,
        ...(row.schema_version !== null ? { schemaVersion: row.schema_version } : {}),
        contentHash: row.content_hash,
        indexRunId,
        endpointCount: row.endpoint_count,
        contractDiffHint: {
          tool: 'parallax_contract_diff',
          workspaceName: workspace.name,
          contractPath: row.path,
          providerServiceName: row.service_name ?? repo.serviceName
        }
      }));
    } catch (error) {
      warnings.push(`workspace contract repo skipped: ${repo.localPath}: ${errorMessage(error)}`);
      return [];
    } finally {
      db?.close();
    }
  });

  return {
    version: 0,
    workspace: workspace.name,
    contracts,
    warnings,
    resources: workspaceResources(workspace.name)
  };
}

function readWorkspaceCrossRepoLinksResource(context: McpContext, workspaceName: string): unknown {
  const workspace = selectMcpWorkspace(context, workspaceName);
  return withReadOnlyDb(context, (db) => {
    const workspaceRow = db
      .prepare('SELECT id FROM workspaces WHERE name = ?')
      .get(workspace.name) as { id: number } | undefined;
    if (!workspaceRow) throw typedMcpError(new Error(`impact workspace not found: ${workspace.name}`), 'resource_not_found');
    const limit = 500;
    const rows = db
      .prepare(`
        SELECT
          link.id,
          link.kind,
          link.confidence,
          link.provenance,
          link.index_run_id,
          source_member.local_path AS source_repo_path,
          source_member.service_name AS source_service,
          target_member.local_path AS target_repo_path,
          target_member.service_name AS target_service
        FROM cross_repo_links link
        INNER JOIN workspace_repos source_member
           ON source_member.workspace_id = link.workspace_id
          AND source_member.repo_id = link.source_repo_id
        INNER JOIN workspace_repos target_member
           ON target_member.workspace_id = link.workspace_id
          AND target_member.repo_id = link.target_repo_id
        WHERE link.workspace_id = ?
        ORDER BY link.kind, source_member.service_name, target_member.service_name, link.id
        LIMIT ?
      `)
      .all(workspaceRow.id, limit + 1) as WorkspaceCrossRepoLinkRow[];
    return {
      version: 0,
      workspace: workspace.name,
      links: rows.slice(0, limit).map((row) => {
        const provenance = parsedProvenance(row.provenance);
        const eventTopology = eventTopologyFromProvenance(provenance);
        return {
          id: row.id,
          kind: row.kind,
          confidence: row.confidence,
          sourceRepoPath: row.source_repo_path,
          sourceService: row.source_service,
          targetRepoPath: row.target_repo_path,
          targetService: row.target_service,
          indexRunId: row.index_run_id,
          ...(eventTopology !== undefined ? { eventTopology } : {}),
          provenance
        };
      }),
      limits: {
        links: limit,
        truncated: rows.length > limit
      },
      resources: workspaceResources(workspace.name)
    };
  });
}

function parsedProvenance(value: string): unknown {
  const parsed = parseJsonObject(value);
  return Object.keys(parsed).length > 0 ? parsed : value;
}

function eventTopologyFromProvenance(provenance: unknown): EventTopologyProvenance | undefined {
  if (!isRecord(provenance) || !isRecord(provenance.eventTopology)) return undefined;
  const providerAction = provenance.eventTopology.providerAction;
  const counterpartyRole = provenance.eventTopology.counterpartyRole;
  const pattern = provenance.eventTopology.pattern;
  if (typeof providerAction !== 'string' || typeof pattern !== 'string') return undefined;
  if (!providerAction || !pattern) return undefined;
  if (counterpartyRole !== 'consumer' && counterpartyRole !== 'producer' && counterpartyRole !== 'unknown') {
    return undefined;
  }
  return { providerAction, counterpartyRole, pattern };
}

function listReportResources(context: McpContext): Array<{ uri: string; name: string; mimeType: string }> {
  return withReadOnlyDb(context, (db, repoId) => {
    const rows = db
      .prepare('SELECT id FROM reports WHERE repo_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(repoId) as Array<{ id: string }>;
    return rows.map((row) => ({
      uri: `parallax://reports/${row.id}`,
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
      uri: `parallax://entities/${encodeURIComponent(row.id)}`,
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
      uri: `parallax://reports/${row.id}/graph/${format}`,
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
