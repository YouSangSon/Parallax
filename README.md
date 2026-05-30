<div align="center">

# 🛰️ Parallax

**Give coding agents a local map of what a change can break.**

Claude Code, Codex, Cursor 같은 에이전트가 코드를 고치기 전에<br/>
저장소를 로컬에서 인덱싱하고, 변경 파일이 건드릴 수 있는 코드·테스트·문서·계약을 증거와 함께 보여주는 impact intelligence 도구.

![status](https://img.shields.io/badge/status-MVP%20working-7c3aed)
![node](https://img.shields.io/badge/node-%3E%3D24.0.0-339933)
![storage](https://img.shields.io/badge/storage-SQLite%20%2B%20sqlite--vec-2563eb)
![mcp](https://img.shields.io/badge/MCP-stdio-14b8a6)
![license](https://img.shields.io/badge/license-MIT-3da639)

[🚀 빠른 시작](#-빠른-시작) · [✨ 주요 기능](#-주요-기능) · [🧱 핵심 개념](#-핵심-개념) · [🤖 MCP](#-mcp--agents) · [🔒 안전 모델](#-안전-모델) · [🗺️ Roadmap](#%EF%B8%8F-roadmap) · [📚 더 읽기](#-더-읽기)

<img src="docs/assets/parallax-ui-demo.png" alt="Parallax Impact Workbench UI showing report delta, impact summary, visual impact map, verification queue, affected paths, and evidence" width="100%">

</div>

---

> **왜 필요한가** — AI coding 도구는 빠르지만, `auth.ts`의 함수 하나를 바꿨을 때 어떤 테스트·consumer·정책 문서가 같이 흔들리는지 매번 추측한다. Parallax는 repo-local `.parallax/impact.db`에 코드 그래프와 agent memory를 저장해, 에이전트가 변경 전에 “무엇이 왜 영향받는지”를 작은 context pack으로 확인하게 만든다.

---

## 🚀 빠른 시작

### 요구사항

| 항목 | 필요 조건 | 비고 |
| :--- | :--- | :--- |
| **Node.js** | `>=24.0.0` | Node built-in `node:sqlite` 사용. experimental warning이 보일 수 있음 |
| **npm** | package-lock 기준 | `npm install`로 개발 환경 구성 |
| **저장소 권한** | 로컬 read/write | `.parallax/` 디렉터리와 SQLite DB 생성 |
| **외부 서비스** | 기본 impact 경로는 불필요 | 모델/LLM 기반 memory 정리는 명시 실행 시에만 사용 |

```bash
# 1. Parallax 빌드
npm install
npm run build

# 2. 현재 checkout의 CLI를 PATH에 연결
npm link

# 3. 분석 대상 repo에서 초기화와 인덱싱
cd /path/to/target-repo
parallax init
parallax index
```

변경 파일 하나를 분석한다.

```bash
parallax analyze --changed src/auth/session.ts --depth 2
```

git diff 범위를 그대로 분석할 수도 있다.

```bash
parallax analyze --base main --head HEAD --json
```

Markdown report는 repo-local 경로에 저장된다.

```text
.parallax/reports/
```

로컬 UI로 최신 report를 바로 열 수 있다.

```bash
parallax ui
parallax ui --report <report-id> --port 3717
```

> 💡 `analyze`는 영향받는 파일이 있으면 exit code `1`을 반환한다. CI나 agent guardrail에서 “영향 있음”을 신호로 쓰기 위한 의도적인 동작이다.

---

## ✨ 주요 기능

### 🔎 Impact analysis

| 기능 | 동작 |
| :--- | :--- |
| **로컬 인덱스** | `.parallax/impact.db`에 파일, entity, relation, evidence, coverage를 저장 |
| **변경 분석** | `--changed` 또는 `--base/--head` 입력을 bounded multi-hop graph traversal로 분석 |
| **증거 중심 report** | `changed`, `affected`, `actions`, `evidence`, `adapterInsights`, `warnings`를 JSON/Markdown으로 출력 |
| **관련 테스트 추론** | import, filename convention, adapter evidence를 이용해 영향 가능성이 높은 테스트를 추천 |
| **Graph export** | 저장된 report를 Mermaid, JSON, DOT으로 export |
| **Coverage 경고** | oversized file skip, stale index, adapter known-gap을 report에 노출 |

### 🧭 Adapter coverage

| 영역 | 현재 상태 |
| :--- | :--- |
| **TypeScript / JavaScript** | parser-backed import, declaration, class/interface heritage, call-site, typed receiver, factory-return, constructor/field call span 확대 중 |
| **JVM / Spring Boot** | endpoint, declaration, config, test evidence span v0 |
| **Python / Go / Rust** | declaration/test relation 중심 lightweight adapter |
| **Markdown / work artifacts** | policy, proposal, PRD, decision 문서를 first-class artifact로 분류하고 코드와 연결 |
| **Config / Infra** | shell, YAML, JSON, TOML, Dockerfile, Makefile, Terraform, CODEOWNERS 등 system/config 후보 인덱싱 |
| **Package manifests** | `package.json`, `pom.xml`, `build.gradle(.kts)`, `go.mod`, `Cargo.toml`, `pyproject.toml` manifest graph |

### 🌐 Workspace & contracts

| 기능 | 설명 |
| :--- | :--- |
| **Workspace catalog** | `.parallax/workspace.json`에 사용자가 허용한 local repo만 등록. clone/network 없음 |
| **Cross-repo resolver** | 등록된 repo 사이의 provider endpoint ↔ consumer file link를 저장 |
| **Contract diff** | OpenAPI, GraphQL, Protobuf, AsyncAPI surface diff를 `breaking` / `non-breaking` / `unknown`으로 분류 |
| **Consumer impact** | removed endpoint/operation, field removal/type change, required request field 추가 등을 known consumer와 연결 |
| **Event topology hint** | AsyncAPI producer/consumer 방향과 breaking provenance를 compact payload로 제공 |

```bash
parallax workspace init --name platform --service api
parallax workspace add-repo ../web --name platform --service web
parallax workspace resolve-contracts --name platform --json
parallax workspace contract-diff --contract openapi.yaml --name platform --json
```

### 🧠 Agent memory

같은 SQLite DB 위에서 agent의 결정·관찰·근거를 content-addressable fact로 저장한다.

| 명령 | 역할 |
| :--- | :--- |
| `remember` | entity에 대한 결정/관찰 fact 저장. `supersedes`로 오래된 fact 대체 |
| `recall` | entity, attribute, keyword, semantic query로 fact 조회 |
| `branch` / `merge` | 여러 plan을 데이터 복사 없이 fork/merge |
| `trace` | fact_provenance edge를 따라 결정의 근거 사슬 추적 |
| `profile` | 한 entity의 static facts, dynamic facts, summary facts를 한 번에 반환 |
| `reflect` | 오래된 facts를 LLM으로 요약해 summary fact로 승격 |

```bash
parallax remember --entity file:src/auth.ts --attribute observed --value '"compiled"'
parallax recall --entity file:src/auth.ts --attribute observed --k 10
parallax branch --name experiment-1 --from main
parallax trace --fact-id <sha256-hex> --depth 5
parallax profile --entity file:src/auth.ts
```

### 🖥️ Local UI

`parallax ui`는 최신 report를 기준으로 바로 작업 화면을 띄운다. landing page가 아니라 Report Delta, Impact Summary, Impact Map, Change Set, Impact Paths, Evidence, Coverage Gaps, Doctor Findings를 한 화면에서 본다.

| 화면 | 기능 |
| :--- | :--- |
| **Change Set** | 분석된 변경 파일과 entity 요약 |
| **Report Delta** | 선택한 report를 직전 saved report와 비교해 영향 범위, evidence, action, lane 변화량을 표시하고 added path를 source/inspector로 연결 |
| **Impact Summary** | 변경 수, 영향 범위, confidence 분포, 우선 확인 대상을 첫 화면에 요약 |
| **Impact Lanes** | runtime code, tests, docs/policy, contracts, config/infra 영향 범주를 한눈에 분리 |
| **Impact Paths** | 변경 → 영향 대상까지의 relation trail, evidence count, source/action control |
| **Verification Queue** | 영향받는 테스트/리뷰 action을 복사 가능한 command와 target source link로 표시 |
| **Evidence** | redacted snippet, source span, relation provenance |
| **Impact Map** | changed root와 affected target을 실제 graph link로 연결하고, target 선택 시 관련 경로와 evidence를 강조 |
| **Impact Inspector** | 선택한 target의 relation, evidence preview, source, verification action을 즉시 확인 |
| **Source Viewer** | evidence의 `Open source` 링크로 repo-local 파일의 해당 line 주변을 바로 확인 |
| **Coverage Gaps** | adapter confidence와 known-gap 확인 |
| **Doctor Findings** | schema/index/vector/telemetry 상태 점검 |

---

## 🧱 핵심 개념

```mermaid
flowchart LR
    Dev["Developer / CI"]
    Agent["Claude Code · Codex · Cursor"]
    CLI["parallax CLI"]
    MCP["MCP stdio server"]
    DB[".parallax/impact.db<br/>SQLite + sqlite-vec"]
    Indexer["Indexer<br/>entities · relations · evidence"]
    Analyzer["Impact Analyzer<br/>changed → affected → actions"]
    Memory["Agent Memory<br/>facts · branches · provenance"]
    Workspace["Workspace / Contract<br/>repo catalog · consumer links"]
    UI["Local UI<br/>report · graph · coverage"]

    Dev --> CLI
    Agent --> MCP
    CLI --> Indexer
    CLI --> Analyzer
    CLI --> Memory
    CLI --> Workspace
    MCP --> Analyzer
    MCP --> Memory
    MCP --> Workspace
    Indexer --> DB
    Analyzer --> DB
    Memory --> DB
    Workspace --> DB
    UI --> DB
```

| 개념 | 설명 |
| :--- | :--- |
| **Entity** | 파일, 함수, 클래스, endpoint, 문서 artifact 같은 영향 분석 단위 |
| **Relation** | `IMPORTS`, `CALLS`, `TESTS`, `GOVERNS`, `CONSUMES_HTTP_ENDPOINT` 같은 연결 |
| **Evidence** | relation을 만든 원본 파일, span, redacted snippet |
| **ImpactAction** | agent가 다음에 확인해야 할 테스트, 파일, 문서, 계약 작업 |
| **Context pack** | MCP agent에게 전체 report 대신 필요한 evidence/resource link만 압축해 주는 payload |
| **Fact** | agent memory의 content-addressable 결정/관찰 row |
| **Branch** | 여러 agent plan을 같은 DB 안에서 분리해 실험하는 head pointer |

Parallax는 graph DB 프로젝트가 아니다. 기본은 repo-local SQLite이며, graph DB, CodeQL, 외부 vector store 같은 것은 나중에 붙일 수 있는 projection/adapter로 둔다.

---

## 🤖 MCP & Agents

Parallax는 공식 MCP SDK 기반 stdio server를 제공한다.

```bash
parallax mcp serve
```

분석 대상 repo에서 먼저 인덱스를 만든 뒤 연결한다.

```bash
parallax init
parallax index
```

### Codex 연결

```bash
codex mcp add parallax -- parallax mcp serve
codex mcp list
```

또는 `.codex/config.toml` / `~/.codex/config.toml`:

```toml
[mcp_servers.parallax]
command = "parallax"
args = ["mcp", "serve"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

### Claude Code 연결

```bash
claude mcp add --transport stdio parallax -- parallax mcp serve
```

PATH에 올리지 않았다면 빌드된 CLI를 직접 지정한다.

```bash
claude mcp add --transport stdio parallax -- node <parallax-checkout>/dist/src/cli.js mcp serve
```

### 주요 MCP tool

| Tool | 역할 |
| :--- | :--- |
| `parallax_analyze_diff` | 변경 파일을 분석하고 CLI와 같은 report model 반환 |
| `parallax_context_for_change` | `brief` / `standard` / `deep` budget에 맞춘 compact context pack 반환 |
| `parallax_search_context` | keyword/path/symbol/relation/evidence/fact text 검색과 RRF ranking |
| `parallax_explain_entity` | entity 하나의 direct relation과 compact evidence 설명 |
| `parallax_contract_diff` | workspace contract diff와 known consumer impact 반환 |
| `parallax_doctor` | schema, latest index, coverage, vector, telemetry 상태 점검 |
| `parallax_remember` / `parallax_recall` | repo-local agent memory fact 쓰기/조회 |
| `parallax_branch` / `parallax_merge` / `parallax_trace` | branch와 provenance 기반 memory workflow |
| `parallax_profile` / `parallax_reflect` | entity profile과 reflective summary 관리 |

### Read-only resources

| Resource | 역할 |
| :--- | :--- |
| `parallax://reports/{reportId}` | 저장된 report JSON |
| `parallax://entities/{entityId}` | 최신 index의 entity와 incoming/outgoing relation |
| `parallax://evidence/{evidenceId}` | redacted evidence snippet과 source span |
| `parallax://reports/{reportId}/graph/{format}` | Mermaid, JSON, DOT graph projection |
| `parallax://coverage/latest` | 최신 index coverage |
| `parallax://workspaces/{workspaceName}` | workspace catalog와 contract/link resource URI |
| `parallax://workspaces/{workspaceName}/contracts` | 최신 indexed contract baseline |
| `parallax://workspaces/{workspaceName}/cross-repo-links` | provider/consumer contract links |

---

## 🔒 안전 모델

| 경계 | 동작 |
| :--- | :--- |
| **Local-first** | 기본 데이터는 현재 repo의 `.parallax/impact.db`에만 저장 |
| **Path containment** | repo root 밖으로 resolve되는 file input 거절 |
| **Secret redaction** | evidence, memory value, LLM 입출력 전 흔한 secret-like 패턴 redaction |
| **Zero-row embedding gate** | redaction된 secret이 감지되면 embedding row를 만들지 않음 |
| **No command execution** | MVP는 프로젝트 command를 실행하지 않고 index/analyze만 수행 |
| **MCP write boundary** | memory/telemetry write도 현재 repo-local DB에만 발생 |
| **외부 write 없음** | Obsidian, GitHub, Jira 같은 repo 밖 write는 별도 권한 모델과 리뷰 뒤에 추가 |

`doctor`는 read-only health check다.

```bash
parallax doctor
```

database가 없거나 schema가 오래된 경우에도 `.parallax/`를 만들지 않고 JSON finding과 exit code `1`로 알려준다.

---

## 🛠️ CLI 전체 명령어

```text
parallax init
parallax index [--max-file-bytes 1000000]
parallax doctor
parallax ui [--report <id>] [--port <n>]
parallax import-session --file <path> --format codex|claude [--branch <name>]

parallax analyze --changed src/file.ts [--depth 2] [--json]
parallax analyze --base main [--head HEAD] [--depth 2] [--json]
parallax graph export --report <id> [--format mermaid|json|dot]
parallax mcp serve

parallax workspace init [--name <name>] [--service <service>] [--force]
parallax workspace add-repo <path> [--name <name>] [--service <service>] [--remote <url>]
parallax workspace list [--name <name>] [--json]
parallax workspace resolve-contracts [--name <name>] [--json]
parallax workspace contract-diff --contract <path> [--name <name>]
                                      [--provider <service>] [--provider-path <path>] [--json]

parallax remember --entity <id> --attribute <name> --value <json|string>
parallax retract  --entity <id> --attribute <name> --value <json|string>
parallax recall   [--query <text>] [--semantic] [--entity <id>] [--attribute <name>]
parallax branch   --name <name> [--from <name>]
parallax branch   --abandon <name>
parallax branch   --restore <name>
parallax merge    --target <branch> --source <branch>
parallax reflect  [--branch <name>] [--older-than-days 30] [--entity <id>]
parallax reflect  --repair [--branch <name>] [--dry-run]
parallax gc-branches [--dry-run] [--max-age <days>]
parallax profile  --entity <id> [--branch <name>]
parallax trace    --fact-id <id> [--depth 5]
parallax reembed  [--model <hf-model>] [--all]
parallax reindex-vec [--model <hf-model>]
```

---

## 🧪 개발

```bash
npm run build
npm run check
npm test
npm run docs:lint
```

주요 script:

| Script | 역할 |
| :--- | :--- |
| `npm run build` | TypeScript를 `dist/`로 compile |
| `npm run check` | emit 없이 typecheck |
| `npm test` | Node test runner suite를 `tsx`로 실행 |
| `npm run bench` | multi-language, Spring Boot, contract, package manifest fixture 기반 deterministic bench |
| `npm run docs:lint` | tracked Markdown에서 local metadata와 secret-like content 검사 |
| `npm run test:mcp` | MCP impact/context/memory/telemetry/path validation 검증 |
| `npm run test:security` | path containment와 redaction 검증 |
| `npm run test:ui` | local UI snapshot, server, JSON resource endpoints 검증 |

릴리스 전 권장 체크:

```bash
npm run check
npm test
npm run docs:lint
npm audit --audit-level=high
```

---

## 🗺️ Roadmap

| 축 | 다음 목표 |
| :--- | :--- |
| **Accuracy** | TS/JS parser-backed span을 더 넓은 dynamic dispatch와 advanced type relation으로 확장 |
| **JVM / Python / Go / Rust** | declaration 중심 adapter를 parser-backed call/import resolution으로 승격 |
| **Workspace / Contract** | nested schema diff 안정화, generated-client/event topology resolver depth 확대 |
| **Package / Build** | lockfile, transitive dependency, semver/range 기반 package graph |
| **Agent surface** | context pack budget tuning과 hit/miss 측정 harness |
| **UI Explorer** | changed → affected → evidence → action 흐름을 한 화면에서 더 직접적으로 탐색 |
| **Measurement** | fixture bench delta와 recall 품질 회귀 detection |

자세한 backlog는 [`docs/roadmap.md`](docs/roadmap.md)를 기준으로 관리한다.

---

## ⚠️ 현재 한계

| 영역 | 상태 |
| :--- | :--- |
| **Full semantic analysis** | 모든 언어의 type-aware analysis가 아니다. adapter별 confidence와 known-gap을 확인해야 함 |
| **Contract depth** | GraphQL/Protobuf/AsyncAPI parser/LSP 수준의 full generated-client usage graph는 후속 |
| **Package resolution** | 현재는 manifest 중심. lockfile/transitive/semver 실행 기반 resolver는 후속 |
| **Graph DB** | 기본 제품 범위가 아님. 필요하면 SQLite에서 optional projection으로 확장 |
| **External writes** | Obsidian/GitHub/Jira write sync는 아직 MCP surface에 노출하지 않음 |
| **Code modification** | Parallax는 코드를 직접 수정하지 않는다. agent에게 영향도와 근거를 제공한다 |

---

## 📚 더 읽기

| 문서 | 내용 |
| :--- | :--- |
| [`docs/vision.ko.md`](docs/vision.ko.md) | 프로젝트 비전 |
| [`docs/value-proposition.ko.md`](docs/value-proposition.ko.md) | 가치 제안과 차별성 |
| [`docs/roadmap.md`](docs/roadmap.md) | 현재 backlog와 다음 슬라이스 |
| [`docs/invariants.md`](docs/invariants.md) | local-first, redaction, 권한 모델 같은 불변 원칙 |
| [`docs/glossary.md`](docs/glossary.md) | 용어집 |
| [`skills/parallax/SKILL.md`](skills/parallax/SKILL.md) | Claude Code/Codex 사용자용 skill |

---

## License

MIT License. 자세한 내용은 [`LICENSE`](LICENSE)를 확인해 주세요.
