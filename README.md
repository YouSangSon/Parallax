# Impact Trace

Impact Trace는 Claude Code, Codex 같은 에이전트 코딩 도구를 위한 로컬 우선
코드 영향도 분석기입니다.

에이전트가 코드를 바꾸기 전에 Impact Trace가 저장소를 인덱싱하고, 변경 파일이
어떤 파일과 테스트에 영향을 줄 수 있는지 증거와 함께 보여줍니다.

핵심 방향은 명확합니다. 이 프로젝트는 graph DB 프로젝트가 아닙니다. MVP는
로컬 SQLite 인덱스를 사용하고, graph DB, vector search, CodeQL 같은 분석은
나중에 붙일 수 있는 선택 adapter로 둡니다.

핵심 분석 모델은 함수, 변수, 클래스, 파일 같은 코드 구성 요소와 문서, 정책, 업무
산출물을 서로 연결해서 인덱싱하는 것입니다. 변경이 들어오면 그 구성 요소를 참조하거나
호출하거나 import하는 다른 구성 요소를 따라가며 사이드 이펙트, 필요한 테스트, 개선
지점을 찾는 방향입니다.
장기적으로는 한 저장소 안의 코드뿐 아니라 여러 프로젝트가 REST API, gRPC/protobuf,
GraphQL, AsyncAPI/event contract로 연결되는 관계까지 같은 graph로 추적합니다.
더 길게는 사업계획서, PRD, 회의록, 의사결정 기록, KPI 문서, 고객/영업 문서 같은
회사 업무 산출물도 `Entity`와 `Relation`으로 올려서 “코드 변경이 제품/운영/사업 문서에
미치는 영향”과 “문서 변경이 구현/테스트에 요구하는 작업”을 함께 추적하는 방향입니다.

## 현재 상태

MVP 구현이 들어가 있습니다.

현재 되는 것:

- repo-local `.impact-trace/` 작업 공간 생성
- 언어 중립 report model: `changed`, `affected`, `actions`, `evidence`
- legacy `files/symbols/edges`와 canonical `entities/relations/relation_evidence` 동시 저장
- adapter run과 index coverage metadata 저장
- 기본 registry가 TypeScript/JavaScript, JVM/Spring Boot, Python, Go, Rust v0 adapter를 regex fallback보다 먼저 적용
- Markdown과 system/config/contract 파일은 regex fallback adapter로 인덱싱
- C#, C, C++ 파일은 fallback 휴리스틱으로 기본 symbol/dependency 인덱싱
- shell, YAML, JSON, TOML, Dockerfile, Makefile, Terraform, protobuf, GraphQL, CODEOWNERS 파일을 config/system/contract 후보로 인덱싱
- 분석 시 canonical `relations`를 우선 사용하고 legacy `edges`는 fallback으로 사용
- bounded multi-hop traversal, cycle protection, depth/fan-out 제한
- `--base`, `--head` 기반 git diff 입력
- stale-index warning과 oversized file skip coverage
- 저장된 report에서 Mermaid/JSON/DOT graph export 생성
- TS/JS export symbol 추출
- TS/JS import edge 추출
- import 기반 관련 테스트 추론
- Markdown mention 기반 관련 문서 추론
- Markdown policy/proposal/PRD/decision 파일을 first-class work artifact로 분류하고 `GOVERNS`/`PROPOSES`/`REQUIRES` impact relation 추론
- system/config 파일의 path mention 기반 관계 추론
- 변경 파일 분석 후 JSON 또는 Markdown report 생성
- 공식 MCP SDK 기반 stdio server 제공
- MCP impact tools 제공: `impact_trace_analyze_diff`, `impact_trace_context_for_change`, `impact_trace_search_context`, `impact_trace_explain_entity`
- agent memory MCP tools 제공: `remember`, `recall`, `branch`, `trace`, `reflect` 등은 `.impact-trace/impact.db` 안에서만 동작
- read-only MCP resources 제공: report, entity, evidence, graph, latest coverage
- evidence output 전 secret-like 값 redaction
- repo root 밖으로 나가는 path 거절
- workspace, contract, cross-repo link, work artifact 확장용 SQLite schema

중요한 점: Impact Trace의 목표는 TS/JS 전용 도구가 아닙니다. 현재 v0 adapter pack은
TS/JS, JVM/Spring Boot, Python, Go, Rust를 별도 adapter run으로 라우팅하고,
Markdown/config/system/contract와 아직 깊게 다루지 않는 언어는 regex fallback으로 둡니다.
공개 report model은 언어별 문자열보다 `EntityRef`, `ImpactTarget`, `ImpactAction` 같은
언어 중립 구조를 우선합니다. 이후 Tree-sitter, LSP, CodeQL, build-system adapter로 깊이를
더하는 방향입니다.

이번 MVP에 없는 것:

- Obsidian write sync
- graph DB projection
- workspace/cross-repo contract resolver
- web graph explorer
- CodeQL adapter
- 모든 언어의 full semantic analysis
- parser-backed full source-span coverage
- 에이전트가 직접 코드를 수정하는 기능

## Direction: agent memory layer

Impact Trace의 큰 방향은 *코드 영향도 분석*에 그치지 않습니다. 같은 local-first
SQLite + MCP stdio 위에 **agent의 결정·관찰·근거를 1급 시민으로 저장하는
agent memory 레이어**를 점진적으로 더합니다.

목표:

- agent가 작업 중에 만든 결정과 관찰을 fact로 영속화
- 시간 질의: "이 변경 5턴 전 상태에서는 어떻게 보였는가"
- branching: agent가 여러 plan을 시뮬레이션하고 그중 하나만 commit
- causal trace: 어떤 결정의 근거 사슬을 1쿼리로 추적

이 방향은 프로젝트 정체성(local-first, single .db, privacy, redaction)을 그대로
두고 *증분으로* 더해집니다. 자세한 사용 흐름은
[docs/agent-memory-cookbook.ko.md](docs/agent-memory-cookbook.ko.md), 결정 기록은
[docs/decisions.ko.md](docs/decisions.ko.md)를 기준으로 봅니다.

```mermaid
graph LR
  Dev[개발자] -->|CLI| Cli["impact-trace CLI"]
  Agent["Claude Code · Codex · Cursor"] -->|MCP stdio| Mcp["impact_trace_* tools"]
  subgraph Local[" 단일 PC ・ 단일 .impact-trace/impact.db "]
    Cli --> Mem
    Mcp --> Mem
    Cli --> Idx
    Mcp --> Idx
    Idx["Code Indexer<br/>(impact-trace index)"] -. dual-write .-> Mem
    Mem["Agent Memory Layer<br/>facts · transactions · branches<br/>fact_provenance · embeddings · attribute_defs"]
    Ana["Impact Analyzer<br/>(impact-trace analyze)"] --> Mem
  end
```

데이터는 *전부* 사용자 PC 안에 머무르고, 한 `.db` 파일을 백업/공유/git checkin
가능합니다. 외부 네트워크 의존 없음.

### 진행 단계

| Phase | 무엇 | 상태 |
|---|---|---|
| 1 | facts/transactions/branches 스키마, 4 MCP 툴 + 4 CLI 명령 (`remember`, `recall`, `branch`, `trace`), 코드 관계 1급 시민 attribute 시드, 인덱서 듀얼 라이트 + evidence_snippet provenance, sqlite-vec 통합, embedding 파이프라인 (stub) + redact-then-embed 게이트 | ✅ 완료 |
| 2 | Transformers.js + multilingual-e5-base ✅, schema v6 model-agnostic ✅, as_of_tx ✅, branch merge ✅, semantic recall (brute-force int8 cosine) ✅ | ✅ 완료 |
| 3 | reflective consolidation (entity별 LLM 자동 요약, multi-provider stub/ollama/anthropic/openai), speculative branch GC (soft-delete via `transactions.archived`), schema v7, redact-then-prompt 게이트 + secret 패턴 확장 | ✅ 완료 |
| 4 | reflect scaling cap (streaming iterate + per-entity bound), Profile API (`profileEntity` 3-bucket view), `factLifecycle` helper, supermemory selective adoption (P1/P4 거부, P2/P3-Expose/P6 채택), Skill packaging (`npx skills add`), `reflect --repair` (orphan 보정), `branch --restore` (역방향 복구), `gc-branches --max-age` (시간 기반 자동 abandon), sqlite-vec ANN (per-model vec0 + brute-force fallback) + `reindex-vec` CLI | ✅ 완료 |
| 5 | MemoryBench harness · topic clustering · multi-layer reflection · concurrent reflect lock · reembed cleanup | ⏳ 후보/deferred |
| 6 | adapter interface/registry, `MultiLanguageRegexAdapter`, multi-adapter run attribution, adapter evidence/diagnostic observability, symbol hash sensitivity, relation-kind memory attribute mapping | ✅ `main` 반영 완료; 다음 slice는 multi-language + Spring Boot adapter pack v0/trusted evidence ([phase6-design.ko.md](docs/phase6-design.ko.md), [phase6b-ts-accuracy-plan.ko.md](docs/phase6b-ts-accuracy-plan.ko.md)) |

**비전 한 페이지:** [docs/vision.ko.md](docs/vision.ko.md). **제품 계획:** [docs/impact-context-layer-plan.ko.md](docs/impact-context-layer-plan.ko.md) — MCP + UI + AI context 절감 + 코드/문서/정책/제안서 impact 기준 문서. **agentmemory 적용성 분석:** [docs/agentmemory-adoption-review.ko.md](docs/agentmemory-adoption-review.ko.md). **통합 로드맵:** [docs/roadmap.md](docs/roadmap.md). **두 축 어휘:** [docs/glossary.md](docs/glossary.md).
자세한 사용 예시는 [docs/agent-memory-cookbook.ko.md](docs/agent-memory-cookbook.ko.md).
현재 설계 근거: [Phase 6 설계/진행](docs/phase6-design.ko.md) · [Phase 6B multi-language + Spring Boot 계획](docs/phase6b-ts-accuracy-plan.ko.md).
누적 결정 로그: [decisions.ko.md (D-001..D-018)](docs/decisions.ko.md).
문서 navigation: [docs/README.md](docs/README.md).

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
impact-trace analyze --changed src/auth/session.ts --depth 2
impact-trace analyze --base main --head HEAD --json
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
impact-trace index [--max-file-bytes 1000000]
impact-trace analyze --changed src/file.ts [--depth 2] [--json]
impact-trace analyze --base main [--head HEAD] [--depth 2] [--json]
impact-trace graph export --report <id> [--format mermaid|json|dot]
impact-trace mcp serve

# agent memory (Phase 1+2)
impact-trace remember --entity <id> --attribute <name> --value <json|string>
                      [--branch <name>] [--agent <id>] [--op assert|retract]
                      [--evidence-fact-ids id1,id2]
impact-trace retract  --entity <id> --attribute <name> --value <json|string>
                      [--branch <name>] [--agent <id>]
impact-trace recall   [--query <text> --semantic] [--entity <id>] [--attribute <name>]
                      [--branch <name>] [--k 20] [--as-of-tx <tx-id>] [--current-only]
impact-trace branch   --name <name> [--from <name>]
impact-trace merge    --target <branch> --source <branch> [--agent <id>]
impact-trace reembed  [--model <provider:id>] [--all]
impact-trace trace    --fact-id <id> [--depth 5]

# agent memory (Phase 3)
impact-trace reflect       [--branch <name>] [--older-than-days 30] [--entity <id>]
                           [--model <provider:id>] [--agent <id>] [--dry-run]
impact-trace branch        --abandon <name>
impact-trace gc-branches   [--dry-run] [--max-age <days>]

# agent memory (Phase 4)
impact-trace reflect       --repair [--branch <name>] [--dry-run]
impact-trace branch        --restore <name>
impact-trace profile       --entity <id> [--branch <name>] [--k 50] [--as-of-tx <tx-id>]
impact-trace reindex-vec   [--model <hf-model>]
```

`profile` 명령은 한 entity의 정보를 *세 가지 분류*로 한 번에 반환합니다:
- `staticFacts` — 인덱서가 만든 코드 구조 (imports, calls, depends_on, ...)
- `dynamicFacts` — agent의 결정/관찰 (observed, verified, concern, ...)
- `summaryFacts` — Phase 3 reflective consolidation 결과 (LLM 요약)

이걸 *agent system prompt에 inject*하면 "이 엔티티에 대해 시스템이 알고 있는 것" 한 번에 전달됨. 자세한 패턴: [docs/agent-memory-cookbook.ko.md](docs/agent-memory-cookbook.ko.md).

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
- 추론된 config/system/contract reference edge
- skipped file coverage
- redacted evidence snippet

### `analyze`

최신 completed index run을 기준으로 변경 파일의 영향 범위를 분석합니다.

```bash
impact-trace analyze --changed src/a.ts --depth 2
impact-trace analyze --changed src/a.ts,src/b.ts --json
impact-trace analyze --base main --head HEAD --json
```

JSON report에는 아래 정보가 들어갑니다.

- `changedFiles`
- `affectedFiles`
- `changed`
- `affected`
- `actions`
- `testCommands` deprecated: 기존 caller 호환용이며 `actions`를 사용하세요.
- `evidence`
- `warnings`
- `indexRunId`
- `reportPath`

### `graph export`

저장된 report를 기준으로 관계 그래프를 출력합니다. 이 기능은 별도 graph DB 없이
SQLite의 canonical `entities`와 `relations`에서 파생합니다.

```bash
impact-trace graph export --report <report-id> --format mermaid
impact-trace graph export --report <report-id> --format json
impact-trace graph export --report <report-id> --format dot
```

### Agent memory 명령 (`remember` / `recall` / `branch` / `trace`)

같은 `.impact-trace/impact.db` 위에서 agent의 결정/관찰을 content-addressable
fact로 영속화합니다. MCP 툴과 1:1 동등하며, 출력은 모두 JSON (stdout).

```bash
# 결정 저장 — value는 JSON 또는 문자열, secret 패턴은 자동 redaction
impact-trace remember --entity file:src/auth.ts --attribute observed --value '"compiled"'

# 조회 — 구조 필터 (Phase 1: structured-only, semantic은 Phase 2)
impact-trace recall --entity file:src/auth.ts --attribute observed --k 10

# 분기 — 데이터 복사 없이 main에서 fork
impact-trace branch --name experiment-1 --from main

# 인과 사슬 — fact_provenance edge를 따라 evidence까지 도달
impact-trace trace --fact-id <sha256-hex> --depth 5
```

자세한 흐름·패턴: [docs/agent-memory-cookbook.ko.md](docs/agent-memory-cookbook.ko.md).

## MCP

Impact Trace는 공식 MCP SDK 기반의 stdio server를 제공합니다. stdio는 로컬
프로세스로 실행되기 때문에 Claude Code, Codex 같은 코딩 에이전트가 현재 작업 중인
저장소를 직접 분석하게 만들기 좋습니다. 영향 분석과 context pack tool은 read-only이고,
agent memory tool은 현재 저장소의 `.impact-trace/impact.db`에만 씁니다.

```bash
impact-trace mcp serve
```

먼저 분석 대상 저장소에서 인덱스를 만들어야 합니다.

```bash
impact-trace init
impact-trace index
```

MCP에서 노출하는 주요 tool은 아래와 같습니다.

| Tool | 역할 |
|---|---|
| `impact_trace_analyze_diff` | 변경 파일을 분석하고 CLI와 같은 report model을 반환합니다. |
| `impact_trace_context_for_change` | 변경 파일을 기준으로 `brief`/`standard`/`deep` budget에 맞춘 compact context pack을 반환합니다. agent가 전체 report를 받지 않고 top impact paths, evidence refs, entity/coverage resource link만 받도록 합니다. |
| `impact_trace_search_context` | keyword/path/symbol/relation/evidence snippet을 최신 index에서 검색하고 RRF-ranked entity context, stream별 rank signal, match reason, compact evidence, resource link를 반환합니다. |
| `impact_trace_explain_entity` | entity 하나의 direct relation과 compact evidence를 제한된 payload로 반환하고, full evidence resource link를 제공합니다. |
| `impact_trace_remember` | agent의 결정/관찰을 content-addressable fact로 저장합니다 (Phase 1). |
| `impact_trace_recall` | branch/entity/attribute 또는 semantic query로 fact를 조회합니다 (Phase 2). |
| `impact_trace_branch` | 새 branch를 기존 branch에서 fork합니다. 데이터 복사 없음. |
| `impact_trace_merge` | 두 branch의 head를 묶어 새 merge 트랜잭션을 만듭니다 (Phase 2 multi-parent DAG). |
| `impact_trace_trace` | fact_provenance edge를 따라 결정의 인과 사슬을 반환합니다. |
| `impact_trace_reflect` | 오래된 facts를 entity별로 LLM이 요약해 summary fact로 승격합니다 (Phase 3). |
| `impact_trace_abandon_branch` | branch state를 `abandoned`로 변경합니다 (Phase 3). main은 보호. |
| `impact_trace_gc_branches` | abandoned branch의 transactions를 soft-delete archive 처리합니다 (Phase 3). `maxAgeDays`로 시간 기반 자동 abandon (Phase 4 P4). |
| `impact_trace_profile` | 한 entity의 facts를 staticFacts/dynamicFacts/summaryFacts 3-bucket으로 한 번에 반환합니다 (Phase 4 P1). |
| `impact_trace_repair_reflections` | orphan summary fact를 보정합니다 (Phase 4 P2). |
| `impact_trace_restore_branch` | abandoned branch의 state + tx archived를 복구합니다 (Phase 4 P3). |

`impact_trace_context_for_change`는 report를 persist하지 않습니다. v0는 `impact-trace://entities/{entityId}`,
`impact-trace://evidence/{evidenceId}`, `impact-trace://coverage/latest` resource link를 반환하고,
큰 report/graph pagination은 다음 context-pack slice에서 붙입니다.
`impact_trace_search_context` v1은 `k=10`, `includeEvidence=true`, `evidencePerEntity=2`,
`snippetChars=240`을 기본으로 하며, keyword/relation/evidence stream을 RRF로 fuse합니다.
응답의 각 result는 `rankSignals.algorithm='rrf'`, `keywordRank`, `relationRank`, `evidenceRank`,
`rrfScore`를 포함합니다. 현재 v1은 semantic/vector search가 아니라 deterministic SQLite stream으로
동작하며, FTS/BM25와 semantic recall fusion은 다음 ranking depth pass입니다.
`impact_trace_explain_entity` v0는 `relationLimit=20`을 incoming/outgoing 각각에 적용하고,
`evidenceLimit=10`, `snippetChars=300`으로 선택된 relation 전체의 evidence payload를 제한합니다.

agent memory 툴(`remember`/`branch`)은 DB에 쓰지만 모두 *현재 저장소의*
`.impact-trace/impact.db` 안에서만 동작합니다. Obsidian export 같은 외부 시스템
write는 여전히 별도 권한 모델과 리뷰를 거친 뒤 추가합니다.

MVP에서 노출하는 resource는 read-only입니다.

| Resource | 역할 |
|---|---|
| `impact-trace://reports/{reportId}` | 저장된 report JSON을 읽습니다. |
| `impact-trace://entities/{entityId}` | 최신 index의 entity와 incoming/outgoing relation을 읽습니다. |
| `impact-trace://evidence/{evidenceId}` | relation evidence의 redacted snippet, source span, source/target entity를 읽습니다. |
| `impact-trace://reports/{reportId}/graph/{format}` | Mermaid, JSON, DOT graph projection을 읽습니다. |
| `impact-trace://coverage/latest` | 최신 index coverage를 읽습니다. |

외부 시스템 write capability는 의도적으로 `tools/list`에 나오지 않습니다. Obsidian export 같은
repo 밖 write는 별도 권한 모델과 리뷰를 거친 뒤 추가합니다.

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
- 영향 분석/context MCP tool은 read-only이며 report persistence도 하지 않습니다.
- agent memory MCP tool은 repo-local `.impact-trace/impact.db`에만 씁니다.
- 프로젝트 command 실행은 MVP 범위 밖입니다.
- `.impact-trace/`는 git ignore 대상입니다.

redaction layer는 OpenAI-style key, Stripe key, GitHub token, AWS access key, Google
API key, npm token, JWT, DB connection URL, Bearer token, private key block 같은 흔한
secret 형태를 가립니다. Phase 3 reflective consolidation에서는 LLM 호출 직전과 직후
모두 같은 redaction을 거치므로 secret이 외부 LLM 제공자에게 전달되거나 summary fact로
echo되지 않습니다 (decision [D-004](docs/decisions.ko.md#d-004-redact-then-embed-zero-row-policy)).
이것은 안전망이지, source file에 secret을 넣어도 된다는 뜻은 아닙니다.

## 개발

```bash
npm test
npm run bench
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
| `npm run bench` | Phase 6B multi-language/Spring Boot fixture를 인덱싱하고 deterministic JSON report를 `.impact-trace/bench/impact-bench-report.json`에 씁니다. |
| `npm run docs:lint` | git tracked Markdown 파일에서 local metadata와 secret-like content를 검사합니다. |
| `npm run test:mcp` | MCP impact/context read-only 동작, repo-local memory write 동작, path validation을 검증합니다. |
| `npm run test:security` | path containment와 redaction을 검증합니다. |

## 문서

제품/엔지니어링 계획:

- [한국어 계획서](docs/impact-trace-plan.ko.md)

인덱싱 모델:

- [한국어 인덱싱 모델](docs/indexing-model.ko.md)

테스트 계획:

- [한국어 테스트 계획](docs/impact-trace-test-plan.ko.md)

진행상황:

- [한국어 진행상황](docs/progress.ko.md)

**문서 인덱스:**

- 📚 [docs/README.md](docs/README.md) — *모든 문서 navigation guide*. 어떤 문서를 언제 읽을지 우선순위.
- 📜 [CHANGELOG.md](CHANGELOG.md) — Phase별 highlights 한눈에.

**설계 결정 + Phase docs:**

- [Impact Context Layer 제품 계획](docs/impact-context-layer-plan.ko.md) — Claude/Codex MCP integration, local UI explorer, context budget, 정책/제안서 impact 계획
- [agentmemory 적용성 분석](docs/agentmemory-adoption-review.ko.md) — `rohitg00/agentmemory`에서 가져올 retrieval/lifecycle 패턴과 거부할 platform surface 정리
- [Phase 6 설계/진행 문서](docs/phase6-design.ko.md) — `main`에 반영된 adapter foundation 작업
- [Phase 6B multi-language + Spring Boot 계획](docs/phase6b-ts-accuracy-plan.ko.md) — 현재 slice: adapter pack v0 routing + ImpactBench fixture, 다음 depth pass: parser-backed adapters, source span, git snapshot metadata
- [Architecture decisions log (D-001..D-018)](docs/decisions.ko.md) — 누적 ADR 로그
- [Agent memory cookbook](docs/agent-memory-cookbook.ko.md)

**Skill 패키징 (Phase 4):**

- [skills/impact-trace/SKILL.md](skills/impact-trace/SKILL.md) — Claude Code 스킬 매니페스트
- [skills/impact-trace/references/architecture.md](skills/impact-trace/references/architecture.md) — 깊은 architecture reference

## 기여

기여를 환영합니다. 시작하기 전에 [CONTRIBUTING.md](CONTRIBUTING.md)를 읽어
주세요.

보안 이슈는 공개 issue에 민감한 정보를 올리지 말고 [SECURITY.md](SECURITY.md)의
방식으로 신고해 주세요.

## Roadmap

1. `entities`, `relations`, `relation_evidence`, `adapter_runs`, `index_coverage` 기반 canonical schema 추가
2. running index와 completed index를 분리해 snapshot-safe analysis 보장
3. `--base`, `--head` 기반 git diff 분석과 stale-index detection 추가
4. Java/Kotlin/Spring Boot/Python/Go/Rust/TS/JS adapter v0 라우팅과 ImpactBench coverage 유지
5. parser-backed adapter depth pass와 source-span evidence 확대
6. C#/.NET, C/C++ adapter와 Maven/Gradle/dotnet/CMake/Bazel build-system resolver 추가
7. shell, YAML/JSON/TOML, CI, Docker, Kubernetes, Terraform, OpenAPI/protobuf/GraphQL/AsyncAPI, CODEOWNERS/policy adapter 추가
8. workspace catalog와 cross-repo API/gRPC/event contract impact 분석 추가
9. web graph explorer와 더 큰 graph filtering 추가
10. source-span evidence와 parser-level provenance 추가
11. MCP evidence/workspace/contract resources 추가
12. graph DB, vector, CodeQL, Obsidian export는 optional projection으로 추가

## License

MIT License입니다. 자세한 내용은 [LICENSE](LICENSE)를 확인해 주세요.
