import assert from 'node:assert/strict';
import { test } from 'node:test';

import { impactReportToSarif } from '../src/sarif.js';
import type { ImpactReport } from '../src/types.js';

function reportFixture(): ImpactReport {
  return {
    id: 'report-1',
    indexRunId: 1,
    changedFiles: ['src/api.ts'],
    changed: [{ id: 'file:src/api.ts', kind: 'file', path: 'src/api.ts' }],
    affectedFiles: [{
      path: 'src/client.ts',
      reason: 'imports changed API',
      confidence: 'proven',
      depth: 1,
      relationPath: ['src/api.ts', 'src/client.ts']
    }],
    affected: [{
      target: { id: 'file:src/client.ts', kind: 'file', path: 'src/client.ts' },
      relations: ['IMPORTS'],
      confidence: 'proven'
    }],
    actions: [{
      kind: 'verify',
      target: { id: 'file:src/client.ts', kind: 'file', path: 'src/client.ts' },
      command: 'npm',
      args: ['test', '--', 'tests/client.test.ts'],
      runnerId: 'npm-test',
      display: 'npm test -- tests/client.test.ts',
      confidence: 'proven'
    }],
    testCommands: [{
      kind: 'verify',
      target: { id: 'file:src/client.ts', kind: 'file', path: 'src/client.ts' },
      command: 'npm',
      args: ['test', '--', 'tests/client.test.ts'],
      runnerId: 'npm-test',
      display: 'npm test -- tests/client.test.ts',
      confidence: 'proven'
    }],
    evidence: [{
      id: 'ev-1',
      file: 'src/client.ts',
      kind: 'import',
      snippet: 'import { loadUsers } from "./api";',
      confidence: 'proven',
      startLine: 4,
      endLine: 4,
      startCol: 1,
      endCol: 35,
      subject: { id: 'file:src/client.ts', kind: 'file', path: 'src/client.ts' },
      target: { id: 'file:src/api.ts', kind: 'file', path: 'src/api.ts' },
      relationKind: 'IMPORTS',
      relationConfidence: 'proven',
      extractorId: 'test-fixture'
    }],
    warnings: ['fixture warning']
  };
}

test('impactReportToSarif maps affected files into GitHub-compatible results', () => {
  const sarif = impactReportToSarif(reportFixture(), {
    category: 'parallax-pr',
    toolVersion: '0.1.0',
    informationUri: 'https://github.com/YouSangSon/Parallax#readme'
  });

  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs.length, 1);
  assert.equal(sarif.runs[0]?.tool.driver.name, 'Parallax');
  assert.equal(sarif.runs[0]?.automationDetails?.id, 'parallax-pr');
  assert.equal(sarif.runs[0]?.results.length, 1);
  const result = sarif.runs[0]?.results[0];
  assert.equal(result?.ruleId, 'parallax.impact.proven');
  assert.equal(result?.level, 'warning');
  assert.equal(result?.locations?.[0]?.physicalLocation?.artifactLocation?.uri, 'src/client.ts');
  assert.equal(result?.locations?.[0]?.physicalLocation?.region?.startLine, 4);
  assert.ok(result?.partialFingerprints?.parallaxImpact);
  assert.deepEqual(result?.properties?.evidenceIds, ['ev-1']);
});

test('impactReportToSarif emits empty runs for no-impact reports', () => {
  const report = reportFixture();
  report.affectedFiles = [];
  report.affected = [];

  const sarif = impactReportToSarif(report);

  assert.equal(sarif.runs[0]?.results.length, 0);
  assert.equal(sarif.runs[0]?.invocations?.[0]?.executionSuccessful, true);
});

test('impactReportToSarif does not emit human-readable relation steps as artifact URIs', () => {
  const report = reportFixture();
  report.affectedFiles[0]!.relationPath = [
    'src/api.ts',
    'web:src/client.ts BREAKS_COMPATIBILITY_WITH users-api:contracts/openapi.yaml',
    'src/client.ts'
  ];

  const sarif = impactReportToSarif(report);
  const result = sarif.runs[0]!.results[0]!;
  const codeFlowUris = result.codeFlows?.flatMap((flow) =>
    flow.threadFlows.flatMap((threadFlow) =>
      threadFlow.locations.map((location) =>
        location.location.physicalLocation.artifactLocation.uri
      )
    )
  ) ?? [];

  assert.deepEqual(result.properties?.relationPath, report.affectedFiles[0]!.relationPath);
  assert.deepEqual(codeFlowUris, ['src/api.ts', 'src/client.ts']);
  assert.equal(
    codeFlowUris.includes('web:src/client.ts BREAKS_COMPATIBILITY_WITH users-api:contracts/openapi.yaml'),
    false
  );
});

test('impactReportToSarif omits non-repo-relative affected files from uploadable results', () => {
  const report = reportFixture();
  report.affectedFiles.push({
    path: 'web:src/client.ts',
    reason: 'cross-repo client consumes changed API',
    confidence: 'inferred',
    relationPath: ['src/api.ts', 'web:src/client.ts']
  });

  const sarif = impactReportToSarif(report);
  const resultUris = sarif.runs[0]!.results.map((result) =>
    result.locations[0]!.physicalLocation.artifactLocation.uri
  );

  assert.deepEqual(resultUris, ['src/client.ts']);
  assert.equal(resultUris.includes('web:src/client.ts'), false);
  assert.equal(sarif.runs[0]!.properties?.omittedAffectedFileCount, 1);
  assert.deepEqual(sarif.runs[0]!.properties?.omittedAffectedFiles, [{
    path: 'web:src/client.ts',
    confidence: 'inferred',
    reason: 'cross-repo client consumes changed API'
  }]);
});
