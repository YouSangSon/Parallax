import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { analyzeDiff, indexProject, initProject } from '../src/index.js';

const fixtureId = 'phase6b-multilanguage-v0';
const schemaVersion = 1;
const defaultOutputPath = '.impact-trace/bench/impact-bench-report.json';
const regexAdapterId = 'multi-language-regex-mvp';

export type ImpactBenchReport = {
  schemaVersion: 1;
  fixtureId: typeof fixtureId;
  summary: {
    passed: boolean;
    score: number;
    expectedRelations: number;
    matchedRelations: number;
    unexpectedRelations: number;
  };
  scores: {
    relationRecall: number;
    relationPrecision: number;
    affectedFileRecall: number;
    evidencePresence: number;
    spanCompleteness: number;
    adapterAttribution: number;
    contextPackReadiness: number;
  };
  missingRelations: string[];
  unexpectedRelations: string[];
  analyzeDiff: {
    changedFiles: string[];
    expectedAffectedFiles: string[];
    matchedAffectedFiles: string[];
  };
  outputPath: string;
};

export type RunImpactBenchOptions = {
  workspaceRoot?: string;
  outputPath?: string;
  keepFixture?: boolean;
};

type ExpectedRelation = {
  kind: string;
  sourceKind?: string;
  sourcePath: string;
  sourceSymbol?: string;
  targetKind?: string;
  targetPath?: string;
  targetSymbol?: string;
  targetDisplayName?: string;
  adapterId: string;
  label: string;
};

type ActualRelation = {
  kind: string;
  sourceKind: string;
  sourcePath: string | null;
  sourceSymbol: string | null;
  targetKind: string;
  targetPath: string | null;
  targetSymbol: string | null;
  targetDisplayName: string;
  adapterId: string | null;
  evidenceCount: number;
  spanCount: number;
};

type RelationMatch = {
  expected: ExpectedRelation;
  actual?: ActualRelation;
};

const expectedRelations: readonly ExpectedRelation[] = [
  relation('DEPENDS_ON', 'src/ts/private.ts', 'src/ts/session.ts', 'TS private route imports session'),
  relation('DEPENDS_ON', 'src/ts/widget.tsx', 'src/ts/session.ts', 'TSX widget imports session'),
  relation('DEPENDS_ON', 'src/js/legacy.js', 'src/ts/session.ts', 'JS require reaches TS session'),
  relation('DEPENDS_ON', 'tests/session.test.ts', 'src/ts/session.ts', 'TS test imports session'),
  relation('VERIFIES', 'tests/session.test.ts', 'src/ts/session.ts', 'TS test verifies session'),
  relation('DOCUMENTS', 'README.md', 'src/ts/session.ts', 'Markdown documents session'),
  relation('CONFIGURES', '.github/workflows/ci.yml', 'src/ts/session.ts', 'Workflow config references session'),
  endpointRelation('src/main/java/com/example/UserController.java', 'GET /api/users', 'Spring Java GET endpoint'),
  endpointRelation('src/main/java/com/example/UserController.java', 'POST /api/users', 'Spring Java POST endpoint'),
  relation('VERIFIES', 'src/test/java/com/example/UserControllerTest.java', 'src/main/java/com/example/UserController.java', 'Spring MVC test verifies controller'),
  endpointRelation('src/main/kotlin/com/example/AuditController.kt', 'GET /api/audits', 'Spring Kotlin GET endpoint'),
  relation('VERIFIES', 'src/test/kotlin/com/example/AuditControllerTest.kt', 'src/main/kotlin/com/example/AuditController.kt', 'Kotlin test verifies controller'),
  relation('CONFIGURES', 'src/main/resources/application.yml', 'src/main/java/com/example/UserService.java', 'Spring config references service'),
  relation('DEPENDS_ON', 'Dockerfile', 'src/main/java/com/example/UserController.java', 'Dockerfile COPY dependency'),
  relation('CONFIGURES', 'Dockerfile', 'src/main/java/com/example/UserController.java', 'Dockerfile copies controller'),
  relation('DEPENDS_ON', 'src/python/app.py', 'src/python/util.py', 'Python module imports util'),
  relation('VERIFIES', 'tests/python/test_util.py', 'src/python/util.py', 'Pytest verifies util'),
  relation('VERIFIES', 'src/go/calc_test.go', 'src/go/calc.go', 'Go test verifies calc'),
  relation('VERIFIES', 'src/rust/lib_test.rs', 'src/rust/lib.rs', 'Rust test verifies lib')
];

const changedFiles = ['src/ts/session.ts'] as const;
const expectedAffectedFiles = [
  '.github/workflows/ci.yml',
  'README.md',
  'src/js/legacy.js',
  'src/ts/private.ts',
  'src/ts/widget.tsx',
  'tests/session.test.ts'
] as const;

export async function runImpactBench(options: RunImpactBenchOptions = {}): Promise<ImpactBenchReport> {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const outputPath = path.resolve(workspaceRoot, options.outputPath ?? defaultOutputPath);
  const outputPathForReport = toPosixRelative(workspaceRoot, outputPath);
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'impact-bench-fixture-'));

  try {
    await writeFixture(fixtureRoot);
    await initProject({ repoRoot: fixtureRoot });
    const index = await indexProject({ repoRoot: fixtureRoot });
    const analyzeReport = await analyzeDiff({
      repoRoot: fixtureRoot,
      changedFiles: [...changedFiles],
      persistReport: false,
      readOnly: true
    });

    const db = new DatabaseSync(path.join(fixtureRoot, '.impact-trace/impact.db'), {
      readOnly: true
    });
    let actualRelations: ActualRelation[];
    try {
      actualRelations = loadActualRelations(db, index.indexRunId);
    } finally {
      db.close();
    }

    const relationMatches = matchExpectedRelations(actualRelations);
    const missingRelations = relationMatches
      .filter((match) => !match.actual)
      .map((match) => match.expected.label)
      .sort();
    const unexpectedRelations = findUnexpectedRelations(actualRelations).sort();
    const matchedRelations = relationMatches.filter((match) => match.actual).length;
    const matchedAffectedFiles = expectedAffectedFiles
      .filter((expected) => analyzeReport.affectedFiles.some((file) => file.path === expected))
      .sort();

    const relationRecall = ratio(matchedRelations, expectedRelations.length);
    const relationPrecision = ratio(
      matchedRelations,
      matchedRelations + unexpectedRelations.length
    );
    const affectedFileRecall = ratio(matchedAffectedFiles.length, expectedAffectedFiles.length);
    const evidencePresence = ratio(
      relationMatches.filter((match) => match.actual && match.actual.evidenceCount > 0).length,
      expectedRelations.length
    );
    const spanCompleteness = ratio(
      relationMatches.filter((match) => match.actual && match.actual.spanCount > 0).length,
      expectedRelations.length
    );
    const adapterAttribution = ratio(
      relationMatches.filter(
        (match) => match.actual && match.actual.adapterId === match.expected.adapterId
      ).length,
      expectedRelations.length
    );
    const contextPackReadiness = analyzeReport.evidence.length > 0
      && Buffer.byteLength(JSON.stringify(analyzeReport.evidence.slice(0, 20)), 'utf8') < 20_000
      ? 1
      : 0;

    const scores = {
      relationRecall,
      relationPrecision,
      affectedFileRecall,
      evidencePresence,
      spanCompleteness,
      adapterAttribution,
      contextPackReadiness
    };
    const score = weightedScore(scores);
    const passed =
      relationRecall >= 0.95 &&
      relationPrecision >= 0.95 &&
      affectedFileRecall === 1 &&
      evidencePresence === 1 &&
      adapterAttribution === 1 &&
      contextPackReadiness === 1 &&
      score >= 0.9;

    const report: ImpactBenchReport = {
      schemaVersion,
      fixtureId,
      summary: {
        passed,
        score,
        expectedRelations: expectedRelations.length,
        matchedRelations,
        unexpectedRelations: unexpectedRelations.length
      },
      scores,
      missingRelations,
      unexpectedRelations,
      analyzeDiff: {
        changedFiles: [...changedFiles],
        expectedAffectedFiles: [...expectedAffectedFiles],
        matchedAffectedFiles
      },
      outputPath: outputPathForReport
    };

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
  } finally {
    if (!options.keepFixture) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }
}

function relation(
  kind: string,
  sourcePath: string,
  targetPath: string,
  label: string
): ExpectedRelation {
  return {
    kind,
    sourceKind: fileKindForPath(sourcePath),
    sourcePath,
    targetKind: fileKindForPath(targetPath),
    targetPath,
    adapterId: regexAdapterId,
    label
  };
}

function endpointRelation(
  sourcePath: string,
  targetDisplayName: string,
  label: string
): ExpectedRelation {
  return {
    kind: 'IMPLEMENTS',
    sourceKind: 'file',
    sourcePath,
    targetKind: 'endpoint',
    targetDisplayName,
    adapterId: regexAdapterId,
    label
  };
}

async function writeFixture(repoRoot: string): Promise<void> {
  const dirs = [
    'src/ts',
    'src/js',
    'src/main/java/com/example',
    'src/main/kotlin/com/example',
    'src/main/resources',
    'src/test/java/com/example',
    'src/test/kotlin/com/example',
    'src/python',
    'tests/python',
    'src/go',
    'src/rust',
    '.github/workflows'
  ];
  await Promise.all(dirs.map((dir) => mkdir(path.join(repoRoot, dir), { recursive: true })));

  await writeFile(path.join(repoRoot, 'src/ts/session.ts'), [
    'export type Session = { token: string };',
    'export function validateSession(token: string): boolean {',
    '  return token.length > 0;',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/ts/types.ts'), 'export type RouteMode = "private";\n');
  await writeFile(path.join(repoRoot, 'src/ts/private.ts'), [
    'import type { Session } from "./session";',
    'import * as session from "./session";',
    'export function privateRoute(input: Session): string {',
    '  return session.validateSession(input.token) ? "ok" : "no";',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/ts/widget.tsx'), [
    'import { validateSession } from "./session";',
    'export function Widget() {',
    '  void import("./session");',
    '  return <span>{validateSession("demo") ? "ok" : "no"}</span>;',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/ts/barrel.ts'), 'export { validateSession } from "./session";\n');
  await writeFile(path.join(repoRoot, 'src/js/legacy.js'), [
    'const { validateSession } = require("../ts/session");',
    'exports.legacyRoute = function legacyRoute(token) {',
    '  return validateSession(token);',
    '};',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'tests/session.test.ts'), [
    'import { validateSession } from "../src/ts/session";',
    'test("validateSession", () => {',
    '  expect(validateSession("abc")).toBe(true);',
    '});',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'README.md'), 'The session boundary is src/ts/session.ts.\n');
  await writeFile(path.join(repoRoot, '.github/workflows/ci.yml'), [
    'name: ci',
    'on: [push]',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm test -- src/ts/session.ts',
    ''
  ].join('\n'));

  await writeFile(path.join(repoRoot, 'src/main/java/com/example/UserService.java'), [
    'package com.example;',
    'import org.springframework.stereotype.Service;',
    '@Service',
    'public class UserService {',
    '  public String listUsers() { return "users"; }',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/main/java/com/example/UserController.java'), [
    'package com.example;',
    'import org.springframework.web.bind.annotation.GetMapping;',
    'import org.springframework.web.bind.annotation.PostMapping;',
    'import org.springframework.web.bind.annotation.RequestMapping;',
    'import org.springframework.web.bind.annotation.RestController;',
    'import com.example.UserService;',
    '@RestController',
    '@RequestMapping("/api")',
    'public class UserController {',
    '  private final UserService userService;',
    '  public UserController(UserService userService) { this.userService = userService; }',
    '  @GetMapping("/users")',
    '  public String listUsers() { return userService.listUsers(); }',
    '  @PostMapping("/users")',
    '  public String createUser() { return "created"; }',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/main/java/com/example/User.java'), [
    'package com.example;',
    'import jakarta.persistence.Entity;',
    'import jakarta.persistence.Table;',
    '@Entity',
    '@Table(name = "users")',
    'public class User {',
    '  private Long id;',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/main/java/com/example/UserRepository.java'), [
    'package com.example;',
    'import org.springframework.data.jpa.repository.JpaRepository;',
    'import org.springframework.stereotype.Repository;',
    'import com.example.User;',
    '@Repository',
    'public interface UserRepository extends JpaRepository<User, Long> {}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/main/java/com/example/AppConfig.java'), [
    'package com.example;',
    'import java.time.Clock;',
    'import org.springframework.context.annotation.Bean;',
    'import org.springframework.context.annotation.Configuration;',
    '@Configuration',
    'public class AppConfig {',
    '  @Bean',
    '  public Clock auditClock() { return Clock.systemUTC(); }',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/test/java/com/example/UserControllerTest.java'), [
    'package com.example;',
    'import org.junit.jupiter.api.Test;',
    'import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;',
    'import com.example.UserController;',
    '@WebMvcTest(UserController.class)',
    'public class UserControllerTest {',
    '  @Test',
    '  void listUsers() {}',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/main/resources/application.yml'), [
    'impact:',
    '  owner: src/main/java/com/example/UserService.java',
    ''
  ].join('\n'));

  await writeFile(path.join(repoRoot, 'src/main/kotlin/com/example/AuditService.kt'), [
    'package com.example',
    'import org.springframework.stereotype.Service',
    '@Service',
    'class AuditService { fun listAudits(): String = "audits" }',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/main/kotlin/com/example/AuditController.kt'), [
    'package com.example',
    'import org.springframework.web.bind.annotation.GetMapping',
    'import org.springframework.web.bind.annotation.RequestMapping',
    'import org.springframework.web.bind.annotation.RestController',
    'import com.example.AuditService',
    '@RestController',
    '@RequestMapping("/api")',
    'class AuditController(private val auditService: AuditService) {',
    '  @GetMapping("/audits")',
    '  fun listAudits(): String = auditService.listAudits()',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/test/kotlin/com/example/AuditControllerTest.kt'), [
    'package com.example',
    'import org.junit.jupiter.api.Test',
    'import org.springframework.boot.test.context.SpringBootTest',
    'import com.example.AuditController',
    '@SpringBootTest',
    'class AuditControllerTest {',
    '  @Test fun listAudits() {}',
    '}',
    ''
  ].join('\n'));

  await writeFile(path.join(repoRoot, 'src/python/util.py'), [
    'def helper():',
    '    return "ok"',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/python/app.py'), [
    'from util import helper',
    'def run():',
    '    return helper()',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'tests/python/test_util.py'), [
    'from util import helper',
    'def test_helper():',
    '    assert helper() == "ok"',
    ''
  ].join('\n'));

  await writeFile(path.join(repoRoot, 'src/go/calc.go'), [
    'package calc',
    'func Add(a int, b int) int { return a + b }',
    'type Result struct { Value int }',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/go/calc_test.go'), [
    'package calc',
    'import "testing"',
    'func TestAdd(t *testing.T) { _ = Add(1, 2) }',
    ''
  ].join('\n'));

  await writeFile(path.join(repoRoot, 'src/rust/lib.rs'), [
    'pub fn run() -> bool { true }',
    'pub struct User;',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/rust/lib_test.rs'), [
    'use super::run;',
    '#[test]',
    'fn run_test() { assert!(run()); }',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'Dockerfile'), [
    'FROM eclipse-temurin:21',
    'COPY src/main/java/com/example/UserController.java /app/UserController.java',
    ''
  ].join('\n'));
}

function loadActualRelations(db: DatabaseSync, indexRunId: number): ActualRelation[] {
  return db.prepare(`
    SELECT
      r.kind,
      source.kind AS sourceKind,
      source.path AS sourcePath,
      source.symbol AS sourceSymbol,
      target.kind AS targetKind,
      target.path AS targetPath,
      target.symbol AS targetSymbol,
      target.display_name AS targetDisplayName,
      adapter_runs.adapter_id AS adapterId,
      count(relation_evidence.id) AS evidenceCount,
      sum(CASE WHEN relation_evidence.start_line IS NOT NULL THEN 1 ELSE 0 END) AS spanCount
    FROM relations r
    JOIN entities source ON source.id = r.source_entity_id
    JOIN entities target ON target.id = r.target_entity_id
    LEFT JOIN adapter_runs ON adapter_runs.id = r.adapter_run_id
    LEFT JOIN relation_evidence ON relation_evidence.relation_id = r.id
    WHERE r.index_run_id = ?
    GROUP BY r.id
    ORDER BY r.kind, source.kind, source.path, source.symbol, target.kind, target.path, target.symbol, target.display_name
  `).all(indexRunId) as ActualRelation[];
}

function matchExpectedRelations(actualRelations: readonly ActualRelation[]): RelationMatch[] {
  const actualByKey = new Map(actualRelations.map((actual) => [relationKey(actual), actual]));
  return expectedRelations.map((expected) => {
    const actual = actualByKey.get(relationKey(expected));
    return actual ? { expected, actual } : { expected };
  });
}

function findUnexpectedRelations(actualRelations: readonly ActualRelation[]): string[] {
  const expectedKeys = new Set(expectedRelations.map((expected) => relationKey(expected)));
  const expectedPaths = new Set(
    expectedRelations.flatMap((expected) =>
      [expected.sourcePath, expected.targetPath].filter((file): file is string => Boolean(file))
    )
  );
  return actualRelations
    .filter((actual) => {
      if (actual.kind === 'DECLARES') return false;
      if (actual.targetKind === 'external_entity') return false;
      if (actual.sourceKind === 'symbol') return false;
      if (!actual.sourcePath || !expectedPaths.has(actual.sourcePath)) return false;
      if (actual.targetPath && !expectedPaths.has(actual.targetPath)) return false;
      return !expectedKeys.has(relationKey(actual));
    })
    .map(formatActualRelation);
}

function relationKey(relationValue: ExpectedRelation | ActualRelation): string {
  const sourceKind = 'sourceKind' in relationValue && relationValue.sourceKind
    ? relationValue.sourceKind
    : 'file';
  const targetKind = 'targetKind' in relationValue && relationValue.targetKind
    ? relationValue.targetKind
    : 'file';
  const source = entityKey(sourceKind, relationValue.sourcePath, relationValue.sourceSymbol);
  const target = entityKey(
    targetKind,
    relationValue.targetPath,
    relationValue.targetSymbol,
    relationValue.targetDisplayName
  );
  return `${relationValue.kind}:${source}->${target}`;
}

function entityKey(
  kind: string,
  pathValue?: string | null,
  symbol?: string | null,
  displayName?: string | null
): string {
  if (kind === 'endpoint') {
    return `${kind}:${displayName ?? symbol ?? ''}`;
  }
  if (pathValue) {
    return `${kind}:${pathValue}${symbol ? `#${symbol}` : ''}`;
  }
  return `${kind}:${symbol ?? displayName ?? ''}`;
}

function formatActualRelation(actual: ActualRelation): string {
  return `${actual.kind}: ${entityKey(actual.sourceKind, actual.sourcePath, actual.sourceSymbol)} -> ${entityKey(
    actual.targetKind,
    actual.targetPath,
    actual.targetSymbol,
    actual.targetDisplayName
  )}`;
}

function fileKindForPath(filePath: string): string {
  if (filePath.endsWith('.md')) return 'doc';
  if (
    filePath.includes('/test') ||
    filePath.startsWith('tests/') ||
    /(?:^|[/\\]).*(?:[._-](?:test|spec)|Test)\.(?:[cm]?[tj]sx?|java|kt|py|go|rs)$/.test(filePath) ||
    /(?:^|[/\\])test_.*\.py$/.test(filePath)
  ) {
    return 'test';
  }
  if (filePath.startsWith('.github/workflows/')) return 'workflow';
  if (filePath === 'Dockerfile') return 'resource';
  if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) return 'config';
  return 'file';
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 1;
  return round(numerator / denominator);
}

function weightedScore(scores: ImpactBenchReport['scores']): number {
  return round(
    scores.relationRecall * 0.35 +
    scores.relationPrecision * 0.2 +
    scores.affectedFileRecall * 0.15 +
    scores.evidencePresence * 0.1 +
    scores.adapterAttribution * 0.1 +
    scores.contextPackReadiness * 0.05 +
    scores.spanCompleteness * 0.05
  );
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function toPosixRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/');
}

async function main(): Promise<void> {
  const report = await runImpactBench();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.summary.passed) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  await main();
}
