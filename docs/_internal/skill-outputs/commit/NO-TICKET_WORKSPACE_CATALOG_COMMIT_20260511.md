# Commit Message 제안 — Workspace catalog v0

## 변경 요약

| 파일 | 내용 |
|---|---|
| `src/workspace.ts` | `.impact-trace/workspace.json` 기반 local workspace catalog API를 추가하고 기존 `repos`/`workspaces`/`workspace_repos` 테이블과 동기화 |
| `src/cli.ts`, `src/index.ts` | `workspace init/add-repo/list` CLI와 public workspace API export 추가 |
| `tests/workspace.test.ts` | idempotent init, sibling repo 등록, catalog source-of-truth sync, symlink/arbitrary-file/path validation 회귀 테스트 추가 |
| `README.md`, `CHANGELOG.md`, `docs/*` | workspace catalog v0 landed 상태, D-026 ADR, 다음 cross-repo resolver/contract diff 작업을 문서화 |

## 선택한 타입/스코프

- type: `feat` — local workspace catalog와 CLI라는 사용자 가시 기능 추가
- scope: `workspace` — multi-repo allowlist와 workspace 동기화 surface가 중심

## Commit Message

```text
feat(workspace): local catalog CLI 추가

- `.impact-trace/workspace.json`을 local-first workspace allowlist로 추가하고 기존 SQLite workspace/repo 테이블에 idempotent하게 동기화
- `workspace init/add-repo/list` CLI와 public API export를 추가해 Claude/Codex MCP 흐름에서 등록된 local repo/service를 조회할 수 있게 구현
- catalog 파일을 source-of-truth로 고정해 list 전에 DB를 재동기화하고 rename/removal stale row를 정리하며 같은 realpath repo는 결정적으로 업데이트
- symlink catalog overwrite, non-default catalog file sync, URL/git-style path, missing/file path, duplicate resolved path를 차단하는 검증과 회귀 테스트를 보강
- D-026 ADR, roadmap, Phase 6 문서, README, changelog가 workspace catalog landed 상태와 다음 cross-repo resolver/contract diff slice를 설명하도록 갱신
```

## 검증

- `npm run check`
- `npx tsx --test tests/workspace.test.ts` — 8 pass
- `npm test` — 252 pass
- `npm run docs:lint`
- `git diff --check`
- `npm audit --json` — 0 vulnerabilities
- `npm run bench` — score 0.9978, 46/46 expected relations matched
- GPT-5.5 spec reviewer — `SPEC_PASS`
