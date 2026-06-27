# Parallax — CLI 레퍼런스

[English](cli-reference.md) · **한국어** · [中文](cli-reference.zh.md)

`parallax` CLI는 indexing, impact 분석, graph export, agent memory, workspace catalog, 진단, MCP 서버, UI로 들어가는 로컬 진입점이다. 모든 명령은 현재 작업 디렉터리의 repo를 대상으로 실행되며 `<repo>/.parallax/impact.db`를 읽고 쓴다. 내장 요약은 `parallax --help`(또는 `-h`)로 본다.

대부분의 machine-oriented 명령은 command-specific flag로 JSON을 출력할 수 있다. `analyze`는 기본적으로 사람이 읽는 요약을 출력하고, `graph export`는 기본적으로 Mermaid 텍스트를 출력한다.

## Indexing

| 명령 | 목적 |
| :--- | :--- |
| `parallax init` | repo의 로컬 `.parallax/` 저장소와 새 데이터베이스를 생성 |
| `parallax index [--max-file-bytes <n>]` | repo를 스캔해 entity/relation graph를 추출; `--max-file-bytes`는 파일당 스캔 크기를 제한 |
| `parallax reindex-vec [--model <hf-model>]` | sqlite-vec ANN 인덱스를 재구축; `--model`은 embedding 모델을 선택 |
| `parallax reembed [--model <hf-model>] [--all]` | fact embedding을 재계산; `--all`은 모든 fact를 재임베딩, 아니면 누락분만 |

## Analysis

| 명령 | 목적 |
| :--- | :--- |
| `parallax analyze --changed <file[,file]> [--depth <n>] [--max-fanout <n>] [--json] [--sarif-output <path>]` | 명시한 변경 파일 목록을 최신 index에 대해 분석 |
| `parallax analyze --base <ref> [--head <ref>] [--depth <n>] [--max-fanout <n>] [--json] [--sarif-output <path>]` | `git diff <base>...<head>`(기본 head `HEAD`)에서 변경 파일 목록을 도출 |
| `parallax query "<cypher>"` | 인덱싱된 그래프에 읽기전용 Cypher 서브셋을 실행하고 JSON 행을 출력 |
| `parallax ingest-traces --file <traces.json>` | 관측된 런타임 `source -> target` 엣지와 매칭되는 관계를 `proven` 신뢰도로 승격 |

`query` 서브셋은 양방향(`->` 또는 `<-`)의 선택적 관계 hop(고정 또는 가변 길이 `*`, `*N`, `*min..max`; max는 8로 제한), 노드 label, `WHERE` 등호 / `CONTAINS`, 투영, `COUNT(<var>)` 집계(비집계 `RETURN` 항목이 암묵적 그룹 키가 됨), 투영된 컬럼에 대한 `ORDER BY`(`ASC`/`DESC`), `LIMIT`를 지원한다 — 예: `MATCH (a)-[r:DEPENDS_ON]->(b) WHERE a.path CONTAINS 'store' RETURN a.path, b.path ORDER BY b.path DESC LIMIT 20`, "무엇이 X에 의존하는가" 역방향 `MATCH (x)<-[r:DEPENDS_ON]-(d) WHERE x.path = 'src/store.ts' RETURN d.path`, "X에서 도달 가능한 전부" 전이 형태 `MATCH (x)-[:DEPENDS_ON*1..3]->(dep) WHERE x.path = 'src/store.ts' RETURN dep.path`, 또는 "가장 많이 의존되는 파일" 형태 `MATCH (a)-[r:DEPENDS_ON]->(b) RETURN b.path, COUNT(a) ORDER BY COUNT(a) DESC LIMIT 10`. write·procedure·projection(`WITH`/`UNWIND`)·`COUNT(*)`·양방향 구문은 거부되며, 가변 길이 경로의 관계 변수는 투영할 수 없고, `ORDER BY`는 투영된 컬럼만 받으며, `COUNT`는 가변 길이 경로에 쓸 수 없다. `ingest-traces`는 읽기전용 MCP에서 분리된 write 표면(invariant **I-8**)이며, 런타임 관측은 신뢰도를 올리기만 한다.

플래그:

- `--changed` — 쉼표로 구분된 변경 파일(`--base`/`--head`와 상호 배타).
- `--base` / `--head` — Git ref; `--head`는 `--base`를 요구한다. `--base`/`--head`/`--changed`가 없으면 positional 파일 경로를 받는다.
- `--depth` — ripple 계산의 최대 traversal 깊이.
- `--max-fanout` — traversal 중 노드당 최대 fan-out.
- `--json` — 요약 대신 전체 report JSON을 출력하고, report를 저장소에 쓰지 않는다. 출력은 발행된 [report JSON Schema](report-schema.ko.md)에 대해 검증된다.
- `--sarif-output <path>` — GitHub Code Scanning upload용 SARIF 2.1.0 projection을 예쁘게 포맷한 JSON 파일로 쓴다. 부모 디렉터리는 생성된다. stdout에는 일반 human summary를 유지하며 `--json`과 함께 쓸 수 없다.
- `--sarif-category <category>` — SARIF run automation id / GitHub Code Scanning category를 설정한다. GitHub Action 같은 wrapper가 넘기지 않으면 category는 비워 둔다.
- `--fail-on <level>` — 종료 코드를 confidence로 제어: `proven` / `inferred` / `heuristic`는 영향 파일이 해당 confidence 이상일 때만 실패; `any`(기본)는 영향 파일이 있으면 실패; `none`은 절대 실패하지 않음. CI에서 고신뢰 영향만 게이트할 때 사용.

기본(`--json` 없음)에서는 report가 저장되고 짧은 요약이 출력되며, 기록 시 report 경로가 표시된다.

변경 파일이 인덱싱된 provider contract이고 workspace에 저장된 `BREAKS_COMPATIBILITY_WITH` link가 이미 있으면, `analyze`는 `crossRepoImpacts`도 포함한다. 각 항목은 consumer service, consumer file, provider contract, breaking change, confidence, evidence snippet, workspace resource URI를 식별한다. `analyze`는 contract diff를 자동 실행하지 않는다. workspace가 오래됐으면 먼저 `parallax workspace contract-diff`로 link를 갱신한다.

## Graph

| 명령 | 목적 |
| :--- | :--- |
| `parallax graph export --report <id> [--format mermaid\|json\|dot] [--limit <n>] [--cursor <cursor>]` | 저장된 report의 relationship graph를 렌더; 기본 형식은 `mermaid` |

`--limit`와 `--cursor`는 `--format json`에서만 적용된다. MCP/UI graph JSON pagination과 같은 `nodeOffset:edgeOffset` cursor 및 `1..500` limit contract를 사용한다.

## Agent memory

| 명령 | 목적 |
| :--- | :--- |
| `parallax remember --entity <id> --attribute <name> --value <json\|string> [--branch <name>] [--agent <id>] [--op assert\|retract] [--evidence-fact-ids id1,id2] [--supersedes-fact-ids id1,id2]` | fact를 content-addressable 관찰로 저장 |
| `parallax retract --entity <id> --attribute <name> --value <json\|string> [--branch <name>] [--agent <id>]` | 철회를 저장(`remember --op retract`와 동등) |
| `parallax recall [--query <text>] [--semantic] [--entity <id>] [--attribute <name>] [--branch <name>] [--k <n>] [--as-of-tx <tx-id>] [--current-only]` | filter 또는 semantic similarity로 fact를 질의 |
| `parallax profile --entity <id> [--branch <name>] [--k <n>] [--as-of-tx <tx-id>]` | entity의 fact를 static / dynamic / summary 버킷으로 집계 |
| `parallax trace --fact-id <id> [--depth <n>]` | fact의 provenance/evidence chain을 걷는다 |
| `parallax branch --name <name> [--from <name>]` | 기존 branch(기본 `main`)에서 새 branch를 분기 |
| `parallax branch --abandon <name>` | branch를 abandoned로 표시 |
| `parallax branch --restore <name>` | abandoned branch를 active로 복원 |
| `parallax merge --target <branch> --source <branch> [--agent <id>]` | source branch를 target에 merge |
| `parallax reflect [--branch <name>] [--older-than-days <n>] [--entity <id>] [--model <provider:id>] [--agent <id>] [--dry-run]` | 오래된 fact를 새 summary fact로 요약 |
| `parallax reflect --repair [--branch <name>] [--dry-run]` | orphan reflection fact의 잃어버린 provenance를 복구 |
| `parallax gc-branches [--dry-run] [--max-age <days>]` | abandoned branch의 transaction을 archive; `--max-age`는 오래된 active branch를 먼저 auto-abandon |
| `parallax import-session --file <path> --format codex\|claude [--branch <name>] [--agent <id>]` | agent 세션 transcript를 memory로 가져오기 |

`--value`로 넘기는 `remember`/`recall` 값은 가능하면 JSON으로 파싱되고 아니면 문자열로 취급된다. `--op` 플래그는 `assert` 또는 `retract`를 받으며, `retract`는 `remember --op retract`의 단축형이다.

## Workspace

| 명령 | 목적 |
| :--- | :--- |
| `parallax workspace init [--name <name>] [--service <service>] [--force]` | 이 repo의 workspace catalog를 생성 또는 재생성 |
| `parallax workspace add-repo <path> [--name <name>] [--service <service>] [--remote <url>]` | 다른 로컬 repo를 workspace catalog에 등록 |
| `parallax workspace list [--name <name>] [--json]` | workspace와 멤버 repo를 나열 |
| `parallax workspace resolve-contracts [--name <name>] [--json]` | cross-repo provider/consumer contract link를 해석 |
| `parallax workspace contract-diff --contract <path> [--name <name>] [--provider <service>] [--provider-path <path>] [--json]` | contract 파일을 인덱싱된 workspace baseline과 diff |
| `parallax workspace verify [--name <name>] [--json]` | 저장된 cross-repo link를 검증하고 malformed, stale, orphan row를 표시 |
| `parallax workspace consumers --provider <service> [--contract <path>] [--method <method>] [--path <route>] [--name <name>] [--json]` | 저장된 workspace link에서 provider의 consumer를 나열 |
| `parallax workspace providers --consumer <service> [--file <path>] [--name <name>] [--json]` | 저장된 workspace link에서 consumer가 사용하는 provider를 나열 |

`workspace verify`, `workspace consumers`, `workspace providers`는 저장된 link만 읽는다. resolution이나 contract diff를 실행하지 않는다. `CONSUMES_HTTP_ENDPOINT` link를 갱신하려면 `workspace resolve-contracts`를 사용하고, `BREAKS_COMPATIBILITY_WITH` link를 갱신하려면 `workspace contract-diff`를 사용한다.

`workspace add-repo`는 repo 경로를 positional 인자로 받는다. cross-repo 범위는 사용자가 명시적으로 등록한 로컬 repo로 한정된다 — clone이나 네트워크 접근 없음.

## Diagnostics

| 명령 | 목적 |
| :--- | :--- |
| `parallax doctor` | 헬스 리포트(schema, 최신 index, coverage, adapter run, vector 상태)를 출력 |

## MCP

| 명령 | 목적 |
| :--- | :--- |
| `parallax mcp serve` | 현재 repo의 MCP stdio 서버를 시작([mcp.ko.md](mcp.ko.md) 참고) |
| `parallax install-agent [--config <path>] [--name <name>] [--dry-run]` | 클라이언트의 `mcpServers` 설정에 Parallax 읽기전용 MCP 서버를 등록(기본 `.mcp.json`); `--dry-run`은 쓰지 않고 병합 결과만 미리보기 |
| `parallax install-agent --copilot-package --target <repo> [--config <path>] [--name <name>] [--dry-run] [--force]` | 명시한 대상 repo에 GitHub Copilot package를 계획 또는 설치: `.github/copilot-instructions.md`, `.github/agents/parallax-impact.agent.md`, 그리고 `--config`가 있을 때만 MCP 설정 snippet |

Copilot package 명령은 명시한 `--target <repo>` 아래에만 쓴다. GitHub를 호출하거나 push하지 않으며, 이 Parallax repo를 `--target`으로 넘기지 않는 한 이 repo를 수정하지 않는다. `--dry-run`은 계획된 상대 경로와 action을 출력하고, 기존 파일은 `--force`가 없으면 건너뛴다.

## UI

| 명령 | 목적 |
| :--- | :--- |
| `parallax ui [--report <id>] [--port <n>]` | 로컬 UI explorer를 시작; `--report`는 특정 report를 열고, `--port`는 리슨 포트를 지정 |

UI는 중단(`SIGINT`/`SIGTERM`)될 때까지 실행되며, 시작 시 URL을 출력한다.

## Exit code

| 코드 | 의미 |
| :--- | :--- |
| `0` | 성공 |
| `1` | `analyze`가 하나 이상의 affected 파일을 찾음(변경에 impact가 있다는 의도된 CI/agent 신호), 또는 `doctor`가 헬스 오류를 찾음 |
| `2` | 명령이 오류를 던짐(알 수 없는 명령, 누락된 필수 플래그, 기타 실패) |

impact 시 `analyze`의 exit code `1`은 의도된 것이다 — CI 작업과 agent hook이 "이 변경이 다른 파일에 영향을 준다"를 report 파싱 없이 non-zero 신호로 다룰 수 있게 한다.

## 함께 보기

- [mcp.ko.md](mcp.ko.md) — 같은 저장소 위의 MCP 서버 surface
- [report-schema.ko.md](report-schema.ko.md) — `analyze --json` 출력의 발행된 JSON Schema
- [extending-adapters.ko.md](extending-adapters.ko.md) — `parallax index`가 graph를 추출하는 방식
- [invariants.ko.md](invariants.ko.md) — local-first, explicit-trigger, read-only-first 불변 원칙
- [glossary.ko.md](glossary.ko.md) — 용어
