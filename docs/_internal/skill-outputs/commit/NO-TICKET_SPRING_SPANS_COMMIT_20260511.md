# 커밋 분석

**Date:** 2026-05-11 13:37:54 KST
**Branch:** feature/phase6l-spring-depth-v0

## 변경 파일

| File | Changes |
| --- | --- |
| `src/adapters/multi-language-regex.ts` | `EvidenceSpan`, `extractSpringEvents`, `extractSpringEndpoints`, `extractSpringBeanMethods`, `inferTestTargets`, `inferTextTargetsWithEvidence`를 보강해 Spring/Spring Boot와 config/test relation이 whole-file 근거 대신 bounded snippet과 line/col span을 저장하도록 변경 |
| `tests/multi-language-regex-spring.test.ts` | Spring endpoint, role/bean declaration, application.yml/properties config mention, filename-inferred JVM `VERIFIES`, analyzeDiff evidence span 회귀 테스트를 추가해 span 누락과 handler bleed를 검증 |
| `bench/impact-bench.ts` | `spanCompleteness` pass gate를 0.75에서 0.85로 올려 TS/JS span 이후 JVM/Spring span 개선까지 bench 기준에 반영 |
| `tests/impact-bench.test.ts` | ImpactBench deterministic report assertion을 새 `spanCompleteness >= 0.85` gate에 맞춰 갱신 |
| `README.md` | README feature list와 roadmap summary가 Spring Boot evidence span landed 상태와 다음 Python/Go/Rust depth를 설명하도록 갱신 |
| `docs/README.md` | 문서 인덱스가 D-023과 JVM/Spring lightweight evidence span v0 landed 상태를 가리키도록 갱신 |
| `docs/decisions.ko.md` | D-023 ADR을 추가해 JVM/Spring span을 parser/build resolver 없이 lightweight line/annotation scanning으로 먼저 고정한 결정을 기록 |
| `docs/progress.ko.md` | 진행 로그와 Phase 6B 트랙을 `spanCompleteness 0.8718`, gate 0.85, 다음 Python/Go/Rust/workspace work 기준으로 갱신 |
| `docs/roadmap.md` | roadmap active next를 JVM/Spring에서 Python/Go/Rust depth 또는 workspace contract로 이동 |
| `docs/phase6b-ts-accuracy-plan.ko.md` | Phase 6B 계획이 TS/JS span뿐 아니라 JVM/Spring endpoint/declaration/config/test span landed 상태와 새 acceptance gate를 설명하도록 갱신 |
| `docs/impact-context-layer-plan.ko.md` | 제품 계획의 source span persistence 설명에 JVM/Spring bounded span을 반영 |
| `docs/agentmemory-adoption-review.ko.md` | agentmemory 적용성 문서의 landed/next 표를 JVM/Spring span landed 이후 상태로 정리 |

## 커밋 메시지

feat(adapters): JVM Spring evidence span 추가

- `extractSpringEvents`와 `extractSpringEndpoints`가 Spring role/bean/endpoint 근거를 whole-file 대신 bounded snippet과 line/col range로 저장해 MCP/UI evidence panel이 정확한 위치를 펼치도록 보강
- `inferTestTargets`와 `inferTextTargetsWithEvidence`가 filename-inferred JVM `VERIFIES` 및 application config `CONFIGURES` 근거를 선언부/매칭 라인으로 고정해 AI context 낭비를 줄임
- `tests/multi-language-regex-spring.test.ts`와 ImpactBench gate가 endpoint bleed, Spring declaration, config line, JVM test declaration span을 검증하도록 확장하고 `spanCompleteness >= 0.85`로 상향
- README, Phase 6B plan, roadmap, progress log, ADR D-023이 JVM/Spring lightweight span landed 상태와 다음 Python/Go/Rust/workspace work를 설명하도록 갱신

## 명령어

```bash
git commit -m "feat(adapters): JVM Spring evidence span 추가

- \`extractSpringEvents\`와 \`extractSpringEndpoints\`가 Spring role/bean/endpoint 근거를 whole-file 대신 bounded snippet과 line/col range로 저장해 MCP/UI evidence panel이 정확한 위치를 펼치도록 보강
- \`inferTestTargets\`와 \`inferTextTargetsWithEvidence\`가 filename-inferred JVM \`VERIFIES\` 및 application config \`CONFIGURES\` 근거를 선언부/매칭 라인으로 고정해 AI context 낭비를 줄임
- \`tests/multi-language-regex-spring.test.ts\`와 ImpactBench gate가 endpoint bleed, Spring declaration, config line, JVM test declaration span을 검증하도록 확장하고 \`spanCompleteness >= 0.85\`로 상향
- README, Phase 6B plan, roadmap, progress log, ADR D-023이 JVM/Spring lightweight span landed 상태와 다음 Python/Go/Rust/workspace work를 설명하도록 갱신"
```

## 분석

- **Type:** `feat` - Spring/Spring Boot evidence span coverage와 bench gate를 사용자가 체감할 수 있는 adapter capability로 추가
- **Scope:** `adapters` - 핵심 변경이 multi-language regex adapter와 adapter accuracy bench/test에 집중
- **Files:** 12
- **Lines:** +374/-75

## 검증

- `npm run check` 통과
- `npx tsx --test tests/multi-language-regex-spring.test.ts tests/impact-bench.test.ts` 통과, 2/2
- `npm run bench` 통과, score 0.9936, `spanCompleteness` 0.8718
- `npm test` 통과, 242/242
- `npm run docs:lint` 통과
- `npm audit --json` 취약점 0
- `git diff --check` 통과
- GPT-5.5 spec review: `SPEC_PASS`
- GPT-5.5 code quality review: `CODE_PASS`
