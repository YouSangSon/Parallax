# Commit Message

```text
feat(workspace): OpenAPI route alias resolver 추가

- cross-repo resolver가 같은 파일의 exact route alias를 실제 HTTP call-site와 연결해 Spring WebClient, RestTemplate, Feign, fetch 기반 OpenAPI consumer impact를 route declaration 없이도 찾도록 보강
- HTTP consumer matching을 call-site gated 방식으로 좁혀 route constant 선언, computed path, Spring controller mapping, ordinary dotted method가 `CONSUMES_HTTP_ENDPOINT` false positive로 저장되지 않게 정리
- Feign mapping detection을 comment-masked source와 Feign interface/class body scope로 제한해 주석 속 `@FeignClient`나 같은 파일의 controller mapping이 consumer로 승격되지 않도록 차단
- cross-repo resolver 테스트에 Java route constant, declaration-only, controller mapping, Feign scope, ordinary method, computed constant 회귀 케이스를 추가해 OpenAPI contract diff의 consumer evidence가 실제 호출 라인을 가리키는지 검증
- D-048과 Phase 6B/progress/roadmap 문서를 갱신해 OpenAPI HTTP route alias resolver v0의 범위와 parser/LSP 후속 한계를 기록
```

## 변경 요약

- `src/cross_repo_resolver.ts`가 OpenAPI HTTP endpoint에 대해 same-file exact route alias와 call-site literal을 별도 HTTP evidence matcher로 처리한다.
- `tests/cross-repo-resolver.test.ts`에 Spring WebClient/Feign positive path와 declaration-only/controller/commented Feign/ordinary method/computed constant negative path를 추가했다.
- `docs/decisions.ko.md`, `docs/phase6b-ts-accuracy-plan.ko.md`, `docs/progress.ko.md`, `docs/roadmap.md`에 route alias resolver의 landed 범위와 제외 범위를 반영했다.

## 타입/스코프 근거

- 타입: `feat` — workspace resolver가 OpenAPI HTTP consumer를 새 방식으로 인식하고 false positive guard를 함께 제공한다.
- 스코프: `workspace` — 변경 중심이 `workspace resolve-contracts`의 cross-repo provider/consumer link 생성 흐름이다.

## 검증 근거

- `npx tsx --test tests/cross-repo-resolver.test.ts` 통과 — 53 pass
- `npm run check` 통과
- `npm run docs:lint` 통과
- `git diff --check` 통과
- `npm run build` 통과
- `npm test` 통과 — 382 pass
- `npm run bench` 통과 — score 0.998, expected relations 49/49
- `npm audit --json` 통과 — vulnerabilities 0
- GPT-5.5 spec compliance re-review: `SPEC_PASS`
- GPT-5.5 code quality re-review: `QUALITY_PASS`
