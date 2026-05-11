# Commit Message 제안 — OpenAPI contract impact baseline

## 변경 요약

| 파일 | 내용 |
|---|---|
| `src/adapters/multi-language-regex.ts` | OpenAPI/Swagger/AsyncAPI, protobuf, GraphQL contract endpoint extraction과 explicit path 기반 구현자 reverse-link를 추가 |
| `src/indexer.ts` | 기존 `contracts` / `contract_versions` 테이블에 contract baseline과 raw file hash 기반 version을 저장 |
| `src/analyzer.ts` | OpenAPI/Swagger/AsyncAPI YAML/JSON path를 `contract` entity로 분류 |
| `bench/impact-bench.ts`, `tests/impact-bench.test.ts` | OpenAPI contract expected relation 3개와 contract-sourced `DECLARES` precision gate를 추가 |
| `tests/impact-trace.test.ts` | OpenAPI/Swagger baseline, JSON endpoint evidence, placeholder guard, contract 변경 → 구현 코드 impact 회귀 테스트 추가 |
| docs / README / CHANGELOG | D-025 ADR과 OpenAPI contract baseline landed 상태, 다음 workspace resolver gap을 문서화 |

## 선택한 타입/스코프

- type: `feat` — contract impact baseline이라는 사용자 가시 기능 추가
- scope: `contracts` — OpenAPI/Swagger/AsyncAPI contract entity, version, relation surface가 중심

## Commit Message

```text
feat(contracts): OpenAPI impact baseline 추가

- OpenAPI/Swagger/AsyncAPI contract 파일을 first-class contract entity로 분류하고 기존 contracts/contract_versions 테이블에 baseline과 raw file hash 기반 version을 저장
- OpenAPI operation, protobuf RPC, GraphQL Query/Mutation field를 endpoint DECLARES relation으로 추출하고 bounded line/col evidence를 붙여 UI/MCP context를 작게 유지
- contract 파일이 명시적으로 repo-local code path를 언급할 때 contract REFERENCES와 code IMPLEMENTS reverse-link를 함께 저장해 contract 변경이 구현 코드 impact로 이어지도록 보강
- ImpactBench fixture를 46개 expected relation으로 확장하고 contract-sourced DECLARES over-extraction도 precision gate에서 잡도록 테스트를 강화
- D-025 ADR, roadmap, progress, README, changelog가 contract baseline landed 상태와 남은 workspace/cross-repo resolver gap을 설명하도록 갱신
```
