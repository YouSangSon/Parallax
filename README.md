<div align="center">

# 🛰️ Parallax

**Give coding agents a local map of what a change can break.**

An impact-intelligence tool that — before agents like Claude Code, Codex, or Cursor touch your code —<br/>
indexes your repository locally and shows, with evidence, the code, tests, docs, and contracts a changed file can affect.

![status](https://img.shields.io/badge/status-MVP%20working-7c3aed)
![node](https://img.shields.io/badge/node-%3E%3D24.0.0-339933)
![storage](https://img.shields.io/badge/storage-SQLite%20%2B%20sqlite--vec-2563eb)
![mcp](https://img.shields.io/badge/MCP-stdio-14b8a6)
![license](https://img.shields.io/badge/license-MIT-3da639)

**English** · [한국어](README.ko.md) · [中文](README.zh.md)

[🚀 Quick start](#-quick-start) · [✨ Features](#-features) · [🧱 Core concepts](#-core-concepts) · [🤖 MCP](#-mcp--agents) · [🔒 Safety model](#-safety-model) · [🗺️ Roadmap](#%EF%B8%8F-roadmap) · [📚 Read more](#-read-more)

<img src="docs/assets/parallax-ui-demo.png" alt="Parallax Impact Workbench UI showing ranked impact route cards, a graph-first impact map, analysis trust signals, impact summary, verification action, affected paths, and evidence" width="100%">

</div>

---

> **Why it exists** — AI coding tools are fast, but every time you change one function in `auth.ts` they have to guess which tests, consumers, and policy docs move with it. Parallax stores a code graph and agent memory in a repo-local `.parallax/impact.db`, so an agent can check "what is affected and why" as a small context pack *before* making the change.

---

## 🚀 Quick start

### Requirements

| Item | Requirement | Notes |
| :--- | :--- | :--- |
| **Node.js** | `>=24.0.0` | Uses the built-in `node:sqlite`; an experimental warning may appear |
| **npm** | per package-lock | `npm install` sets up the dev environment |
| **Repo permissions** | local read/write | Creates the `.parallax/` directory and SQLite DB |
| **External services** | not needed for the core impact path | Model/LLM-based memory cleanup runs only when explicitly invoked |

```bash
# 1. Build Parallax
npm install
npm run build

# 2. Link the current checkout's CLI onto your PATH
npm link

# 3. Initialize and index inside the target repo
cd /path/to/target-repo
parallax init
parallax index
```

Analyze a single changed file:

```bash
parallax analyze --changed src/auth/session.ts --depth 2
```

Or analyze a git diff range directly:

```bash
parallax analyze --base main --head HEAD --json
```

Markdown reports are saved to a repo-local path:

```text
.parallax/reports/
```

Open the latest report in the local UI:

```bash
parallax ui
parallax ui --report <report-id> --port 3717
```

> 💡 `analyze` returns exit code `1` when there are affected files. This is intentional, so CI or agent guardrails can use "has impact" as a signal.

---

## ✨ Features

### 🔎 Impact analysis

| Feature | Behavior |
| :--- | :--- |
| **Local index** | Stores files, entities, relations, evidence, and coverage in `.parallax/impact.db` |
| **Change analysis** | Analyzes `--changed` or `--base/--head` input via bounded multi-hop graph traversal |
| **Evidence-first report** | Emits `changed`, `affected`, `actions`, `evidence`, `adapterInsights`, `warnings` as JSON/Markdown |
| **Related-test inference** | Suggests likely-affected tests using imports, filename conventions, and adapter evidence |
| **Graph export** | Exports a saved report as Mermaid, JSON, or DOT |
| **Coverage warnings** | Surfaces oversized-file skips, stale index, and adapter known-gaps in the report |

### 🧭 Adapter coverage

| Area | Current state |
| :--- | :--- |
| **TypeScript / JavaScript** | Expanding parser-backed import, declaration, class/interface heritage, call-site, typed/destructured/named-object receiver, factory-return, and constructor/field call spans |
| **JVM / Spring Boot** | Endpoint, declaration, config, and test evidence span v0 |
| **Python / Go / Rust** | Lightweight adapter centered on declaration/test relations |
| **Markdown / work artifacts** | Classifies policy, proposal, PRD, and decision docs as first-class artifacts and links them to code |
| **Config / Infra** | Indexes system/config candidates: shell, YAML, JSON, TOML, Dockerfile, Makefile, Terraform, CODEOWNERS, etc. |
| **Package manifests** | Manifest graph for `package.json`, `pom.xml`, `build.gradle(.kts)`, `go.mod`, `Cargo.toml`, `pyproject.toml` |

### 🌐 Workspace & contracts

| Feature | Description |
| :--- | :--- |
| **Workspace catalog** | Registers only the local repos a user has allowed in `.parallax/workspace.json`. No clone/network |
| **Cross-repo resolver** | Stores provider endpoint ↔ consumer file links between registered repos |
| **Contract diff** | Classifies OpenAPI, GraphQL, Protobuf, and AsyncAPI surface diffs as `breaking` / `non-breaking` / `unknown` |
| **Consumer impact** | Links removed endpoints/operations, field removal/type changes, and added required request fields to known consumers |
| **Event topology hint** | Provides AsyncAPI producer/consumer direction and breaking provenance as a compact payload |

```bash
parallax workspace init --name platform --service api
parallax workspace add-repo ../web --name platform --service web
parallax workspace resolve-contracts --name platform --json
parallax workspace contract-diff --contract openapi.yaml --name platform --json
```

### 🧠 Agent memory

Stores an agent's decisions, observations, and rationale as content-addressable facts on the same SQLite DB.

| Command | Role |
| :--- | :--- |
| `remember` | Store a decision/observation fact about an entity; supersede stale facts with `--supersedes-fact-ids` |
| `recall` | Query facts by entity, attribute, keyword, or semantic query |
| `branch` / `merge` | Fork/merge multiple plans without copying data |
| `trace` | Follow `fact_provenance` edges to trace a decision's chain of reasoning |
| `profile` | Return an entity's static facts, dynamic facts, and summary facts at once |
| `reflect` | Summarize stale facts with an LLM and promote them to summary facts |

```bash
parallax remember --entity src/auth/session.ts \
  --attribute decision --value "Allow JWT clock skew of 60s"
parallax recall --entity src/auth/session.ts --json
parallax profile --entity src/auth/session.ts
```

---

## 🧱 Core concepts

| Concept | One-line description |
| :--- | :--- |
| **Impact graph** | A directed graph connecting files/symbols/contracts; computes a change's ripple via bounded traversal |
| **Evidence** | Every relation carries its source file, line, and snippet as proof |
| **Confidence** | Labels evidence trust in three levels: proven / inferred / heuristic |
| **Context pack** | Delivers change-analysis results as a small JSON bundle that is easy for an agent to consume |
| **Work artifact** | A first-class object linking docs like policy, PRD, and decision to code |
| **Adapter** | A per-language/format extractor that reports its confidence and known-gaps |

---

## 🤖 MCP & agents

Parallax provides an MCP stdio server.

```bash
parallax mcp serve
```

| MCP tool | Role |
| :--- | :--- |
| `parallax_analyze_diff` | Takes changed files and returns an impact report |
| `parallax_context_for_change` | Returns a budget-fit context pack for a change |
| `parallax_search_context` | Searches the latest index by keyword/path/symbol/relation/evidence |
| `parallax_contract_diff` | Compares an OpenAPI contract against the indexed workspace baseline |
| `parallax_remember` / `parallax_recall` | Write/read agent memory facts |
| `parallax_profile` / `parallax_trace` | Query an entity profile and its reasoning chain |

Registered tools are exposed through the MCP tool surface. Graph export is an MCP **resource**, not a tool: read `parallax://reports/{reportId}/graph/{format}` (`mermaid`, `json`, or `dot`).

> Register it as a stdio server with an MCP client like Claude Code or Codex and it's ready to use.

---

## 🔒 Safety model

| Principle | Detail |
| :--- | :--- |
| **Local-first** | All index and memory data is stored in the repo-local `.parallax/`. No external transfer |
| **Explicit workspace** | Cross-repo covers only local repos the user registered. No clone/network |
| **Redaction** | Secret-like strings are redacted before storage |
| **Source-tree read-only by default** | MCP never edits source files; analysis/search tools, context-pack reuse, and MCP resource reads may append context-pack or telemetry rows in `.parallax/impact.db`, while explicit memory commands write facts |
| **Deterministic output** | The same input yields the same report; reproducible in CI |

---

## 🧪 Development

```bash
npm run build
npm run check
npm test
npm run docs:lint
```

Key scripts:

| Script | Role |
| :--- | :--- |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run check` | Typecheck without emit |
| `npm test` | Run the Node test runner suite via `tsx` |
| `npm run bench` | Deterministic bench over multi-language, Spring Boot, contract, and package-manifest fixtures |
| `npm run docs:lint` | Check tracked and untracked Markdown for forbidden content, trilingual parity, same-language links, and missing local `.md` targets |
| `npm run verify` | Run the full source-checkout release gate |
| `npm run test:mcp` | Verify MCP impact/context/memory/telemetry/path validation |
| `npm run test:security` | Verify path containment and redaction |
| `npm run test:ui` | Verify local UI snapshot, server, and JSON resource endpoints |
| `npm run test:dogfood` | Self-index Parallax and assert the internal dependency graph survives (see [`docs/verification.md`](docs/verification.md)) |

Full source-checkout release gate:

```bash
npm run verify
```

`npm run verify` is the canonical pre-release command from a source checkout. It runs lint, install smoke (which owns the only build), the fast suite, dogfood, bench, and the high-level audit.

---

## 🗺️ Roadmap

| Axis | Next goal |
| :--- | :--- |
| **Accuracy** | Extend parser-backed TS/JS spans to broader dynamic dispatch and advanced type relations |
| **JVM / Python / Go / Rust** | Promote declaration-centric adapters to parser-backed call/import resolution |
| **Workspace / Contract** | Stabilize nested schema diff; deepen generated-client/event-topology resolver |
| **Package / Build** | Package graph based on lockfile, transitive dependencies, and semver/range |
| **Agent surface** | Context pack budget tuning and a hit/miss measurement harness |
| **UI Explorer** | More direct single-screen exploration of the changed → affected → evidence → action flow |
| **Measurement** | Fixture bench delta and recall-quality regression detection |

The detailed backlog is tracked against [`docs/roadmap.md`](docs/roadmap.md).

---

## ⚠️ Current limitations

| Area | State |
| :--- | :--- |
| **Full semantic analysis** | Not type-aware analysis for every language; check each adapter's confidence and known-gap |
| **Contract depth** | Full generated-client usage graphs at GraphQL/Protobuf/AsyncAPI parser/LSP level are future work |
| **Package resolution** | Currently manifest-centric; lockfile/transitive/semver execution-based resolvers are future work |
| **Graph DB** | Out of the default product scope; can be extended as an optional projection from SQLite if needed |
| **External writes** | Obsidian/GitHub/Jira write sync is not yet exposed on the MCP surface |
| **Code modification** | Parallax does not modify code directly; it gives agents impact and evidence |

---

## 📚 Read more

| Document | Content |
| :--- | :--- |
| [`docs/vision.md`](docs/vision.md) | Project vision |
| [`docs/value-proposition.md`](docs/value-proposition.md) | Value proposition and differentiation |
| [`docs/roadmap.md`](docs/roadmap.md) | Current backlog and next slices |
| [`docs/invariants.md`](docs/invariants.md) | Invariants like local-first, redaction, and the permission model |
| [`docs/glossary.md`](docs/glossary.md) | Glossary |
| [`docs/README.md`](docs/README.md) | Documentation index |
| [`docs/architecture.md`](docs/architecture.md) | Source-checkout runtime architecture and extension map |
| [`docs/mcp.md`](docs/mcp.md) | MCP server, tools, and resources |
| [`docs/cli-reference.md`](docs/cli-reference.md) | Every CLI command, flag, and exit code |
| [`docs/extending-adapters.md`](docs/extending-adapters.md) | Authoring semantic adapters |
| [`docs/verification.md`](docs/verification.md) | Verification layers, test scripts, and the dogfood guard |
| [`docs/operations.md`](docs/operations.md) | Troubleshooting and operator runbook |
| [`docs/release-checklist.md`](docs/release-checklist.md) | Source-checkout release, CI, audit, and package smoke checklist |

---

## License

MIT License. See [`LICENSE`](LICENSE) for details.
