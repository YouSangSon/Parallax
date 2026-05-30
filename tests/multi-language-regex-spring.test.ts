import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { analyzeDiff, indexProject, initProject } from '../src/index.js';
import { databasePath } from '../src/store.js';

process.env.PARALLAX_EMBEDDING_MODEL = 'stub-sha256';

type EvidenceSpanRow = {
  snippet: string;
  start_line: number | null;
  end_line: number | null;
  start_col: number | null;
  end_col: number | null;
};

test('indexProject emits Spring Boot endpoints, component declarations, and JVM/Python/Go/Rust VERIFIES relations', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'parallax-spring-'));
  await mkdir(path.join(repoRoot, 'src/main/java/com/example/orders'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src/main/java/com/example/health'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src/main/java/com/example/internal'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src/main/java/com/example/users'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src/main/kotlin/com/example/kotlin'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src/main/resources'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src/main/java/com/a'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src/main/java/com/b'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src/main/java/com/junitlocal'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src/test/java/com/example/orders'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src/test/java/com/example/users'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src/test/java/com/a'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src/test/java/com/junitlocal'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src/test/kotlin/com/example/orders'), { recursive: true });
  await mkdir(path.join(repoRoot, 'python'), { recursive: true });
  await mkdir(path.join(repoRoot, 'tests'), { recursive: true });
  await mkdir(path.join(repoRoot, 'go/orders'), { recursive: true });
  await mkdir(path.join(repoRoot, 'rust/src'), { recursive: true });
  await mkdir(path.join(repoRoot, 'rust/tests'), { recursive: true });

  await writeFile(
    path.join(repoRoot, 'src/main/java/com/example/orders/OrderController.java'),
    [
      'package com.example.orders;',
      '',
      'import org.springframework.web.bind.annotation.GetMapping;',
      'import org.springframework.web.bind.annotation.PostMapping;',
      'import org.springframework.web.bind.annotation.RequestMapping;',
      'import org.springframework.web.bind.annotation.RestController;',
      '',
      '@RestController',
      '@RequestMapping("/api/orders")',
      'public class OrderController {',
      '  private final OrderService orderService;',
      '',
      '  public OrderController(OrderService orderService) {',
      '    this.orderService = orderService;',
      '  }',
      '',
      '  @GetMapping("/{id}")',
      '  public OrderDto getOrder(String id) {',
      '    return orderService.getOrder(id);',
      '  }',
      '',
      '  @PostMapping',
      '  public OrderDto createOrder(OrderDto input) {',
      '    return orderService.createOrder(input);',
      '  }',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/main/java/com/example/orders/OrderService.java'),
    [
      'package com.example.orders;',
      '',
      'import org.springframework.stereotype.Service;',
      '',
      '@Service',
      'public class OrderService {',
      '  public OrderDto getOrder(String id) { return new OrderDto(id); }',
      '  public OrderDto createOrder(OrderDto input) { return input; }',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/main/java/com/example/orders/OrderRepository.java'),
    [
      'package com.example.orders;',
      '',
      'import org.springframework.data.jpa.repository.JpaRepository;',
      '',
      'public interface OrderRepository extends JpaRepository<OrderEntity, Long> {',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/main/java/com/example/orders/OrderEntity.java'),
    [
      'package com.example.orders;',
      '',
      'import jakarta.persistence.Entity;',
      '',
      '@Entity',
      'public class OrderEntity {',
      '  Long id;',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/main/java/com/example/orders/OrderConfig.java'),
    [
      'package com.example.orders;',
      '',
      'import org.springframework.context.annotation.Bean;',
      'import org.springframework.context.annotation.Configuration;',
      '',
      '@Configuration',
      'public class OrderConfig {',
      '  @Bean',
      '  public OrderClient orderClient() { return new OrderClient(); }',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/main/java/com/example/orders/OrderProperties.java'),
    [
      'package com.example.orders;',
      '',
      'import org.springframework.boot.context.properties.ConfigurationProperties;',
      '',
      '@ConfigurationProperties(prefix = "orders")',
      'public class OrderProperties {',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/main/java/com/example/orders/CatalogClient.java'),
    [
      'package com.example.orders;',
      '',
      'import org.springframework.cloud.openfeign.FeignClient;',
      '',
      '@FeignClient(name = "catalog")',
      'public interface CatalogClient {',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/main/resources/application.yml'),
    [
      'orders:',
      '  service-ref: src/main/java/com/example/orders/OrderService.java',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/main/resources/application.properties'),
    [
      'orders.properties-ref=src/main/java/com/example/orders/OrderProperties.java',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/main/java/com/example/orders/OrderDto.java'),
    'package com.example.orders;\npublic record OrderDto(String id) {}\n'
  );
  await writeFile(
    path.join(repoRoot, 'src/main/java/com/example/health/PublicHealthController.java'),
    [
      'package com.example.health;',
      '',
      'import org.springframework.web.bind.annotation.GetMapping;',
      'import org.springframework.web.bind.annotation.RestController;',
      '',
      '@RestController',
      'public class PublicHealthController {',
      '  @GetMapping("/health")',
      '  public String health() { return "ok"; }',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/main/java/com/example/internal/InternalHealthController.java'),
    [
      'package com.example.internal;',
      '',
      'import org.springframework.web.bind.annotation.GetMapping;',
      'import org.springframework.web.bind.annotation.RestController;',
      '',
      '@RestController',
      'public class InternalHealthController {',
      '  @GetMapping("/health")',
      '  public String health() { return "ok"; }',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/main/java/com/example/health/InlineHealthController.java'),
    [
      'package com.example.health;',
      '',
      'import org.springframework.web.bind.annotation.GetMapping;',
      'import org.springframework.web.bind.annotation.RequestMapping;',
      'import org.springframework.web.bind.annotation.RestController;',
      '',
      '@RestController @RequestMapping("/inline") public class InlineHealthController {',
      '  @GetMapping("/ping") public String ping() { return "ok"; }',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/main/java/com/example/health/NestedHealthController.java'),
    [
      'package com.example.health;',
      '',
      'import org.springframework.web.bind.annotation.GetMapping;',
      'import org.springframework.web.bind.annotation.RestController;',
      '',
      '@RestController',
      'public class NestedHealthController {',
      '  static class Dto {',
      '    String value;',
      '  }',
      '',
      '  @GetMapping("/brace-string")',
      '  public String braceString() { return "}"; }',
      '',
      '  @GetMapping("/nested")',
      '  public String nested() { return "ok"; }',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/main/kotlin/com/example/kotlin/InternalKotlinController.kt'),
    [
      'package com.example.kotlin',
      '',
      'import org.springframework.web.bind.annotation.GetMapping',
      'import org.springframework.web.bind.annotation.RequestMapping',
      'import org.springframework.web.bind.annotation.RestController',
      '',
      '@RestController',
      '@RequestMapping(path = ["/kotlin"])',
      'internal class InternalKotlinController {',
      '  @GetMapping(path = ["/internal"])',
      '  fun internalPing(): String = "ok"',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/main/java/com/example/users/UserService.java'),
    'package com.example.users;\npublic class UserService {}\n'
  );
  await writeFile(
    path.join(repoRoot, 'src/main/java/com/example/users/User.java'),
    'package com.example.users;\npublic class User {}\n'
  );
  await writeFile(
    path.join(repoRoot, 'src/main/java/com/a/OrderService.java'),
    'package com.a;\npublic class OrderService {}\n'
  );
  await writeFile(
    path.join(repoRoot, 'src/main/java/com/b/OrderService.java'),
    'package com.b;\npublic class OrderService {}\n'
  );
  await writeFile(
    path.join(repoRoot, 'src/main/java/com/junitlocal/Test.java'),
    'package com.junitlocal;\npublic class Test {}\n'
  );

  await writeFile(
    path.join(repoRoot, 'src/test/java/com/example/orders/OrderControllerTests.java'),
    [
      'package com.example.orders;',
      '',
      'import com.example.orders.OrderController;',
      '',
      'class OrderControllerTests {',
      '  void verifiesController() {',
      '    OrderController controller = null;',
      '  }',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/test/java/com/example/users/UserServiceTest.java'),
    [
      'package com.example.users;',
      '',
      'class UserServiceTest {',
      '  void verifiesServiceWithoutImportingUserModel() {',
      '    User user = null;',
      '    UserService service = null;',
      '  }',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/test/java/com/a/OrderServiceTest.java'),
    [
      'package com.a;',
      '',
      'class OrderServiceTest {',
      '  void verifiesPackageLocalService() {',
      '    OrderService service = null;',
      '  }',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/test/java/com/junitlocal/JUnitUsageTest.java'),
    [
      'package com.junitlocal;',
      '',
      'import org.junit.Test;',
      '',
      'class JUnitUsageTest {',
      '  @Test',
      '  void usesExternalJunitAnnotation() {}',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'src/test/kotlin/com/example/orders/OrderServiceSpec.kt'),
    [
      'package com.example.orders',
      '',
      'import com.example.orders.OrderService',
      '',
      'class OrderServiceSpec {',
      '  fun verifiesService() {',
      '    OrderService()',
      '  }',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoRoot, 'python/calculator.py'),
    'class Calculator:\n    pass\n\n\ndef calculate():\n    return 1\n'
  );
  await writeFile(
    path.join(repoRoot, 'python/calculator_test.py'),
    'from calculator import calculate\n\ndef test_calculate():\n    assert calculate() == 1\n'
  );
  await writeFile(path.join(repoRoot, 'src/calculator.py'), 'def calculate():\n    return 2\n');
  await writeFile(
    path.join(repoRoot, 'tests/test_calculator.py'),
    'def test_calculate():\n    assert True\n'
  );
  await writeFile(path.join(repoRoot, 'go/orders/order.go'), 'package orders\n\nfunc Calculate() int { return 1 }\n');
  await writeFile(
    path.join(repoRoot, 'go/orders/order_test.go'),
    'package orders\n\nfunc TestCalculate(t *testing.T) {\n  _ = Calculate()\n}\n'
  );
  await writeFile(path.join(repoRoot, 'rust/src/calculator.rs'), 'pub fn calculate() -> i32 { 1 }\n');
  await writeFile(
    path.join(repoRoot, 'rust/tests/calculator_spec.rs'),
    'use parallax_fixture::calculator::calculate;\n\n#[test]\nfn verifies_calculator() {\n  assert_eq!(calculate(), 1);\n}\n'
  );

  await initProject({ repoRoot });
  const index = await indexProject({ repoRoot });

  const db = new DatabaseSync(databasePath(repoRoot), { readOnly: true });
  try {
    const endpoints = db
      .prepare(
        `SELECT display_name
         FROM entities
         WHERE updated_index_run_id = ?
           AND kind = ?
           AND display_name LIKE ?
         ORDER BY display_name`
      )
      .all(index.indexRunId, 'endpoint', '%/api/orders%') as Array<{ display_name: string }>;
    assert.deepEqual(
      endpoints.map((row) => row.display_name),
      ['GET /api/orders/{id}', 'POST /api/orders']
    );

    const healthEndpointRows = db
      .prepare(
        `SELECT id, display_name
         FROM entities
         WHERE updated_index_run_id = ?
           AND kind = ?
           AND display_name = ?
         ORDER BY id`
      )
      .all(index.indexRunId, 'endpoint', 'GET /health') as Array<{
      id: string;
      display_name: string;
    }>;
    assert.equal(healthEndpointRows.length, 2);
    assert.equal(new Set(healthEndpointRows.map((row) => row.id)).size, 2);

    const inlineEndpoint = db
      .prepare(
        `SELECT id
         FROM entities
         WHERE updated_index_run_id = ?
           AND kind = ?
           AND display_name = ?`
      )
      .get(index.indexRunId, 'endpoint', 'GET /inline/ping');
    assert.ok(inlineEndpoint, 'inline Spring class annotations should produce endpoints');

    for (const endpoint of ['GET /nested', 'GET /brace-string', 'GET /kotlin/internal']) {
      const row = db
        .prepare(
          `SELECT id
           FROM entities
           WHERE updated_index_run_id = ?
             AND kind = ?
             AND display_name = ?`
        )
        .get(index.indexRunId, 'endpoint', endpoint);
      assert.ok(row, `missing endpoint ${endpoint}`);
    }

    const controllerEndpointRelations = db
      .prepare(
        `SELECT r.kind, source.display_name AS source_display, target.display_name AS target_display,
                ev.file_path, ev.snippet, ev.confidence
         FROM relations r
         INNER JOIN entities source ON source.id = r.source_entity_id
         INNER JOIN entities target ON target.id = r.target_entity_id
         INNER JOIN relation_evidence ev ON ev.relation_id = r.id
         WHERE r.index_run_id = ?
           AND r.kind = ?
           AND target.kind = ?
           AND source.symbol = ?
         ORDER BY target.display_name`
      )
      .all(index.indexRunId, 'IMPLEMENTS', 'endpoint', 'OrderController') as Array<{
      kind: string;
      source_display: string;
      target_display: string;
      file_path: string;
      snippet: string;
      confidence: string;
    }>;
    assert.deepEqual(
      controllerEndpointRelations.map((row) => ({
        source: row.source_display,
        target: row.target_display,
        file: row.file_path,
        confidence: row.confidence
      })),
      [
        {
          source: 'OrderController (src/main/java/com/example/orders/OrderController.java)',
          target: 'GET /api/orders/{id}',
          file: 'src/main/java/com/example/orders/OrderController.java',
          confidence: 'proven'
        },
        {
          source: 'OrderController (src/main/java/com/example/orders/OrderController.java)',
          target: 'POST /api/orders',
          file: 'src/main/java/com/example/orders/OrderController.java',
          confidence: 'proven'
        }
      ]
    );
    assert.ok(controllerEndpointRelations[0]!.snippet.includes('@GetMapping("/{id}")'));

    const getEndpointEvidence = db
      .prepare(
        `SELECT ev.snippet, ev.start_line, ev.end_line, ev.start_col, ev.end_col
         FROM relations r
         INNER JOIN entities source ON source.id = r.source_entity_id
         INNER JOIN entities target ON target.id = r.target_entity_id
         INNER JOIN relation_evidence ev ON ev.relation_id = r.id
         WHERE r.index_run_id = ?
           AND r.kind = ?
           AND source.symbol = ?
           AND target.display_name = ?`
      )
      .get(index.indexRunId, 'IMPLEMENTS', 'OrderController', 'GET /api/orders/{id}') as
      | EvidenceSpanRow
      | undefined;
    assert.ok(getEndpointEvidence, 'expected persisted endpoint relation evidence');
    assertBoundedSpan(getEndpointEvidence, 'OrderController GET endpoint');
    assert.equal(getEndpointEvidence.start_line, 17);
    assert.equal(getEndpointEvidence.end_line, 18);
    assert.equal(getEndpointEvidence.start_col, 3);
    assert.match(getEndpointEvidence.snippet, /@GetMapping\("\/\{id\}"\)/);
    assert.match(getEndpointEvidence.snippet, /public OrderDto getOrder\(String id\)/);
    assert.equal(
      getEndpointEvidence.snippet.includes('@PostMapping'),
      false,
      'endpoint evidence should not include the next handler'
    );

    const springDeclarationProvenances = db
      .prepare(
        `SELECT provenance
         FROM relations
         WHERE index_run_id = ?
           AND kind = ?
           AND provenance LIKE 'spring:%'
         ORDER BY provenance`
      )
      .all(index.indexRunId, 'DECLARES') as Array<{ provenance: string }>;
    for (const expected of [
      'spring:Bean:orderClient',
      'spring:Configuration:OrderConfig',
      'spring:ConfigurationProperties:OrderProperties',
      'spring:Entity:OrderEntity',
      'spring:FeignClient:CatalogClient',
      'spring:Service:OrderService',
      'spring:SpringDataRepository:OrderRepository'
    ]) {
      assert.ok(
        springDeclarationProvenances.some((row) => row.provenance === expected),
        `missing ${expected}`
      );
    }

    const springDeclarationEvidence = db
      .prepare(
        `SELECT r.provenance, ev.snippet, ev.start_line, ev.end_line, ev.start_col, ev.end_col
         FROM relations r
         INNER JOIN relation_evidence ev ON ev.relation_id = r.id
         WHERE r.index_run_id = ?
           AND r.kind = ?
           AND r.provenance IN (
             'spring:Bean:orderClient',
             'spring:Configuration:OrderConfig',
             'spring:ConfigurationProperties:OrderProperties',
             'spring:Entity:OrderEntity',
             'spring:FeignClient:CatalogClient',
             'spring:Service:OrderService',
             'spring:SpringDataRepository:OrderRepository'
           )
         ORDER BY r.provenance`
      )
      .all(index.indexRunId, 'DECLARES') as Array<EvidenceSpanRow & { provenance: string }>;
    assert.equal(springDeclarationEvidence.length, 7);
    for (const row of springDeclarationEvidence) {
      assertBoundedSpan(row, row.provenance);
      assert.equal(
        row.snippet.includes('package com.example'),
        false,
        `${row.provenance} should not use whole-file evidence`
      );
    }
    assert.match(
      findEvidenceByProvenance(springDeclarationEvidence, 'spring:Configuration:OrderConfig').snippet,
      /@Configuration/
    );
    assert.match(
      findEvidenceByProvenance(springDeclarationEvidence, 'spring:Bean:orderClient').snippet,
      /@Bean/
    );
    assert.match(
      findEvidenceByProvenance(springDeclarationEvidence, 'spring:SpringDataRepository:OrderRepository').snippet,
      /interface OrderRepository extends JpaRepository/
    );

    const polyglotDeclarationEvidence = db
      .prepare(
        `SELECT source.path AS source_path, target.symbol AS target_symbol,
                ev.snippet, ev.start_line, ev.end_line, ev.start_col, ev.end_col
         FROM relations r
         INNER JOIN entities source ON source.id = r.source_entity_id
         INNER JOIN entities target ON target.id = r.target_entity_id
         INNER JOIN relation_evidence ev ON ev.relation_id = r.id
         WHERE r.index_run_id = ?
           AND r.kind = ?
           AND source.path IN (?, ?, ?)
           AND target.symbol IN (?, ?, ?)
         ORDER BY source.path, target.symbol`
      )
      .all(
        index.indexRunId,
        'DECLARES',
        'python/calculator.py',
        'go/orders/order.go',
        'rust/src/calculator.rs',
        'calculate',
        'Calculate',
        'Calculator'
      ) as Array<EvidenceSpanRow & { source_path: string; target_symbol: string }>;
    for (const expected of [
      { sourcePath: 'python/calculator.py', targetSymbol: 'Calculator', snippet: /^class Calculator:/ },
      { sourcePath: 'python/calculator.py', targetSymbol: 'calculate', snippet: /^def calculate\(\):$/ },
      { sourcePath: 'go/orders/order.go', targetSymbol: 'Calculate', snippet: /^func Calculate\(\) int/ },
      { sourcePath: 'rust/src/calculator.rs', targetSymbol: 'calculate', snippet: /^pub fn calculate\(\)/ }
    ]) {
      const row = polyglotDeclarationEvidence.find(
        (item) => item.source_path === expected.sourcePath && item.target_symbol === expected.targetSymbol
      );
      assert.ok(row, `missing DECLARES evidence for ${expected.sourcePath}#${expected.targetSymbol}`);
      assertBoundedSpan(row, `${expected.sourcePath}#${expected.targetSymbol}`);
      assert.match(row.snippet, expected.snippet);
      assert.equal(
        row.snippet.includes('\n    return'),
        false,
        `${expected.sourcePath}#${expected.targetSymbol} should not use a whole-function snippet`
      );
    }

    const configEvidence = db
      .prepare(
        `SELECT source.path AS source_path, target.path AS target_path,
                ev.snippet, ev.start_line, ev.end_line, ev.start_col, ev.end_col
         FROM relations r
         INNER JOIN entities source ON source.id = r.source_entity_id
         INNER JOIN entities target ON target.id = r.target_entity_id
         INNER JOIN relation_evidence ev ON ev.relation_id = r.id
         WHERE r.index_run_id = ?
           AND r.kind = ?
           AND source.path IN (?, ?)
           AND target.path IN (?, ?)
         ORDER BY source.path, target.path`
      )
      .all(
        index.indexRunId,
        'CONFIGURES',
        'src/main/resources/application.properties',
        'src/main/resources/application.yml',
        'src/main/java/com/example/orders/OrderProperties.java',
        'src/main/java/com/example/orders/OrderService.java'
      ) as Array<EvidenceSpanRow & { source_path: string; target_path: string }>;
    assert.equal(configEvidence.length, 2);
    for (const row of configEvidence) {
      assertBoundedSpan(row, `${row.source_path} -> ${row.target_path}`);
      assert.equal(row.start_line, row.end_line);
      assert.equal(
        row.snippet.includes('\n'),
        false,
        `${row.source_path} config evidence should be the matched line only`
      );
    }
    assert.match(
      configEvidence.find((row) => row.source_path.endsWith('application.yml'))?.snippet ?? '',
      /OrderService\.java/
    );
    assert.match(
      configEvidence.find((row) => row.source_path.endsWith('application.properties'))?.snippet ?? '',
      /OrderProperties\.java/
    );

    const verifiesRelations = db
      .prepare(
        `SELECT source.path AS source_path, target.path AS target_path
         FROM relations r
         INNER JOIN entities source ON source.id = r.source_entity_id
         INNER JOIN entities target ON target.id = r.target_entity_id
         WHERE r.index_run_id = ?
           AND r.kind = ?
         ORDER BY source.path, target.path`
      )
      .all(index.indexRunId, 'VERIFIES') as Array<{ source_path: string; target_path: string }>;

    for (const expected of [
      {
        source: 'src/test/java/com/example/orders/OrderControllerTests.java',
        target: 'src/main/java/com/example/orders/OrderController.java'
      },
      {
        source: 'src/test/kotlin/com/example/orders/OrderServiceSpec.kt',
        target: 'src/main/java/com/example/orders/OrderService.java'
      },
      { source: 'python/calculator_test.py', target: 'python/calculator.py' },
      { source: 'tests/test_calculator.py', target: 'src/calculator.py' },
      { source: 'go/orders/order_test.go', target: 'go/orders/order.go' },
      { source: 'rust/tests/calculator_spec.rs', target: 'rust/src/calculator.rs' }
    ]) {
      assert.ok(
        verifiesRelations.some(
          (row) => row.source_path === expected.source && row.target_path === expected.target
        ),
        `missing VERIFIES ${expected.source} -> ${expected.target}`
      );
    }
    assert.equal(
      verifiesRelations.some(
        (row) =>
          row.source_path === 'src/test/java/com/example/users/UserServiceTest.java' &&
          row.target_path === 'src/main/java/com/example/users/User.java'
      ),
      false,
      'UserServiceTest should not verify User.java just because the content mentions User'
    );
    assert.equal(
      verifiesRelations.some(
        (row) =>
          row.source_path === 'src/test/java/com/example/users/UserServiceTest.java' &&
          row.target_path === 'src/main/java/com/example/users/UserService.java'
      ),
      true,
      'UserServiceTest should verify UserService.java from the test filename'
    );
    const filenameInferredVerifyEvidence = db
      .prepare(
        `SELECT ev.snippet, ev.start_line, ev.end_line, ev.start_col, ev.end_col
         FROM relations r
         INNER JOIN entities source ON source.id = r.source_entity_id
         INNER JOIN entities target ON target.id = r.target_entity_id
         INNER JOIN relation_evidence ev ON ev.relation_id = r.id
         WHERE r.index_run_id = ?
           AND r.kind = ?
           AND source.path = ?
           AND target.path = ?`
      )
      .get(
        index.indexRunId,
        'VERIFIES',
        'src/test/java/com/example/users/UserServiceTest.java',
        'src/main/java/com/example/users/UserService.java'
      ) as EvidenceSpanRow | undefined;
    assert.ok(filenameInferredVerifyEvidence, 'expected filename-inferred JVM VERIFIES evidence');
    assertBoundedSpan(filenameInferredVerifyEvidence, 'filename-inferred JVM VERIFIES');
    assert.equal(filenameInferredVerifyEvidence.start_line, 3);
    assert.match(filenameInferredVerifyEvidence.snippet, /class UserServiceTest/);
    assert.equal(
      filenameInferredVerifyEvidence.snippet.includes('UserService service = null'),
      false,
      'filename-inferred JVM VERIFIES should not use whole-file evidence'
    );
    const pythonImportBackedVerifyEvidence = findVerifyEvidence(
      db,
      index.indexRunId,
      'python/calculator_test.py',
      'python/calculator.py'
    );
    assertBoundedSpan(pythonImportBackedVerifyEvidence, 'import-backed Python VERIFIES');
    assert.equal(pythonImportBackedVerifyEvidence.start_line, 1);
    assert.match(pythonImportBackedVerifyEvidence.snippet, /^from calculator import calculate$/);
    assert.equal(
      pythonImportBackedVerifyEvidence.snippet.includes('def test_calculate'),
      false,
      'import-backed Python VERIFIES should prefer import-line evidence'
    );
    for (const expected of [
      {
        label: 'filename-inferred Python VERIFIES',
        sourcePath: 'tests/test_calculator.py',
        targetPath: 'src/calculator.py',
        snippet: /^def test_calculate\(\):$/
      },
      {
        label: 'filename-inferred Go VERIFIES',
        sourcePath: 'go/orders/order_test.go',
        targetPath: 'go/orders/order.go',
        snippet: /^func TestCalculate\(t \*testing\.T\)/
      },
      {
        label: 'filename-inferred Rust VERIFIES',
        sourcePath: 'rust/tests/calculator_spec.rs',
        targetPath: 'rust/src/calculator.rs',
        snippet: /^#\[test\]\nfn verifies_calculator\(\)/
      }
    ]) {
      const row = findVerifyEvidence(db, index.indexRunId, expected.sourcePath, expected.targetPath);
      assertBoundedSpan(row, expected.label);
      assert.match(row.snippet, expected.snippet);
      assert.equal(
        row.snippet.includes('assert True') || row.snippet.includes('_ = Calculate()') || row.snippet.includes('assert_eq!'),
        false,
        `${expected.label} should not use whole-test-body evidence`
      );
    }
    assert.deepEqual(
      verifiesRelations
        .filter((row) => row.source_path === 'src/test/java/com/a/OrderServiceTest.java')
        .map((row) => row.target_path),
      ['src/main/java/com/a/OrderService.java']
    );
    assert.deepEqual(
      verifiesRelations
        .filter((row) => row.source_path === 'src/test/kotlin/com/example/orders/OrderServiceSpec.kt')
        .map((row) => row.target_path),
      ['src/main/java/com/example/orders/OrderService.java']
    );
    assert.equal(
      verifiesRelations.some(
        (row) =>
          row.source_path === 'src/test/java/com/junitlocal/JUnitUsageTest.java' &&
          row.target_path === 'src/main/java/com/junitlocal/Test.java'
      ),
      false,
      'external org.junit.Test import should not verify local Test.java'
    );
  } finally {
    db.close();
  }

  const pythonImpact = await analyzeDiff({
    repoRoot,
    changedFiles: ['python/calculator.py']
  });
  assert.ok(
    pythonImpact.affectedFiles.some((file) => file.path === 'python/calculator_test.py')
  );
  assert.equal(
    pythonImpact.testCommands.some((command) => command.args?.includes('python/calculator_test.py')),
    false
  );

  const springImpact = await analyzeDiff({
    repoRoot,
    changedFiles: ['src/main/java/com/example/orders/OrderController.java']
  });
  assert.ok(
    springImpact.evidence.some(
      (item) =>
        item.relationKind === 'IMPLEMENTS' &&
        item.file === 'src/main/java/com/example/orders/OrderController.java' &&
        item.snippet.includes('@GetMapping("/{id}")') &&
        item.startLine === 17
    ),
    'expected analyzeDiff evidence to include Spring endpoint relation span'
  );
});

function assertBoundedSpan(row: EvidenceSpanRow, label: string): void {
  assert.equal(row.start_line === null, false, `${label} should have start_line`);
  assert.equal(row.end_line === null, false, `${label} should have end_line`);
  assert.equal(row.start_col === null, false, `${label} should have start_col`);
  assert.equal(row.end_col === null, false, `${label} should have end_col`);
  assert.ok(row.snippet.length > 0, `${label} should have snippet`);
}

function findEvidenceByProvenance(
  rows: ReadonlyArray<EvidenceSpanRow & { provenance: string }>,
  provenance: string
): EvidenceSpanRow {
  const row = rows.find((item) => item.provenance === provenance);
  assert.ok(row, `missing evidence for ${provenance}`);
  return row;
}

function findVerifyEvidence(
  db: DatabaseSync,
  indexRunId: number,
  sourcePath: string,
  targetPath: string
): EvidenceSpanRow {
  const row = db
    .prepare(
      `SELECT ev.snippet, ev.start_line, ev.end_line, ev.start_col, ev.end_col
       FROM relations r
       INNER JOIN entities source ON source.id = r.source_entity_id
       INNER JOIN entities target ON target.id = r.target_entity_id
       INNER JOIN relation_evidence ev ON ev.relation_id = r.id
       WHERE r.index_run_id = ?
         AND r.kind = ?
         AND source.path = ?
         AND target.path = ?`
    )
    .get(indexRunId, 'VERIFIES', sourcePath, targetPath) as EvidenceSpanRow | undefined;
  assert.ok(row, `missing VERIFIES evidence for ${sourcePath} -> ${targetPath}`);
  return row;
}
