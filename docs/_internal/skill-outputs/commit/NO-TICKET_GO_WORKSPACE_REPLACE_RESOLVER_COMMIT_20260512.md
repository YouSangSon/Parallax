# NO-TICKET Go Workspace Replace Resolver Commit (2026-05-12)

## 변경 범위

| 파일 | 요약 |
|---|---|
| `src/adapters/build-system-package.ts` | `go.work use` directory를 repo-local `go.mod` manifest로 연결하고, `go.mod`의 local `replace`를 해당 manifest 범위에서만 실제 Go package dependency로 해석 |
| `tests/build-system-adapter.test.ts` | `go.work` directive evidence 우선순위, scoped local replace, replace 없는 동일 module require의 external 유지 회귀 테스트 추가 |
| `bench/impact-bench.ts`, `tests/impact-bench.test.ts` | Go workspace/replace fixture와 expected relation 5개를 추가하고 expected relation count를 58로 갱신 |
| `docs/decisions.ko.md`, `docs/phase6b-ts-accuracy-plan.ko.md`, `docs/progress.ko.md`, `docs/roadmap.md` | D-051과 Phase 6B 문서에 Go workspace/replace v0의 local-path scope와 `go` command/transitive build-list 제외 경계 기록 |

## 타입/스코프 판단

- 타입: `feat` — Go workspace/replace 기반 local package impact graph라는 새 사용자 기능을 추가한다.
- 스코프: `adapters` — 변경의 중심이 build-system semantic adapter와 package dependency extraction이다.

## 커밋 메시지

```text
feat(adapters): Go workspace resolver 추가

- `BuildSystemPackageAdapter`가 `go.work use` directory를 실행 없이 repo-local `go.mod` manifest로 연결해 workspace 변경이 포함 module manifests까지 전파되게 한다
- `go.mod`의 repo-local `replace <module> => ./local-path`를 해당 manifest 범위에서만 실제 local Go package dependency로 해석해 외부 pseudo package 오분류를 줄인다
- replace alias를 전역 package index에 섞지 않고 source `go.mod`별 scoped index로 적용해 다른 module의 동일 `require`가 잘못 로컬 package로 붙지 않게 막는다
- `go.work`의 generic path mention보다 `use` directive evidence를 우선해 주석/본문 mention이 relation evidence line을 오염시키지 않도록 고정한다
- Go workspace/replace 회귀 테스트, ImpactBench fixture, D-051과 Phase 6B/progress/roadmap 문서를 local-path v0 scope와 후속 한계에 맞게 갱신한다
```

## 검증

- `npm run check` — pass
- `npx tsx --test tests/build-system-adapter.test.ts tests/impact-bench.test.ts` — 7 pass
- `npm run docs:lint` — pass
- `git diff --check` — pass
- `npm run build` — pass
- `npm test` — 385 pass
- `npm run bench` — passed, score 0.9983, expected relations 58/58, unexpected relations 0
- `npm audit --json` — 0 vulnerabilities
- GPT-5.5 spec final re-review — `SPEC_PASS`
- GPT-5.5 code-quality final re-review — `QUALITY_PASS`
