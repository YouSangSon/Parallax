# Impact-trace — Vision

**One sentence:** Impact-trace is a local-first SQLite + MCP substrate that gives AI coding agents two things in one place: *what does changing this code break* (impact analysis) and *what do we already know about this codebase* (persistent memory).

> 한국어: [vision.ko.md](vision.ko.md)

## The thesis

AI coding agents (Claude Code, Codex, Cursor, etc.) are powerful but stateless. Every session starts cold — they re-read the repo from scratch, lose track of what was tried, and have no shared notion of "what does this commit actually affect downstream." Impact-trace is the local-first substrate that fixes both:

- **Impact analysis** — when an agent (or a human) is about to change a file, function, config, workflow, or contract, impact-trace says *what else in the repo (and across repos) is affected*, with evidence and a confidence label. This is the original product axis (P0..P4 in `impact-trace-plan.ko.md`).
- **Agent memory layer** — when an agent observes, decides, retracts, summarizes, or hands off to another agent, impact-trace stores the observation as a content-addressable fact with provenance, and lets future calls recall it by entity / attribute / branch / time / semantic similarity. This is the second product axis (Phases 1..4, ADRs D-001..D-018).

Both axes share the same single-file SQLite store at `<repo>/.impact-trace/impact.db`. Both surface through the same MCP tool set. They are not two products — they are two *capabilities* of one substrate.

## Who it is for

| Audience | Use case |
|---|---|
| **AI coding agents** (Claude Code, Codex, Cursor, custom MCP clients) | Inject "impact context" before code edits; persist observations across sessions; hand off branches between agents |
| **Engineers adopting agentic workflows** | Run impact analysis locally in CI / pre-commit; query agent memory to audit "what did the agent know when it made this change?" |
| **Tool builders** (other MCP server authors, IDE plugins) | Use impact-trace as the durable layer underneath a transient agent loop |

## Why local-first

D-001 is the foundation: everything in `<repo>/.impact-trace/impact.db`, no external services, no cloud sync, no graph DB requirement. Reasons:

1. **Source code is sensitive** — sending a private repo's structure to an external service is a non-starter for many teams.
2. **Setup cost** — every external dep (Postgres, Neo4j, hosted vector DB) doubles install friction. SQLite is already on every machine.
3. **Offline reliability** — agents must work on a plane, in a SCIF, behind a firewall.
4. **Single-file portability** — `impact.db` can be copied, diffed, archived, sandboxed.

The cost: brute-force at scale. P5 ANN (D-018) is the first response; future P5+ work explores partitioning + retention policies.

## Identity invariants (the things we will not re-litigate without a new ADR)

These are the load-bearing decisions captured in [decisions.ko.md](decisions.ko.md). Read them before proposing big changes:

| Group | Invariants |
|---|---|
| **Storage** | D-001 single SQLite file · D-002 SHA-256 content-addressable fact id · D-003 ADD-only schema migration · D-006 multi-parent transactions via `transaction_parents` · D-007 model-agnostic `fact_embeddings(fact_id, model)` PK |
| **Privacy** | D-004 redact-then-embed/prompt zero-row policy · D-012 no LLM/embedding SDKs (fetch only) |
| **Lifecycle** | D-005 async outside SQLite tx · D-009 explicit `reflect` trigger (no daemon) · D-010 preserve original facts when summarizing · D-011 soft-delete branch GC (facts never deleted) |
| **Phase 4 additions** | D-013 lifecycle binary from `is_code_relation` · D-014 Profile API separate from recall · D-015 `reflect --repair` separate trigger · D-016 `branch --restore` bundles state + tx unarchive · D-017 auto-abandon piggybacks on `gc-branches --max-age` · D-018 sqlite-vec ANN with per-model vec0 + brute-force fallback |

## Three-year aspiration

**Year 1 (now):** Both axes work for a single repo + single agent. Impact analysis covers TS/JS deeply, other languages broadly. Agent memory works with deterministic stub embeddings + 4 LLM providers + sqlite-vec ANN.

**Year 2:** Cross-repo workspace catalog (impact-trace-plan §"Workspace") + multi-agent memory handoffs (Phase 5 candidates: concurrent reflect lock, multi-layer reflection). Adapter coverage hits "tier-1 enterprise stack" (TS, Python, Go, Rust, Java/Kotlin, C#, C/C++ + YAML/Terraform/Kubernetes/OpenAPI/protobuf).

**Year 3:** MemoryBench harness (Phase 5 P0) provides regression signals so quality of memory operations improves measurably across embedding models, LLM providers, and reflection algorithms. Optional projections (graph DB, web explorer) become first-class consumers; impact-trace remains the canonical SQLite source of truth.

## What we will not build

These were considered and rejected — see [decisions.ko.md](decisions.ko.md) for context. Re-proposing requires a new ADR.

- **Required graph DB.** Source of truth must remain SQLite.
- **Required cloud sync.** Local-first is identity, not a phase.
- **Daemon / always-on background process.** Every operation is user-triggered.
- **LLM/embedding SDKs.** `fetch` only, ~30 LOC per provider.
- **Auto-edit code.** We recommend actions; we do not execute them.
- **Cross-language full semantic analysis at once.** Tier adapters (P1 → P2) ship breadth before depth.

## How to navigate this repo

| If you are a... | Start with... |
|---|---|
| New AI agent picking up the project | This file → [docs/README.md](README.md) → [decisions.ko.md](decisions.ko.md) |
| Engineer running it for the first time | [README.md](../README.md) → [agent-memory-cookbook.ko.md](agent-memory-cookbook.ko.md) |
| Designer of a new feature | [decisions.ko.md](decisions.ko.md) → [roadmap.md](roadmap.md) → current phase plan such as [phase6b-ts-accuracy-plan.ko.md](phase6b-ts-accuracy-plan.ko.md) |
| Maintainer doing a release | [CHANGELOG.md](../CHANGELOG.md) → [progress.ko.md](progress.ko.md) |
| Open-sourcing or onboarding teammate | This file → [glossary.md](glossary.md) → [skills/impact-trace/SKILL.md](../skills/impact-trace/SKILL.md) |
