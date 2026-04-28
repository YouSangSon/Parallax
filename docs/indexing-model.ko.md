# Impact Trace 인덱싱 모델

영어 버전: [indexing-model.en.md](indexing-model.en.md)

## 목표

Impact Trace의 인덱싱 모델은 한 repo 안의 여러 언어와 여러 시스템 설정, 그리고 여러
repo 사이의 API/gRPC/event contract를 같은 영향도 그래프로 표현한다. 파일은 시작점일
뿐이다. 최종 분석 단위는 함수, 변수, 클래스, 모듈, package, shell command, YAML
workflow, Kubernetes resource, Terraform resource, policy rule, 문서, 테스트,
contract, event 같은 `Entity`다. 언어 범위는 TS/JS에서 시작하지만 Python, Go, Rust,
Java, Kotlin, C#, C, C++까지 같은 모델로 확장한다.

## 핵심 용어

| 용어 | 뜻 | 왜 중요한가 |
|---|---|---|
| Entity | 변경되거나 영향을 받을 수 있는 대상 | 파일뿐 아니라 symbol, workflow, resource, policy도 분석 대상이 된다. |
| Relation | entity 사이의 방향성 있는 연결 | 변경 영향이 어떤 경로로 전파되는지 설명한다. |
| Evidence | relation을 믿을 수 있는 근거 | 에이전트가 추측이 아니라 증거를 보고 판단한다. |
| Adapter | 특정 언어/시스템에서 entity와 relation을 추출하는 모듈 | TS/JS, Python, Go, Rust, Java/Kotlin, C#, C/C++, shell, YAML, CI, Terraform을 독립적으로 확장할 수 있다. |
| Workspace | 여러 repo를 하나의 제품/서비스 경계로 묶은 단위 | API, gRPC, event로 연결된 프로젝트 간 영향을 추적한다. |
| Contract | OpenAPI, protobuf, GraphQL, AsyncAPI 같은 서비스 계약 | provider 변경이 consumer를 깨뜨리는지 판단하는 기준이다. |
| Coverage | 무엇을 읽었고 무엇을 건너뛰었는지 | 모르는 영역을 숨기지 않는다. |
| Visualization | entity graph에서 파생한 관계 보기 | 에이전트와 사람이 같은 영향 경로를 확인한다. |
| Action | 변경 후 실행하거나 확인할 추천 작업 | 테스트, owner review, policy review, docs update를 구조화한다. |

## Entity 분류

| Category | Entity kind | 예시 |
|---|---|---|
| Code | `file`, `symbol`, `module`, `package` | `validateSession`, `auth/session.ts`, npm workspace |
| Test | `test` | test file, test case, CI test job |
| Docs | `doc` | README, ADR, runbook |
| Config | `config` | YAML, JSON, TOML, `.env`, `tsconfig`, package script |
| Workflow | `workflow` | GitHub Actions workflow, job, step, Make target |
| Infra | `resource` | Docker image, Kubernetes deployment, Terraform resource |
| API | `endpoint` | REST route, GraphQL field, protobuf service |
| Contract | `contract`, `event` | OpenAPI operation, protobuf method, GraphQL field, Kafka topic |
| External | `external_entity` | workspace 밖 SaaS API, third-party service, unmanaged repo |
| Governance | `policy` | CODEOWNERS rule, OPA/Rego rule, permission manifest |

## Relation 분류

| Relation | 설명 |
|---|---|
| `DEPENDS_ON` | source entity가 target entity를 필요로 한다. |
| `CALLS` | source symbol 또는 command가 target을 호출한다. |
| `REFERENCES` | config key, path, resource name, symbol을 참조한다. |
| `VERIFIES` | test나 CI job이 target entity를 검증한다. |
| `DOCUMENTS` | 문서가 target entity를 설명한다. |
| `CONFIGURES` | config가 runtime, workflow, resource를 설정한다. |
| `GENERATES` | build/script가 artifact를 만든다. |
| `DEPLOYS` | workflow가 artifact/resource를 배포한다. |
| `OWNS` | owner나 review path를 지정한다. |
| `GOVERNS` | policy가 변경 가능 여부나 review requirement를 결정한다. |
| `IMPLEMENTS` | code, route handler, RPC handler가 contract를 구현한다. |
| `CONSUMES` | client, generated SDK, workflow, service가 API/RPC/event contract를 사용한다. |
| `PRODUCES` | service나 workflow가 event, artifact, API response contract를 만든다. |
| `BREAKS_COMPATIBILITY_WITH` | 변경된 contract가 기존 consumer baseline과 호환되지 않는다. |

## Entity ID 원칙

Entity ID는 deterministic해야 한다. 같은 repo와 같은 index input이면 항상 같은 ID가
나와야 report 비교와 graph projection이 가능하다.

여러 repo를 묶는 workspace에서는 ID에 repo namespace를 포함한다. repo-local ID는
계속 짧게 유지하되, workspace report에서는 `repo:<service-name>:` prefix를 붙여
충돌을 피한다.

| Entity | ID 예시 |
|---|---|
| File | `file:src/auth/session.ts` |
| Symbol | `symbol:typescript:src/auth/session.ts#function:validateSession` |
| Package | `package:npm:apps/web` |
| CI job | `workflow:github-actions:.github/workflows/ci.yml#job:test` |
| Kubernetes resource | `resource:kubernetes:apps/api/deployment/api` |
| Terraform resource | `resource:terraform:aws_lambda_function.auth_handler` |
| Policy rule | `policy:codeowners:/src/auth/*` |
| Workspace repo | `repo:billing-api` |
| OpenAPI contract | `repo:billing-api:contract:openapi:/paths/~1invoices/get` |
| Protobuf method | `repo:user-api:contract:protobuf:user.v1.UserService/GetUser` |
| Event topic | `repo:orders:event:kafka:order.created` |
| External API | `external:stripe:/v1/customers` |

## 언어 adapter 범위

언어 adapter는 모두 같은 `Entity`와 `Relation` output contract를 따른다. 각 언어의
정확도는 단계적으로 올리되, report model은 언어별로 갈라지지 않는다.

| 언어/생태계 | 주요 entity | 주요 relation |
|---|---|---|
| TypeScript/JavaScript | module, function, class, variable, type, package | imports, re-exports, references, calls |
| Python | module, function, class, package | imports, references, calls |
| Go | package, function, method, interface | imports, references, calls |
| Rust | crate, module, function, trait, impl | uses, references, calls |
| Java/Kotlin | Maven/Gradle module, package, class, method, field, annotation | imports, references, calls, implements |
| C#/.NET | solution, project, namespace, class, method, property | project dependency, references, calls |
| C/C++ | translation unit, header, function, type, macro, build target | includes, references, calls, generates |
| Build systems | npm, pip, cargo, Maven, Gradle, dotnet, CMake, Make, Bazel target | depends-on, verifies, generates |

## Workspace와 프로젝트 간 연결

각 repo는 독립적으로 인덱싱할 수 있어야 한다. workspace index는 repo-local DB를
버리지 않고, 각 repo의 completed index를 읽어 cross-repo relation만 추가한다.

| 연결 유형 | 추출 근거 | 생성 relation |
|---|---|---|
| REST/OpenAPI | `openapi.yaml`, route handler, generated client, base URL config | `IMPLEMENTS`, `CONSUMES`, `DOCUMENTS` |
| gRPC/protobuf | `.proto`, service implementation, generated stub import | `IMPLEMENTS`, `CONSUMES` |
| GraphQL | schema, resolver, query/mutation document | `IMPLEMENTS`, `CONSUMES` |
| AsyncAPI/event | topic/channel schema, producer call, consumer subscription | `PRODUCES`, `CONSUMES` |
| External SaaS | local contract snapshot, SDK import, env/config key | `CONSUMES`, `REFERENCES` |

contract diff는 `breaking`, `non-breaking`, `unknown`으로 분류한다. analyzer는 breaking
가능성이 있는 변경을 consumer repo, 관련 테스트, owner review action까지 연결한다.

## 관계 시각화 모델

시각화는 canonical graph의 projection이다. 저장 모델은 바꾸지 않고 report/entity/workspace
범위에서 nodes와 edges를 다시 만든다.

| Export | 목적 |
|---|---|
| Mermaid | Markdown report, PR 설명, Obsidian note에 붙일 작은 그래프 |
| DOT/Graphviz | 큰 그래프 레이아웃, CI artifact, 이미지 생성 |
| JSON graph | 웹 UI, D3, Cytoscape, Gephi 같은 외부 도구 연동 |

시각화 node에는 entity kind, repo, display name, confidence, coverage status를 넣는다.
edge에는 relation kind, evidence count, confidence를 넣고, raw secret이나 긴 source
snippet은 넣지 않는다.

## Adapter 계층

Adapter는 서로 같은 output contract를 가져야 한다.

```text
Repo files
  -> file classifier
  -> adapter selection
  -> entities
  -> relations
  -> evidence spans
  -> coverage records
```

| Adapter family | 역할 |
|---|---|
| Language semantic | TypeScript Compiler API, LSP, CodeQL처럼 정확한 symbol/reference를 만든다. |
| Syntax fallback | Tree-sitter처럼 여러 언어에서 기본 symbol/import를 만든다. |
| Build/project system | Maven, Gradle, dotnet, CMake, Make, Bazel, package manager metadata를 읽는다. |
| Config/system | YAML, JSON, TOML, shell, Docker, Kubernetes, Terraform, CI를 읽는다. |
| Workspace/contract | repo catalog, OpenAPI, protobuf, GraphQL, AsyncAPI, event schema를 읽는다. |
| Policy/governance | CODEOWNERS, OPA/Rego, permission manifest를 읽는다. |
| Action provider | test/review/docs/deploy action을 추천한다. |
| Projection | SQLite entity graph를 graph DB, visual graph, vector DB, Obsidian으로 파생한다. |

## 저장 모델 요구사항

| 요구사항 | 이유 |
|---|---|
| `entities`와 `relations`가 canonical이어야 한다. | graph DB 없이도 범용 영향도 분석을 할 수 있다. |
| `workspaces`와 `workspace_repos`는 repo-local DB 위에 얇게 추가한다. | 단일 repo 사용성을 유지하면서 cross-repo 분석을 가능하게 한다. |
| `contracts`, `contract_versions`, `cross_repo_links`가 있어야 한다. | API/gRPC/event 변경의 producer/consumer 영향을 저장한다. |
| `adapter_runs`를 저장해야 한다. | 어떤 adapter가 어떤 버전으로 무엇을 읽었는지 알아야 한다. |
| `relation_evidence`가 source span을 가져야 한다. | report가 line-level 근거를 보여줄 수 있다. |
| `index_coverage`가 skipped reason을 가져야 한다. | unsupported language나 oversized file을 숨기지 않는다. |
| running index와 completed index를 분리해야 한다. | 분석이 중간 상태를 읽지 않는다. |
| report는 versioned contract여야 한다. | MCP client와 CLI automation이 안전하게 업그레이드된다. |

## 분석 결과 모델

| Field | 역할 |
|---|---|
| `reportVersion` | report JSON contract 버전 |
| `schemaVersion` | SQLite schema compatibility |
| `repo` | root, remote, branch, commit, dirty state |
| `diff` | base/head, changed ranges, rename/delete 정보 |
| `changed` | 변경된 entity 목록 |
| `affected` | 영향받는 entity와 relation path |
| `workspace` | 선택적으로 workspace, 관련 repo, service boundary |
| `actions` | 테스트, 리뷰, 문서, 배포 확인 추천 |
| `evidence` | redacted source span과 provenance |
| `coverage` | missing adapter, skipped file, parse error |
| `graph` | 선택적으로 Mermaid/DOT/JSON graph export URI나 inline summary |

## 현재 MVP와의 차이

| 현재 MVP | 목표 모델 |
|---|---|
| file path 중심 | entity ID 중심 |
| `edges.target_path` reverse lookup | `relations.target_entity_id` graph traversal |
| regex TS/JS extraction | semantic adapter + fallback adapter |
| whole-file snippet evidence | source span evidence |
| changedFiles input | git diff, entity input, patch input |
| npm test action | runner/action provider |
| single MCP tool JSON text | compact tool + paginated resources |
| repo-local impact only | workspace-aware API/gRPC/event contract impact |
| no graph visualization | Mermaid/DOT/JSON graph export + optional web explorer |
