# NO-TICKET Build-System Package Resolver Commit (2026-05-12)

## 변경 범위

| 파일 | 요약 |
|---|---|
| `src/adapters/build-system-package.ts` | `package.json`, `pom.xml`, `build.gradle(.kts)`, `go.mod`, `Cargo.toml`, `pyproject.toml`을 manifest-only로 읽는 `build-system-package-resolver-v0` adapter 추가 |
| `src/indexer.ts`, `src/adapters/types.ts` | build manifest 파일을 `config` entity로 저장하고 새 package adapter를 언어별 adapter/fallback보다 먼저 라우팅 |
| `tests/build-system-adapter.test.ts` | npm workspace/local dependency, Maven/Gradle/Go/Cargo/Python dependency, malformed manifest diagnostics, path-prefix false positive 회귀 테스트 추가 |
| `bench/impact-bench.ts`, `tests/impact-bench.test.ts` | npm package graph expected relation 3개를 ImpactBench에 추가하고 expected relation count를 49로 갱신 |
| `README.md`, `CHANGELOG.md`, `docs/*.md` | build-system/package resolver v0 landed 상태, manifest-only 경계, D-038 ADR, 남은 lockfile/transitive/tool execution depth를 문서화 |

## 타입/스코프 판단

- 타입: `feat` — package manifest 기반 impact graph라는 새 사용자 기능이 추가됨
- 스코프: `adapters` — 변경의 중심이 semantic adapter registry와 build-system adapter임

## 커밋 메시지

```text
feat(adapters): build-system package resolver 추가

- `BuildSystemPackageAdapter`가 package.json, pom.xml, build.gradle(.kts), go.mod, Cargo.toml, pyproject.toml을 실행 없이 읽어 package graph를 만든다
- manifest file이 local package를 `DECLARES`하고 package가 manifest와 dependencies를 `DEPENDS_ON`하도록 저장해 manifest 변경이 dependent package까지 전파된다
- repo-local path mention은 token-bounded `CONFIGURES`로 보존해 `src/app.tsx`가 `src/app.ts`까지 잘못 매칭되는 false positive를 막는다
- npm workspace/local package, Maven, Gradle, Go, Cargo, pyproject dependency와 malformed manifest diagnostic을 회귀 테스트로 고정한다
- ImpactBench와 README/roadmap/progress/ADR D-038을 manifest-only resolver v0 landed 상태로 갱신한다
```

## 검증

- `npx tsx --test tests/build-system-adapter.test.ts` — 3 pass
- `npm run check` — pass
- `npm test` — 343 pass
- `npm run build` — pass
- `npm run docs:lint` — pass
- `npm audit --json` — 0 vulnerabilities
- `npm run bench` — passed, score 0.998, expected relations 49/49, unexpected relations 0
- `git diff --check` — pass
- GPT-5.5 spec re-review — `SPEC_PASS`
- GPT-5.5 code-quality re-review — `CODE_QUALITY_PASS`
