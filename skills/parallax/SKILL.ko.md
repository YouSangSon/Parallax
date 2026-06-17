---
name: parallax
description: Local-first code impact analyzer + agent memory layer for Claude Code, Codex, and other agentic coding tools. Use when you need to analyze how a code change ripples through a repository, persist agent decisions/observations as content-addressable facts, run reflective consolidation on long-running memory, or surface a per-entity profile of static (code structure) + dynamic (agent activity) + summary (LLM-consolidated) context. Single SQLite database, no cloud dependencies, MCP-native.
---

# Parallax Skill

[English](SKILL.md) · **한국어** · [中文](SKILL.zh.md)

Parallax는 AI 코딩 에이전트를 위한 local-first code-aware memory layer다. 저장소를 entity와 relation으로 인덱싱하고, agent observation을 transaction DAG 위의 content-addressable fact로 받아들이며, 그 통합된 view를 MCP tool과 CLI를 통해 노출한다.

## When to invoke

- "How does this change ripple?" → `analyze`
- "Which policies/proposals/decisions mention this code?" → repo-local Markdown 작업 산출물을 인덱싱한 뒤 analyze 또는 MCP context tool 사용
- "Remember/recall an agent decision" → `remember` / `recall`
- "Find relevant indexed context without reading files" → MCP `parallax_search_context`
- "What does this entity directly touch?" → MCP `parallax_explain_entity` 또는 memory context를 위한 CLI `profile`
- "Summarize old episodic facts" → `reflect` ()
- "Trace why I decided X" → `trace`
- "Mark this experiment branch dead and clean it up" → `branch --abandon` 그다음 `gc-branches` ()

## Quickstart

```bash
# 1. Install (one-time, in the target repo)
npm install -g parallax          # or use this checkout via npm link

# 2. Initialize and index the repo
parallax init
parallax index

# 3. Analyze a code change
parallax analyze --changed src/auth/session.ts
# or use git diff:
parallax analyze --base main --head HEAD --json

# 4. Persist an agent observation
parallax remember --entity file:src/auth/session.ts \
                      --attribute observed --value '"compiled"'

# 5. Profile an entity (combined static + dynamic + summary view)
parallax profile --entity file:src/auth/session.ts

# 6. Run on a branch — no data copy on fork
parallax branch --name plan-A
parallax remember --branch plan-A --entity file:foo.ts \
                      --attribute concern --value '"TODO: refactor"'

# 7. Consolidate older facts (LLM call)
PARALLAX_REFLECTION_MODEL=stub parallax reflect --older-than-days 30

# 8. Speculative branch GC (soft-delete only — facts never destroyed)
parallax branch --abandon plan-A
parallax gc-branches
```

## MCP integration

MCP 클라이언트 설정에 추가한다:

```json
{
  "mcpServers": {
    "parallax": {
      "type": "stdio",
      "command": "parallax",
      "args": ["mcp", "serve"]
    }
  }
}
```

또는 Claude Code CLI를 통해:

```bash
claude mcp add --transport stdio parallax -- parallax mcp serve
```

## MCP tools surfaced (18)

| Tool | Read-only? | What it does |
|---|---|---|
| `parallax_analyze_diff` | ❌ | 변경된 파일 목록에 대해 impact analysis 실행 |
| `parallax_context_for_change` | ❌ | 변경된 파일에 대한 budget이 적용된 compact context pack 반환 |
| `parallax_search_context` | ❌ | keyword/path/symbol/relation/evidence로 최신 인덱싱된 entity를 검색하고, resource link와 함께 순위가 매겨진 context 반환 |
| `parallax_contract_diff` | ❌ | 현재 OpenAPI contract 파일을 최신 인덱싱된 workspace baseline과 비교해 compact한 breaking-change impact 반환 |
| `parallax_remember` | ❌ | agent fact(entity, attribute, value)를 branch에 저장 |
| `parallax_recall` | ✅ | branch / entity / attribute / semantic query로 fact 조회 (brute-force fallback이 있는 sqlite-vec ANN) |
| `parallax_profile` | ✅ | entity별 three-bucket view (static / dynamic / summary) —  |
| `parallax_explain_entity` | ❌ | 인덱싱된 entity 하나에 대한 compact한 직접 incoming/outgoing relation 및 evidence view |
| `parallax_branch` | ❌ | 기존 branch에서 새 branch fork (data copy 없음) |
| `parallax_merge` | ❌ | 두 branch head를 결합하는 multi-parent merge transaction |
| `parallax_abandon_branch` | ❌ | branch를 state='abandoned'로 표시 (idempotent, main은 보호됨) |
| `parallax_restore_branch` | ❌ | abandon+gc 되돌리기 — 단일 atomic call로 `state='active'` AND `archived=0` () |
| `parallax_gc_branches` | ❌ | abandoned branch의 transaction을 archive (soft-delete). 시간 기반 자동 abandon을 위한 `maxAgeDays` opt-in () |
| `parallax_reflect` | ❌ | entity별로 오래된 fact를 LLM으로 summary fact로 요약 |
| `parallax_repair_reflections` | ❌ | SAVEPOINT atomicity gap으로 남은 orphan summary fact를 정합화 () |
| `parallax_trace` | ✅ | fact_provenance edge를 따라 evidence source까지 거슬러 탐색 |
| `parallax_context_telemetry` | ✅ | 최근 local MCP context tool 실행과 resource read를 반환해, 어떤 compact context가 실제로 확장됐는지 agent와 UI가 측정 |
| `parallax_doctor` | ✅ | schema, 최신 index, coverage, adapter run, vector 상태, context telemetry 가용성을 다루는 read-only local health report |

Read-only resources: `parallax://reports/{id}`, `parallax://entities/{id}`, `parallax://evidence/{id}`, `parallax://reports/{id}/graph/{format}`, `parallax://coverage/latest`.

## Identity and invariants

- **Local-first single SQLite `.db` file.** 기본적으로 외부 네트워크를 사용하지 않는다. memory layer 전체가 `<repo>/.parallax/impact.db`에 존재한다.
- **Content-addressable fact id.** `id = SHA-256(entity || attribute || value || op)`. 동일한 observation은 절대 중복되지 않는다.
- **ADD-only schema migration.** column과 table은 추가되며, 아무것도 drop되지 않는다. `src/store.ts`에 있는 allowlist로 보호되는 `tryAddColumn` helper.
- **Soft-delete only.** fact는 절대 DELETE되지 않는다. Branch GC는 *transaction*을 archive해서(`transactions.archived = 1`) recall이 더 이상 그것을 surface하지 않도록 하지만, 기저의 fact row는 살아남으며 다른 branch에서 참조될 수 있다.
- **Redact-then-prompt gate.** 모든 LLM input/output은 `redactSecrets()`를 거친다 (12개 secret family: OpenAI/Stripe/GitHub/Slack/AWS access key/AWS secret/Google/npm/JWT/Bearer/DB URL/Private key). Redact된 fact는 value_blob='[REDACTED]'와 빈 embedding row를 갖는다.
- **async-outside-tx pattern.** Embedding과 LLM 연산은 SQLite transaction이 열리기 *전에* 일어난다. 동기 `withAgentMemoryDb` 콜백은 쓰기만 수행한다.

## Lifecycle of a fact

```
attribute_defs.is_code_relation = 1  →  static fact (indexer-emitted)
attribute_defs.is_code_relation = 0  →  dynamic fact (agent-decision)
attribute = 'reflection'              →  summary fact ( consolidation)
```

`profile` tool은 이 축을 따라 fact를 분할한다. lifecycle이 저장되는 것이 아니라 derive된다는 원칙은 `docs/invariants.md`를 참고한다.

## When NOT to use

- 여러 사용자에 걸친 cloud-hosted memory → 대신 [supermemory](https://supermemory.ai)를 사용한다.
- PDF / image / video 추출 — 범위 밖이다. parallax는 코드에 초점을 둔다.
- 실시간 analytics 대시보드 — 이것은 로컬 단일 사용자 도구다.

## Reference docs

심층 architecture 세부사항은 `references/architecture.md`를 참고한다.

전체 design rationale과 decision log는 다음을 참고한다:
- `docs/vision.md` / `docs/vision.ko.md` — one-page thesis (여기서 시작)
- `docs/roadmap.md` — 두 축(impact analysis + agent memory)을 아우르는 통합 roadmap
- `docs/glossary.md` — 두 축에 걸친 branch/entity/transaction을 명확히 구분
- `docs/invariants.md` — load-bearing 원칙
- `docs/vision.ko.md` — 프로젝트 방향성
- `docs/roadmap.md` — 다음 작업
