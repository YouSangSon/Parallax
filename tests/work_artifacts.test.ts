import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ImpactReport } from '../src/types.js';
import {
  isWorkArtifactEvidence,
  workArtifactEvidenceResourceUri,
  workArtifactPathSet,
  workArtifactsFromImpactReport
} from '../src/work_artifacts.js';

function makeReport(): ImpactReport {
  return {
    id: 'report-1',
    indexRunId: 7,
    changedFiles: ['src/auth/session.ts'],
    changed: [
      {
        id: 'file:src/auth/session.ts',
        kind: 'file',
        path: 'src/auth/session.ts',
        displayName: 'src/auth/session.ts'
      }
    ],
    affectedFiles: [
      {
        path: 'policies/security-auth.md',
        reason: 'governs src/auth/session.ts',
        confidence: 'heuristic',
        depth: 2,
        relationPath: ['GOVERNS']
      },
      {
        path: 'docs/decisions/auth-session.md',
        reason: 'documents src/auth/session.ts',
        confidence: 'inferred',
        depth: 1,
        relationPath: ['DOCUMENTS']
      },
      {
        path: 'src/auth/helper.ts',
        reason: 'imports src/auth/session.ts',
        confidence: 'proven',
        depth: 1,
        relationPath: ['IMPORTS']
      }
    ],
    affected: [
      {
        target: {
          id: 'file:policies/security-auth.md',
          kind: 'policy',
          path: 'policies/security-auth.md',
          displayName: 'policies/security-auth.md'
        },
        relations: ['GOVERNS'],
        confidence: 'heuristic'
      },
      {
        target: {
          id: 'file:policies/security-auth.md',
          kind: 'policy',
          path: 'policies/security-auth.md',
          displayName: 'duplicate should be ignored'
        },
        relations: ['GOVERNS'],
        confidence: 'heuristic'
      },
      {
        target: {
          id: 'file:docs/decisions/auth-session.md',
          kind: 'decision',
          path: 'docs/decisions/auth-session.md',
          displayName: 'docs/decisions/auth-session.md'
        },
        relations: ['DOCUMENTS'],
        confidence: 'inferred'
      },
      {
        target: {
          id: 'file:src/auth/helper.ts',
          kind: 'file',
          path: 'src/auth/helper.ts',
          displayName: 'src/auth/helper.ts'
        },
        relations: ['IMPORTS'],
        confidence: 'proven'
      }
    ],
    evidence: [
      {
        id: 'ev-policy',
        file: 'policies/security-auth.md',
        kind: 'GOVERNS',
        snippet: [
          '---',
          'title: Security Auth Policy',
          'owner: security-platform',
          'status: approved',
          'updated: 2000-01-01',
          '---',
          '# Security auth policy',
          ''
        ].join('\n'),
        confidence: 'heuristic',
        subject: {
          id: 'file:policies/security-auth.md',
          kind: 'policy',
          path: 'policies/security-auth.md'
        }
      },
      {
        id: 'ev-decision',
        file: 'docs/decisions/auth-session.md',
        kind: 'DOCUMENTS',
        snippet: [
          '---',
          'title: Auth session decision',
          'updated: 2026-02-30',
          '---',
          '# Auth session decision',
          ''
        ].join('\n'),
        confidence: 'inferred',
        subject: {
          id: 'file:docs/decisions/auth-session.md',
          kind: 'decision',
          path: 'docs/decisions/auth-session.md'
        }
      },
      {
        id: 'ev-policy-file-only',
        file: 'policies/security-auth.md',
        kind: 'GOVERNS',
        snippet: '# File-only policy evidence',
        confidence: 'heuristic'
      },
      {
        id: 'ev-helper',
        file: 'src/auth/helper.ts',
        kind: 'IMPORTS',
        snippet: 'import { session } from "./session";',
        confidence: 'proven',
        subject: {
          id: 'file:src/auth/helper.ts',
          kind: 'file',
          path: 'src/auth/helper.ts'
        }
      }
    ],
    actions: [],
    testCommands: []
  };
}

test('workArtifactPathSet returns only work artifact target paths', () => {
  assert.deepEqual([...workArtifactPathSet(makeReport())].sort(), [
    'docs/decisions/auth-session.md',
    'policies/security-auth.md'
  ]);
});

test('workArtifactsFromImpactReport extracts deduped metadata freshness and optional depth', () => {
  const artifacts = workArtifactsFromImpactReport(makeReport(), {
    asOfIso: '2026-06-18',
    includeDepth: true
  });

  assert.deepEqual(artifacts.map((item) => item.path), [
    'policies/security-auth.md',
    'docs/decisions/auth-session.md'
  ]);

  const policy = artifacts[0]!;
  assert.equal(policy.kind, 'policy');
  assert.equal(policy.displayName, 'Security Auth Policy');
  assert.equal(policy.depth, 2);
  assert.deepEqual(policy.metadata, {
    title: 'Security Auth Policy',
    owner: 'security-platform',
    status: 'approved',
    updatedAt: '2000-01-01',
    source: 'frontmatter'
  });
  assert.equal(policy.freshness.state, 'stale');
  assert.equal(policy.freshness.thresholdDays, 90);
  assert.ok((policy.freshness.ageDays ?? 0) > 90);

  const decision = artifacts[1]!;
  assert.equal(decision.kind, 'decision');
  assert.equal(decision.displayName, 'Auth session decision');
  assert.equal(decision.depth, 1);
  assert.equal(decision.metadata?.updatedAt, '2026-02-30');
  assert.equal(decision.freshness.state, 'unknown');
});

test('workArtifact evidence helpers identify artifact evidence and resource URIs', () => {
  const report = makeReport();
  const paths = workArtifactPathSet(report);
  const [policyEvidence, decisionEvidence, fileOnlyEvidence, helperEvidence] = report.evidence;

  assert.equal(isWorkArtifactEvidence(policyEvidence!, paths), true);
  assert.equal(isWorkArtifactEvidence(decisionEvidence!, paths), true);
  assert.equal(isWorkArtifactEvidence(fileOnlyEvidence!, paths), true);
  assert.equal(isWorkArtifactEvidence(helperEvidence!, paths), false);
  assert.equal(
    workArtifactEvidenceResourceUri(policyEvidence!, paths),
    `parallax://entities/${encodeURIComponent('file:policies/security-auth.md')}`
  );
  assert.equal(
    workArtifactEvidenceResourceUri(decisionEvidence!, paths),
    `parallax://entities/${encodeURIComponent('file:docs/decisions/auth-session.md')}`
  );
  assert.equal(
    workArtifactEvidenceResourceUri(fileOnlyEvidence!, paths),
    `parallax://entities/${encodeURIComponent('file:policies/security-auth.md')}`
  );
  assert.equal(workArtifactEvidenceResourceUri(helperEvidence!, paths), undefined);
});
