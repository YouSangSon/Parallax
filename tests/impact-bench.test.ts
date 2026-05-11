import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runImpactBench } from '../bench/impact-bench.js';

process.env.IMPACT_TRACE_EMBEDDING_MODEL = 'stub-sha256';

test('ImpactBench runner writes deterministic report shape', async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'impact-bench-workspace-'));
  const outputPath = path.join(workspaceRoot, '.impact-trace/bench/impact-bench-report.json');

  try {
    const report = await runImpactBench({ workspaceRoot, outputPath });
    const savedReport = JSON.parse(await readFile(outputPath, 'utf8')) as unknown;
    const secondReport = await runImpactBench({ workspaceRoot, outputPath });
    const secondSavedReport = JSON.parse(await readFile(outputPath, 'utf8')) as unknown;
    const serializedReport = JSON.stringify(report);

    assert.deepEqual(savedReport, report);
    assert.deepEqual(secondReport, report);
    assert.deepEqual(secondSavedReport, report);
    assert.equal(serializedReport.includes(workspaceRoot), false);
    assert.equal(serializedReport.includes(tmpdir()), false);
    assert.equal(serializedReport.includes('impact-bench-fixture-'), false);
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.fixtureId, 'phase6b-multilanguage-v0');
    assert.equal(report.outputPath, '.impact-trace/bench/impact-bench-report.json');
    assert.equal(report.summary.passed, true);
    assert.equal(report.summary.expectedRelations, 39);
    assert.equal(report.summary.expectedRelations, report.summary.matchedRelations);
    assert.equal(report.summary.unexpectedRelations, 0);
    assert.equal(report.scores.affectedFileRecall, 1);
    assert.equal(report.scores.evidencePresence, 1);
    assert.ok(report.scores.spanCompleteness >= 0.75);
    assert.equal(report.scores.adapterAttribution, 1);
    assert.equal(report.scores.contextPackReadiness, 1);
    assert.ok(report.summary.score >= 0.9);
    assert.equal(report.retrieval.fixtureId, 'search-context-retrieval-v0');
    assert.deepEqual(
      report.retrieval.queries.map((query) => query.id),
      [...report.retrieval.queries.map((query) => query.id)].sort()
    );
    assert.equal(report.retrieval.summary.recallAt5, 1);
    assert.equal(report.retrieval.summary.recallAt10, 1);
    assert.equal(report.retrieval.summary.mrr, 1);
    assert.equal(report.retrieval.summary.ndcgAt10, 1);
    assert.ok(report.retrieval.summary.precisionAt5 > 0);
    assert.ok(report.retrieval.budgets.brief.maxReturnedBytes <= 5_000);
    assert.equal(report.retrieval.budgets.brief.budgetExceededCount, 0);
    assert.ok(
      report.retrieval.streamAblations.all.recallAt5
        > report.retrieval.streamAblations.withoutEvidenceFts.recallAt5
    );
    assert.ok(
      report.retrieval.streamAblations.all.recallAt5
        > report.retrieval.streamAblations.withoutFactsFts.recallAt5
    );
    for (const query of report.retrieval.queries) {
      assert.equal(query.returnedBytes <= 5_000, true);
      for (const uri of query.resourceUris) {
        assert.match(uri, /^impact-trace:\/\//);
      }
    }
    assert.deepEqual(report.missingRelations, []);
    assert.deepEqual(report.unexpectedRelations, []);
    for (const requiredLabel of [
      'TS type-only import reaches session',
      'TS namespace import reaches session',
      'TSX dynamic import reaches session',
      'TSX static import reaches session',
      'TS re-export barrel reaches session',
      'TS path alias import reaches session',
      'Spring @ConfigurationProperties declares properties class',
      'Spring application.properties references configuration properties',
      'Spring Data repository imports entity',
      'Spring @DataJpaTest verifies repository',
      'Spring Feign @FeignClient declares client',
      'Spring WebClient import declares client dependency',
      'Spring RestTemplate import declares client dependency'
    ]) {
      assert.ok(
        report.expectedRelationLabels.includes(requiredLabel),
        `missing fixture coverage label: ${requiredLabel}`
      );
    }
    assert.deepEqual(report.analyzeDiff.changedFiles, ['src/ts/session.ts']);
    assert.ok(report.analyzeDiff.expectedAffectedFiles.includes('src/ts/private.ts'));
    assert.ok(report.analyzeDiff.expectedAffectedFiles.includes('tests/session.test.ts'));
    assert.deepEqual(
      [...report.analyzeDiff.matchedAffectedFiles],
      [...report.analyzeDiff.expectedAffectedFiles]
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
