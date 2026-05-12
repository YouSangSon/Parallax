# NO-TICKET Maven Property Interpolation Commit (2026-05-12)

## 변경 범위

| 파일 | 요약 |
|---|---|
| `src/adapters/build-system-package.ts` | `pom.xml`의 same-file `<properties>`와 `project.*`/`pom.*`/parent alias를 manifest-only로 치환해 Maven package/dependency 좌표와 version metadata를 실제 값으로 저장 |
| `tests/build-system-adapter.test.ts` | Maven property interpolation, parent alias, comment/build/profile/dependencyManagement 제외, unresolved `${...}` pseudo-coordinate 차단, evidence line/col 안정성 회귀 테스트 추가 |
| `bench/impact-bench.ts`, `tests/impact-bench.test.ts` | Maven property dependency fixture와 Spring Web package dependency expected relation을 추가하고 expected relation count를 53으로 갱신 |
| `docs/decisions.ko.md`, `docs/phase6b-ts-accuracy-plan.ko.md`, `docs/progress.ko.md`, `docs/roadmap.md` | Maven property interpolation v0의 POM-local scope, Maven 실행/parent traversal/profile/effective model 제외, Phase 6B package depth 후속 한계 문서화 |

## 타입/스코프 판단

- 타입: `feat` — Maven POM property 기반 package impact graph라는 새 사용자 기능을 추가한다.
- 스코프: `adapters` — 변경의 중심이 build-system semantic adapter와 package dependency extraction이다.

## 커밋 메시지

```text
feat(adapters): Maven property resolver 추가

- `BuildSystemPackageAdapter`가 `pom.xml`의 same-file `<properties>`와 `project.*`/`pom.*`/parent alias를 실행 없이 치환해 `${...}` pseudo coordinate 대신 실제 Maven package 좌표를 저장한다
- parent metadata와 dependency version/scope까지 property interpolation을 적용해 Spring Boot/Maven dependency impact가 compact package graph에 남도록 보강한다
- `<profiles>`, `<build>`, `<reporting>`, `<dependencyManagement>`, XML comment는 offset-preserving masking으로 제외해 inactive profile/plugin/managed dependency false positive와 evidence span drift를 막는다
- Maven property 회귀 테스트와 ImpactBench fixture를 추가해 relation 53개가 모두 matched되고 unexpected relation 없이 통과하도록 검증한다
- D-050과 Phase 6B/progress/roadmap 문서를 갱신해 POM-local v0 scope와 Maven 실행/parent traversal/profile/effective model 후속 한계를 기록한다
```

## 검증

- `npm run check` — pass
- `npx tsx --test tests/build-system-adapter.test.ts tests/impact-bench.test.ts` — 6 pass
- `npm run docs:lint` — pass
- `git diff --check` — pass
- `npm run build` — pass
- `npm test` — 384 pass
- `npm run bench` — passed, score 0.9981, expected relations 53/53, unexpected relations 0
- `npm audit --json` — 0 vulnerabilities
- GPT-5.5 spec review — `SPEC_PASS`
- GPT-5.5 code-quality final re-review — `QUALITY_PASS`
