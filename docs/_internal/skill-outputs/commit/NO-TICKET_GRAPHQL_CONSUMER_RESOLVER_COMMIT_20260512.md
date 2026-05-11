# 커밋 분석

**Date:** 2026-05-12 03:36:52 KST
**Branch:** feature/phase6y-graphql-consumer-resolver-v0

## 변경 파일

| File | Changes |
| --- | --- |
| `src/cross_repo_resolver.ts` | `loadProviderEndpoints`가 GraphQL provider contract에서만 `Query.users` 같은 root field endpoint를 `GRAPHQL`로 해석해 protobuf `Query.users` false positive를 막고, `firstMatchingGraphqlOperationLine`이 consumer operation document의 top-level selection만 `CONSUMES_HTTP_ENDPOINT` 후보로 연결 |
| `src/cross_repo_resolver.ts` | `shouldScanConsumerFile`과 `isInsideBacktickTemplate`이 README/docs/examples와 TS/JS 일반 코드/주석 backtick을 제외해 문서 예시나 `function query()`가 impact link로 저장되지 않게 보강 |
| `tests/cross-repo-resolver.test.ts` | GraphQL provider/consumer happy path, docs/example 제외, protobuf `Query` service 제외, TS comment backtick 제외, stale/path safety 회귀 테스트를 추가해 resolver v0의 허용 범위를 고정 |
| `README.md` | current features와 roadmap 문구를 GraphQL consumer resolver landed 상태로 바꿔 사용자가 현재 지원되는 GraphQL impact surface와 남은 protobuf/AsyncAPI scope를 구분할 수 있게 갱신 |
| `CHANGELOG.md` | Phase 6B 항목에 GraphQL consumer resolver v0를 추가해 릴리스 노트가 실제 구현된 provider root field to consumer operation 연결을 반영 |
| `docs/README.md` | 문서 인덱스의 ADR 범위와 Phase 6B 설명을 D-036까지 확장해 새 GraphQL resolver 결정 문서로 바로 이동할 수 있게 갱신 |
| `docs/agentmemory-adoption-review.ko.md` | agentmemory 적용 리뷰의 next slice 문구를 protobuf/AsyncAPI consumer resolver 중심으로 갱신해 완료된 GraphQL resolver와 다음 작업을 분리 |
| `docs/decisions.ko.md` | D-036 decision record를 추가해 `CONSUMES_HTTP_ENDPOINT` envelope 재사용, GraphQL-only provider gating, docs/example 제외, full parser defer 결정을 남김 |
| `docs/impact-context-layer-plan.ko.md` | MCP context layer 계획의 contract impact milestone을 GraphQL consumer resolver landed 상태로 정리해 AI context 축소 roadmap과 현재 구현이 맞게 갱신 |
| `docs/phase6-design.ko.md` | Phase 6 설계 문서에 GraphQL consumer operation linking을 추가하고 남은 protobuf/AsyncAPI resolver를 후속 범위로 이동 |
| `docs/phase6b-ts-accuracy-plan.ko.md` | TS/JS accuracy plan에서 GraphQL template literal consumer scan의 제약과 false positive 방지 조건을 문서화해 구현 기준과 테스트 기준을 맞춤 |
| `docs/progress.ko.md` | 2026-05-12 진행 기록에 GraphQL consumer resolver v0와 GPT-5.5 review/verification 결과를 추가해 작업 이력을 보존 |
| `docs/roadmap.md` | roadmap의 next work 항목을 protobuf/AsyncAPI consumer resolver와 GraphQL full parser depth로 갱신해 이미 끝난 GraphQL v0가 반복 계획되지 않게 정리 |

## 커밋 메시지

feat(workspace): GraphQL consumer resolver 추가

- `resolveCrossRepoContracts`가 GraphQL provider root field와 consumer operation document를 연결해 schema 변경이 실제 consumer 코드에 미치는 후보 impact를 저장
- `loadProviderEndpoints`가 GraphQL contract에서만 `Query.users` display를 해석해 protobuf service 이름이 GraphQL link로 오염되지 않게 차단
- `firstMatchingGraphqlOperationLine`이 TS/JS backtick template과 raw `.graphql` document만 스캔해 README, docs 예시, 일반 함수 코드를 false positive에서 제외
- `tests/cross-repo-resolver.test.ts`에 provider kind gating, comment backtick, docs exclusion, stale/path safety 회귀 테스트를 추가해 resolver v0 계약을 검증
- README, roadmap, progress, Phase 문서와 D-036 decision record를 GraphQL resolver landed 및 다음 protobuf/AsyncAPI scope에 맞게 갱신

## 명령어

```bash
git commit -m "feat(workspace): GraphQL consumer resolver 추가

- resolveCrossRepoContracts가 GraphQL provider root field와 consumer operation document를 연결해 schema 변경이 실제 consumer 코드에 미치는 후보 impact를 저장
- loadProviderEndpoints가 GraphQL contract에서만 Query.users display를 해석해 protobuf service 이름이 GraphQL link로 오염되지 않게 차단
- firstMatchingGraphqlOperationLine이 TS/JS backtick template과 raw .graphql document만 스캔해 README, docs 예시, 일반 함수 코드를 false positive에서 제외
- tests/cross-repo-resolver.test.ts에 provider kind gating, comment backtick, docs exclusion, stale/path safety 회귀 테스트를 추가해 resolver v0 계약을 검증
- README, roadmap, progress, Phase 문서와 D-036 decision record를 GraphQL resolver landed 및 다음 protobuf/AsyncAPI scope에 맞게 갱신"
```

## 검증

- `npx tsx --test tests/cross-repo-resolver.test.ts` — 12/12 pass
- `npm run check`
- `npm run docs:lint`
- `git diff --check`
- `npm test` — 332/332 pass
- `npm run build`
- `npm audit --json` — 0 vulnerabilities
- `npm run bench` — score 0.9978, 46/46 expected relations matched
- GPT-5.5 spec review: `SPEC_PASS`
- GPT-5.5 code quality re-review: `CODE_QUALITY_PASS`

## 분석

- **Type:** `feat` - workspace resolver가 GraphQL consumer impact link라는 새 기능을 제공
- **Scope:** `workspace` - workspace catalog와 cross-repo link 저장 흐름이 중심
- **Files:** 12 before commit artifact
- **Lines:** +721/-67 before commit artifact
