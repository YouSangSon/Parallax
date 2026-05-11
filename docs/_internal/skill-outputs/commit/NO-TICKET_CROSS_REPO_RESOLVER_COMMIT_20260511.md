# Commit Message 제안 — Cross-repo contract resolver v0

## 변경 요약

| 파일 | 내용 |
|---|---|
| `src/cross_repo_resolver.ts` | workspace catalog에 등록된 indexed local repo를 read-only로 열고 OpenAPI provider endpoint와 HTTP consumer file literal을 `cross_repo_links`로 연결 |
| `src/cli.ts`, `src/index.ts` | `workspace resolve-contracts` CLI와 `resolveCrossRepoContracts` public API export 추가 |
| `tests/cross-repo-resolver.test.ts` | provider/consumer link, stale provider/consumer, deleted file, symlink escape, tampered DB path escape 회귀 테스트 추가 |
| `docs/*`, `README.md`, `CHANGELOG.md` | D-027 ADR, resolver landed 상태, 다음 contract diff/breaking-change slice를 문서화 |

## 선택한 타입/스코프

- type: `feat` — workspace 기반 cross-repo provider/consumer resolver라는 사용자 가시 기능 추가
- scope: `workspace` — workspace catalog 위에서 동작하는 multi-repo contract link surface가 중심

## Commit Message

```text
feat(workspace): cross-repo contract resolver 추가

- `resolveCrossRepoContracts`와 `workspace resolve-contracts` CLI를 추가해 workspace catalog에 등록된 indexed local repo 사이의 OpenAPI provider endpoint와 HTTP consumer file을 연결
- 각 repo의 기존 Impact Trace DB를 read-only로 열고 root workspace DB의 기존 `cross_repo_links` 테이블에 deterministic `CONSUMES_HTTP_ENDPOINT` link와 provenance JSON을 저장
- provider contract와 consumer file을 모두 `resolveInsideRoot`와 indexed hash로 검증해 stale file, deleted file, symlink escape, tampered DB path escape를 warning+skip으로 처리
- cross-repo resolver 회귀 테스트 6개를 추가해 happy path와 stale/provider/consumer/path-boundary 보안 케이스를 고정
- D-027 ADR, roadmap, Phase 6 문서, README, changelog가 resolver landed 상태와 다음 contract diff/breaking-change slice를 설명하도록 갱신
```

## 검증

- `npm run check`
- `npx tsx --test tests/cross-repo-resolver.test.ts` — 6 pass
- `npx tsx --test tests/cross-repo-resolver.test.ts tests/workspace.test.ts` — 14 pass
- `npm test` — 258 pass
- `npm run docs:lint`
- `git diff --check`
- `npm audit --json` — 0 vulnerabilities
- `npm run bench` — score 0.9978, 46/46 expected relations matched
- GPT-5.5 spec reviewer — `SPEC_PASS`
- GPT-5.5 code quality reviewer — `CODE_PASS`
