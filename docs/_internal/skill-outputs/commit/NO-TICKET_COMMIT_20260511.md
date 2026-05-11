# 커밋 분석

**Date:** 2026-05-11 13:05:28 KST
**Branch:** feature/phase6k-parser-depth-v0

## 변경 파일

| File | Changes |
| --- | --- |
| `src/adapters/multi-language-regex.ts` | `extractTypeScriptJavaScriptImports`, `makeRelation`, `inferTestTargets`가 TS/JS import evidence 위치를 잃던 문제를 줄이기 위해 `ts.createSourceFile` AST와 line/col span 전달을 추가해 import-backed `DEPENDS_ON`/`VERIFIES`가 bounded snippet을 저장하도록 변경 |
| `bench/impact-bench.ts` | `runImpactBench`의 `passed` 조건이 span regression을 놓치지 않도록 `spanCompleteness >= 0.75` gate를 실제 bench pass/fail에 포함 |
| `tests/multi-language-regex-ts-spans.test.ts` | parser-backed import span 회귀를 고정하기 위해 static/type-only/namespace/re-export/dynamic import/require/test import fixture를 인덱싱하고 `relation_evidence` line/col/snippet/adaptor attribution을 검증 |
| `tests/impact-bench.test.ts` | ImpactBench regression test가 span completeness 하락을 잡도록 `report.scores.spanCompleteness >= 0.75` assertion을 추가 |
| `tests/mcp.test.ts` | `makeWideContextRepo` fixture의 import evidence가 짧아진 뒤에도 brief budget truncation을 검증하기 위해 긴 import alias를 사용하도록 조정 |
| `package.json`, `package-lock.json` | runtime adapter가 TypeScript parser를 import하므로 `typescript`를 devDependency에서 dependency로 이동 |
| `README.md`, `docs/README.md`, `docs/agentmemory-adoption-review.ko.md`, `docs/impact-context-layer-plan.ko.md`, `docs/phase6b-ts-accuracy-plan.ko.md`, `docs/progress.ko.md`, `docs/roadmap.md` | TS/JS parser-backed import span v0가 landed 됐고 다음 depth가 JVM/Spring/Python/Go/Rust/workspace 쪽이라는 현재 제품 상태를 문서에 반영 |
| `docs/decisions.ko.md` | `D-022`를 추가해 TS/JS import span은 `ts.createSourceFile` parser로 처리하고 `ts.createProgram`/Tree-sitter/full resolver는 후속으로 남기는 결정을 기록 |

## 커밋 메시지

feat(adapters): TS/JS parser import span 추가

- `extractTypeScriptJavaScriptImports`가 `ts.createSourceFile` AST로 import/export/import()/require evidence를 추출해 TS/JS relation의 line/col range를 bounded snippet과 함께 저장
- `makeRelation`과 `inferTestTargets`가 import-backed `VERIFIES`에 같은 evidence span을 재사용해 테스트 영향 근거가 파일 전체로 퍼지지 않게 정리
- `runImpactBench`, `tests/impact-bench.test.ts`, `tests/multi-language-regex-ts-spans.test.ts`가 `spanCompleteness >= 0.75`와 TS/JS import span fixture를 검증하도록 보강
- README, Phase 6B 문서, roadmap, ADR `D-022`가 landed 범위와 남은 JVM/Spring/Python/Go/Rust depth work를 설명하도록 갱신

## 명령어

```bash
git commit -m "feat(adapters): TS/JS parser import span 추가

- \`extractTypeScriptJavaScriptImports\`가 \`ts.createSourceFile\` AST로 import/export/import()/require evidence를 추출해 TS/JS relation의 line/col range를 bounded snippet과 함께 저장
- \`makeRelation\`과 \`inferTestTargets\`가 import-backed \`VERIFIES\`에 같은 evidence span을 재사용해 테스트 영향 근거가 파일 전체로 퍼지지 않게 정리
- \`runImpactBench\`, \`tests/impact-bench.test.ts\`, \`tests/multi-language-regex-ts-spans.test.ts\`가 \`spanCompleteness >= 0.75\`와 TS/JS import span fixture를 검증하도록 보강
- README, Phase 6B 문서, roadmap, ADR \`D-022\`가 landed 범위와 남은 JVM/Spring/Python/Go/Rust depth work를 설명하도록 갱신"
```

## 분석

- **Type:** feat - TS/JS adapter가 parser-backed evidence span이라는 새 분석 capability를 제공
- **Scope:** adapters - 핵심 변경이 `MultiLanguageRegexAdapter`의 TS/JS import evidence extraction에 집중
- **Files:** 16
- **Lines:** +401/-63
