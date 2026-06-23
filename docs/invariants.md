# Invariants

**English** · [한국어](invariants.ko.md) · [中文](invariants.zh.md)

> Core decisions that must not break even if the project starts over. New decisions are made only insofar as they do not violate this document.

---

## I-1. Local-first, single SQLite DB

All data is stored in a single `<repo>/.parallax/impact.db`. No dependency on external services (graph DB, hosted vector store, cloud sync). On first boot a fresh DB is created, and schema migration runs automatically when the DB is opened.

**Why this must not break:**

- Sending code structure to an external service is a non-starter for many teams.
- A single external dependency doubles installation friction. SQLite is already everywhere.
- It must work on a plane, in a SCIF, or behind a firewall.
- A single file is easy to copy, diff, archive, and sandbox.

## I-2. Content-addressable fact id (SHA-256)

`fact.id = SHA-256(entity || attribute || value_blob || op)`. The same (entity, attribute, value, op) tuple always yields the same id. Dedup cost is zero.

## I-3. ADD-only schema migration

Existing columns are never changed or deleted. The approach is always to add new columns/tables. A DB opened with an older schema must still be readable.

## I-4. Redact-then-embed (zero-row policy)

A value in which a secret pattern is detected enters the embedding pipeline only after redaction. The original is also stored in the fact value in its redacted form. Redaction unconditionally precedes any external model call.

## I-5. Async work outside SQLite transaction

Long-running work such as LLM calls, embedding computation, and network fetches happens outside the SQLite transaction. DB lock time is kept to the millisecond range.

## I-6. Explicit triggers, no daemon

Maintenance work like reflect/index/gc runs only via explicit CLI/MCP calls. No background worker or daemon is created. The user always knows when and which work is running.

## I-7. No LLM/embedding SDKs (fetch only)

OpenAI/Anthropic/HuggingFace SDKs are not added as dependencies. When needed, call them directly with `fetch`. This keeps SDK updates from dictating the project's dependency weight.

## I-8. Read-only agent surface first

MCP stabilizes a safe read-only analysis surface first. Write permissions are added only after a separate model and review. By default an agent is blocked from accidentally performing destructive operations.

## I-9. Actions are recommendations

Test or review commands are not run automatically. They are only recommended in a `command + args` structure. Responsibility for execution rests with a human or a higher-level agent.

## I-10. Evidence first, no silent certainty

Every impact judgment must carry evidence + provenance + confidence together. What is unknown is surfaced explicitly as `unknown` / coverage gap / missing adapter. Estimated values are not returned as if they were facts.
Analysis reports also expose per-adapter-run confidence and known gaps, so that agents and people can distinguish parser-backed results from broad heuristic coverage.

## I-11. Saved reports are immutable snapshots

Persisted reports and report-scoped graph exports are read from the stored report JSON snapshot. Later index runs, carry-forward, retention, repair, or canonical graph row changes must not change what an existing report says. Canonical graph rows may enrich legacy reports only when the persisted report lacks relation-bearing evidence.
