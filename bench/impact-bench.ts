import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { analyzeDiff, indexProject, initProject } from '../src/index.js';
import { searchContextForRepo } from '../src/mcp.js';
import {
  GO_SEMANTIC_ADAPTER_ID,
  JVM_SPRING_SEMANTIC_ADAPTER_ID,
  MULTI_LANG_REGEX_ADAPTER_ID,
  PYTHON_SEMANTIC_ADAPTER_ID,
  RUST_SEMANTIC_ADAPTER_ID,
  TS_JS_SEMANTIC_ADAPTER_ID
} from '../src/adapters/multi-language-regex.js';
import { BUILD_SYSTEM_PACKAGE_ADAPTER_ID } from '../src/adapters/build-system-package.js';

const fixtureId = 'phase6b-multilanguage-v0';
const schemaVersion = 2;
const defaultOutputPath = '.impact-trace/bench/impact-bench-report.json';
const regexAdapterId = MULTI_LANG_REGEX_ADAPTER_ID;
const retrievalFixtureId = 'search-context-retrieval-v0';

export type ImpactBenchReport = {
  schemaVersion: 2;
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
  expectedRelationLabels: string[];
  analyzeDiff: {
    changedFiles: string[];
    expectedAffectedFiles: string[];
    matchedAffectedFiles: string[];
  };
  retrieval: RetrievalBenchReport;
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

type RetrievalBenchReport = {
  fixtureId: typeof retrievalFixtureId;
  summary: RetrievalMetrics;
  budgets: {
    brief: {
      maxReturnedBytes: number;
      budgetExceededCount: number;
    };
  };
  streamAblations: {
    all: RetrievalMetrics;
    withoutEvidenceFts: RetrievalMetrics;
    withoutFactsFts: RetrievalMetrics;
  };
  queries: RetrievalQueryReport[];
};

type RetrievalMetrics = {
  recallAt5: number;
  recallAt10: number;
  precisionAt5: number;
  mrr: number;
  ndcgAt10: number;
};

type RetrievalQuerySpec = {
  id: string;
  query: string;
  expectedEntityIds: string[];
};

type RetrievalQueryReport = RetrievalQuerySpec & RetrievalMetrics & {
  returnedEntityIds: string[];
  resourceUris: string[];
  returnedBytes: number;
  budgetExceeded: boolean;
};

type SearchContextBenchResult = {
  results: Array<{ entity: { id: string }; resourceUri: string }>;
  limits: { returnedBytes: number; budgetExceeded: boolean };
};

const retrievalQueries: readonly RetrievalQuerySpec[] = [
  {
    id: 'evidence-fts-policy',
    query: 'credential nonce validator',
    expectedEntityIds: ['file:bench/evidence-policy.ts']
  },
  {
    id: 'facts-fts-policy',
    query: 'checkout retry policy',
    expectedEntityIds: ['file:bench/fact-policy.ts']
  }
];

const expectedRelations: readonly ExpectedRelation[] = [
  languageRelation('DEPENDS_ON', 'src/ts/type-only.ts', 'src/ts/session.ts', 'TS type-only import reaches session'),
  languageRelation('DEPENDS_ON', 'src/ts/namespace-consumer.ts', 'src/ts/session.ts', 'TS namespace import reaches session'),
  languageRelation('DEPENDS_ON', 'src/ts/private.ts', 'src/ts/session.ts', 'TS private route imports session'),
  languageRelation('DEPENDS_ON', 'src/ts/widget.tsx', 'src/ts/session.ts', 'TSX dynamic import reaches session'),
  languageRelation('DEPENDS_ON', 'src/ts/static-widget.tsx', 'src/ts/session.ts', 'TSX static import reaches session'),
  languageRelation('DEPENDS_ON', 'src/ts/barrel.ts', 'src/ts/session.ts', 'TS re-export barrel reaches session'),
  languageRelation('DEPENDS_ON', 'src/ts/alias-consumer.ts', 'src/ts/session.ts', 'TS path alias import reaches session'),
  languageRelation('DEPENDS_ON', 'src/js/legacy.js', 'src/ts/session.ts', 'JS require reaches TS session'),
  languageRelation('DEPENDS_ON', 'tests/session.test.ts', 'src/ts/session.ts', 'TS test imports session'),
  languageRelation('VERIFIES', 'tests/session.test.ts', 'src/ts/session.ts', 'TS test verifies session'),
  fallbackRelation('DOCUMENTS', 'README.md', 'src/ts/session.ts', 'Markdown documents session'),
  fallbackRelation('CONFIGURES', '.github/workflows/ci.yml', 'src/ts/session.ts', 'Workflow config references session'),
  packageDeclareRelation('package.json', '@acme/impact-bench', 'npm package declares bench workspace package'),
  packageManifestIdentityRelation('package.json', 'npm package identity depends on package manifest'),
  packageDependencyRelation('package.json', 'typescript', 'npm package depends on TypeScript package'),
  packageManifestIdentityRelation('pyproject.toml', 'Python package identity depends on pyproject manifest'),
  packageDependencyRelation('pyproject.toml', 'fastapi', 'Python project dependency depends on FastAPI package'),
  packageDependencyRelation('pyproject.toml', 'pytest', 'Python optional dependency depends on pytest package'),
  packageDependencyRelation('pyproject.toml', 'mypy', 'Python dependency group depends on mypy package'),
  packageDependencyRelation('pyproject.toml', 'mkdocs', 'Poetry dependency group depends on mkdocs package'),
  packageManifestIdentityRelation('pom.xml', 'Maven package identity depends on build manifest'),
  packageDependencyRelation('pom.xml', 'org.springframework.boot:spring-boot-starter-web', 'Maven property dependency depends on Spring Web package'),
  packageManifestIdentityRelation('app/build.gradle.kts', 'Gradle package identity depends on build manifest'),
  packageDependencyRelation('app/build.gradle.kts', 'org.springframework.boot:spring-boot-starter-web', 'Gradle version catalog alias depends on Spring Web package'),
  buildSystemConfigRelation('go.work', 'services/go-api/go.mod', 'Go workspace includes service module'),
  buildSystemConfigRelation('go.work', 'libs/go-shared/go.mod', 'Go workspace includes shared module'),
  packageManifestIdentityRelation('services/go-api/go.mod', 'Go service package identity depends on module manifest'),
  packageManifestIdentityRelation('libs/go-shared/go.mod', 'Go shared package identity depends on module manifest'),
  localPackageDependencyRelation('services/go-api/go.mod', 'libs/go-shared/go.mod', 'Go replace dependency depends on local shared module'),
  endpointRelation('src/main/java/com/example/UserController.java', 'GET /api/users', 'Spring Java GET endpoint'),
  endpointRelation('src/main/java/com/example/UserController.java', 'POST /api/users', 'Spring Java POST endpoint'),
  languageRelation('DEPENDS_ON', 'src/main/java/com/example/UserController.java', 'src/main/java/com/example/UserService.java', 'Spring controller imports service'),
  languageRelation('DEPENDS_ON', 'src/test/java/com/example/UserControllerTest.java', 'src/main/java/com/example/UserController.java', 'Spring @WebMvcTest imports controller'),
  languageRelation('VERIFIES', 'src/test/java/com/example/UserControllerTest.java', 'src/main/java/com/example/UserController.java', 'Spring @WebMvcTest verifies controller'),
  endpointRelation('src/main/kotlin/com/example/AuditController.kt', 'GET /api/audits', 'Spring Kotlin GET endpoint'),
  languageRelation('DEPENDS_ON', 'src/test/kotlin/com/example/AuditControllerTest.kt', 'src/main/kotlin/com/example/AuditController.kt', 'Kotlin @SpringBootTest imports controller'),
  languageRelation('VERIFIES', 'src/test/kotlin/com/example/AuditControllerTest.kt', 'src/main/kotlin/com/example/AuditController.kt', 'Kotlin @SpringBootTest verifies controller'),
  springDeclareRelation('src/main/java/com/example/AppConfig.java', 'AppConfig', 'Spring @Configuration declares config class'),
  springDeclareRelation('src/main/java/com/example/AppConfig.java', 'auditClock', 'Spring @Bean declares bean method'),
  springDeclareRelation('src/main/java/com/example/AppProperties.java', 'AppProperties', 'Spring @ConfigurationProperties declares properties class'),
  fallbackRelation('CONFIGURES', 'src/main/resources/application.yml', 'src/main/java/com/example/UserService.java', 'Spring application.yml references service'),
  fallbackRelation('CONFIGURES', 'src/main/resources/application.properties', 'src/main/java/com/example/AppProperties.java', 'Spring application.properties references configuration properties'),
  springDeclareRelation('src/main/java/com/example/User.java', 'User', 'JPA @Entity declares persistence entity'),
  springDeclareRelation('src/main/java/com/example/UserRepository.java', 'UserRepository', 'Spring Data repository declares repository'),
  languageRelation('DEPENDS_ON', 'src/main/java/com/example/UserRepository.java', 'src/main/java/com/example/User.java', 'Spring Data repository imports entity'),
  languageRelation('DEPENDS_ON', 'src/test/java/com/example/UserRepositoryTest.java', 'src/main/java/com/example/UserRepository.java', 'Spring @DataJpaTest imports repository'),
  languageRelation('VERIFIES', 'src/test/java/com/example/UserRepositoryTest.java', 'src/main/java/com/example/UserRepository.java', 'Spring @DataJpaTest verifies repository'),
  springDeclareRelation('src/main/java/com/example/CatalogClient.java', 'CatalogClient', 'Spring Feign @FeignClient declares client'),
  externalRelation('DEPENDS_ON', 'src/main/java/com/example/UserClient.java', 'org.springframework.web.reactive.function.client.WebClient', 'Spring WebClient import declares client dependency'),
  externalRelation('DEPENDS_ON', 'src/main/java/com/example/AdminClient.java', 'org.springframework.web.client.RestTemplate', 'Spring RestTemplate import declares client dependency'),
  contractEndpointRelation('contracts/openapi.yaml', 'GET /api/users', 'OpenAPI contract declares users endpoint'),
  contractReferenceRelation('contracts/openapi.yaml', 'src/main/java/com/example/UserController.java', 'OpenAPI contract references controller implementation'),
  contractImplementerRelation('src/main/java/com/example/UserController.java', 'contracts/openapi.yaml', 'Spring controller implements OpenAPI contract'),
  fallbackRelation('DEPENDS_ON', 'Dockerfile', 'src/main/java/com/example/UserController.java', 'Dockerfile COPY dependency'),
  fallbackRelation('CONFIGURES', 'Dockerfile', 'src/main/java/com/example/UserController.java', 'Dockerfile copies controller'),
  languageDeclareRelation('src/python/util.py', 'Helper', 'Python class declares Helper'),
  languageDeclareRelation('src/python/util.py', 'helper', 'Python function declares helper'),
  languageRelation('DEPENDS_ON', 'src/python/app.py', 'src/python/util.py', 'Python module imports util'),
  languageRelation('VERIFIES', 'tests/python/test_util.py', 'src/python/util.py', 'Pytest verifies util'),
  languageDeclareRelation('src/go/calc.go', 'Add', 'Go function declares Add'),
  languageRelation('VERIFIES', 'src/go/calc_test.go', 'src/go/calc.go', 'Go test verifies calc'),
  languageDeclareRelation('src/rust/lib.rs', 'run', 'Rust function declares run'),
  languageRelation('VERIFIES', 'src/rust/lib_test.rs', 'src/rust/lib.rs', 'Rust test verifies lib')
];

const changedFiles = ['src/ts/session.ts'] as const;
const expectedAffectedFiles = [
  '.github/workflows/ci.yml',
  'README.md',
  'src/js/legacy.js',
  'src/ts/alias-consumer.ts',
  'src/ts/barrel.ts',
  'src/ts/namespace-consumer.ts',
  'src/ts/private.ts',
  'src/ts/static-widget.tsx',
  'src/ts/type-only.ts',
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
    seedRetrievalFixture(fixtureRoot, index.indexRunId);
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
    const retrieval = await runRetrievalBench(fixtureRoot);

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
      spanCompleteness >= 0.9 &&
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
      expectedRelationLabels: expectedRelations.map((relation) => relation.label).sort(),
      analyzeDiff: {
        changedFiles: [...changedFiles],
        expectedAffectedFiles: [...expectedAffectedFiles],
        matchedAffectedFiles
      },
      retrieval,
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

function seedRetrievalFixture(repoRoot: string, indexRunId: number): void {
  const db = new DatabaseSync(path.join(repoRoot, '.impact-trace/impact.db'));
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    const repo = db.prepare('SELECT id FROM repos LIMIT 1').get() as { id: number };
    const insertEntity = db.prepare(`
      INSERT OR REPLACE INTO entities (
        id, repo_id, kind, path, symbol, language_id, display_name,
        created_index_run_id, updated_index_run_id
      )
      VALUES (?, ?, 'file', ?, NULL, 'typescript', ?, ?, ?)
    `);
    insertEntity.run(
      'file:bench/evidence-policy.ts',
      repo.id,
      'bench/evidence-policy.ts',
      'Bench Evidence Policy',
      indexRunId,
      indexRunId
    );
    insertEntity.run(
      'file:bench/fact-policy.ts',
      repo.id,
      'bench/fact-policy.ts',
      'Bench Fact Policy',
      indexRunId,
      indexRunId
    );
    db.prepare(`
      INSERT OR REPLACE INTO relations (
        id, repo_id, source_entity_id, target_entity_id, kind, confidence,
        adapter_run_id, index_run_id, provenance
      )
      VALUES (?, ?, ?, ?, 'DOCUMENTS', 'medium', NULL, ?, 'impact-bench-retrieval')
    `).run(
      'bench:evidence-policy',
      repo.id,
      'file:bench/evidence-policy.ts',
      'file:bench/evidence-policy.ts',
      indexRunId
    );
    db.prepare(`
      INSERT OR REPLACE INTO relation_evidence (
        id, relation_id, repo_id, file_path, kind, snippet, confidence, index_run_id
      )
      VALUES (?, ?, ?, ?, 'DOCUMENTS', ?, 'medium', ?)
    `).run(
      'bench:evidence-policy:0',
      'bench:evidence-policy',
      repo.id,
      'bench/evidence-policy.ts',
      'rotating credential validator rejects stale nonce during handoff',
      indexRunId
    );

    db.prepare(`
      INSERT OR IGNORE INTO attribute_defs (name, value_type, is_code_relation, description)
      VALUES ('session_summary', 'json', 0, 'Bench retrieval memory fact')
    `).run();
    db.prepare(`
      INSERT OR IGNORE INTO transactions (id, parent_tx_id, branch_id, ts, agent, index_run_id)
      VALUES ('tx_bench_retrieval', NULL, 'br_main', datetime('now'), 'impact-bench', ?)
    `).run(indexRunId);
    db.prepare(`
      INSERT OR REPLACE INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted)
      VALUES (?, ?, 'session_summary', ?, 'assert', 'tx_bench_retrieval', 0)
    `).run(
      'bench:fact-policy',
      'file:bench/fact-policy.ts',
      JSON.stringify('checkout retry owner escalation policy')
    );
  } finally {
    db.close();
  }
}

async function runRetrievalBench(repoRoot: string): Promise<RetrievalBenchReport> {
  const all = await runRetrievalQueries(repoRoot, []);
  const withoutEvidenceFts = await runRetrievalQueries(repoRoot, ['evidenceFts']);
  const withoutFactsFts = await runRetrievalQueries(repoRoot, ['factsFts']);

  return {
    fixtureId: retrievalFixtureId,
    summary: summarizeRetrieval(all),
    budgets: {
      brief: {
        maxReturnedBytes: Math.max(...all.map((query) => query.returnedBytes)),
        budgetExceededCount: all.filter((query) => query.budgetExceeded).length
      }
    },
    streamAblations: {
      all: summarizeRetrieval(all),
      withoutEvidenceFts: summarizeRetrieval(withoutEvidenceFts),
      withoutFactsFts: summarizeRetrieval(withoutFactsFts)
    },
    queries: all
  };
}

async function runRetrievalQueries(
  repoRoot: string,
  disabledStreams: Array<'evidenceFts' | 'factsFts'>
): Promise<RetrievalQueryReport[]> {
  const reports: RetrievalQueryReport[] = [];
  for (const spec of [...retrievalQueries].sort((left, right) => left.id.localeCompare(right.id))) {
    const result = await searchContextForRepo({
      repoRoot,
      query: spec.query,
      k: 10,
      includeEvidence: false,
      budget: 'brief',
      disabledStreams
    }) as SearchContextBenchResult;
    const returnedEntityIds = result.results.map((item) => item.entity.id);
    const metrics = retrievalMetrics(returnedEntityIds, spec.expectedEntityIds);
    reports.push({
      ...spec,
      ...metrics,
      returnedEntityIds,
      resourceUris: result.results.map((item) => item.resourceUri),
      returnedBytes: result.limits.returnedBytes,
      budgetExceeded: result.limits.budgetExceeded
    });
  }
  return reports;
}

function languageRelation(
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
    adapterId: adapterIdForPath(sourcePath),
    label
  };
}

function fallbackRelation(
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

function buildSystemConfigRelation(
  sourcePath: string,
  targetPath: string,
  label: string
): ExpectedRelation {
  return {
    kind: 'CONFIGURES',
    sourceKind: fileKindForPath(sourcePath),
    sourcePath,
    targetKind: fileKindForPath(targetPath),
    targetPath,
    adapterId: BUILD_SYSTEM_PACKAGE_ADAPTER_ID,
    label
  };
}

function springDeclareRelation(
  sourcePath: string,
  targetSymbol: string,
  label: string
): ExpectedRelation {
  return {
    kind: 'DECLARES',
    sourceKind: 'file',
    sourcePath,
    targetKind: 'symbol',
    targetPath: sourcePath,
    targetSymbol,
    adapterId: JVM_SPRING_SEMANTIC_ADAPTER_ID,
    label
  };
}

function languageDeclareRelation(
  sourcePath: string,
  targetSymbol: string,
  label: string
): ExpectedRelation {
  return {
    kind: 'DECLARES',
    sourceKind: 'file',
    sourcePath,
    targetKind: 'symbol',
    targetPath: sourcePath,
    targetSymbol,
    adapterId: adapterIdForPath(sourcePath),
    label
  };
}

function externalRelation(
  kind: string,
  sourcePath: string,
  targetDisplayName: string,
  label: string
): ExpectedRelation {
  return {
    kind,
    sourceKind: 'file',
    sourcePath,
    targetKind: 'external_entity',
    targetDisplayName,
    adapterId: adapterIdForPath(sourcePath),
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
    adapterId: JVM_SPRING_SEMANTIC_ADAPTER_ID,
    label
  };
}

function contractEndpointRelation(
  sourcePath: string,
  targetDisplayName: string,
  label: string
): ExpectedRelation {
  return {
    kind: 'DECLARES',
    sourceKind: 'contract',
    sourcePath,
    targetKind: 'endpoint',
    targetDisplayName,
    adapterId: regexAdapterId,
    label
  };
}

function contractReferenceRelation(
  sourcePath: string,
  targetPath: string,
  label: string
): ExpectedRelation {
  return {
    kind: 'REFERENCES',
    sourceKind: 'contract',
    sourcePath,
    targetKind: fileKindForPath(targetPath),
    targetPath,
    adapterId: regexAdapterId,
    label
  };
}

function contractImplementerRelation(
  sourcePath: string,
  targetPath: string,
  label: string
): ExpectedRelation {
  return {
    kind: 'IMPLEMENTS',
    sourceKind: fileKindForPath(sourcePath),
    sourcePath,
    targetKind: 'contract',
    targetPath,
    adapterId: regexAdapterId,
    label
  };
}

function packageDeclareRelation(
  sourcePath: string,
  targetDisplayName: string,
  label: string
): ExpectedRelation {
  return {
    kind: 'DECLARES',
    sourceKind: fileKindForPath(sourcePath),
    sourcePath,
    targetKind: 'package',
    targetPath: sourcePath,
    targetDisplayName,
    adapterId: BUILD_SYSTEM_PACKAGE_ADAPTER_ID,
    label
  };
}

function packageManifestIdentityRelation(
  sourcePath: string,
  label: string
): ExpectedRelation {
  return {
    kind: 'DEPENDS_ON',
    sourceKind: 'package',
    sourcePath,
    targetKind: fileKindForPath(sourcePath),
    targetPath: sourcePath,
    adapterId: BUILD_SYSTEM_PACKAGE_ADAPTER_ID,
    label
  };
}

function packageDependencyRelation(
  sourcePath: string,
  targetDisplayName: string,
  label: string
): ExpectedRelation {
  return {
    kind: 'DEPENDS_ON',
    sourceKind: 'package',
    sourcePath,
    targetKind: 'package',
    targetDisplayName,
    adapterId: BUILD_SYSTEM_PACKAGE_ADAPTER_ID,
    label
  };
}

function localPackageDependencyRelation(
  sourcePath: string,
  targetPath: string,
  label: string
): ExpectedRelation {
  return {
    kind: 'DEPENDS_ON',
    sourceKind: 'package',
    sourcePath,
    targetKind: 'package',
    targetPath,
    adapterId: BUILD_SYSTEM_PACKAGE_ADAPTER_ID,
    label
  };
}

function adapterIdForPath(relativePath: string): string {
  if (isBuildSystemManifestPath(relativePath)) return BUILD_SYSTEM_PACKAGE_ADAPTER_ID;
  const language = languageIdForPath(relativePath);
  if (language === 'typescript' || language === 'javascript') return TS_JS_SEMANTIC_ADAPTER_ID;
  if (language === 'java' || language === 'kotlin') return JVM_SPRING_SEMANTIC_ADAPTER_ID;
  if (language === 'python') return PYTHON_SEMANTIC_ADAPTER_ID;
  if (language === 'go') return GO_SEMANTIC_ADAPTER_ID;
  if (language === 'rust') return RUST_SEMANTIC_ADAPTER_ID;
  return regexAdapterId;
}

async function writeFixture(repoRoot: string): Promise<void> {
  const dirs = [
    'contracts',
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
    'services/go-api',
    'libs/go-shared',
    'src/rust',
    'app',
    'gradle',
    '.github/workflows'
  ];
  await Promise.all(dirs.map((dir) => mkdir(path.join(repoRoot, dir), { recursive: true })));

  await writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({
    name: '@acme/impact-bench',
    private: true,
    dependencies: {
      typescript: '^5.9.3'
    }
  }, null, 2));
  await writeFile(path.join(repoRoot, 'pyproject.toml'), [
    '[project]',
    'name = "impact-api"',
    'version = "0.1.0"',
    'dependencies = [',
    '  "fastapi>=0.110",',
    ']',
    '',
    '[project.optional-dependencies]',
    'dev = [',
    '  "pytest>=8",',
    ']',
    '',
    '[dependency-groups]',
    'typing = [',
    '  "mypy>=1.10",',
    '  { include-group = "test" },',
    ']',
    'test = []',
    '',
    '[tool.poetry.group.docs.dependencies]',
    'mkdocs = "^1.6"',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'pom.xml'), [
    '<project>',
    '  <modelVersion>4.0.0</modelVersion>',
    '  <properties>',
    '    <acme.group>com.acme</acme.group>',
    '    <revision>1.0.0</revision>',
    '    <spring.boot.version>3.2.0</spring.boot.version>',
    '  </properties>',
    '  <groupId>${acme.group}</groupId>',
    '  <artifactId>impact-bench-service</artifactId>',
    '  <version>${revision}</version>',
    '  <dependencies>',
    '    <dependency>',
    '      <groupId>org.springframework.boot</groupId>',
    '      <artifactId>spring-boot-starter-web</artifactId>',
    '      <version>${spring.boot.version}</version>',
    '    </dependency>',
    '  </dependencies>',
    '</project>',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: {
        '@app/*': ['src/ts/*']
      }
    }
  }, null, 2));
  await writeFile(path.join(repoRoot, 'gradle/libs.versions.toml'), [
    '[versions]',
    'springBoot = "3.2.0"',
    '',
    '[libraries]',
    'spring-boot-starter-web = { module = "org.springframework.boot:spring-boot-starter-web", version.ref = "springBoot" }',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'app/build.gradle.kts'), [
    'plugins { java }',
    'dependencies {',
    '  implementation(libs.spring.boot.starter.web)',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'go.work'), [
    'go 1.22',
    '',
    'use (',
    '  ./services/go-api',
    '  ./libs/go-shared',
    ')',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'services/go-api/go.mod'), [
    'module example.com/go-api',
    '',
    'go 1.22',
    '',
    'require github.com/acme/shared v0.0.0',
    '',
    'replace github.com/acme/shared => ../../libs/go-shared',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'libs/go-shared/go.mod'), [
    'module example.com/internal/shared',
    '',
    'go 1.22',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/ts/session.ts'), [
    'export type Session = { token: string };',
    'export function validateSession(token: string): boolean {',
    '  return token.length > 0;',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/ts/types.ts'), 'export type RouteMode = "private";\n');
  await writeFile(path.join(repoRoot, 'src/ts/type-only.ts'), [
    'import type { Session } from "./session";',
    'export type SessionToken = Session["token"];',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/ts/namespace-consumer.ts'), [
    'import * as session from "./session";',
    'export function namespaceConsumer(token: string): boolean {',
    '  return session.validateSession(token);',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/ts/private.ts'), [
    'import { validateSession } from "./session";',
    'export function privateRoute(token: string): string {',
    '  return validateSession(token) ? "ok" : "no";',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/ts/widget.tsx'), [
    'export async function Widget() {',
    '  void import("./session");',
    '  return <span>dynamic</span>;',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/ts/static-widget.tsx'), [
    'import { validateSession } from "./session";',
    'export function StaticWidget() {',
    '  return <span>{validateSession("demo") ? "ok" : "no"}</span>;',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/ts/barrel.ts'), 'export { validateSession } from "./session";\n');
  await writeFile(path.join(repoRoot, 'src/ts/alias-consumer.ts'), [
    'import { validateSession } from "@app/session";',
    'export function aliasConsumer(): boolean {',
    '  return validateSession("alias");',
    '}',
    ''
  ].join('\n'));
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
  await writeFile(path.join(repoRoot, 'src/main/java/com/example/AppProperties.java'), [
    'package com.example;',
    'import org.springframework.boot.context.properties.ConfigurationProperties;',
    '@ConfigurationProperties(prefix = "impact")',
    'public class AppProperties {',
    '  private String owner;',
    '}',
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
  await writeFile(path.join(repoRoot, 'src/main/java/com/example/CatalogClient.java'), [
    'package com.example;',
    'import org.springframework.cloud.openfeign.FeignClient;',
    '@FeignClient(name = "catalog")',
    'public interface CatalogClient {',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/main/java/com/example/UserClient.java'), [
    'package com.example;',
    'import org.springframework.web.reactive.function.client.WebClient;',
    'public class UserClient {',
    '  private final WebClient webClient;',
    '  public UserClient(WebClient webClient) { this.webClient = webClient; }',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/main/java/com/example/AdminClient.java'), [
    'package com.example;',
    'import org.springframework.web.client.RestTemplate;',
    'public class AdminClient {',
    '  private final RestTemplate restTemplate;',
    '  public AdminClient(RestTemplate restTemplate) { this.restTemplate = restTemplate; }',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'contracts/openapi.yaml'), [
    'openapi: 3.0.3',
    'info:',
    '  title: User API',
    '  version: 1.0.0',
    '  x-service-name: user-service',
    'paths:',
    '  /api/users:',
    '    get:',
    '      operationId: listUsers',
    '      x-implementation: src/main/java/com/example/UserController.java',
    '      responses:',
    '        "200":',
    '          description: ok',
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
  await writeFile(path.join(repoRoot, 'src/test/java/com/example/UserRepositoryTest.java'), [
    'package com.example;',
    'import org.junit.jupiter.api.Test;',
    'import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;',
    'import com.example.UserRepository;',
    '@DataJpaTest',
    'public class UserRepositoryTest {',
    '  @Test',
    '  void verifiesRepository() {}',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/main/resources/application.yml'), [
    'impact:',
    '  owner: src/main/java/com/example/UserService.java',
    ''
  ].join('\n'));
  await writeFile(path.join(repoRoot, 'src/main/resources/application.properties'), [
    'impact.properties=src/main/java/com/example/AppProperties.java',
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
    'class Helper:',
    '    pass',
    '',
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
    'func TestAdd(t *testing.T) {',
    '  _ = Add(1, 2)',
    '}',
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
    'fn run_test() {',
    '  assert!(run());',
    '}',
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
  const externalScoredSourcePaths = new Set(
    expectedRelations
      .filter((expected) => expected.targetKind === 'external_entity')
      .map((expected) => expected.sourcePath)
  );
  const expectedPaths = new Set(
    expectedRelations.flatMap((expected) =>
      [expected.sourcePath, expected.targetPath].filter((file): file is string => Boolean(file))
    )
  );
  return actualRelations
    .filter((actual) => {
      if (actual.kind === 'DECLARES' && actual.sourceKind !== 'contract') return false;
      if (
        actual.targetKind === 'external_entity' &&
        (!actual.sourcePath || !externalScoredSourcePaths.has(actual.sourcePath))
      ) {
        return false;
      }
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
  if (isPathObviousContract(filePath)) return 'contract';
  if (
    filePath.endsWith('.json') ||
    filePath.endsWith('.toml') ||
    filePath.endsWith('.yml') ||
    filePath.endsWith('.yaml') ||
    filePath.endsWith('.properties') ||
    isBuildSystemManifestPath(filePath)
  ) return 'config';
  return 'file';
}

function isBuildSystemManifestPath(filePath: string): boolean {
  const basename = path.posix.basename(filePath);
  return new Set([
    'package.json',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'go.mod',
    'go.work',
    'Cargo.toml',
    'pyproject.toml'
  ]).has(basename);
}

function isPathObviousContract(filePath: string): boolean {
  const basename = path.posix.basename(filePath);
  const withoutExtension = basename.replace(/\.[^.]+$/, '').toLowerCase();
  return (
    withoutExtension.includes('openapi') ||
    withoutExtension.includes('swagger') ||
    withoutExtension.includes('asyncapi')
  );
}

function languageIdForPath(filePath: string): string | undefined {
  const basename = path.posix.basename(filePath);
  if (basename === 'Dockerfile' || basename === 'Containerfile') return 'dockerfile';
  if (basename === 'package.json') return 'json';
  const ext = path.posix.extname(filePath);
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.java') return 'java';
  if (ext === '.kt' || ext === '.kts') return 'kotlin';
  if (ext === '.py') return 'python';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rust';
  if (ext === '.yml' || ext === '.yaml') return 'yaml';
  if (ext === '.properties') return 'properties';
  if (ext === '.md') return 'markdown';
  return undefined;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 1;
  return round(numerator / denominator);
}

function retrievalMetrics(returnedEntityIds: readonly string[], expectedEntityIds: readonly string[]): RetrievalMetrics {
  const expected = new Set(expectedEntityIds);
  const relevantRanks = returnedEntityIds
    .map((entityId, index) => expected.has(entityId) ? index + 1 : null)
    .filter((rank): rank is number => rank !== null);
  const recallAt5 = ratio(
    returnedEntityIds.slice(0, 5).filter((entityId) => expected.has(entityId)).length,
    expected.size
  );
  const recallAt10 = ratio(
    returnedEntityIds.slice(0, 10).filter((entityId) => expected.has(entityId)).length,
    expected.size
  );
  const precisionAt5 = ratio(
    returnedEntityIds.slice(0, 5).filter((entityId) => expected.has(entityId)).length,
    5
  );
  const mrr = relevantRanks.length > 0 ? round(1 / relevantRanks[0]!) : 0;
  const dcgAt10 = returnedEntityIds.slice(0, 10).reduce((total, entityId, index) => {
    if (!expected.has(entityId)) return total;
    return total + 1 / Math.log2(index + 2);
  }, 0);
  const idealDcgAt10 = Array.from({ length: Math.min(expected.size, 10) }).reduce<number>(
    (total, _unused, index) => total + 1 / Math.log2(index + 2),
    0
  );
  const ndcgAt10 = idealDcgAt10 === 0 ? 1 : round(dcgAt10 / idealDcgAt10);
  return { recallAt5, recallAt10, precisionAt5, mrr, ndcgAt10 };
}

function summarizeRetrieval(reports: readonly RetrievalQueryReport[]): RetrievalMetrics {
  return {
    recallAt5: averageMetric(reports, 'recallAt5'),
    recallAt10: averageMetric(reports, 'recallAt10'),
    precisionAt5: averageMetric(reports, 'precisionAt5'),
    mrr: averageMetric(reports, 'mrr'),
    ndcgAt10: averageMetric(reports, 'ndcgAt10')
  };
}

function averageMetric(reports: readonly RetrievalQueryReport[], key: keyof RetrievalMetrics): number {
  if (reports.length === 0) return 1;
  return round(reports.reduce((total, report) => total + report[key], 0) / reports.length);
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
