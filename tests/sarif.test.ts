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
  assert.equal(sarif.runs[0]?.results.length, 2);
  const result = sarif.runs[0]?.results.find((item) => item.ruleId === 'parallax.impact.proven');
  assert.equal(result?.ruleId, 'parallax.impact.proven');
  assert.equal(result?.level, 'warning');
  assert.equal(result?.locations?.[0]?.physicalLocation?.artifactLocation?.uri, 'src/client.ts');
  assert.equal(result?.locations?.[0]?.physicalLocation?.region?.startLine, 4);
  assert.ok(result?.partialFingerprints?.parallaxImpact);
  assert.deepEqual(result?.properties?.evidenceIds, ['ev-1']);
});

test('impactReportToSarif emits recommended verification actions as note results', () => {
  const sarif = impactReportToSarif(reportFixture());

  const result = sarif.runs[0]?.results.find((item) => item.ruleId === 'parallax.verification');

  assert.equal(result?.level, 'note');
  assert.equal(result?.message.text, 'Recommended verification: npm test -- tests/client.test.ts');
  assert.equal(result?.locations[0]?.physicalLocation.artifactLocation.uri, 'src/client.ts');
  assert.equal(result?.properties?.command, 'npm');
  assert.deepEqual(result?.properties?.args, ['test', '--', 'tests/client.test.ts']);
  assert.equal(sarif.runs[0]?.properties?.verificationActionCount, 1);
  assert.equal(sarif.runs[0]?.properties?.omittedVerificationActionCount, 0);
});

test('impactReportToSarif emits index coverage gaps as warning results', () => {
  const report = reportFixture();
  report.changedFiles = ['src/new-api.ts'];
  report.affectedFiles = [{
    path: 'src/new-api.ts',
    reason: 'changed file not in index',
    confidence: 'unknown'
  }];
  report.affected = [];
  report.actions = [];
  report.testCommands = [];
  report.evidence = [];

  const sarif = impactReportToSarif(report);

  const result = sarif.runs[0]?.results.find((item) => item.ruleId === 'parallax.coverage-gap');
  assert.equal(result?.level, 'warning');
  assert.equal(result?.message.text, 'Index coverage gap: src/new-api.ts was not present in index run 1');
  assert.equal(result?.locations[0]?.physicalLocation.artifactLocation.uri, 'src/new-api.ts');
  assert.equal(result?.properties?.changedPath, 'src/new-api.ts');
  assert.ok(result?.partialFingerprints?.parallaxImpact);
  assert.equal(sarif.runs[0]?.properties?.coverageGapCount, 1);
  assert.equal(sarif.runs[0]?.properties?.omittedCoverageGapCount, 0);
});

test('impactReportToSarif omits coverage-gap results without an uploadable changed file anchor', () => {
  const report = reportFixture();
  report.changedFiles = ['workspace:src/new-api.ts'];
  report.affectedFiles = [{
    path: 'workspace:src/new-api.ts',
    reason: 'changed file not in index',
    confidence: 'unknown'
  }];
  report.affected = [];
  report.actions = [];
  report.testCommands = [];
  report.evidence = [];

  const sarif = impactReportToSarif(report);

  assert.equal(sarif.runs[0]?.results.length, 0);
  assert.equal(sarif.runs[0]?.properties?.coverageGapCount, 0);
  assert.equal(sarif.runs[0]?.properties?.omittedCoverageGapCount, 1);
});

test('impactReportToSarif emits cross-repo contract breaks on provider contracts', () => {
  const report = reportFixture();
  report.changedFiles = ['contracts/openapi.yaml'];
  report.crossRepoImpacts = [{
    workspace: 'platform',
    provider: {
      serviceName: 'users-api',
      contractPath: 'contracts/openapi.yaml'
    },
    consumer: {
      serviceName: 'web',
      path: 'src/client.ts'
    },
    change: {
      kind: 'removed_endpoint',
      method: 'GET',
      path: '/api/users',
      previousEndpointId: 'endpoint:yaml:GET /api/users'
    },
    confidence: 'heuristic',
    evidence: {
      filePath: 'web:src/client.ts',
      snippet: 'return fetch("https://users.example.test/api/users");'
    },
    resources: {
      workspace: 'parallax://workspaces/platform',
      crossRepoLinks: 'parallax://workspaces/platform/cross-repo-links'
    }
  }];

  const sarif = impactReportToSarif(report);

  const result = sarif.runs[0]?.results.find((item) => item.ruleId === 'parallax.contract-break');
  assert.equal(result?.level, 'warning');
  assert.equal(
    result?.message.text,
    'Breaking contract change may affect web:src/client.ts: removed_endpoint GET /api/users'
  );
  assert.equal(result?.locations[0]?.physicalLocation.artifactLocation.uri, 'contracts/openapi.yaml');
  assert.equal(result?.properties?.providerContractPath, 'contracts/openapi.yaml');
  assert.equal(result?.properties?.consumerServiceName, 'web');
  assert.equal(result?.properties?.consumerPath, 'src/client.ts');
  assert.equal(result?.properties?.evidenceFilePath, 'web:src/client.ts');
  assert.ok(result?.partialFingerprints?.parallaxImpact);
  assert.equal(sarif.runs[0]?.properties?.contractBreakCount, 1);
  assert.equal(sarif.runs[0]?.properties?.omittedContractBreakCount, 0);
});

test('impactReportToSarif omits contract-break results without an uploadable provider contract anchor', () => {
  const report = reportFixture();
  report.affectedFiles = [];
  report.affected = [];
  report.actions = [];
  report.testCommands = [];
  report.crossRepoImpacts = [{
    workspace: 'platform',
    provider: {
      serviceName: 'users-api',
      contractPath: 'users-api:contracts/openapi.yaml'
    },
    consumer: {
      serviceName: 'web',
      path: 'src/client.ts'
    },
    change: {
      kind: 'removed_endpoint',
      method: 'GET',
      path: '/api/users'
    },
    confidence: 'heuristic',
    evidence: {
      filePath: 'web:src/client.ts',
      snippet: 'return fetch("https://users.example.test/api/users");'
    }
  }];

  const sarif = impactReportToSarif(report);

  assert.equal(sarif.runs[0]?.results.length, 0);
  assert.equal(sarif.runs[0]?.properties?.contractBreakCount, 0);
  assert.equal(sarif.runs[0]?.properties?.omittedContractBreakCount, 1);
});

test('impactReportToSarif emits adapter known gaps as note results on changed files', () => {
  const report = reportFixture();
  report.changedFiles = ['src/api.ts', 'docs/api-contract.md'];
  report.adapterInsights = [{
    id: 'typescript-adapter',
    version: '1.2.3',
    languageIds: ['typescript'],
    status: 'completed',
    confidence: 'heuristic',
    knownGaps: ['dynamic dispatch can miss indirect callers']
  }];

  const sarif = impactReportToSarif(report);

  const result = sarif.runs[0]?.results.find((item) => item.ruleId === 'parallax.adapter-known-gap');
  assert.equal(result?.level, 'note');
  assert.equal(
    result?.message.text,
    'Adapter known gap: typescript-adapter: dynamic dispatch can miss indirect callers'
  );
  assert.equal(result?.locations[0]?.physicalLocation.artifactLocation.uri, 'src/api.ts');
  assert.equal(result?.relatedLocations?.[0]?.physicalLocation.artifactLocation.uri, 'docs/api-contract.md');
  assert.equal(result?.properties?.adapterId, 'typescript-adapter');
  assert.equal(result?.properties?.knownGap, 'dynamic dispatch can miss indirect callers');
  assert.ok(result?.partialFingerprints?.parallaxImpact);
  assert.equal(sarif.runs[0]?.properties?.adapterKnownGapCount, 1);
  assert.equal(sarif.runs[0]?.properties?.omittedAdapterKnownGapCount, 0);
});

test('impactReportToSarif omits adapter known-gap results without an uploadable changed file anchor', () => {
  const report = reportFixture();
  report.changedFiles = ['workspace:src/api.ts'];
  report.affectedFiles = [];
  report.affected = [];
  report.actions = [];
  report.testCommands = [];
  report.adapterInsights = [{
    id: 'typescript-adapter',
    version: '1.2.3',
    languageIds: ['typescript'],
    status: 'completed',
    confidence: 'heuristic',
    knownGaps: ['dynamic dispatch can miss indirect callers']
  }];

  const sarif = impactReportToSarif(report);

  assert.equal(sarif.runs[0]?.results.length, 0);
  assert.equal(sarif.runs[0]?.properties?.adapterKnownGapCount, 0);
  assert.equal(sarif.runs[0]?.properties?.omittedAdapterKnownGapCount, 1);
});

test('impactReportToSarif emits empty runs for no-impact reports', () => {
  const report = reportFixture();
  report.affectedFiles = [];
  report.affected = [];
  report.actions = [];
  report.testCommands = [];

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
  const result = sarif.runs[0]!.results.find((item) => item.ruleId === 'parallax.impact.proven')!;
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
  const resultUris = sarif.runs[0]!.results
    .filter((result) => result.ruleId.startsWith('parallax.impact.'))
    .map((result) => result.locations[0]!.physicalLocation.artifactLocation.uri);

  assert.deepEqual(resultUris, ['src/client.ts']);
  assert.equal(resultUris.includes('web:src/client.ts'), false);
  assert.equal(sarif.runs[0]!.properties?.omittedAffectedFileCount, 1);
  assert.deepEqual(sarif.runs[0]!.properties?.omittedAffectedFiles, [{
    path: 'web:src/client.ts',
    confidence: 'inferred',
    reason: 'cross-repo client consumes changed API'
  }]);
});
