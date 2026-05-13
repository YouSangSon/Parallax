# Phase 6B — Multi-language + Spring Boot Adapter Pack v0 + Trusted Evidence

> **작성:** 2026-05-09 (`main` @ `3cba0a2`)
> **상태:** `/autoplan` + `/team-builder` 이후 사용자 stack 정정 반영. 2026-05-12 현재 ImpactBench, adapter pack v0 routing, TS/JS parser-backed import span v0, JVM/Spring lightweight evidence span v0, Python/Go/Rust lightweight evidence span v0, OpenAPI contract impact baseline, workspace catalog v0, cross-repo contract resolver v0, OpenAPI same-file HTTP route alias resolver v0, GraphQL/Protobuf/AsyncAPI consumer resolver v0, generated-client/event topology v0, AsyncAPI same-file event alias resolver v0, contract diff topology provenance, contract topology surface v0, OpenAPI endpoint-surface/nested schema contract diff v0, Protobuf contract diff v0, GraphQL contract diff v0, AsyncAPI contract diff v0, build-system/package resolver v0, Gradle version catalog resolver v0, Maven property interpolation v0, Go workspace/replace resolver v0, Python optional/dependency groups v0, MCP workspace/contract resources v0, MCP work artifact context preview v0, UI workspace topology surface v0, UI work artifact impact surface v0, UI work artifact metadata/freshness preview v0가 landed. 파일명은 기존 링크 유지를 위해 유지한다.
> **결론:** 이 phase는 **Java/Kotlin/Spring Boot/Python/Go/Rust/TS/JS adapter pack v0 + source-span evidence + git snapshot metadata + OpenAPI baseline + workspace catalog + cross-repo resolver + OpenAPI same-file HTTP route alias resolver + GraphQL/Protobuf/AsyncAPI consumer resolver + generated-client/event topology v0 + same-file event alias resolver v0 + contract topology surface v0 + endpoint/nested schema contract diff + Protobuf contract diff + GraphQL contract diff + AsyncAPI contract diff + build-system/package resolver + Gradle version catalog resolver + Maven property interpolation + Go workspace/replace resolver + Python optional/dependency groups + MCP workspace/contract resources + MCP work artifact context preview + UI workspace topology surface + MCP/UI work artifact impact/metadata/freshness surface**를 닫았다. 다음 제품 slice는 full parser/LSP depth, richer generated-client/event topology, deeper package/build resolution이다.

---

## 0. 한 줄 목표

Java, Kotlin, Spring Boot, Python, Go, Rust, TS/JS 저장소에서 "이 변경이 무엇을 깨뜨릴 수 있는가"를 **파일/라인/근거/검증 명령까지 믿고 볼 수 있는 답변**으로 만든다.

지금 Impact Trace의 가장 큰 빈칸은 adapter framework가 아니라 **실제 사용 stack을 coverage gap 없이 설명하는 pragmatic semantic lane**이다. `SemanticAdapter`/`AdapterRun`/registry는 이미 있고, 기본 registry는 이제 TS/JS, JVM/Spring Boot, Python, Go, Rust v0 adapter를 regex fallback보다 먼저 라우팅한다. 따라서 다음 작업은 한 언어만 깊게 파는 것이 아니라, 사용자의 실제 stack에 맞춰 v0 adapter pack을 유지하면서 Spring Boot를 first-class로 다루고 parser-backed depth를 점진적으로 더하는 것이다.

## Product North Star

최종 제품은 Claude/Codex 같은 CLI agent에 MCP로 붙는 **impact context layer**다.

- agent는 코드 수정 전후에 관련 코드, 테스트, 문서, 정책, 제안서, 의사결정 기록을 MCP로 받는다.
- agent가 전체 repo를 반복해서 읽으며 context window를 쓰는 대신, Impact-trace가 precomputed graph에서 필요한 context만 budget에 맞춰 준다.
- 사람은 같은 relation graph를 UI에서 changed/affected/evidence/action 흐름으로 본다.
- SQLite에 저장된 canonical graph가 source of truth이고, UI/graph DB/IDE integration은 그 위의 projection이다.

Phase 6B는 이 제품 전체가 아니라 첫 필수 조건이다. UI와 MCP가 유용하려면 먼저 "실제 stack의 변경 영향 답변이 맞고, evidence가 파일 위치를 가리키고, index가 어느 git 상태의 것인지 말할 수 있어야" 한다. 그래서 UI를 먼저 크게 만들기보다 multi-language adapter pack v0 + span + snapshot을 먼저 닫는다.

## 1. 왜 이 방향인가

| 후보 | 결정 |
|---|---|
| Phase 5 MemoryBench 먼저 | 뒤로 둔다. 장기적으로 필요하지만 지금은 측정 대상의 핵심인 multi-language impact relation이 아직 regex 기반이다. |
| TypeScript adapter만 먼저 | 거부한다. 사용자의 실제 stack은 Java/Kotlin/Spring Boot/Python/Go/Rust/TS/JS이고, TypeScript 단일 slice는 제품 검증 범위를 잘못 좁힌다. |
| Spring Boot를 미래 generic JVM bucket으로 둠 | 거부한다. Spring Boot는 v0 first-class target이다. endpoint/config/persistence/test relation이 제품 가치와 바로 연결된다. |
| workspace loader 먼저 | 초기에는 뒤로 뒀고, OpenAPI baseline 이후 v0 local allowlist와 cross-repo resolver까지 완료했다. |
| **Multi-language + Spring Boot v0 + trusted evidence** | 채택. adapter foundation을 실제 stack coverage로 검증하고, evidence 위치와 git 상태까지 같이 닫는다. |

## 2. Scope

포함:

- 얇은 `ImpactBench` spine: `bench/` + `npm run bench`, deterministic fixture scoring
- TypeScript/JavaScript semantic adapter v0: import/export/re-export/path alias/type-only/namespace/dynamic import/require relation
- Java/Kotlin/Spring Boot adapter v0: package/import/class/interface/function-ish declaration, Spring annotation relation
- **Spring Boot adapter v0:** endpoint/config/test/persistence/client relation을 first-class로 추출
- Python adapter v0: module/import/class/function/test relation
- Go adapter v0: package/import/function/type/test relation
- Rust adapter v0: module/use/struct/enum/function/test relation
- registry priority: language/framework adapters가 regex fallback보다 먼저 매칭
- `relation_evidence` source span persistence: `start_line`, `end_line`, `start_col`, `end_col`
- report/MCP evidence output의 optional span 노출
- `index_runs` git snapshot metadata: commit SHA, branch name, dirty state
- stale-index warning을 git snapshot 기반으로 정밀화
- docs/ADR 정리: Phase 6 foundation부터 MCP work artifact context preview까지 decisions log D-046으로 갱신

v0 target languages/frameworks:

- Java
- Kotlin
- Spring Boot
- Python
- Go
- Rust
- TypeScript
- JavaScript

제외:

- full MemoryBench, topic clustering, multi-layer reflection
- full interprocedural call graph, data-flow, symbol reference graph
- JVM bytecode analysis, full Maven/Gradle model, annotation processor resolution
- Python virtualenv/package resolver, Go transitive module/build-list resolver, Cargo feature resolver, package-manager lockfile/transitive resolver
- GraphQL/protobuf/AsyncAPI full parser depth, cross-file generated-client usage graph, richer event topology inference, OpenAPI의 discriminator/nullable/format/auth 같은 advanced compatibility semantics
- LSP/CodeQL enrichment, graph DB projection, full web explorer
- agent가 report를 보고 자동으로 코드 수정하는 기능

단, 현재 v0 adapter들은 deterministic heuristic extractor를 공유한다. TS/JS import-like syntax는 `ts.createSourceFile` 기반 parser span으로 한 단계 깊어졌고, JVM/Spring은 endpoint/declaration/config/test relation에 lightweight line/annotation spans를 저장한다. Python/Go/Rust는 declaration/test relation에 lightweight declaration-line spans를 저장한다. OpenAPI/Swagger/AsyncAPI YAML/JSON은 contract baseline과 명시적 code path 기반 implementer reverse-link를 저장한다. workspace catalog v0는 `.impact-trace/workspace.json` local allowlist를 기존 `workspaces`/`workspace_repos` 테이블에 동기화한다. cross-repo contract resolver v0는 indexed workspace repo의 OpenAPI provider endpoint와 HTTP consumer call-site literal/same-file exact route alias, GraphQL provider root field와 consumer operation document, Protobuf provider RPC와 service-anchored/generated-client/full-route consumer call, AsyncAPI provider operation과 consumer/producer event address call-site를 `cross_repo_links`로 연결한다. OpenAPI HTTP route alias v0는 TS/JS/Java/Kotlin standalone exact string alias를 실제 `fetch`/Feign mapping/WebClient/RestTemplate/common HTTP client call-site가 직접 쓰는 경우만 link로 승격하고, Spring controller mapping/declaration-only/computed path는 제외한다. AsyncAPI event topology v0는 Spring Kafka/KafkaJS/Python/Go/Rust common call-site와 같은 파일의 TS/JS/Java/Kotlin standalone exact string alias를 producer/consumer hint로 provenance에 남기고, contract diff는 이 hint를 impacted consumer와 breaking link provenance까지 보존한다. contract topology surface v0는 이 hint를 summary breakdown, CLI human output, MCP cross-repo link top-level field로 노출해 agent/UI가 nested provenance를 다시 파싱하지 않아도 되게 한다. UI workspace topology surface v0는 같은 compact contract/link/resource shape를 `impact-trace ui`와 `/api/workspaces/{name}`에 노출해 사람이 full provenance를 펼치지 않고도 workspace impact를 확인하게 한다. UI work artifact impact surface v0는 selected report의 policy/decision/PRD/requirement/proposal target을 `workArtifacts`와 Work Artifacts panel로 분리하고, 문서 본문 대신 entity resource URI만 제공한다. UI work artifact metadata/freshness preview v0는 Markdown frontmatter/문서 선두 H1에서 title/owner/status/updatedAt만 추출하고, `updatedAt`을 report 생성 시각 기준 stale/current/unknown으로 분류한다. MCP work artifact context preview v0는 같은 compact artifact metadata/freshness를 `context_for_change.workArtifacts`로 제공하고 artifact evidence snippet은 placeholder로 생략한다. contract diff v0는 latest indexed OpenAPI endpoint surface와 current contract file을 비교해 removed endpoint를 breaking, added endpoint를 non-breaking으로 분류하고 known consumer를 `BREAKS_COMPATIBILITY_WITH` link로 저장한다. JSON/YAML OpenAPI는 latest index에 `openapi-compat-v0` schemaVersion 2 request/response nested schema path signature를 저장해 response status/required property/type 및 request required property/type breaking rule까지 비교한다. Protobuf는 latest index에 `protobuf-compat-v0` service/RPC/message field signature를 저장하고 removed RPC, response field removal/type change를 breaking으로 분류한다. GraphQL은 latest index에 `graphql-compat-v0` root operation/object/input signature를 저장하고 removed root field, response field removal/type change, required argument/input field 추가를 breaking으로 분류한다. AsyncAPI는 latest index에 `asyncapi-compat-v0` operation/channel/message payload signature를 저장하고 removed operation, message payload field removal/type change, 새 required payload field 추가를 breaking으로 분류한다. build-system/package resolver v0는 `package.json`, `pom.xml`, `build.gradle(.kts)`, `go.mod`, `go.work`, `Cargo.toml`, `pyproject.toml`과 Gradle `libs.versions.toml`을 manifest-only로 읽어 package `DECLARES`/`DEPENDS_ON` graph를 만든다. Maven POM은 같은 파일의 `<properties>`와 `project.*`/`pom.*`/parent alias를 package 좌표와 version metadata로 치환한다. Gradle version catalog는 가장 가까운 default `gradle/libs.versions.toml`의 `[versions]`/`[libraries]`/`[bundles]` alias를 build script의 direct/nested `libs.*` accessor에서 실제 package 좌표와 version metadata로 펼친다. Go workspace/replace v0는 `go.work use` 디렉터리를 해당 `go.mod`에 연결하고 repo-local `replace => ./local` module을 실제 local Go package dependency로 승격한다. Python dependency groups v0는 `pyproject.toml`의 `[project.optional-dependencies]`, PEP 735 `[dependency-groups]`, Poetry `[tool.poetry.group.<group>.dependencies]`를 package dependency graph에 추가하되 `include-group` 객체는 dependency로 오인하지 않는다. nested object path, root/nested array item path, object/array segment를 지나는 local `$ref` chain, allOf object merge, properties 없는 required-only object까지 포함한 oneOf/anyOf property/root body fingerprint는 포함됐다. schemaVersion 1 flat OpenAPI baseline은 warning으로 reindex를 요구한다. full type-checker, full parser-backed Python/Go/Rust resolution, Tree-sitter/LSP/CodeQL enrichment, full source span coverage, cross-file generated-client data flow, richer event topology inference, GraphQL/protobuf/AsyncAPI full parser depth, lockfile/transitive/semver/package-manager execution depth, Maven parent file/profile/effective model, custom/imported Gradle catalog, Go transitive module/build-list semantics, PEP 735 include expansion은 후속 pass로 둔다.

## 3. Architecture

### Adapter boundary

`src/adapters/types.ts`의 현재 contract를 유지한다.

- `SemanticAdapter.start(ctx, files)`에서 비싼 setup을 한 번 수행
- `AdapterRun.process(file)`에서 `entity`, `relation`, `diagnostic` event emit
- language/framework adapter는 지원 파일을 먼저 처리하고, regex adapter는 Markdown, config/system language, unsupported syntax fallback으로 유지
- adapter가 확실히 모르는 relation은 만들지 않고 coverage gap/diagnostic으로 남긴다

### v0 relation surface

| Relation | v0 처리 |
|---|---|
| `DECLARES` | file/module/package -> class/function/type/config key/endpoint/test declaration |
| `DEPENDS_ON` | import/use/require, Spring bean/client/config dependency, package/module dependency |
| `VERIFIES` | test file/class/function -> imported or annotated source/config/persistence target |
| `REFERENCES` | config key, route path, table/entity name, bean name, external service/client reference |
| `IMPLEMENTS` | Spring controller/service/repository/config entity가 endpoint/config/persistence role을 구현 |
| `CALLS` | v0에서는 framework-obvious client calls만 제한적으로 처리. 일반 call graph는 v1.1로 미룸 |

v0 깊이는 pragmatic하게 제한한다. **DECLARES, DEPENDS_ON, VERIFIES, endpoint/config/persistence relation**을 먼저 닫고, full call graph는 이후 slice에서 LSP/CodeQL/Tree-sitter enrichment와 함께 다룬다.

### Spring Boot adapter v0

Spring Boot는 future JVM bucket이 아니라 Phase 6B v0의 first-class adapter다.

| Surface | v0 추출 |
|---|---|
| Web endpoints | `@RestController`, `@Controller`, `@RequestMapping`, `@GetMapping`, `@PostMapping`, `@PutMapping`, `@PatchMapping`, `@DeleteMapping` |
| Service layer | `@Service`, constructor/field injection dependency, controller -> service `DEPENDS_ON` |
| Persistence | `@Repository`, Spring Data `Repository`/`JpaRepository`/`CrudRepository`, JPA `@Entity`, `@Table`, repository -> entity relation |
| Configuration | `@Configuration`, `@Bean`, `@ConfigurationProperties`, `@Value`, `application.yml`, `application.yaml`, `application.properties` |
| Tests | `@SpringBootTest`, `@WebMvcTest`, `@DataJpaTest`, common JUnit test class/function naming, test -> target `VERIFIES` |
| HTTP clients | Feign (`@FeignClient`), `WebClient`, `RestTemplate` dependency/client relation |

Spring v0의 목표는 "Spring 애플리케이션의 모든 runtime wiring을 완벽히 재현"이 아니다. 목표는 controller endpoint, service dependency, repository/entity, config key, slice/integration test가 impact report와 MCP context pack에서 근거와 함께 보이는 것이다.

### Language adapter v0 detail

| Adapter | v0 minimum |
|---|---|
| TypeScript/JavaScript | imports/re-exports/path alias/type-only/namespace/dynamic import/require, exported declarations, test imports, TSX/JSX smoke |
| Java | package/import, class/interface/enum/record, method-ish declarations, annotations, JUnit tests |
| Kotlin | package/import, class/object/interface/data class, function declarations, annotations, tests |
| Python | import/from import, function/class declarations, pytest/unittest test files/functions |
| Go | package/import, func/type declarations, `_test.go` verifies source package |
| Rust | `mod`/`use`, `fn`/`struct`/`enum`/`trait` declarations, `#[test]` and tests module |

### Source span

`PendingEvidence` 타입은 이미 `startLine/endLine/startCol/endCol`을 받을 수 있다. 빠진 것은 DB persistence와 report/MCP serialization이다.

ADD-only schema:

- `relation_evidence.start_line INTEGER`
- `relation_evidence.end_line INTEGER`
- `relation_evidence.start_col INTEGER`
- `relation_evidence.end_col INTEGER`

새 confidence enum은 만들지 않는다. 현재 union인 `proven | inferred | heuristic | unknown`을 유지하고, parser/annotation exact span은 `proven`, regex line-only/whole-file evidence는 `heuristic`으로 둔다.

### Git snapshot

`index_runs`에 다음 컬럼을 ADD-only로 추가한다.

- `git_commit_sha TEXT`
- `git_branch_name TEXT`
- `git_is_dirty INTEGER NOT NULL DEFAULT 0`

non-git repo에서는 nullable metadata로 동작한다. analyzer는 현재 HEAD/dirty state가 index run metadata와 다르면 stale warning을 더 명확히 낸다.

## 4. Thin ImpactBench

full MemoryBench가 아니라 adapter accuracy용 얇은 evaluation spine을 먼저 둔다.

목표:

- `npm test`: 회귀 보호
- `npm run bench`: golden fixture 기반 정확도 측정
- 외부 네트워크, LLM, 실제 embedding model 없이 deterministic 실행
- JSON report 생성

필수 fixture:

- TS/JS: re-export barrel, path alias, type-only import, namespace import, dynamic import, require, TSX/JSX import
- Java/Kotlin: package/import/class/function declaration, JUnit tests, annotation smoke
- Spring Boot endpoint: `@RestController` + class/method `@RequestMapping`/`@GetMapping`/`@PostMapping`
- Spring Boot config: `@Configuration`, `@Bean`, `@ConfigurationProperties`, `application.yml`/`application.properties`
- Spring Boot persistence: JPA `@Entity`, Spring Data Repository, `@Repository`
- Spring Boot tests: `@SpringBootTest`, `@WebMvcTest`, `@DataJpaTest`
- Spring Boot clients: Feign `@FeignClient`, `WebClient`, `RestTemplate`
- Python: imports, class/function declarations, pytest/unittest verifies
- Go: package/import/function/type declarations, `_test.go` verifies
- Rust: `mod`/`use`, item declarations, `#[test]` verifies
- fallback: Markdown/config/system inference remains attributed to regex adapter

채점:

- expected relation recall/precision per adapter
- `analyzeDiff` affected file recall
- evidence 존재 여부와 redaction 유지
- adapter attribution: supported files는 language/framework adapter, fallback은 regex adapter
- span completeness: source-span slice 이후 gate로 승격
- context-pack readiness: top relation/evidence payload가 MCP budget에 넣을 수 있을 만큼 작고 dedupe 가능

현재 얇은 spine은 `bench/impact-bench.ts`와 `npm run bench`로 시작한다. report는 기본적으로 `.impact-trace/bench/impact-bench-report.json`에 쓰며, `.impact-trace/`는 gitignore 대상이라 반복 실행해도 작업트리를 오염시키지 않는다. 2026-05-12 기준 fixture는 TS/JS alias/re-export/type-only/namespace/dynamic import/require span, Spring Boot `@ConfigurationProperties`, `application.properties`, JPA/Spring Data, `@DataJpaTest`, Feign/WebClient/RestTemplate, Python/Go/Rust declaration/test span, OpenAPI endpoint declaration과 Spring controller implementer reverse-link, Gradle/Maven/Go/Python package resolver expected relation까지 검증한다. TS/JS parser-backed import span v0, JVM/Spring lightweight evidence span v0, Python/Go/Rust lightweight evidence span v0, OpenAPI contract impact baseline 이후 `spanCompleteness >= 0.9`가 bench gate다. 이 spine은 Phase 6B 전체 완료 선언이 아니라, 이후 Java/Kotlin/Spring Boot/Python/Go/Rust/TS/JS/contract/package adapter depth pass가 개선됐는지 숫자로 확인하기 위한 기준선이다.

## 5. Commit Plan

1. `docs: retarget Phase 6B to multi-language Spring Boot pack`
   - README, roadmap, progress, docs index, changelog의 TypeScript 단일 slice 문구 정리
   - 이 문서를 다음 작업 기준으로 연결

2. `test(bench): add ImpactBench multi-language fixtures`
   - `bench/` + `npm run bench`
   - TS/JS, Java/Kotlin/Spring Boot, Python, Go, Rust fixture matrix
   - language/framework adapter attribution과 regex fallback 경계를 JSON report로 고정
   - unit test를 깨는 expected-fail 대신 benchmark signal로 둠
   - 현재 thin spine landed: relation recall/precision, affected-file recall, evidence presence, span completeness, adapter attribution, context-pack readiness를 deterministic JSON으로 기록

3. `feat(evidence): persist relation evidence source spans`
   - ADD-only schema
   - insert/restore/analyzer/report/MCP 타입 반영
   - 기존 row NULL span backward-compatible

4. `feat(adapters): add TS and JS semantic adapter v0`
   - landed: default registry가 TS/JS 파일을 `typescript-javascript-semantic-v0` adapter run으로 라우팅
   - import/export/re-export/path alias/type-only/namespace/dynamic import coverage
   - landed depth: `ts.createSourceFile`로 static/type-only/namespace/re-export/dynamic import/require evidence snippet과 line/col range 저장
   - follow-up: parser-backed `ts.createProgram` depth pass와 diagnostics 고도화

5. `feat(adapters): add Java Kotlin Spring Boot adapter v0`
   - landed: default registry가 Java/Kotlin 파일을 `jvm-spring-semantic-v0` adapter run으로 라우팅
   - Java/Kotlin package/import/declaration/annotation extraction
   - Spring endpoint/config/persistence/test/client relation extraction
   - landed depth: Spring endpoint `IMPLEMENTS`, Spring role/bean `DECLARES`, config path mention `CONFIGURES`, filename-inferred JVM `VERIFIES` evidence에 bounded snippet과 line/col range 저장
   - `@RestController`, mapping annotations, `@Service`, `@Repository`, `@Configuration/@Bean`, `@ConfigurationProperties`, JPA `@Entity`, Spring Data Repository, Feign/WebClient/RestTemplate coverage

6. `feat(adapters): add Python Go Rust adapter v0`
   - landed: `python-semantic-v0`, `go-semantic-v0`, `rust-semantic-v0` adapter run 라우팅
   - module/import/declaration/test relation extraction
   - landed depth: Python/Go/Rust generic `DECLARES`와 filename-inferred `VERIFIES` evidence에 bounded declaration-line snippet과 line/col range 저장
   - build-system/package resolver v0 landed as manifest-only graph; full package-manager resolution remains deferred
   - unsupported syntax is diagnostic, not hard failure

7. `feat(indexer): route supported languages through adapter pack`
   - default registry priority 조정
   - regex fallback 유지
   - tests `VERIFIES`, external import, docs/config inference regression 방지

8. `feat(indexer): record git snapshot metadata`
   - `index_runs` commit/branch/dirty 저장
   - analyzer stale warning 정밀화
   - non-git repo no-op 테스트

9. `docs: promote adapter ADRs and close Phase 6B handoff`
   - D-019 adapter interface
   - D-020 adapter run unit
   - D-021 migration/regex fallback policy
   - Phase 6B 결과와 다음 Phase 5/7 진입 조건 기록

## 5.5 Product Slices Completed After Phase 6B Planning

초기 Phase 6B 계획 뒤에 다음 제품 slice도 완료됐다.

1. **MCP context pack/resource contract:** `impact_trace_context_for_change`, body-free work artifact context preview, `impact_trace_explain_entity`, graph pagination, typed error envelope, persisted context pack reuse가 landed 상태다.
   - `brief`/`standard`/`deep` context budget, dedupe, ranking, resource-on-demand evidence가 v0에 포함됐다.
   - multi-language adapter 결과는 language/framework별 top impact path로 압축되어 AI context 사용량을 줄인다.
2. **UI explorer v0:** 저장된 report/graph JSON을 읽어 changed/affected/evidence/action을 필터링해 보여주는 read-only local UI가 `impact-trace ui`로 landed 상태다.
3. **Workspace catalog + resolver + contract diff + MCP/UI resources v0:** `.impact-trace/workspace.json` local allowlist, `workspace init/add-repo/list/resolve-contracts/contract-diff` CLI, OpenAPI HTTP consumer links와 same-file exact route alias resolver, GraphQL operation-document consumer links, Protobuf generated-client/full-route consumer links, AsyncAPI producer/consumer topology hints와 same-file exact alias resolver, contract topology summary/CLI/resource surface, JSON/YAML OpenAPI nested request/response schema breaking rules, Protobuf service/RPC/message field breaking rules, GraphQL root/object/input schema breaking rules, AsyncAPI operation/message payload breaking rules, `impact_trace_contract_diff`, `impact-trace://workspaces/{name}/contracts`, `/cross-repo-links` resource, `impact-trace ui` workspace topology panel, `/api/workspaces/{name}` JSON이 landed 상태다.
4. **Build-system/package resolver v0:** `package.json`, `pom.xml`, `build.gradle(.kts)`, Gradle `libs.versions.toml`, `go.mod`, `go.work`, `Cargo.toml`, `pyproject.toml` manifest-only package graph가 landed 상태다. Maven POM property interpolation은 same-file `<properties>`와 `project.*`/`pom.*`/parent alias를 actual package coordinate와 version metadata로 펼친다. Gradle version catalog `[versions]`/`[libraries]`/`[bundles]` alias는 actual package coordinate와 version metadata로 펼치며, `platform(libs.*)`/`enforcedPlatform(libs.*)` 같은 nested accessor도 dependency type을 유지한다. Go workspace/replace resolver는 `go.work use` directory를 `go.mod` manifest로 연결하고 repo-local `replace` module을 actual local Go package dependency로 승격한다. Python dependency groups v0는 `[project.optional-dependencies]`, PEP 735 `[dependency-groups]`, Poetry `tool.poetry.group.<group>.dependencies`를 graph에 넣고 `include-group` 객체를 dependency로 오인하지 않는다. package manager/build tool execution, lockfile/transitive resolution, Maven parent file/profile/effective model, custom/imported Gradle catalogs, Go transitive module/build-list semantics, Python include expansion/virtualenv resolution은 후속이다.
5. **MCP/UI work artifact impact/metadata/freshness surface v0:** selected report와 context pack의 policy, decision, PRD, requirement, proposal impact가 `workArtifacts`로 분리된다. Markdown frontmatter/문서 선두 H1에서 title/owner/status/updatedAt만 추출하고, stale/current/unknown freshness를 표시하되 본문은 싣지 않는다.

다음 제품 slice는 full parser/LSP depth, richer generated-client/event topology, deeper package/build resolution으로 넓히는 것이다.

## 6. Acceptance Criteria

- `npm run check`, `npm test`, `npm run docs:lint`, `npm audit --audit-level=high` 통과
- `npm run bench`가 deterministic JSON report를 생성
- v0 target이 명시적으로 cover됨: Java, Kotlin, Spring Boot, Python, Go, Rust, TypeScript, JavaScript
- Spring Boot fixture에서 endpoint/config/persistence/test/client relation이 검출됨
  - `@RestController`, `@RequestMapping`/`@GetMapping`/`@PostMapping`
  - `@Service`, `@Repository`, `@Configuration`/`@Bean`, `@ConfigurationProperties`
  - `application.yml`/`application.properties`
  - `@SpringBootTest`, `@WebMvcTest`, `@DataJpaTest`
  - JPA `@Entity`, Spring Data Repository, Feign/WebClient/RestTemplate
- 각 language adapter가 regex 대비 핵심 fixture를 추가/정확 검출
- build-system/package resolver가 npm, Maven, Gradle, Go, Cargo, Python manifest에서 local/external package `DECLARES`/`DEPENDS_ON` graph를 만들고 malformed manifest를 diagnostic으로 처리
- 기존 behavior regression 없음: Markdown mentions, external entity, tests `VERIFIES`, docs/config inference 유지
- 가능한 evidence에는 `start_line/end_line/start_col/end_col` 저장
- TS/JS import-backed evidence와 import 기반 `VERIFIES`, JVM/Spring endpoint/declaration/config/test evidence, Python/Go/Rust declaration/test evidence, OpenAPI endpoint/implementer evidence는 bounded snippet + line/col range를 저장하고 ImpactBench `spanCompleteness >= 0.9`를 유지
- analyze/MCP evidence output에서 span 확인 가능
- dirty repo 또는 HEAD mismatch에서 git snapshot 기반 warning 출력
- docs가 더 이상 Phase 6B를 TypeScript 단일 slice로 설명하지 않음
- adapter output이 MCP context pack의 budget/dedupe/ranking 입력으로 재사용 가능한 shape를 유지

## 7. Premise Gate

추천 전제는 이것이다:

> Impact Trace의 다음 사용자 가치는 "memory가 더 똑똑해짐"도 "TS만 정확해짐"도 아니라 "실제 stack의 변경 영향 답변을 믿을 수 있음"이다.

이 전제를 채택하면 위 commit plan으로 간다. 전제를 거부하면 TypeScript 단일 adapter 또는 MemoryBench를 먼저 설계해야 하지만, 그 경우 사용자의 Java/Kotlin/Spring Boot/Python/Go/Rust/TS/JS stack에서 제품 signal이 약하다.
