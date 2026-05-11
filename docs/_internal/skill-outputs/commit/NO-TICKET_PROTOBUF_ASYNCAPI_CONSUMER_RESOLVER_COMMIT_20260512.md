# NO-TICKET Protobuf/AsyncAPI Consumer Resolver Commit (2026-05-12)

## 변경 범위

| 파일 | 요약 |
|---|---|
| `src/cross_repo_resolver.ts` | Protobuf provider endpoint를 `RPC Service/Rpc`로, AsyncAPI operation을 `ACTION address`로 해석하고 기존 `CONSUMES_HTTP_ENDPOINT` envelope에 저장하도록 resolver를 확장 |
| `tests/cross-repo-resolver.test.ts` | Protobuf RPC consumer link, ordinary helper false positive, generated protobuf skip, AsyncAPI exact event address/partial topic exclusion 회귀 테스트 추가 |
| `tests/contract-diff.test.ts` | removed Protobuf RPC와 removed AsyncAPI operation이 resolved consumer에 `BREAKS_COMPATIBILITY_WITH` link를 남기는지 검증 |
| `README.md`, `CHANGELOG.md`, `docs/*.md` | Protobuf/AsyncAPI consumer resolver v0 landed 상태, D-037 ADR, 남은 generated-client/event topology/full parser 범위 갱신 |

## 타입/스코프 판단

- 타입: `feat` — `workspace resolve-contracts`의 provider/consumer 연결 surface가 Protobuf와 AsyncAPI까지 확장됨
- 스코프: `workspace` — 변경의 중심이 workspace cross-repo resolver와 그 결과를 사용하는 contract impact 흐름임

## 커밋 메시지

```text
feat(workspace): Protobuf AsyncAPI consumer resolver 추가

- `workspace resolve-contracts`가 Protobuf RPC와 AsyncAPI event operation을 기존 cross-repo link envelope에 저장해 removed RPC/event의 downstream impact를 작게 전달
- Protobuf matcher가 service anchor와 receiver call 또는 exact route literal만 인정하고 generated protobuf 파일/헤더와 helper declaration false positive를 제외
- AsyncAPI matcher가 source/config의 exact event address token만 사용해 docs/examples/README와 partial topic match가 consumer impact로 섞이지 않게 정리
- cross-repo resolver와 contract-diff 테스트를 추가해 RPC/event link 생성과 `BREAKS_COMPATIBILITY_WITH` persistence를 검증
- README, roadmap, progress, Phase 문서와 D-037 decision record를 landed behavior 및 다음 full parser/LSP/generated-client scope에 맞게 갱신
```

## 검증

- `npx tsx --test tests/cross-repo-resolver.test.ts tests/contract-diff.test.ts` — 82 pass
- `npm run check` — pass
- `npm test` — 340 pass
- `npm run build` — pass
- `npm run docs:lint` — pass
- `npm audit --json` — 0 vulnerabilities
- `npm run bench` — passed, score 0.9978
- `git diff --check` — pass
- GPT-5.5 spec review — `SPEC_PASS`
- GPT-5.5 code-quality re-review — `QUALITY_PASS`
