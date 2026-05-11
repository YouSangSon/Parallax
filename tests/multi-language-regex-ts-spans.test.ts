import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { indexProject, initProject } from '../src/index.js';
import { databasePath } from '../src/store.js';
import { TS_JS_SEMANTIC_ADAPTER_ID } from '../src/adapters/multi-language-regex.js';

process.env.IMPACT_TRACE_EMBEDDING_MODEL = 'stub-sha256';

type EvidenceRow = {
  kind: string;
  source_path: string;
  target_path: string;
  snippet: string;
  start_line: number | null;
  end_line: number | null;
  start_col: number | null;
  end_col: number | null;
  adapter_id: string | null;
};

test('TypeScript JavaScript adapter records parser-backed import evidence spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'impact-trace-ts-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await mkdir(path.join(repoRoot, 'tests'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/session.ts'), [
    'export type Session = { id: string };',
    'export function validateSession(id: string): boolean {',
    '  return id.length > 0;',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/static.ts'), [
    'import { validateSession } from "./session";',
    'export const staticValue = validateSession("static");',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/type-only.ts'), [
    'import type { Session } from "./session";',
    'export type LocalSession = Session;',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/namespace.ts'), [
    'import * as session from "./session";',
    'export const namespaceValue = session.validateSession("namespace");',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/barrel.ts'), [
    'export { validateSession } from "./session";',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/dynamic.tsx'), [
    'export async function loadSession() {',
    '  return import("./session");',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/legacy.js'), [
    'const session = require("./session");',
    'module.exports = session;',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'tests/session.test.ts'), [
    'import { validateSession } from "../src/session";',
    'test("session", () => validateSession("test"));',
    ''
  ].join('\n'));

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const rows = db
      .prepare(`
        SELECT
          r.kind,
          source.path AS source_path,
          target.path AS target_path,
          ev.snippet,
          ev.start_line,
          ev.end_line,
          ev.start_col,
          ev.end_col,
          adapter_runs.adapter_id
        FROM relations r
        INNER JOIN entities source ON source.id = r.source_entity_id
        INNER JOIN entities target ON target.id = r.target_entity_id
        INNER JOIN relation_evidence ev ON ev.relation_id = r.id
        LEFT JOIN adapter_runs ON adapter_runs.id = r.adapter_run_id
        WHERE r.index_run_id = ?
          AND target.path = ?
        ORDER BY r.kind, source.path
      `)
      .all(index.indexRunId, 'src/session.ts') as EvidenceRow[];

    for (const sourcePath of [
      'src/barrel.ts',
      'src/dynamic.tsx',
      'src/legacy.js',
      'src/namespace.ts',
      'src/static.ts',
      'src/type-only.ts',
      'tests/session.test.ts'
    ]) {
      const row = findEvidence(rows, 'DEPENDS_ON', sourcePath);
      assert.equal(row.adapter_id, TS_JS_SEMANTIC_ADAPTER_ID);
      assert.equal(row.start_line === null, false, `${sourcePath} should have start_line`);
      assert.equal(row.end_line === null, false, `${sourcePath} should have end_line`);
      assert.equal(row.start_col === null, false, `${sourcePath} should have start_col`);
      assert.equal(row.end_col === null, false, `${sourcePath} should have end_col`);
      assert.equal(row.snippet.includes('./session') || row.snippet.includes('../src/session'), true);
      assert.equal(row.snippet.includes('export const'), false, `${sourcePath} snippet should not be whole-file evidence`);
      assert.equal(row.snippet.includes('module.exports'), false, `${sourcePath} snippet should not include following statements`);
      assert.equal(row.snippet.includes('test("session"'), false, `${sourcePath} snippet should not include test body`);
    }

    assert.equal(findEvidence(rows, 'DEPENDS_ON', 'src/static.ts').start_line, 1);
    assert.equal(findEvidence(rows, 'DEPENDS_ON', 'src/type-only.ts').start_line, 1);
    assert.equal(findEvidence(rows, 'DEPENDS_ON', 'src/namespace.ts').start_line, 1);
    assert.equal(findEvidence(rows, 'DEPENDS_ON', 'src/barrel.ts').start_line, 1);
    assert.equal(findEvidence(rows, 'DEPENDS_ON', 'src/dynamic.tsx').start_line, 2);
    assert.equal(findEvidence(rows, 'DEPENDS_ON', 'src/legacy.js').start_line, 1);

    const verifies = findEvidence(rows, 'VERIFIES', 'tests/session.test.ts');
    assert.equal(verifies.start_line, 1);
    assert.equal(verifies.adapter_id, TS_JS_SEMANTIC_ADAPTER_ID);
    assert.match(verifies.snippet, /^import /);
  } finally {
    db.close();
  }
});

function findEvidence(rows: readonly EvidenceRow[], kind: string, sourcePath: string): EvidenceRow {
  const row = rows.find((item) => item.kind === kind && item.source_path === sourcePath);
  assert.ok(row, `missing ${kind} evidence for ${sourcePath}`);
  return row;
}
