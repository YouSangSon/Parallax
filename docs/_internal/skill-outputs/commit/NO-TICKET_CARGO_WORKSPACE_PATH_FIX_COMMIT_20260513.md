# Commit Message — Cargo workspace path fix

## 추천 커밋 메시지

```text
fix(adapters): Cargo workspace path 기준 수정

- `[workspace.dependencies]`에서 상속한 Cargo `path`를 member manifest가 아니라 workspace root manifest 기준으로 해석해 local crate impact가 잘못 추론되지 않게 수정
- workspace-inherited path dependency도 실제 path 근거가 있으면 `proven` relation으로 남기도록 dependency override metadata를 보강
- Cargo regression fixture가 workspace-inherited path와 direct member-relative path를 함께 검증하도록 확장
- Cargo v0 제외 범위를 문서에 명확히 적어 실행, `Cargo.lock`, feature/target resolver, `package.workspace`, `[workspace].exclude`, complex glob이 후속임을 고정
```

## 검증

- `npx tsx --test tests/build-system-adapter.test.ts` RED 확인: `inferred` vs `proven` 실패
- `npx tsx --test tests/build-system-adapter.test.ts`
- `npm run check`
- `npx tsx --test tests/build-system-adapter.test.ts tests/impact-bench.test.ts`
- `npm run docs:lint`
- `git diff --check`
- `npm run build`
- `npm run bench`
- `npm test`
- GPT-5.5 spec re-review: `SPEC_PASS`
- GPT-5.5 quality review: `QUALITY_PASS`
