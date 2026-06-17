# Parallax — MCP 레퍼런스

[English](mcp.md) · **한국어** · [中文](mcp.zh.md)

Parallax는 MCP(Model Context Protocol) **stdio** 서버를 제공해, Claude Code, Codex 같은 코딩 에이전트가 CLI와 UI가 쓰는 것과 같은 SQLite 저장소 위의 impact graph, agent memory, 분석 surface를 읽게 한다. 이 문서는 서버를 실행하는 방법과 서버가 등록하는 모든 tool 및 resource를 다룬다.

## 서버 실행

```bash
parallax mcp serve
```

서버는 stdio 위에서 MCP를 말한다(`StdioServerTransport`). 현재 작업 디렉터리의 repo를 대상으로 동작한다 — `repoRoot`는 실행한 디렉터리이고, 모든 읽기/쓰기는 그 repo의 `<repo>/.parallax/impact.db`로 간다. tool이 읽을 완료된 index run이 있도록 repo를 최소 한 번 인덱싱(`parallax index`)해 두자.

## MCP 클라이언트에 등록

Parallax를 어떤 MCP 클라이언트에든 stdio 서버로 등록한다. 개념적으로 클라이언트가 `parallax mcp serve`를 자식 프로세스로 띄우고 stdio로 통신한다. Claude Code나 Codex에서는 분석하려는 repo에서 그 명령을 클라이언트가 가리키게 한다. 서버는 작업 디렉터리에서 repo를 해석하므로, 대상 repo를 현재 디렉터리로 두고 실행한다.

## read-only-first 불변 원칙

Parallax는 불변 원칙 **I-8**([invariants.ko.md](invariants.ko.md) 참고)을 따른다 — agent surface는 안전한 read-only 분석 계층을 먼저 안정화하고, 쓰기 권한은 별도 모델과 리뷰 뒤에만 추가한다. 각 tool은 MCP `readOnlyHint` 어노테이션을 선언한다. 표에서 `readOnlyHint: true`는 source tree를 수정하지 않는다는 뜻이지, local database write가 전혀 없다는 뜻은 아니다. analysis/search/context tool은 응답 과정에서 `.parallax/impact.db`에 `context_tool_runs` telemetry 행과 context-pack 행을 추가할 수 있고, MCP resource read는 `context_resource_accesses` telemetry 행을 추가할 수 있다. `readOnlyHint: false` tool에는 명시적 memory write와 branch 관리 tool이 포함된다. 이들 중 어느 것도 source tree를 수정하지 않는다 — action은 추천일 뿐이다(불변 원칙 **I-9**).

## Tool

등록된 tool은 모두 `parallax_` 접두사를 사용한다. 이 표는 MCP `tools/list` 응답과 대조해 검증되며, *read-only* 열은 각 tool의 `readOnlyHint` 어노테이션을 반영한다.

| Tool | 역할 | read-only |
| :--- | :--- | :--- |
| `parallax_analyze_diff` | 변경된 파일을 최신 완료 index에 대해 분석하고 전체 impact report를 반환 | 아니오 |
| `parallax_context_for_change` | 변경된 파일에 대해 budget(`brief`/`standard`/`deep`)에 맞춘 context pack — 랭크된 impact path, evidence 참조, resource link를 반환 | 아니오 |
| `parallax_search_context` | 최신 index를 keyword, path, symbol, relation provenance, evidence snippet으로 검색해 랭크된 entity context를 반환 | 아니오 |
| `parallax_contract_diff` | 현재 OpenAPI contract 파일을 인덱싱된 workspace baseline과 비교해 compact한 breaking-change impact를 반환 | 아니오 |
| `parallax_remember` | agent 관찰을 branch 위의 content-addressable fact로 저장(`assert`/`retract`) | 아니오 |
| `parallax_recall` | entity, attribute, branch로 fact를 질의(선택적으로 semantic) | 예 |
| `parallax_branch` | 기존 branch(기본 `main`)에서 새 memory branch를 분기; 데이터 복사 없음 | 아니오 |
| `parallax_merge` | target에서의 recall이 두 branch DAG를 모두 걷도록 merge transaction을 생성 | 아니오 |
| `parallax_reflect` | 오래된 fact를 entity별로 묶어 각 그룹을 provenance가 달린 새 summary fact로 요약 | 아니오 |
| `parallax_abandon_branch` | 이후 GC가 transaction을 archive하도록 branch를 abandoned로 표시(`main`은 abandon 불가) | 아니오 |
| `parallax_gc_branches` | abandoned branch의 transaction을 archive해 recall이 더 이상 노출하지 않게 함; fact 자체는 삭제되지 않음 | 아니오 |
| `parallax_profile` | 한 entity에 대한 fact를 static / dynamic / summary 버킷으로 집계 | 예 |
| `parallax_explain_entity` | 인덱싱된 한 entity의 직접 relation과 evidence context를 compact하게 반환 | 아니오 |
| `parallax_context_telemetry` | 최근 MCP context tool 실행과 resource 읽기를 반환해 무엇이 확장됐는지 확인 | 예 |
| `parallax_doctor` | read-only 헬스 리포트(schema, 최신 index, coverage, adapter run, vector 상태)를 반환 | 예 |
| `parallax_repair_reflections` | orphan reflection fact의 잃어버린 provenance edge와 audit 행을 복구(idempotent) | 아니오 |
| `parallax_restore_branch` | abandoned branch를 active로 되돌리고 transaction을 un-archive(idempotent) | 아니오 |
| `parallax_trace` | `fact_provenance` edge를 fact에서 evidence chain을 따라 거슬러 걷는다 | 예 |

## Resource

Resource는 MCP resource URI로 읽는다. 템플릿 URI는 `{...}` 구간을 확장하며, `parallax://coverage/latest`는 고정 URI다.

| Resource | URI / 템플릿 | 역할 |
| :--- | :--- | :--- |
| `parallax_reports` | `parallax://reports/{reportId}` | 저장된 impact report JSON 문서 |
| `parallax_entities` | `parallax://entities/{entityId}` | 최신 완료 index run의 canonical 인덱싱 entity |
| `parallax_evidence` | `parallax://evidence/{evidenceId}` | source span, redacted snippet, relation context가 담긴 relation evidence |
| `parallax_context_packs` | `parallax://context-packs/{contextPackId}` | 반복 재사용을 위해 content hash로 키잉된 compact context pack |
| `parallax_workspaces` | `parallax://workspaces/{workspaceName}` | workspace catalog 멤버십과 contract/cross-repo impact resource로의 link |
| `parallax_workspace_contracts` | `parallax://workspaces/{workspaceName}/contracts` | 로컬 workspace catalog 전반의 최신 인덱싱 contract baseline |
| `parallax_workspace_cross_repo_links` | `parallax://workspaces/{workspaceName}/cross-repo-links` | workspace 범위의 provider/consumer 및 breaking contract impact link |
| `parallax_graphs` | `parallax://reports/{reportId}/graph/{format}` | report 범위의 relationship graph 투영(`mermaid`, `json`, `dot`) |
| `parallax_coverage_latest` | `parallax://coverage/latest` | 최신 완료 index run의 index coverage 행 |

graph export는 tool이 아니라 `parallax_graphs` **resource**로 제공된다 — `format`이 `mermaid`, `json`, `dot` 중 하나인 `parallax://reports/{reportId}/graph/{format}`를 읽는다. 동등한 CLI 형태는 `parallax graph export`다([cli-reference.ko.md](cli-reference.ko.md) 참고).

JSON graph resource는 `?limit=100&cursor=nodeOffset:edgeOffset`로 페이지를 나눌 수 있고, CLI JSON graph export도 `parallax graph export --format json --limit 100 --cursor nodeOffset:edgeOffset`로 같은 contract를 사용한다. paged request에서 `limit` 기본값은 `100`이며 `1`부터 `500` 사이여야 한다. 다음 페이지 cursor는 `page.nextCursor`로 반환된다. 잘못된 pagination은 MCP `invalid_pagination`을 반환하고, UI는 같은 validation을 `invalid_request`로 매핑하며, CLI는 같은 graph page validation error를 출력하고 exit code `2`로 종료한다.

## 함께 보기

- [cli-reference.ko.md](cli-reference.ko.md) — 같은 저장소 위의 로컬 CLI surface
- [extending-adapters.ko.md](extending-adapters.ko.md) — tool이 읽는 인덱싱된 graph가 어떻게 만들어지는가
- [invariants.ko.md](invariants.ko.md) — read-only-first와 evidence-first 불변 원칙
- [glossary.ko.md](glossary.ko.md) — context pack, evidence, confidence 같은 용어
