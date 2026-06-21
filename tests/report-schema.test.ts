import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { z } from 'zod';

import { analyzeDiff, indexProject, initProject } from '../src/index.js';
import type { ImpactReport } from '../src/types.js';
import {
  IMPACT_REPORT_SCHEMA_VERSION,
  buildImpactReportJsonSchema,
  impactReportSchema
} from '../src/report_schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// Compile-time conformance: a real ImpactReport must satisfy the published
// schema's inferred shape. `npm run check` fails if ImpactReport gains a
// required field the schema lacks, or a field's type diverges. The runtime
// real-output test below backstops the reverse direction, which assignability
// cannot see under exactOptionalPropertyTypes.
const _conformsToSchema = (report: ImpactReport): z.infer<typeof impactReportSchema> => report;
void _conformsToSchema;

test('the zod schema accepts a real `analyze --json` payload', async () => {
  // Arrange: a tiny repo with a single import edge so analyze surfaces an
  // affected file plus evidence (exercises the nested sub-schemas).
  const workspace = mkdtempSync(path.join(tmpdir(), 'parallax-report-schema-'));
  try {
    mkdirSync(path.join(workspace, 'src'), { recursive: true });
    writeFileSync(path.join(workspace, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(
      path.join(workspace, 'src/b.ts'),
      "import { a } from './a.js';\nexport const b = a + 1;\n"
    );

    await initProject({ repoRoot: workspace });
    await indexProject({ repoRoot: workspace });

    // Act: produce the exact object `parallax analyze --json` prints, then round-trip
    // through JSON so serialization effects (dropped `undefined` keys) are exercised.
    const report = await analyzeDiff({ repoRoot: workspace, changedFiles: ['src/a.ts'] });
    const emitted = JSON.parse(JSON.stringify(report)) as unknown;

    // Assert: the published schema validates the emitted JSON.
    const parsed = impactReportSchema.safeParse(emitted);
    assert.ok(parsed.success, `expected emitted report to validate; got ${JSON.stringify(parsed.error?.issues)}`);
    assert.ok(report.affectedFiles.some((file) => file.path === 'src/b.ts'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('the zod schema rejects an unknown confidence value', () => {
  // Arrange: a minimal-but-invalid report (confidence outside the enum).
  const invalid = {
    id: 'r1',
    indexRunId: 1,
    changedFiles: ['src/a.ts'],
    affectedFiles: [{ path: 'src/b.ts', reason: 'x', confidence: 'maybe' }],
    changed: [],
    affected: [],
    actions: [],
    testCommands: [],
    evidence: []
  };

  // Act
  const parsed = impactReportSchema.safeParse(invalid);

  // Assert
  assert.equal(parsed.success, false);
});

test('the committed JSON Schema artifact matches the generator (drift guard)', () => {
  // Arrange: the published artifact consumers depend on.
  const artifactPath = path.join(repoRoot, 'schemas', 'impact-report.schema.json');
  const committed = JSON.parse(readFileSync(artifactPath, 'utf8')) as unknown;

  // Act
  const generated = buildImpactReportJsonSchema();

  // Assert: regenerating from the zod schema reproduces the committed file.
  assert.deepEqual(committed, generated);
});

test('the JSON Schema artifact carries a stable, versioned $id', () => {
  // Arrange / Act
  const generated = buildImpactReportJsonSchema() as Record<string, unknown>;

  // Assert
  assert.equal(generated.version, IMPACT_REPORT_SCHEMA_VERSION);
  assert.ok(typeof generated.$id === 'string' && (generated.$id as string).includes('impact-report'));
  assert.equal(generated.$schema, 'https://json-schema.org/draft/2020-12/schema');
});
