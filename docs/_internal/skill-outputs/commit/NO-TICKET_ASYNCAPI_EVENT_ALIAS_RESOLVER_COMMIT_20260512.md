# Commit Message

```text
feat(workspace): AsyncAPI event alias resolver 추가

- cross-repo resolver가 같은 파일의 standalone exact string alias를 AsyncAPI event address로 인식해 상수화된 subscribe/send call site도 producer/consumer impact로 연결하도록 보강
- source file의 bare member expression, property/member assignment, concatenation, interpolation, wildcard, placeholder/default expression은 제외해 computed topic false positive를 줄임
- resolver 회귀 테스트에 alias positive path와 comment, partial topic, property/member, computed literal negative path를 추가해 compact provenance가 call-site snippet을 유지하는지 검증
- D-047 ADR과 Phase 6B 문서를 갱신해 same-file literal-only alias 범위와 full parser/LSP로 넘긴 잔여 위험을 명확히 기록
```

## 변경 요약

- `src/cross_repo_resolver.ts`의 AsyncAPI evidence matching에 same-file alias lane을 추가했다.
- `tests/cross-repo-resolver.test.ts`에 alias positive/negative regression을 추가했다.
- `docs/decisions.ko.md`에 D-047을 추가하고, `docs/phase6b-ts-accuracy-plan.ko.md`의 landed scope를 갱신했다.

## 타입/스코프 근거

- 타입: `feat` — workspace cross-repo resolver가 새 AsyncAPI alias matching 기능을 제공한다.
- 스코프: `workspace` — 변경 지점이 workspace contract resolver와 cross-repo link 생성 흐름이다.

## 검증 근거

- `npx tsx --test tests/cross-repo-resolver.test.ts` 통과
- `npm run check` 통과
- GPT-5.5 spec compliance review: `SPEC_PASS`
- GPT-5.5 code quality review: `QUALITY_PASS`
