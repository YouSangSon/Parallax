# Commit Message — Cargo workspace/path resolver

## 추천 커밋 메시지

```text
feat(adapters): Cargo workspace resolver 추가

- `BuildSystemPackageAdapter`가 `Cargo.toml`의 workspace members를 member manifest와 연결해 Rust workspace root 변경의 영향 경로를 보존
- Cargo local `path` dependency와 `workspace = true` version metadata를 package graph에 반영해 local crate와 shared dependency context를 더 정확히 노출
- Cargo workspace/path fixture와 ImpactBench 기대 relation을 추가해 workspace member, local path dependency, workspace dependency metadata를 회귀 테스트로 고정
- D-053과 Phase 6B 문서를 갱신해 Cargo 실행, lockfile, transitive graph, feature/target resolver는 후속 범위로 분리
```

## 변경 요약

- `src/adapters/build-system-package.ts`에서 Cargo workspace definition, dependency override, local path index를 추가했다.
- `tests/build-system-adapter.test.ts`와 ImpactBench fixture가 Cargo workspace/path dependency relation을 검증한다.
- `docs/decisions.ko.md`, `docs/progress.ko.md`, `docs/roadmap.md`, `docs/phase6b-ts-accuracy-plan.ko.md`가 Cargo manifest-only resolver 범위를 반영한다.

## 검증

- `npm run check`
- `npx tsx --test tests/build-system-adapter.test.ts`
- `npx tsx --test tests/build-system-adapter.test.ts tests/impact-bench.test.ts`
- `npm run docs:lint`
- `git diff --check`
- `npm run build`
- `npm run bench`
- `npm audit --json`
- `npm test`

## 남은 리뷰 이슈

- GPT-5.5 spec review가 `SPEC_FAIL`을 반환했다.
- 주요 이슈는 `[workspace.dependencies]`에 선언된 Cargo `path`가 member manifest 기준으로 해석되는 점이다.
- PR 본문에 이 리스크를 명시하고 draft 상태로 올린다.
