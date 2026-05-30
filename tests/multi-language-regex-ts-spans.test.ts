import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { indexProject, initProject } from '../src/index.js';
import { databasePath } from '../src/store.js';
import { TS_JS_SEMANTIC_ADAPTER_ID } from '../src/adapters/multi-language-regex.js';

process.env.PARALLAX_EMBEDDING_MODEL = 'stub-sha256';

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
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-spans-'));
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

test('TypeScript JavaScript adapter records parser-backed declaration and call spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-call-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/session.ts'), [
    'export type Session = { id: string };',
    'export function validateSession(id: string): boolean {',
    '  return id.length > 0;',
    '}',
    'export const createSession = (id: string): Session => ({ id });',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/consumer.ts'), [
    'import { validateSession as validate } from "./session";',
    'import * as session from "./session";',
    'export const direct = validate("direct");',
    'export const namespaced = session.validateSession("namespace");',
    ''
  ].join('\n'));

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const declarations = db
      .prepare(`
        SELECT
          target.symbol AS symbol,
          ev.snippet,
          ev.start_line,
          ev.end_line,
          ev.start_col,
          ev.end_col,
          adapter_runs.adapter_id
        FROM relations r
        INNER JOIN entities target ON target.id = r.target_entity_id
        INNER JOIN relation_evidence ev ON ev.relation_id = r.id
        LEFT JOIN adapter_runs ON adapter_runs.id = r.adapter_run_id
        WHERE r.index_run_id = ?
          AND r.kind = 'DECLARES'
          AND r.source_entity_id = 'file:src/session.ts'
        ORDER BY target.symbol
      `)
      .all(index.indexRunId) as Array<{
        symbol: string;
        snippet: string;
        start_line: number | null;
        end_line: number | null;
        start_col: number | null;
        end_col: number | null;
        adapter_id: string | null;
      }>;

    const validateDecl = declarations.find((row) => row.symbol === 'validateSession');
    assert.ok(validateDecl, 'validateSession declaration should be indexed');
    assert.equal(validateDecl.adapter_id, TS_JS_SEMANTIC_ADAPTER_ID);
    assert.equal(validateDecl.start_line, 2);
    assert.equal(validateDecl.start_col, 1);
    assert.match(validateDecl.snippet, /^export function validateSession/);
    assert.equal(validateDecl.snippet.includes('createSession'), false);

    const createDecl = declarations.find((row) => row.symbol === 'createSession');
    assert.ok(createDecl, 'createSession declaration should be indexed');
    assert.equal(createDecl.start_line, 5);
    assert.equal(createDecl.snippet, 'export const createSession = (id: string): Session => ({ id });');

    const calls = db
      .prepare(`
        SELECT
          r.provenance,
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
          AND r.kind = 'CALLS'
          AND source.path = 'src/consumer.ts'
          AND target.path = 'src/session.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        provenance: string;
        snippet: string;
        start_line: number | null;
        end_line: number | null;
        start_col: number | null;
        end_col: number | null;
        adapter_id: string | null;
      }>;

    assert.deepEqual(calls.map((row) => row.snippet), [
      'validate("direct")',
      'session.validateSession("namespace")'
    ]);
    assert.deepEqual(calls.map((row) => row.start_line), [3, 4]);
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed local symbol call spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-local-call-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/session.ts'), [
    'function normalizeToken(token: string): string {',
    '  return token.trim();',
    '}',
    'export function validateSession(token: string): boolean {',
    '  return normalizeToken(token).length > 0;',
    '}',
    'export const makeGuard = (token: string): boolean => validateSession(token);',
    ''
  ].join('\n'));

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const calls = db
      .prepare(`
        SELECT
          source.symbol AS source_symbol,
          target.symbol AS target_symbol,
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
          AND r.kind = 'CALLS'
          AND source.kind = 'symbol'
          AND target.kind = 'symbol'
          AND source.path = 'src/session.ts'
          AND target.path = 'src/session.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        source_symbol: string;
        target_symbol: string;
        snippet: string;
        start_line: number | null;
        end_line: number | null;
        start_col: number | null;
        end_col: number | null;
        adapter_id: string | null;
      }>;

    assert.deepEqual(
      calls.map((row) => [row.source_symbol, row.target_symbol, row.snippet]),
      [
        ['validateSession', 'normalizeToken', 'normalizeToken(token)'],
        ['makeGuard', 'validateSession', 'validateSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [5, 7]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed class method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-method-call-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'export class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return this.normalizeToken(token).length > 0;',
    '  }',
    '',
    '  private normalizeToken(token: string): string {',
    '    return token.trim();',
    '  }',
    '}',
    ''
  ].join('\n'));

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const declarations = db
      .prepare(`
        SELECT
          target.symbol AS symbol,
          ev.snippet,
          ev.start_line,
          adapter_runs.adapter_id
        FROM relations r
        INNER JOIN entities target ON target.id = r.target_entity_id
        INNER JOIN relation_evidence ev ON ev.relation_id = r.id
        LEFT JOIN adapter_runs ON adapter_runs.id = r.adapter_run_id
        WHERE r.index_run_id = ?
          AND r.kind = 'DECLARES'
          AND r.source_entity_id = 'file:src/guard.ts'
        ORDER BY target.symbol
      `)
      .all(index.indexRunId) as Array<{
        symbol: string;
        snippet: string;
        start_line: number | null;
        adapter_id: string | null;
      }>;

    assert.deepEqual(
      declarations.map((row) => [row.symbol, row.start_line]),
      [
        ['SessionGuard', 1],
        ['SessionGuard.normalizeToken', 6],
        ['SessionGuard.validateSession', 2]
      ]
    );
    assert.ok(declarations.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));

    const calls = db
      .prepare(`
        SELECT
          source.symbol AS source_symbol,
          target.symbol AS target_symbol,
          r.provenance,
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
          AND r.kind = 'CALLS'
          AND source.kind = 'symbol'
          AND target.kind = 'symbol'
          AND source.path = 'src/guard.ts'
          AND target.path = 'src/guard.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        source_symbol: string;
        target_symbol: string;
        provenance: string;
        snippet: string;
        start_line: number | null;
        end_line: number | null;
        start_col: number | null;
        end_col: number | null;
        adapter_id: string | null;
      }>;

    assert.deepEqual(
      calls.map((row) => [row.source_symbol, row.target_symbol, row.snippet]),
      [
        ['SessionGuard.validateSession', 'SessionGuard.normalizeToken', 'this.normalizeToken(token)']
      ]
    );
    assert.equal(calls[0]?.start_line, 3);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('method-call:')));
  } finally {
    db.close();
  }
});

function findEvidence(rows: readonly EvidenceRow[], kind: string, sourcePath: string): EvidenceRow {
  const row = rows.find((item) => item.kind === kind && item.source_path === sourcePath);
  assert.ok(row, `missing ${kind} evidence for ${sourcePath}`);
  return row;
}
