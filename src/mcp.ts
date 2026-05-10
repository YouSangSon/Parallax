import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createBranch, mergeBranches, recallOnRepo, rememberOnRepo, trace } from './agent_memory.js';
import type { RememberValue } from './agent_memory.js';
import { abandonBranch, gcBranches, restoreBranch } from './branch_gc.js';
import { reflectFacts, repairReflections } from './reflection.js';
import { profileEntity } from './profile.js';
import { normalizeRepoRoot, redactSecrets } from './security.js';
import { getRepoId, latestCompletedIndexRun, openDatabase } from './store.js';
import type {
  Confidence,
  ContextBudget,
  ContextPack,
  ContextPackEvidence,
  ContextPackItem,
  EntityRef,
  Evidence,
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
    'impact_trace_context_for_change',
    {
      title: 'Build compact context for a change',
      description:
        'Return a budgeted context pack for changed files so coding agents get ranked impact paths, evidence refs, and resource links without the full report payload.',
      inputSchema: {
        changedFiles: z.array(z.string()).min(1),
        budget: z.enum(['brief', 'standard', 'deep']).optional(),
        maxDepth: z.number().int().min(1).max(8).optional(),
        maxFanout: z.number().int().min(1).max(2_000).optional()
      },
      annotations: {
        title: 'Build compact context for a change',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ changedFiles, budget, maxDepth, maxFanout }) => {
      const normalizedBudget = normalizeContextBudget(budget);
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
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(pack)
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
      return jsonResource(uri.toString(), readEvidence(context, evidenceId));
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

function readEvidence(context: McpContext, evidenceId: string): unknown {
  return withReadOnlyDb(context, (db, repoId) => {
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
        INNER JOIN relations ON relations.id = evidence.relation_id AND relations.repo_id = evidence.repo_id
        LEFT JOIN entities source ON source.id = relations.source_entity_id AND source.repo_id = evidence.repo_id
        LEFT JOIN entities target ON target.id = relations.target_entity_id AND target.repo_id = evidence.repo_id
        WHERE evidence.repo_id = ? AND evidence.id = ?
      `)
      .get(repoId, evidenceId) as EvidenceResourceRow | undefined;
    if (!row) throw new Error(`impact evidence not found: ${evidenceId}`);
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

function asConfidence(value: string): Confidence {
  if (value === 'proven' || value === 'inferred' || value === 'heuristic' || value === 'unknown') return value;
  return 'unknown';
}
