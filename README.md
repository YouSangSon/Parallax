# Impact Trace

Impact Trace는 Claude Code, Codex 같은 에이전트 코딩 도구를 위한 로컬 우선
코드 영향도 분석기입니다.

에이전트가 코드를 바꾸기 전에 Impact Trace가 저장소를 인덱싱하고, 변경 파일이
어떤 파일과 테스트에 영향을 줄 수 있는지 증거와 함께 보여줍니다.

핵심 방향은 명확합니다. 이 프로젝트는 graph DB 프로젝트가 아닙니다. MVP는
로컬 SQLite 인덱스를 사용하고, graph DB, vector search, CodeQL 같은 분석은
나중에 붙일 수 있는 선택 adapter로 둡니다.

핵심 분석 모델은 함수, 변수, 클래스, 파일 같은 코드 구성 요소를 서로 연결해서
인덱싱하는 것입니다. 변경이 들어오면 그 구성 요소를 참조하거나 호출하거나 import하는
다른 구성 요소를 따라가며 사이드 이펙트, 필요한 테스트, 개선 지점을 찾는 방향입니다.
장기적으로는 한 저장소 안의 코드뿐 아니라 여러 프로젝트가 REST API, gRPC/protobuf,
GraphQL, AsyncAPI/event contract로 연결되는 관계까지 같은 graph로 추적합니다.

## 현재 상태

MVP 구현이 들어가 있습니다.

현재 되는 것:

- repo-local `.impact-trace/` 작업 공간 생성
- 언어 중립 report model: `changed`, `affected`, `actions`, `evidence`
- 현재 내장 adapter로 TypeScript, JavaScript, Markdown 파일 인덱싱
- TS/JS export symbol 추출
- TS/JS import edge 추출
- import 기반 관련 테스트 추론
- Markdown mention 기반 관련 문서 추론
- 변경 파일 분석 후 JSON 또는 Markdown report 생성
- 공식 MCP SDK 기반 stdio server 제공
- read-only MCP tool 제공: `impact_trace_analyze_diff`
- evidence output 전 secret-like 값 redaction
- repo root 밖으로 나가는 path 거절

중요한 점: Impact Trace의 목표는 TS/JS 전용 도구가 아닙니다. MVP의 첫 extractor가
TS/JS와 Markdown일 뿐이고, 공개 report model은 언어별 문자열보다 `EntityRef`,
`ImpactTarget`, `ImpactAction` 같은 언어 중립 구조를 우선합니다. Python, Go, Rust,
Java, Kotlin, C#, C, C++ 같은 언어는 Tree-sitter, LSP, CodeQL, build-system adapter를
통해 추가하는 방향입니다.

이번 MVP에 없는 것:

- Obsidian write sync
- graph DB projection
- workspace/cross-repo contract index
- Mermaid/DOT/JSON graph visualization export
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
- `changed`
- `affected`
- `actions`
- `testCommands` deprecated: 기존 caller 호환용이며 `actions`를 사용하세요.
- `evidence`
- `indexRunId`
- `reportPath`

## MCP

Impact Trace는 공식 MCP SDK 기반의 read-only stdio server를 제공합니다. stdio는
로컬 프로세스로 실행되기 때문에 Claude Code, Codex 같은 코딩 에이전트가 현재
작업 중인 저장소를 직접 분석하게 만들기 좋습니다.

```bash
impact-trace mcp serve
```

먼저 분석 대상 저장소에서 인덱스를 만들어야 합니다.

```bash
impact-trace init
impact-trace index
```

MVP에서 노출하는 tool은 하나입니다.

| Tool | 역할 |
|---|---|
| `impact_trace_analyze_diff` | 변경 파일을 분석하고 CLI와 같은 report model을 반환합니다. |

write tool은 의도적으로 `tools/list`에 나오지 않습니다. Obsidian export 같은 write
capability는 별도 권한 모델과 리뷰를 거친 뒤 추가합니다.

### Claude Code 연결

`impact-trace`를 `npm link`로 PATH에 올린 경우, 분석 대상 저장소에서 아래처럼
추가합니다.

```bash
claude mcp add --transport stdio impact-trace -- impact-trace mcp serve
```

PATH에 올리지 않았다면 빌드된 CLI를 직접 지정할 수 있습니다.

```bash
claude mcp add --transport stdio impact-trace -- node <impact-trace-checkout>/dist/src/cli.js mcp serve
```

팀 공유가 필요하면 Claude Code의 project scope로 `.mcp.json`을 만들 수 있습니다.

```json
{
  "mcpServers": {
    "impact-trace": {
      "type": "stdio",
      "command": "impact-trace",
      "args": ["mcp", "serve"],
      "env": {}
    }
  }
}
```

참고: [Claude Code MCP 공식 문서](https://code.claude.com/docs/en/mcp)는 로컬 도구나
시스템 접근이 필요한 MCP 서버에 stdio transport를 권장하고,
`claude mcp add --transport stdio <name> -- <command>` 형식을 사용합니다.

### Codex 연결

Codex CLI로 추가할 수 있습니다.

```bash
codex mcp add impact-trace -- impact-trace mcp serve
codex mcp list
```

또는 `~/.codex/config.toml`이나 신뢰한 프로젝트의 `.codex/config.toml`에 직접
추가합니다.

```toml
[mcp_servers.impact-trace]
command = "impact-trace"
args = ["mcp", "serve"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

PATH에 올리지 않았다면:

```toml
[mcp_servers.impact-trace]
command = "node"
args = ["<impact-trace-checkout>/dist/src/cli.js", "mcp", "serve"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

참고: [Codex MCP 공식 문서](https://developers.openai.com/codex/mcp)는 CLI와 IDE
extension이 MCP 설정을 공유하며, stdio server를 `command`와 `args`로 설정한다고
설명합니다.

### stdio를 먼저 쓰는 이유

MVP의 tool은 긴 토큰 스트리밍이 아니라 “변경 파일 목록 입력 -> 영향도 report 반환”
흐름입니다. 그래서 HTTP/streaming server보다 로컬 stdio server가 단순하고 안전합니다.
나중에 인덱싱 시간이 길어지면 MCP progress notification, task support, HTTP transport를
추가할 수 있습니다.

## 안전 모델

Impact Trace는 로컬 소스 코드를 읽는 도구이므로, 첫 번째 안전 경계는 파일
접근입니다.

- 모든 file input은 realpath containment check를 거칩니다.
- repo root 밖으로 resolve되는 path는 거절합니다.
- evidence snippet은 output 전에 redaction합니다.
- MCP는 MVP에서 read-only이며 report persistence도 하지 않습니다.
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

인덱싱 모델:

- [인덱싱 모델 index](docs/indexing-model.md)
- [한국어 인덱싱 모델](docs/indexing-model.ko.md)
- [English indexing model](docs/indexing-model.en.md)

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

1. `entities`, `relations`, `relation_evidence`, `adapter_runs`, `index_coverage` 기반 canonical schema 추가
2. running index와 completed index를 분리해 snapshot-safe analysis 보장
3. `--base`, `--head` 기반 git diff 분석과 stale-index detection 추가
4. TypeScript Compiler API 기반 semantic adapter 추가
5. Python, Go, Rust adapter 추가
6. Java/Kotlin, C#/.NET, C/C++ adapter와 Maven/Gradle/dotnet/CMake/Bazel build-system resolver 추가
7. shell, YAML/JSON/TOML, CI, Docker, Kubernetes, Terraform, OpenAPI/protobuf/GraphQL/AsyncAPI, CODEOWNERS/policy adapter 추가
8. workspace catalog와 cross-repo API/gRPC/event contract impact 분석 추가
9. Mermaid/DOT/JSON graph visualization export와 MCP graph resource 추가
10. recursive entity traversal, fan-out warning, source-span evidence 추가
11. MCP report/evidence/entity/coverage/workspace/contract resources 추가
12. graph DB, vector, CodeQL, Obsidian export는 optional projection으로 추가

## License

MIT License입니다. 자세한 내용은 [LICENSE](LICENSE)를 확인해 주세요.
