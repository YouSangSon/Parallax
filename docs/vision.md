# Parallax — Vision

**English** · [한국어](vision.ko.md) · [中文](vision.zh.md)

**In one sentence:** Parallax is a **local-first impact context layer** that lets *AI coding agents* like Claude Code and Codex and humans see the same relation graph — connecting code, docs, policies, proposals, and decisions, reducing the context an agent spends re-reading the repo, and using MCP and a UI to tell you *what is affected* before and after a code change.


## Thesis

AI coding agents (Claude Code, Codex, Cursor, etc.) are powerful, but their *statelessness* is the problem. Every session is a cold start — they re-read the repo, forget what they tried, and have no shared model of "where this commit actually has impact." For humans, too, code, docs, policies, proposals, and customer requirements are scattered, making it hard to see the blast radius of a change on a single screen. Parallax fills this gap in a local-first way:

- **Impact context axis** — right before an agent (or a human) changes a file/function/config/workflow/contract/policy/doc, it tells you what is affected *within and across the repo*, along with evidence and confidence. At the same time, a precomputed graph and a compact context pack reduce the context an agent uses.
- **Agent memory axis** — every time an agent observes, decides, retracts, summarizes, or hands off, it is stored as a content-addressable fact with provenance, and subsequent calls recall it by entity / attribute / branch / time / semantic similarity.
- **Human UX axis** — it provides the same relation graph through a UI that humans can explore. The key is not a graph DB, but projecting the canonical graph stored in SQLite onto a screen where you can filter, search, and drill down into evidence.

All three axes share a **single SQLite file** `<repo>/.parallax/impact.db`. Agents read via **MCP tools/resources**, and humans view via **CLI/graph export/UI**. *The code analyzer, memory, and UI are not separate things — they are different surfaces of one impact context layer.*

## Product shape

| Surface | Role | What the user gets |
|---|---|---|
| **MCP server** | Provides compact impact context and resource URIs to Claude/Codex/Cursor | The agent doesn't miss the relevant code, tests, docs, policies, and proposals before and after a change, while reducing full-file dumps and repeated-exploration context |
| **CLI** | Runs index/analyze/graph/export/remember/recall locally | Easy to attach to CI, pre-commit, agent hooks, and manual verification |
| **UI explorer** | Lets humans explore the relation graph, evidence, coverage gaps, and changed/affected paths | Stakeholders outside the code can also see "why this file and doc are affected" |
| **Local SQLite store** | Canonical source of truth | Reproducible without a graph DB or cloud, and sensitive repo information is never sent outside |

Representative flow:

1. The user modifies code with Claude/Codex.
2. Parallax maps the diff onto the entity graph.
3. It finds the relevant code, tests, config, CI, policies, docs, and PRD/proposal/decision records along with evidence.
4. MCP gives the agent "the context you need to know when making this change" and "the actions you should verify."
5. The UI shows the same results as a changed → affected → evidence → action flow.

## Who it's for

| Audience | Use case |
|---|---|
| **AI coding agents** (Claude Code, Codex, Cursor, custom MCP clients) | Inject *impact context* before modifying code; recall relevant code/docs/policies/proposals; persist observations across sessions |
| **Engineers adopting agentic workflows** | Local impact analysis in CI / pre-commit; audit "what the agent knew when it made this change" |
| **Reviewers / PMs / ops staff** | Check change impact paths and evidence in the UI; check how a code change affects policies/docs/customer commitments |
| **Tool builders** (other MCP servers, IDE plugins) | Use as a durable layer *beneath* the ephemeral agent loop |

## Why local-first

Local-first is the foundation — all data lives in `<repo>/.parallax/impact.db`. No external services, no cloud sync, no required graph DB. Reasons:

1. **Source code is sensitive** — sending the structure of a private repo to an external service is a non-starter for many teams.
2. **Installation cost** — every external dep (Postgres, Neo4j, hosted vector DB) doubles installation friction. SQLite is already on every machine.
3. **Offline reliability** — agents must work on a plane, in a SCIF, and behind a firewall.
4. **Single-file portability** — `impact.db` can be copied, diffed, archived, and sandboxed.

The cost: brute-force limits at scale. sqlite-vec ANN is the first response; later we explore partitioning + retention policies.

## Identity invariants (principles not to be reconsidered without a new decision)

Before proposing a large change, read [invariants.md](invariants.md). The essentials: local-first single SQLite, content-addressable fact, ADD-only migration, redact-then-embed, fetch-only (no SDK), explicit triggers (no daemon), read-only agent surface first, actions are recommendations, evidence first.

## 3-year vision

**Year 1 (now):** MCP impact context works reliably on a single repo + single agent. Impact analysis goes deep on TS/JS, broadly on other languages. Agent memory uses deterministic stub embedding + 4 LLM providers + sqlite-vec ANN. The MCP context pack reduces agent context usage with `brief`/`standard`/`deep` budgets and resource-on-demand. The UI starts as the first explorer that reads stored reports/graphs.

**Year 2:** Cross-repo workspace catalog + multi-agent memory handoff. Adapter coverage reaches the "tier-1 enterprise stack" (TS, Python, Go, Rust, Java/Kotlin, C#, C/C++ + YAML/Terraform/Kubernetes/OpenAPI/protobuf).

**Year 3:** The MemoryBench harness provides regression signal so that the quality of memory operations improves *measurably* (across embedding models / LLM providers / reflection algorithms). The UI, graph DB projection, and IDE/plugin surfaces become first-class consumers, while parallax remains the canonical SQLite source of truth.

## What we will *not* build

These items were reviewed and rejected — context is in [invariants.md](invariants.md). Re-proposing any of them requires a separate discussion.

- **A required graph DB.** The source of truth stays SQLite.
- **Required cloud sync.** Local-first is the identity, not a phase.
- **Daemon / background process.** Every operation is user-triggered.
- **LLM/embedding SDK.** `fetch` only, ~30 LOC per provider.
- **Automatic code modification.** Recommendations only, never executed.
- **Full semantic analysis of all languages at once.** Tier adapters (P1 → P2) secure breadth before depth.

## Repo navigation guide

| If you are ... | Starting point |
|---|---|
| An AI agent/engineer entering for the first time | [README.md](../README.md) → this file → [invariants.md](invariants.md) |
| A contributor looking for the next task | [roadmap.md](roadmap.md) |
| Someone confused by the terminology | [glossary.md](glossary.md) |
