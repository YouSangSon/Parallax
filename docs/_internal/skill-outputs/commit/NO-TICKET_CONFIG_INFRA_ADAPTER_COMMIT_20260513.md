# 커밋 분석

**Date:** 2026-05-13 11:04:59 KST
**Branch:** feature/phase6as-config-infra-adapter-v0

## 변경 파일

| File | Changes |
| --- | --- |
| `src/adapters/config-infra.ts` | `config-infra-semantic-v0` adapter를 추가해 GitHub Actions workflow YAML, Dockerfile/Containerfile, Terraform `.tf`의 explicit repo-local path impact를 regex fallback에서 분리 |
| `src/indexer.ts` | config/infra adapter를 build-system adapter 다음, 언어별/regex fallback adapter 앞에 등록해 scoped config/infra 파일의 adapter attribution을 전용 adapter로 귀속 |
| `tests/config-infra-adapter.test.ts` | workflow/Terraform `CONFIGURES`, Dockerfile/Containerfile `COPY`/`ADD` `DEPENDS_ON`, multi-source shell/JSON form, compact JSON form, `--from` multistage 제외, path prefix false positive를 회귀 테스트로 고정 |
| `bench/impact-bench.ts` | workflow와 Dockerfile expected relation을 `config-infra-semantic-v0` attribution으로 갱신하고 adapter path classifier에 config/infra scope를 반영 |
| `docs/decisions.ko.md` | D-054에 config/infra adapter v0의 explicit path 기준, Docker `COPY`/`ADD` 처리, generic YAML/Docker/Terraform semantic depth 제외를 기록 |
| `docs/phase6b-ts-accuracy-plan.ko.md` | Phase 6B 범위와 제외 항목에 config/infra adapter v0와 후속 semantic depth를 반영 |
| `docs/progress.ko.md` | config/infra adapter v0 진행상황, 검증 결과, 완료 체크리스트를 갱신 |
| `docs/roadmap.md` | A5 config/CI/infra lane을 부분 완료로 갱신하고 다음 depth를 generic YAML, Docker build context, Terraform graph로 정리 |

## 커밋 메시지

feat(adapters): config infra adapter 추가

- `config-infra-semantic-v0`가 GitHub Actions workflow, Dockerfile/Containerfile, Terraform `.tf`의 explicit repo-local path impact를 regex fallback에서 분리해 adapter attribution을 독립 측정
- Docker `COPY`/`ADD` source를 `DEPENDS_ON`, workflow/Terraform/Docker explicit path mention을 `CONFIGURES`로 저장하고 `--from` multistage/glob/URL은 v0 밖으로 둠
- shell/JSON multi-source `COPY`/`ADD`, compact JSON, prefix path false positive, Containerfile/Terraform/workflow coverage를 회귀 테스트로 고정
- ImpactBench와 D-054/progress/roadmap/Phase 6B 문서가 config/infra v0 범위와 후속 semantic depth를 기록

## 명령어

```bash
git commit -m "feat(adapters): config infra adapter 추가

- config-infra-semantic-v0가 GitHub Actions workflow, Dockerfile/Containerfile, Terraform .tf의 explicit repo-local path impact를 regex fallback에서 분리해 adapter attribution을 독립 측정
- Docker COPY/ADD source를 DEPENDS_ON, workflow/Terraform/Docker explicit path mention을 CONFIGURES로 저장하고 --from multistage/glob/URL은 v0 밖으로 둠
- shell/JSON multi-source COPY/ADD, compact JSON, prefix path false positive, Containerfile/Terraform/workflow coverage를 회귀 테스트로 고정
- ImpactBench와 D-054/progress/roadmap/Phase 6B 문서가 config/infra v0 범위와 후속 semantic depth를 기록"
```

## 검증

- `npm run check` 통과
- `npm run build` 통과
- `npx tsx --test tests/config-infra-adapter.test.ts tests/impact-bench.test.ts` 통과
- `npm run docs:lint` 통과
- `git diff --check` 통과
- `npm run bench` 통과 — score 0.9986, expected relations 69/69, unexpected relations 0, adapter attribution 1.0
- `npm test` 통과 — 389/389 tests
- GPT-5.5 spec review `SPEC_PASS`
- GPT-5.5 quality review `QUALITY_PASS`

## 분석

- **Type:** `feat` - config/CI/infra explicit path impact를 전용 adapter가 새로 처리한다.
- **Scope:** `adapters` - 핵심 변경이 adapter registry와 config/infra semantic adapter에 있다.
- **Files:** 9
