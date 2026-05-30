---
name: parallax
description: Local-first code impact analyzer + agent memory layer for Claude Code, Codex, and other agentic coding tools. Use when you need to analyze how a code change ripples through a repository, persist agent decisions/observations as content-addressable facts, run reflective consolidation on long-running memory, or surface a per-entity profile of static (code structure) + dynamic (agent activity) + summary (LLM-consolidated) context. Single SQLite database, no cloud dependencies, MCP-native.
---

# Parallax Skill

Parallax is the local-first code-aware memory layer for AI coding agents. It indexes a repository into entities and relations, accepts agent observations as content-addressable facts on a transaction DAG, and exposes the combined view through MCP tools and a CLI.

## When to invoke

- "How does this change ripple?" → `analyze`
- "Which policies/proposals/decisions mention this code?" → analyze or MCP context tools after indexing repo-local Markdown work artifacts
- "Remember/recall an agent decision" → `remember` / `recall`
- "Find relevant indexed context without reading files" → MCP `parallax_search_context`
- "What does this entity directly touch?" → MCP `parallax_explain_entity` or CLI `profile` for memory context
- "Summarize old episodic facts" → `reflect` ()
- "Trace why I decided X" → `trace`
- "Mark this experiment branch dead and clean it up" → `branch --abandon` then `gc-branches` ()

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

Add to your MCP client config:

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

Or via the Claude Code CLI:

```bash
claude mcp add --transport stdio parallax -- parallax mcp serve
```

## MCP tools surfaced (15)

| Tool | Read-only? | What it does |
|---|---|---|
| `parallax_analyze_diff` | ✅ | Run impact analysis for a list of changed files |
| `parallax_context_for_change` | ✅ | Return a budgeted compact context pack for changed files |
| `parallax_search_context` | ✅ | Search latest indexed entities by keyword/path/symbol/relation/evidence and return ranked context with resource links |
| `parallax_remember` | ❌ | Persist an agent fact (entity, attribute, value) on a branch |
| `parallax_recall` | ✅ | Retrieve facts by branch / entity / attribute / semantic query (sqlite-vec ANN with brute-force fallback) |
| `parallax_profile` | ✅ | Three-bucket per-entity view (static / dynamic / summary) —  |
| `parallax_explain_entity` | ✅ | Compact direct incoming/outgoing relation and evidence view for one indexed entity |
| `parallax_branch` | ❌ | Fork a new branch from an existing branch (no data copy) |
| `parallax_merge` | ❌ | Multi-parent merge transaction joining two branch heads |
| `parallax_abandon_branch` | ❌ | Mark a branch state='abandoned' (idempotent, main protected) |
| `parallax_restore_branch` | ❌ | Reverse abandon+gc — `state='active'` AND `archived=0` in one atomic call () |
| `parallax_gc_branches` | ❌ | Archive transactions of abandoned branches (soft-delete). `maxAgeDays` opt-in for time-based auto-abandon () |
| `parallax_reflect` | ❌ | LLM-summarize older facts per-entity into summary facts |
| `parallax_repair_reflections` | ❌ | Reconcile orphan summary facts left by SAVEPOINT atomicity gap () |
| `parallax_trace` | ✅ | Walk fact_provenance edges back to evidence sources |

Read-only resources: `parallax://reports/{id}`, `parallax://entities/{id}`, `parallax://evidence/{id}`, `parallax://reports/{id}/graph/{format}`, `parallax://coverage/latest`.

## Identity and invariants

- **Local-first single SQLite `.db` file.** No external network by default. The whole memory layer lives in `<repo>/.parallax/impact.db`.
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
- PDF / image / video extraction — out of scope; parallax is code-focused.
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
