# Parallax — 운영 Runbook

[English](operations.md) · **한국어** · [中文](operations.zh.md)

Parallax가 현재 작업트리와 다르게 동작하거나, MCP 설정이 실패하거나, 로컬 데이터베이스가 없거나, CI가 실패할 때 이 runbook을 사용한다. Parallax의 운영 상태는 `.parallax/impact.db`에 저장된다. source file은 그대로 저장소에 남는다.

## 첫 확인

대상 저장소 루트에서 다음 명령을 실행한다.

```bash
parallax doctor
npm run lint
npm test
```

`parallax doctor`는 가장 빠른 health report다. 데이터베이스, schema version, 최신 index, coverage, adapter run, vector 상태, context telemetry를 확인한다.

## 데이터베이스가 없을 때

증상:

- `parallax doctor`가 `database_missing`을 보고한다.
- MCP tool이 `.parallax/impact.db`가 없다는 오류를 반환한다.

해결:

```bash
parallax init
parallax index
parallax doctor
```

데이터베이스가 실수로 삭제된 경우에도 다시 index하면 된다. 데이터베이스는 로컬 저장소와 명시적인 memory command에서 파생된다.

## Index가 stale일 때

증상:

- `analyze`가 최신 index가 다른 git commit에서 만들어졌다고 경고한다.
- `analyze`가 index 이후 working tree dirty state가 바뀌었다고 경고한다.
- changed file이 최신 index에 없다.

해결:

```bash
parallax index
parallax analyze --base main --head HEAD --json
```

경고가 남아 있으면 `git status --short`를 실행하고, generated file, renamed file, ignored file이 index 이후 바뀌었는지 확인한다.

## Coverage가 skipped일 때

증상:

- `doctor`가 `coverage_skipped_paths`를 보고한다.
- UI Analysis Trust 패널에 coverage gap이 보인다.
- `parallax://coverage/latest`에 skipped row가 있다.

해결:

1. `parallax doctor` 또는 UI에서 skipped path와 reason을 확인한다.
2. 파일이 의도적으로 너무 크다면 gap을 문서화하고 유지한다.
3. 파일을 index해야 한다면 더 큰 limit으로 다시 실행한다.

```bash
parallax index --max-file-bytes 2000000
```

Vendored file이나 generated file에 limit을 무작정 올리지 않는다. 가능하면 ignore rule에 넣거나 indexed tree 밖에 둔다.

## Adapter가 실패할 때

증상:

- `doctor`가 `failed` adapter run을 보여준다.
- `analyze`가 `adapterInsights`에 adapter error를 보여준다.

해결:

1. Adapter `errorSummary`를 읽는다.
2. 가능한 가장 작은 repository fixture로 재현한다.
3. Adapter behavior를 바꾸기 전에 `tests/` 아래에 테스트를 추가한다.
4. 다음 명령을 실행한다.

```bash
npm run check
npm test
npm run test:dogfood
npm run bench
```

Engine change는 unit test가 통과해도 실제 graph가 깨질 수 있으므로 dogfood와 bench가 필요하다.

## MCP 설정이 실패할 때

증상:

- MCP client가 `parallax mcp serve`를 시작하지 못한다.
- Client에서 tool이 보이지 않는다.
- Server가 잘못된 저장소에서 시작된다.

해결:

1. CLI가 실행되는지 확인한다.

```bash
parallax --help
```

2. 작업 디렉터리가 대상 저장소 루트인지 확인한다.
3. 다음을 실행한다.

```bash
parallax init
parallax index
parallax mcp serve
```

4. MCP server를 client에 stdio command로 등록한다. 에이전트가 수정할 저장소 루트를 그대로 사용한다.

MCP는 source file을 수정하지 않는다. analysis/search/context 호출은 `.parallax/impact.db`에 context-pack 또는 tool telemetry row를 저장할 수 있고, MCP resource read는 resource-access telemetry row를 저장할 수 있다.

## Node 24 SQLite warning

증상:

- Node가 `node:sqlite` experimental warning을 출력한다.

의미:

Parallax는 Node.js 24 built-in SQLite를 의도적으로 사용한다. 현재 Node release에서는 이 warning이 예상되며 데이터 손실을 뜻하지 않는다.

조치:

- Node.js를 `>=24.0.0`으로 유지한다.
- CI의 machine parsing을 깨뜨리는 경우가 아니라면 warning을 억제하지 않는다.

## Workspace catalog 문제

증상:

- Cross-repo contract resolution이 link를 반환하지 않는다.
- Repository path가 거부된다.
- Workspace가 예상과 다른 service를 보여준다.

해결:

```bash
parallax workspace list --json
parallax workspace init --name platform --service api --force
parallax workspace add-repo ../web --name platform --service web
parallax workspace resolve-contracts --name platform --json
```

Workspace entry는 명시적인 local path다. Parallax는 저장소를 clone하지 않고, 사용자가 등록하지 않은 path를 scan하지 않는다.

## CI 실패 triage

CI는 `npm ci` 뒤에 aggregate gate인 `npm run verify`를 실행한다. Source checkout에서 `npm run verify`를 먼저 재현한 다음, log의 첫 실패 subcommand로 범위를 좁힌다.

| 실패 command | 보통 의미 | 첫 조치 |
| :--- | :--- | :--- |
| `npm run verify` | release sub-gate 중 하나가 실패함 | 로컬에서 다시 실행한 뒤, 아래의 첫 실패 subcommand 항목으로 이동한다. |
| `npm audit --audit-level=high` | 현재 lockfile에 dependency advisory가 있음 | `npm audit fix`를 실행하고 lockfile을 검토한 뒤 테스트를 다시 실행한다. |
| `npm run lint` | Typecheck 또는 docs lint 실패 | 로컬에서 명령을 실행하고 첫 번째 보고 파일부터 고친다. |
| `npm run build` | TypeScript compile output 실패 | `npm run check`를 실행하고 type 또는 module error를 고친다. |
| `npm test` | 빠른 unit/integration suite 실패 | 이름이 나온 test file을 로컬에서 재현한다. |
| `npm run test:dogfood` | 실제 self-index graph 회귀 | indexer/adapters/analyzer/store 변경을 먼저 본다. |
| `npm run bench` | Accuracy 또는 retrieval 회귀 | bench report를 비교하고 의도한 behavior 변경일 때만 expectation을 갱신한다. |
| `npm run test:install-smoke` | packaged CLI가 실행되지 않음 | `npm run build && node dist/src/cli.js --help`를 실행한다. |

## 복구 규칙

확신이 없으면 새 파생 상태를 만든다.

```bash
rm -rf .parallax
parallax init
parallax index
parallax doctor
```

로컬 memory fact가 필요 없는 저장소에서만 이 작업을 한다. 데이터베이스 안에 중요한 결정이 있다면 `.parallax`를 삭제하기 전에 export하거나 백업한다.
