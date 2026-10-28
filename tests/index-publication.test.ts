import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { AdapterRegistry } from '../src/adapters/registry.js';
import type { EntityDescriptor, IndexEvent } from '../src/adapters/types.js';
import { indexProjectWithRegistryForTest } from '../src/indexer.js';
import { initProject } from '../src/init.js';
import { databasePath } from '../src/store.js';

test('relation endpoints advance freshness once per run without repeated search projection writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parallax-entity-freshness-'));
  try {
    await writeFile(path.join(root, 'input.ts'), 'export const value = 1;\n');
    await initProject({ repoRoot: root });
    const observer = new DatabaseSync(databasePath(root));
    try {
      // The indexer opens its own connection, so this fixture trigger is not TEMP.
      observer.exec(`
        CREATE TABLE freshness_observations (entity_id TEXT, old_run INTEGER, new_run INTEGER);
        CREATE TRIGGER observe_entity_freshness AFTER UPDATE OF updated_index_run_id ON entities
        BEGIN
          INSERT INTO freshness_observations VALUES (new.id, old.updated_index_run_id, new.updated_index_run_id);
        END;
      `);
    } finally {
      observer.close();
    }

    const target: EntityDescriptor = {
      kind: 'external_entity', languageId: 'typescript', displayName: 'Persistent marker',
      metadata: { specifier: 'shared-target' }
    };
    const targetId = 'external:typescript:shared-target';
    const registry = new AdapterRegistry();
    registry.register({
      id: 'freshness-observation', version: '1', capabilities: ['references'],
      supports: file => file.relativePath === 'input.ts',
      start: () => ({
        async *process(file): AsyncIterable<IndexEvent> {
          for (const kind of ['DEPENDS_ON', 'REFERENCES'] as const) {
            yield { kind: 'relation', relation: {
              source: { kind: 'file', path: file.relativePath }, target, kind,
              evidence: [{ file: file.relativePath, snippet: 'shared target', confidence: 'proven' }]
            } };
          }
          yield { kind: 'relation', relation: {
            source: target, target, kind: 'REFERENCES',
            evidence: [{ file: file.relativePath, snippet: 'self reference', confidence: 'proven' }]
          } };
        }
      })
    });

    const first = await indexProjectWithRegistryForTest({ repoRoot: root }, registry);
    const firstRead = new DatabaseSync(databasePath(root), { readOnly: true });
    try {
      const entity = firstRead.prepare('SELECT created_index_run_id, updated_index_run_id FROM entities WHERE id = ?').get(targetId);
      assert.equal(entity?.created_index_run_id, first.indexRunId);
      assert.equal(entity?.updated_index_run_id, first.indexRunId);
      assert.equal(firstRead.prepare("SELECT entity_id FROM search_entities_fts WHERE search_entities_fts MATCH 'Persistent'").get()?.entity_id, targetId);
    } finally {
      firstRead.close();
    }

    await writeFile(path.join(root, 'input.ts'), 'export const value = 2;\n');
    const second = await indexProjectWithRegistryForTest({ repoRoot: root }, registry);
    assert.equal(second.mode, 'full');
    assert.notEqual(second.indexRunId, first.indexRunId);
    // Read without openDatabase(), whose projection repair could hide a regression.
    const db = new DatabaseSync(databasePath(root), { readOnly: true });
    try {
      const entity = db.prepare('SELECT created_index_run_id, updated_index_run_id, display_name FROM entities WHERE id = ?').get(targetId);
      assert.equal(entity?.created_index_run_id, first.indexRunId);
      assert.equal(entity?.updated_index_run_id, second.indexRunId);
      assert.equal(entity?.display_name, 'Persistent marker');
      assert.deepEqual(db.prepare('SELECT index_run_id FROM entity_versions WHERE entity_id = ? ORDER BY index_run_id').all(targetId).map(row => row.index_run_id), [first.indexRunId, second.indexRunId]);
      const search = db.prepare("SELECT entity_id, display_name, CAST(updated_index_run_id AS INTEGER) AS run FROM search_entities_fts WHERE search_entities_fts MATCH 'Persistent'").all();
      assert.deepEqual(search.map(row => ({ ...row })), [{ entity_id: targetId, display_name: 'Persistent marker', run: second.indexRunId }]);
      assert.equal(db.prepare('SELECT count(*) AS count FROM relations WHERE index_run_id = ?').get(second.indexRunId)?.count, 3);
      assert.equal(db.prepare('SELECT count(*) AS count FROM relation_evidence WHERE index_run_id = ?').get(second.indexRunId)?.count, 3);
      assert.deepEqual(db.prepare('SELECT old_run, new_run FROM freshness_observations WHERE entity_id = ? AND old_run <> new_run').all(targetId).map(row => ({ ...row })), [{ old_run: first.indexRunId, new_run: second.indexRunId }]);
      assert.equal(db.prepare('SELECT count(*) AS count FROM freshness_observations WHERE old_run = new_run').get()?.count, 0);
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
