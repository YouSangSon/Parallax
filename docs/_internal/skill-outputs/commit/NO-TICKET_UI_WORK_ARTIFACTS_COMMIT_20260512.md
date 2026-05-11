# Commit Message — UI work artifact impact surface

## 변경 범위 분석

- 현재 브랜치 고유 변경: `impact-trace ui`의 selected report 기반 Work Artifacts preview, artifact evidence snippet bootstrap 생략, UI 회귀 테스트, D-043 및 진행 문서 갱신.
- 다른 feature branch 병합 변경: 없음.
- base/main 유입 변경: 없음.

## 권장 커밋 메시지

```text
feat(ui): work artifact impact panel 추가

- `buildUiSnapshot`이 selected report의 policy/decision/PRD/requirement/proposal impact를 `workArtifacts`로 분리해 코드 변경이 업무 산출물에 미치는 영향을 바로 보게 보강
- Work Artifacts panel과 `bootstrap.workArtifacts`를 추가해 문서 본문을 싣지 않고 entity resource URI로 expand-on-demand 흐름 유지
- artifact evidence snippet은 UI bootstrap에서 placeholder로 치환해 정책/제안서/PRD 본문이 첫 화면 JSON에 섞이지 않도록 차단
- policy/proposal/PRD/requirement/decision fixture 테스트와 private body 회귀 테스트로 UI 노출 경로를 고정
- D-043 ADR과 README/progress/roadmap/Phase 문서를 갱신해 report-derived preview 결정을 문서화
```

## Type / Scope 근거

- `feat`: 사용자가 보는 UI 기능과 bootstrap shape가 확장됐다.
- `ui`: 주요 변경 파일이 `src/ui.ts`와 `tests/ui.test.ts`이며, 문서는 UI 제품 surface 결정을 설명한다.

## 검증

- `npm run check`
- `npx tsx --test tests/ui.test.ts`
- `npm run docs:lint`
- `git diff --check`
- `npm run build`
- `npm test`
- `npm run bench`
- `npm audit --json`
- GPT-5.5 SPEC review: `SPEC_PASS`
- GPT-5.5 CODE re-review: `CODE_PASS`
