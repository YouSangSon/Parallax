# Commit Message: OpenAPI YAML Schema Diff

## 추천 커밋 메시지

```text
feat(contracts): OpenAPI YAML schema diff 추가

- `yaml` parser로 YAML OpenAPI를 object model로 정규화해 JSON과 같은 `openapi-compat-v0` flat request/response signature를 저장
- `workspace contract-diff`가 YAML current contract에서도 response status/required property/type 변경과 request required property/type 변경을 breaking change로 분류하도록 확장
- current YAML은 기존 endpoint scanner를 safety gate로 유지하고 parser failure는 `unparsed_current_contract`로 승격해 기존 breaking link를 보존
- YAML response required property 제거, request required property 추가, parser failure preserve-link 회귀 테스트와 baseline persistence 테스트를 추가
- README, roadmap, progress, Phase 문서와 D-031 decision record를 JSON/YAML flat schema v0 범위와 nested/protobuf/GraphQL 후속 범위에 맞게 갱신
```

## 변경 파일 요약

| 파일 | 변경 |
|---|---|
| `package.json`, `package-lock.json` | YAML body/schema parsing을 위해 `yaml` 의존성 추가 |
| `src/openapi_compat.ts` | YAML parse 결과를 JSON과 같은 compatibility signature builder에 연결하고 parser error를 구조화 |
| `src/adapters/multi-language-regex.ts` | YAML contract metadata 생성 시 compatibility signature 계산 |
| `src/contract_diff.ts` | current YAML endpoint scanner 성공 후 compatibility parse를 수행하고 parser failure를 unknown/unparsed로 처리 |
| `tests/contract-diff.test.ts` | YAML schema/body breaking rules와 parser failure preserve-link 회귀 테스트 추가 |
| `tests/impact-trace.test.ts` | YAML compatibility baseline persistence 검증 추가 |
| `README.md`, `docs/*.md` | JSON/YAML flat schema diff v0와 후속 nested/protobuf/GraphQL 범위 문서화 |

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
- GPT-5.5 spec re-review: `SPEC_PASS`
- GPT-5.5 code quality review: `CODE_PASS`
