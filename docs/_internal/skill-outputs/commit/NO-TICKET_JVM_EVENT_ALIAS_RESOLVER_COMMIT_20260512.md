# Commit Message

```text
feat(workspace): JVM event alias resolver 추가

- cross-repo resolver가 Java `static final String`과 Kotlin `const val` topic alias를 인식해 Spring Kafka listener와 KafkaTemplate producer impact를 같은 파일 안에서 연결하도록 보강
- alias matching을 exact quoted literal과 standalone declaration으로 제한해 computed JVM constants와 기존 property/member/computed topic false positive를 계속 차단
- cross-repo resolver 테스트에 Java listener, Kotlin producer, computed JVM constant regression을 추가해 Spring Boot event topology가 call-site snippet 기반으로 유지되는지 검증
- D-047과 Phase 6B 문서를 갱신해 same-file literal alias 범위가 TS/JS뿐 아니라 Java/Kotlin/Spring common path까지 포함함을 기록
```

## 변경 요약

- `src/cross_repo_resolver.ts`의 AsyncAPI alias extractor가 Java/Kotlin constant 선언을 인식한다.
- `tests/cross-repo-resolver.test.ts`에 Java `@KafkaListener`, Kotlin `KafkaTemplate.send`, computed JVM constant negative case를 추가했다.
- `docs/decisions.ko.md`, `docs/phase6b-ts-accuracy-plan.ko.md`에 Java/Kotlin alias scope를 반영했다.

## 타입/스코프 근거

- 타입: `feat` — workspace resolver의 AsyncAPI event alias coverage가 Java/Kotlin으로 확장된다.
- 스코프: `workspace` — cross-repo workspace contract resolver와 event topology link 생성 흐름이다.

## 검증 근거

- `npx tsx --test tests/cross-repo-resolver.test.ts` 통과
- `npm run check` 통과
- GPT-5.5 spec compliance review: `SPEC_PASS`
- GPT-5.5 code quality review: `QUALITY_PASS`
