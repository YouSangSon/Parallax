# Commit message artifact

## 변경 요약

| 영역 | 내용 |
|---|---|
| `src/mcp.ts` | `impact_trace_contract_diff` MCP tool과 workspace/contract/cross-repo link resource 3종 추가 |
| `tests/mcp.test.ts` | MCP tool list, contract diff call, workspace resource read, contract baseline resource, cross-repo link resource 회귀 테스트 추가 |
| `README.md`, `CHANGELOG.md`, `docs/*` | D-029 ADR과 roadmap/progress/phase 문서를 MCP workspace/contract resources v0 landed 상태로 갱신 |

## 타입/스코프 판단

- 타입: `feat` — coding agent가 endpoint-surface contract impact를 MCP로 직접 요청하고 resource로 확장하는 새 기능이다.
- 스코프: `mcp` — 핵심 변경이 MCP tool/resource surface에 집중되어 있다.
- 티켓: 브랜치와 요청에 명시된 티켓 번호가 없어 `NO-TICKET`으로 기록한다.

## 커밋 메시지

```text
feat(mcp): contract impact resources 추가

- `impact_trace_contract_diff`를 추가해 OpenAPI endpoint-surface diff를 MCP에서 바로 실행하고 workspace contract/link resource URI를 함께 반환
- `impact-trace://workspaces/{name}`, `/contracts`, `/cross-repo-links` resource를 추가해 agent가 전체 workspace를 덤프하지 않고 catalog, contract baseline, provider/consumer link를 필요할 때만 확장
- MCP 회귀 테스트로 tool schema, persisted breaking link, contract endpoint count, `CONSUMES_HTTP_ENDPOINT`/`BREAKS_COMPATIBILITY_WITH` provenance resource를 고정
- D-029 ADR, README, roadmap/progress/phase 문서를 MCP workspace/contract resources v0 범위와 후속 schema/body diff 계획에 맞게 갱신
```

## 검증

- `npm run check`
- `npx tsx --test tests/mcp.test.ts`
- `npx tsx --test tests/mcp.test.ts tests/contract-diff.test.ts tests/cross-repo-resolver.test.ts`
- `npm test`
- `npm run build`
- `npm run docs:lint`
- `git diff --check`
- `npm audit --json`
- `npm run bench`
- GPT-5.5 spec review: `SPEC_PASS`
- GPT-5.5 code quality review: `CODE_PASS`
