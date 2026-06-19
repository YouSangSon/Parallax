# Parallax — CLI Reference

**English** · [한국어](cli-reference.ko.md) · [中文](cli-reference.zh.md)

The `parallax` CLI is the local entry point to indexing, impact analysis, graph export, agent memory, the workspace catalog, diagnostics, the MCP server, and the UI. Every command runs against the repo in the current working directory and reads/writes `<repo>/.parallax/impact.db`. Run `parallax --help` (or `-h`) for the built-in summary.

Most machine-oriented commands can print JSON through command-specific flags. `analyze` defaults to a human summary, and `graph export` defaults to Mermaid text.

## Indexing

| Command | Purpose |
| :--- | :--- |
| `parallax init` | Create the local `.parallax/` store and a fresh database for the repo |
| `parallax index [--max-file-bytes <n>]` | Scan the repo and extract the entity/relation graph; `--max-file-bytes` caps per-file scan size |
| `parallax reindex-vec [--model <hf-model>]` | Rebuild the sqlite-vec ANN index; `--model` selects the embedding model |
| `parallax reembed [--model <hf-model>] [--all]` | Recompute fact embeddings; `--all` re-embeds every fact, otherwise only missing ones |

## Analysis

| Command | Purpose |
| :--- | :--- |
| `parallax analyze --changed <file[,file]> [--depth <n>] [--max-fanout <n>] [--json]` | Analyze an explicit list of changed files against the latest index |
| `parallax analyze --base <ref> [--head <ref>] [--depth <n>] [--max-fanout <n>] [--json]` | Derive the changed file list from `git diff <base>...<head>` (default head `HEAD`) |
| `parallax query "<cypher>"` | Run a read-only Cypher subset over the indexed graph and print JSON rows |
| `parallax ingest-traces --file <traces.json>` | Promote relations matching observed runtime `source -> target` edges to `proven` confidence |

The `query` subset supports an optional relationship hop in either direction (`->` or `<-`), fixed or variable-length (`*`, `*N`, `*min..max`; max capped at 8), node labels, `WHERE` equality / `CONTAINS`, projection, and `LIMIT` — e.g. `MATCH (a)-[r:DEPENDS_ON]->(b) WHERE a.path CONTAINS 'store' RETURN a.path, b.path LIMIT 20`, the reverse "what depends on X" form `MATCH (x)<-[r:DEPENDS_ON]-(d) WHERE x.path = 'src/store.ts' RETURN d.path`, or the transitive "everything reachable from X" form `MATCH (x)-[:DEPENDS_ON*1..3]->(dep) WHERE x.path = 'src/store.ts' RETURN dep.path`. Write, procedure, projection (`WITH`/`UNWIND`), and bidirectional clauses are rejected; a variable-length path's relationship variable is not projectable. `ingest-traces` is a write surface kept off the read-only MCP (invariant **I-8**); runtime observation only ever raises confidence.

Flags:

- `--changed` — comma-separated changed files (mutually exclusive with `--base`/`--head`).
- `--base` / `--head` — Git refs; `--head` requires `--base`. Without `--base`/`--head`/`--changed`, positional file paths are accepted.
- `--depth` — maximum traversal depth for ripple computation.
- `--max-fanout` — maximum fan-out per node during traversal.
- `--json` — print the full report JSON instead of the summary, and skip writing the report to the store.
- `--fail-on <level>` — control the exit code by confidence: `proven` / `inferred` / `heuristic` fail only when an affected file meets or exceeds that confidence; `any` (default) fails on any affected file; `none` never fails. Use in CI to gate on high-confidence impact only.

By default (no `--json`) the report is persisted and a short summary is printed; the report path is shown when written.

## Graph

| Command | Purpose |
| :--- | :--- |
| `parallax graph export --report <id> [--format mermaid\|json\|dot] [--limit <n>] [--cursor <cursor>]` | Render a stored report's relationship graph; default format is `mermaid` |

`--limit` and `--cursor` apply only with `--format json`. They use the same `nodeOffset:edgeOffset` cursor and `1..500` limit contract as MCP/UI graph JSON pagination.

## Agent memory

| Command | Purpose |
| :--- | :--- |
| `parallax remember --entity <id> --attribute <name> --value <json\|string> [--branch <name>] [--agent <id>] [--op assert\|retract] [--evidence-fact-ids id1,id2] [--supersedes-fact-ids id1,id2]` | Persist a fact as a content-addressable observation |
| `parallax retract --entity <id> --attribute <name> --value <json\|string> [--branch <name>] [--agent <id>]` | Persist a retraction (equivalent to `remember --op retract`) |
| `parallax recall [--query <text>] [--semantic] [--entity <id>] [--attribute <name>] [--branch <name>] [--k <n>] [--as-of-tx <tx-id>] [--current-only]` | Query facts by filter or semantic similarity |
| `parallax profile --entity <id> [--branch <name>] [--k <n>] [--as-of-tx <tx-id>]` | Aggregate an entity's facts into static / dynamic / summary buckets |
| `parallax trace --fact-id <id> [--depth <n>]` | Walk a fact's provenance/evidence chain |
| `parallax branch --name <name> [--from <name>]` | Create a new branch forking from an existing one (default `main`) |
| `parallax branch --abandon <name>` | Mark a branch as abandoned |
| `parallax branch --restore <name>` | Restore an abandoned branch to active |
| `parallax merge --target <branch> --source <branch> [--agent <id>]` | Merge a source branch into a target |
| `parallax reflect [--branch <name>] [--older-than-days <n>] [--entity <id>] [--model <provider:id>] [--agent <id>] [--dry-run]` | Summarize older facts into new summary facts |
| `parallax reflect --repair [--branch <name>] [--dry-run]` | Restore lost provenance for orphan reflection facts |
| `parallax gc-branches [--dry-run] [--max-age <days>]` | Archive transactions of abandoned branches; `--max-age` auto-abandons stale active branches first |
| `parallax import-session --file <path> --format codex\|claude [--branch <name>] [--agent <id>]` | Import an agent session transcript into memory |

The `remember`/`recall` value passed via `--value` is parsed as JSON when possible and otherwise treated as a string. The `--op` flag accepts `assert` or `retract`; `retract` is shorthand for `remember --op retract`.

## Workspace

| Command | Purpose |
| :--- | :--- |
| `parallax workspace init [--name <name>] [--service <service>] [--force]` | Create or re-create the workspace catalog for this repo |
| `parallax workspace add-repo <path> [--name <name>] [--service <service>] [--remote <url>]` | Register another local repo into the workspace catalog |
| `parallax workspace list [--name <name>] [--json]` | List workspaces and their member repos |
| `parallax workspace resolve-contracts [--name <name>] [--json]` | Resolve cross-repo provider/consumer contract links |
| `parallax workspace contract-diff --contract <path> [--name <name>] [--provider <service>] [--provider-path <path>] [--json]` | Diff a contract file against the indexed workspace baseline |

`workspace add-repo` takes the repo path as a positional argument. Cross-repo coverage is limited to local repos the user explicitly registers — no clone or network access.

## Diagnostics

| Command | Purpose |
| :--- | :--- |
| `parallax doctor` | Print a health report (schema, latest index, coverage, adapter runs, vector state) |

## MCP

| Command | Purpose |
| :--- | :--- |
| `parallax mcp serve` | Start the MCP stdio server for the current repo (see [mcp.md](mcp.md)) |
| `parallax install-agent [--config <path>] [--name <name>] [--dry-run]` | Register Parallax's read-only MCP server in a client's `mcpServers` config (default `.mcp.json`); `--dry-run` previews the merged config without writing |

## UI

| Command | Purpose |
| :--- | :--- |
| `parallax ui [--report <id>] [--port <n>]` | Start the local UI explorer; `--report` opens a specific report, `--port` sets the listen port |

The UI runs until interrupted (`SIGINT`/`SIGTERM`); it prints its URL on startup.

## Exit codes

| Code | Meaning |
| :--- | :--- |
| `0` | Success |
| `1` | `analyze` found one or more affected files (an intentional CI/agent signal that a change has impact), or `doctor` found health errors |
| `2` | The command threw an error (unknown command, missing required flag, or other failure) |

The `analyze` exit code of `1` on impact is deliberate: it lets CI jobs and agent hooks treat "this change affects other files" as a non-zero signal without parsing the report.

## See also

- [mcp.md](mcp.md) — the MCP server surface over the same store
- [extending-adapters.md](extending-adapters.md) — how `parallax index` extracts the graph
- [invariants.md](invariants.md) — local-first, explicit-trigger, and read-only-first invariants
- [glossary.md](glossary.md) — terminology
