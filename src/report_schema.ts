import { z } from 'zod';

/**
 * Published schema for `parallax analyze --json` output (the {@link ImpactReport}).
 *
 * The hand-written `ImpactReport` type in `types.ts` stays authoritative; these
 * zod schemas mirror it so consumers get a machine-readable contract. A
 * compile-time conformance assertion (see `tests/report-schema.test.ts`) keeps
 * the mirror honest, and the JSON Schema artifact under `schemas/` is generated
 * from `buildImpactReportJsonSchema()` with a drift guard in `npm run lint`.
 */

/** Bump (semver) whenever the emitted report shape changes. */
export const IMPACT_REPORT_SCHEMA_VERSION = '1.2.0';

const SCHEMA_ID =
  'https://raw.githubusercontent.com/YouSangSon/Parallax/main/schemas/impact-report.schema.json';
const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

const confidenceSchema = z.enum(['proven', 'inferred', 'heuristic', 'unknown']);

const entityKindSchema = z.enum([
  'file',
  'symbol',
  'module',
  'package',
  'test',
  'doc',
  'config',
  'policy',
  'proposal',
  'prd',
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
]);

const entityRefSchema = z.object({
  id: z.string(),
  kind: entityKindSchema,
  path: z.string().optional(),
  symbol: z.string().optional(),
  languageId: z.string().optional(),
  displayName: z.string().optional()
});

const evidenceSchema = z.object({
  id: z.string(),
  file: z.string(),
  kind: z.string(),
  snippet: z.string(),
  confidence: confidenceSchema,
  startLine: z.number().optional(),
  endLine: z.number().optional(),
  startCol: z.number().optional(),
  endCol: z.number().optional(),
  subject: entityRefSchema.optional(),
  target: entityRefSchema.optional(),
  relationKind: z.string().optional(),
  relationConfidence: confidenceSchema.optional(),
  extractorId: z.string().optional()
});

const affectedFileSchema = z.object({
  path: z.string(),
  reason: z.string(),
  confidence: confidenceSchema,
  depth: z.number().optional(),
  relationPath: z.array(z.string()).optional()
});

const impactTargetSchema = z.object({
  target: entityRefSchema,
  relations: z.array(z.string()),
  confidence: confidenceSchema
});

const impactActionSchema = z.object({
  kind: z.enum(['verify', 'review']),
  runnerId: z.string().optional(),
  target: entityRefSchema,
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  display: z.string(),
  confidence: confidenceSchema
});

const adapterRunInsightSchema = z.object({
  id: z.string(),
  version: z.string(),
  languageIds: z.array(z.string()),
  confidence: confidenceSchema,
  knownGaps: z.array(z.string()),
  status: z.string(),
  errorSummary: z.string().optional()
});

export const impactReportSchema = z.object({
  id: z.string(),
  indexRunId: z.number(),
  changedFiles: z.array(z.string()),
  affectedFiles: z.array(affectedFileSchema),
  changed: z.array(entityRefSchema),
  affected: z.array(impactTargetSchema),
  actions: z.array(impactActionSchema),
  testCommands: z.array(impactActionSchema),
  evidence: z.array(evidenceSchema),
  adapterInsights: z.array(adapterRunInsightSchema).optional(),
  warnings: z.array(z.string()).optional(),
  reportPath: z.string().optional()
});

/**
 * Build the published JSON Schema artifact for the impact report. Deterministic:
 * the same zod schema always yields byte-identical output, so the committed
 * `schemas/impact-report.schema.json` can be drift-guarded against it.
 */
export function buildImpactReportJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(impactReportSchema) as Record<string, unknown>;
  // Drop generator-emitted metadata so our versioned identity wins (no dupes).
  const { $schema: _dialect, $id: _id, title: _title, ...body } = generated;
  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: SCHEMA_ID,
    title: 'Parallax Impact Report',
    description: 'Schema for `parallax analyze --json` output (ImpactReport).',
    version: IMPACT_REPORT_SCHEMA_VERSION,
    ...body
  };
}
