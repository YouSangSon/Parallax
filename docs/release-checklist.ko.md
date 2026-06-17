# Parallax — 릴리스 체크리스트

[English](release-checklist.md) · **한국어** · [中文](release-checklist.zh.md)

Package를 publish하거나, release tag를 자르거나, engine behavior를 바꾸는 변경을 merge하기 전에 이 체크리스트를 사용한다.

Source checkout 참고: 이 gate들은 repository checkout이 필요하다. npm package는 compiled artifact를 싣지만, 이 script들이 호출하는 TypeScript source target인 `tests/**/*.test.ts`, `bench/impact-bench.ts`, `scripts/docs-lint.js`는 싣지 않는다.

Package surface 참고: `package.json`은 `prepack`으로 `npm run build`를 실행하므로 `npm pack`과 `npm publish`는 `dist/src`를 package에 담기 전에 현재 source에서 `dist/`를 다시 build한다.

## 필수 로컬 gate

Source checkout의 저장소 루트에서 실행한다.

```bash
npm run verify
```

`npm run verify`는 canonical aggregate gate다. 마지막 audit 단계는 npm registry와 network 상태에 의존한다.

## 각 gate가 증명하는 것

| Gate | 증명 | 필수 시점 |
| :--- | :--- | :--- |
| `npm run lint` | TypeScript typecheck와 docs lint 통과. | 모든 변경. |
| `npm run test:install-smoke` | Build된 CLI가 `dist/`에서 실행됨. 이 sub-gate가 `verify` 안의 유일한 build를 담당. | Release와 CI. |
| `npm test` | 빠른 unit/integration test 통과. | 모든 변경. |
| `npm run test:dogfood` | Parallax가 자기 자신을 index하고 실제 dependency graph를 보존. | Engine 변경. |
| `npm run bench` | Multi-language fixture recall, evidence, ranking, retrieval이 고정 기대치 안에 있음. | Adapter, analyzer, search, ranking, retrieval 변경. |
| `npm audit --audit-level=high` | 현재 lockfile에 high-level dependency advisory가 없음. | Release와 CI. |

## 문서 gate

사용자가 보는 동작이 바뀌면 다음을 확인한다.

1. Landing page 약속이 바뀌면 root README variants를 갱신한다.
2. CLI command, flag, output, exit code가 바뀌면 `docs/cli-reference*.md`를 갱신한다.
3. MCP tool, resource, annotation, side effect가 바뀌면 `docs/mcp*.md`를 갱신한다.
4. Adapter 계약이 바뀌면 `docs/extending-adapters*.md`를 갱신한다.
5. Subsystem boundary 또는 storage rule이 바뀌면 `docs/architecture*.md`를 갱신한다.
6. `npm run docs:lint`를 실행한다.

## Dependency gate

`npm audit fix`가 `package-lock.json`을 바꾸면 다음을 확인한다.

1. Direct dependency range가 꼭 바뀌어야 하는 경우가 아니라면 `package.json`이 그대로인지 확인한다.
2. Direct/transitive package bump를 검토한다.
3. `npm run test:install-smoke`를 실행한다.
4. `npm audit --audit-level=high`를 실행한다.

## Engine-change gate

Engine change는 indexer, adapter, analyzer, store, graph export, cross-repo resolver, MCP search, context-pack ranking path 아래의 변경이다.

이런 변경에는 다음을 적용한다.

1. 수정 전 실패하는 집중 테스트를 추가한다.
2. `npm test`를 실행한다.
3. `npm run test:dogfood`를 실행한다.
4. `npm run bench`를 실행한다.
5. Behavior 변경이 의도되었고 문서화되었을 때만 benchmark expectation을 갱신한다.

## 최종 review

Merge 전 확인한다.

1. `git diff --stat`을 검토한다.
2. `git diff`를 검토한다.
3. Local path, secret-like string, generated report가 stage되지 않았는지 확인한다.
4. `.parallax/`, `dist/`, `node_modules/`, `.worktrees/`가 untracked 상태로 남는지 확인한다.
5. CI가 `npm ci` 뒤에 `npm run verify`를 실행하는지 확인한다.
