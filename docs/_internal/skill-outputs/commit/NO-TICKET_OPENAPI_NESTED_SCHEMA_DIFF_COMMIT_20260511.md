# Commit Message: OpenAPI Nested Schema Diff

## 추천 커밋 메시지

```text
feat(contracts): OpenAPI nested schema diff 추가

- `openapi-compat-v0` payload를 schemaVersion 2로 올려 flat baseline과 nested-capable baseline이 조용히 섞이지 않게 하고, stale schemaVersion 1 baseline은 warning과 reindex 요구로 처리
- JSON/YAML request/response signature가 nested object path, root/nested array item path, local `$ref` chain, allOf object merge를 저장하도록 확장해 endpoint가 유지되는 body-level breaking change를 잡도록 보강
- oneOf/anyOf는 property/root body fingerprint로 보수적으로 비교하고, required-only object branch와 JSON Pointer array index ref까지 회귀 테스트로 고정
- `contract-diff`가 nested required/type change를 known consumer endpoint의 `BREAKS_COMPATIBILITY_WITH` link로 저장하도록 유지하며 기존 unknown/preserve-link safety behavior는 보존
- README, roadmap, progress, Phase 문서와 D-032 decision record를 schemaVersion 2 nested schema diff 범위와 후속 protobuf/GraphQL/AsyncAPI 범위에 맞게 갱신
```

## 변경 파일 요약

| 파일 | 변경 |
|---|---|
| `src/openapi_compat.ts` | nested schema path signature, composition fingerprint, array pointer `$ref` resolution, schemaVersion 2 적용 |
| `src/contract_diff.ts` | stale OpenAPI compatibility baseline warning과 schemaVersion mismatch fallback 처리 |
| `tests/contract-diff.test.ts` | nested JSON/YAML, root/nested array, allOf, oneOf/anyOf, required-only object, array pointer ref, stale baseline 회귀 테스트 추가 |
| `tests/impact-trace.test.ts` | OpenAPI compatibility baseline schemaVersion 2 persistence 검증 갱신 |
| `README.md`, `CHANGELOG.md`, `docs/*.md` | nested schema diff 범위, schemaVersion 2 reindex 요구, 후속 contract diff 범위 문서화 |

## 검증

- `npm run check`
- `npx tsx --test tests/contract-diff.test.ts`
- `npx tsx --test tests/contract-diff.test.ts tests/impact-trace.test.ts`
- `npm run docs:lint`
- `git diff --check`
- `npm test`
- `npm run build`
- `npm audit --json`
- `npm run bench`
- GPT-5.5 spec/code review: `CODE_PASS`
