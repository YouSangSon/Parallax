import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { ImpactBenchReport } from '../bench/impact-bench.js';
import {
  formatBenchSummaryMarkdown,
  generateBenchSummaryMarkdown,
  writeBenchSummary
} from '../bench/impact-bench-report.js';

type BenchReportOverrides = Omit<
  Partial<ImpactBenchReport>,
  'crossRepoContracts' | 'contractDiffQuality' | 'coChangeQuality' | 'tracePromotionQuality'
> & {
  crossRepoContracts?: ImpactBenchReport['crossRepoContracts'] | undefined;
  contractDiffQuality?: ImpactBenchReport['contractDiffQuality'] | undefined;
  coChangeQuality?: ImpactBenchReport['coChangeQuality'] | undefined;
  tracePromotionQuality?: ImpactBenchReport['tracePromotionQuality'] | undefined;
};

function makeReport(overrides: BenchReportOverrides = {}): ImpactBenchReport {
  const report: ImpactBenchReport = {
    schemaVersion: 7,
    fixtureId: 'phase6b-multilanguage-v0',
    summary: {
      passed: true,
      score: 0.9987,
      expectedRelations: 78,
      matchedRelations: 78,
      unexpectedRelations: 0
    },
    scores: {
      relationRecall: 1,
      relationPrecision: 1,
      affectedFileRecall: 1,
      evidencePresence: 1,
      spanCompleteness: 0.9737,
      adapterAttribution: 1,
      contextPackReadiness: 1
    },
    missingRelations: [],
    unexpectedRelations: [],
    expectedRelationLabels: ['TS namespace consumer calls session validator'],
    analyzeDiff: {
      changedFiles: ['src/ts/session.ts'],
      expectedAffectedFiles: ['src/ts/namespace-consumer.ts', 'tests/session.test.ts'],
      matchedAffectedFiles: ['src/ts/namespace-consumer.ts', 'tests/session.test.ts']
    },
    crossRepoContracts: {
      fixtureId: 'cross-repo-contract-impact-v0',
      summary: {
        passed: true,
        score: 1,
        expectedImpacts: 1,
        matchedImpacts: 1,
        expectedGraphEdges: 1,
        matchedGraphEdges: 1
      },
      expectedConsumerPaths: ['web:src/client.ts'],
      matchedConsumerPaths: ['web:src/client.ts'],
      missingConsumerPaths: [],
      expectedEvidenceKinds: ['BREAKS_COMPATIBILITY_WITH'],
      matchedEvidenceKinds: ['BREAKS_COMPATIBILITY_WITH'],
      graphEdges: {
        expected: 1,
        matched: 1
      }
    },
    contractDiffQuality: {
      fixtureId: 'contract-diff-quality-v0',
      summary: {
        passed: true,
        score: 1,
        expectedCases: 6,
        matchedCases: 6,
        expectedChanges: 6,
        matchedChanges: 6
      },
      cases: [
        {
          id: 'removed-response-required-property',
          score: 1,
          expectedChanges: 1,
          matchedChanges: 1,
          expectedChangeKeys: ['removed_response_required_property|breaking|responses.200.body.required.name'],
          matchedChangeKeys: ['removed_response_required_property|breaking|responses.200.body.required.name'],
          missingChangeKeys: []
        },
        {
          id: 'added-request-required-property',
          score: 1,
          expectedChanges: 1,
          matchedChanges: 1,
          expectedChangeKeys: ['added_request_required_property|breaking|requestBody.required.email'],
          matchedChangeKeys: ['added_request_required_property|breaking|requestBody.required.email'],
          missingChangeKeys: []
        },
        {
          id: 'changed-response-property-type',
          score: 1,
          expectedChanges: 1,
          matchedChanges: 1,
          expectedChangeKeys: ['changed_response_property_type|breaking|responses.200.body.properties.name'],
          matchedChangeKeys: ['changed_response_property_type|breaking|responses.200.body.properties.name'],
          missingChangeKeys: []
        },
        {
          id: 'changed-response-property-format',
          score: 1,
          expectedChanges: 1,
          matchedChanges: 1,
          expectedChangeKeys: ['changed_response_property_format|breaking|responses.200.body.properties.id.format'],
          matchedChangeKeys: ['changed_response_property_format|breaking|responses.200.body.properties.id.format'],
          missingChangeKeys: []
        },
        {
          id: 'added-response-property-nullable',
          score: 1,
          expectedChanges: 1,
          matchedChanges: 1,
          expectedChangeKeys: ['added_response_property_nullable|breaking|responses.200.body.properties.id.nullable'],
          matchedChangeKeys: ['added_response_property_nullable|breaking|responses.200.body.properties.id.nullable'],
          missingChangeKeys: []
        },
        {
          id: 'removed-response-enum-value',
          score: 1,
          expectedChanges: 1,
          matchedChanges: 1,
          expectedChangeKeys: ['removed_response_property_enum_value|breaking|responses.200.body.properties.status.enum.string:"disabled"'],
          matchedChangeKeys: ['removed_response_property_enum_value|breaking|responses.200.body.properties.status.enum.string:"disabled"'],
          missingChangeKeys: []
        }
      ],
      missingChanges: []
    },
    coChangeQuality: {
      fixtureId: 'co-change-quality-v0',
      summary: {
        passed: true,
        score: 1,
        expectedPartners: 1,
        matchedPartners: 1,
        expectedAffectedFiles: 1,
        matchedAffectedFiles: 1
      },
      expectedPartners: ['src/beta.ts'],
      matchedPartners: ['src/beta.ts'],
      missingPartners: [],
      expectedAffectedFiles: ['src/beta.ts'],
      matchedAffectedFiles: ['src/beta.ts'],
      missingAffectedFiles: []
    },
    tracePromotionQuality: {
      fixtureId: 'trace-promotion-quality-v0',
      summary: {
        passed: true,
        score: 1,
        expectedPromotions: 1,
        matchedPromotions: 1,
        expectedProvenAffectedFiles: 1,
        matchedProvenAffectedFiles: 1,
        unmatchedEdges: 0
      },
      expectedPromotedEdges: ['src/beta.ts->src/alpha.ts'],
      matchedPromotedEdges: ['src/beta.ts->src/alpha.ts'],
      missingPromotedEdges: [],
      expectedProvenAffectedFiles: ['src/beta.ts'],
      matchedProvenAffectedFiles: ['src/beta.ts'],
      missingProvenAffectedFiles: [],
      unmatchedEdges: []
    },
    retrieval: {
      fixtureId: 'search-context-retrieval-v0',
      summary: {
        recallAt5: 1,
        recallAt10: 1,
        precisionAt5: 0.2,
        mrr: 1,
        ndcgAt10: 1
      },
      semanticModels: {
        fixtureId: 'semantic-recall-model-regression-v0',
        summary: {
          passed: true,
          modelCount: 2,
          recallAt1: 1,
          isolation: 1
        },
        models: [
          {
            model: 'bench-semantic-model-a',
            expectedFactId: 'bench:model-a-policy',
            disallowedFactId: 'bench:model-foreign-a-policy',
            topFactId: 'bench:model-a-policy',
            returnedFactIds: ['bench:model-a-policy', 'bench:model-b-policy'],
            recallAt1: 1,
            isolated: true
          },
          {
            model: 'bench-semantic-model-b',
            expectedFactId: 'bench:model-b-policy',
            disallowedFactId: 'bench:model-foreign-b-policy',
            topFactId: 'bench:model-b-policy',
            returnedFactIds: ['bench:model-b-policy', 'bench:model-a-policy'],
            recallAt1: 1,
            isolated: true
          }
        ]
      },
      budgets: {
        brief: {
          maxReturnedBytes: 966,
          budgetExceededCount: 0
        }
      },
      streamAblations: {
        all: {
          recallAt5: 1,
          recallAt10: 1,
          precisionAt5: 0.2,
          mrr: 1,
          ndcgAt10: 1
        },
        withoutEvidenceFts: {
          recallAt5: 0.5,
          recallAt10: 0.5,
          precisionAt5: 0.1,
          mrr: 0.5,
          ndcgAt10: 0.5
        },
        withoutFactsFts: {
          recallAt5: 0.5,
          recallAt10: 0.5,
          precisionAt5: 0.1,
          mrr: 0.5,
          ndcgAt10: 0.5
        }
      },
      queries: [
        {
          id: 'evidence-fts-policy',
          query: 'credential nonce validator',
          expectedEntityIds: ['file:bench/evidence-policy.ts'],
          recallAt5: 1,
          recallAt10: 1,
          precisionAt5: 0.2,
          mrr: 1,
          ndcgAt10: 1,
          returnedEntityIds: ['file:bench/evidence-policy.ts'],
          resourceUris: ['parallax://entities/file%3Abench%2Fevidence-policy.ts'],
          returnedBytes: 966,
          budgetExceeded: false
        }
      ]
    },
    outputPath: '.parallax/bench/impact-bench-report.json'
  };

  const merged = {
    ...report,
    ...overrides,
    summary: { ...report.summary, ...overrides.summary },
    scores: { ...report.scores, ...overrides.scores },
    analyzeDiff: { ...report.analyzeDiff, ...overrides.analyzeDiff },
    retrieval: { ...report.retrieval, ...overrides.retrieval }
  } as ImpactBenchReport;
  if ('crossRepoContracts' in overrides) {
    merged.crossRepoContracts = (overrides.crossRepoContracts === undefined
      ? undefined
      : { ...report.crossRepoContracts, ...overrides.crossRepoContracts }) as ImpactBenchReport['crossRepoContracts'];
  } else {
    merged.crossRepoContracts = report.crossRepoContracts;
  }
  if ('contractDiffQuality' in overrides) {
    merged.contractDiffQuality = (overrides.contractDiffQuality === undefined
      ? undefined
      : { ...report.contractDiffQuality, ...overrides.contractDiffQuality }) as ImpactBenchReport['contractDiffQuality'];
  } else {
    merged.contractDiffQuality = report.contractDiffQuality;
  }
  if ('coChangeQuality' in overrides) {
    merged.coChangeQuality = (overrides.coChangeQuality === undefined
      ? undefined
      : { ...report.coChangeQuality, ...overrides.coChangeQuality }) as ImpactBenchReport['coChangeQuality'];
  } else {
    merged.coChangeQuality = report.coChangeQuality;
  }
  if ('tracePromotionQuality' in overrides) {
    merged.tracePromotionQuality = (overrides.tracePromotionQuality === undefined
      ? undefined
      : { ...report.tracePromotionQuality, ...overrides.tracePromotionQuality }) as ImpactBenchReport['tracePromotionQuality'];
  } else {
    merged.tracePromotionQuality = report.tracePromotionQuality;
  }
  return merged;
}

test('bench report summary renders current metrics without a baseline', () => {
  const markdown = formatBenchSummaryMarkdown(makeReport());

  assert.match(markdown, /^## Impact Bench/);
  assert.match(markdown, /\*\*Status:\*\* passed/);
  assert.match(markdown, /\| Overall score \| 0\.9987 \| n\/a \|/);
  assert.match(markdown, /\| Matched relations \| 78\/78 \| n\/a \|/);
  assert.match(markdown, /\| Cross-repo contract impact \| 1\.0000 \| n\/a \|/);
  assert.match(markdown, /\| Cross-repo impacts \| 1\/1 \| n\/a \|/);
  assert.match(markdown, /\| Cross-repo graph edges \| 1\/1 \| n\/a \|/);
  assert.match(markdown, /\| Contract-diff quality \| 1\.0000 \| n\/a \|/);
  assert.match(markdown, /\| Contract-diff cases \| 6\/6 \| n\/a \|/);
  assert.match(markdown, /\| Contract-diff changes \| 6\/6 \| n\/a \|/);
  assert.match(markdown, /\| Co-change quality \| 1\.0000 \| n\/a \|/);
  assert.match(markdown, /\| Co-change partners \| 1\/1 \| n\/a \|/);
  assert.match(markdown, /\| Co-change affected files \| 1\/1 \| n\/a \|/);
  assert.match(markdown, /\| Trace-promotion quality \| 1\.0000 \| n\/a \|/);
  assert.match(markdown, /\| Trace promotions \| 1\/1 \| n\/a \|/);
  assert.match(markdown, /\| Trace proven affected files \| 1\/1 \| n\/a \|/);
  assert.match(markdown, /\| Trace unmatched edges \| 0 \| n\/a \|/);
  assert.match(markdown, /\| Semantic recall@1 \| 1\.0000 \| n\/a \|/);
  assert.match(markdown, /\| Semantic model isolation \| 1\.0000 \| n\/a \|/);
  assert.match(markdown, /\| `evidence-fts-policy` \| 1\.0000 \| 1\.0000 \| 966 \| no \|/);
  assert.match(markdown, /\| `bench-semantic-model-a` \| 1\.0000 \| yes \| `bench:model-a-policy` \|/);
  assert.match(markdown, /### Missing cross-repo consumers\n\nNone\./);
  assert.match(markdown, /### Missing contract-diff changes\n\nNone\./);
  assert.match(markdown, /### Missing co-change partners\n\nNone\./);
  assert.match(markdown, /### Missing co-change affected files\n\nNone\./);
  assert.match(markdown, /### Missing trace promotions\n\nNone\./);
  assert.match(markdown, /### Missing trace proven affected files\n\nNone\./);
  assert.match(markdown, /### Unmatched trace edges\n\nNone\./);
  assert.match(markdown, /### Missing relations\n\nNone\./);
  assert.match(markdown, /### Unexpected relations\n\nNone\./);
});

test('bench report summary renders metric and count deltas against a baseline', () => {
  const baseline = makeReport({
    summary: {
      passed: true,
      score: 0.9123,
      expectedRelations: 78,
      matchedRelations: 70,
      unexpectedRelations: 2
    },
    scores: {
      relationRecall: 0.9211,
      relationPrecision: 0.9459,
      affectedFileRecall: 0.9,
      evidencePresence: 0.95,
      spanCompleteness: 0.9,
      adapterAttribution: 0.98,
      contextPackReadiness: 1
    },
    analyzeDiff: {
      changedFiles: ['src/ts/session.ts'],
      expectedAffectedFiles: ['src/ts/namespace-consumer.ts', 'tests/session.test.ts'],
      matchedAffectedFiles: ['src/ts/namespace-consumer.ts']
    },
    crossRepoContracts: {
      ...makeReport().crossRepoContracts,
      summary: {
        passed: false,
        score: 0,
        expectedImpacts: 1,
        matchedImpacts: 0,
        expectedGraphEdges: 1,
        matchedGraphEdges: 0
      },
      matchedConsumerPaths: [],
      missingConsumerPaths: ['web:src/client.ts'],
      matchedEvidenceKinds: [],
      graphEdges: {
        expected: 1,
        matched: 0
      }
    },
    contractDiffQuality: {
      ...makeReport().contractDiffQuality,
      summary: {
        passed: false,
        score: 0.6667,
        expectedCases: 6,
        matchedCases: 4,
        expectedChanges: 6,
        matchedChanges: 4
      },
      cases: [
        {
          id: 'removed-response-required-property',
          score: 1,
          expectedChanges: 1,
          matchedChanges: 1,
          expectedChangeKeys: ['removed_response_required_property|breaking|responses.200.body.required.name'],
          matchedChangeKeys: ['removed_response_required_property|breaking|responses.200.body.required.name'],
          missingChangeKeys: []
        },
        {
          id: 'added-request-required-property',
          score: 0,
          expectedChanges: 1,
          matchedChanges: 0,
          expectedChangeKeys: ['added_request_required_property|breaking|requestBody.required.email'],
          matchedChangeKeys: [],
          missingChangeKeys: ['added_request_required_property|breaking|requestBody.required.email']
        },
        {
          id: 'changed-response-property-type',
          score: 0,
          expectedChanges: 1,
          matchedChanges: 0,
          expectedChangeKeys: ['changed_response_property_type|breaking|responses.200.body.properties.name'],
          matchedChangeKeys: [],
          missingChangeKeys: ['changed_response_property_type|breaking|responses.200.body.properties.name']
        },
        {
          id: 'removed-response-enum-value',
          score: 1,
          expectedChanges: 1,
          matchedChanges: 1,
          expectedChangeKeys: ['removed_response_property_enum_value|breaking|responses.200.body.properties.status.enum.string:"disabled"'],
          matchedChangeKeys: ['removed_response_property_enum_value|breaking|responses.200.body.properties.status.enum.string:"disabled"'],
          missingChangeKeys: []
        },
        {
          id: 'changed-response-property-format',
          score: 1,
          expectedChanges: 1,
          matchedChanges: 1,
          expectedChangeKeys: ['changed_response_property_format|breaking|responses.200.body.properties.id.format'],
          matchedChangeKeys: ['changed_response_property_format|breaking|responses.200.body.properties.id.format'],
          missingChangeKeys: []
        },
        {
          id: 'added-response-property-nullable',
          score: 1,
          expectedChanges: 1,
          matchedChanges: 1,
          expectedChangeKeys: ['added_response_property_nullable|breaking|responses.200.body.properties.id.nullable'],
          matchedChangeKeys: ['added_response_property_nullable|breaking|responses.200.body.properties.id.nullable'],
          missingChangeKeys: []
        }
      ],
      missingChanges: [
        'added-request-required-property: added_request_required_property|breaking|requestBody.required.email',
        'changed-response-property-type: changed_response_property_type|breaking|responses.200.body.properties.name'
      ]
    },
    coChangeQuality: {
      ...makeReport().coChangeQuality,
      summary: {
        passed: false,
        score: 0,
        expectedPartners: 1,
        matchedPartners: 0,
        expectedAffectedFiles: 1,
        matchedAffectedFiles: 0
      },
      matchedPartners: [],
      missingPartners: ['src/beta.ts'],
      matchedAffectedFiles: [],
      missingAffectedFiles: ['src/beta.ts']
    },
    tracePromotionQuality: {
      ...makeReport().tracePromotionQuality,
      summary: {
        passed: false,
        score: 0,
        expectedPromotions: 1,
        matchedPromotions: 0,
        expectedProvenAffectedFiles: 1,
        matchedProvenAffectedFiles: 0,
        unmatchedEdges: 1
      },
      matchedPromotedEdges: [],
      missingPromotedEdges: ['src/beta.ts->src/alpha.ts'],
      matchedProvenAffectedFiles: [],
      missingProvenAffectedFiles: ['src/beta.ts'],
      unmatchedEdges: ['src/beta.ts->src/alpha.ts']
    },
    retrieval: {
      ...makeReport().retrieval,
      summary: {
        recallAt5: 0.5,
        recallAt10: 0.5,
        precisionAt5: 0.1,
        mrr: 0.5,
        ndcgAt10: 0.5
      },
      semanticModels: {
        ...makeReport().retrieval.semanticModels!,
        summary: {
          passed: false,
          modelCount: 2,
          recallAt1: 0.5,
          isolation: 0.5
        }
      }
    }
  });

  const markdown = formatBenchSummaryMarkdown(makeReport(), { baseline });

  assert.match(markdown, /\*\*Status:\*\* passed \(baseline: passed\)/);
  assert.match(markdown, /\| Overall score \| 0\.9987 \| \+0\.0864 \|/);
  assert.match(markdown, /\| Relation recall \| 1\.0000 \| \+0\.0789 \|/);
  assert.match(markdown, /\| Matched relations \| 78\/78 \| \+8 \|/);
  assert.match(markdown, /\| Unexpected relations \| 0 \| -2 better \|/);
  assert.match(markdown, /\| Matched affected files \| 2\/2 \| \+1 \|/);
  assert.match(markdown, /\| Cross-repo contract impact \| 1\.0000 \| \+1\.0000 \|/);
  assert.match(markdown, /\| Cross-repo impacts \| 1\/1 \| \+1 \|/);
  assert.match(markdown, /\| Cross-repo graph edges \| 1\/1 \| \+1 \|/);
  assert.match(markdown, /\| Contract-diff quality \| 1\.0000 \| \+0\.3333 \|/);
  assert.match(markdown, /\| Contract-diff cases \| 6\/6 \| \+2 \|/);
  assert.match(markdown, /\| Contract-diff changes \| 6\/6 \| \+2 \|/);
  assert.match(markdown, /\| Co-change quality \| 1\.0000 \| \+1\.0000 \|/);
  assert.match(markdown, /\| Co-change partners \| 1\/1 \| \+1 \|/);
  assert.match(markdown, /\| Co-change affected files \| 1\/1 \| \+1 \|/);
  assert.match(markdown, /\| Trace-promotion quality \| 1\.0000 \| \+1\.0000 \|/);
  assert.match(markdown, /\| Trace promotions \| 1\/1 \| \+1 \|/);
  assert.match(markdown, /\| Trace proven affected files \| 1\/1 \| \+1 \|/);
  assert.match(markdown, /\| Trace unmatched edges \| 0 \| -1 better \|/);
  assert.match(markdown, /\| Retrieval recall@5 \| 1\.0000 \| \+0\.5000 \|/);
  assert.match(markdown, /\| Semantic recall@1 \| 1\.0000 \| \+0\.5000 \|/);
  assert.match(markdown, /\| Semantic model isolation \| 1\.0000 \| \+0\.5000 \|/);
});

test('bench report summary loads report files and tolerates a missing optional baseline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-bench-report-'));
  const reportPath = path.join(root, 'current.json');
  const missingBaselinePath = path.join(root, 'missing.json');
  await writeFile(reportPath, JSON.stringify(makeReport(), null, 2));

  const markdown = await generateBenchSummaryMarkdown({
    reportPath,
    baselinePath: missingBaselinePath
  });

  assert.match(markdown, /\| Overall score \| 0\.9987 \| n\/a \|/);
});

test('bench report summary accepts a schema v2 baseline without semantic metrics', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-bench-report-legacy-'));
  const reportPath = path.join(root, 'current.json');
  const baselinePath = path.join(root, 'baseline-v2.json');
  const {
    crossRepoContracts: _crossRepoContracts,
    contractDiffQuality: _contractDiffQuality,
    coChangeQuality: _coChangeQuality,
    tracePromotionQuality: _tracePromotionQuality,
    ...baseline
  } = makeReport({
    schemaVersion: 2
  });
  delete baseline.retrieval.semanticModels;
  await writeFile(reportPath, JSON.stringify(makeReport(), null, 2));
  await writeFile(baselinePath, JSON.stringify(baseline, null, 2));

  const markdown = await generateBenchSummaryMarkdown({
    reportPath,
    baselinePath
  });

  assert.match(markdown, /\| Overall score \| 0\.9987 \| \+0\.0000 \|/);
  assert.match(markdown, /\| Semantic recall@1 \| 1\.0000 \| n\/a \|/);
  assert.match(markdown, /\| Semantic model isolation \| 1\.0000 \| n\/a \|/);
});

test('bench report summary skips cross-repo rows for a schema v3 current report without crossRepoContracts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-bench-report-current-v3-'));
  const reportPath = path.join(root, 'current-v3.json');
  const current = makeReport({
    schemaVersion: 3,
    crossRepoContracts: undefined
  });
  await writeFile(reportPath, JSON.stringify(current, null, 2));

  const markdown = await generateBenchSummaryMarkdown({ reportPath });

  assert.doesNotMatch(markdown, /\| Cross-repo contract impact \|/);
  assert.doesNotMatch(markdown, /\| Cross-repo impacts \|/);
  assert.doesNotMatch(markdown, /\| Cross-repo graph edges \|/);
  assert.doesNotMatch(markdown, /### Missing cross-repo consumers/);
});

test('bench report summary skips contract-diff rows for a schema v4 current report without contractDiffQuality', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-bench-report-current-v4-'));
  const reportPath = path.join(root, 'current-v4.json');
  const current = makeReport({
    schemaVersion: 4,
    contractDiffQuality: undefined
  });
  await writeFile(reportPath, JSON.stringify(current, null, 2));

  const markdown = await generateBenchSummaryMarkdown({ reportPath });

  assert.doesNotMatch(markdown, /\| Contract-diff quality \|/);
  assert.doesNotMatch(markdown, /\| Contract-diff cases \|/);
  assert.doesNotMatch(markdown, /\| Contract-diff changes \|/);
  assert.doesNotMatch(markdown, /### Missing contract-diff changes/);
});

test('bench report summary skips co-change rows for a schema v5 current report without coChangeQuality', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-bench-report-current-v5-'));
  const reportPath = path.join(root, 'current-v5.json');
  const current = makeReport({
    schemaVersion: 5,
    coChangeQuality: undefined
  });
  await writeFile(reportPath, JSON.stringify(current, null, 2));

  const markdown = await generateBenchSummaryMarkdown({ reportPath });

  assert.doesNotMatch(markdown, /\| Co-change quality \|/);
  assert.doesNotMatch(markdown, /\| Co-change partners \|/);
  assert.doesNotMatch(markdown, /\| Co-change affected files \|/);
  assert.doesNotMatch(markdown, /### Missing co-change partners/);
  assert.doesNotMatch(markdown, /### Missing co-change affected files/);
});

test('bench report summary skips trace-promotion rows for a schema v6 current report without tracePromotionQuality', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-bench-report-current-v6-'));
  const reportPath = path.join(root, 'current-v6.json');
  const current = makeReport({
    schemaVersion: 6,
    tracePromotionQuality: undefined
  });
  await writeFile(reportPath, JSON.stringify(current, null, 2));

  const markdown = await generateBenchSummaryMarkdown({ reportPath });

  assert.doesNotMatch(markdown, /\| Trace-promotion quality \|/);
  assert.doesNotMatch(markdown, /\| Trace promotions \|/);
  assert.doesNotMatch(markdown, /\| Trace proven affected files \|/);
  assert.doesNotMatch(markdown, /\| Trace unmatched edges \|/);
  assert.doesNotMatch(markdown, /### Missing trace promotions/);
  assert.doesNotMatch(markdown, /### Missing trace proven affected files/);
  assert.doesNotMatch(markdown, /### Unmatched trace edges/);
});

test('loadBenchReport rejects a schema v4 current report without crossRepoContracts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-bench-report-invalid-v4-'));
  const reportPath = path.join(root, 'current-v4.json');
  const invalid = makeReport({
    schemaVersion: 4,
    crossRepoContracts: undefined
  });
  await writeFile(reportPath, JSON.stringify(invalid, null, 2));

  await assert.rejects(
    () => generateBenchSummaryMarkdown({ reportPath }),
    /invalid bench report .*crossRepoContracts/
  );
});

test('loadBenchReport rejects a schema v5 current report without contractDiffQuality', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-bench-report-invalid-v5-'));
  const reportPath = path.join(root, 'current-v5.json');
  const invalid = makeReport({
    schemaVersion: 5,
    contractDiffQuality: undefined
  });
  await writeFile(reportPath, JSON.stringify(invalid, null, 2));

  await assert.rejects(
    () => generateBenchSummaryMarkdown({ reportPath }),
    /invalid bench report .*contractDiffQuality/
  );
});

test('loadBenchReport rejects a schema v6 current report without coChangeQuality', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-bench-report-invalid-v6-'));
  const reportPath = path.join(root, 'current-v6.json');
  const invalid = makeReport({
    schemaVersion: 6,
    coChangeQuality: undefined
  });
  await writeFile(reportPath, JSON.stringify(invalid, null, 2));

  await assert.rejects(
    () => generateBenchSummaryMarkdown({ reportPath }),
    /invalid bench report .*coChangeQuality/
  );
});

test('loadBenchReport rejects a schema v7 current report without tracePromotionQuality', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-bench-report-invalid-v7-'));
  const reportPath = path.join(root, 'current-v7.json');
  const invalid = makeReport({
    schemaVersion: 7,
    tracePromotionQuality: undefined
  });
  await writeFile(reportPath, JSON.stringify(invalid, null, 2));

  await assert.rejects(
    () => generateBenchSummaryMarkdown({ reportPath }),
    /invalid bench report .*tracePromotionQuality/
  );
});

test('loadBenchReport rejects malformed schema v3 crossRepoContracts when present', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-bench-report-malformed-v3-'));
  const reportPath = path.join(root, 'current-v3-malformed.json');
  const invalid = {
    ...makeReport({ schemaVersion: 3 }),
    crossRepoContracts: {
      fixtureId: 'cross-repo-contract-impact-v0',
      summary: {
        passed: true,
        score: 1,
        expectedImpacts: 1,
        matchedImpacts: 1,
        expectedGraphEdges: 1
      }
    }
  };
  await writeFile(reportPath, JSON.stringify(invalid, null, 2));

  await assert.rejects(
    () => generateBenchSummaryMarkdown({ reportPath }),
    /invalid bench report .*crossRepoContracts\.summary\.matchedGraphEdges/
  );
});

test('bench report summary can write to GitHub step summary and allow missing reports', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-bench-report-missing-'));
  const summaryPath = path.join(root, 'summary.md');
  await mkdir(path.dirname(summaryPath), { recursive: true });

  await writeBenchSummary({
    reportPath: path.join(root, 'missing-report.json'),
    allowMissing: true,
    githubStepSummary: true,
    env: { GITHUB_STEP_SUMMARY: summaryPath }
  });

  const markdown = await readFile(summaryPath, 'utf8');
  assert.match(markdown, /^## Impact Bench/);
  assert.match(markdown, /No bench report was found/);
});
