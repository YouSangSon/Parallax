# Impact Trace 인덱싱 모델

영어 버전: [indexing-model.en.md](indexing-model.en.md)

## 목표

Impact Trace의 인덱싱 모델은 한 repo 안의 여러 언어와 여러 시스템 설정을 같은
영향도 그래프로 표현한다. 파일은 시작점일 뿐이다. 최종 분석 단위는 함수, 변수,
클래스, 모듈, package, shell command, YAML workflow, Kubernetes resource, Terraform
resource, policy rule, 문서, 테스트 같은 `Entity`다.

## 핵심 용어

| 용어 | 뜻 | 왜 중요한가 |
|---|---|---|
| Entity | 변경되거나 영향을 받을 수 있는 대상 | 파일뿐 아니라 symbol, workflow, resource, policy도 분석 대상이 된다. |
| Relation | entity 사이의 방향성 있는 연결 | 변경 영향이 어떤 경로로 전파되는지 설명한다. |
| Evidence | relation을 믿을 수 있는 근거 | 에이전트가 추측이 아니라 증거를 보고 판단한다. |
| Adapter | 특정 언어/시스템에서 entity와 relation을 추출하는 모듈 | TS, shell, YAML, CI, Terraform을 독립적으로 확장할 수 있다. |
| Coverage | 무엇을 읽었고 무엇을 건너뛰었는지 | 모르는 영역을 숨기지 않는다. |
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

## Entity ID 원칙

Entity ID는 deterministic해야 한다. 같은 repo와 같은 index input이면 항상 같은 ID가
나와야 report 비교와 graph projection이 가능하다.

| Entity | ID 예시 |
|---|---|
| File | `file:src/auth/session.ts` |
| Symbol | `symbol:typescript:src/auth/session.ts#function:validateSession` |
| Package | `package:npm:apps/web` |
| CI job | `workflow:github-actions:.github/workflows/ci.yml#job:test` |
| Kubernetes resource | `resource:kubernetes:apps/api/deployment/api` |
| Terraform resource | `resource:terraform:aws_lambda_function.auth_handler` |
| Policy rule | `policy:codeowners:/src/auth/*` |

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
| Config/system | YAML, JSON, TOML, shell, Docker, Kubernetes, Terraform, CI를 읽는다. |
| Policy/governance | CODEOWNERS, OPA/Rego, permission manifest를 읽는다. |
| Action provider | test/review/docs/deploy action을 추천한다. |
| Projection | SQLite entity graph를 graph DB, vector DB, Obsidian으로 파생한다. |

## 저장 모델 요구사항

| 요구사항 | 이유 |
|---|---|
| `entities`와 `relations`가 canonical이어야 한다. | graph DB 없이도 범용 영향도 분석을 할 수 있다. |
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
| `actions` | 테스트, 리뷰, 문서, 배포 확인 추천 |
| `evidence` | redacted source span과 provenance |
| `coverage` | missing adapter, skipped file, parse error |

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

