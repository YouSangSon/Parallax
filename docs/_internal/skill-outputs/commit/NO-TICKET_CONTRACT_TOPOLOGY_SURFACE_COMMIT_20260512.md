# Commit Message: Contract Topology Surface

## 추천 커밋 메시지

```text
feat(contracts): topology surface 요약 추가

- `analyzeContractDiff` summary에 event topology count와 breakdown을 추가해 removed event impact의 producer/consumer 방향을 compact payload에서 바로 확인하게 보강
- `workspace contract-diff` human output이 impacted consumer line에 topology hint를 표시해 CLI에서 nested provenance를 다시 파싱하지 않아도 되게 정리
- MCP `/cross-repo-links` resource가 provenance를 유지하면서 top-level `eventTopology` shortcut을 제공해 agent/UI가 link 목록을 더 작게 필터링할 수 있게 개선
- contract diff와 MCP 회귀 테스트, README, progress, roadmap, Phase 문서와 D-041 ADR을 갱신해 optional compact surface 결정을 문서화
```

## 변경 파일 요약

| 파일 | 내용 |
|---|---|
| `src/contract_diff.ts` | impacted consumer topology를 summary count/breakdown으로 집계 |
| `src/cli.ts` | non-JSON `workspace contract-diff` 출력에 topology hint 표시 |
| `src/mcp.ts` | `/cross-repo-links` resource link row에 optional top-level `eventTopology` shortcut 추가 |
| `tests/contract-diff.test.ts`, `tests/mcp.test.ts` | summary/CLI/MCP topology surface 회귀 테스트 |
| `README.md`, `CHANGELOG.md`, `docs/*.md` | contract topology surface v0와 D-041 ADR 반영 |

## 타입/스코프 근거

- 타입: `feat` — contract diff/MCP/CLI public surface에 새 compact topology context가 추가된다.
- 스코프: `contracts` — 변경 중심이 workspace contract impact surface다.

## 검증

- `npm run check`
- `npx tsx --test tests/contract-diff.test.ts tests/mcp.test.ts` — 115 pass
- `npm run docs:lint`
- `git diff --check`
- `npm run build`
- `npm run bench` — score 0.998, expected 49/49, unexpected 0
- `npm audit --json` — vulnerabilities 0
- `npm test` — 354 pass

## 리뷰

- GPT-5.5 spec compliance re-review — SPEC_PASS
- GPT-5.5 code quality review — CODE_QUALITY_PASS
