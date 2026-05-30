# Roadmap

> 앞으로 해야 할 일을 thematic으로 정리한다. 진행 상황 추적은 git log 와 PR 단위로 유지한다.

이 문서는 *지금 막힘없이 갈 방향*만 적는다. 큰 결정은 [invariants.md](invariants.md)를 깨지 않는 선에서 한다.

---

## 1. 정확도 (Accuracy)

지금 가장 큰 빈칸은 regex/declaration-line 기반 evidence가 *언제 틀리는지*를 사람이 알 수 없다는 것이다.

- [ ] TS/JS Tree-sitter 또는 TypeScript parser 기반 full symbol/call span
  - 진행: TypeScript parser 기반 import, declaration, imported call-site, local identifier call, same-class `this.method()`, static `ClassName.method()`, typed parameter instance method call, constructor parameter property instance method call, class field arrow method caller/target, class field instance method call, same-file `new ClassName()` instance call, direct `new ClassName().method()` call span은 landed. 더 넓은 dynamic dispatch와 type relation은 남음.
- [ ] JVM/Spring Boot endpoint·DI·persistence relation을 parser 기반으로 승격
- [ ] Python/Go/Rust call/import resolution을 declaration-only에서 parser-backed로 확장
- [x] adapter run마다 confidence label과 known-gap을 report에 명시

## 2. Workspace / Contract

cross-repo impact가 v0 상태. 사용자가 등록한 local repo 사이에서만 동작.

- [ ] OpenAPI / GraphQL / Protobuf / AsyncAPI contract diff를 *nested schema* 단위까지 안정화
- [ ] generated-client / event topology resolver를 heuristic 너머로
- [ ] workspace catalog가 monorepo 내부 sub-package를 first-class로 인식
- [ ] cross-repo link이 양방향 (provider→consumer, consumer→provider) 항상 일관

## 3. Package / Build 해상도

manifest-only resolver는 transitive/lockfile/semver를 보지 못한다.

- [ ] lockfile 기반 transitive 의존성 그래프 (npm·pip·poetry·go·cargo·maven·gradle)
- [ ] semver/range 정보로 영향받는 버전 범위 추론
- [ ] build script 실행 없이 dependency 그래프 dump 표준화

## 4. Agent surface

MCP는 read-only로 안정화됐다. 다음은 agent 사용성을 깊게 보는 단계.

- [ ] `context_for_change`의 budget tuning (brief/standard/deep)을 사용 텔레메트리로 검증
- [ ] context pack 결과의 hit/miss 측정 harness
- [ ] write surface를 별도 권한 모델로 분리해 도입 검토 ([invariants.md](invariants.md) I-8 준수)

## 5. UI Explorer

지금 UI는 저장된 report와 graph를 읽는 첫 explorer 수준.

- [ ] changed → affected → evidence → action 흐름의 단일 화면 검증
- [ ] policy / decision / PRD / requirement / proposal 같은 work-artifact lane을 first-class panel로
- [ ] evidence resource를 클릭 한 번에 원본 파일/라인으로 jump

## 6. 회고와 측정

회귀 신호 없이 모든 변경이 작동한다는 보장이 없다.

- [ ] 다언어 fixture 기반 deterministic bench harness
- [ ] embedding 모델 / LLM provider 교차 시 recall 품질 회귀 detection
- [ ] CI에서 매 PR마다 bench delta를 자동 리포트

---

## 다음 한 슬라이스만 고른다면

`tests/`와 `bench/`에 이미 있는 fixture 위에서 **정확도 (1)** 의 첫 항목 — *parser-backed TS/JS span* — 을 닫는 게 가장 ROI가 높다. 다른 모든 축이 evidence span 정밀도에 의존하기 때문이다.
