# Codex Navigation Guide

**English** · [한국어](CODEX-NAVIGATION-GUIDE.ko.md) · [中文](CODEX-NAVIGATION-GUIDE.zh.md)

## Start Here

Read `goal.md` → `PLAN.md` → `GATES.md` → `CONTEXT.md` → `DESIGN.md`. Use `rg` to follow only the symbols and tests named by the active plan item; do not treat the older ignored `.superpowers/sdd/CLAUDE_HANDOFF.md` as current without comparing its SHA to `HEAD`.

## Surface Ownership

- `src/indexer.ts`, `src/index_delta.ts`, `src/adapters/`: scan, delta, adapter, and persistence contracts.
- `src/store.ts`: additive SQLite schema and migration invariants.
- `src/ui*.ts`, `src/ui/`: local report workbench.
- `tests/`: deterministic correctness and regression gates.
- `bench/`: deterministic quality bench and advisory performance measurement.
- `docs/`: public EN/KO/ZH product, operation, and verification contracts.
- `PLAN.md`, `GATES.md`: current sequence and current proof; `IMPROVEMENT_OPPORTUNITIES.md`: detailed backlog.

## Change Navigation

Before editing a shared function, enumerate every caller and the relevant tests. Prefer the existing contract or helper, keep external actions read-only, and preserve untracked/user-owned files. For index changes, prove incremental output against the full-index oracle and keep ignored-file, resource-limit, and adapter-content semantics explicit.

## Diff Packet

A review packet contains the base and head SHAs, `git diff --stat`, the full scoped diff, commands with exit codes and counts, known fallbacks, and cleanup evidence. Keep local green, committed state, pushed state, and deployment proof separate.
