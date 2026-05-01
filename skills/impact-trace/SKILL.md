---
name: impact-trace
description: Local-first code impact analyzer + agent memory layer for Claude Code, Codex, and other agentic coding tools. Use when you need to analyze how a code change ripples through a repository, persist agent decisions/observations as content-addressable facts, run reflective consolidation on long-running memory, or surface a per-entity profile of static (code structure) + dynamic (agent activity) + summary (LLM-consolidated) context. Single SQLite database, no cloud dependencies, MCP-native.
---

# Impact-Trace Skill

Impact-trace is the local-first code-aware memory layer for AI coding agents. It indexes a repository into entities and relations, accepts agent observations as content-addressable facts on a transaction DAG, and exposes the combined view through MCP tools and a CLI.

## When to invoke

- "How does this change ripple?" → `analyze`
- "Remember/recall an agent decision" → `remember` / `recall`
- "What does the system know about file:X?" → `profile` (Phase 4)
- "Summarize old episodic facts" → `reflect` (Phase 3)
- "Trace why I decided X" → `trace`
- "Mark this experiment branch dead and clean it up" → `branch --abandon` then `gc-branches` (Phase 3)

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

## MCP tools surfaced (12)

| Tool | Read-only? | What it does |
|---|---|---|
| `impact_trace_analyze_diff` | ✅ | Run impact analysis for a list of changed files |
| `impact_trace_remember` | ❌ | Persist an agent fact (entity, attribute, value) on a branch |
| `impact_trace_recall` | ✅ | Retrieve facts by branch / entity / attribute / semantic query (sqlite-vec ANN with brute-force fallback) |
| `impact_trace_profile` | ✅ | Three-bucket per-entity view (static / dynamic / summary) — Phase 4 P1 |
| `impact_trace_branch` | ❌ | Fork a new branch from an existing branch (no data copy) |
| `impact_trace_merge` | ❌ | Multi-parent merge transaction joining two branch heads |
| `impact_trace_abandon_branch` | ❌ | Mark a branch state='abandoned' (idempotent, main protected) |
| `impact_trace_restore_branch` | ❌ | Reverse abandon+gc — `state='active'` AND `archived=0` in one atomic call (Phase 4 P3) |
| `impact_trace_gc_branches` | ❌ | Archive transactions of abandoned branches (soft-delete). `maxAgeDays` opt-in for time-based auto-abandon (Phase 4 P4) |
| `impact_trace_reflect` | ❌ | LLM-summarize older facts per-entity into summary facts |
| `impact_trace_repair_reflections` | ❌ | Reconcile orphan summary facts left by SAVEPOINT atomicity gap (Phase 4 P2) |
| `impact_trace_trace` | ✅ | Walk fact_provenance edges back to evidence sources |

Read-only resources: `impact-trace://reports/{id}`, `impact-trace://entities/{id}`, `impact-trace://reports/{id}/graph/{format}`, `impact-trace://coverage/latest`.

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
attribute = 'reflection'              →  summary fact (Phase 3 consolidation)
```

The `profile` tool partitions facts along this axis. See decision D-013 in `docs/decisions.ko.md` for why this is derived from existing data, not a new column.

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
- `docs/decisions.ko.md` — **D-001..D-018** cumulative ADRs (six new in Phase 4)
- `docs/phase3-design.ko.md` — schema v7, LLM provider abstraction, reflection, branch GC
- `docs/phase4-p2-p3-design.ko.md` + `docs/phase4-p4-p5-design.ko.md` — Phase 4 sub-phase design / retrospective
- `docs/phase5-handoff.ko.md` — Phase 5 entry point (5 candidates, 4 design decisions)
- `docs/supermemory-adoption.ko.md` — patterns we adopted from supermemory and why we rejected others
