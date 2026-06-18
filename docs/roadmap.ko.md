# Roadmap

[English](roadmap.md) · **한국어** · [中文](roadmap.zh.md)

> 앞으로 해야 할 일을 thematic으로 정리한다. 진행 상황 추적은 git log 와 PR 단위로 유지한다.

이 문서는 *지금 막힘없이 갈 방향*만 적는다. 큰 결정은 [invariants.ko.md](invariants.ko.md)를 깨지 않는 선에서 한다.

---

## 1. 정확도 (Accuracy)

지금 가장 큰 빈칸은 regex/declaration-line 기반 evidence가 *언제 틀리는지*를 사람이 알 수 없다는 것이다.

- [ ] TS/JS Tree-sitter 또는 TypeScript parser 기반 full symbol/call span
  - 진행: TypeScript parser 기반 import, declaration, same-file/named-imported/direct-named-re-exported/star-re-exported/namespace-re-exported/default-imported/direct-default-re-exported/namespace-imported class/interface heritage type relation, imported call-site, local identifier call, method-reference alias call, same-class `this.method()`, same-file class `super.method()`, same-file class extends inherited instance/static method, static `ClassName.method()`, same-file/direct-new-or-const-alias-inferred/namespace-constructor-inferred/factory-wrapper-inferred/direct-factory-call-receiver/named-imported/direct-named-re-exported/star-re-exported/namespace-imported/namespace-re-exported/default-imported/direct-default-re-exported/awaited factory return type instance method call, interface/type-literal method/function-property/function-type-alias signature, same-file/named-imported/direct-named-re-exported/star-re-exported/namespace-re-exported/default-imported/direct-default-re-exported/namespace-imported interface/type-literal typed receiver method call, same-file interface extends typed receiver method call, same-file alias-backed interface extends typed receiver method call, same-file type reference alias typed receiver method call, same-file simple generic type reference typed receiver method call, same-file generic constraint typed receiver method call, same-file intersection type alias typed receiver method call, direct intersection typed receiver method call, same-file simple union typed receiver method call, local/class-scoped array/`Array<T>`/`ReadonlyArray<T>`/`readonly T[]`, numeric tuple element, same-file indexed collection alias, explicitly typed array/tuple destructuring, typed local collection binding에서 이어지는 array/tuple destructuring, declared typed local/class field receiver method call, typed local variable instance method call, typed/destructured/named-object parameter instance method call, assertion-wrapped/non-null/parenthesized typed receiver method call, string-literal element access method call, private member receiver method call, constructor parameter property instance method call, constructor assignment instance method call, object literal method/property callable declaration과 receiver method call, class field arrow method caller/target, static class field arrow method call, typed class field instance method call, class field instance method call, same-file `new ClassName()` instance call, direct `new ClassName().method()` call span은 landed. 더 넓은 dynamic dispatch와 advanced type relation은 남음.
- [ ] JVM/Spring Boot endpoint·DI·persistence relation을 parser 기반으로 승격
- [ ] Python/Go/Rust call/import resolution을 declaration-only에서 parser-backed로 확장
- [x] adapter run마다 confidence label과 known-gap을 report에 명시
- [x] NodeNext/ESM `.js` 확장자 local import을 TypeScript source(`.ts`)로 resolve — 내부 import 의존성 그래프가 전부 `external_entity`로 빠지던 문제 수정
- [x] impact report의 `affected`를 confidence(proven > inferred > heuristic) → depth → path 순으로 정렬 — proven 코드 영향이 heuristic 문서 mention 아래 묻히던 문제 수정 (UI의 first-glance target도 자동 개선)

## 2. Workspace / Contract

cross-repo impact가 v0 상태. 사용자가 등록한 local repo 사이에서만 동작.

- [ ] OpenAPI / GraphQL / Protobuf / AsyncAPI contract diff를 *nested schema* 단위까지 안정화
- [ ] generated-client / event topology resolver를 heuristic 너머로
- [ ] workspace catalog가 monorepo 내부 sub-package를 first-class로 인식
- [ ] cross-repo link이 양방향 (provider→consumer, consumer→provider) 항상 일관

## 3. Package / Build 해상도

package resolver는 common ecosystem의 manifest graph와 npm lockfile transitive dependency를 다룬다. npm이 아닌 대부분의 lockfile ecosystem과 semver 영향 분석은 아직 남아 있다.

- [x] npm `package-lock.json` v2/v3 transitive 의존성 그래프
  - 현재 gate: transitive package entry를 locked version과 evidence span이 있는 lockfile-derived `DEPENDS_ON` package relation으로 index한다.
- [ ] pip/poetry/go/cargo/maven/gradle lockfile로 lockfile 기반 transitive 의존성 그래프 확장
- [ ] semver/range 정보로 영향받는 버전 범위 추론
- [ ] build script 실행 없이 dependency 그래프 dump 표준화

## 4. Agent surface

MCP는 read-only로 안정화됐다. 다음은 agent 사용성을 깊게 보는 단계.

- [ ] `context_for_change`의 budget tuning (brief/standard/deep)을 사용 텔레메트리로 검증
- [ ] context pack 결과의 hit/miss 측정 harness
- [ ] write surface를 별도 권한 모델로 분리해 도입 검토 ([invariants.ko.md](invariants.ko.md) I-8 준수)

## 5. UI Explorer

지금 UI는 저장된 report와 graph를 읽는 첫 explorer 수준.

- [x] changed → affected → evidence → action 흐름의 단일 화면 검증
- [x] policy / decision / PRD / requirement / proposal 같은 work-artifact lane을 first-class panel로
- [x] evidence resource를 클릭 한 번에 원본 파일/라인으로 jump
- [x] selected impact의 relation/evidence/action을 더 깊게 drill-down하는 inspector 확장
- [x] saved report 간 비교와 regression delta UI
- [x] report delta의 added path를 source viewer와 inspector/verification action에 직접 연결하고 removed path는 source viewer로 연결
- [x] report delta의 wider/narrower 판단 기준을 team policy로 설정 가능하게 만들기
- [x] report delta policy preset을 UI에서 비교할 수 있게 만들기
- [x] impact map에 primary flow summary, 방향 화살표, stage band를 추가해 first glance 강화
- [x] report delta preset에서 선택한 policy를 config patch로 내보내기
- [x] impact map을 첫 viewport의 primary surface로 올려 변경 → 영향 흐름을 바로 보이게 만들기
- [x] impact map의 fallback edge도 displayed path로 표시해 "0 graph links"처럼 오해되는 상태 제거
- [x] impact summary도 displayed path 기준으로 맞춰 summary와 map의 용어 불일치 제거
- [x] 첫 화면에 changed root → affected targets → next verification triage strip 추가
- [x] triage strip에서 top affected/verification target을 클릭하면 inspector/evidence 선택으로 연결
- [x] impact map edge/label도 selected target과 함께 강조해 그래프 해석성 강화
- [x] 초기 primary flow/inspector를 action-first selected target 기준으로 통일
- [x] map legend row도 selected target과 동기화하고 서버 렌더링부터 selected state 표시
- [x] Impact Summary에 coverage, adapter confidence, known gap을 묶은 Analysis Trust 요약 추가
- [x] client-updated map, inspector, copy, source, empty-state label까지 localize해 workbench language switcher를 정직하게 유지
- [x] language/report navigation에서 selected report와 language query state를 함께 보존
- [x] 선택된 impact의 lane, confidence, evidence 수, 검증 준비 상태를 합친 판정 카드 추가

## 6. 회고와 측정

회귀 신호 없이 모든 변경이 작동한다는 보장이 없다.

- [x] 다언어 fixture 기반 deterministic bench harness
  - 현재 gate: `bench/impact-bench.ts`가 TypeScript/JavaScript, JVM/Spring Boot, Python, Go, Rust, OpenAPI, build manifest 고정 fixture를 만들고 relation recall/precision, affected-file recall, evidence/span coverage, adapter attribution, context-pack readiness, retrieval 품질을 채점한다. `npm run bench`, `npm test`, CI의 `npm run verify` gate에서 실행된다.
- [x] embedding 모델 / LLM provider 교차 시 recall 품질 회귀 detection
  - 현재 gate: deterministic bench가 모델별 recall@1과 cross-model isolation을 확인하는 semantic model matrix를 포함한다. live provider 호출에 의존하지 않고 embedding 모델 namespace 회귀를 잡는 offline gate이며, LLM provider의 네트워크 품질 평가는 CI 밖에 두고 provider contract는 offline test가 계속 검증한다.
- [x] CI에서 매 PR마다 bench delta를 자동 리포트
  - 현재 gate: CI가 pull request에서 base SHA의 bench report를 준비하고, head에서 canonical `npm run verify` gate를 실행한 뒤, `npm run bench:report` Markdown을 GitHub Step Summary에 append해 score, relation, affected-file, retrieval, semantic recall delta를 표시한다.

---

## 다음 한 슬라이스만 고른다면

`tests/`와 `bench/`에 이미 있는 fixture 위에서 **정확도 (1)** 의 첫 항목 — *parser-backed TS/JS span* — 을 닫는 게 가장 ROI가 높다. 다른 모든 축이 evidence span 정밀도에 의존하기 때문이다.
