# Impact Trace Plan

Generated: 2026-04-28

Korean version: [impact-trace-plan.ko.md](impact-trace-plan.ko.md)

## Product Summary

Impact Trace is a local-first project analysis layer for Claude Code, Codex, and
similar coding agents. It indexes a repository, connects code symbols to imports,
tests, docs, commits, and notes, then explains what may break when a proposed
change lands.

The user clarified that a graph database is not mandatory. The plan therefore
uses a pluggable index as the core: SQLite for canonical metadata and reports,
optional DuckDB for analytical snapshots, optional vector search for semantic
retrieval, and optional graph database projection only when Cypher-style graph
queries become worth the operational cost.

## Sources Checked

| Source | Relevant Finding |
|---|---|
| [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) | TypeScript supports AST traversal, incremental watchers, and type checker access. |
| [Language Server Protocol 3.17](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/specification.md) | LSP includes definition, references, call hierarchy, type hierarchy, document symbols, diagnostics, and workspace file events. |
| [CodeQL overview](https://codeql.github.com/docs/codeql-overview/about-codeql/) | CodeQL databases expose AST, data flow graph, and control flow graph per language. |
| [MCP resources spec](https://modelcontextprotocol.io/specification/2025-06-18/server/resources) | MCP resources expose context via URIs and require URI validation and permission checks. |
| [Obsidian URI docs](https://obsidian.md/help/uri) | Obsidian can open/create notes through encoded `obsidian://` URIs. |
| [FalkorDBLite docs](https://docs.falkordb.com/operations/falkordblite/) | Embedded graph runtime exists for Python and TypeScript, useful for prototyping and CI, but production should move to hosted/self-hosted FalkorDB. |
| [Kuzu GitHub](https://github.com/kuzudb/kuzu) | Kuzu is archived as of 2025-10-10, so it should not be the default core dependency. |

## Premises

| Premise | Status | Rationale |
|---|---|---|
| Agents need evidence before editing code. | Accepted | Claude Code and Codex can read code, but repeated repo-wide rediscovery is slow and misses cross-file context. |
| Side effects are mostly dependency, runtime, and ownership relationships. | Accepted | Direct imports are not enough; tests, docs, config, generated files, package boundaries, and historical bug fixes matter. |
| Graph DB is optional, not a requirement. | Accepted | User clarified this. Core should be storage-neutral and query-oriented. |
| Obsidian is a good human knowledge surface. | Accepted with constraint | Use Markdown export first. Avoid requiring a plugin before the core analysis is useful. |
| Perfect analysis is possible. | Rejected | The product should make uncertainty explicit through evidence, confidence, and missing-data flags. |

## What Already Exists

This repository is currently empty except for Git metadata. There is no existing
code, README, package manifest, design doc, test suite, or implementation to
reuse. The plan must therefore define the first product shape, architecture, and
verification strategy.

## NOT In Scope

| Item | Rationale |
|---|---|
| Universal full semantic analysis for every language in v1 | Too broad. Start with TypeScript/JavaScript and Tree-sitter import/symbol fallback. |
| Required graph database | User clarified it is optional. A graph projection adapter can come later. |
| Required Obsidian plugin | Markdown export plus Obsidian URI is enough for MVP. |
| Autonomous code editing | Impact Trace advises agents; it does not directly modify project code in v1. |
| Cloud sync | Local-first protects source code and secrets during early use. |

## Dream State Delta

```text
CURRENT
  Empty repo. Agents inspect code ad hoc and manually guess side effects.

THIS PLAN
  Local CLI/MCP tool indexes repos, answers "what does this change affect?",
  writes evidence-backed reports, and exports durable notes to Obsidian.

12-MONTH IDEAL
  Every agent edit starts with a cached project map, every PR has an impact
  packet, risky changes list tests/docs/owners automatically, and Obsidian
  becomes the human-readable memory of architecture decisions and hotspots.
```

## Core User Workflows

1. A developer runs `impact-trace init` in a repo.
2. The tool indexes files, packages, symbols, imports, tests, docs, and recent git history.
3. Before an agent changes code, the developer or agent runs `impact-trace analyze --diff`.
4. Impact Trace returns affected modules, tests to run, risky assumptions, and source evidence.
5. The MCP server exposes the same analysis to Claude Code or Codex.
6. The user can export project maps and change reports into an Obsidian vault.

## Architecture Recommendation

Default stack:

| Layer | Recommendation | Why |
|---|---|---|
| Runtime | Node.js/TypeScript | Matches Claude/Codex tool ecosystem, MCP SDKs, Obsidian plugin ecosystem, and TypeScript analysis APIs. |
| Canonical store | SQLite | Simple local persistence, low setup, easy backups, works for reports and graph-like edge tables. |
| Analytical snapshots | DuckDB optional | Useful later for large repo metrics and history queries without forcing it into MVP. |
| Text search | SQLite FTS5 first | Good enough for local reports; swap to Tantivy/Meilisearch later only if needed. |
| Semantic search | Optional LanceDB/sqlite-vec adapter | Useful for "similar code" but not required for deterministic impact analysis. |
| Graph projection | Optional FalkorDBLite/Neo4j/Memgraph adapter | Only needed if recursive graph queries and visualization become core. |
| Parsing | TypeScript compiler API for TS/JS; Tree-sitter fallback for broad syntax | Combines semantic accuracy where available with language coverage where semantics are expensive. |
| Deep semantic analysis | Optional CodeQL adapter | Powerful for data/control-flow, but should be optional because setup is heavier. |
| Agent API | CLI plus MCP server | CLI is debuggable; MCP gives Claude Code/Codex structured tools/resources. |
| Human notes | Markdown export to Obsidian vault | Transparent, diffable, and works without plugin approval. |

## System Diagram

```text
                         +----------------------+
                         | Claude Code / Codex  |
                         +----------+-----------+
                                    |
                             MCP tools/resources
                                    |
+-----------+      +----------------v----------------+
| Git diff  +----->| Impact Trace Analyzer           |
+-----------+      | - changed file/symbol resolver   |
                   | - reverse dependency walk        |
+-----------+      | - risk classifier                |
| Repo scan +----->| - evidence packet builder        |
+-----------+      +----------------+----------------+
                                    |
              +---------------------+---------------------+
              |                                           |
     +--------v---------+                       +---------v--------+
     | Local Index      |                       | Report Exporter   |
     | SQLite core      |                       | Markdown/JSON     |
     | optional DuckDB  |                       | Obsidian notes    |
     | optional vectors |                       +------------------+
     +--------+---------+
              |
      optional graph projection
              |
     +--------v---------+
     | FalkorDB/Neo4j   |
     | or other adapter |
     +------------------+
```

## Data Model

Canonical SQLite tables:

| Table | Purpose |
|---|---|
| `repos` | Repo root, VCS metadata, default branch, config hash. |
| `schema_versions` | Applied migration versions and compatibility metadata. |
| `index_runs` | Commit, dirty state, started/finished time, extractor versions, and failure summary for each indexing pass. |
| `files` | Path, language, hash, package, last indexed commit. |
| `symbols` | Name, kind, file, range, export status, deterministic semantic ID, extractor version. |
| `edges` | `IMPORTS`, `CALLS`, `TESTS`, `DOCUMENTS`, `OWNS`, `GENERATES`, `CONFIGURES`, with provenance and confidence reason. |
| `git_changes` | Commit/file/symbol history for hotspot and churn analysis. |
| `reports` | Stable change analysis output and evidence IDs. |
| `evidence` | Redacted source spans, commands, query results, confidence labels, source hash, snippet length, and raw-evidence availability flag. |
| `notes` | Obsidian note paths and backlinks to files/symbols/reports. |

Optional graph projection should be derived from these tables, never the source of
truth. That keeps migrations simple and prevents lock-in.

## CLI Surface

```bash
impact-trace init
impact-trace index
impact-trace analyze --base origin/main --head HEAD
impact-trace analyze --diff-file patch.diff
impact-trace explain src/foo.ts:handler
impact-trace mcp serve
```

`impact-trace obsidian sync` is planned after the read-only MCP loop is stable.

## MCP Surface

Tools:

| Tool | Output |
|---|---|
| `impact_trace_analyze_diff` | Affected files, symbols, tests, docs, owners, and risk evidence. |

Resources:

| URI | Meaning |
|---|---|
| `impact://report/{id}` | Future full impact report resource. Deferred until URI encoding and pagination are specified. |

Security rule: every MCP path or URI must be normalized, validated against the
configured repo/vault roots, and denied if it resolves outside those roots.

MCP capability model:

| Capability | Default | Enablement |
|---|---|---|
| Read analysis reports | Enabled | `impact-trace mcp serve` |
| Read repo snippets | Redacted only | Always passes through redaction and size caps. |
| Write Obsidian notes | Disabled | Requires `impact-trace mcp serve --allow-write --vault <root>`. |
| Execute project commands | Disabled | Out of scope for v1. |

All MCP tool arguments must have JSON Schema validation, realpath root containment
after symlink resolution, size limits, time limits, and deterministic JSON-RPC
errors. Write tools are absent from `tools/list` in v1. Future write mode requires
an explicit capability flag and a separate review.

## Obsidian Export

Markdown notes:

| Note | Content |
|---|---|
| `Impact Trace/Project Map.md` | Packages, entry points, dependency boundaries, test strategy. |
| `Impact Trace/Hotspots.md` | High-churn files, high fan-in symbols, repeated failure areas. |
| `Impact Trace/Reports/<date>-<branch>.md` | Per-change impact packet. |
| `Impact Trace/Symbols/<semantic-id>.md` | Symbol facts, callers, tests, related notes. |
| `Impact Trace/ADRs/*.md` | Human decisions generated from accepted recommendations. |

Obsidian sync defaults to dry-run. Writes use temp-file-and-rename, every managed
note has a stable ID and previous content hash, user edits produce conflict files,
and symlinked vault paths are denied. Opening notes through `obsidian://open` is
optional and must URI-encode vault and file names.

## MVP Definition

MVP is intentionally narrower than the full product:

| Included in MVP | Deferred |
|---|---|
| `init`, `index`, `analyze` | Obsidian auto-sync as a default behavior |
| JSON and Markdown reports | Graph DB projection |
| Minimal read-only MCP `impact_trace_analyze_diff` | CodeQL adapter |
| TypeScript/JavaScript extraction | Full multi-language semantic analysis |
| Secret redaction and path safety | Remote sync |
| One completed `index_run_id` per report | File/symbol MCP resources |

## Implementation Phases

| Phase | Output | Exit Criteria |
|---|---|---|
| 1. Project skeleton | TypeScript CLI, config, test harness, SQLite migrations. | `init`, `index --dry-run`, unit tests pass. |
| 2. TS/JS indexer | File, symbol, import, package, and test edge extraction. | Fixture repos index deterministically. |
| 3. Diff impact analyzer | Reverse dependency walk and evidence packet renderer. | Changing an exported symbol identifies importers and tests. |
| 4. Read-only MCP server | Minimal `impact_trace_analyze_diff` and report resources. | MCP client can call analyze and read report resources without write capability. |
| 5. Obsidian export | Dry-run-first Markdown report and project map writer. | Tmp vault receives stable notes without overwriting unrelated files. |
| 6. Optional adapters | DuckDB snapshots, vector search, CodeQL, graph projection. | Each adapter can be enabled without changing core schema contracts. |

## CEO Review

### 0A. Premise Challenge

The strongest premise is that agents need a durable project map. That is valid:
without one, every agent session spends context on rediscovery and still misses
non-code side effects like docs and tests.

The weakest premise is "perfect project analysis." That should be rejected. The
product should report what it can prove, what it infers, and what it cannot know.
Confidence labels are part of the product, not an implementation detail.

The user clarified graph DB is optional. This changes the strategic center: Impact
Trace is not a graph database project. It is an evidence product for code changes.

### 0B. Existing Code Leverage

There is no repo code to leverage. External leverage should come from mature local
analysis surfaces:

| Sub-problem | Existing Leverage |
|---|---|
| TypeScript symbol extraction | TypeScript compiler API and type checker. |
| Editor-grade references | LSP definition/references/call hierarchy where servers exist. |
| Broad language parsing | Tree-sitter parsers. |
| Deep control/data flow | Optional CodeQL database and query output. |
| Agent integration | MCP tools and resources. |
| Human knowledge surface | Obsidian Markdown vault and URI scheme. |

### 0C. Dream State Mapping

Impact Trace wins if it becomes the "pre-edit x-ray" for agent coding. The product
should answer four questions faster than manual repo reading:

1. What exactly changed?
2. What can this break?
3. What should be tested?
4. What durable project knowledge should be updated?

### 0C-bis. Implementation Alternatives

| Approach | Effort | Risk | Pros | Cons | Decision |
|---|---:|---|---|---|---|
| SQLite-first local index | Medium | Low | Fast TTHW, easy install, works offline, storage-neutral. | Recursive graph queries need custom SQL or projection. | Accepted. |
| Graph DB core | Medium-high | Medium | Natural dependency traversal and Cypher queries. | Setup/maintenance risk; Kuzu archived; user says not required. | Rejected as default. |
| CodeQL-first semantic engine | High | Medium | Strong data/control-flow for supported languages. | Heavy install and language coverage constraints. | Optional adapter. |
| Obsidian plugin first | Medium | Medium | Strong visual/human workflow. | Core analysis value becomes tied to plugin UX. | Deferred. |

### 0D. Mode-Specific Analysis

Mode: SELECTIVE EXPANSION.

Accepted expansions:

| Expansion | Reason |
|---|---|
| MCP server in MVP | The target users are Claude Code/Codex agents, so CLI alone is incomplete. |
| Obsidian Markdown export in MVP | User explicitly mentioned Obsidian, and file export is cheap. |
| Confidence/evidence model in MVP | Without this, reports become AI guesses instead of actionable analysis. |

Deferred expansions are listed in `TODOS.md`.

### 0E. Temporal Interrogation

| Time | Failure Risk | Product Response |
|---|---|---|
| Hour 1 | User cannot get a useful result quickly. | `init`, `index`, `analyze` must work on a small TS repo in under 5 minutes. |
| Hour 6 | Reports are plausible but not trusted. | Every claim needs source spans, edge path, and confidence. |
| Week 2 | Index goes stale. | Store file hashes and git commit; warn on dirty/stale index. |
| Month 2 | Language support pressure grows. | Keep extractor adapter contracts stable. |
| Month 6 | Teams want shared memory. | Add optional remote/cache sync only after local value is proven. |

### 0F. Mode Confirmation

Selective expansion is correct. It keeps the first implementation small enough to
ship while including the two surfaces that matter: agent consumption and Obsidian
memory.

## CEO Dual Voices

Codex CLI was available, but this generated plan was produced in a Codex session
without a separate Claude subagent. The review therefore uses primary analysis
plus source-checked external facts. Missing independent subagent review is a
process limitation to address before shipping.

```text
CEO DUAL VOICES - CONSENSUS TABLE
Dimension                            Primary  Codex CLI  Consensus
1. Premises valid?                   Yes      N/A        Single-reviewer
2. Right problem to solve?           Yes      N/A        Single-reviewer
3. Scope calibration correct?        Yes      N/A        Single-reviewer
4. Alternatives sufficiently explored?Yes     N/A        Single-reviewer
5. Competitive/market risks covered? Partial  N/A        Needs benchmark pass
6. 6-month trajectory sound?         Yes      N/A        Single-reviewer
```

## CEO Review Sections

### Section 1: Architecture Review

The architecture should not hardwire a graph DB. The source of truth is a stable
edge table plus report/evidence tables. Optional projections can materialize graph
queries without making the whole product depend on one storage engine.

### Section 2: Error & Rescue Map

| Error | User Sees | Rescue |
|---|---|---|
| No git repo | Clear "not a repo" error. | Allow `--path` or tell user to run inside repo. |
| Unsupported language | Lower-confidence file/import report. | Use Tree-sitter/text fallback and list missing extractor. |
| Stale index | Warning before analysis. | Offer `impact-trace index --changed`. |
| Obsidian vault missing | Export fails with actionable path error. | Create directory only with explicit flag. |
| MCP path escape | Request denied. | Return JSON-RPC error with invalid path reason. |
| CodeQL unavailable | Optional adapter disabled. | Continue with core analysis. |

### Section 3: Security & Threat Model

New attack surface is local file access through CLI/MCP. The product must treat
repo content, prompts, and note paths as untrusted. MCP tools must never execute
repo scripts unless an explicit command path is added later with user approval.

Required controls:

| Threat | Control |
|---|---|
| Path traversal through MCP arguments | JSON Schema validation, normalize, resolve realpath, enforce repo/vault root allowlist, test TOCTOU cases. |
| Prompt injection in repo files | Reports quote evidence; they do not follow instructions from source files. |
| Secret leakage to SQLite/MCP/Markdown/Obsidian | Redaction pipeline before every write or response; denylisted paths; secret-pattern scanning; binary detection; snippet-length caps; opt-in raw evidence reveal. |
| Malicious symlink | Resolve realpath before read/write. |
| Oversized repo denial of service | File count, file size, and traversal depth limits. |
| Partial SQLite reads during indexing | WAL mode, one-writer lock, busy timeout, and read transactions pinned to `index_run_id`. |

### Section 4: Data Flow & Interaction Edge Cases

Edge cases:

| Case | Handling |
|---|---|
| Rename-only diff | Preserve symbol history if file hash/range evidence matches. |
| Deleted file | Report importers and docs that still reference it. |
| Generated file | Mark as generated and trace source generator if known. |
| Dynamic import | Lower confidence edge with exact source span. |
| Barrel exports | Resolve through `index.ts` and package exports. |
| Monorepo package boundary | Report package dependents, not just file importers. |
| Test naming mismatch | Use configured test globs plus historical co-change as fallback. |
| npm/pnpm/yarn/bun workspaces | Extract workspace graph, package exports, tsconfig paths/references, import maps, and package-level dependency edges. |

### Section 5: Code Quality Review

The plan avoids a premature abstraction by using adapter boundaries only where the
blast radius is real: extractors, stores, report renderers, and agent surfaces.
Avoid adding a generic plugin system until two real adapters exist.

### Section 6: Test Review

The plan needs fixture repos, not only mocks. Impact analysis is behavior over
relationships, so tests must verify end-to-end reports from real repo layouts.
See [impact-trace-test-plan.md](impact-trace-test-plan.md).

Release accuracy gates:

| Metric | v1 Gate |
|---|---:|
| Affected-file recall on golden diffs | >= 90% |
| Critical false-negative count | 0 |
| Test recommendation precision | >= 70% |
| Stale-index detection | 100% on fixture cases |
| Secret redaction failures | 0 planted secrets leaked |

### Section 7: Performance Review

Primary risks are large monorepos, repeated parsing, and recursive dependency
walks. Mitigations: file hashes, incremental indexing, bounded traversal depth,
package-level summaries, and cached report snapshots.

### Section 8: Observability & Debuggability Review

Every report should include:

| Field | Purpose |
|---|---|
| `index_commit` | Shows which repo state was indexed. |
| `diff_base` / `diff_head` | Makes the report reproducible. |
| `evidence_ids` | Lets users inspect exactly why a claim exists. |
| `confidence` | Separates proven edges from heuristics. |
| `missing_adapters` | Explains why analysis may be incomplete. |

CLI/MCP compatibility contract:

| Contract | Requirement |
|---|---|
| CLI output | Human-readable by default, stable `--json` envelope for automation. |
| Exit codes | `0` clean, `1` findings/risk, `2` user/config error, `3` internal error. |
| MCP schemas | Versioned input/output JSON Schemas for each tool. |
| Resources | Schema-versioned report resources with pagination for large evidence. |
| Errors | Typed error envelope with problem, cause, fix, and evidence ID when available. |

### Section 9: Deployment & Rollout Review

Ship as an npm package first:

```bash
npm install -g impact-trace
impact-trace init
impact-trace index
impact-trace analyze --base origin/main --head HEAD
```

Avoid Docker as the default because it hurts TTHW. Use Docker only for optional
graph/CodeQL adapters that need heavier runtime support.

Packaging constraints:

| Constraint | Requirement |
|---|---|
| Core install | Prefer pure JS/WASM or prebuilt packages. |
| Optional adapters | DuckDB, CodeQL, graph DB, and vector packages stay out of the default install. |
| CI smoke tests | macOS, Linux, Windows, active Node LTS versions. |
| Doc lint | Block local absolute home paths, hidden tool state, and machine-local metadata in committed docs. |

### Section 10: Long-Term Trajectory Review

The product should become a stable memory substrate for code agents. That means
the database schema and report format matter more than the first UI. Treat reports
as durable artifacts that can be compared across commits.

## Engineering Review

### Step 0: Scope Challenge

Scope is realistic if TypeScript/JavaScript is the first high-confidence lane and
other languages are fallback-only. Trying to support all languages semantically in
v1 would break schedule and trust.

### Architecture Diagram

```text
+---------------------+
| CLI commands         |
+----------+----------+
           |
+----------v----------+        +---------------------+
| App services         +------->| MCP server          |
| config, repo, diff   |        | tools/resources     |
+----------+----------+        +----------+----------+
           |                              |
+----------v----------+                   |
| Extractor adapters   |                   |
| ts, tree-sitter, lsp |                   |
+----------+----------+                   |
           |                              |
+----------v------------------------------v----------+
| Core index store                                 |
| SQLite: files, symbols, edges, evidence, reports |
+----------+----------------------------------------+
           |
+----------v----------+        +---------------------+
| Analyzer             +------->| Renderers           |
| impact, risk, tests  |        | Markdown, JSON      |
+----------+----------+        +----------+----------+
           |                              |
           |                     +--------v----------+
           |                     | Obsidian vault    |
           |                     +-------------------+
           |
    optional projections
           |
+----------v----------+
| DuckDB / graph / vec |
+---------------------+
```

### Code Quality Findings

| Finding | Decision |
|---|---|
| Risk of "adapter soup" before core behavior is proven. | Keep adapters internal until two implementations need the same interface. |
| Report confidence can become vague. | Define fixed confidence levels: proven, inferred, heuristic, unknown. |
| CLI and MCP may diverge. | Both call the same service methods and return shared report IDs. |

### Test Coverage Map

| Codepath | Coverage Required |
|---|---|
| `init` config creation | Unit + e2e tmp repo. |
| `index` changed-file scan | Unit + fixture repo snapshots. |
| TS symbol extraction | Fixture tests with exports, imports, classes, barrel files. |
| Diff analyzer | Fixture diffs with rename/delete/signature change. |
| Reverse dependency walk | Unit tests for cycles, depth limits, duplicate paths. |
| Test recommendation | Fixture repos with test naming and package scripts. |
| Markdown report | Snapshot with normalized paths and stable ordering. |
| Obsidian export | Tmp vault integration test. |
| MCP tools/resources | Protocol-level integration test with invalid path cases. |

### Performance Findings

| Risk | Mitigation |
|---|---|
| Full reindex is slow. | Hash files and only reparse changed paths plus invalidated dependents. |
| Reverse traversal can explode. | Depth caps, package boundaries, and fan-out warnings. |
| Report output can overwhelm agents. | Return summary first, expose full evidence as MCP resources. |
| Large files degrade parsing. | File size caps and explicit skipped-file evidence. |

### Failure Modes Registry

| Failure Mode | Severity | Detection | Recovery |
|---|---|---|---|
| False negative affected file | High | Fixture regression or user report. | Add extractor edge or heuristic with evidence. |
| False positive huge blast radius | Medium | Report has fan-out warning. | Collapse to package-level summary. |
| Stale index used | High | Compare index commit/hash to working tree. | Warn and suggest reindex. |
| Vault overwrite | High | Export writes only managed directory and checks existing frontmatter. | Abort unless managed marker exists. |
| MCP reads outside root | Critical | Path validation test. | Deny request. |
| Secret leaks into evidence/report/vault | Critical | Planted-secret fixtures and redaction tests. | Redact before storage/export and make raw evidence opt-in only. |
| Partial SQLite state read during indexing | High | Concurrent CLI/MCP fixture. | WAL mode, one-writer lock, `index_run_id` pinned read transaction. |
| Optional adapter unavailable | Low | Startup capability check. | Continue with lower confidence. |

### Worktree Parallelization Strategy

After skeleton lands, work can split safely:

| Stream | Owns | Depends On |
|---|---|---|
| CLI/config/store | `src/cli`, `src/config`, migrations | none |
| TS extractor | `src/extractors/typescript` | store schema |
| Analyzer/report | `src/analyze`, `src/report` | store schema |
| Obsidian export | `src/export/obsidian` | report model |
| MCP server | `src/mcp` | analyzer service |

## DX Review

### Product Type

Developer tool for local code analysis and AI coding workflows.

### Developer Persona Card

| Field | Value |
|---|---|
| Primary user | Solo developer or staff engineer using Claude Code/Codex on unfamiliar or large repos. |
| Pain | The agent changes code without understanding side effects. |
| Desired outcome | A short, evidence-backed "what breaks and what to test" packet before editing. |
| Tolerance | Low setup friction; high tolerance for transparent limitations. |

### Developer Empathy Narrative

I am about to ask an agent to edit a repo I do not fully have in my head. I do not
want a generic summary. I want the exact affected files, why they are affected,
which tests to run, which docs may be stale, and where the tool is guessing.

### Developer Journey Map

| Stage | User Action | Friction | Product Requirement |
|---|---|---|---|
| 1. Discover | Reads README. | Unsure if graph DB required. | Say no database server is required. |
| 2. Install | `npm install -g impact-trace`. | Native deps risk. | Keep core install lightweight. |
| 3. Init | `impact-trace init`. | Config confusion. | Detect repo defaults automatically. |
| 4. Index | `impact-trace index`. | Slow first run. | Show progress and skipped files. |
| 5. Analyze | `impact-trace analyze --base ...`. | Needs useful output fast. | Print concise summary and report path. |
| 6. Inspect | Opens Markdown report. | Too much noise. | Group by severity and evidence. |
| 7. Agent use | Starts MCP server. | Tool naming confusion. | Provide copy-paste config snippets. |
| 8. Obsidian | Syncs vault notes. | Fear of clobbering notes. | Write only managed folder with markers. |
| 9. Repeat | Runs on next branch. | Stale index. | Incremental update and explicit freshness. |

### Competitive DX Benchmark

Reference mental competitors:

| Tool Class | Strength | Gap Impact Trace Fills |
|---|---|---|
| IDE/LSP | Great local definitions/references. | Does not package agent-ready impact reports across tests/docs/history. |
| CodeQL | Strong semantic and security analysis. | Heavier setup; not built as a quick agent preflight packet. |
| Repo map generators | Good summaries. | Often static and weak on diff-specific side effects. |
| Obsidian notes | Durable human knowledge. | Manual; not automatically connected to code changes. |

### Magical Moment

After one command:

```bash
impact-trace analyze --base origin/main --head HEAD
```

The user sees:

```text
High risk: src/auth/session.ts changed exported validateSession()
Affected: 7 direct importers, 2 routes, 3 tests, 1 README example
Run: npm test -- auth/session auth/middleware routes/private
Evidence: report written to .impact-trace/reports/2026-04-28-main.md
```

### TTHW Assessment

| Metric | Target |
|---|---|
| Install | Under 1 minute on a normal Node environment. |
| First index on small repo | Under 2 minutes. |
| First useful report | Under 5 minutes from zero. |
| MCP setup | Under 5 minutes with copy-paste config. |

### DX Scorecard

| Dimension | Current Plan Score | Target Before v1 |
|---|---:|---:|
| Getting started | 7 | 9 |
| CLI/API naming | 8 | 9 |
| Error messages | 7 | 9 |
| Documentation | 6 | 9 |
| Upgrade/migration | 5 | 8 |
| Dev environment | 7 | 9 |
| Community/examples | 4 | 7 |
| Measurement/feedback | 6 | 8 |

### DX Implementation Checklist

| Requirement | Status |
|---|---|
| `README` says graph DB is optional. | Planned. |
| `init` explains what files it creates. | Planned. |
| Every error includes problem, cause, fix. | Planned. |
| MCP tool names are stable and short. | Planned. |
| Reports include evidence and confidence. | Planned. |
| Obsidian export has dry-run mode. | Planned. |
| Fixture repos document expected outputs. | Planned. |

## Cross-Phase Themes

| Theme | Phases | Action |
|---|---|---|
| Evidence over summaries | CEO, Eng, DX | Build report/evidence schema early. |
| Optional graph layer | CEO, Eng | Keep graph DB out of the core MVP. |
| Local-first safety | CEO, Eng, DX | No cloud sync or script execution in v1. |
| Trust through reproducibility | Eng, DX | Include commit, index freshness, and source spans. |

## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | CEO | Make graph DB optional, not core. | Mechanical | Explicit over clever | User clarified it is not required; storage-neutral core is simpler. | Graph DB as mandatory architecture. |
| 2 | CEO | Use SQLite as canonical v1 store. | Mechanical | Pragmatic | Low setup and enough structure for file/symbol/edge/report tables. | Neo4j/Kuzu/Falkor as required store. |
| 3 | CEO | Add MCP server to MVP. | Mechanical | Completeness | Claude Code/Codex are target surfaces; CLI alone misses agent workflow. | CLI-only MVP. |
| 4 | CEO | Use Obsidian Markdown export before plugin. | Mechanical | Bias toward action | Works immediately and avoids plugin distribution risk. | Required Obsidian plugin in v1. |
| 5 | Eng | TypeScript/JavaScript first. | Mechanical | Pragmatic | Best accuracy-to-effort ratio for likely early users. | Universal semantic support in v1. |
| 6 | Eng | CodeQL optional adapter. | Mechanical | Explicit over clever | Powerful but too heavy for first-run setup. | CodeQL-first architecture. |
| 7 | Eng | Graph projection derived from canonical store. | Mechanical | DRY | Prevents dual source-of-truth bugs. | Separate graph DB as primary state. |
| 8 | DX | Target under-5-minute hello world. | Mechanical | Bias toward action | Developer tool must prove value before setup patience runs out. | Heavy bootstrap workflow. |
| 9 | Eng | Make MCP read-only by default. | Mechanical | Security first | Write tools create repo/vault access risk and must require explicit capability flags. | Always-on MCP export/write tools. |
| 10 | Eng | Add redaction before storage/export. | Mechanical | Completeness | Evidence can contain secrets before it reaches reports or Obsidian. | Redaction only at final renderer. |
| 11 | Eng | Move read-only MCP before Obsidian export. | Mechanical | Bias toward action | The target user is an agent workflow, while Obsidian can follow after core agent value works. | Obsidian before MCP. |
| 12 | Eng | Add measurable accuracy gates. | Mechanical | Explicit over clever | The product promise needs release thresholds, not only confidence prose. | Qualitative-only review. |

## Review Scores

| Review | Score | Notes |
|---|---:|---|
| CEO | 8/10 | Strong problem framing after graph DB was demoted. Needs real competitor benchmark later. |
| Design | Skipped | No UI scope in MVP plan. |
| Engineering | 8/10 | Architecture is shippable if adapters stay secondary. |
| DX | 7/10 | Good CLI/MCP shape; docs and examples need investment before v1. |

## Approval Recommendation

Approve this plan as the initial project direction. The most important correction
already happened: Impact Trace should be an evidence-backed impact analysis tool,
not a graph database project.
