# Commit Message - MCP work artifact context preview

## 변경 범위 분석

- 현재 브랜치 고유 변경: `context_for_change`의 body-free `workArtifacts` lane, context pack cache v2, work artifact evidence snippet placeholder, MCP regression test, D-046/docs update.
- 다른 feature branch 병합 변경: 없음.
- base/main 유입 변경: 없음.

## 권장 커밋 메시지

```text
feat(context): work artifact preview 추가

- `impact_trace_context_for_change`가 policy, decision, PRD, requirement, proposal impact를 `workArtifacts` compact lane으로 반환해 Claude/Codex가 업무 산출물 영향을 본문 없이 받게 보강
- Work artifact evidence snippet은 placeholder로 치환하고 entity/evidence resource URI만 남겨 문서 본문이 context pack payload에 섞이지 않도록 차단
- metadata와 stale/current/unknown freshness를 index run 기준으로 계산하고 context pack cache를 v2로 올려 이전 persisted shape와 충돌하지 않게 정리
- MCP 회귀 테스트와 D-046 ADR, README, progress, roadmap, Phase 문서를 갱신해 body-free context preview 계약을 문서화
```

## 검증

- `npm run check`
- `npx tsx --test tests/mcp.test.ts --test-name-pattern "context_for_change"`
- `npm run docs:lint`
- `git diff --check`
- `npm run build`
- `npm test`
- `npm run bench`
- `npm audit --json`
- GPT-5.5 spec review: pass after removing extra `depth` field
- GPT-5.5 code review: pass
