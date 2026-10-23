import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { AdapterRegistry } from '../src/adapters/registry.js';
import type { IndexEvent, SemanticAdapter } from '../src/adapters/types.js';
import { initProject } from '../src/index.js';
import { indexProjectWithRegistryForTest } from '../src/indexer.js';
import { databasePath } from '../src/store.js';

const owner = 'src/a.ts';
const other = 'src/b.ts';
const relation: IndexEvent = {
  kind: 'relation',
  relation: {
    source: { kind: 'file', path: owner },
    target: { kind: 'file', path: other },
    kind: 'DEPENDS_ON',
    evidence: [{ file: owner, snippet: 'b', confidence: 'proven' }]
  }
};

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-output-ownership-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, owner), 'export const a = 1;\n');
  await writeFile(path.join(root, other), 'export const b = 1;\n');
  await initProject({ repoRoot: root });
  return root;
}

function registry(event: IndexEvent, outputOwnership?: SemanticAdapter['outputOwnership']): AdapterRegistry {
  const result = new AdapterRegistry();
  result.register({
    id: 'ownership-test',
    version: '1',
    capabilities: ['references'],
    fileContentScope: 'target-only',
    ...(outputOwnership ? { outputOwnership } : {}),
    supports: (file) => file.language === 'typescript',
    start: () => ({
      async *process(file) {
        if (file.relativePath === owner) yield event;
      }
    })
  });
  return result;
}

function publishedState(root: string): unknown {
  const db = new DatabaseSync(databasePath(root), { readOnly: true });
  try {
    const tables = [
      'files', 'entities', 'entity_versions', 'relations', 'relation_evidence',
      'evidence', 'edges', 'symbols', 'transactions', 'transaction_parents',
      'facts', 'fact_provenance', 'branches'
    ];
    return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  } finally {
    db.close();
  }
}

const invalidEvents: Array<[string, IndexEvent]> = [
  ['foreign entity', { kind: 'entity', entity: { kind: 'file', path: other, displayName: 'foreign' } }],
  ['global identity with a local path', { kind: 'entity', entity: { kind: 'external_entity', path: owner, displayName: 'global' } }],
  ['symbol identity', { kind: 'entity', entity: { kind: 'symbol', path: owner, symbol: 'a' } }],
  ['foreign source', { kind: 'relation', relation: { ...relation.relation, source: { kind: 'file', path: other } } }],
  ['foreign evidence', { kind: 'relation', relation: { ...relation.relation, evidence: [{ file: other, confidence: 'proven' }] } }],
  ['foreign diagnostic', { kind: 'diagnostic', file: other, level: 'warn', message: 'foreign' }],
  ['unscoped diagnostic', { kind: 'diagnostic', level: 'warn', message: 'global' }],
  ['unindexed target', { kind: 'relation', relation: { ...relation.relation, target: { kind: 'file', path: 'missing.ts' } } }],
  ['foreign target metadata', { kind: 'relation', relation: { ...relation.relation, target: { kind: 'file', path: other, metadata: { marker: 'foreign' } } } }],
  ['foreign target symbol', { kind: 'relation', relation: { ...relation.relation, target: { kind: 'symbol', path: other, symbol: 'b' } } }]
];

for (const [label, event] of invalidEvents) {
  test(`processed-file ownership rejects ${label} without publishing a partial cohort`, async () => {
    const root = await fixture();
    try {
      const first = await indexProjectWithRegistryForTest({ repoRoot: root }, registry(relation, 'processed-file'));
      const before = publishedState(root);
      await writeFile(path.join(root, owner), 'export const a = 2;\n');
      await assert.rejects(
        indexProjectWithRegistryForTest({ repoRoot: root }, registry(event, 'processed-file')),
        /processed-file output ownership/
      );
      assert.deepEqual(publishedState(root), before);
      const db = new DatabaseSync(databasePath(root), { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT status FROM index_runs ORDER BY id DESC LIMIT 1').get()?.status, 'failed');
        assert.equal(db.prepare("SELECT max(id) AS id FROM index_runs WHERE status = 'completed'").get()?.id, first.indexRunId);
        assert.equal(db.prepare('SELECT status FROM adapter_runs ORDER BY id DESC LIMIT 1').get()?.status, 'failed');
      } finally {
        db.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('enabling processed-file ownership revalidates unchanged legacy output', async () => {
  const root = await fixture();
  try {
    const foreign = invalidEvents[0]![1];
    await indexProjectWithRegistryForTest({ repoRoot: root }, registry(foreign));
    const before = publishedState(root);
    await assert.rejects(
      indexProjectWithRegistryForTest({ repoRoot: root }, registry(foreign, 'processed-file')),
      /processed-file output ownership/
    );
    assert.deepEqual(publishedState(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('processed-file ownership snapshots each yield before later mutations', async () => {
  const root = await fixture();
  try {
    const output = structuredClone(relation);
    const adapter = registry(output, 'processed-file').list()[0]!;
    const isolated = new AdapterRegistry();
    isolated.register({
      ...adapter,
      start: () => ({
        async *process(file) {
          if (file.relativePath !== owner) return;
          yield { kind: 'entity', entity: { kind: 'file', path: owner } };
          yield output;
          (output.relation.source as { path: string }).path = other;
          (output.relation.evidence![0] as { file: string }).file = other;
          yield { kind: 'diagnostic', file: owner, level: 'warn', message: 'owned warning' };
        },
        dispose() {
          (output.relation.target as { path: string }).path = 'missing.ts';
        }
      })
    });
    const run = await indexProjectWithRegistryForTest({ repoRoot: root }, isolated);
    const db = new DatabaseSync(databasePath(root), { readOnly: true });
    try {
      assert.deepEqual(
        db.prepare('SELECT source_entity_id, target_entity_id FROM relations WHERE index_run_id = ?').all(run.indexRunId).map((row) => ({ ...row })),
        [{ source_entity_id: `file:${owner}`, target_entity_id: `file:${other}` }]
      );
      assert.equal(db.prepare('SELECT file_path FROM relation_evidence WHERE index_run_id = ?').get(run.indexRunId)?.file_path, owner);
      assert.ok(db.prepare("SELECT path FROM index_coverage WHERE index_run_id = ? AND reason = 'diagnostic warning: owned warning'").get(run.indexRunId)?.path?.toString().startsWith(`${owner}#diagnostic:`));
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('processed-file ownership isolates input files before adapter startup', async () => {
  const root = await fixture();
  try {
    const adapter = registry(relation, 'processed-file').list()[0]!;
    await indexProjectWithRegistryForTest({ repoRoot: root }, registry(relation, 'processed-file'));
    const before = publishedState(root);
    await writeFile(path.join(root, owner), 'export const a = 2;\n');
    const isolated = new AdapterRegistry();
    isolated.register({
      ...adapter,
      start: (_ctx, files) => {
        (files[0] as { relativePath: string }).relativePath = other;
        return { async *process() { yield relation; } };
      }
    });
    await assert.rejects(indexProjectWithRegistryForTest({ repoRoot: root }, isolated), TypeError);
    assert.deepEqual(publishedState(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
