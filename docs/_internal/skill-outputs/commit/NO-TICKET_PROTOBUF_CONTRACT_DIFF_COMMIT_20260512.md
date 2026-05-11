# Commit Message: Protobuf Contract Diff

## 추천 커밋 메시지

```text
feat(contracts): Protobuf contract diff 추가

- `.proto` index baseline에 `protobuf-compat-v0` compact signature를 저장해 raw contract body, descriptor image, Buf/BSR 의존 없이 service/RPC/message field surface를 비교
- `workspace contract-diff`가 protobuf contract kind와 `.proto` current file을 인식하고 removed RPC, RPC type/streaming change, response field removal/type/name/label change를 breaking으로 분류
- protobuf endpoint baseline을 compatibility parser와 같은 comment-stripping path로 통일하고 nested message/enum field false positive를 막으면서 oneof member field는 parent field로 유지
- removed RPC, response field type/removal, commented RPC, nested message, oneof member field 회귀 테스트를 추가해 compact compatibility storage와 false positive 방지를 검증
- README, roadmap, progress, Phase 문서와 D-033 decision record를 Protobuf v0 landed 상태와 다음 GraphQL/AsyncAPI scope에 맞게 갱신
```

## 변경 파일 요약

| 파일 | 변경 |
|---|---|
| `src/protobuf_compat.ts` | Protobuf compatibility signature extractor, comment stripping, top-level service/message parsing, nested block filtering, oneof member field 보존 |
| `src/adapters/multi-language-regex.ts` | protobuf contract metadata에 compact compatibility payload를 저장하고 endpoint extraction을 parser 기반으로 통일 |
| `src/contract_diff.ts` | protobuf current parser, baseline parser, removed RPC 및 message/RPC breaking-change classifier 추가 |
| `tests/contract-diff.test.ts` | removed RPC, response field type/removal, commented RPC, nested message, oneof member field 회귀 테스트 추가 |
| `README.md`, `CHANGELOG.md`, `docs/*.md` | Protobuf contract diff v0 범위, 제한, 다음 GraphQL/AsyncAPI scope 문서화 |

## 검증

- `npm run check`
- `npx tsx --test tests/contract-diff.test.ts`
- `npx tsx --test tests/impact-trace.test.ts`
- `npm run docs:lint`
- `git diff --check`
- `npm test`
- `npm run build`
- `npm audit --json`
- `npm run bench`
- GPT-5.5 spec review: `SPEC_PASS`
- GPT-5.5 code quality review: `CODE_QUALITY_PASS`
