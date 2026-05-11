# 커밋 분석

**Date:** 2026-05-12 02:22:45 KST
**Branch:** feature/phase6w-graphql-contract-diff-v0

## 변경 파일

| File | Changes |
| --- | --- |
| `src/graphql_compat.ts` | `extractGraphqlCompatibility`를 추가해 GraphQL SDL(schema definition language)에서 root operation, object field, input field signature를 compact JSON으로 만들고 raw SDL 저장 없이 contract baseline을 비교할 수 있게 구현 |
| `src/adapters/multi-language-regex.ts` | `contractMetadataForFile`과 `extractGraphqlEndpoints`가 GraphQL compatibility signature를 재사용하게 바꿔 index baseline과 endpoint evidence가 같은 parser 결과를 공유하도록 정리 |
| `src/contract_diff.ts` | `parseCurrentContractByKind`와 GraphQL classifier를 추가해 indexed baseline과 current `.graphql`/`.gql` 파일을 비교하고 removed root field, response object change, required input change를 breaking으로 분류 |
| `tests/contract-diff.test.ts` | GraphQL fixture와 8개 focused test를 추가해 root field removal, response type/removal, required/defaulted input, required flag regression, nested object traversal이 회귀하지 않도록 고정 |
| `README.md` | 현재 상태와 roadmap에 GraphQL contract diff v0 landed 상태를 반영해 사용자가 다음 작업을 AsyncAPI와 consumer resolver로 읽을 수 있게 갱신 |
| `CHANGELOG.md` | Phase highlights에 `graphql-compat-v0` 추가를 기록해 release note에서 GraphQL schema diff 범위와 non-dependency 원칙을 확인할 수 있게 정리 |
| `docs/README.md` | 문서 인덱스의 최신 상태와 ADR 범위를 D-034로 올려 새 contributor가 GraphQL landed 문서를 바로 찾을 수 있게 갱신 |
| `docs/decisions.ko.md` | D-034를 추가해 compact GraphQL signature 결정, 거부한 Hive/Inspector/runtime dependency, v0 제한과 다음 AsyncAPI 범위를 보존 |
| `docs/roadmap.md` | A6와 active next 항목을 GraphQL landed, AsyncAPI/GraphQL consumer resolver next로 바꿔 다음 실행 순서를 문서화 |
| `docs/progress.ko.md` | 2026-05-12 진행 로그에 GraphQL contract diff v0를 추가해 날짜별 작업 이력이 Protobuf 이후 흐름과 맞게 연결 |
| `docs/phase6b-ts-accuracy-plan.ko.md` | Phase 6B 상태와 completed slice 설명에 GraphQL diff를 포함해 product plan의 완료/제외 범위를 현재 코드와 맞춤 |
| `docs/phase6-design.ko.md` | Phase 6/6B 진행 문서에 GraphQL landed와 다음 AsyncAPI/consumer resolver를 반영해 legacy next-action 문구를 정리 |
| `docs/impact-context-layer-plan.ko.md` | GraphQL Inspector 참고 범위를 실제 채택한 compact signature rule로 좁히고 Phase E contract impact 표를 현재 구현과 맞춤 |
| `docs/agentmemory-adoption-review.ko.md` | pattern adoption 상태표에 GraphQL diff를 landed로 추가해 agentmemory 기반 context 절감 로드맵과 contract impact 상태를 동기화 |

## 커밋 메시지

feat(contracts): GraphQL contract diff 추가

- `extractGraphqlCompatibility`가 GraphQL SDL에서 compact signature를 만들어 raw schema 저장 없이 root operation, object field, input field baseline을 비교
- `workspace contract-diff`가 `.graphql`/`.gql` 변경을 읽어 removed root field, response object field change, required argument/input change를 breaking으로 분류
- GraphQL focused tests가 defaulted non-null input, required flag regression, nested response object traversal을 검증해 false negative를 줄임
- README, roadmap, progress, Phase 문서와 D-034 decision record를 GraphQL landed 및 다음 AsyncAPI/consumer resolver scope에 맞게 갱신

## 명령어

```bash
git commit -m "feat(contracts): GraphQL contract diff 추가

- extractGraphqlCompatibility가 GraphQL SDL에서 compact signature를 만들어 raw schema 저장 없이 root operation, object field, input field baseline을 비교
- workspace contract-diff가 .graphql/.gql 변경을 읽어 removed root field, response object field change, required argument/input change를 breaking으로 분류
- GraphQL focused tests가 defaulted non-null input, required flag regression, nested response object traversal을 검증해 false negative를 줄임
- README, roadmap, progress, Phase 문서와 D-034 decision record를 GraphQL landed 및 다음 AsyncAPI/consumer resolver scope에 맞게 갱신"
```

## 분석

- **Type:** `feat` - GraphQL contract diff라는 새 사용자 기능을 추가
- **Scope:** `contracts` - contract baseline/diff/classifier와 관련 문서가 중심
- **Files:** 15
- **Lines:** +1225/-85
