# 커밋 분석

**Date:** 2026-05-12 03:00:27 KST
**Branch:** feature/phase6x-asyncapi-contract-diff-v0

## 변경 파일

| File | Changes |
| --- | --- |
| `src/asyncapi_compat.ts` | AsyncAPI YAML/JSON에서 operation, channel, message payload signature를 compact JSON으로 추출해 raw event contract 저장 없이 baseline/current 비교가 가능하게 구현 |
| `src/adapters/multi-language-regex.ts` | AsyncAPI contract metadata와 endpoint extraction을 추가해 index baseline에 `asyncapi-compat-v0` payload와 `SEND/RECEIVE address` endpoint를 저장 |
| `src/contract_diff.ts` | `workspace contract-diff`가 AsyncAPI contract를 인식하고 removed operation, message payload field removal/type change, newly required payload field를 breaking으로 분류 |
| `tests/contract-diff.test.ts` | AsyncAPI YAML/JSON fixture와 malformed/invalid action 회귀 테스트를 추가해 false breaking과 기존 breaking link 삭제를 방지 |
| `README.md`, `CHANGELOG.md`, `docs/*.md` | AsyncAPI contract diff v0 landed 상태, D-035 decision record, 다음 GraphQL/protobuf/AsyncAPI consumer resolver 범위를 문서화 |

## 커밋 메시지

feat(contracts): AsyncAPI contract diff 추가

- `asyncapi-compat-v0`가 AsyncAPI YAML/JSON에서 operation, channel, message payload signature를 만들어 raw event contract 저장 없이 baseline을 비교
- `workspace contract-diff`가 AsyncAPI current file을 읽어 removed operation, message payload field removal/type change, 새 required payload field를 breaking으로 분류
- malformed operations, missing channel, AsyncAPI v3 invalid action을 unknown으로 처리하고 기존 breaking link를 보존하도록 회귀 테스트를 추가
- README, roadmap, progress, Phase 문서와 D-035 decision record를 AsyncAPI landed 및 다음 consumer resolver scope에 맞게 갱신

## 명령어

```bash
git commit -m "feat(contracts): AsyncAPI contract diff 추가

- asyncapi-compat-v0가 AsyncAPI YAML/JSON에서 operation, channel, message payload signature를 만들어 raw event contract 저장 없이 baseline을 비교
- workspace contract-diff가 AsyncAPI current file을 읽어 removed operation, message payload field removal/type change, 새 required payload field를 breaking으로 분류
- malformed operations, missing channel, AsyncAPI v3 invalid action을 unknown으로 처리하고 기존 breaking link를 보존하도록 회귀 테스트를 추가
- README, roadmap, progress, Phase 문서와 D-035 decision record를 AsyncAPI landed 및 다음 consumer resolver scope에 맞게 갱신"
```

## 검증

- `npm run check`
- `npx tsx --test tests/contract-diff.test.ts`
- `npm test` — 326/326 pass
- `npm run build`
- `npm audit --json` — 0 vulnerabilities
- `npm run bench` — score 0.9978
- `npm run docs:lint`
- `git diff --check`
- GPT-5.5 spec review: `SPEC_PASS`
- GPT-5.5 code quality review: `CODE_QUALITY_PASS`

## 분석

- **Type:** `feat` - AsyncAPI contract diff라는 새 사용자 기능을 추가
- **Scope:** `contracts` - contract baseline/diff/classifier와 관련 문서가 중심
- **Files:** 15
- **Lines:** +1077/-60 before commit artifact
