# NO-TICKET Gradle Version Catalog Resolver Commit (2026-05-12)

## 변경 범위

| 파일 | 요약 |
|---|---|
| `src/adapters/build-system-package.ts` | `gradle/libs.versions.toml`의 `[versions]`, `[libraries]`, `[bundles]`를 manifest-only로 읽고 `build.gradle(.kts)`의 `libs.*` accessor를 실제 Gradle package dependency로 펼치는 resolver 추가 |
| `tests/build-system-adapter.test.ts` | direct alias, bundle alias, `version.ref`, nested `platform(libs.*)`/`enforcedPlatform(libs.*)`, nearest catalog scoping, comment/string false positive 회귀 테스트 추가 |
| `bench/impact-bench.ts`, `tests/impact-bench.test.ts` | Gradle version catalog fixture와 Spring Web package dependency expected relation을 추가하고 expected relation count를 51로 갱신 |
| `docs/decisions.ko.md`, `docs/phase6b-ts-accuracy-plan.ko.md`, `docs/progress.ko.md`, `docs/roadmap.md` | Gradle version catalog resolver v0의 landed scope, no Gradle execution 경계, custom/imported catalog 후속 한계 문서화 |

## 타입/스코프 판단

- 타입: `feat` — Gradle version catalog 기반 dependency impact graph라는 새 사용자 기능을 추가한다.
- 스코프: `adapters` — 변경의 중심이 build-system semantic adapter와 그 package dependency extraction이다.

## 커밋 메시지

```text
feat(adapters): Gradle catalog resolver 추가

- `BuildSystemPackageAdapter`가 default `gradle/libs.versions.toml`을 실행 없이 읽어 `libs.*` accessor를 `libs.*` pseudo package가 아니라 실제 Gradle package 좌표로 저장한다
- `[versions]`의 `version.ref`, string/module/group-name library notation, `[bundles]` alias를 지원해 Spring Boot/Kotlin dependency impact가 compact package graph에 남도록 보강한다
- build manifest 기준 가장 가까운 default catalog만 사용하고 nested `platform(libs.*)`/`enforcedPlatform(libs.*)` accessor를 outer dependency type과 함께 보존한다
- comment와 quoted string 안의 `libs.*`를 masking해 주석/문자열 예시가 dependency edge로 승격되는 false positive를 차단한다
- Gradle catalog 회귀 테스트, ImpactBench fixture, D-049와 Phase 6B/progress/roadmap 문서를 새 v0 scope와 후속 한계에 맞게 갱신한다
```

## 검증

- `npm run check` — pass
- `npx tsx --test tests/build-system-adapter.test.ts` — 4 pass
- `npx tsx --test tests/build-system-adapter.test.ts tests/impact-bench.test.ts` — 5 pass
- `npm run docs:lint` — pass
- `git diff --check` — pass
- `npm run build` — pass
- `npm test` — 383 pass
- `npm run bench` — passed, score 0.998, expected relations 51/51, unexpected relations 0
- `npm audit --json` — 0 vulnerabilities
- GPT-5.5 spec re-review — `SPEC_PASS`
- GPT-5.5 code-quality final re-review — `QUALITY_PASS`
