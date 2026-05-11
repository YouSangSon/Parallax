# Commit Message: UI Workspace Topology Surface

## 추천 커밋 메시지

```text
feat(ui): workspace topology surface 추가

- `buildUiSnapshot`과 `/api/workspaces/{name}`가 workspace contract baseline, provider/consumer link, event topology hint를 compact shape로 반환해 agent와 사람이 같은 context surface를 보게 보강
- `impact-trace ui`에 Workspace Contracts/Resources panel을 추가해 full provenance나 raw contract body를 펼치지 않고 service, route, topology, resource URI를 바로 확인하게 정리
- 실제 AsyncAPI workspace fixture와 legacy provenance/unindexed repo fallback 테스트를 추가해 event topology happy path와 degraded path가 모두 깨지지 않도록 고정
- D-042 ADR, progress, roadmap, Phase 문서, README, changelog를 갱신해 UI가 MCP resource-on-demand 모델을 재사용하는 결정을 문서화
```

## 변경 파일 요약

| 파일 | 내용 |
|---|---|
| `src/ui.ts` | UI snapshot/API에 workspace contract/link/topology preview와 `/api/workspaces/{name}` endpoint 추가 |
| `tests/ui.test.ts` | AsyncAPI workspace topology, API endpoint, malformed provenance, unindexed repo warning 회귀 테스트 추가 |
| `docs/decisions.ko.md` | D-042 ADR로 UI workspace topology surface 결정 기록 |
| `README.md`, `CHANGELOG.md`, `docs/*.md` | UI workspace topology surface v0 landed 상태와 다음 work 정리 |

## 타입/스코프 근거

- 타입: `feat` — read-only UI와 JSON API에 새 workspace topology 기능이 추가된다.
- 스코프: `ui` — 변경 중심이 `impact-trace ui` snapshot, HTML panel, UI API surface다.

## 검증

- `npm run check`
- `npx tsx --test tests/ui.test.ts` — 7 pass
- `npm run docs:lint`
- `git diff --check`
- `npm run build`
- `npm run bench` — score 0.998, expected 49/49, unexpected 0
- `npm audit --json` — vulnerabilities 0
- `npm test` — 356 pass

## 리뷰

- GPT-5.5 spec compliance review — SPEC_PASS
- GPT-5.5 code quality review — CODE_QUALITY_PASS
- code quality residual note였던 malformed provenance/unindexed repo fallback은 추가 회귀 테스트로 보강
