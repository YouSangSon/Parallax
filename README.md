# Impact Trace

Impact Trace is a planned local-first code impact analysis tool for Claude Code,
Codex, and other agentic coding workflows.

The goal is simple: before an agent changes code, it can ask what the change is
likely to affect, which tests and files need attention, what can break, and what
improvements are nearby. The project does not require a graph database as its
core. The current plan uses a pluggable local index, with optional graph
projection when graph traversal is useful.

## MVP

The current MVP ships a local TypeScript CLI with:

- `impact-trace init`
- `impact-trace index`
- `impact-trace analyze --changed src/file.ts`
- `impact-trace mcp serve` with read-only `impact_trace_analyze_diff`

The implementation stores a local SQLite index in `.impact-trace/`, redacts
secret-like evidence before output, rejects paths outside the repo root, and
writes Markdown reports under `.impact-trace/reports/`.

Start with the product and engineering plan:

- [docs/impact-trace-plan.md](docs/impact-trace-plan.md)
- [docs/impact-trace-plan.en.md](docs/impact-trace-plan.en.md)
- [docs/impact-trace-plan.ko.md](docs/impact-trace-plan.ko.md)
- [docs/impact-trace-test-plan.md](docs/impact-trace-test-plan.md)
- [docs/impact-trace-test-plan.en.md](docs/impact-trace-test-plan.en.md)
- [docs/impact-trace-test-plan.ko.md](docs/impact-trace-test-plan.ko.md)
