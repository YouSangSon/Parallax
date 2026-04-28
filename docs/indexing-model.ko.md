# Impact Trace 인덱싱 모델

영어 버전: [indexing-model.en.md](indexing-model.en.md)

## 목표

Impact Trace의 핵심은 엔터프라이즈 코드베이스의 구성요소를 서로 연결해서 인덱싱하는
것이다. 파일만 추적하는 도구가 아니라 함수, 변수, 클래스, 모듈, 테스트, 문서,
정책, 설정, 배포 리소스까지 하나의 영향도 그래프로 다룬다.

그래프 DB는 필수가 아니다. 현재 canonical store는 SQLite이고, graph DB는 필요해질
때 SQLite의 entity/relation 데이터를 projection하는 선택 adapter다.

## 핵심 개념

| 개념 | 의미 | 예시 |
|---|---|---|
| Entity | 변경되거나 영향을 받을 수 있는 대상 | file, symbol, module, test, doc, config, policy |
| Relation | entity 사이의 관계 | depends-on, calls, verifies, documents, configures, generates |
| Evidence | relation을 믿을 수 있는 근거 | source snippet, import edge, test import, doc mention |
| Action | 변경 후 해야 할 검증/리뷰 | test command, policy review, owner review |
| Adapter | 특정 언어나 시스템에서 entity/relation을 추출하는 모듈 | TypeScript, Python, Go, Terraform, Kubernetes, OpenAPI |

## 현재 MVP

현재 내장 adapter는 TS/JS/Markdown 중심이다.

| 대상 | 현재 상태 |
|---|---|
| TypeScript/JavaScript file | 인덱싱됨 |
| TS/JS export symbol | 정규식 기반 추출 |
| TS/JS import relation | 상대 import 기반 추출 |
| test relation | import/name 기반 추론 |
| Markdown doc relation | 파일명 mention 기반 추론 |
| policy/config relation | 아직 adapter 없음 |

중요한 점은 공개 report model이 이미 언어 중립 구조를 가진다는 것이다.

- `changed`: 변경된 `EntityRef`
- `affected`: 영향받는 `ImpactTarget`
- `actions`: 실행/리뷰 추천을 나타내는 `ImpactAction`
- `evidence`: relation과 판단 근거
- `testCommands`: 이전 caller 호환용 deprecated alias

## 엔터프라이즈 확장 방향

다음 adapter를 추가하면 같은 모델로 더 넓은 구성요소를 인덱싱할 수 있다.

| Adapter | Entity | Relation |
|---|---|---|
| Tree-sitter | file, symbol, module | depends-on, calls, declares |
| LSP | symbol, module | references, definition, call hierarchy |
| CodeQL | symbol, data-flow node | calls, taints, controls |
| Terraform | resource, module, variable | configures, depends-on |
| Kubernetes | deployment, service, configmap, secret ref | configures, routes-to |
| OpenAPI/GraphQL | endpoint, schema field, resolver | implements, consumes |
| CI/CD | job, workflow, artifact | verifies, deploys, generates |
| Policy-as-code | rule, package, control | governs, denies, requires-review |

## 분석 흐름

```text
changed input
  -> EntityRef로 정규화
  -> 최신 completed index_run_id 선택
  -> reverse relation traversal
  -> affected target 계산
  -> evidence 수집과 redaction
  -> structured action 추천
  -> CLI/MCP/Markdown report 반환
```

## 설계 원칙

- 분석 결과는 증거와 confidence를 함께 가져야 한다.
- 모르는 것은 숨기지 않고 `unknown` 또는 coverage gap으로 드러낸다.
- MCP는 MVP에서 read-only이며 command를 실행하지 않는다.
- command 추천은 문자열이 아니라 `command`와 `args` 구조를 우선한다.
- 언어별 세부 구현은 adapter 안에 두고, report model은 언어 중립으로 유지한다.

