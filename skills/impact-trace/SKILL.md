---
name: impact-trace
description: Local-first code impact analyzer + agent memory layer for Claude Code, Codex, and other agentic coding tools. Use when you need to analyze how a code change ripples through a repository, persist agent decisions/observations as content-addressable facts, run reflective consolidation on long-running memory, or surface a per-entity profile of static (code structure) + dynamic (agent activity) + summary (LLM-consolidated) context. Single SQLite database, no cloud dependencies, MCP-native.
---

# Impact-Trace Skill

Impact-trace is the local-first code-aware memory layer for AI coding agents. It indexes a repository into entities and relations, accepts agent observations as content-addressable facts on a transaction DAG, and exposes the combined view through MCP tools and a CLI.

## When to invoke

- "How does this change ripple?" → `analyze`
- "Which policies/proposals/decisions mention this code?" → analyze or MCP context tools after indexing repo-local Markdown work artifacts
- "Remember/recall an agent decision" → `remember` / `recall`
- "Find relevant indexed context without reading files" → MCP `impact_trace_search_context`
- "What does this entity directly touch?" → MCP `impact_trace_explain_entity` or CLI `profile` for memory context
- "Summarize old episodic facts" → `reflect` ()
- "Trace why I decided X" → `trace`
- "Mark this experiment branch dead and clean it up" → `branch --abandon` then `gc-branches` ()

## Quickstart

```bash
# 1. Install (one-time, in the target repo)
npm install -g impact-trace          # or use this checkout via npm link

# 2. Initialize and index the repo
impact-trace init
impact-trace index

# 3. Analyze a code change
impact-trace analyze --changed src/auth/session.ts
# or use git diff:
impact-trace analyze --base main --head HEAD --json

# 4. Persist an agent observation
impact-trace remember --entity file:src/auth/session.ts \
                      --attribute observed --value '"compiled"'

# 5. Profile an entity (combined static + dynamic + summary view)
impact-trace profile --entity file:src/auth/session.ts

# 6. Run on a branch — no data copy on fork
impact-trace branch --name plan-A
impact-trace remember --branch plan-A --entity file:foo.ts \
                      --attribute concern --value '"TODO: refactor"'

# 7. Consolidate older facts (LLM call)
IMPACT_TRACE_REFLECTION_MODEL=stub impact-trace reflect --older-than-days 30

# 8. Speculative branch GC (soft-delete only — facts never destroyed)
impact-trace branch --abandon plan-A
impact-trace gc-branches
```

## MCP integration

Add to your MCP client config:

```json
{
  "mcpServers": {
    "impact-trace": {
      "type": "stdio",
      "command": "impact-trace",
      "args": ["mcp", "serve"]
    }
  }
}
```

Or via the Claude Code CLI:

```bash
claude mcp add --transport stdio impact-trace -- impact-trace mcp serve
```

## MCP tools surfaced (15)

| Tool | Read-only? | What it does |
|---|---|---|
| `impact_trace_analyze_diff` | ✅ | Run impact analysis for a list of changed files |
| `impact_trace_context_for_change` | ✅ | Return a budgeted compact context pack for changed files |
| `impact_trace_search_context` | ✅ | Search latest indexed entities by keyword/path/symbol/relation/evidence and return ranked context with resource links |
| `impact_trace_remember` | ❌ | Persist an agent fact (entity, attribute, value) on a branch |
| `impact_trace_recall` | ✅ | Retrieve facts by branch / entity / attribute / semantic query (sqlite-vec ANN with brute-force fallback) |
| `impact_trace_profile` | ✅ | Three-bucket per-entity view (static / dynamic / summary) —  |
| `impact_trace_explain_entity` | ✅ | Compact direct incoming/outgoing relation and evidence view for one indexed entity |
| `impact_trace_branch` | ❌ | Fork a new branch from an existing branch (no data copy) |
| `impact_trace_merge` | ❌ | Multi-parent merge transaction joining two branch heads |
| `impact_trace_abandon_branch` | ❌ | Mark a branch state='abandoned' (idempotent, main protected) |
| `impact_trace_restore_branch` | ❌ | Reverse abandon+gc — `state='active'` AND `archived=0` in one atomic call () |
| `impact_trace_gc_branches` | ❌ | Archive transactions of abandoned branches (soft-delete). `maxAgeDays` opt-in for time-based auto-abandon () |
| `impact_trace_reflect` | ❌ | LLM-summarize older facts per-entity into summary facts |
| `impact_trace_repair_reflections` | ❌ | Reconcile orphan summary facts left by SAVEPOINT atomicity gap () |
| `impact_trace_trace` | ✅ | Walk fact_provenance edges back to evidence sources |

Read-only resources: `impact-trace://reports/{id}`, `impact-trace://entities/{id}`, `impact-trace://evidence/{id}`, `impact-trace://reports/{id}/graph/{format}`, `impact-trace://coverage/latest`.

## Identity and invariants

- **Local-first single SQLite `.db` file.** No external network by default. The whole memory layer lives in `<repo>/.impact-trace/impact.db`.
- **Content-addressable fact id.** `id = SHA-256(entity || attribute || value || op)`. Same observation never duplicates.
- **ADD-only schema migration.** Columns and tables are added; nothing is dropped. Allowlist-guarded `tryAddColumn` helper in `src/store.ts`.
- **Soft-delete only.** Facts are never DELETED. Branch GC archives *transactions* (`transactions.archived = 1`) so recall stops surfacing them, but the underlying fact rows survive and may be referenced from other branches.
- **Redact-then-prompt gate.** All LLM input/output passes through `redactSecrets()` (11 secret families: OpenAI/Stripe/GitHub/Slack/AWS/Google/npm/JWT/Bearer/DB URL/Private key). Redacted facts get value_blob='[REDACTED]' and zero embedding row.
- **async-outside-tx pattern.** Embedding and LLM compute happen *before* the SQLite transaction opens; the sync `withAgentMemoryDb` callback only writes.

## Lifecycle of a fact

```
attribute_defs.is_code_relation = 1  →  static fact (indexer-emitted)
attribute_defs.is_code_relation = 0  →  dynamic fact (agent-decision)
attribute = 'reflection'              →  summary fact ( consolidation)
```

The `profile` tool partitions facts along this axis. See `docs/invariants.md` for the principle that lifecycle is derived, not stored.

## When NOT to use

- Cloud-hosted memory across many users → use [supermemory](https://supermemory.ai) instead.
- PDF / image / video extraction — out of scope; impact-trace is code-focused.
- Real-time analytics dashboards — this is a local single-user tool.

## Reference docs

For deep architecture details, see `references/architecture.md`.

For the full design rationale and decision log, see:
- `docs/vision.md` / `docs/vision.ko.md` — one-page thesis (start here)
- `docs/roadmap.md` — unified roadmap across both axes (impact analysis + agent memory)
- `docs/glossary.md` — disambiguates branch/entity/transaction across the two axes
- `docs/invariants.md` — load-bearing 원칙
- `docs/vision.ko.md` — 프로젝트 방향성
- `docs/roadmap.md` — 다음 작업
