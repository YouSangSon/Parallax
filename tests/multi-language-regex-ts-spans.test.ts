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

test('TypeScript JavaScript adapter records parser-backed local instance method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-instance-call-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    'export function authorize(token: string): boolean {',
    '  const guard = new SessionGuard();',
    '  return guard.validateSession(token);',
    '}',
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
        ['authorize', 'SessionGuard.validateSession', 'guard.validateSession(token)']
      ]
    );
    assert.equal(calls[0]?.start_line, 8);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed typed local variable instance method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-typed-local-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    '',
    'export function authorize(token: string): boolean {',
    '  const guard: SessionGuard = createGuard();',
    '  return guard.validateSession(token);',
    '}',
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
        ['authorize', 'SessionGuard.validateSession', 'guard.validateSession(token)']
      ]
    );
    assert.equal(calls[0]?.start_line, 9);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed factory return type instance method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-factory-return-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    '',
    'function createGuard(): SessionGuard {',
    '  return new SessionGuard();',
    '}',
    '',
    'export function authorize(token: string): boolean {',
    '  const guard = createGuard();',
    '  return guard.validateSession(token);',
    '}',
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
        ['authorize', 'createGuard', 'createGuard()'],
        ['authorize', 'SessionGuard.validateSession', 'guard.validateSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [12, 13]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.some((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed class field arrow method spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-field-method-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'export class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return this.normalizeToken(token).length > 0;',
    '  }',
    '',
    '  private normalizeToken = (token: string): string => token.trim();',
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
    assert.equal(
      declarations.find((row) => row.symbol === 'SessionGuard.normalizeToken')?.snippet,
      'private normalizeToken = (token: string): string => token.trim();'
    );

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

test('TypeScript JavaScript adapter records parser-backed calls from class field arrow methods', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-field-caller-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'export class SessionGuard {',
    '  validateSession = (token: string): boolean => {',
    '    return this.normalizeToken(token).length > 0;',
    '  };',
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
    assert.equal(
      declarations.find((row) => row.symbol === 'SessionGuard.validateSession')?.snippet,
      [
        'validateSession = (token: string): boolean => {',
        '    return this.normalizeToken(token).length > 0;',
        '  };'
      ].join('\n')
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

test('TypeScript JavaScript adapter records parser-backed class field instance method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-field-instance-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    '',
    'export class Coordinator {',
    '  private guard = new SessionGuard();',
    '',
    '  authorize(token: string): boolean {',
    '    return this.guard.validateSession(token);',
    '  }',
    '}',
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
        ['Coordinator.authorize', 'SessionGuard.validateSession', 'this.guard.validateSession(token)']
      ]
    );
    assert.equal(calls[0]?.start_line, 11);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('field-instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed typed class field instance method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-typed-field-instance-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    '',
    'export class Coordinator {',
    '  private guard: SessionGuard = createGuard();',
    '',
    '  authorize(token: string): boolean {',
    '    return this.guard.validateSession(token);',
    '  }',
    '}',
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
        ['Coordinator.authorize', 'SessionGuard.validateSession', 'this.guard.validateSession(token)']
      ]
    );
    assert.equal(calls[0]?.start_line, 11);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('field-instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed constructor parameter property method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-constructor-param-property-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    '',
    'export class Coordinator {',
    '  constructor(private guard: SessionGuard) {}',
    '',
    '  authorize(token: string): boolean {',
    '    return this.guard.validateSession(token);',
    '  }',
    '}',
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
        ['Coordinator.authorize', 'SessionGuard.validateSession', 'this.guard.validateSession(token)']
      ]
    );
    assert.equal(calls[0]?.start_line, 11);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('field-instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed constructor assignment method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-constructor-assignment-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    '',
    'export class Coordinator {',
    '  private guard: SessionGuard;',
    '',
    '  constructor(guard: SessionGuard) {',
    '    this.guard = guard;',
    '  }',
    '',
    '  authorize(token: string): boolean {',
    '    return this.guard.validateSession(token);',
    '  }',
    '}',
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
        ['Coordinator.authorize', 'SessionGuard.validateSession', 'this.guard.validateSession(token)']
      ]
    );
    assert.equal(calls[0]?.start_line, 15);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('field-instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed direct new instance method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-direct-new-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    '',
    'export function authorize(token: string): boolean {',
    '  return new SessionGuard().validateSession(token);',
    '}',
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
        ['authorize', 'SessionGuard.validateSession', 'new SessionGuard().validateSession(token)']
      ]
    );
    assert.equal(calls[0]?.start_line, 8);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('direct-instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed static class method call spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-static-method-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  static validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    '',
    'export function authorize(token: string): boolean {',
    '  return SessionGuard.validateSession(token);',
    '}',
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
        ['authorize', 'SessionGuard.validateSession', 'SessionGuard.validateSession(token)']
      ]
    );
    assert.equal(calls[0]?.start_line, 8);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('static-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter does not treat non-static class method access as a parser-backed static call', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-non-static-method-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    '',
    'export function authorize(token: string): boolean {',
    '  return SessionGuard.validateSession(token);',
    '}',
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
          r.provenance,
          ev.snippet
        FROM relations r
        INNER JOIN entities source ON source.id = r.source_entity_id
        INNER JOIN entities target ON target.id = r.target_entity_id
        INNER JOIN relation_evidence ev ON ev.relation_id = r.id
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
      }>;

    assert.deepEqual(calls, []);
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed typed parameter instance method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-typed-param-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    '',
    'export function authorize(guard: SessionGuard, token: string): boolean {',
    '  return guard.validateSession(token);',
    '}',
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
        ['authorize', 'SessionGuard.validateSession', 'guard.validateSession(token)']
      ]
    );
    assert.equal(calls[0]?.start_line, 8);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed interface typed parameter method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-interface-param-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'interface SessionValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    '',
    'export function authorize(guard: SessionValidator, token: string): boolean {',
    '  return guard.validateSession(token);',
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
        ['SessionValidator', 1],
        ['SessionValidator.validateSession', 2],
        ['authorize', 5]
      ]
    );
    assert.ok(declarations.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.equal(
      declarations.find((row) => row.symbol === 'SessionValidator.validateSession')?.snippet,
      'validateSession(token: string): boolean;'
    );

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
        ['authorize', 'SessionValidator.validateSession', 'guard.validateSession(token)']
      ]
    );
    assert.equal(calls[0]?.start_line, 6);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed interface function property dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-interface-property-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'interface SessionValidator {',
    '  validateSession: (token: string) => boolean;',
    '}',
    '',
    'export function authorize(guard: SessionValidator, token: string): boolean {',
    '  return guard.validateSession(token);',
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
        ['SessionValidator', 1],
        ['SessionValidator.validateSession', 2],
        ['authorize', 5]
      ]
    );
    assert.ok(declarations.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.equal(
      declarations.find((row) => row.symbol === 'SessionValidator.validateSession')?.snippet,
      'validateSession: (token: string) => boolean;'
    );

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
        ['authorize', 'SessionValidator.validateSession', 'guard.validateSession(token)']
      ]
    );
    assert.equal(calls[0]?.start_line, 6);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed interface extends dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-interface-extends-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'interface BaseSessionValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    '',
    'interface AuditableSessionValidator {',
    '  auditSession: (token: string) => boolean;',
    '}',
    '',
    'interface SessionValidator extends BaseSessionValidator, AuditableSessionValidator {}',
    '',
    'export function authorize(guard: SessionValidator, token: string): boolean {',
    '  return guard.validateSession(token) && guard.auditSession(token);',
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
        ['AuditableSessionValidator', 5],
        ['AuditableSessionValidator.auditSession', 6],
        ['BaseSessionValidator', 1],
        ['BaseSessionValidator.validateSession', 2],
        ['SessionValidator', 9],
        ['authorize', 11]
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
        ['authorize', 'BaseSessionValidator.validateSession', 'guard.validateSession(token)'],
        ['authorize', 'AuditableSessionValidator.auditSession', 'guard.auditSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [12, 12]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed type reference alias dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-type-reference-alias-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'interface SessionValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    '',
    'type GuardAlias = SessionValidator;',
    '',
    'type AuditValidator = {',
    '  auditSession: (token: string) => boolean;',
    '};',
    '',
    'type AuditAlias = GuardAuditAlias;',
    'type GuardAuditAlias = AuditValidator;',
    '',
    'export function authorize(guard: GuardAlias, audit: AuditAlias, token: string): boolean {',
    '  return guard.validateSession(token) && audit.auditSession(token);',
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
        ['AuditAlias', 11],
        ['AuditValidator', 7],
        ['AuditValidator.auditSession', 8],
        ['GuardAlias', 5],
        ['GuardAuditAlias', 12],
        ['SessionValidator', 1],
        ['SessionValidator.validateSession', 2],
        ['authorize', 14]
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
        ['authorize', 'SessionValidator.validateSession', 'guard.validateSession(token)'],
        ['authorize', 'AuditValidator.auditSession', 'audit.auditSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [15, 15]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed type literal member dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-type-literal-member-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'type SessionValidator = {',
    '  validateSession(token: string): boolean;',
    '  auditSession: (token: string) => boolean;',
    '};',
    '',
    'export function authorize(guard: SessionValidator, token: string): boolean {',
    '  return guard.validateSession(token) && guard.auditSession(token);',
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
        ['SessionValidator', 1],
        ['SessionValidator.auditSession', 3],
        ['SessionValidator.validateSession', 2],
        ['authorize', 6]
      ]
    );
    assert.ok(declarations.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.equal(
      declarations.find((row) => row.symbol === 'SessionValidator.validateSession')?.snippet,
      'validateSession(token: string): boolean;'
    );
    assert.equal(
      declarations.find((row) => row.symbol === 'SessionValidator.auditSession')?.snippet,
      'auditSession: (token: string) => boolean;'
    );

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
        ['authorize', 'SessionValidator.validateSession', 'guard.validateSession(token)'],
        ['authorize', 'SessionValidator.auditSession', 'guard.auditSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [7, 7]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed function type alias property dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-function-type-alias-property-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'type ValidatorFn = (token: string) => boolean;',
    '',
    'interface SessionValidator {',
    '  validateSession: ValidatorFn;',
    '  auditSession: ValidatorFn;',
    '}',
    '',
    'export function authorize(guard: SessionValidator, token: string): boolean {',
    '  return guard.validateSession(token) && guard.auditSession(token);',
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
        ['SessionValidator', 3],
        ['SessionValidator.auditSession', 5],
        ['SessionValidator.validateSession', 4],
        ['ValidatorFn', 1],
        ['authorize', 8]
      ]
    );
    assert.ok(declarations.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.equal(
      declarations.find((row) => row.symbol === 'SessionValidator.validateSession')?.snippet,
      'validateSession: ValidatorFn;'
    );
    assert.equal(
      declarations.find((row) => row.symbol === 'SessionValidator.auditSession')?.snippet,
      'auditSession: ValidatorFn;'
    );

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
        ['authorize', 'SessionValidator.validateSession', 'guard.validateSession(token)'],
        ['authorize', 'SessionValidator.auditSession', 'guard.auditSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [9, 9]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

function findEvidence(rows: readonly EvidenceRow[], kind: string, sourcePath: string): EvidenceRow {
  const row = rows.find((item) => item.kind === kind && item.source_path === sourcePath);
  assert.ok(row, `missing ${kind} evidence for ${sourcePath}`);
  return row;
}
