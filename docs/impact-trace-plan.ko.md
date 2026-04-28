# Impact Trace 계획서

생성일: 2026-04-28

영어 버전: [impact-trace-plan.en.md](impact-trace-plan.en.md)

## 한눈에 보기

Impact Trace는 Claude Code, Codex 같은 에이전트 코딩 도구가 코드를 바꾸기 전에
프로젝트 영향 범위를 읽을 수 있게 만드는 local-first 인덱싱 레이어다.

핵심은 graph DB가 아니다. 핵심은 한 저장소 안의 함수, 변수, 클래스, 모듈, shell
script, YAML, CI workflow, Terraform, Kubernetes, OpenAPI, 정책 파일, 문서, 테스트뿐
아니라 여러 저장소 사이의 REST API, gRPC/protobuf, GraphQL, AsyncAPI/event contract를
같은 `Entity`와 `Relation` 모델로 연결하는 것이다. SQLite가 canonical store가 되고,
graph DB는 필요할 때 파생하는 projection이다.

## 목차

- 제품 원칙
- 현재 기준선
- 해결할 문제
- 범위와 비범위
- 목표 아키텍처
- Canonical 데이터 모델
- Adapter 전략
- 분석 흐름
- 연관성 시각화
- MCP와 CLI 계약
- 보안과 신뢰 경계
- 테스트와 품질 게이트
- 단계별 로드맵
- 부족한 점
- 의사결정 기록

## 제품 원칙

| 원칙 | 설명 |
|---|---|
| Evidence first | 모든 영향도 판단은 evidence, provenance, confidence를 함께 가져야 한다. |
| Storage-neutral core | SQLite가 source of truth이고 graph/vector/CodeQL은 선택 adapter다. |
| Multi-language by default | TS/JS, Python, Go, Rust, Java, Kotlin, C#, C, C++와 설정 시스템이 섞이는 것을 기본 전제로 둔다. |
| Workspace-aware impact | 한 제품이 여러 repo와 service contract로 나뉘는 것을 기본 확장 축으로 둔다. |
| Visualization is a projection | 관계 시각화는 source of truth가 아니라 canonical graph에서 파생한 view로 둔다. |
| No silent certainty | 모르는 것은 `unknown`, coverage gap, missing adapter로 드러낸다. |
| Read-only agent surface first | MCP는 먼저 안전한 read-only 분석 표면으로 안정화한다. |
| Actions are recommendations | 테스트나 리뷰 command는 실행하지 않고 `command + args` 구조로 추천만 한다. |

## 현재 기준선

현재 MVP는 제품 방향을 검증하기 위한 좁은 구현이다.

| 영역 | 현재 상태 |
|---|---|
| CLI | `init`, `index`, `analyze`, `mcp serve` 제공 |
| MCP | 공식 MCP SDK 기반 stdio server, read-only `impact_trace_analyze_diff` 제공 |
| Storage | repo-local SQLite, legacy `files/symbols/edges`, canonical `entities/relations/relation_evidence` 병행 저장 |
| Indexing | TS/JS/Markdown + Python/Go/Rust/Java/Kotlin/C#/C/C++ 파일과 기본 symbol/dependency 휴리스틱 추출 |
| Report | `changed`, `affected`, `actions`, `evidence` 중심의 언어 중립 report model |
| Security | path containment, symlink escape 방어, MCP report persistence 차단, redaction 기본 테스트 |
| Tests | unit/integration/security/MCP/install smoke 테스트 |

현재 구현의 핵심 한계도 명확하다.

| 한계 | 영향 |
|---|---|
| DB가 `files`, `symbols`, `edges` 중심 | 정책, CI, infra, endpoint 같은 entity를 자연스럽게 표현하기 어렵다. |
| analyzer 입력이 `changedFiles` 중심 | symbol, package, workflow, resource 단위 분석으로 확장하기 어렵다. |
| regex 기반 TS/JS 추출 | re-export, path alias, type-only import, call/reference를 놓친다. |
| 1-hop reverse edge 분석 | 실제 enterprise side effect를 과소 보고한다. |
| snapshot isolation 미완성 | indexing 중 completed index가 오염될 수 있다. |
| source span과 provenance 부족 | report가 왜 그런 결론을 냈는지 감사하기 어렵다. |
| resource limit 부족 | 큰 repo나 악의적 repo에서 indexing이 느려지거나 실패할 수 있다. |
| cross-repo contract model 부재 | 프로젝트 A의 API/gRPC 변경이 프로젝트 B client나 consumer를 깨뜨리는지 알기 어렵다. |

## 해결할 문제

에이전트는 코드를 읽을 수 있지만, 매번 repo를 새로 탐색한다. 그래서 다음 정보를 자주
놓친다.

1. 변경된 함수나 설정이 어떤 테스트와 배포 경로에 연결되는지
2. shell script, YAML workflow, Terraform, Kubernetes 리소스가 코드와 어떻게 연결되는지
3. 문서, policy, owner, CI job 같은 non-code 구성요소가 변경 영향에 포함되는지
4. 프로젝트 A의 API, gRPC, GraphQL, event contract 변경이 프로젝트 B의 client와 consumer를 깨뜨리는지
5. 분석이 정확한지, 추론인지, 모르는 영역인지
6. 어떤 테스트와 리뷰를 실행해야 하는지

Impact Trace는 이 문제를 cached project map으로 푼다. 프로젝트를 먼저 인덱싱하고,
변경이 들어오면 entity graph를 따라가며 영향 범위와 검증 action을 만든다.

## 범위와 비범위

### v1 범위

| 포함 | 이유 |
|---|---|
| Canonical entity/relation schema | 다중 언어와 설정 시스템을 같은 모델에 올리기 위한 기반이다. |
| Snapshot-safe indexing | 에이전트가 분석 중인 index가 중간 상태로 깨지면 안 된다. |
| Git diff 기반 분석 | 사용자가 changed file을 수동으로 넣는 MVP 표면을 넘어야 한다. |
| Tiered language adapters | TS/JS뿐 아니라 Python, Go, Rust, Java, Kotlin, C#, C, C++를 단계적으로 지원한다. |
| TypeScript semantic adapter | 첫 high-confidence lane으로 정확도를 확보한다. |
| Config/system adapters | shell, YAML, package, CI, Docker, Kubernetes, Terraform은 enterprise repo의 실제 영향 경로다. |
| Workspace catalog와 contract index | 여러 repo가 API, gRPC, event로 연결되는 enterprise 구조를 표현하기 위한 기반이다. |
| Relationship visualization export | 에이전트와 사람이 같은 영향 경로를 볼 수 있도록 Mermaid/DOT/JSON graph export를 제공한다. |
| MCP read-only resources | 큰 report와 evidence를 tool 응답 하나에 몰아넣지 않기 위해 필요하다. |
| Security/resource limits | 로컬 소스 코드는 untrusted input으로 취급해야 한다. |

### v1 비범위

| 제외 | 이유 |
|---|---|
| 필수 graph DB | source of truth를 둘로 만들면 migration과 consistency 비용이 커진다. |
| 필수 Obsidian plugin | Markdown export와 MCP 분석이 안정화된 뒤 붙이는 편이 안전하다. |
| 필수 웹 그래프 UI | 초기에는 CLI/MCP graph export를 먼저 만들고, 웹 탐색기는 projection 안정화 뒤 붙인다. |
| 에이전트의 자동 코드 수정 | Impact Trace는 추천과 evidence를 제공하고 실행은 하지 않는다. |
| 모든 언어의 full semantic analysis | 언어마다 완전한 의미 분석을 한 번에 구현하면 정확도와 일정이 무너진다. |
| cloud sync | 초기에는 source code와 secret 보호를 위해 local-first를 유지한다. |

## 목표 아키텍처

```text
                         +----------------------+
                         | Claude Code / Codex  |
                         +----------+-----------+
                                    |
                          MCP tools / resources
                                    |
+-------------+      +--------------v--------------+
| Git diff    +----->| Impact Analyzer             |
| base/head   |      | - changed entity resolver   |
+-------------+      | - bounded graph traversal   |
                     | - confidence aggregation    |
+-------------+      | - action recommendation     |
| CLI         +----->| - evidence packet builder   |
+-------------+      +--------------+--------------+
                                    |
                     +--------------v--------------+
                     | Workspace / Contract Index  |
                     | repos, APIs, gRPC, events   |
                     | producers, consumers        |
                     +--------------+--------------+
                                    |
                     +--------------v--------------+
                     | Canonical SQLite Store       |
                     | repos, workspaces            |
                     | adapter_runs, entities       |
                     | relations, evidence_spans    |
                     | reports, coverage            |
                     +--------------+--------------+
                                    |
              +---------------------+----------------------+
              |                     |                      |
 +------------v-----------+ +-------v---------+ +----------v----------+
 | Language adapters      | | System adapters | | Optional projections |
 | TS, Python, Go, Rust   | | CI, YAML, K8s   | | graph, visual, vector |
 | Java, Kotlin, C#, C/C++| | Terraform, API  | | CodeQL, Obsidian     |
 | Tree-sitter, LSP       | | contracts, events| |                     |
 +------------------------+ +-----------------+ +---------------------+
```

## Canonical 데이터 모델

v1의 핵심 작업은 file-edge store를 entity graph store로 바꾸는 것이다.

### 필수 테이블

| Table | 목적 |
|---|---|
| `repos` | repo root, remote, default branch, config hash를 저장한다. |
| `schema_versions` | migration version, 적용 시간, 실패 상태를 기록한다. |
| `workspaces` | 여러 repo를 하나의 제품/조직/배포 경계로 묶는 logical workspace를 저장한다. |
| `workspace_repos` | workspace에 속한 repo의 local path, remote, service name, trust policy를 저장한다. |
| `index_runs` | git commit, dirty state, branch, status, 시작/종료 시간, config hash를 저장한다. |
| `adapter_runs` | adapter ID, version, language/system ID, parser/tool version, config hash, error summary를 저장한다. |
| `entities` | file, symbol, package, test, doc, config, policy, workflow, resource, endpoint를 통합 저장한다. |
| `entity_versions` | entity의 content hash, location, display name, source range, index run별 상태를 저장한다. |
| `relations` | `source_entity_id`, `target_entity_id`, relation kind, confidence, adapter run을 저장한다. |
| `relation_evidence` | relation을 뒷받침하는 source span, query result, command output, confidence rationale을 저장한다. |
| `contracts` | OpenAPI, protobuf, GraphQL, AsyncAPI contract의 owner repo, service, version metadata를 저장한다. |
| `contract_versions` | contract hash, schema version, compatibility baseline, breaking-change summary를 저장한다. |
| `cross_repo_links` | repo 간 producer/consumer, client/server, topic subscriber 관계를 저장한다. |
| `index_coverage` | indexed/skipped path, unsupported language/system, parse error, size limit skip을 저장한다. |
| `reports` | versioned impact report JSON과 관련 evidence ID를 저장한다. |
| `graph_projection_runs` | 선택 graph DB projection의 source index run, schema version, invalidation 상태를 저장한다. |

### Entity 종류

| Kind | 예시 |
|---|---|
| `file` | `src/auth/session.ts`, `.github/workflows/ci.yml` |
| `symbol` | function, class, variable, method, type, interface |
| `module` | package module, Python module, Go package, Rust crate module |
| `package` | npm workspace, Python package, Maven module |
| `test` | test file, test case, CI test job |
| `doc` | README, ADR, runbook, API docs |
| `config` | JSON, YAML, TOML, env, tsconfig, package scripts |
| `policy` | CODEOWNERS, OPA/Rego rule, permission manifest |
| `workflow` | GitHub Actions job, GitLab CI job, Make target |
| `resource` | Docker image, Kubernetes deployment, Terraform resource |
| `endpoint` | REST route, GraphQL field, gRPC/protobuf service |
| `contract` | OpenAPI operation, protobuf service/method, GraphQL schema field, AsyncAPI channel |
| `event` | Kafka topic, queue message, webhook event, domain event |
| `external_entity` | workspace 밖 SaaS API, third-party service, unmanaged repo |

### Relation 종류

| Kind | 의미 |
|---|---|
| `DEPENDS_ON` | 한 entity가 다른 entity를 필요로 한다. |
| `DECLARES` | file/module entity가 symbol을 선언한다. |
| `CALLS` | 함수나 command가 다른 symbol/command를 호출한다. |
| `REFERENCES` | symbol, config key, resource name을 참조한다. |
| `VERIFIES` | test나 CI job이 entity를 검증한다. |
| `DOCUMENTS` | 문서가 entity를 설명한다. |
| `CONFIGURES` | config가 runtime, workflow, resource를 설정한다. |
| `GENERATES` | script나 build step이 artifact를 만든다. |
| `DEPLOYS` | workflow가 artifact나 resource를 배포한다. |
| `OWNS` | CODEOWNERS나 policy가 owner/review path를 지정한다. |
| `GOVERNS` | policy가 변경 허용 여부나 review requirement를 결정한다. |
| `IMPLEMENTS` | code, route handler, RPC handler가 contract를 구현한다. |
| `CONSUMES` | client, generated SDK, workflow, service가 API/RPC/event contract를 사용한다. |
| `PRODUCES` | service나 workflow가 event, artifact, API response contract를 만든다. |
| `BREAKS_COMPATIBILITY_WITH` | 변경된 contract가 기존 consumer baseline과 호환되지 않는다. |

## Adapter 전략

한 repo 안에는 여러 언어와 시스템이 공존한다. 따라서 adapter는 언어별 parser뿐 아니라
config/system/policy adapter로 나뉜다.

| Adapter | P단계 | Entity | Relation |
|---|---:|---|---|
| File classifier | P0 | file, config 후보 | languageId/systemId, skipped reason |
| Git diff adapter | P0 | changed file/entity | base/head, rename/delete/binary/untracked |
| Workspace catalog adapter | P0 | workspace, repo, service boundary | owns-repo, exposes-service, depends-on-service |
| Contract baseline adapter | P0 | contract, endpoint, event | implements, consumes, produces |
| TypeScript Compiler API | P1 | symbol, module, package | imports, re-exports, references, calls |
| Python adapter | P1 | module, function, class, package | imports, references, calls |
| Go adapter | P1 | package, function, method, interface | imports, references, calls |
| Rust adapter | P1 | crate, module, function, trait, impl | uses, references, calls |
| Package/workspace adapter | P1 | package, script, workspace | depends-on, verifies, generates |
| JVM adapter | P2 | Java/Kotlin package, class, method, field, annotation | imports, references, calls, implements |
| .NET adapter | P2 | C# namespace, class, method, property, project | references, calls, project dependency |
| Native adapter | P2 | C/C++ translation unit, function, type, macro, target | includes, references, calls, build target |
| Build-system adapter | P1/P2 | npm, pip, cargo, Maven, Gradle, dotnet, CMake, Make, Bazel target | depends-on, verifies, generates |
| Shell/Make adapter | P1 | script, command, target | calls, generates, configures |
| YAML/JSON/TOML adapter | P1 | config, workflow, resource | configures, references |
| GitHub Actions/GitLab CI adapter | P1 | workflow, job, step | verifies, deploys, calls |
| Docker/Kubernetes adapter | P1 | image, service, deployment, secret ref | configures, deploys, routes-to |
| Terraform adapter | P1 | module, variable, resource | depends-on, configures |
| OpenAPI/GraphQL/protobuf/AsyncAPI adapter | P1 | endpoint, schema field, service, event | implements, consumes, produces, documents |
| Cross-repo resolver | P1 | external_entity, cross_repo_link | contract producer/consumer, SDK import, base URL, topic subscriber |
| Markdown/ADR adapter | P1 | doc, decision | documents, references |
| CODEOWNERS/policy adapter | P1 | owner rule, policy rule | owns, governs, requires-review |
| Tree-sitter fallback | P2 | broad symbol/module | declares, imports, references |
| LSP adapter | P2 | symbol/reference/call hierarchy | definition, references, calls |
| CodeQL adapter | P2 | data-flow/control-flow node | taints, controls, calls |

언어별 adapter는 한 번에 full semantic analysis를 목표로 하지 않는다. P1에서는 프로젝트
구조, import/reference/call, test/build target을 안정적으로 잡고, P2에서 LSP, CodeQL,
빌드 시스템 정보를 붙여 정확도를 올린다.

## 분석 흐름

```text
git diff or changed input
  -> changed paths, deleted paths, renamed paths, changed ranges
  -> EntityRef 후보로 정규화
  -> 최신 completed index_run_id와 freshness 확인
  -> workspace catalog에서 관련 repo와 service boundary 확인
  -> contract/entity 변경이면 producer와 consumer repo 후보 확인
  -> changed entity를 relation graph에 매핑
  -> bounded reverse traversal
  -> package/workflow/resource/workspace boundary 반영
  -> affected targets와 confidence 계산
  -> evidence span과 coverage gap 수집
  -> test/review/docs/deploy action 추천
  -> CLI summary, JSON report, graph export, MCP resource 반환
```

### Traversal 규칙

| 규칙 | 이유 |
|---|---|
| 기본은 bounded traversal | 큰 repo에서 fan-out 폭발을 막는다. |
| cycle detection 필수 | package와 workflow graph는 쉽게 순환한다. |
| fan-out warning 제공 | 너무 넓은 영향 범위는 요약과 group-by가 필요하다. |
| confidence aggregation | proven relation과 heuristic relation을 같은 무게로 보지 않는다. |
| coverage gap 포함 | adapter가 없어서 못 본 영역을 report가 말해야 한다. |

## 연관성 시각화

시각화는 분석 정확도의 원천이 아니라 사람이 이해하기 위한 projection이다. 원본 데이터는
항상 SQLite의 `entities`, `relations`, `relation_evidence`에 남고, 화면이나 그래프
파일은 특정 report, workspace, entity 범위에서 다시 생성한다.

| 표면 | 단계 | 설명 |
|---|---:|---|
| Mermaid export | P1 | PR 설명, Markdown report, Obsidian note에 붙일 수 있는 작은 영향 그래프를 만든다. |
| DOT/Graphviz export | P1 | 큰 그래프를 레이아웃하거나 CI artifact로 저장할 수 있게 한다. |
| JSON graph export | P1 | 웹 UI, D3, Cytoscape, Gephi 같은 외부 도구가 읽을 수 있는 안정 contract다. |
| MCP graph resource | P3 | 에이전트가 `impact://graph/{id}`로 관계 그래프를 페이지 단위로 읽는다. |
| Web graph explorer | P4 | entity, repo, contract, confidence, coverage gap을 필터링하는 선택 UI다. |

시각화 기본 필터는 `changed`, `affected`, `tests`, `deploy`, `contract`, `unknown` 그룹이다.
edge는 relation kind와 confidence로 색/두께를 구분하고, secret-like evidence는 표시하지
않는다.

## MCP와 CLI 계약

### CLI

```bash
impact-trace init
impact-trace index
impact-trace workspace init
impact-trace workspace index
impact-trace analyze --base origin/main --head HEAD
impact-trace analyze --workspace --base origin/main --head HEAD
impact-trace analyze --changed src/file.ts --json
impact-trace graph export --report <id> --format mermaid
impact-trace graph export --entity impact://entity/{id} --depth 2 --format json
impact-trace explain impact://entity/{id}
impact-trace mcp serve
```

### MCP tools

| Tool | 상태 | 설명 |
|---|---|---|
| `impact_trace_analyze_diff` | MVP | changed files를 분석한다. |
| `impact_trace_analyze_git_diff` | P0 | base/head 기준으로 변경 entity를 계산한다. |
| `impact_trace_explain_entity` | P1 | 특정 entity의 relation과 evidence를 설명한다. |
| `impact_trace_analyze_workspace_diff` | P3 | 여러 repo의 diff와 contract consumer 영향을 분석한다. |
| `impact_trace_get_graph` | P3 | report/entity/workspace 범위의 관계 그래프 resource URI를 반환한다. |

### MCP resources

| URI | 상태 | 설명 |
|---|---|---|
| `impact://report/{id}` | P1 | 전체 report를 pagination 가능한 resource로 노출한다. |
| `impact://evidence/{id}` | P1 | redacted evidence span과 provenance를 노출한다. |
| `impact://entity/{id}` | P1 | entity metadata와 direct relations를 노출한다. |
| `impact://coverage/{indexRunId}` | P1 | missing adapter와 skipped file을 노출한다. |
| `impact://workspace/{id}` | P3 | workspace repo/service catalog와 coverage를 노출한다. |
| `impact://contract/{id}` | P3 | contract version, producer, consumer, compatibility evidence를 노출한다. |
| `impact://graph/{id}` | P3 | 시각화용 graph nodes/edges, filters, legend를 pagination으로 노출한다. |

MCP tool 응답은 작고 agent-friendly해야 한다. 큰 report는 resource로 분리한다.

## 보안과 신뢰 경계

Impact Trace는 로컬 repo를 읽지만 repo content를 신뢰하지 않는다.

| 위험 | 대응 |
|---|---|
| path traversal | 모든 file input은 root containment를 통과해야 한다. |
| symlink escape | realpath 검증과 symlink 정책 테스트를 유지한다. |
| TOCTOU(확인과 실행 사이의 틈) | 검증 후 다시 여는 read/write 경로를 줄이고 atomic open 전략을 설계한다. |
| partial index read | completed snapshot과 running snapshot을 분리한다. |
| secret leakage | 저장 전 redaction, denylisted path, binary detection, sensitivity classification을 둔다. |
| oversized repo DoS | file count, file size, depth, binary, timeout limit을 둔다. |
| command execution | MCP는 command를 실행하지 않는다. action은 구조화된 추천으로만 반환한다. |
| cross-repo traversal | workspace allowlist에 등록된 repo만 읽고, 임의 remote clone이나 network call은 하지 않는다. |
| external contract | third-party API는 local contract/spec 파일이나 사용자가 제공한 snapshot만 신뢰한다. |
| visualization leakage | graph label과 tooltip에는 redacted display name과 provenance summary만 넣는다. |
| future write tools | capability object로 repo read, vault write, command execute를 분리한다. |

## 테스트와 품질 게이트

| Gate | v1 기준 |
|---|---:|
| golden fixture affected-entity recall | >= 90% |
| critical false negative | 0 |
| test action precision | >= 70% |
| stale-index detection | fixture 100% |
| secret leak | planted secret 0건 |
| MCP read-only mutation | 0건 |
| unsupported coverage reporting | fixture 100% |
| graph export determinism | fixture 100% |

필수 fixture repo:

| Fixture | 포함할 내용 |
|---|---|
| TS package | re-export, default export, type-only import, path alias |
| JVM repo | Java, Kotlin, Maven, Gradle, annotation, test source set |
| .NET repo | C#, solution/project reference, NuGet package, test project |
| native repo | C, C++, header include, CMake/Make/Bazel target |
| mixed-language repo | TS, Python, Go, Rust, Java, Kotlin, C#, C/C++, shell, YAML, Dockerfile, Markdown |
| CI/infra repo | GitHub Actions, Docker, Kubernetes, Terraform |
| monorepo | workspaces, package boundary, package-level tests |
| workspace contract repo | provider repo, consumer repo, OpenAPI/protobuf/GraphQL/AsyncAPI contract |
| event-driven repo | producer service, consumer service, queue/topic schema |
| graph visualization repo | changed/affected/test/deploy/contract relation을 Mermaid/DOT/JSON으로 검증 |
| security repo | `.env`, Kubernetes Secret, Terraform vars, PEM, token-like content |
| stale-index repo | running index와 completed index 충돌 시나리오 |
| delete/rename repo | deleted file, renamed file, binary file, generated file |

## 단계별 로드맵

### P0: Entity Graph Core

목표: 다중 언어와 설정 시스템을 올릴 수 있는 저장소 기반을 만든다.

| 작업 | 완료 기준 |
|---|---|
| migration runner 도입 | schema version, failed migration, compatibility check가 있다. |
| `entities`/`relations`/`relation_evidence` 추가 | file/symbol/import edge가 새 모델에도 저장된다. |
| `adapter_runs`/`index_coverage` 저장 | adapter metadata와 skipped reason이 DB와 report에 남는다. |
| snapshot isolation 수정 | running index가 latest completed index를 오염시키지 않는다. |
| 성능 index 추가 | reverse traversal hot query가 index를 사용한다. |
| report versioning | `reportVersion`, `schemaVersion`, repo/index/diff metadata가 포함된다. |
| resource limits | oversized/binary/deep tree가 skip으로 기록된다. |
| git diff input | `--base`, `--head`, rename/delete/untracked를 처리한다. |
| workspace catalog schema | repo-local index를 유지하면서 여러 repo를 하나의 workspace로 묶을 수 있다. |
| contract entity baseline | OpenAPI/protobuf/GraphQL/AsyncAPI 파일이 `contract`, `endpoint`, `event` entity로 저장된다. |

### P1: Mixed Repo Adapter Pack

목표: 실제 enterprise repo의 code, config, workflow, infra 경계를 연결한다.

| 작업 | 완료 기준 |
|---|---|
| TypeScript semantic adapter | compiler API로 export/import/re-export/path alias/source span을 추출한다. |
| Python/Go/Rust adapter | package/module/symbol/import/reference relation을 추출한다. |
| package/workspace adapter | npm/pnpm/yarn/bun workspace와 scripts/test runner를 추출한다. |
| shell/Make adapter | command와 generated artifact relation을 추출한다. |
| YAML/JSON/TOML adapter | config key와 referenced path/resource를 추출한다. |
| CI adapter | workflow, job, step, test/deploy action을 추출한다. |
| Docker/Kubernetes/Terraform adapter | deployment/resource/config relation을 추출한다. |
| OpenAPI/protobuf/GraphQL/AsyncAPI adapter | endpoint/service/event contract와 handler/client relation을 추출한다. |
| cross-repo resolver | API/gRPC/event producer 변경이 consumer repo와 generated SDK import에 연결된다. |
| compatibility analyzer | contract diff가 breaking/non-breaking/unknown으로 분류된다. |
| Markdown/CODEOWNERS/policy adapter | docs/owner/policy relation을 추출한다. |
| graph export | report/entity 범위의 Mermaid, DOT, JSON graph가 deterministic하게 생성된다. |
| recursive traversal | multi-hop impact와 fan-out warning을 제공한다. |

### P2: Enterprise Language Adapter Pack

목표: JVM, .NET, native codebase까지 enterprise 언어 범위를 넓힌다.

| 작업 | 완료 기준 |
|---|---|
| Java/Kotlin adapter | Maven/Gradle module, package/class/method, annotation, test source set relation을 추출한다. |
| C#/.NET adapter | solution/project reference, namespace/class/method/property, NuGet relation을 추출한다. |
| C/C++ adapter | header include, function/type/macro, compile target, generated source relation을 추출한다. |
| build-system resolver | Maven, Gradle, dotnet, CMake, Bazel, Make target이 test/build/deploy action과 연결된다. |
| LSP/CodeQL enrichment | supported language에서 reference/call/data-flow evidence를 보강한다. |

### P3: Agent-Ready MCP

목표: Claude Code와 Codex가 큰 report를 안전하게 읽고 action을 선택할 수 있게 한다.

| 작업 | 완료 기준 |
|---|---|
| MCP report/evidence/entity resources | 큰 payload를 pagination으로 읽을 수 있다. |
| MCP workspace/contract resources | repo catalog와 contract impact를 resource로 읽을 수 있다. |
| MCP graph resource | 큰 관계 그래프를 pagination과 filter metadata로 읽을 수 있다. |
| workspace diff tool | 여러 repo의 changed entity와 downstream consumer risk를 요약한다. |
| compact tool response | tool은 summary와 resource URI를 반환한다. |
| explain command | entity 하나의 relation과 evidence를 설명한다. |
| action provider | npm 외 CI/job/docs/owner review action을 추천한다. |
| typed error envelope | problem, cause, fix, evidence ID를 포함한다. |
| stale-index warning | agent가 낡은 index를 보고 있다는 사실을 즉시 알 수 있다. |

### P4: Optional Projections and Human Memory

목표: core가 안정화된 뒤 선택 기능을 붙인다.

| 작업 | 완료 기준 |
|---|---|
| graph DB projection | SQLite source index run에서 파생되고 invalidation policy가 있다. |
| web graph explorer | entity/relation/workspace/contract를 confidence와 coverage 기준으로 필터링한다. |
| CodeQL adapter | supported language에서 data/control-flow evidence를 추가한다. |
| vector/search adapter | 유사 코드와 문서 검색을 보조한다. |
| Obsidian dry-run export | managed note, conflict handling, symlink guard가 있다. |
| hotspot/history analytics | churn, co-change, owner, failure history를 report에 반영한다. |

## 부족한 점

| 부족한 점 | 심각도 | 해결 단계 |
|---|---:|---|
| file-centric schema | High | P0 |
| running index가 completed snapshot을 오염시킬 수 있음 | High | P0 |
| TOCTOU read/write gap | High | P0 |
| source span/provenance 부족 | High | P0 |
| git diff/stale-index 부재 | High | P0 |
| cross-repo workspace/contract model 부재 | High | P0/P1 |
| regex TS/JS extraction | High | P1 |
| Java/Kotlin/C# adapter 부재 | High | P2 |
| C/C++와 build-system relation 부재 | High | P2 |
| shell/YAML/infra/policy adapter 부재 | High | P1 |
| relation visualization export 부재 | Medium | P1/P3 |
| MCP resource 부재 | Medium | P3 |
| action provider가 npm에 고정됨 | Medium | P3 |
| open-source release automation 부재 | Medium | P3 |

## 의사결정 기록

| 결정 | 이유 | 거절한 대안 |
|---|---|---|
| graph DB를 core로 두지 않는다. | 초기 설치와 migration을 단순하게 유지한다. | Neo4j/FalkorDB/Kuzu를 필수 runtime으로 둔다. |
| SQLite에 entity graph를 저장한다. | local-first, 가벼운 설치, 테스트 가능성이 좋다. | graph DB를 source of truth로 둔다. |
| 언어 adapter는 tier 방식으로 확장한다. | TS/JS, Python, Go, Rust 뒤에 Java, Kotlin, C#, C, C++까지 같은 모델에 올린다. | 한 언어의 full semantic analysis만 먼저 완성한다. |
| 다중 언어보다 다중 system model을 먼저 잡는다. | 실제 repo는 언어와 YAML/shell/infra/policy가 섞인다. | TypeScript semantic adapter부터 깊게 구현한다. |
| repo-local DB를 유지하되 workspace catalog를 추가한다. | 단일 repo 사용성을 유지하면서 multi-repo API/gRPC/event impact로 확장한다. | 처음부터 중앙 서버나 필수 graph DB를 둔다. |
| MCP는 read-only부터 안정화한다. | agent integration에서 파일 쓰기와 command 실행은 위험하다. | Obsidian/write tool을 먼저 추가한다. |
| adapter는 metadata와 coverage를 반드시 남긴다. | 누락된 분석을 숨기면 에이전트가 잘못된 확신을 가진다. | adapter 실패를 조용히 무시한다. |
| command는 실행하지 않고 action으로 추천한다. | repo-controlled 문자열이 실행 경로가 되면 위험하다. | shell command string을 그대로 반환한다. |

## 승인 기준

이 계획은 다음 상태가 되면 v1 방향으로 승인한다.

1. P0 schema와 migration이 구현되어 기존 MVP report가 계속 동작한다.
2. 최소 mixed-language fixture가 `file`, `symbol`, `config`, `workflow`, `resource`, `policy` entity를 만든다.
3. Java/Kotlin, C#, C/C++ fixture가 module/project/build target relation을 만든다.
4. workspace contract fixture가 provider repo와 consumer repo 사이의 API/gRPC/event relation을 만든다.
5. `analyze --base --head`가 changed entity와 affected entity를 반환한다.
6. graph export가 같은 report에서 deterministic Mermaid/JSON graph를 만든다.
7. MCP read-only tool이 report resource URI와 compact summary를 반환한다.
8. security fixture에서 raw secret leak이 0건이다.
9. missing adapter와 skipped file이 report에 명확히 표시된다.
