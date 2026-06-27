import { z } from 'zod';

const resourcesSchema = z.record(z.string(), z.unknown());
const workspaceSchema = z.object({
  name: z.string(),
  repos: z.array(z.object({ serviceName: z.string() }).passthrough())
}).passthrough();
const factSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  attribute: z.string(),
  value: z.unknown(),
  op: z.string(),
  txId: z.string(),
  ts: z.string()
}).passthrough();

export const MCP_OUTPUT_SCHEMAS = {
  parallax_analyze_diff: z.object({
    id: z.string(),
    indexRunId: z.number(),
    changedFiles: z.array(z.string()),
    affectedFiles: z.array(z.unknown()),
    changed: z.array(z.unknown()),
    affected: z.array(z.unknown()),
    actions: z.array(z.unknown()),
    testCommands: z.array(z.unknown()),
    evidence: z.array(z.unknown())
  }).passthrough(),
  parallax_context_for_change: z.object({
    version: z.number(),
    budget: z.enum(['brief', 'standard', 'deep']),
    indexRunId: z.number(),
    resources: resourcesSchema,
    omittedCounts: z.record(z.string(), z.number())
  }).passthrough(),
  parallax_search_context: z.object({
    query: z.string(),
    indexRunId: z.number(),
    results: z.array(z.unknown()),
    resources: resourcesSchema,
    limits: z.object({
      k: z.number(),
      includeEvidence: z.boolean()
    }).passthrough()
  }).passthrough(),
  parallax_contract_diff: z.object({
    workspace: z.object({ name: z.string() }).passthrough(),
    provider: z.object({ serviceName: z.string() }).passthrough(),
    contract: z.object({
      path: z.string(),
      id: z.string(),
      kind: z.string(),
      previousContentHash: z.string(),
      indexRunId: z.number()
    }).passthrough(),
    changes: z.array(z.unknown()),
    impactedConsumers: z.array(z.unknown()),
    warnings: z.array(z.string()),
    resources: resourcesSchema
  }).passthrough(),
  parallax_cross_repo_consumers: z.object({
    version: z.number(),
    workspace: workspaceSchema,
    consumers: z.array(z.unknown()),
    warnings: z.array(z.string()),
    resources: resourcesSchema
  }).passthrough(),
  parallax_cross_repo_providers: z.object({
    version: z.number(),
    workspace: workspaceSchema,
    providers: z.array(z.unknown()),
    warnings: z.array(z.string()),
    resources: resourcesSchema
  }).passthrough(),
  parallax_resolve_cross_repo_contracts: z.object({
    workspace: workspaceSchema,
    links: z.array(z.unknown()),
    warnings: z.array(z.string()),
    resources: resourcesSchema
  }).passthrough(),
  parallax_remember: z.object({
    factId: z.string(),
    txId: z.string()
  }).passthrough(),
  parallax_recall: z.object({
    facts: z.array(factSchema)
  }).passthrough(),
  parallax_query: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.unknown())),
    indexRunId: z.number(),
    resources: resourcesSchema
  }).passthrough(),
  parallax_co_change: z.object({
    file: z.string(),
    indexRunId: z.number(),
    partners: z.array(z.unknown()),
    resources: resourcesSchema
  }).passthrough(),
  parallax_branch: z.object({
    branchId: z.string(),
    headTxId: z.string().nullable()
  }).passthrough(),
  parallax_merge: z.object({
    mergeTxId: z.string(),
    targetBranchId: z.string(),
    sourceBranchId: z.string(),
    previousTargetHead: z.string().nullable(),
    sourceHead: z.string()
  }).passthrough(),
  parallax_reflect: z.object({
    branch: z.string(),
    model: z.string(),
    summarized: z.number(),
    skippedEntities: z.number(),
    reflections: z.array(z.unknown())
  }).passthrough(),
  parallax_abandon_branch: z.object({
    branchId: z.string(),
    name: z.string(),
    state: z.literal('abandoned'),
    alreadyAbandoned: z.boolean()
  }).passthrough(),
  parallax_gc_branches: z.object({
    scanned: z.number(),
    archivedTransactions: z.number(),
    autoAbandoned: z.number(),
    branches: z.array(z.unknown()),
    dryRun: z.boolean()
  }).passthrough(),
  parallax_profile: z.object({
    entity: z.string(),
    branch: z.string(),
    staticFacts: z.array(factSchema),
    dynamicFacts: z.array(factSchema),
    summaryFacts: z.array(factSchema)
  }).passthrough(),
  parallax_explain_entity: z.object({
    entity: z.unknown(),
    indexRunId: z.number(),
    relations: z.object({
      incoming: z.array(z.unknown()),
      outgoing: z.array(z.unknown())
    }).passthrough(),
    resources: resourcesSchema,
    limits: z.object({
      relationLimit: z.number(),
      evidenceLimit: z.number()
    }).passthrough(),
    counts: z.object({
      incoming: z.number(),
      outgoing: z.number(),
      evidence: z.number()
    }).passthrough()
  }).passthrough(),
  parallax_context_telemetry: z.object({
    version: z.number(),
    summary: z.object({
      toolRuns: z.number(),
      resourceAccesses: z.number(),
      returnedBytes: z.number(),
      resourcesAdvertised: z.number()
    }).passthrough(),
    toolRuns: z.array(z.unknown()),
    resourceAccesses: z.array(z.unknown())
  }).passthrough(),
  parallax_doctor: z.object({
    version: z.number(),
    generatedAt: z.string(),
    repoRoot: z.string(),
    database: z.object({
      path: z.string(),
      exists: z.boolean(),
      schemaVersion: z.number().nullable()
    }).passthrough(),
    findings: z.array(z.unknown())
  }).passthrough(),
  parallax_repair_reflections: z.object({
    branch: z.string(),
    scanned: z.number(),
    repaired: z.number(),
    dryRun: z.boolean(),
    orphans: z.array(z.unknown())
  }).passthrough(),
  parallax_restore_branch: z.object({
    branchId: z.string(),
    name: z.string(),
    state: z.literal('active'),
    unarchivedTransactions: z.number(),
    alreadyActive: z.boolean()
  }).passthrough(),
  parallax_trace: z.object({
    chain: z.array(factSchema),
    edges: z.array(z.unknown())
  }).passthrough()
} as const;

export type McpOutputToolName = keyof typeof MCP_OUTPUT_SCHEMAS;
