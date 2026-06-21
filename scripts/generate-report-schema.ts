#!/usr/bin/env tsx
/**
 * Generate (or verify) the published JSON Schema artifact for the impact report.
 *
 *   tsx scripts/generate-report-schema.ts           # write schemas/impact-report.schema.json
 *   tsx scripts/generate-report-schema.ts --check    # fail if the committed file is stale
 *
 * The `--check` form runs in `npm run lint` so a changed report shape can never
 * ship without a regenerated, committed schema.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildImpactReportJsonSchema } from '../src/report_schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const artifactPath = path.resolve(here, '..', 'schemas', 'impact-report.schema.json');

const serialized = `${JSON.stringify(buildImpactReportJsonSchema(), null, 2)}\n`;
const checkMode = process.argv.includes('--check');

if (checkMode) {
  let committed: string;
  try {
    committed = readFileSync(artifactPath, 'utf8');
  } catch {
    console.error(
      `schemas/impact-report.schema.json is missing. Run: npm run schemas:build`
    );
    process.exit(1);
  }
  if (committed !== serialized) {
    console.error(
      `schemas/impact-report.schema.json is stale. Run: npm run schemas:build`
    );
    process.exit(1);
  }
  console.log('schemas/impact-report.schema.json is up to date.');
} else {
  writeFileSync(artifactPath, serialized, 'utf8');
  console.log(`Wrote ${path.relative(path.resolve(here, '..'), artifactPath)}`);
}
