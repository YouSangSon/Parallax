# Parallax — CLI Reference

**English** · [한국어](cli-reference.ko.md) · [中文](cli-reference.zh.md)

The `parallax` CLI is the local entry point to indexing, impact analysis, graph export, agent memory, the workspace catalog, diagnostics, the MCP server, and the UI. Every command runs against the repo in the current working directory and reads/writes `<repo>/.parallax/impact.db`. Run `parallax --help` (or `-h`) for the built-in summary.

Most machine-oriented commands can print JSON through command-specific flags. `analyze` defaults to a human summary, and `graph export` defaults to Mermaid text.

## Indexing

| Command | Purpose |
| :--- | :--- |
| `parallax init` | Create the local `.parallax/` store and a fresh database for the repo |
| `parallax index [--max-file-bytes <n>]` | Scan the repo and extract the entity/relation graph; `--max-file-bytes` caps per-file scan size |
| `parallax scip import --file <index.scip or index.scip.json>` | Import a SCIP binary index or JSON emitted by the official SCIP CLI, then augment the latest completed index with SCIP reference edges |
| `parallax scip export [--file <index.scip.json>]` | Export the latest completed Parallax index as SCIP-compatible JSON, either to stdout or to a file |
| `parallax reindex-vec [--model <hf-model>]` | Rebuild the sqlite-vec ANN index; `--model` selects the embedding model |
| `parallax reembed [--model <hf-model>] [--all]` | Recompute fact embeddings; `--all` re-embeds every fact, otherwise only missing ones |

`scip import` requires an existing completed Parallax index. Run `parallax scip import --file index.scip` to import a binary SCIP index through the official `scip` CLI on `PATH`, or import pre-rendered JSON with `parallax scip import --file index.scip.json` after `scip print --json index.scip > index.scip.json`. `scip export` emits SCIP-compatible JSON from the latest completed index; writing binary `.scip` protobuf files is intentionally left out until users need it.

## Analysis

| Command | Purpose |
| :--- | :--- |
| `parallax analyze --changed <file[,file]> [--depth <n>] [--max-fanout <n>] [--json] [--sarif-output <path>]` | Analyze an explicit list of changed files against the latest index |
| `parallax analyze --base <ref> [--head <ref>] [--depth <n>] [--max-fanout <n>] [--json] [--sarif-output <path>]` | Derive the changed file list from `git diff <base>...<head>` (default head `HEAD`) |
| `parallax repo-map --changed <file[,file]> [--query <text>] [--budget <tokens>] [--json]` | Build a token-budgeted repo map/context card with changed roots, affected files, tests, docs, work artifacts, evidence refs, verification actions, a ranked verification plan, resources, confidence, provenance, known gaps, and omitted counts |
| `parallax pr triage --base <ref> [--head <ref>] [--fail-on <level>] [--sarif-output <path>] [--query <text>] [--budget <tokens>]` | Run the local dependency/PR triage path: analyze the diff, write SARIF, and print a repo map |
| `parallax install-hook [--hook pre-commit\|pre-push\|all] [--fail-on <level>] [--command <bin>] [--dry-run] [--force]` | Install local Git hooks that run Parallax impact gates before commits or pushes |
| `parallax query "<cypher>"` | Run a read-only Cypher subset over the indexed graph and print JSON rows |
| `parallax ingest-traces --file <traces.json>` | Promote relations matching observed runtime `source -> target` edges to `proven` confidence |

The `query` subset supports an optional relationship hop in either direction (`->` or `<-`), fixed or variable-length (`*`, `*N`, `*min..max`; max capped at 8), node labels, `WHERE` equality / `CONTAINS`, projection, `COUNT(<var>)` aggregation (non-aggregate `RETURN` items become implicit grouping keys), `ORDER BY` a projected column (`ASC`/`DESC`), and `LIMIT` — e.g. `MATCH (a)-[r:DEPENDS_ON]->(b) WHERE a.path CONTAINS 'store' RETURN a.path, b.path ORDER BY b.path DESC LIMIT 20`, the reverse "what depends on X" form `MATCH (x)<-[r:DEPENDS_ON]-(d) WHERE x.path = 'src/store.ts' RETURN d.path`, the transitive "everything reachable from X" form `MATCH (x)-[:DEPENDS_ON*1..3]->(dep) WHERE x.path = 'src/store.ts' RETURN dep.path`, or the "most-depended-on files" form `MATCH (a)-[r:DEPENDS_ON]->(b) RETURN b.path, COUNT(a) ORDER BY COUNT(a) DESC LIMIT 10`. Write, procedure, projection (`WITH`/`UNWIND`), `COUNT(*)`, and bidirectional clauses are rejected; a variable-length path's relationship variable is not projectable; `ORDER BY` only accepts a projected column; `COUNT` is not allowed on variable-length paths. `ingest-traces` is a write surface kept off the read-only MCP (invariant **I-8**); runtime observation only ever raises confidence.

Flags:

- `--changed` — comma-separated changed files (mutually exclusive with `--base`/`--head`).
- `--base` / `--head` — Git refs; `--head` requires `--base`. Without `--base`/`--head`/`--changed`, positional file paths are accepted.
- `--depth` — maximum traversal depth for ripple computation.
- `--max-fanout` — maximum fan-out per node during traversal.
- `--json` — print the full report JSON instead of the summary, and skip writing the report to the store. The output validates against the published [report JSON Schema](report-schema.md).
- `--sarif-output <path>` — write a pretty-printed SARIF 2.1.0 projection to a file for GitHub Code Scanning upload. The projection includes affected-file findings, index coverage-gap warnings, cross-repo contract-break warnings, recommended verification-action notes, and adapter known-gap notes. Parent directories are created. This keeps the normal human summary on stdout and is mutually exclusive with `--json`.
- `--sarif-category <category>` — set the SARIF run automation id / GitHub Code Scanning category. Defaults to no category unless supplied by a wrapper such as the GitHub Action.
- `--fail-on <level>` — control the exit code by confidence: `proven` / `inferred` / `heuristic` fail only when an affected file meets or exceeds that confidence; `any` (default) fails on any affected file; `none` never fails. Use in CI to gate on high-confidence impact only.

By default (no `--json`) the report is persisted and a short summary is printed; the report path is shown when written.

`repo-map` is a read-only planning surface for agents. It reuses the same impact analysis, context-pack ranking, indexed search, and `parallax://` resources as MCP; it does not create a new index. Its `verificationPlan` groups existing recommended actions by nearest `package.json` root and runner, emits copy-pasteable commands, and lists the changed / affected / target paths each group covers. The planner does not execute Nx, Bazel, or other external build tools. `--budget` is a token target estimated as `Math.ceil(text.length / 4)`, so the output discloses the requested budget, estimated tokens, truncation state, and omitted counts. `--query` adds ranked search-context matches from the existing index, and `--json` prints the full structured card.

`pr triage` is a local wrapper for dependency-update and pull-request review. It accepts the same changed-file inputs as `analyze`, persists the impact report, writes SARIF to `.parallax/pr-triage.sarif` by default, applies `--fail-on`, and prints a repo map with a dependency-focused default query. It does not call GitHub, upload SARIF, checkout branches, or modify remote state. After you have a PR branch available locally, a typical Dependabot flow is:

```bash
parallax index
parallax pr triage --base origin/main --head HEAD --fail-on proven
```

`install-hook` is an opt-in local installer. It writes executable `pre-commit` and/or `pre-push` hook files into the active Git hooks directory, including repositories that use `core.hooksPath`. The generated `pre-commit` hook gates the staged changed-file list from `git diff --cached`; the generated `pre-push` hook gates the pushed diff using Git's pre-push input first and falls back to `PARALLAX_BASE`, the upstream merge-base, or `origin/main`. Existing non-Parallax hooks are skipped unless `--force` is supplied; `--dry-run` prints the plan without writing. Use `PARALLAX_SKIP_HOOK=1` or Git's `--no-verify` to bypass a local hook intentionally.

When the changed file is an indexed provider contract and the workspace already contains persisted `BREAKS_COMPATIBILITY_WITH` links, `analyze` also includes `crossRepoImpacts`. These entries identify the consumer service, consumer file, provider contract, breaking change, confidence, evidence snippet, and workspace resource URIs. `analyze` does not run contract diff automatically; refresh links first with `parallax workspace contract-diff` when the workspace is stale.

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
| `parallax workspace discover-packages [--name <name>] [--json]` | Discover npm/pnpm workspace packages and sync them into the workspace catalog |
| `parallax workspace list [--name <name>] [--json]` | List workspaces and their member repos |
| `parallax workspace resolve-contracts [--name <name>] [--json]` | Resolve cross-repo provider/consumer contract links |
| `parallax workspace contract-diff --contract <path> [--name <name>] [--provider <service>] [--provider-path <path>] [--json]` | Diff a contract file against the indexed workspace baseline |
| `parallax workspace verify [--name <name>] [--json]` | Verify persisted cross-repo links and flag malformed, stale, or orphan rows |
| `parallax workspace consumers --provider <service> [--contract <path>] [--method <method>] [--path <route>] [--name <name>] [--json]` | List consumers of a provider from persisted workspace links |
| `parallax workspace providers --consumer <service> [--file <path>] [--name <name>] [--json]` | List providers used by a consumer from persisted workspace links |

`workspace verify`, `workspace consumers`, and `workspace providers` read persisted links only. They do not run resolution or contract diff. Use `workspace resolve-contracts` to refresh `CONSUMES_HTTP_ENDPOINT` links and `workspace contract-diff` to refresh `BREAKS_COMPATIBILITY_WITH` links.

`workspace add-repo` takes the repo path as a positional argument. Cross-repo coverage is limited to local repos the user explicitly registers — no clone or network access. A catalog entry may also point at an already indexed package directory inside the same monorepo; `resolve-contracts` reads the nearest parent Parallax database and scopes paths to that member.

`workspace discover-packages` reads only local manifests: `package.json` `workspaces` arrays / `workspaces.packages` and `pnpm-workspace.yaml` `packages`. It supports direct paths, `*`, `**`, leading `!` excludes, and simple `{apps,packages}` brace groups, then writes the discovered package directories into `.parallax/workspace.json` as member repos. When package members are found, the root repo entry is replaced by those package entries to avoid duplicate same-monorepo links; catalog entries outside the current repo root are preserved. It does not run npm, pnpm, Nx, Turbo, installs, daemons, caches, or network calls.

## Diagnostics

| Command | Purpose |
| :--- | :--- |
| `parallax doctor` | Print a health report (schema, latest index, coverage, adapter runs, vector state) |

## MCP

| Command | Purpose |
| :--- | :--- |
| `parallax mcp serve` | Start the MCP stdio server for the current repo (see [mcp.md](mcp.md)) |
| `parallax install-agent [--config <path>] [--name <name>] [--dry-run]` | Register Parallax's read-only MCP server in a client's `mcpServers` config (default `.mcp.json`); `--dry-run` previews the merged config without writing |
| `parallax install-agent --copilot-package --target <repo> [--config <path>] [--name <name>] [--dry-run] [--force]` | Plan or install a GitHub Copilot package into the explicit target repo: `.github/copilot-instructions.md`, `.github/agents/parallax-impact.agent.md`, and an MCP config snippet only when `--config` is supplied |

The Copilot package command writes only under the explicit `--target <repo>` path. It does not call GitHub, push changes, or modify this Parallax repo unless this repo is passed as `--target`. `--dry-run` prints the planned relative paths and actions; existing files are skipped unless `--force` is supplied.

## UI

| Command | Purpose |
| :--- | :--- |
| `parallax ui [--report <id>] [--port <n>]` | Start the local UI explorer; `--report` opens a specific report, `--port` sets the listen port |

The UI runs until interrupted (`SIGINT`/`SIGTERM`); it prints its URL on startup. The workbench URL preserves the selected impact path, filter text, and report-delta policy preset, and the toolbar can export the current view as JSON, affected-path CSV, or a PNG/SVG impact map.

## Exit codes

| Code | Meaning |
| :--- | :--- |
| `0` | Success |
| `1` | `analyze` found one or more affected files (an intentional CI/agent signal that a change has impact), or `doctor` found health errors |
| `2` | The command threw an error (unknown command, missing required flag, or other failure) |

The `analyze` exit code of `1` on impact is deliberate: it lets CI jobs and agent hooks treat "this change affects other files" as a non-zero signal without parsing the report.

## See also

- [mcp.md](mcp.md) — the MCP server surface over the same store
- [report-schema.md](report-schema.md) — published JSON Schema for `analyze --json` output
- [extending-adapters.md](extending-adapters.md) — how `parallax index` extracts the graph
- [invariants.md](invariants.md) — local-first, explicit-trigger, and read-only-first invariants
- [glossary.md](glossary.md) — terminology
