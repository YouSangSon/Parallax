# Commit Message: OpenAPI JSON Schema Diff

## 추천 커밋 메시지

```text
feat(contracts): OpenAPI JSON schema diff 추가

- JSON OpenAPI index baseline에 `openapi-compat-v0` request/response flat schema signature를 저장해 re-index 전 current contract와 비교할 수 있게 구현
- `workspace contract-diff`가 response status/required property/type 변경과 request required property/type 변경을 breaking change로 분류하도록 확장
- schema/body breaking change도 matching `CONSUMES_HTTP_ENDPOINT` consumer에 `BREAKS_COMPATIBILITY_WITH` link를 저장하고 provenance에 schema 세부 정보를 남기도록 보강
- chained/duplicate local `$ref`를 재귀적으로 해석하는 회귀 테스트와 contract baseline persistence 테스트로 false negative를 방지
- README, progress, indexing model, Phase 6B plan, D-030 decision record에 JSON flat schema v0 범위와 한계를 문서화
```

## 변경 파일 요약

| 파일 | 변경 |
|---|---|
| `src/openapi_compat.ts` | JSON OpenAPI compatibility signature extractor 추가 |
| `src/adapters/multi-language-regex.ts` | JSON contract metadata 생성 시 compatibility signature 계산 |
| `src/indexer.ts` | signature를 `contract_versions.compatibility_json`에 저장하고 `contracts.metadata_json`은 compact하게 유지 |
| `src/contract_diff.ts` | baseline/current signature 비교와 schema/body breaking classification, link provenance 확장 |
| `tests/contract-diff.test.ts` | removed response required property, added request required property, chained/duplicate `$ref` type-change 회귀 테스트 추가 |
| `tests/impact-trace.test.ts` | JSON OpenAPI compatibility baseline persistence 검증 추가 |
| `README.md`, `docs/*.md` | JSON OpenAPI schema/body diff v0 범위와 제한 문서화 |

## 검증

- `npm run check`
- `npx tsx --test tests/contract-diff.test.ts`
- `npx tsx --test tests/contract-diff.test.ts tests/impact-trace.test.ts`
- `npm test`
- `npm run build`
- `npm run docs:lint`
- `git diff --check`
- `npm audit --json`
- `npm run bench`
- GPT-5.5 spec review: `SPEC_PASS`
- GPT-5.5 code quality re-review: `CODE_PASS`
