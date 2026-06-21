# Parallax — MCP Reference

**English** · [한국어](mcp.ko.md) · [中文](mcp.zh.md)

Parallax ships an MCP (Model Context Protocol) **stdio** server so coding agents like Claude Code and Codex can read the impact graph, agent memory, and analysis surfaces the same SQLite store powers for the CLI and UI. This page documents how to run the server and every tool and resource it registers.

## Run the server

```bash
parallax mcp serve
```

The server speaks MCP over stdio (`StdioServerTransport`). It runs against the repo in the current working directory: its `repoRoot` is the directory you launch it from, and all reads and writes go to that repo's `<repo>/.parallax/impact.db`. Index the repo at least once (`parallax index`) so the tools have a completed index run to read.

## Register with an MCP client

Register Parallax as a stdio server with any MCP client. Conceptually the client launches `parallax mcp serve` as a child process and talks to it over stdio. With Claude Code or Codex, point the client at that command from the repo you want analyzed. Because the server resolves the repo from its working directory, launch it with the target repo as the current directory.

## Read-only-first invariant

Parallax follows invariant **I-8** (see [invariants.md](invariants.md)): the agent surface stabilizes a safe read-only analysis layer first, and write permissions are added only behind a separate model and review. Each tool declares an MCP `readOnlyHint` annotation. Tools marked `readOnlyHint: true` in the table are source-tree read-only, not necessarily zero local database writes. Analysis/search/context tools may append `context_tool_runs` telemetry and context-pack rows in `.parallax/impact.db` as a side effect of answering, and MCP resource reads may append `context_resource_accesses` telemetry rows. Tools marked `readOnlyHint: false` include explicit memory-write and branch-management tools. None of them modify your source tree — actions are recommendations only (invariant **I-9**).

## Tools

All registered tools use the `parallax_` prefix. This table is checked against the MCP `tools/list` response; the *read-only* column reflects each tool's `readOnlyHint` annotation.

| Tool | Role | Read-only |
| :--- | :--- | :--- |
| `parallax_analyze_diff` | Analyze changed files against the latest completed index and return the full impact report | No |
| `parallax_context_for_change` | Return a budgeted context pack (`brief`/`standard`/`deep`) of ranked impact paths, evidence refs, git co-change advisories, and resource links for changed files | No |
| `parallax_search_context` | Search the latest index by keyword, path, symbol, relation provenance, or evidence snippet and return ranked entity context | No |
| `parallax_contract_diff` | Compare a current OpenAPI contract file against the indexed workspace baseline and return compact breaking-change impact | No |
| `parallax_remember` | Persist an agent observation as a content-addressable fact on a branch (`assert`/`retract`) | No |
| `parallax_recall` | Query facts by entity, attribute, and branch (optionally semantic) | Yes |
| `parallax_query` | Run a read-only Cypher subset (forward/reverse/variable-length hop, labels, WHERE =/CONTAINS, projection, COUNT aggregation, ORDER BY, LIMIT) over the indexed entity/relation graph and return JSON rows plus the queried index run and navigable entity resources | Yes |
| `parallax_co_change` | Return files historically coupled to a given file via git co-change (CO_CHANGES), ranked by coupling strength — surfaces correlational couplings the static graph misses, at heuristic confidence | Yes |
| `parallax_branch` | Create a new memory branch forking from an existing branch (default `main`); no data copied | No |
| `parallax_merge` | Create a merge transaction so recall on the target walks both branch DAGs | No |
| `parallax_reflect` | Group older facts by entity and summarize each group into a new summary fact with provenance | No |
| `parallax_abandon_branch` | Mark a branch as abandoned so later GC archives its transactions (cannot abandon `main`) | No |
| `parallax_gc_branches` | Archive transactions of abandoned branches so recall stops surfacing them; facts are never deleted | No |
| `parallax_profile` | Aggregate facts about an entity into static / dynamic / summary buckets | Yes |
| `parallax_explain_entity` | Return compact direct relation and evidence context for one indexed entity | No |
| `parallax_context_telemetry` | Return recent MCP context tool runs and resource reads so callers can see what was expanded | Yes |
| `parallax_doctor` | Return a read-only health report (schema, latest index, coverage, adapter runs, vector state) | Yes |
| `parallax_repair_reflections` | Restore lost provenance edges and audit rows for orphan reflection facts (idempotent) | No |
| `parallax_restore_branch` | Move an abandoned branch back to active and un-archive its transactions (idempotent) | No |
| `parallax_trace` | Walk `fact_provenance` edges from a fact back through its evidence chain | Yes |

## MCP prompts

Prompts are workflow templates (surfaced via `prompts/list` and fetched with `prompts/get`) that teach an agent how to chain the read-only tools into a coherent investigation. Each returns a user message sequencing analyze → context → query/co-change → remember, and biases toward high-confidence (proven > inferred > heuristic) signal. Both accept an optional `changedFiles` string.

| Prompt | Purpose |
| :--- | :--- |
| `impact_workflow` | Map the full blast radius of a change end to end: `parallax_analyze_diff` → `parallax_context_for_change` → `parallax_query` / `parallax_co_change` → `parallax_remember` |
| `triage_change` | Quickly triage whether a change is risky and decide what to verify, then record the verdict |

## Resources

Resources are read via MCP resource URIs. Templated URIs expand the `{...}` segments; `parallax://coverage/latest` is a fixed URI.

| Resource | URI / template | Role |
| :--- | :--- | :--- |
| `parallax_reports` | `parallax://reports/{reportId}` | Persisted impact report JSON documents |
| `parallax_entities` | `parallax://entities/{entityId}` | Canonical indexed entities from the latest completed index run |
| `parallax_evidence` | `parallax://evidence/{evidenceId}` | Relation evidence with source span, redacted snippet, and relation context |
| `parallax_context_packs` | `parallax://context-packs/{contextPackId}` | Persisted compact context packs keyed by content hash for repeated reuse |
| `parallax_workspaces` | `parallax://workspaces/{workspaceName}` | Workspace catalog membership and links to contract and cross-repo impact resources |
| `parallax_workspace_contracts` | `parallax://workspaces/{workspaceName}/contracts` | Latest indexed contract baselines across the local workspace catalog |
| `parallax_workspace_cross_repo_links` | `parallax://workspaces/{workspaceName}/cross-repo-links` | Workspace-scoped provider/consumer and breaking contract impact links |
| `parallax_graphs` | `parallax://reports/{reportId}/graph/{format}` | Report-scoped relationship graph projection in `mermaid`, `json`, or `dot` |
| `parallax_coverage_latest` | `parallax://coverage/latest` | Index coverage rows for the latest completed index run |

Graph export is delivered as the `parallax_graphs` **resource**, not a tool: read `parallax://reports/{reportId}/graph/{format}` with `format` one of `mermaid`, `json`, or `dot`. The equivalent CLI form is `parallax graph export` (see [cli-reference.md](cli-reference.md)).

JSON graph resources can be paged with `?limit=100&cursor=nodeOffset:edgeOffset`, and CLI JSON graph export uses the same contract via `parallax graph export --format json --limit 100 --cursor nodeOffset:edgeOffset`. For paged requests, `limit` defaults to `100` and must be between `1` and `500`; the next page cursor is returned as `page.nextCursor`. Invalid pagination returns MCP `invalid_pagination`; the UI maps the same validation to `invalid_request`, and the CLI reports the same graph page validation errors with exit code `2`.

## See also

- [cli-reference.md](cli-reference.md) — the local CLI surface over the same store
- [extending-adapters.md](extending-adapters.md) — how the indexed graph the tools read is produced
- [invariants.md](invariants.md) — the read-only-first and evidence-first invariants
- [glossary.md](glossary.md) — terms like context pack, evidence, and confidence
