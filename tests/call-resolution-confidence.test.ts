import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { indexProject, initProject } from '../src/index.js';
import { databasePath } from '../src/store.js';

process.env.PARALLAX_EMBEDDING_MODEL = 'stub-sha256';

// A5 — resolution-strength-aware confidence in the TS/JS call lane.
// Concretely-resolved calls (this.method, import-resolved, local) stay
// `inferred`; type-inferred receiver dispatch (`instance-call`) and object-flow
// aliases (`method-alias-call`) — the dynamic-dispatch approximations the
// knownGaps flags as not parser-backed — are honestly downgraded to `heuristic`.

async function indexCallFixture(): Promise<{ repoRoot: string; indexRunId: number }> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-call-confidence-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'src/svc.ts'),
    ['export class Service {', '  run(): number {', '    return 1;', '  }', '}', ''].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/main.ts'),
    [
      "import { Service } from './svc.js';",
      'export function main(): number {',
      '  const svc = new Service();',
      '  return svc.run();', // instance-call: inferred-type receiver -> heuristic
      '}',
      'export class Other {',
      '  helper(): number {',
      '    return 2;',
      '  }',
      '  go(): number {',
      '    return this.helper();', // method-call: concrete this-method -> inferred
      '  }',
      '}',
      ''
    ].join('\n')
  );
  await initProject({ repoRoot });
  const result = await indexProject({ repoRoot });
  return { repoRoot, indexRunId: result.indexRunId };
}

function callRowsByProvenancePrefix(repoRoot: string, indexRunId: number, prefix: string): string[] {
  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    return (
      db
        .prepare(
          `SELECT r.confidence AS confidence
           FROM relations r
           WHERE r.index_run_id = ? AND r.kind = 'CALLS' AND r.provenance LIKE ?
           ORDER BY r.provenance`
        )
        .all(indexRunId, `${prefix}%`) as Array<{ confidence: string }>
    ).map((row) => row.confidence);
  } finally {
    db.close();
  }
}

test('type-inferred instance-call dispatch is downgraded to heuristic confidence', async () => {
  const { repoRoot, indexRunId } = await indexCallFixture();
  const instanceConfidences = callRowsByProvenancePrefix(repoRoot, indexRunId, 'instance-call:');
  assert.ok(instanceConfidences.length > 0, 'fixture must produce at least one instance-call');
  assert.ok(
    instanceConfidences.every((confidence) => confidence === 'heuristic'),
    `instance-call dispatch must be heuristic, got ${JSON.stringify(instanceConfidences)}`
  );
});

test('concretely-resolved this-method calls stay inferred', async () => {
  const { repoRoot, indexRunId } = await indexCallFixture();
  const methodConfidences = callRowsByProvenancePrefix(repoRoot, indexRunId, 'method-call:');
  assert.ok(methodConfidences.length > 0, 'fixture must produce at least one this-method call');
  assert.ok(
    methodConfidences.every((confidence) => confidence === 'inferred'),
    `concrete this-method calls must stay inferred, got ${JSON.stringify(methodConfidences)}`
  );
});
