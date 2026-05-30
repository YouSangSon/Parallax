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

test('TypeScript JavaScript adapter records parser-backed type heritage relation spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-type-heritage-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'interface BaseValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    '',
    'type AuditableValidator = {',
    '  auditSession(token: string): boolean;',
    '};',
    '',
    'interface SessionValidator extends BaseValidator, AuditableValidator {}',
    '',
    'class BaseGuard {}',
    '',
    'class SessionGuard extends BaseGuard implements SessionValidator {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '  auditSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    ''
  ].join('\n'));

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const relations = db
      .prepare(`
        SELECT
          r.kind,
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
          AND r.kind IN ('EXTENDS', 'IMPLEMENTS')
          AND source.path = 'src/guard.ts'
          AND target.path = 'src/guard.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        kind: string;
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
      relations.map((row) => [
        row.kind,
        row.source_symbol,
        row.target_symbol,
        row.snippet
      ]),
      [
        ['EXTENDS', 'SessionValidator', 'BaseValidator', 'BaseValidator'],
        ['EXTENDS', 'SessionValidator', 'AuditableValidator', 'AuditableValidator'],
        ['EXTENDS', 'SessionGuard', 'BaseGuard', 'BaseGuard'],
        ['IMPLEMENTS', 'SessionGuard', 'SessionValidator', 'SessionValidator']
      ]
    );
    assert.deepEqual(relations.map((row) => row.start_line), [9, 9, 13, 13]);
    assert.ok(relations.every((row) => row.end_line !== null));
    assert.ok(relations.every((row) => row.start_col !== null));
    assert.ok(relations.every((row) => row.end_col !== null));
    assert.ok(relations.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(relations.every((row) => row.provenance.startsWith('typescript:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed imported type heritage relation spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-imported-type-heritage-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/base.ts'), [
    'export interface BaseValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    '',
    'export type AuditableValidator = {',
    '  auditSession(token: string): boolean;',
    '};',
    '',
    'export class BaseGuard {}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'import { BaseGuard } from "./base";',
    'import type { BaseValidator as Validator, AuditableValidator } from "./base";',
    '',
    'interface SessionValidator extends Validator, AuditableValidator {}',
    '',
    'class SessionGuard extends BaseGuard implements SessionValidator {}',
    ''
  ].join('\n'));

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const relations = db
      .prepare(`
        SELECT
          r.kind,
          source.path AS source_path,
          source.symbol AS source_symbol,
          target.path AS target_path,
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
          AND r.kind IN ('EXTENDS', 'IMPLEMENTS')
          AND source.path = 'src/guard.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        kind: string;
        source_path: string;
        source_symbol: string;
        target_path: string;
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
      relations.map((row) => [
        row.kind,
        row.source_symbol,
        row.target_path,
        row.target_symbol,
        row.snippet
      ]),
      [
        ['EXTENDS', 'SessionValidator', 'src/base.ts', 'BaseValidator', 'Validator'],
        ['EXTENDS', 'SessionValidator', 'src/base.ts', 'AuditableValidator', 'AuditableValidator'],
        ['EXTENDS', 'SessionGuard', 'src/base.ts', 'BaseGuard', 'BaseGuard'],
        ['IMPLEMENTS', 'SessionGuard', 'src/guard.ts', 'SessionValidator', 'SessionValidator']
      ]
    );
    assert.deepEqual(relations.map((row) => row.start_line), [4, 4, 6, 6]);
    assert.ok(relations.every((row) => row.end_line !== null));
    assert.ok(relations.every((row) => row.start_col !== null));
    assert.ok(relations.every((row) => row.end_col !== null));
    assert.ok(relations.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(relations.every((row) => row.provenance.startsWith('typescript:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed named re-exported type heritage and receiver spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-named-reexported-type-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/contracts.ts'), [
    'export interface SessionValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/barrel.ts'), [
    'export { SessionValidator } from "./contracts";',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'import type { SessionValidator as Validator } from "./barrel";',
    '',
    'type GuardAlias = Validator;',
    '',
    'interface ChildValidator extends Validator {}',
    '',
    'export function authorize(guard: GuardAlias, token: string): boolean {',
    '  return guard.validateSession(token);',
    '}',
    ''
  ].join('\n'));

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const relations = db
      .prepare(`
        SELECT
          r.kind,
          source.symbol AS source_symbol,
          target.path AS target_path,
          target.symbol AS target_symbol,
          ev.snippet,
          ev.start_line,
          adapter_runs.adapter_id
        FROM relations r
        INNER JOIN entities source ON source.id = r.source_entity_id
        INNER JOIN entities target ON target.id = r.target_entity_id
        INNER JOIN relation_evidence ev ON ev.relation_id = r.id
        LEFT JOIN adapter_runs ON adapter_runs.id = r.adapter_run_id
        WHERE r.index_run_id = ?
          AND r.kind = 'EXTENDS'
          AND source.path = 'src/guard.ts'
          AND target.path = 'src/contracts.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        kind: string;
        source_symbol: string;
        target_path: string;
        target_symbol: string;
        snippet: string;
        start_line: number | null;
        adapter_id: string | null;
      }>;

    assert.deepEqual(
      relations.map((row) => [
        row.kind,
        row.source_symbol,
        row.target_symbol,
        row.snippet
      ]),
      [
        ['EXTENDS', 'ChildValidator', 'SessionValidator', 'Validator']
      ]
    );
    assert.equal(relations[0]?.start_line, 5);
    assert.ok(relations.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));

    const calls = db
      .prepare(`
        SELECT
          source.symbol AS source_symbol,
          target.symbol AS target_symbol,
          r.provenance,
          ev.snippet,
          ev.start_line,
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
          AND target.path = 'src/contracts.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        source_symbol: string;
        target_symbol: string;
        provenance: string;
        snippet: string;
        start_line: number | null;
        adapter_id: string | null;
      }>;

    assert.deepEqual(
      calls.map((row) => [
        row.source_symbol,
        row.target_symbol,
        row.snippet
      ]),
      [
        ['authorize', 'SessionValidator.validateSession', 'guard.validateSession(token)']
      ]
    );
    assert.equal(calls[0]?.start_line, 8);
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed star re-exported type heritage and receiver spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-star-reexported-type-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/contracts.ts'), [
    'export interface SessionValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/barrel.ts'), [
    'export * from "./contracts";',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'import type { SessionValidator as Validator } from "./barrel";',
    '',
    'type GuardAlias = Validator;',
    '',
    'interface ChildValidator extends Validator {}',
    '',
    'export function authorize(guard: GuardAlias, token: string): boolean {',
    '  return guard.validateSession(token);',
    '}',
    ''
  ].join('\n'));

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const relations = db
      .prepare(`
        SELECT
          r.kind,
          source.symbol AS source_symbol,
          target.path AS target_path,
          target.symbol AS target_symbol,
          ev.snippet,
          ev.start_line,
          adapter_runs.adapter_id
        FROM relations r
        INNER JOIN entities source ON source.id = r.source_entity_id
        INNER JOIN entities target ON target.id = r.target_entity_id
        INNER JOIN relation_evidence ev ON ev.relation_id = r.id
        LEFT JOIN adapter_runs ON adapter_runs.id = r.adapter_run_id
        WHERE r.index_run_id = ?
          AND r.kind = 'EXTENDS'
          AND source.path = 'src/guard.ts'
          AND target.path = 'src/contracts.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        kind: string;
        source_symbol: string;
        target_path: string;
        target_symbol: string;
        snippet: string;
        start_line: number | null;
        adapter_id: string | null;
      }>;

    assert.deepEqual(
      relations.map((row) => [
        row.kind,
        row.source_symbol,
        row.target_symbol,
        row.snippet
      ]),
      [
        ['EXTENDS', 'ChildValidator', 'SessionValidator', 'Validator']
      ]
    );
    assert.equal(relations[0]?.start_line, 5);
    assert.ok(relations.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));

    const calls = db
      .prepare(`
        SELECT
          source.symbol AS source_symbol,
          target.symbol AS target_symbol,
          r.provenance,
          ev.snippet,
          ev.start_line,
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
          AND target.path = 'src/contracts.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        source_symbol: string;
        target_symbol: string;
        provenance: string;
        snippet: string;
        start_line: number | null;
        adapter_id: string | null;
      }>;

    assert.deepEqual(
      calls.map((row) => [
        row.source_symbol,
        row.target_symbol,
        row.snippet
      ]),
      [
        ['authorize', 'SessionValidator.validateSession', 'guard.validateSession(token)']
      ]
    );
    assert.equal(calls[0]?.start_line, 8);
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed namespace re-exported type heritage and receiver spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-namespace-reexported-type-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/contracts.ts'), [
    'export interface SessionValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/barrel.ts'), [
    'export * as Contracts from "./contracts";',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'import type { Contracts as ContractTypes } from "./barrel";',
    '',
    'type GuardAlias = ContractTypes.SessionValidator;',
    '',
    'interface ChildValidator extends ContractTypes.SessionValidator {}',
    '',
    'export function authorize(guard: GuardAlias, token: string): boolean {',
    '  return guard.validateSession(token);',
    '}',
    ''
  ].join('\n'));

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const relations = db
      .prepare(`
        SELECT
          r.kind,
          source.symbol AS source_symbol,
          target.path AS target_path,
          target.symbol AS target_symbol,
          ev.snippet,
          ev.start_line,
          adapter_runs.adapter_id
        FROM relations r
        INNER JOIN entities source ON source.id = r.source_entity_id
        INNER JOIN entities target ON target.id = r.target_entity_id
        INNER JOIN relation_evidence ev ON ev.relation_id = r.id
        LEFT JOIN adapter_runs ON adapter_runs.id = r.adapter_run_id
        WHERE r.index_run_id = ?
          AND r.kind = 'EXTENDS'
          AND source.path = 'src/guard.ts'
          AND target.path = 'src/contracts.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        kind: string;
        source_symbol: string;
        target_path: string;
        target_symbol: string;
        snippet: string;
        start_line: number | null;
        adapter_id: string | null;
      }>;

    assert.deepEqual(
      relations.map((row) => [
        row.kind,
        row.source_symbol,
        row.target_symbol,
        row.snippet
      ]),
      [
        ['EXTENDS', 'ChildValidator', 'SessionValidator', 'ContractTypes.SessionValidator']
      ]
    );
    assert.equal(relations[0]?.start_line, 5);
    assert.ok(relations.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));

    const calls = db
      .prepare(`
        SELECT
          source.symbol AS source_symbol,
          target.symbol AS target_symbol,
          r.provenance,
          ev.snippet,
          ev.start_line,
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
          AND target.path = 'src/contracts.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        source_symbol: string;
        target_symbol: string;
        provenance: string;
        snippet: string;
        start_line: number | null;
        adapter_id: string | null;
      }>;

    assert.deepEqual(
      calls.map((row) => [
        row.source_symbol,
        row.target_symbol,
        row.snippet
      ]),
      [
        ['authorize', 'SessionValidator.validateSession', 'guard.validateSession(token)']
      ]
    );
    assert.equal(calls[0]?.start_line, 8);
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed default imported type heritage relation spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-default-imported-type-heritage-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/base-guard.ts'), [
    'export default class BaseGuard {}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/base-validator.ts'), [
    'export default interface BaseValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'import BaseGuard from "./base-guard";',
    'import type Validator from "./base-validator";',
    '',
    'interface SessionValidator extends Validator {}',
    '',
    'class SessionGuard extends BaseGuard implements SessionValidator {}',
    ''
  ].join('\n'));

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const relations = db
      .prepare(`
        SELECT
          r.kind,
          source.path AS source_path,
          source.symbol AS source_symbol,
          target.path AS target_path,
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
          AND r.kind IN ('EXTENDS', 'IMPLEMENTS')
          AND source.path = 'src/guard.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        kind: string;
        source_path: string;
        source_symbol: string;
        target_path: string;
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
      relations.map((row) => [
        row.kind,
        row.source_symbol,
        row.target_path,
        row.target_symbol,
        row.snippet
      ]),
      [
        ['EXTENDS', 'SessionValidator', 'src/base-validator.ts', 'BaseValidator', 'Validator'],
        ['EXTENDS', 'SessionGuard', 'src/base-guard.ts', 'BaseGuard', 'BaseGuard'],
        ['IMPLEMENTS', 'SessionGuard', 'src/guard.ts', 'SessionValidator', 'SessionValidator']
      ]
    );
    assert.deepEqual(relations.map((row) => row.start_line), [4, 6, 6]);
    assert.ok(relations.every((row) => row.end_line !== null));
    assert.ok(relations.every((row) => row.start_col !== null));
    assert.ok(relations.every((row) => row.end_col !== null));
    assert.ok(relations.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(relations.every((row) => row.provenance.startsWith('typescript:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed default re-exported type heritage and receiver spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-default-reexported-type-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/contracts.ts'), [
    'export interface SessionValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/barrel.ts'), [
    'export { SessionValidator as default } from "./contracts";',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'import type Validator from "./barrel";',
    '',
    'type GuardAlias = Validator;',
    '',
    'interface ChildValidator extends Validator {}',
    '',
    'export function authorize(guard: GuardAlias, token: string): boolean {',
    '  return guard.validateSession(token);',
    '}',
    ''
  ].join('\n'));

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const relations = db
      .prepare(`
        SELECT
          r.kind,
          source.symbol AS source_symbol,
          target.path AS target_path,
          target.symbol AS target_symbol,
          ev.snippet,
          ev.start_line,
          adapter_runs.adapter_id
        FROM relations r
        INNER JOIN entities source ON source.id = r.source_entity_id
        INNER JOIN entities target ON target.id = r.target_entity_id
        INNER JOIN relation_evidence ev ON ev.relation_id = r.id
        LEFT JOIN adapter_runs ON adapter_runs.id = r.adapter_run_id
        WHERE r.index_run_id = ?
          AND r.kind = 'EXTENDS'
          AND source.path = 'src/guard.ts'
          AND target.path = 'src/contracts.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        kind: string;
        source_symbol: string;
        target_path: string;
        target_symbol: string;
        snippet: string;
        start_line: number | null;
        adapter_id: string | null;
      }>;

    assert.deepEqual(
      relations.map((row) => [
        row.kind,
        row.source_symbol,
        row.target_symbol,
        row.snippet
      ]),
      [
        ['EXTENDS', 'ChildValidator', 'SessionValidator', 'Validator']
      ]
    );
    assert.equal(relations[0]?.start_line, 5);
    assert.ok(relations.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));

    const calls = db
      .prepare(`
        SELECT
          source.symbol AS source_symbol,
          target.symbol AS target_symbol,
          r.provenance,
          ev.snippet,
          ev.start_line,
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
          AND target.path = 'src/contracts.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        source_symbol: string;
        target_symbol: string;
        provenance: string;
        snippet: string;
        start_line: number | null;
        adapter_id: string | null;
      }>;

    assert.deepEqual(
      calls.map((row) => [
        row.source_symbol,
        row.target_symbol,
        row.snippet
      ]),
      [
        ['authorize', 'SessionValidator.validateSession', 'guard.validateSession(token)']
      ]
    );
    assert.equal(calls[0]?.start_line, 8);
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed namespace imported type heritage relation spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-namespace-imported-type-heritage-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/base.ts'), [
    'export interface BaseValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    '',
    'export type AuditableValidator = {',
    '  auditSession(token: string): boolean;',
    '};',
    '',
    'export class BaseGuard {}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'import type * as Base from "./base";',
    '',
    'interface SessionValidator extends Base.BaseValidator, Base.AuditableValidator {}',
    '',
    'class SessionGuard extends Base.BaseGuard implements SessionValidator {}',
    ''
  ].join('\n'));

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const relations = db
      .prepare(`
        SELECT
          r.kind,
          source.path AS source_path,
          source.symbol AS source_symbol,
          target.path AS target_path,
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
          AND r.kind IN ('EXTENDS', 'IMPLEMENTS')
          AND source.path = 'src/guard.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        kind: string;
        source_path: string;
        source_symbol: string;
        target_path: string;
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
      relations.map((row) => [
        row.kind,
        row.source_symbol,
        row.target_path,
        row.target_symbol,
        row.snippet
      ]),
      [
        ['EXTENDS', 'SessionValidator', 'src/base.ts', 'BaseValidator', 'Base.BaseValidator'],
        ['EXTENDS', 'SessionValidator', 'src/base.ts', 'AuditableValidator', 'Base.AuditableValidator'],
        ['EXTENDS', 'SessionGuard', 'src/base.ts', 'BaseGuard', 'Base.BaseGuard'],
        ['IMPLEMENTS', 'SessionGuard', 'src/guard.ts', 'SessionValidator', 'SessionValidator']
      ]
    );
    assert.deepEqual(relations.map((row) => row.start_line), [3, 3, 5, 5]);
    assert.ok(relations.every((row) => row.end_line !== null));
    assert.ok(relations.every((row) => row.start_col !== null));
    assert.ok(relations.every((row) => row.end_col !== null));
    assert.ok(relations.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(relations.every((row) => row.provenance.startsWith('typescript:')));
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

test('TypeScript JavaScript adapter records parser-backed class extends inherited method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-class-extends-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class BaseGuard {',
    '  validateSession(token: string): boolean {',
    '    return this.normalizeToken(token).length > 0;',
    '  }',
    '',
    '  protected normalizeToken(token: string): string {',
    '    return token.trim();',
    '  }',
    '}',
    '',
    'class SessionGuard extends BaseGuard {',
    '  authorize(token: string): boolean {',
    '    return this.validateSession(token);',
    '  }',
    '}',
    '',
    'export function authorizeLocal(token: string): boolean {',
    '  const guard = new SessionGuard();',
    '  return guard.validateSession(token);',
    '}',
    '',
    'export function authorizeDirect(token: string): boolean {',
    '  return new SessionGuard().validateSession(token);',
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
        start_line: number | null;
        adapter_id: string | null;
      }>;

    assert.deepEqual(
      declarations.map((row) => [row.symbol, row.start_line]),
      [
        ['BaseGuard', 1],
        ['BaseGuard.normalizeToken', 6],
        ['BaseGuard.validateSession', 2],
        ['SessionGuard', 11],
        ['SessionGuard.authorize', 12],
        ['authorizeDirect', 22],
        ['authorizeLocal', 17],
        ['guard', 18]
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
        ['BaseGuard.validateSession', 'BaseGuard.normalizeToken', 'this.normalizeToken(token)'],
        ['SessionGuard.authorize', 'BaseGuard.validateSession', 'this.validateSession(token)'],
        ['authorizeLocal', 'BaseGuard.validateSession', 'guard.validateSession(token)'],
        ['authorizeDirect', 'BaseGuard.validateSession', 'new SessionGuard().validateSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [3, 13, 19, 23]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.deepEqual(
      calls.map((row) => row.provenance.split(':')[0]),
      ['method-call', 'method-call', 'instance-call', 'direct-instance-call']
    );
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed super receiver method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-super-receiver-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class BaseGuard {',
    '  validateSession(token: string): boolean {',
    '    return this.normalizeToken(token).length > 0;',
    '  }',
    '',
    '  protected normalizeToken(token: string): string {',
    '    return token.trim();',
    '  }',
    '}',
    '',
    'class SessionGuard extends BaseGuard {',
    '  authorize(token: string): boolean {',
    '    return super.validateSession(token);',
    '  }',
    '',
    '  audit(token: string): boolean {',
    '    return super["normalizeToken"](token).length > 0;',
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
        ['BaseGuard.validateSession', 'BaseGuard.normalizeToken', 'this.normalizeToken(token)'],
        ['SessionGuard.authorize', 'BaseGuard.validateSession', 'super.validateSession(token)'],
        ['SessionGuard.audit', 'BaseGuard.normalizeToken', 'super["normalizeToken"](token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [3, 13, 17]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.deepEqual(
      calls.map((row) => row.provenance.split(':')[0]),
      ['method-call', 'super-call', 'super-call']
    );
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

test('TypeScript JavaScript adapter records parser-backed declared typed local and field receiver dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-declared-typed-receiver-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'interface SessionValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    '',
    'class Coordinator {',
    '  private guard!: SessionValidator;',
    '',
    '  authorize(token: string): boolean {',
    '    return this.guard.validateSession(token);',
    '  }',
    '}',
    '',
    'export function authorize(guard: SessionValidator, token: string): boolean {',
    '  let selected: SessionValidator;',
    '  selected = guard;',
    '  return selected.validateSession(token);',
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
        ['Coordinator.authorize', 'SessionValidator.validateSession', 'this.guard.validateSession(token)'],
        ['authorize', 'SessionValidator.validateSession', 'selected.validateSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [9, 16]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.deepEqual(
      calls.map((row) => row.provenance.split(':')[0]),
      ['field-instance-call', 'instance-call']
    );
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

test('TypeScript JavaScript adapter records parser-backed direct factory call receiver method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-direct-factory-call-receiver-spans-'));
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
    'const createInferredGuard = () => new SessionGuard();',
    '',
    'export function authorize(token: string): boolean {',
    '  return createGuard().validateSession(token)',
    '    && createInferredGuard().validateSession(token);',
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
        ORDER BY ev.start_line, ev.start_col, ev.end_col
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
        ['authorize', 'SessionGuard.validateSession', 'createGuard().validateSession(token)'],
        ['authorize', 'createInferredGuard', 'createInferredGuard()'],
        ['authorize', 'SessionGuard.validateSession', 'createInferredGuard().validateSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [14, 14, 15, 15]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.equal(
      calls.filter((row) => row.provenance.startsWith('direct-factory-instance-call:')).length,
      2
    );
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed inferred factory return type instance method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-inferred-factory-return-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    '',
    'class AuditGuard {',
    '  auditSession(token: string): boolean {',
    '    return token.trim().length > 0;',
    '  }',
    '}',
    '',
    'function createGuard() {',
    '  return new SessionGuard();',
    '}',
    '',
    'const createAuditGuard = () => new AuditGuard();',
    '',
    'function createAliasedGuard() {',
    '  const guard = new SessionGuard();',
    '  return guard;',
    '}',
    '',
    'const createAliasedAuditGuard = () => {',
    '  const auditGuard = new AuditGuard();',
    '  return auditGuard;',
    '};',
    '',
    'function createWrappedGuard() {',
    '  return createGuard();',
    '}',
    '',
    'const createWrappedAuditGuard = () => createAuditGuard();',
    '',
    'export function authorize(token: string): boolean {',
    '  const guard = createGuard();',
    '  const auditGuard = createAuditGuard();',
    '  const aliasedGuard = createAliasedGuard();',
    '  const aliasedAuditGuard = createAliasedAuditGuard();',
    '  const wrappedGuard = createWrappedGuard();',
    '  const wrappedAuditGuard = createWrappedAuditGuard();',
    '  return guard.validateSession(token)',
    '    && auditGuard.auditSession(token)',
    '    && aliasedGuard.validateSession(token)',
    '    && aliasedAuditGuard.auditSession(token)',
    '    && wrappedGuard.validateSession(token)',
    '    && wrappedAuditGuard.auditSession(token);',
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
        ['createWrappedGuard', 'createGuard', 'createGuard()'],
        ['createWrappedAuditGuard', 'createAuditGuard', 'createAuditGuard()'],
        ['authorize', 'createGuard', 'createGuard()'],
        ['authorize', 'createAuditGuard', 'createAuditGuard()'],
        ['authorize', 'createAliasedGuard', 'createAliasedGuard()'],
        ['authorize', 'createAliasedAuditGuard', 'createAliasedAuditGuard()'],
        ['authorize', 'createWrappedGuard', 'createWrappedGuard()'],
        ['authorize', 'createWrappedAuditGuard', 'createWrappedAuditGuard()'],
        ['authorize', 'SessionGuard.validateSession', 'guard.validateSession(token)'],
        ['authorize', 'AuditGuard.auditSession', 'auditGuard.auditSession(token)'],
        ['authorize', 'SessionGuard.validateSession', 'aliasedGuard.validateSession(token)'],
        ['authorize', 'AuditGuard.auditSession', 'aliasedAuditGuard.auditSession(token)'],
        ['authorize', 'SessionGuard.validateSession', 'wrappedGuard.validateSession(token)'],
        ['authorize', 'AuditGuard.auditSession', 'wrappedAuditGuard.auditSession(token)']
      ]
    );
    assert.deepEqual(
      calls.map((row) => row.start_line),
      [30, 33, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47]
    );
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.equal(
      calls.filter((row) => row.provenance.startsWith('instance-call:')).length,
      6
    );
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed out-of-order factory wrapper return type instance method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-out-of-order-factory-wrapper-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    '',
    'class AuditGuard {',
    '  auditSession(token: string): boolean {',
    '    return token.trim().length > 0;',
    '  }',
    '}',
    '',
    'function createWrappedGuard() {',
    '  return createGuard();',
    '}',
    '',
    'const createWrappedAuditGuard = () => createAuditGuard();',
    '',
    'function createGuard() {',
    '  return new SessionGuard();',
    '}',
    '',
    'const createAuditGuard = () => new AuditGuard();',
    '',
    'export function authorize(token: string): boolean {',
    '  const guard = createWrappedGuard();',
    '  const auditGuard = createWrappedAuditGuard();',
    '  return guard.validateSession(token)',
    '    && auditGuard.auditSession(token);',
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
        ['createWrappedGuard', 'createGuard', 'createGuard()'],
        ['createWrappedAuditGuard', 'createAuditGuard', 'createAuditGuard()'],
        ['authorize', 'createWrappedGuard', 'createWrappedGuard()'],
        ['authorize', 'createWrappedAuditGuard', 'createWrappedAuditGuard()'],
        ['authorize', 'SessionGuard.validateSession', 'guard.validateSession(token)'],
        ['authorize', 'AuditGuard.auditSession', 'auditGuard.auditSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [14, 17, 26, 27, 28, 29]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.equal(
      calls.filter((row) => row.provenance.startsWith('instance-call:')).length,
      2
    );
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed namespace constructor factory return type instance method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-namespace-constructor-factory-return-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/contracts.ts'), [
    'export class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'import * as Contracts from "./contracts";',
    '',
    'function createGuard() {',
    '  return new Contracts.SessionGuard();',
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
          target.path AS target_path,
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
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        source_symbol: string;
        target_symbol: string;
        target_path: string;
        provenance: string;
        snippet: string;
        start_line: number | null;
        end_line: number | null;
        start_col: number | null;
        end_col: number | null;
        adapter_id: string | null;
      }>;

    assert.deepEqual(
      calls.map((row) => [row.source_symbol, row.target_path, row.target_symbol, row.snippet]),
      [
        ['authorize', 'src/guard.ts', 'createGuard', 'createGuard()'],
        [
          'authorize',
          'src/contracts.ts',
          'SessionGuard.validateSession',
          'guard.validateSession(token)'
        ]
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [8, 9]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.some((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed imported factory return type instance method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-imported-factory-return-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/contracts.ts'), [
    'export class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/factory.ts'), [
    'import { SessionGuard } from "./contracts";',
    '',
    'export function createGuard(): SessionGuard {',
    '  return new SessionGuard();',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'import { createGuard } from "./factory";',
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
          AND target.path = 'src/contracts.ts'
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
    assert.equal(calls[0]?.start_line, 5);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed re-exported factory return type instance method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-reexported-factory-return-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/contracts.ts'), [
    'export class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/factory.ts'), [
    'import { SessionGuard } from "./contracts";',
    '',
    'export function createGuard(): SessionGuard {',
    '  return new SessionGuard();',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/barrel.ts'), [
    'export { createGuard } from "./factory";',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'import { createGuard as makeGuard } from "./barrel";',
    '',
    'export function authorize(token: string): boolean {',
    '  const guard = makeGuard();',
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
          AND target.path = 'src/contracts.ts'
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
    assert.equal(calls[0]?.start_line, 5);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed star re-exported factory return type instance method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-star-reexported-factory-return-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/contracts.ts'), [
    'export class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/factory.ts'), [
    'import { SessionGuard } from "./contracts";',
    '',
    'export function createGuard(): SessionGuard {',
    '  return new SessionGuard();',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/barrel.ts'), [
    'export * from "./factory";',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'import { createGuard as makeGuard } from "./barrel";',
    '',
    'export function authorize(token: string): boolean {',
    '  const guard = makeGuard();',
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
          AND target.path = 'src/contracts.ts'
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
    assert.equal(calls[0]?.start_line, 5);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed namespace factory return type instance method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-namespace-factory-return-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/contracts.ts'), [
    'export class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/factory.ts'), [
    'import { SessionGuard } from "./contracts";',
    '',
    'export function createGuard(): SessionGuard {',
    '  return new SessionGuard();',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/barrel.ts'), [
    'export * as GuardFactories from "./factory";',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/namespace-guard.ts'), [
    'import * as GuardFactories from "./factory";',
    '',
    'export function authorizeNamespace(token: string): boolean {',
    '  const guard = GuardFactories.createGuard();',
    '  return guard.validateSession(token);',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/reexported-guard.ts'), [
    'import { GuardFactories as Factories } from "./barrel";',
    '',
    'export function authorizeReexported(token: string): boolean {',
    '  const guard = Factories.createGuard();',
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
          source.path AS source_path,
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
          AND source.path IN ('src/namespace-guard.ts', 'src/reexported-guard.ts')
          AND target.path = 'src/contracts.ts'
        ORDER BY source.path, ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        source_symbol: string;
        source_path: string;
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
      calls.map((row) => [
        row.source_symbol,
        row.source_path,
        row.target_symbol,
        row.snippet
      ]),
      [
        [
          'authorizeNamespace',
          'src/namespace-guard.ts',
          'SessionGuard.validateSession',
          'guard.validateSession(token)'
        ],
        [
          'authorizeReexported',
          'src/reexported-guard.ts',
          'SessionGuard.validateSession',
          'guard.validateSession(token)'
        ]
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [5, 5]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed default factory return type instance method dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-default-factory-return-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/contracts.ts'), [
    'export class SessionGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/default-factory.ts'), [
    'import { SessionGuard } from "./contracts";',
    '',
    'export default function createGuard(): SessionGuard {',
    '  return new SessionGuard();',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/named-factory.ts'), [
    'import { SessionGuard } from "./contracts";',
    '',
    'export function createGuard(): SessionGuard {',
    '  return new SessionGuard();',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/default-barrel.ts'), [
    'export { createGuard as default } from "./named-factory";',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/default-guard.ts'), [
    'import makeGuard from "./default-factory";',
    '',
    'export function authorizeDefault(token: string): boolean {',
    '  const guard = makeGuard();',
    '  return guard.validateSession(token);',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/reexported-default-guard.ts'), [
    'import makeGuard from "./default-barrel";',
    '',
    'export function authorizeReexportedDefault(token: string): boolean {',
    '  const guard = makeGuard();',
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
          source.path AS source_path,
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
          AND source.path IN ('src/default-guard.ts', 'src/reexported-default-guard.ts')
          AND target.path = 'src/contracts.ts'
        ORDER BY source.path, ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        source_symbol: string;
        source_path: string;
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
      calls.map((row) => [
        row.source_symbol,
        row.source_path,
        row.target_symbol,
        row.snippet
      ]),
      [
        [
          'authorizeDefault',
          'src/default-guard.ts',
          'SessionGuard.validateSession',
          'guard.validateSession(token)'
        ],
        [
          'authorizeReexportedDefault',
          'src/reexported-default-guard.ts',
          'SessionGuard.validateSession',
          'guard.validateSession(token)'
        ]
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [5, 5]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
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

test('TypeScript JavaScript adapter records parser-backed static class field arrow call spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-static-field-arrow-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  static validateSession = (token: string): boolean => token.length > 0;',
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
    assert.equal(calls[0]?.start_line, 6);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('static-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed inherited static class method call spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-inherited-static-method-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class BaseGuard {',
    '  static validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    '',
    'class SessionGuard extends BaseGuard {}',
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
        ['authorize', 'BaseGuard.validateSession', 'SessionGuard.validateSession(token)']
      ]
    );
    assert.equal(calls[0]?.start_line, 10);
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

test('TypeScript JavaScript adapter does not treat inherited non-static class method access as a parser-backed static call', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-inherited-non-static-method-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class BaseGuard {',
    '  validateSession(token: string): boolean {',
    '    return token.length > 0;',
    '  }',
    '}',
    '',
    'class SessionGuard extends BaseGuard {}',
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

test('TypeScript JavaScript adapter records parser-backed destructured typed receiver dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-destructured-typed-receiver-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  validateSession(token: string): boolean { return token.length > 0; }',
    '  auditSession(token: string): boolean { return token.length > 1; }',
    '}',
    '',
    'export function authorize({ guard, backup: auditGuard }: { guard: SessionGuard; backup: SessionGuard }, token: string): boolean {',
    '  const { guard: localGuard }: { guard: SessionGuard } = { guard };',
    '  return guard.validateSession(token) && auditGuard.auditSession(token) && localGuard.validateSession(token);',
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
        ['authorize', 'SessionGuard.validateSession', 'guard.validateSession(token)'],
        ['authorize', 'SessionGuard.auditSession', 'auditGuard.auditSession(token)'],
        ['authorize', 'SessionGuard.validateSession', 'localGuard.validateSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [8, 8, 8]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed named object destructured receiver dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-named-object-destructured-receiver-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  validateSession(token: string): boolean { return token.length > 0; }',
    '  auditSession(token: string): boolean { return token.length > 1; }',
    '}',
    'interface SessionContext {',
    '  guard: SessionGuard;',
    '  backup: SessionGuard;',
    '}',
    'type AliasContext = { aliasGuard: SessionGuard };',
    'type RenamedContext = SessionContext;',
    '',
    'export function authorize({ guard, backup: auditGuard }: SessionContext, { aliasGuard }: AliasContext, { guard: renamedGuard }: RenamedContext, token: string): boolean {',
    '  return guard.validateSession(token) && auditGuard.auditSession(token) && aliasGuard.validateSession(token) && renamedGuard.auditSession(token);',
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
        ['authorize', 'SessionGuard.validateSession', 'guard.validateSession(token)'],
        ['authorize', 'SessionGuard.auditSession', 'auditGuard.auditSession(token)'],
        ['authorize', 'SessionGuard.validateSession', 'aliasGuard.validateSession(token)'],
        ['authorize', 'SessionGuard.auditSession', 'renamedGuard.auditSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [13, 13, 13, 13]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed assertion-wrapped typed receiver dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-assertion-wrapped-receiver-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'interface SessionValidator {',
    '  validateSession(token: string): boolean;',
    '  auditSession(token: string): boolean;',
    '  normalizeSession(token: string): boolean;',
    '}',
    'type ValidatorAlias = SessionValidator;',
    '',
    'export function authorize(guard: SessionValidator, value: unknown, token: string): boolean {',
    '  return guard!.validateSession(token)',
    '    && (value as ValidatorAlias).auditSession(token)',
    '    && ((guard)).normalizeSession(token);',
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
        ['authorize', 'SessionValidator.validateSession', 'guard!.validateSession(token)'],
        ['authorize', 'SessionValidator.auditSession', '(value as ValidatorAlias).auditSession(token)'],
        ['authorize', 'SessionValidator.normalizeSession', '((guard)).normalizeSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [9, 10, 11]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed string-literal element access dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-element-access-dispatch-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  validateSession(token: string): boolean { return token.length > 0; }',
    '  auditSession(token: string): boolean { return token.length > 1; }',
    '  normalizeSession(token: string): boolean { return token.trim().length > 0; }',
    '}',
    'function createGuard(): SessionGuard { return new SessionGuard(); }',
    '',
    'export function authorize(guard: SessionGuard, token: string, methodName: string): boolean {',
    '  return guard["validateSession"](token)',
    '    && new SessionGuard()["auditSession"](token)',
    '    && createGuard()["normalizeSession"](token)',
    '    && guard[methodName](token);',
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
          AND target.symbol LIKE 'SessionGuard.%'
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
        ['authorize', 'SessionGuard.validateSession', 'guard["validateSession"](token)'],
        ['authorize', 'SessionGuard.auditSession', 'new SessionGuard()["auditSession"](token)'],
        ['authorize', 'SessionGuard.normalizeSession', 'createGuard()["normalizeSession"](token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [9, 10, 11]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.includes('-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed private member receiver dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-private-member-receiver-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'class SessionGuard {',
    '  validateSession(token: string): boolean { return token.length > 0; }',
    '  auditSession(token: string): boolean { return token.length > 1; }',
    '}',
    '',
    'export class SessionService {',
    '  #guard: SessionGuard;',
    '  #normalize = (token: string): string => token.trim();',
    '',
    '  constructor(guard: SessionGuard) {',
    '    this.#guard = guard;',
    '  }',
    '',
    '  authorize(token: string): boolean {',
    '    return this.#guard.validateSession(this.#normalize(token));',
    '  }',
    '',
    '  #authorizeInternal(token: string): boolean {',
    '    return this.#guard.auditSession(token);',
    '  }',
    '',
    '  run(token: string): boolean {',
    '    return this.#authorizeInternal(token);',
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
        ORDER BY ev.start_line, ev.start_col, target.symbol
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
        ['SessionService.authorize', 'SessionGuard.validateSession', 'this.#guard.validateSession(this.#normalize(token))'],
        ['SessionService.authorize', 'SessionService.#normalize', 'this.#normalize(token)'],
        ['SessionService.#authorizeInternal', 'SessionGuard.auditSession', 'this.#guard.auditSession(token)'],
        ['SessionService.run', 'SessionService.#authorizeInternal', 'this.#authorizeInternal(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [15, 15, 19, 23]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.includes('-call:')));
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

test('TypeScript JavaScript adapter records parser-backed imported interface typed receiver dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-imported-interface-receiver-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/contracts.ts'), [
    'export interface SessionValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    '',
    'export type AuditableValidator = {',
    '  auditSession: (token: string) => boolean;',
    '};',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'import type { SessionValidator as Validator, AuditableValidator } from "./contracts";',
    '',
    'type GuardAlias = Validator;',
    '',
    'export function authorize(guard: GuardAlias, audit: AuditableValidator, token: string): boolean {',
    '  return guard.validateSession(token) && audit.auditSession(token);',
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
          source.path AS source_path,
          target.symbol AS target_symbol,
          target.path AS target_path,
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
          AND target.path = 'src/contracts.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        source_symbol: string;
        source_path: string;
        target_symbol: string;
        target_path: string;
        provenance: string;
        snippet: string;
        start_line: number | null;
        end_line: number | null;
        start_col: number | null;
        end_col: number | null;
        adapter_id: string | null;
      }>;

    assert.deepEqual(
      calls.map((row) => [
        row.source_symbol,
        row.target_symbol,
        row.snippet
      ]),
      [
        ['authorize', 'SessionValidator.validateSession', 'guard.validateSession(token)'],
        ['authorize', 'AuditableValidator.auditSession', 'audit.auditSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [6, 6]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed default imported interface typed receiver dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-default-imported-interface-receiver-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/contracts.ts'), [
    'export default interface SessionValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'import type Validator from "./contracts";',
    '',
    'type GuardAlias = Validator;',
    '',
    'export function authorize(guard: GuardAlias, token: string): boolean {',
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
          source.path AS source_path,
          target.symbol AS target_symbol,
          target.path AS target_path,
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
          AND target.path = 'src/contracts.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        source_symbol: string;
        source_path: string;
        target_symbol: string;
        target_path: string;
        provenance: string;
        snippet: string;
        start_line: number | null;
        end_line: number | null;
        start_col: number | null;
        end_col: number | null;
        adapter_id: string | null;
      }>;

    assert.deepEqual(
      calls.map((row) => [
        row.source_symbol,
        row.target_symbol,
        row.snippet
      ]),
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

test('TypeScript JavaScript adapter records parser-backed namespace imported interface typed receiver dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-namespace-imported-interface-receiver-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/contracts.ts'), [
    'export interface SessionValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    '',
    'export type AuditableValidator = {',
    '  auditSession: (token: string) => boolean;',
    '};',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'import type * as Contracts from "./contracts";',
    '',
    'type GuardAlias = Contracts.SessionValidator;',
    '',
    'export function authorize(',
    '  guard: GuardAlias,',
    '  audit: Contracts.AuditableValidator,',
    '  token: string',
    '): boolean {',
    '  return guard.validateSession(token) && audit.auditSession(token);',
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
          source.path AS source_path,
          target.symbol AS target_symbol,
          target.path AS target_path,
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
          AND target.path = 'src/contracts.ts'
        ORDER BY ev.start_line, ev.start_col
      `)
      .all(index.indexRunId) as Array<{
        source_symbol: string;
        source_path: string;
        target_symbol: string;
        target_path: string;
        provenance: string;
        snippet: string;
        start_line: number | null;
        end_line: number | null;
        start_col: number | null;
        end_col: number | null;
        adapter_id: string | null;
      }>;

    assert.deepEqual(
      calls.map((row) => [
        row.source_symbol,
        row.target_symbol,
        row.snippet
      ]),
      [
        ['authorize', 'SessionValidator.validateSession', 'guard.validateSession(token)'],
        ['authorize', 'AuditableValidator.auditSession', 'audit.auditSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [10, 10]);
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

test('TypeScript JavaScript adapter records parser-backed alias-backed interface extends dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-interface-alias-extends-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'interface BaseSessionValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    '',
    'type AuditableSessionValidator = {',
    '  auditSession: (token: string) => boolean;',
    '};',
    '',
    'type BaseAlias = BaseSessionValidator;',
    'type CombinedValidator = BaseAlias & AuditableSessionValidator;',
    '',
    'interface SimpleSessionValidator extends BaseAlias {}',
    'interface SessionValidator extends CombinedValidator {}',
    '',
    'export function authorizeSimple(guard: SimpleSessionValidator, token: string): boolean {',
    '  return guard.validateSession(token);',
    '}',
    '',
    'export function authorizeCombined(guard: SessionValidator, token: string): boolean {',
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
        ['BaseAlias', 9],
        ['BaseSessionValidator', 1],
        ['BaseSessionValidator.validateSession', 2],
        ['CombinedValidator', 10],
        ['SessionValidator', 13],
        ['SimpleSessionValidator', 12],
        ['authorizeCombined', 19],
        ['authorizeSimple', 15]
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
        ['authorizeSimple', 'BaseSessionValidator.validateSession', 'guard.validateSession(token)'],
        ['authorizeCombined', 'BaseSessionValidator.validateSession', 'guard.validateSession(token)'],
        ['authorizeCombined', 'AuditableSessionValidator.auditSession', 'guard.auditSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [16, 20, 20]);
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

test('TypeScript JavaScript adapter records parser-backed intersection type alias dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-intersection-type-alias-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'interface BaseSessionValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    '',
    'type AuditableSessionValidator = {',
    '  auditSession: (token: string) => boolean;',
    '};',
    '',
    'type BaseAlias = BaseSessionValidator;',
    'type SessionValidator = BaseAlias & AuditableSessionValidator;',
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
        ['BaseAlias', 9],
        ['BaseSessionValidator', 1],
        ['BaseSessionValidator.validateSession', 2],
        ['SessionValidator', 10],
        ['authorize', 12]
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
    assert.deepEqual(calls.map((row) => row.start_line), [13, 13]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed direct intersection typed receiver dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-direct-intersection-type-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'interface BaseSessionValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    '',
    'type AuditableSessionValidator = {',
    '  auditSession: (token: string) => boolean;',
    '};',
    '',
    'export function authorize(',
    '  guard: BaseSessionValidator & AuditableSessionValidator,',
    '  token: string',
    '): boolean {',
    '  return guard.validateSession(token) && guard.auditSession(token);',
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
        ['authorize', 'BaseSessionValidator.validateSession', 'guard.validateSession(token)'],
        ['authorize', 'AuditableSessionValidator.auditSession', 'guard.auditSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [13, 13]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.ok(calls.every((row) => row.provenance.startsWith('instance-call:')));
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed union typed receiver dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-union-type-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'interface PrimarySessionValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    '',
    'type SecondarySessionValidator = {',
    '  validateSession: (token: string) => boolean;',
    '};',
    '',
    'type SessionValidator = PrimarySessionValidator | SecondarySessionValidator;',
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
        ORDER BY target.symbol
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
        ['authorize', 'PrimarySessionValidator.validateSession', 'guard.validateSession(token)'],
        ['authorize', 'SecondarySessionValidator.validateSession', 'guard.validateSession(token)']
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

test('TypeScript JavaScript adapter records parser-backed simple generic receiver dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-generic-receiver-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'interface SessionValidator<TToken> {',
    '  validateSession(token: TToken): boolean;',
    '}',
    '',
    'type AuditValidator<TToken> = {',
    '  auditSession: (token: TToken) => boolean;',
    '};',
    '',
    'type GuardAlias = SessionValidator<string>;',
    'type AuditAlias<TToken> = AuditValidator<TToken>;',
    '',
    'interface ExtendedValidator<TToken> extends SessionValidator<TToken> {}',
    '',
    'class BaseGuard<TToken> {',
    '  validateSession(token: TToken): boolean {',
    '    return Boolean(token);',
    '  }',
    '}',
    '',
    'class SessionGuard extends BaseGuard<string> {}',
    '',
    'export function authorize(',
    '  guard: SessionValidator<string>,',
    '  alias: GuardAlias,',
    '  extended: ExtendedValidator<string>,',
    '  audit: AuditAlias<string>,',
    '  token: string',
    '): boolean {',
    '  return guard.validateSession(token)',
    '    && alias.validateSession(token)',
    '    && extended.validateSession(token)',
    '    && audit.auditSession(token);',
    '}',
    '',
    'export function authorizeClass(token: string): boolean {',
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
        ['authorize', 'SessionValidator.validateSession', 'guard.validateSession(token)'],
        ['authorize', 'SessionValidator.validateSession', 'alias.validateSession(token)'],
        ['authorize', 'SessionValidator.validateSession', 'extended.validateSession(token)'],
        ['authorize', 'AuditValidator.auditSession', 'audit.auditSession(token)'],
        ['authorizeClass', 'BaseGuard.validateSession', 'new SessionGuard().validateSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [29, 30, 31, 32, 36]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.deepEqual(
      calls.map((row) => row.provenance.split(':')[0]),
      ['instance-call', 'instance-call', 'instance-call', 'instance-call', 'direct-instance-call']
    );
  } finally {
    db.close();
  }
});

test('TypeScript JavaScript adapter records parser-backed generic constraint receiver dispatch spans', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-ts-generic-constraint-receiver-spans-'));
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src/guard.ts'), [
    'interface SessionValidator {',
    '  validateSession(token: string): boolean;',
    '}',
    '',
    'type AuditableValidator = {',
    '  auditSession: (token: string) => boolean;',
    '};',
    '',
    'export function authorize<TGuard extends SessionValidator, TAudit extends AuditableValidator>(',
    '  guard: TGuard,',
    '  audit: TAudit,',
    '  token: string',
    '): boolean {',
    '  return guard.validateSession(token)',
    '    && audit.auditSession(token);',
    '}',
    '',
    'class Coordinator<TGuard extends SessionValidator> {',
    '  private guard!: TGuard;',
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
        ['authorize', 'SessionValidator.validateSession', 'guard.validateSession(token)'],
        ['authorize', 'AuditableValidator.auditSession', 'audit.auditSession(token)'],
        ['Coordinator.authorize', 'SessionValidator.validateSession', 'this.guard.validateSession(token)']
      ]
    );
    assert.deepEqual(calls.map((row) => row.start_line), [14, 15, 22]);
    assert.ok(calls.every((row) => row.end_line !== null));
    assert.ok(calls.every((row) => row.start_col !== null));
    assert.ok(calls.every((row) => row.end_col !== null));
    assert.ok(calls.every((row) => row.adapter_id === TS_JS_SEMANTIC_ADAPTER_ID));
    assert.deepEqual(
      calls.map((row) => row.provenance.split(':')[0]),
      ['instance-call', 'instance-call', 'field-instance-call']
    );
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
