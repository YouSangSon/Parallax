# Impact Trace 테스트 계획

생성일: 2026-04-28

영어 버전: [impact-trace-test-plan.en.md](impact-trace-test-plan.en.md)

## 범위

이 테스트 계획은 Impact Trace의 첫 구현을 다룬다: local-first repo indexer,
diff impact analyzer, Markdown/Obsidian exporter, CLI, MCP server.

## 테스트 다이어그램

```text
git diff
  -> changed files
  -> changed symbols
  -> reverse dependency walk
  -> risk classifier
  -> affected tests/docs/routes
  -> evidence packet
  -> CLI / MCP / Markdown export
```

## Unit Tests

| 영역 | 필수 테스트 |
|---|---|
| Path safety | repo root 밖 path 거절, symlink normalize, absolute path escape 차단. |
| Git diff parser | untracked file, rename, delete, binary file, merge-base diff 처리. |
| Symbol extractor | exported/imported TypeScript symbol, local function, class, call hint 추출. |
| Dependency index | file/symbol/import edge insert/update/delete가 idempotent해야 한다. |
| Impact walk | reverse import traversal, depth limit, deterministic ordering. |
| Risk classifier | model guess가 아니라 evidence 기반 deterministic severity 생성. |
| Report renderer | source file link와 confidence label을 포함한 stable Markdown rendering. |
| Obsidian exporter | unrelated vault file을 clobber하지 않음. |
| MCP server | input validation, JSON-RPC error, resource consistency. |
| Secret redaction | SQLite write, MCP response, Markdown report, Obsidian export 전에 planted secret이 redacted되는지 확인. |
| SQLite concurrency | WAL mode, one-writer lock, busy timeout, pinned `index_run_id` read, crash recovery. |
| Package/workspace graph | npm/pnpm/yarn/bun workspace, `tsconfig` paths/references, `exports`, import map 감지. |
| CLI/MCP contracts | JSON schema, exit code, typed error envelope, pagination, schema version 검증. |
| Doc lint | local absolute home path, hidden tool state, machine-local metadata가 committed docs에 들어오면 실패. |

## Integration Tests

| Fixture Repo | Scenario | Expected Result |
|---|---|---|
| TypeScript library | exported function signature 변경. | direct importer, test, README example, call site가 보고된다. |
| Next.js app | shared component prop 변경. | 해당 component를 쓰는 page/route와 visual state가 보고된다. |
| Node CLI | command option parser 변경. | CLI help test, docs example, command handler가 보고된다. |
| Python package | imported function 변경. | import graph fallback이 낮은 confidence로 affected module을 찾는다. |
| Monorepo | shared package 변경. | workspace dependent와 package-level test command가 보고된다. |
| Secret fixture | planted token/cert가 들어 있는 파일 변경. | report에는 redacted snippet만 있고 raw reveal은 explicit opt-in이 필요하다. |
| Concurrent fixture | indexing 중 MCP가 report를 읽음. | MCP는 partial state가 아니라 완성된 `index_run_id`만 본다. |

## 정확도 게이트

| Metric | v1 Gate |
|---|---:|
| golden diff 기준 affected-file recall | >= 90% |
| critical false-negative count | 0 |
| test recommendation precision | >= 70% |
| stale-index detection | fixture case 100% |
| secret redaction failures | planted leak 0건 |

## E2E Tests

1. fixture repo에서 `impact-trace init`이 local config와 database를 생성한다.
2. `impact-trace index`가 deterministic index를 만든다.
3. `impact-trace analyze --base main --head feature`가 Markdown report를 생성한다.
4. MCP client가 read-only `impact_trace_analyze_diff`를 호출하고 같은 evidence ID를 받는다.
5. `impact-trace obsidian sync --vault <tmp-vault>`는 기본 dry-run이다.
6. `impact-trace obsidian sync --vault <tmp-vault> --write`가 conflict protection과 함께 backlink 포함 note를 쓴다.

## Regression Rule

impact traversal에서 발견되는 모든 버그는 수정 전에 fixture repo 또는 fixture
diff를 추가해야 한다. snapshot test는 underlying evidence ID가 포함될 때만
허용한다.

## Verification Commands

```bash
npm test
npm run lint
npm run typecheck
npm run test:fixtures
npm run test:security
npm run test:mcp
npm run test:benchmark
npm run test:install-smoke
npm run docs:lint
```
