# Commit Message - UI work artifact freshness badge

## 변경 범위 분석

- 현재 브랜치 고유 변경: Work Artifacts row의 stale/current/unknown freshness badge, deterministic report-time date comparison, invalid date regression test, D-045/docs update.
- 다른 feature branch 병합 변경: 없음.
- base/main 유입 변경: 없음.

## 권장 커밋 메시지

```text
feat(ui): work artifact freshness badge 추가

- Work Artifacts row가 updatedAt metadata와 report 생성 시각을 비교해 stale, current, unknown 상태를 보여주도록 보강
- stale/unknown artifact를 current보다 먼저 정렬해 오래된 정책, PRD, requirement, decision, proposal impact를 더 빨리 확인하게 정리
- invalid YYYY-MM-DD 값이 JS Date 보정으로 current/stale 처리되지 않고 unknown으로 남는 회귀 테스트를 추가
- D-045 ADR과 README, progress, roadmap, Phase 문서를 갱신해 body-free freshness preview 결정을 문서화
```

## 검증

- `npm run check`
- `npx tsx --test tests/ui.test.ts`
- `npm run docs:lint`
- `git diff --check`
- `npm run build`
- `npm test`
- `npm run bench`
- `npm audit --json`
- GPT-5.5 spec review: pass
- GPT-5.5 code review: pass after invalid-date regression coverage
