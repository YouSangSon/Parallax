# 커밋 분석

**Date:** 2026-05-13 09:43:45
**Branch:** feature/phase6ap-python-optional-deps-v0

## 변경 파일

| File | Changes |
| --- | --- |
| `src/adapters/build-system-package.ts` | `parsePyprojectToml`과 `pyprojectDependencies`가 `[project]` 섹션 안의 runtime dependency만 읽도록 범위를 고정하고, optional/dependency group/Poetry group dependency를 package graph에 추가해 Python dev/test/docs package impact가 빠지지 않게 보강 |
| `tests/build-system-adapter.test.ts` | `indexProject` pyproject fixture에 optional extras, PEP 735 dependency groups, Poetry group, legacy `[tool.poetry]` identity case를 추가하고 `include-group` 객체가 fake dependency가 되지 않도록 target set 회귀 검증 |
| `bench/impact-bench.ts` | ImpactBench fixture에 `pyproject.toml` runtime/optional/group/Poetry dependency를 추가해 benchmark가 Python package resolver depth를 직접 측정하도록 확장 |
| `tests/impact-bench.test.ts` | expected relation 수를 63개로 갱신하고 Python project/optional/group/Poetry dependency label을 필수 coverage로 고정 |
| `docs/decisions.ko.md` | D-052에 Python dependency groups v0의 pyproject-local, manifest-only 범위와 include expansion/lockfile/virtualenv 제외를 기록 |
| `docs/phase6b-ts-accuracy-plan.ko.md` | Phase 6B package resolver 설명에 Python optional/dependency groups v0와 후속 범위인 include expansion을 반영 |
| `docs/progress.ko.md` | 진행상황과 완료 목록에 Python optional/dependency groups v0를 추가해 현재 package/build depth 상태를 맞춤 |
| `docs/roadmap.md` | 로드맵의 build-system/package resolver 현황에 Python optional/dependency groups v0를 반영하고 다음 depth를 lockfile/transitive/include expansion으로 정리 |

## 커밋 메시지

feat(adapters): Python dependency groups 추가

- `parsePyprojectToml`과 `pyprojectDependencies`가 `pyproject.toml`의 project/optional/group 섹션을 구분해 읽도록 바꿔 Python package impact가 잘못 섞이지 않게 보강
- Poetry group dependency와 legacy `[tool.poetry]` package identity를 지원해 Poetry 기반 프로젝트의 docs/dev dependency도 graph에서 볼 수 있게 추가
- PEP 735 `include-group` 객체가 fake package로 저장되지 않도록 adapter 테스트와 ImpactBench fixture를 확장해 회귀를 막음
- D-052와 Phase 6B 문서에 manifest-only 범위와 lockfile/transitive/virtualenv/include expansion 제외를 기록해 다음 package depth 경계를 명확히 함

## 명령어

```bash
git commit -m "feat(adapters): Python dependency groups 추가

- parsePyprojectToml과 pyprojectDependencies가 pyproject.toml의 project/optional/group 섹션을 구분해 읽도록 바꿔 Python package impact가 잘못 섞이지 않게 보강
- Poetry group dependency와 legacy [tool.poetry] package identity를 지원해 Poetry 기반 프로젝트의 docs/dev dependency도 graph에서 볼 수 있게 추가
- PEP 735 include-group 객체가 fake package로 저장되지 않도록 adapter 테스트와 ImpactBench fixture를 확장해 회귀를 막음
- D-052와 Phase 6B 문서에 manifest-only 범위와 lockfile/transitive/virtualenv/include expansion 제외를 기록해 다음 package depth 경계를 명확히 함"
```

## 분석

- **Type:** `feat` - Python package graph가 optional/dependency group dependency를 새로 인식한다.
- **Scope:** `adapters` - 핵심 변경이 build-system/package resolver adapter에 있다.
- **Files:** 8
- **Lines:** +389/-38
