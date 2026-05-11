# Commit Message: Contract Diff Event Topology Provenance

## 추천 커밋 메시지

```text
feat(contracts): event topology provenance 보존

- `analyzeContractDiff`가 resolved consumer link의 `eventTopology`를 impacted consumer 결과까지 전달해 removed AsyncAPI operation 영향이 producer/consumer 방향을 잃지 않게 정리
- `BREAKS_COMPATIBILITY_WITH` provenance에 provider action, counterparty role, pattern을 보존해 MCP/UI가 breaking impact를 다시 추론하지 않고 바로 표시할 수 있게 보강
- AsyncAPI removed operation focused test를 갱신해 topology hint가 result와 persisted breaking link에 같이 남는지 검증
- README, progress, roadmap, Phase 문서와 D-040 ADR을 갱신해 schema 변경 없이 provenance를 이어가는 결정을 문서화
```

## 변경 파일 요약

| 파일 | 내용 |
|---|---|
| `src/contract_diff.ts` | consumes link provenance의 optional `eventTopology`를 parse하고 impacted consumer/breaking link provenance로 전달 |
| `tests/contract-diff.test.ts` | removed AsyncAPI operation impact가 event topology를 result와 persisted provenance에 보존하는지 검증 |
| `README.md`, `CHANGELOG.md`, `docs/*.md` | contract diff topology provenance landed 상태와 D-040 ADR 반영 |

## 타입/스코프 근거

- 타입: `feat` — contract diff output과 persisted breaking impact provenance에 새 사용자-visible context가 추가된다.
- 스코프: `contracts` — 변경 중심이 `workspace contract-diff`의 breaking impact 생성이다.

## 검증

- `npm run check`
- `npx tsx --test tests/contract-diff.test.ts` — 64 pass
- `npm run docs:lint`
- `git diff --check`
- `npm run build`
- `npm run bench` — score 0.998, expected 49/49, unexpected 0
- `npm audit --json` — vulnerabilities 0
- `npm test` — 354 pass

## 리뷰

- GPT-5.5 spec compliance review — SPEC_PASS
- GPT-5.5 code quality review — CODE_QUALITY_PASS
