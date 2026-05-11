# Commit Message - UI work artifact metadata preview

## 변경 범위 분석

- 현재 브랜치 고유 변경: Work Artifacts row의 compact metadata preview, Markdown frontmatter/document-leading H1 parser, body-free UI bootstrap 회귀 테스트, D-044 문서 갱신.
- 다른 feature branch 병합 변경: 없음.
- base/main 유입 변경: 없음.

## 권장 커밋 메시지

```text
feat(ui): work artifact metadata preview 추가

- Work Artifacts row가 Markdown frontmatter와 문서 선두 H1에서 title, owner, status, updatedAt만 추출해 정책, PRD, 제안서 impact를 더 빨리 판단하게 보강
- artifact evidence snippet은 UI bootstrap에서 placeholder와 resource URI로 유지해 문서 본문이 첫 화면 payload에 섞이지 않도록 차단
- 본문 중간 heading과 fenced-code heading이 metadata로 승격되지 않는 회귀 테스트를 추가해 compact metadata 경계를 고정
- D-044 ADR과 README, progress, roadmap, Phase 문서를 갱신해 body-free metadata preview 결정을 문서화
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
- GPT-5.5 code review: pass after fenced/body heading leak fix
