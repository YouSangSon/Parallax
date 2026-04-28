# Impact Trace

Impact Trace는 Claude Code, Codex 같은 에이전트 코딩 도구를 위한 로컬 우선
코드 영향도 분석기입니다.

에이전트가 코드를 바꾸기 전에 Impact Trace가 저장소를 인덱싱하고, 변경 파일이
어떤 파일과 테스트에 영향을 줄 수 있는지 증거와 함께 보여줍니다.

핵심 방향은 명확합니다. 이 프로젝트는 graph DB 프로젝트가 아닙니다. MVP는
로컬 SQLite 인덱스를 사용하고, graph DB, vector search, CodeQL 같은 분석은
나중에 붙일 수 있는 선택 adapter로 둡니다.

## 현재 상태

MVP 구현이 들어가 있습니다.

현재 되는 것:

- repo-local `.impact-trace/` 작업 공간 생성
- TypeScript, JavaScript, Markdown 파일 인덱싱
- TS/JS export symbol 추출
- TS/JS import edge 추출
- import 기반 관련 테스트 추론
- Markdown mention 기반 관련 문서 추론
- 변경 파일 분석 후 JSON 또는 Markdown report 생성
- read-only MCP tool 제공: `impact_trace_analyze_diff`
- evidence output 전 secret-like 값 redaction
- repo root 밖으로 나가는 path 거절

이번 MVP에 없는 것:

- Obsidian write sync
- graph DB projection
- CodeQL adapter
- 모든 언어의 full semantic analysis
- file/symbol MCP resource
- 에이전트가 직접 코드를 수정하는 기능

## 요구 사항

- Node.js `>=24.0.0`
- npm

현재 구현은 Node의 built-in `node:sqlite`를 사용합니다. Node 24에서는 이 API가
아직 experimental 상태라서 DB를 사용하는 명령에서 experimental warning이 보일
수 있습니다.

## 빠른 시작

이 저장소에서 빌드합니다.

```bash
npm install
npm run build
```

이 checkout 안에서 `impact-trace` 명령을 바로 쓰고 싶으면:

```bash
npm link
```

분석하고 싶은 저장소에서 실행합니다.

```bash
impact-trace init
impact-trace index
impact-trace analyze --changed src/auth/session.ts
```

JSON 출력이 필요하면:

```bash
impact-trace analyze --changed src/auth/session.ts --json
```

Markdown report는 아래 경로에 생성됩니다.

```text
.impact-trace/reports/
```

## CLI

```bash
impact-trace init
impact-trace index
impact-trace analyze --changed src/file.ts [--json]
impact-trace mcp serve
```

### `init`

현재 저장소에 Impact Trace 작업 공간을 만듭니다.

```text
.impact-trace/
  config.json
  impact.db
```

### `index`

현재 저장소를 스캔해서 로컬 SQLite DB에 저장합니다.

저장하는 정보:

- 파일 목록
- exported symbol
- import edge
- 추론된 test edge
- 추론된 doc edge
- redacted evidence snippet

### `analyze`

최신 completed index run을 기준으로 변경 파일의 영향 범위를 분석합니다.

```bash
impact-trace analyze --changed src/a.ts
impact-trace analyze --changed src/a.ts,src/b.ts --json
```

JSON report에는 아래 정보가 들어갑니다.

- `changedFiles`
- `affectedFiles`
- `testCommands`
- `evidence`
- `indexRunId`
- `reportPath`

## MCP

read-only MCP server를 시작합니다.

```bash
impact-trace mcp serve
```

MVP에서 노출하는 tool은 하나입니다.

| Tool | 역할 |
|---|---|
| `impact_trace_analyze_diff` | 변경 파일을 분석하고 CLI와 같은 report model을 반환합니다. |

write tool은 의도적으로 `tools/list`에 나오지 않습니다. Obsidian export 같은 write
capability는 별도 권한 모델과 리뷰를 거친 뒤 추가합니다.

## 안전 모델

Impact Trace는 로컬 소스 코드를 읽는 도구이므로, 첫 번째 안전 경계는 파일
접근입니다.

- 모든 file input은 realpath containment check를 거칩니다.
- repo root 밖으로 resolve되는 path는 거절합니다.
- evidence snippet은 output 전에 redaction합니다.
- MCP는 MVP에서 read-only입니다.
- 프로젝트 command 실행은 MVP 범위 밖입니다.
- `.impact-trace/`는 git ignore 대상입니다.

redaction layer는 OpenAI-style key, GitHub token, AWS access key, private key
block 같은 흔한 secret 형태를 가립니다. 이것은 안전망이지, source file에 secret을
넣어도 된다는 뜻은 아닙니다.

## 개발

```bash
npm test
npm run lint
npm run test:security
npm run test:mcp
npm run test:install-smoke
npm audit --audit-level=high
```

주요 script:

| Script | 역할 |
|---|---|
| `npm run build` | TypeScript를 `dist/`로 compile합니다. |
| `npm run check` | emit 없이 typecheck합니다. |
| `npm test` | Node test runner suite를 `tsx`로 실행합니다. |
| `npm run docs:lint` | committed Markdown에 local path나 secret-like content가 들어가는 것을 막습니다. |
| `npm run test:mcp` | read-only MCP 동작과 path validation을 검증합니다. |
| `npm run test:security` | path containment와 redaction을 검증합니다. |

## 문서

제품/엔지니어링 계획:

- [계획서 index](docs/impact-trace-plan.md)
- [한국어 계획서](docs/impact-trace-plan.ko.md)
- [English plan](docs/impact-trace-plan.en.md)

테스트 계획:

- [테스트 계획 index](docs/impact-trace-test-plan.md)
- [한국어 테스트 계획](docs/impact-trace-test-plan.ko.md)
- [English test plan](docs/impact-trace-test-plan.en.md)

## 기여

기여를 환영합니다. 시작하기 전에 [CONTRIBUTING.md](CONTRIBUTING.md)를 읽어
주세요.

보안 이슈는 공개 issue에 민감한 정보를 올리지 말고 [SECURITY.md](SECURITY.md)의
방식으로 신고해 주세요.

## Roadmap

1. `--changed` 입력 대신 실제 git diff parsing 추가
2. npm, pnpm, yarn, bun workspace graph 추출
3. TypeScript Compiler API 기반 semantic analysis 강화
4. recall/precision gate가 있는 benchmark fixture 추가
5. Obsidian dry-run sync 추가 후 guarded write sync 추가
6. graph, vector, CodeQL adapter 선택 지원

## License

MIT License입니다. 자세한 내용은 [LICENSE](LICENSE)를 확인해 주세요.
