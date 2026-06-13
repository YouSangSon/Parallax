import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { analyzeDiff, indexProject, initProject } from '../src/index.js';
import { databasePath } from '../src/store.js';

// Dogfood guard: index Parallax's own source in an isolated temp repo and
// assert the internal DEPENDS_ON graph survives. This catches a class of
// regression that green unit tests cannot: real NodeNext `./x.js` imports
// collapsing to external_entity, which once made `src/store.ts` report zero
// code dependents while the whole unit suite stayed green. Floors (not exact
// counts) keep the test stable across legit refactors; the discriminator is
// the collapse to ~0, not the precise number.

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');

const MIN_PROVEN_SRC_DEPENDENTS = 5;
const MIN_INTERNAL_DEPENDS_ON_ROWS = 20;

function withDogfoodRepo(callback: (tempRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'parallax-dogfood-'));
  return (async () => {
    try {
      cpSync(path.join(repoRoot, 'src'), path.join(tempRoot, 'src'), { recursive: true });
      await initProject({ repoRoot: tempRoot });
      await indexProject({ repoRoot: tempRoot });
      await callback(tempRoot);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  })();
}

test('dogfood: analyzeDiff reports proven src dependents for store.ts', async () => {
  await withDogfoodRepo(async (tempRoot) => {
    // Arrange + Act: real user path on Parallax's own source.
    const report = await analyzeDiff({ repoRoot: tempRoot, changedFiles: ['src/store.ts'] });

    // Assert: the internal graph survives — many src dependents, all reachable
    // with proven confidence (not collapsed to external_entity).
    const provenSrcDependents = report.affectedFiles.filter(
      (file) => file.confidence === 'proven' && file.path.startsWith('src/')
    );
    assert.ok(
      provenSrcDependents.length >= MIN_PROVEN_SRC_DEPENDENTS,
      `expected >= ${MIN_PROVEN_SRC_DEPENDENTS} proven src dependents for src/store.ts, got ${provenSrcDependents.length}`
    );
    assert.ok(
      report.affectedFiles.some(
        (file) => file.confidence === 'proven' && file.path.startsWith('src/')
      ),
      'expected at least one proven affected file under src/'
    );
  });
});

test('dogfood: internal DEPENDS_ON edges resolve to local src entities, not external_entity', async () => {
  await withDogfoodRepo(async (tempRoot) => {
    // Secondary, raw-SQL pinpoint over the canonical relations + entities
    // tables (NOT the legacy `edges` table or the IMPORTS/imports projections,
    // which return 0 in both healthy and regressed states).
    const db = new DatabaseSync(databasePath(tempRoot), { readOnly: true });
    try {
      // Arrange + Act: count DEPENDS_ON edges whose target is a local src file.
      const internalEdges = db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM relations r
           JOIN entities target ON target.id = r.target_entity_id
           WHERE r.kind = 'DEPENDS_ON'
             AND target.path LIKE 'src/%'
             AND target.kind != 'external_entity'`
        )
        .get() as { count: number };

      const storeDependents = db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM relations r
           JOIN entities source ON source.id = r.source_entity_id
           WHERE r.kind = 'DEPENDS_ON'
             AND r.target_entity_id = 'file:src/store.ts'
             AND r.confidence = 'proven'
             AND source.path LIKE 'src/%'`
        )
        .get() as { count: number };

      // Assert: the internal dependency graph is present, not stripped to ~0.
      assert.ok(
        internalEdges.count > MIN_INTERNAL_DEPENDS_ON_ROWS,
        `expected > ${MIN_INTERNAL_DEPENDS_ON_ROWS} internal DEPENDS_ON edges to src targets, got ${internalEdges.count}`
      );
      assert.ok(
        storeDependents.count >= MIN_PROVEN_SRC_DEPENDENTS,
        `expected >= ${MIN_PROVEN_SRC_DEPENDENTS} proven src dependents of src/store.ts, got ${storeDependents.count}`
      );
    } finally {
      db.close();
    }
  });
});
