# Commit Message Artifact

## 변경 요약

| 영역 | 내용 |
| --- | --- |
| `src/contract_diff.ts` | latest indexed OpenAPI endpoint surface와 current contract file을 비교하는 `analyzeContractDiff` 추가 |
| `src/cli.ts`, `src/index.ts` | `workspace contract-diff` CLI와 public API/type export 추가 |
| `src/adapters/multi-language-regex.ts` | indexed OpenAPI JSON/YAML baseline extractor를 current diff parser와 같은 endpoint-surface 규칙으로 보수화 |
| `tests/contract-diff.test.ts`, `tests/impact-trace.test.ts` | breaking/non-breaking/unknown 분류, persistence, stale workspace, path safety, JSON/YAML parser symmetry 회귀 테스트 추가 |
| `README.md`, `CHANGELOG.md`, `docs/*` | D-028 ADR, Phase 6B/progress/roadmap 문서를 OpenAPI endpoint-surface contract diff v0 landed 상태로 갱신 |

## 타입/스코프 근거

- 타입: `feat` — 사용자가 요청한 provider/consumer contract diff 기능이 새 public API와 CLI로 추가됨.
- 스코프: `contracts` — OpenAPI contract baseline, endpoint surface, breaking-change impact 저장이 핵심 변경 영역.
- 티켓: 브랜치에 명시 티켓이 없어 `NO-TICKET`.

## Commit Message

```text
feat(contracts): OpenAPI contract diff 추가

- `analyzeContractDiff`와 `workspace contract-diff` CLI를 추가해 latest indexed OpenAPI endpoint surface와 current contract file을 비교하고 removed endpoint는 breaking, added endpoint는 non-breaking으로 분류
- `CONSUMES_HTTP_ENDPOINT` provenance와 현재 workspace membership으로 known consumer만 좁혀 `BREAKS_COMPATIBILITY_WITH` link를 저장하고, unreadable/unparsed current contract는 기존 breaking link를 보존
- OpenAPI JSON/YAML baseline extractor와 current diff parser의 endpoint-surface 규칙을 맞춰 invalid shape, nested paths, tab indentation, symlink/path escape에서 false impact가 생기지 않도록 보강
- contract diff 회귀 테스트와 D-028 ADR, README, roadmap/progress 문서를 endpoint-surface v0 범위와 후속 schema/body diff 계획에 맞게 갱신
```

## 검증

- `npm run check`
- `npx tsx --test tests/contract-diff.test.ts tests/impact-trace.test.ts`
- `npm test`
- `npm run build`
- `npm run docs:lint`
- `git diff --check`
- `npm audit --json`
- `npm run bench`
- GPT-5.5 code review: `CODE_PASS`
