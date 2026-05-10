# Impact-trace — 비전

**한 문장:** Impact-trace는 Claude Code, Codex 같은 *AI 코딩 에이전트*와 사람이 같은 관계 그래프를 보게 해주는 **local-first impact context layer**다 — 코드, 문서, 정책, 제안서, 의사결정을 연결하고, agent가 repo를 반복해서 읽느라 쓰는 context를 줄이면서 코드 변경 전후에 *무엇이 영향받는지*를 MCP와 UI로 알려준다.

> English: [vision.md](vision.md)

## 테제 (thesis)

AI 코딩 에이전트(Claude Code, Codex, Cursor 등)는 강력하지만 *상태 없음*이 문제다. 매 세션이 cold start — repo를 새로 읽고, 시도한 것을 기억 못 하며, "이 commit이 실제로 어디에 영향을 주는가"에 대한 공유 모델이 없다. 사람이 보기에도 코드, 문서, 정책, 제안서, 고객 요구사항이 흩어져 있어 변경의 파급 범위를 한 화면에서 보기 어렵다. Impact-trace는 이 결손을 local-first 방식으로 메운다:

- **Impact context 축** — 에이전트(또는 사람)가 파일/함수/설정/워크플로/contract/정책/문서를 바꾸기 직전, *repo 안과 repo 사이*의 무엇이 영향받는지를 evidence + confidence와 함께 알려준다. 동시에 precomputed graph와 compact context pack으로 agent가 쓰는 context를 줄인다. 원래 product 축 (`impact-trace-plan.ko.md`의 P0..P4).
- **Agent memory 축** — 에이전트가 관찰/결정/철회/요약/handoff할 때마다 content-addressable fact + provenance로 저장하고, 후속 호출이 entity / attribute / branch / 시간 / semantic similarity로 recall한다. Phase 1..4, ADR D-001..D-018.
- **Human UX 축** — 같은 relation graph를 사람이 탐색할 수 있는 UI로 제공한다. 핵심은 graph DB가 아니라, SQLite에 저장된 canonical graph를 필터·검색·evidence drill-down이 가능한 화면으로 투영하는 것이다.

세 축 모두 **단일 SQLite 파일** `<repo>/.impact-trace/impact.db`를 공유한다. agent는 **MCP tools/resources**로 읽고, 사람은 **CLI/graph export/UI**로 본다. *코드 분석기, 메모리, UI가 따로 노는 것이 아니라 한 impact context layer의 서로 다른 surface*다.

## 제품 모양

| Surface | 역할 | 사용자가 얻는 것 |
|---|---|---|
| **MCP server** | Claude/Codex/Cursor에 compact impact context와 resource URI를 제공 | agent가 수정 전후 관련 코드, 테스트, 문서, 정책, 제안서를 놓치지 않으면서 전체 파일 덤프와 반복 탐색 context를 줄임 |
| **CLI** | index/analyze/graph/export/remember/recall을 로컬에서 실행 | CI, pre-commit, agent hook, 수동 검증에 붙이기 쉬움 |
| **UI explorer** | relation graph, evidence, coverage gap, changed/affected path를 사람이 탐색 | "왜 이 파일과 문서가 영향받는지"를 코드 밖 이해관계자도 볼 수 있음 |
| **Local SQLite store** | canonical source of truth | graph DB나 cloud 없이 재현 가능하고 민감한 repo 정보를 외부로 보내지 않음 |

대표 동작:

1. 사용자가 Claude/Codex로 코드를 수정한다.
2. Impact-trace가 diff를 entity graph에 매핑한다.
3. 관련 코드, 테스트, config, CI, 정책, 문서, PRD/제안서/의사결정 기록을 evidence와 함께 찾는다.
4. MCP는 agent에게 "이 변경을 할 때 알아야 할 맥락"과 "검증해야 할 action"을 준다.
5. UI는 같은 결과를 changed → affected → evidence → action 흐름으로 보여준다.

## 누구를 위한 것인가

| 대상 | 사용 사례 |
|---|---|
| **AI 코딩 에이전트** (Claude Code, Codex, Cursor, 커스텀 MCP 클라이언트) | 코드 수정 전 *영향 컨텍스트* 주입; 관련 코드/문서/정책/제안서 recall; 세션 간 관찰 영속 |
| **agentic 워크플로우 도입 엔지니어** | CI / pre-commit에서 로컬 영향 분석; "에이전트가 이 변경을 만들 때 무엇을 알고 있었는가" 감사 |
| **리뷰어 / PM / 운영 담당자** | UI에서 변경 영향 경로와 evidence 확인; 코드 변경이 정책/문서/고객 약속에 미치는 영향 확인 |
| **도구 빌더** (다른 MCP 서버, IDE 플러그인) | 일시적 에이전트 루프 *밑*의 durable layer로 사용 |

## 왜 local-first인가

D-001이 토대 — 모든 데이터는 `<repo>/.impact-trace/impact.db`. 외부 서비스 없음, cloud sync 없음, graph DB 필수 아님. 이유:

1. **소스 코드는 민감하다** — 사적 repo 구조를 외부 서비스에 보내는 건 많은 팀에게 non-starter.
2. **설치 비용** — 모든 외부 dep (Postgres, Neo4j, hosted vector DB)이 설치 마찰을 두 배. SQLite는 모든 머신에 이미 있다.
3. **오프라인 신뢰성** — 에이전트는 비행기에서, SCIF에서, 방화벽 뒤에서도 작동해야 한다.
4. **단일 파일 이식성** — `impact.db`는 복사·diff·아카이브·샌드박스 가능.

비용: 스케일에서 brute-force 한계. P5 ANN (D-018)이 첫 대응; 추후 P5+ 작업이 partitioning + retention 정책 탐구.

## 정체성 invariants (새 ADR 없이는 재고하지 않는 결정들)

[decisions.ko.md](decisions.ko.md)에 캡처된 load-bearing 결정. 큰 변경을 제안하기 전 반드시 읽는다:

| 그룹 | invariants |
|---|---|
| **저장** | D-001 단일 SQLite 파일 · D-002 SHA-256 content-addressable fact id · D-003 ADD-only schema migration · D-006 `transaction_parents` 다중 부모 · D-007 model-agnostic `fact_embeddings(fact_id, model)` PK |
| **프라이버시** | D-004 redact-then-embed/prompt zero-row · D-012 LLM/embedding SDK 거부 (fetch only) |
| **수명 주기** | D-005 SQLite tx 바깥 async · D-009 명시적 `reflect` trigger (no daemon) · D-010 요약 시 원본 fact 보존 · D-011 soft-delete branch GC (facts 절대 삭제 안 함) |
| **Phase 4 추가** | D-013 lifecycle binary from `is_code_relation` · D-014 Profile API recall과 별도 export · D-015 `reflect --repair` 별도 trigger · D-016 `branch --restore` state + tx unarchive 묶음 · D-017 auto-abandon이 `gc-branches --max-age`에 piggyback · D-018 sqlite-vec ANN per-model vec0 + brute-force fallback |

## 3년 비전

**1년차 (지금):** single repo + single agent에서 MCP impact context가 믿을 만하게 작동. 영향 분석은 TS/JS 깊게, 기타 언어 broadly. 에이전트 메모리는 deterministic stub embedding + 4 LLM provider + sqlite-vec ANN. MCP context pack은 `brief`/`standard`/`deep` budget과 resource-on-demand로 agent context 사용량을 줄인다. UI는 저장된 report/graph를 읽는 첫 explorer로 시작한다.

**2년차:** Cross-repo workspace catalog (impact-trace-plan §"Workspace") + multi-agent 메모리 handoff (Phase 5 후보: concurrent reflect lock, multi-layer reflection). Adapter coverage가 "tier-1 enterprise stack"에 도달 (TS, Python, Go, Rust, Java/Kotlin, C#, C/C++ + YAML/Terraform/Kubernetes/OpenAPI/protobuf).

**3년차:** MemoryBench harness (Phase 5 P0)가 회귀 신호를 제공해 메모리 작업의 품질이 *측정 가능하게* 개선됨 (embedding 모델 / LLM provider / reflection 알고리즘 교차). UI, graph DB projection, IDE/plugin surfaces가 first-class consumer가 되고, impact-trace는 canonical SQLite source of truth로 유지.

## 만들지 *않을* 것들

이 항목들은 검토 후 거부 — context는 [decisions.ko.md](decisions.ko.md). 재제안하려면 새 ADR 필수.

- **필수 graph DB.** Source of truth는 SQLite로 유지.
- **필수 cloud sync.** Local-first는 정체성, phase가 아님.
- **Daemon / 백그라운드 프로세스.** 모든 작업은 사용자 trigger.
- **LLM/embedding SDK.** `fetch`만, provider당 ~30 LOC.
- **자동 코드 수정.** 추천만, 실행 안 함.
- **모든 언어 동시 full semantic 분석.** Tier adapter (P1 → P2)가 깊이 전에 폭을 확보.

## repo 탐색 가이드

| 당신이 ... 라면 | 시작점 |
|---|---|
| 처음 진입하는 AI 에이전트 | 이 파일 → [docs/README.md](README.md) → [decisions.ko.md](decisions.ko.md) |
| 처음 실행하는 엔지니어 | [README.md](../README.md) → [agent-memory-cookbook.ko.md](agent-memory-cookbook.ko.md) |
| 새 feature 설계자 | [decisions.ko.md](decisions.ko.md) → [roadmap.md](roadmap.md) → 현재 phase 계획 문서([phase6b-ts-accuracy-plan.ko.md](phase6b-ts-accuracy-plan.ko.md) 등) |
| 릴리스를 만드는 maintainer | [CHANGELOG.md](../CHANGELOG.md) → [progress.ko.md](progress.ko.md) |
| 오픈소스 / 새 팀원 온보딩 | 이 파일 → [glossary.md](glossary.md) → [skills/impact-trace/SKILL.md](../skills/impact-trace/SKILL.md) |
