# 커밋 분석

**Date:** 2026-05-11 14:04:05 KST
**Branch:** feature/phase6m-polyglot-depth-v0

## 변경 파일

| File | Changes |
| --- | --- |
| `src/adapters/multi-language-regex.ts` | `ExtractedSymbol.evidence`, `symbolEvidenceForMatch`, `declarationLineEvidence`, Python/Go/Rust `testDeclarationEvidence`를 추가해 declaration/test relation이 whole-file 근거 대신 bounded line/col span을 저장하도록 보강 |
| `tests/multi-language-regex-spring.test.ts` | Python class/function, Go function, Rust function `DECLARES`와 Python/Go/Rust filename-inferred `VERIFIES`, Python import-backed `VERIFIES` evidence preference를 검증하도록 fixture와 assertion 확장 |
| `bench/impact-bench.ts` | Python/Go/Rust 대표 `DECLARES` relation을 expected set에 추가하고 `spanCompleteness` pass gate를 0.9로 상향 |
| `tests/impact-bench.test.ts` | ImpactBench expected relation 수와 required label assertion을 43개 polyglot span fixture에 맞춰 갱신 |
| `README.md` | feature list와 Phase 6B summary가 Python/Go/Rust lightweight span landed 상태와 다음 workspace/contract work를 설명하도록 갱신 |
| `docs/README.md` | 문서 인덱스가 D-024와 Python/Go/Rust lightweight evidence span v0 landed 상태를 가리키도록 갱신 |
| `docs/decisions.ko.md` | D-024 ADR을 추가해 Python/Go/Rust span을 full resolver 전에 declaration-line evidence로 먼저 고정한 결정을 기록 |
| `docs/progress.ko.md` | 진행 로그와 검증 표를 `spanCompleteness 0.9535`, expected relations 43/43, tests 242개 기준으로 갱신 |
| `docs/roadmap.md` | roadmap active next를 Python/Go/Rust depth에서 workspace/contract impact로 이동 |
| `docs/phase6b-ts-accuracy-plan.ko.md` | Phase 6B 계획이 Python/Go/Rust lightweight span landed 상태와 새 `spanCompleteness >= 0.9` acceptance gate를 설명하도록 갱신 |
| `docs/impact-context-layer-plan.ko.md` | 제품 계획의 source span persistence 설명에 Python/Go/Rust declaration/test bounded span을 반영 |
| `docs/agentmemory-adoption-review.ko.md` | agentmemory 적용성 문서의 landed/next 표를 Python/Go/Rust span landed 이후 상태로 정리 |

## 커밋 메시지

feat(adapters): Python Go Rust evidence span 추가

- `extractEvents`와 `extractSymbols`가 Python/Go/Rust `DECLARES` 근거를 declaration-line bounded snippet과 line/col range로 저장해 UI/MCP가 polyglot 선언 위치를 작게 펼치도록 보강
- `testDeclarationEvidence`가 Python/Go/Rust filename-inferred `VERIFIES` 근거를 테스트 선언부로 고정하고 import-backed evidence preference는 dedupe 순서로 유지해 기존 import relation을 보존
- `tests/multi-language-regex-spring.test.ts`와 ImpactBench가 Python class/function, Go/Rust function, filename-inferred tests, import-backed Python test evidence를 검증하고 `spanCompleteness >= 0.9`로 상향
- README, Phase 6B plan, roadmap, progress log, ADR D-024가 Python/Go/Rust lightweight span landed 상태와 다음 workspace/contract work를 설명하도록 갱신

## 명령어

```bash
git commit -m "feat(adapters): Python Go Rust evidence span 추가

- \`extractEvents\`와 \`extractSymbols\`가 Python/Go/Rust \`DECLARES\` 근거를 declaration-line bounded snippet과 line/col range로 저장해 UI/MCP가 polyglot 선언 위치를 작게 펼치도록 보강
- \`testDeclarationEvidence\`가 Python/Go/Rust filename-inferred \`VERIFIES\` 근거를 테스트 선언부로 고정하고 import-backed evidence preference는 dedupe 순서로 유지해 기존 import relation을 보존
- \`tests/multi-language-regex-spring.test.ts\`와 ImpactBench가 Python class/function, Go/Rust function, filename-inferred tests, import-backed Python test evidence를 검증하고 \`spanCompleteness >= 0.9\`로 상향
- README, Phase 6B plan, roadmap, progress log, ADR D-024가 Python/Go/Rust lightweight span landed 상태와 다음 workspace/contract work를 설명하도록 갱신"
```

## 분석

- **Type:** `feat` - Python/Go/Rust evidence span coverage와 bench gate를 adapter capability로 추가
- **Scope:** `adapters` - 핵심 변경이 multi-language regex adapter, adapter fixture, ImpactBench에 집중
- **Files:** 12
- **Lines:** +316/-42

## 검증

- `npm run check` 통과
- `npx tsx --test tests/multi-language-regex-spring.test.ts tests/impact-bench.test.ts` 통과, 2/2
- `npm run bench` 통과, score 0.9977, expected relations 43/43, `spanCompleteness` 0.9535
- `npm test` 통과, 242/242
- `npm run docs:lint` 통과
- `npm audit --json` 취약점 0
- `git diff --check` 통과
- GPT-5.5 spec review: `SPEC_PASS`
- GPT-5.5 code quality review: `CODE_PASS`
