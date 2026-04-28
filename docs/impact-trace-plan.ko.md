# Impact Trace 계획서

생성일: 2026-04-28

영어 버전: [impact-trace-plan.en.md](impact-trace-plan.en.md)

## 제품 요약

Impact Trace는 Claude Code, Codex, 그리고 비슷한 에이전트 코딩 도구를 위한
로컬 우선 프로젝트 분석 레이어다. 저장소를 인덱싱하고, 코드 심볼을 import,
테스트, 문서, 커밋, 노트와 연결한 뒤, 특정 변경이 어떤 사이드 이펙트를 만들
수 있는지 증거와 함께 설명한다.

사용자는 graph DB가 꼭 필요하지 않다고 명확히 했다. 따라서 핵심 구조는 graph
DB가 아니라 플러그 가능한 로컬 인덱스다. 기본 저장소는 SQLite로 두고, 필요할
때 DuckDB, 벡터 검색, graph DB projection을 붙인다.

## 확인한 자료

| 자료 | 관련 내용 |
|---|---|
| [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) | TypeScript는 AST 순회, 증분 watcher, type checker 접근을 지원한다. |
| [Language Server Protocol 3.17](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/specification.md) | LSP는 definition, references, call hierarchy, type hierarchy, document symbols, diagnostics, workspace file events를 제공한다. |
| [CodeQL overview](https://codeql.github.com/docs/codeql-overview/about-codeql/) | CodeQL database는 언어별 AST, data flow graph, control flow graph를 질의 가능한 형태로 제공한다. |
| [MCP resources spec](https://modelcontextprotocol.io/specification/2025-06-18/server/resources) | MCP resources는 URI 기반으로 컨텍스트를 노출하고, URI 검증과 권한 확인이 필요하다. |
| [Obsidian URI docs](https://obsidian.md/help/uri) | Obsidian은 인코딩된 `obsidian://` URI로 노트를 열거나 만들 수 있다. |
| [FalkorDBLite docs](https://docs.falkordb.com/operations/falkordblite/) | Python/TypeScript용 embedded graph runtime이 있지만, production은 hosted/self-hosted FalkorDB가 권장된다. |
| [Kuzu GitHub](https://github.com/kuzudb/kuzu) | Kuzu는 2025-10-10에 archived 상태가 되었으므로 기본 핵심 의존성으로 두면 유지보수 리스크가 있다. |

## 전제

| 전제 | 상태 | 이유 |
|---|---|---|
| 에이전트는 코드 변경 전에 증거 기반 컨텍스트가 필요하다. | 채택 | 매번 저장소를 새로 읽으면 느리고, 테스트/문서/설정 같은 사이드 이펙트를 놓친다. |
| 사이드 이펙트는 dependency, runtime, ownership 관계에서 주로 나온다. | 채택 | 직접 import만으로는 충분하지 않다. 테스트, 문서, 설정, 생성 파일, 패키지 경계, 과거 버그 이력도 중요하다. |
| graph DB는 선택 사항이다. | 채택 | 사용자가 명확히 말했고, 코어는 storage-neutral하게 유지하는 편이 낫다. |
| Obsidian은 좋은 사람용 지식 표면이다. | 조건부 채택 | 먼저 Markdown export로 충분하다. Obsidian plugin을 v1 필수 조건으로 만들면 속도가 느려진다. |
| 완벽한 분석이 가능하다. | 거절 | 제품은 모르는 것을 숨기지 말고 confidence와 missing-data flag로 드러내야 한다. |

## 현재 있는 것

이 저장소는 Git metadata 외에는 비어 있다. 기존 코드, README, package manifest,
design doc, 테스트, 구현체가 없으므로 첫 제품 형태, 아키텍처, 검증 전략을
문서로 먼저 고정해야 한다.

## 범위 밖

| 항목 | 이유 |
|---|---|
| v1에서 모든 언어의 완전한 semantic analysis 지원 | 범위가 너무 넓다. TypeScript/JavaScript를 먼저 고신뢰 경로로 잡고, 나머지는 Tree-sitter 기반 fallback으로 둔다. |
| 필수 graph DB | graph DB는 필수가 아니다. 필요하면 projection adapter로 추가한다. |
| 필수 Obsidian plugin | Markdown export와 Obsidian URI만으로 MVP 가치가 나온다. |
| 자율 코드 수정 | v1의 Impact Trace는 에이전트에게 조언만 한다. 직접 프로젝트 코드를 수정하지 않는다. |
| cloud sync | 초기에는 소스 코드와 secret 보호를 위해 local-first를 유지한다. |

## 목표 상태

```text
현재
  빈 저장소. 에이전트는 매번 코드를 ad hoc으로 읽고 사이드 이펙트를 추측한다.

이번 계획
  로컬 CLI/MCP 도구가 저장소를 인덱싱하고,
  "이 변경이 무엇에 영향을 주는가?"를 답하며,
  evidence-backed report와 Obsidian 노트를 생성한다.

12개월 후 이상적 상태
  모든 에이전트 변경은 cached project map으로 시작한다.
  모든 PR에는 impact packet이 붙는다.
  위험한 변경은 테스트/문서/owner를 자동으로 드러낸다.
  Obsidian은 architecture decision과 hotspot의 사람용 memory가 된다.
```

## 핵심 사용자 흐름

1. 개발자가 저장소에서 `impact-trace init`을 실행한다.
2. 도구가 파일, 패키지, 심볼, import, 테스트, 문서, 최근 git history를 인덱싱한다.
3. 에이전트가 코드를 바꾸기 전에 `impact-trace analyze --diff`를 실행한다.
4. Impact Trace는 영향받는 module, 실행할 테스트, 위험한 가정, source evidence를 반환한다.
5. MCP server가 같은 분석을 Claude Code나 Codex에 노출한다.
6. 사용자는 project map과 change report를 Obsidian vault로 export한다.

## 권장 아키텍처

| 레이어 | 권장안 | 이유 |
|---|---|---|
| Runtime | Node.js/TypeScript | Claude/Codex tool ecosystem, MCP SDK, Obsidian plugin ecosystem, TypeScript analysis API와 잘 맞는다. |
| Canonical store | SQLite | 로컬 persistence가 쉽고, 설치가 가볍고, report/edge table에 충분하다. |
| Analytical snapshots | DuckDB 선택 | 대형 repo metric과 history query가 필요해질 때 붙인다. |
| Text search | SQLite FTS5 우선 | 초기 report 검색에는 충분하다. 필요해질 때 Tantivy/Meilisearch로 교체한다. |
| Semantic search | LanceDB/sqlite-vec adapter 선택 | "비슷한 코드" 탐색에는 유용하지만 deterministic impact analysis의 필수 조건은 아니다. |
| Graph projection | FalkorDBLite/Neo4j/Memgraph adapter 선택 | recursive graph query와 시각화가 핵심 가치가 될 때만 켠다. |
| Parsing | TS/JS는 TypeScript Compiler API, 범용 syntax는 Tree-sitter fallback | 가능한 곳에서는 semantic accuracy를 얻고, 그 외에는 language coverage를 확보한다. |
| Deep semantic analysis | CodeQL adapter 선택 | data/control-flow에 강하지만 setup이 무겁기 때문에 optional로 둔다. |
| Agent API | CLI + MCP server | CLI는 디버깅이 쉽고, MCP는 Claude Code/Codex에 structured tool/resource를 제공한다. |
| Human notes | Obsidian vault로 Markdown export | 투명하고 diff 가능하며 plugin 승인 없이 바로 동작한다. |

## 시스템 다이어그램

```text
                         +----------------------+
                         | Claude Code / Codex  |
                         +----------+-----------+
                                    |
                             MCP tools/resources
                                    |
+-----------+      +----------------v----------------+
| Git diff  +----->| Impact Trace Analyzer           |
+-----------+      | - changed file/symbol resolver   |
                   | - reverse dependency walk        |
+-----------+      | - risk classifier                |
| Repo scan +----->| - evidence packet builder        |
+-----------+      +----------------+----------------+
                                    |
              +---------------------+---------------------+
              |                                           |
     +--------v---------+                       +---------v--------+
     | Local Index      |                       | Report Exporter   |
     | SQLite core      |                       | Markdown/JSON     |
     | optional DuckDB  |                       | Obsidian notes    |
     | optional vectors |                       +------------------+
     +--------+---------+
              |
      optional graph projection
              |
     +--------v---------+
     | FalkorDB/Neo4j   |
     | or other adapter |
     +------------------+
```

## 데이터 모델

SQLite canonical table:

| Table | 목적 |
|---|---|
| `repos` | repo root, VCS metadata, default branch, config hash. |
| `schema_versions` | 적용된 migration version과 compatibility metadata. |
| `index_runs` | 각 indexing pass의 commit, dirty state, 시작/종료 시간, extractor version, 실패 요약. |
| `files` | path, language, hash, package, last indexed commit. |
| `symbols` | name, kind, file, range, export status, deterministic semantic ID, extractor version. |
| `edges` | `IMPORTS`, `CALLS`, `TESTS`, `DOCUMENTS`, `OWNS`, `GENERATES`, `CONFIGURES`, provenance, confidence reason. |
| `git_changes` | hotspot과 churn 분석을 위한 commit/file/symbol history. |
| `reports` | 안정적인 change analysis output과 evidence ID. |
| `evidence` | redacted source span, command, query result, confidence label, source hash, snippet length, raw-evidence availability flag. |
| `notes` | Obsidian note path와 file/symbol/report backlink. |

graph projection은 이 테이블에서 파생되어야 한다. graph DB가 source of truth가
되면 migration과 consistency 문제가 커진다.

## CLI 표면

```bash
impact-trace init
impact-trace index
impact-trace analyze --base origin/main --head HEAD
impact-trace analyze --diff-file patch.diff
impact-trace explain src/foo.ts:handler
impact-trace mcp serve
```

`impact-trace obsidian sync`는 read-only MCP loop가 안정화된 뒤 구현한다.

## MCP 표면

도구:

| Tool | Output |
|---|---|
| `impact_trace_analyze_diff` | 영향받는 파일, 심볼, 테스트, 문서, owner, risk evidence. |

Resources:

| URI | 의미 |
|---|---|
| `impact://report/{id}` | future full impact report resource. URI encoding과 pagination이 정해질 때까지 보류. |

보안 규칙: 모든 MCP path/URI는 normalize하고, 설정된 repo/vault root 안에 있는지
검증해야 한다. root 밖으로 resolve되면 거절한다.

MCP capability model:

| Capability | 기본값 | 켜는 방법 |
|---|---|---|
| analysis report 읽기 | Enabled | `impact-trace mcp serve` |
| repo snippet 읽기 | redacted only | 항상 redaction과 size cap을 통과한다. |
| Obsidian note 쓰기 | Disabled | `impact-trace mcp serve --allow-write --vault <root>` 필요. |
| project command 실행 | Disabled | v1 범위 밖. |

모든 MCP tool argument는 JSON Schema validation, symlink resolution 이후 realpath
root containment, size limit, time limit, deterministic JSON-RPC error를 가져야
한다. v1에서는 write tool이 `tools/list`에 나오지 않는다. future write mode는
명시적 capability flag와 별도 review가 필요하다.

## Obsidian Export

Markdown note:

| Note | 내용 |
|---|---|
| `Impact Trace/Project Map.md` | package, entry point, dependency boundary, test strategy. |
| `Impact Trace/Hotspots.md` | high-churn file, high fan-in symbol, 반복 failure area. |
| `Impact Trace/Reports/<date>-<branch>.md` | change별 impact packet. |
| `Impact Trace/Symbols/<semantic-id>.md` | symbol facts, caller, test, related note. |
| `Impact Trace/ADRs/*.md` | 채택된 recommendation에서 생성된 human decision. |

Obsidian sync는 기본적으로 dry-run이다. 실제 쓰기는 temp-file-and-rename을
사용하고, 모든 managed note는 stable ID와 previous content hash를 가진다. 사용자
수정이 감지되면 conflict file을 만들고, symlink된 vault path는 거절한다.
`obsidian://open`으로 노트를 여는 것은 optional이고, vault/file 이름은 반드시
URI-encode해야 한다.

## MVP 정의

MVP는 전체 제품보다 좁게 잡는다.

| MVP 포함 | 보류 |
|---|---|
| `init`, `index`, `analyze` | Obsidian auto-sync default behavior |
| JSON/Markdown report | graph DB projection |
| 최소 read-only MCP `impact_trace_analyze_diff` | CodeQL adapter |
| TypeScript/JavaScript extraction | 모든 언어 full semantic analysis |
| secret redaction과 path safety | remote sync |
| report마다 하나의 completed `index_run_id` 사용 | file/symbol MCP resources |

## 구현 단계

| 단계 | 산출물 | 완료 조건 |
|---|---|---|
| 1. Project skeleton | TypeScript CLI, config, test harness, SQLite migrations. | `init`, `index --dry-run`, unit test 통과. |
| 2. TS/JS indexer | file, symbol, import, package, test edge extraction. | fixture repo가 deterministic하게 index된다. |
| 3. Diff impact analyzer | reverse dependency walk와 evidence packet renderer. | exported symbol 변경 시 importer와 test를 찾는다. |
| 4. Read-only MCP server | 최소 `impact_trace_analyze_diff`와 report resources. | write capability 없이 MCP client가 analyze/report read를 할 수 있다. |
| 5. Obsidian export | dry-run-first Markdown report와 project map writer. | tmp vault에 note를 쓰되 unrelated file은 덮어쓰지 않는다. |
| 6. Optional adapters | DuckDB snapshots, vector search, CodeQL, graph projection. | core schema contract 변경 없이 adapter를 켤 수 있다. |

## CEO 리뷰

### 전제 검토

가장 강한 전제는 에이전트에게 durable project map이 필요하다는 점이다. 맞다.
매번 repo를 다시 읽는 방식은 context를 낭비하고, 테스트/문서 같은 non-code
side effect를 놓친다.

가장 약한 전제는 "완벽한 프로젝트 분석"이다. 이 전제는 버려야 한다. 제품은
증명 가능한 것, 추론한 것, 모르는 것을 분리해서 보여줘야 한다. confidence
label은 부가 기능이 아니라 제품의 핵심이다.

graph DB는 optional이다. 따라서 Impact Trace는 graph database project가 아니라
code change evidence product다.

### 기존 코드 활용

repo 내부에 활용할 코드는 없다. 대신 외부의 성숙한 분석 표면을 활용한다.

| 문제 | 활용할 것 |
|---|---|
| TypeScript symbol extraction | TypeScript compiler API와 type checker. |
| editor-grade references | LSP definition/references/call hierarchy. |
| broad language parsing | Tree-sitter parser. |
| deep control/data flow | optional CodeQL database와 query output. |
| agent integration | MCP tools/resources. |
| human knowledge surface | Obsidian Markdown vault와 URI scheme. |

### 구현 대안

| 접근 | 노력 | 리스크 | 장점 | 단점 | 결정 |
|---|---:|---|---|---|---|
| SQLite-first local index | 중간 | 낮음 | 빠른 TTHW, 쉬운 설치, offline 동작, storage-neutral. | recursive graph query는 SQL/projection이 필요하다. | 채택 |
| graph DB core | 중상 | 중간 | dependency traversal과 Cypher query가 자연스럽다. | setup/maintenance 리스크, Kuzu archived, 사용자가 필수 아니라고 함. | 기본값으로는 거절 |
| CodeQL-first semantic engine | 높음 | 중간 | data/control-flow가 강하다. | 설치가 무겁고 language coverage 제약이 있다. | optional adapter |
| Obsidian plugin first | 중간 | 중간 | 사람용 workflow가 좋다. | core analysis 가치가 plugin UX에 묶인다. | 보류 |

## Engineering 리뷰

### Scope Challenge

TypeScript/JavaScript를 첫 high-confidence lane으로 잡고, 다른 언어는 fallback으로
두면 현실적인 범위다. v1에서 모든 언어를 semantic하게 지원하려 하면 일정과
신뢰도가 무너진다.

### Architecture Diagram

```text
+---------------------+
| CLI commands         |
+----------+----------+
           |
+----------v----------+        +---------------------+
| App services         +------->| MCP server          |
| config, repo, diff   |        | tools/resources     |
+----------+----------+        +----------+----------+
           |                              |
+----------v----------+                   |
| Extractor adapters   |                   |
| ts, tree-sitter, lsp |                   |
+----------+----------+                   |
           |                              |
+----------v------------------------------v----------+
| Core index store                                 |
| SQLite: files, symbols, edges, evidence, reports |
+----------+----------------------------------------+
           |
+----------v----------+        +---------------------+
| Analyzer             +------->| Renderers           |
| impact, risk, tests  |        | Markdown, JSON      |
+----------+----------+        +----------+----------+
           |                              |
           |                     +--------v----------+
           |                     | Obsidian vault    |
           |                     +-------------------+
           |
    optional projections
           |
+----------v----------+
| DuckDB / graph / vec |
+---------------------+
```

### Code Quality 결정

| Finding | Decision |
|---|---|
| core behavior가 검증되기 전에 adapter가 너무 많아질 수 있다. | 같은 interface가 실제로 두 구현에서 필요해질 때까지 adapter는 internal로 둔다. |
| confidence label이 모호해질 수 있다. | `proven`, `inferred`, `heuristic`, `unknown`으로 고정한다. |
| CLI와 MCP 결과가 갈라질 수 있다. | 둘 다 같은 service method를 호출하고 shared report ID를 반환한다. |

### Failure Modes Registry

| Failure Mode | Severity | Detection | Recovery |
|---|---|---|---|
| 영향을 받는 파일을 놓침 | High | fixture regression 또는 user report. | extractor edge나 heuristic을 evidence와 함께 추가한다. |
| false positive가 너무 커짐 | Medium | report에 fan-out warning 표시. | package-level summary로 접는다. |
| stale index 사용 | High | index commit/hash와 working tree 비교. | 경고 후 reindex 제안. |
| vault overwrite | High | managed directory와 frontmatter marker 확인. | marker 없으면 중단. |
| MCP가 root 밖 파일을 읽음 | Critical | path validation test. | 요청 거절. |
| secret이 evidence/report/vault로 유출 | Critical | planted secret fixture와 redaction test. | storage/export 전에 redaction pipeline을 적용하고 raw evidence는 opt-in으로 제한. |
| indexing 중 partial SQLite state를 읽음 | High | concurrent CLI/MCP fixture. | WAL mode, one-writer lock, `index_run_id` pinned read transaction. |
| optional adapter unavailable | Low | startup capability check. | 낮은 confidence로 계속 진행. |

### 정확도 게이트

| Metric | v1 Gate |
|---|---:|
| golden diff 기준 affected-file recall | >= 90% |
| critical false-negative count | 0 |
| test recommendation precision | >= 70% |
| stale-index detection | fixture case 100% |
| secret redaction failures | planted secret leak 0건 |

### CLI/MCP 계약

| Contract | Requirement |
|---|---|
| CLI output | 기본은 사람이 읽기 쉬운 출력, automation은 stable `--json` envelope. |
| Exit codes | `0` clean, `1` findings/risk, `2` user/config error, `3` internal error. |
| MCP schemas | tool별 versioned input/output JSON Schema. |
| Resources | large evidence pagination을 지원하는 schema-versioned report resources. |
| Errors | problem, cause, fix, evidence ID를 담는 typed error envelope. |

### Packaging 제약

| Constraint | Requirement |
|---|---|
| Core install | pure JS/WASM 또는 prebuilt package를 우선한다. |
| Optional adapters | DuckDB, CodeQL, graph DB, vector package는 default install 밖에 둔다. |
| CI smoke tests | macOS, Linux, Windows, active Node LTS에서 install smoke test. |
| Doc lint | local absolute home path, hidden tool state, machine-local metadata를 committed docs에서 차단한다. |

## DX 리뷰

### Product Type

로컬 코드 분석과 AI coding workflow를 위한 developer tool.

### Developer Persona

| Field | Value |
|---|---|
| Primary user | 낯선 또는 큰 repo에서 Claude Code/Codex를 쓰는 solo developer 또는 staff engineer. |
| Pain | 에이전트가 side effect를 이해하지 못한 채 코드를 바꾼다. |
| Desired outcome | 수정 전 "무엇이 깨질 수 있고 무엇을 테스트해야 하는지"를 짧고 증거 기반으로 받고 싶다. |
| Tolerance | setup friction은 낮아야 한다. 한계가 투명하면 받아들일 수 있다. |

### Developer Journey Map

| Stage | User Action | Friction | Product Requirement |
|---|---|---|---|
| 1. Discover | README를 읽는다. | graph DB가 필요한지 헷갈린다. | database server가 필요 없다고 명확히 말한다. |
| 2. Install | `npm install -g impact-trace`. | native dependency 리스크. | core install은 가볍게 유지한다. |
| 3. Init | `impact-trace init`. | config가 헷갈린다. | repo default를 자동 감지한다. |
| 4. Index | `impact-trace index`. | 첫 실행이 느릴 수 있다. | 진행률과 skipped file을 보여준다. |
| 5. Analyze | `impact-trace analyze --base ...`. | 빠르게 유용한 결과가 필요하다. | concise summary와 report path를 출력한다. |
| 6. Inspect | Markdown report를 연다. | 정보가 너무 많을 수 있다. | severity와 evidence 기준으로 그룹화한다. |
| 7. Agent use | MCP server를 시작한다. | tool naming/config가 헷갈린다. | copy-paste config snippet을 제공한다. |
| 8. Obsidian | vault notes를 sync한다. | 기존 노트 덮어쓰기 우려. | managed folder와 marker만 쓴다. |
| 9. Repeat | 다음 branch에서 반복한다. | stale index. | incremental update와 freshness 표시. |

### TTHW 목표

| Metric | Target |
|---|---|
| Install | 일반 Node 환경에서 1분 이하. |
| 작은 repo 첫 index | 2분 이하. |
| 첫 유용한 report | zero state에서 5분 이하. |
| MCP setup | copy-paste config 기준 5분 이하. |

### DX Scorecard

| Dimension | 현재 계획 | v1 전 목표 |
|---|---:|---:|
| Getting started | 7 | 9 |
| CLI/API naming | 8 | 9 |
| Error messages | 7 | 9 |
| Documentation | 6 | 9 |
| Upgrade/migration | 5 | 8 |
| Dev environment | 7 | 9 |
| Community/examples | 4 | 7 |
| Measurement/feedback | 6 | 8 |

## Cross-Phase Themes

| Theme | Phases | Action |
|---|---|---|
| evidence over summaries | CEO, Eng, DX | report/evidence schema를 일찍 만든다. |
| optional graph layer | CEO, Eng | graph DB를 core MVP 밖에 둔다. |
| local-first safety | CEO, Eng, DX | v1에는 cloud sync와 script execution을 넣지 않는다. |
| reproducibility로 trust 확보 | Eng, DX | commit, index freshness, source span을 포함한다. |

## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | CEO | graph DB를 core가 아니라 optional로 둔다. | Mechanical | Explicit over clever | 사용자가 필수 아니라고 했고 storage-neutral core가 단순하다. | mandatory graph DB architecture |
| 2 | CEO | SQLite를 v1 canonical store로 쓴다. | Mechanical | Pragmatic | 설치가 쉽고 file/symbol/edge/report table에 충분하다. | Neo4j/Kuzu/Falkor 필수 store |
| 3 | CEO | MCP server를 MVP에 포함한다. | Mechanical | Completeness | Claude Code/Codex가 target surface이므로 CLI-only는 부족하다. | CLI-only MVP |
| 4 | CEO | Obsidian plugin보다 Markdown export를 먼저 한다. | Mechanical | Bias toward action | 즉시 동작하고 plugin distribution 리스크가 없다. | v1 필수 Obsidian plugin |
| 5 | Eng | TypeScript/JavaScript를 먼저 지원한다. | Mechanical | Pragmatic | 초기 사용자에게 accuracy/effort 비율이 좋다. | 모든 언어 semantic 지원 |
| 6 | Eng | CodeQL은 optional adapter로 둔다. | Mechanical | Explicit over clever | 강력하지만 first-run setup이 무겁다. | CodeQL-first architecture |
| 7 | Eng | graph projection은 canonical store에서 파생한다. | Mechanical | DRY | source-of-truth가 둘이 되는 버그를 막는다. | graph DB primary state |
| 8 | DX | TTHW를 5분 이하로 잡는다. | Mechanical | Bias toward action | developer tool은 setup patience가 끝나기 전에 가치를 보여줘야 한다. | heavy bootstrap workflow |
| 9 | Eng | MCP는 기본 read-only로 둔다. | Mechanical | Security first | write tool은 repo/vault 접근 리스크가 크므로 명시적 capability flag가 필요하다. | always-on MCP export/write tools |
| 10 | Eng | storage/export 전에 redaction을 적용한다. | Mechanical | Completeness | evidence는 report나 Obsidian에 도달하기 전에 secret을 포함할 수 있다. | final renderer에서만 redaction |
| 11 | Eng | Obsidian export보다 read-only MCP를 먼저 만든다. | Mechanical | Bias toward action | target user는 agent workflow이고 Obsidian은 core value 이후에 붙여도 된다. | Obsidian before MCP |
| 12 | Eng | 측정 가능한 정확도 게이트를 추가한다. | Mechanical | Explicit over clever | 제품 약속은 정성적 confidence 문구가 아니라 release threshold가 필요하다. | qualitative-only review |

## Review Scores

| Review | Score | Notes |
|---|---:|---|
| CEO | 8/10 | graph DB를 내려놓은 뒤 문제 정의가 명확해졌다. 실제 competitor benchmark는 나중에 필요하다. |
| Design | Skipped | MVP 계획에 UI scope가 없다. |
| Engineering | 8/10 | adapter를 secondary로 유지하면 구현 가능한 아키텍처다. |
| DX | 7/10 | CLI/MCP 형태는 좋다. v1 전 문서와 예제가 더 필요하다. |

## 승인 권장

이 계획을 초기 프로젝트 방향으로 승인한다. 가장 중요한 수정은 이미 반영됐다:
Impact Trace는 graph database project가 아니라 evidence-backed impact analysis
tool이다.
