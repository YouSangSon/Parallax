# Commit Message: Generated Client / Event Topology Resolver

## 추천 커밋 메시지

```text
feat(workspace): generated client event topology 추가

- `resolveCrossRepoContracts`가 Connect-ES `createClient` 생성 client 호출과 `pkg.Service/Rpc` Protobuf route string을 인식해 generated client 사용 코드를 downstream impact로 연결
- AsyncAPI event matcher가 Spring Kafka, KafkaJS, Python, Go, Rust 계열 producer/consumer call-site를 분류해 event direction을 compact provenance로 남김
- source comment, generated protobuf descriptor, producer-only SEND mismatch 같은 false positive 회귀 테스트를 추가해 heuristic resolver 경계를 고정
- README, progress, roadmap, Phase 문서와 D-039 ADR을 갱신해 EventCatalog, AsyncAPI parser/diff, Buf/protoc를 runtime dependency로 들이지 않는 결정을 문서화
```

## 변경 파일 요약

| 파일 | 내용 |
|---|---|
| `src/cross_repo_resolver.ts` | Protobuf full route matching, Connect-ES style service anchor support, AsyncAPI producer/consumer topology hint, comment-line false positive guard 추가 |
| `tests/cross-repo-resolver.test.ts` | generated client, full RPC path, source comment guard, Spring Kafka listener, producer-side RECEIVE, SEND/producer mismatch 회귀 테스트 추가 |
| `README.md`, `CHANGELOG.md`, `docs/*.md` | generated-client/event topology v0 landed 상태, D-039 ADR, 후속 full parser/LSP/richer topology 범위 갱신 |

## 타입/스코프 근거

- 타입: `feat` — workspace resolver가 새 generated-client/event topology impact surface를 제공한다.
- 스코프: `workspace` — 변경 중심이 `workspace resolve-contracts`의 cross-repo link 생성이다.

## 검증

- `npm run check`
- `npx tsx --test tests/cross-repo-resolver.test.ts` — 29 pass
- `npm run docs:lint`
- `git diff --check`
- `npm test` — 354 pass
- `npm run build`
- `npm run bench` — score 0.998, expected 49/49, unexpected 0
- `npm audit --json` — vulnerabilities 0
- GPT-5.5 spec review — SPEC_PASS
- GPT-5.5 code-quality review — CODE_QUALITY_PASS
