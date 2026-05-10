# Impact Trace 테스트 계획

생성일: 2026-04-28

## 목표

테스트의 목적은 Impact Trace가 "그럴듯한 report"가 아니라 증거 기반 영향도 분석을
안전하게 제공하는지 검증하는 것이다. 특히 한 repo 안에 여러 언어, shell script,
YAML, CI, infra, policy가 섞인 상황과 여러 repo가 API/gRPC/event contract로 연결된
상황을 기본 fixture로 다룬다.

## 테스트 피라미드

```text
unit
  -> path/security/redaction/schema/adapter parser
integration
  -> fixture repo indexing and analysis
contract
  -> CLI JSON, MCP tool/resource, report schema
accuracy
  -> golden diff recall/precision
security
  -> secret leak, path escape, read-only mutation, resource limit
```

## Unit Tests

| 영역 | 필수 테스트 |
|---|---|
| Path safety | repo root 밖 path, absolute path, symlink escape, internal symlink 허용 정책 |
| TOCTOU | 확인 후 파일/디렉터리 swap 시 읽기와 쓰기가 안전하게 실패해야 한다. |
| Redaction | OpenAI/GitHub/Slack/AWS/JWT/Bearer/PEM/env/Kubernetes Secret/Terraform vars |
| Resource limits | oversized file, binary file, deep tree, high file count, timeout |
| Migration runner | schema version, failed migration, compatibility check |
| Entity IDs | 같은 입력에서 deterministic ID 생성 |
| Relation model | source/target entity, kind, confidence, adapter run, evidence 연결 |
| Language adapter contract | TS/JS, Python, Go, Rust, Java/Kotlin, C#, C/C++ adapter가 같은 entity/relation shape를 반환 |
| Workspace contract model | provider/consumer repo, contract version, cross-repo link ID가 deterministic |
| Work artifact model | PRD/사업계획서/회의록/KPI/customer artifact ID와 relation이 deterministic |
| Adapter coverage | unsupported language/system, skipped reason, parse error |
| Git diff parser | rename, delete, untracked, binary, changed ranges, merge-base |
| Graph export model | Mermaid/DOT/JSON output이 deterministic하고 secret-like label을 포함하지 않음 |
| Action rendering | command와 args는 구조화되고 display는 non-authoritative여야 한다. |

## Integration Fixture Matrix

| Fixture | 포함할 파일 | 검증할 것 |
|---|---|---|
| TS semantic | TS/JS, `tsconfig`, path alias, re-export | symbol/import/reference/call relation |
| Python/Go/Rust | Python package, Go module, Rust crate | module/package/import/reference relation |
| JVM | Java, Kotlin, Maven, Gradle, annotation, test source set | package/class/method/build/test relation |
| .NET | C#, solution, project reference, NuGet, test project | namespace/class/method/project dependency relation |
| Native | C, C++, header, macro, CMake/Make/Bazel target | include/reference/build target relation |
| Mixed language | TS, Python, Go, Rust, Java, Kotlin, C#, C/C++, shell, YAML, Markdown | 여러 adapter의 coverage와 relation merge |
| CI workflow | GitHub Actions, package scripts, shell step | workflow/job/step/test action relation |
| Infra | Dockerfile, Compose, Kubernetes YAML, Terraform | configures/deploys/resource relation |
| API contract | OpenAPI, GraphQL, route handler | endpoint와 구현체 연결 |
| gRPC contract | protobuf, service implementation, generated client | RPC method와 provider/consumer 연결 |
| Workspace contract | provider repo, consumer repo, OpenAPI/protobuf/GraphQL/AsyncAPI | cross-repo producer/consumer 영향 |
| Company work artifact | PRD, 사업계획서, 회의록, KPI, 고객 문서 | 요구사항/결정/고객 영향이 코드 entity로 연결됨 |
| Event contract | topic/channel schema, producer, subscriber | event producer/consumer 영향 |
| Graph visualization | changed/affected/test/deploy/contract relation | Mermaid/DOT/JSON graph export |
| Policy | CODEOWNERS, OPA/Rego, permission config | owns/governs/requires-review relation |
| Monorepo | npm/pnpm/yarn/bun workspace | package boundary와 package-level action |
| Secret fixture | `.env`, K8s Secret, token-like text, PEM | SQLite/MCP/Markdown raw leak 0건 |
| Snapshot fixture | indexing 중 analyze/MCP read | completed index만 읽음 |
| Delete/rename fixture | deleted, renamed, generated, binary file | stale edge와 deleted target 처리 |

## Contract Tests

| 표면 | 검증 |
|---|---|
| CLI human output | 짧은 summary, affected count, report path |
| CLI JSON | `reportVersion`, `schemaVersion`, `repo`, `workspace`, `diff`, `changed`, `affected`, `actions`, `evidence`, `coverage`, `graph` |
| Exit codes | `0` clean, `1` findings/risk, `2` user/config error, `3` internal error |
| MCP tools | read-only annotation, compact response, deterministic errors |
| MCP resources | `impact-trace://reports/{id}`, `impact-trace://entities/{id}`, `impact-trace://reports/{id}/graph/{format}`, `impact-trace://coverage/latest`, pagination, not found error |
| Graph export | Mermaid/DOT/JSON schema, stable node IDs, relation legend, confidence metadata |
| Report compatibility | deprecated field와 새 field가 migration 기간에 함께 유지됨 |

## Security Tests

| 위험 | 테스트 |
|---|---|
| path traversal | `../`, absolute path, encoded path, symlink path |
| TOCTOU | validation 후 symlink swap, `.impact-trace` swap, report dir swap |
| secret leakage | SQLite table, Markdown report, MCP response 모두 검사 |
| resource exhaustion | file size/count/depth/time limit 초과 시 skip coverage |
| read-only MCP | uninitialized repo에서 workspace 생성 금지, initialized repo에서 reports/sidecar 생성 금지 |
| command execution | action은 실행되지 않고 allowlisted runner 없이 executable state가 되지 않음 |
| cross-repo traversal | workspace allowlist 밖 repo나 remote URL을 자동으로 읽거나 clone하지 않음 |
| graph leakage | graph label, tooltip, JSON node metadata에 raw secret/source snippet이 들어가지 않음 |
| prompt injection | repo content는 evidence로만 표시되고 지시문으로 해석하지 않음 |

## 정확도 게이트

| Metric | v1 Gate |
|---|---:|
| affected-entity recall | >= 90% |
| critical false negative | 0 |
| test action precision | >= 70% |
| stale-index detection | fixture 100% |
| secret leak | 0 |
| unsupported coverage reporting | fixture 100% |
| MCP read-only mutation | 0 |
| cross-repo contract recall | >= 85% |
| graph export determinism | fixture 100% |

## E2E 시나리오

1. mixed-language fixture에서 `impact-trace init`을 실행한다.
2. `impact-trace index`가 entity, relation, evidence, coverage를 저장한다.
3. `impact-trace analyze --base main --head feature --json`이 changed/affected entity를 반환한다.
4. workspace fixture에서 provider contract 변경이 consumer repo의 affected entity로 이어진다.
5. graph export가 같은 report에서 deterministic Mermaid/JSON/DOT graph를 만든다.
6. MCP client가 같은 report를 compact response와 resource URI로 읽는다.
7. report에 missing adapter, skipped file, stale-index warning, confidence가 포함된다.
8. 회사 업무 artifact fixture에서 PRD/회의록/고객 문서가 요구사항과 코드 entity로 연결된다.
9. security fixture에서 raw secret이 SQLite, Markdown, MCP, graph export 어디에도 나오지 않는다.

## 회귀 규칙

impact traversal 버그는 수정 전에 fixture diff를 추가한다. security boundary 버그는
수정 전에 failing security test를 추가한다. adapter 정확도 버그는 golden fixture에
relation expected output을 추가한다.

## Verification Commands

```bash
npm test
npm run lint
npm run check
npm run test:fixtures
npm run test:security
npm run test:mcp
npm run test:benchmark
npm run test:install-smoke
npm audit --audit-level=high
npm run docs:lint
```
