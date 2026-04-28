# Impact Trace Plan

Generated: 2026-04-28

Korean version: [impact-trace-plan.ko.md](impact-trace-plan.ko.md)

## At A Glance

Impact Trace is a local-first indexing layer for coding agents such as Claude Code
and Codex. Before an agent changes code, Impact Trace should tell it what the change
can affect, what evidence supports that answer, and what verification actions are
worth running.

The core is not a graph database. The core is a canonical entity/relation model that
can connect functions, variables, classes, modules, shell scripts, YAML, CI workflows,
Terraform, Kubernetes, OpenAPI, policy files, docs, and tests inside one repository,
plus REST API, gRPC/protobuf, GraphQL, and AsyncAPI/event contracts across repositories.
SQLite remains the source of truth. Graph databases are optional projections.

## Table Of Contents

- Product Principles
- Current Baseline
- Problem
- Scope And Non-Scope
- Target Architecture
- Canonical Data Model
- Adapter Strategy
- Analysis Flow
- Relationship Visualization
- MCP And CLI Contract
- Security And Trust Boundaries
- Test And Quality Gates
- Roadmap
- Known Gaps
- Decision Record

## Product Principles

| Principle | Meaning |
|---|---|
| Evidence first | Every impact claim carries evidence, provenance, and confidence. |
| Storage-neutral core | SQLite is the source of truth; graph/vector/CodeQL are optional adapters. |
| Multi-language by default | A real repo can mix TS/JS, Python, Go, Rust, Java, Kotlin, C#, C, C++, and system configs. |
| Workspace-aware impact | A product can be split across repos and service contracts. |
| Visualization is a projection | Relationship visualization is derived from the canonical graph, not a source of truth. |
| No silent certainty | Unknowns appear as `unknown`, coverage gaps, or missing adapters. |
| Read-only agent surface first | MCP starts as a safe read-only analysis surface. |
| Actions are recommendations | Test/review commands are structured suggestions, not executed commands. |

## Current Baseline

The MVP is intentionally narrow.

| Area | Current State |
|---|---|
| CLI | `init`, `index`, `analyze`, `mcp serve` |
| MCP | Official MCP SDK stdio server with read-only `impact_trace_analyze_diff` |
| Storage | Repo-local SQLite at `.impact-trace/impact.db` |
| Indexing | TS/JS/Markdown files, export symbols, import edges, some test/doc edges |
| Report | Language-neutral `changed`, `affected`, `actions`, `evidence` report model |
| Security | Path containment, symlink escape defense, MCP no-persistence, redaction tests |
| Tests | Unit, integration, security, MCP, install smoke |

The major limitations are also clear.

| Limitation | Impact |
|---|---|
| DB is centered on `files`, `symbols`, `edges` | Policy, CI, infra, endpoints, and resources are awkward to represent. |
| Analyzer input is `changedFiles` | Symbol, package, workflow, and resource analysis cannot fit naturally. |
| TS/JS extraction is regex-based | Re-exports, aliases, type-only imports, references, and calls are missed. |
| Analysis is one-hop reverse edge lookup | Enterprise side effects are under-reported. |
| Snapshot isolation is incomplete | Running indexes can mutate data relied on by completed indexes. |
| Source spans and provenance are thin | Reports are difficult to audit. |
| Resource limits are missing | Large or malicious repos can slow or break indexing. |
| No cross-repo contract model | API/gRPC changes in project A cannot yet be traced to clients or consumers in project B. |

## Problem

Agents can read code, but they rediscover the repo every session. They frequently miss:

1. Which tests and deployment paths connect to a changed function or setting
2. How shell scripts, YAML workflows, Terraform, and Kubernetes resources connect to code
3. Whether docs, policy, ownership, or CI jobs should be part of the impact report
4. Whether API, gRPC, GraphQL, or event contract changes in project A break project B clients or consumers
5. Whether a claim is proven, inferred, heuristic, or unknown
6. Which tests, reviews, or docs updates should be recommended

Impact Trace solves this with a cached project map. It indexes the project first, then
walks the entity graph when a change arrives.

## Scope And Non-Scope

### In v1 Scope

| Included | Why |
|---|---|
| Canonical entity/relation schema | Required for mixed language and mixed system indexing. |
| Snapshot-safe indexing | Agents must not read half-written index data. |
| Git diff analysis | Manual changed file input is only an MVP surface. |
| Tiered language adapters | Support TS/JS, Python, Go, Rust, Java, Kotlin, C#, C, and C++ in phases. |
| TypeScript semantic adapter | First high-confidence language lane. |
| Config/system adapters | Shell, YAML, package, CI, Docker, Kubernetes, Terraform are real impact paths. |
| Workspace catalog and contract index | Required to model enterprise systems connected by API, gRPC, and events. |
| Relationship visualization export | Mermaid/DOT/JSON graph export lets agents and humans inspect the same impact paths. |
| MCP read-only resources | Large reports should be resources, not one huge tool response. |
| Security/resource limits | Local repo content is untrusted input. |

### Not In v1 Scope

| Excluded | Why |
|---|---|
| Required graph database | Dual source-of-truth makes migration and consistency harder. |
| Required Obsidian plugin | Markdown/export work can follow after MCP analysis is stable. |
| Required web graph UI | Start with CLI/MCP graph export; add a web explorer after projections stabilize. |
| Autonomous code editing | Impact Trace advises; it does not edit code. |
| Full semantic analysis for every language | Accuracy and schedule would collapse if every language were deep at once. |
| Cloud sync | Local-first protects source code and secrets during early use. |

## Target Architecture

```text
                         +----------------------+
                         | Claude Code / Codex  |
                         +----------+-----------+
                                    |
                          MCP tools / resources
                                    |
+-------------+      +--------------v--------------+
| Git diff    +----->| Impact Analyzer             |
| base/head   |      | - changed entity resolver   |
+-------------+      | - bounded graph traversal   |
                     | - confidence aggregation    |
+-------------+      | - action recommendation     |
| CLI         +----->| - evidence packet builder   |
+-------------+      +--------------+--------------+
                                    |
                     +--------------v--------------+
                     | Workspace / Contract Index  |
                     | repos, APIs, gRPC, events   |
                     | producers, consumers        |
                     +--------------+--------------+
                                    |
                     +--------------v--------------+
                     | Canonical SQLite Store       |
                     | repos, workspaces            |
                     | adapter_runs, entities       |
                     | relations, evidence_spans    |
                     | reports, coverage            |
                     +--------------+--------------+
                                    |
              +---------------------+----------------------+
              |                     |                      |
 +------------v-----------+ +-------v---------+ +----------v----------+
 | Language adapters      | | System adapters | | Optional projections |
 | TS, Python, Go, Rust   | | CI, YAML, K8s   | | graph, visual, vector |
 | Java, Kotlin, C#, C/C++| | Terraform, API  | | CodeQL, Obsidian     |
 | Tree-sitter, LSP       | | contracts, events| |                     |
 +------------------------+ +-----------------+ +---------------------+
```

## Canonical Data Model

The main v1 shift is from a file-edge store to an entity graph store.

### Required Tables

| Table | Purpose |
|---|---|
| `repos` | Repo root, remote, default branch, config hash. |
| `schema_versions` | Migration version, applied time, failure status. |
| `workspaces` | Logical product/org/deployment boundary that groups multiple repos. |
| `workspace_repos` | Local path, remote, service name, and trust policy for repos in a workspace. |
| `index_runs` | Git commit, dirty state, branch, status, times, config hash. |
| `adapter_runs` | Adapter ID/version, language or system ID, parser/tool version, config hash, errors. |
| `entities` | Unified file, symbol, package, test, doc, config, policy, workflow, resource, endpoint records. |
| `entity_versions` | Content hash, location, display name, source range, state per index run. |
| `relations` | `source_entity_id`, `target_entity_id`, relation kind, confidence, adapter run. |
| `relation_evidence` | Source spans, query results, command outputs, confidence rationale. |
| `contracts` | Owner repo, service, and version metadata for OpenAPI, protobuf, GraphQL, and AsyncAPI contracts. |
| `contract_versions` | Contract hash, schema version, compatibility baseline, breaking-change summary. |
| `cross_repo_links` | Producer/consumer, client/server, and topic subscriber links across repos. |
| `index_coverage` | Indexed/skipped paths, unsupported languages/systems, parse errors, size-limit skips. |
| `reports` | Versioned impact report JSON and related evidence IDs. |
| `graph_projection_runs` | Optional graph projection source index run, schema version, invalidation state. |

### Entity Kinds

| Kind | Examples |
|---|---|
| `file` | `src/auth/session.ts`, `.github/workflows/ci.yml` |
| `symbol` | Function, class, variable, method, type, interface |
| `module` | Package module, Python module, Go package, Rust crate module |
| `package` | npm workspace, Python package, Maven module |
| `test` | Test file, test case, CI test job |
| `doc` | README, ADR, runbook, API docs |
| `config` | JSON, YAML, TOML, env, tsconfig, package scripts |
| `policy` | CODEOWNERS, OPA/Rego rule, permission manifest |
| `workflow` | GitHub Actions job, GitLab CI job, Make target |
| `resource` | Docker image, Kubernetes deployment, Terraform resource |
| `endpoint` | REST route, GraphQL field, gRPC/protobuf service |
| `contract` | OpenAPI operation, protobuf service/method, GraphQL schema field, AsyncAPI channel |
| `event` | Kafka topic, queue message, webhook event, domain event |
| `external_entity` | SaaS API, third-party service, or unmanaged repo outside the workspace |

### Relation Kinds

| Kind | Meaning |
|---|---|
| `DEPENDS_ON` | One entity needs another. |
| `CALLS` | A function or command invokes another symbol or command. |
| `REFERENCES` | A symbol, config key, resource name, or path is referenced. |
| `VERIFIES` | A test or CI job verifies an entity. |
| `DOCUMENTS` | A doc explains an entity. |
| `CONFIGURES` | A config controls runtime, workflow, or resource behavior. |
| `GENERATES` | A script or build step creates an artifact. |
| `DEPLOYS` | A workflow deploys an artifact or resource. |
| `OWNS` | Ownership or review path is assigned. |
| `GOVERNS` | A policy determines allowed changes or required review. |
| `IMPLEMENTS` | Code, route handlers, or RPC handlers implement a contract. |
| `CONSUMES` | Clients, generated SDKs, workflows, or services use an API/RPC/event contract. |
| `PRODUCES` | Services or workflows produce events, artifacts, or API response contracts. |
| `BREAKS_COMPATIBILITY_WITH` | A changed contract is incompatible with an existing consumer baseline. |

## Adapter Strategy

A repository can contain multiple programming languages and multiple operational systems. Adapters
therefore include language, config, system, and policy adapters.

| Adapter | Phase | Entity | Relation |
|---|---:|---|---|
| File classifier | P0 | file, config candidate | languageId/systemId, skipped reason |
| Git diff adapter | P0 | changed file/entity | base/head, rename/delete/binary/untracked |
| Workspace catalog adapter | P0 | workspace, repo, service boundary | owns-repo, exposes-service, depends-on-service |
| Contract baseline adapter | P0 | contract, endpoint, event | implements, consumes, produces |
| TypeScript Compiler API | P1 | symbol, module, package | imports, re-exports, references, calls |
| Python adapter | P1 | module, function, class, package | imports, references, calls |
| Go adapter | P1 | package, function, method, interface | imports, references, calls |
| Rust adapter | P1 | crate, module, function, trait, impl | uses, references, calls |
| Package/workspace adapter | P1 | package, script, workspace | depends-on, verifies, generates |
| JVM adapter | P2 | Java/Kotlin package, class, method, field, annotation | imports, references, calls, implements |
| .NET adapter | P2 | C# namespace, class, method, property, project | references, calls, project dependency |
| Native adapter | P2 | C/C++ translation unit, function, type, macro, target | includes, references, calls, build target |
| Build-system adapter | P1/P2 | npm, pip, cargo, Maven, Gradle, dotnet, CMake, Make, Bazel target | depends-on, verifies, generates |
| Shell/Make adapter | P1 | script, command, target | calls, generates, configures |
| YAML/JSON/TOML adapter | P1 | config, workflow, resource | configures, references |
| GitHub Actions/GitLab CI adapter | P1 | workflow, job, step | verifies, deploys, calls |
| Docker/Kubernetes adapter | P1 | image, service, deployment, secret ref | configures, deploys, routes-to |
| Terraform adapter | P1 | module, variable, resource | depends-on, configures |
| OpenAPI/GraphQL/protobuf/AsyncAPI adapter | P1 | endpoint, schema field, service, event | implements, consumes, produces, documents |
| Cross-repo resolver | P1 | external_entity, cross_repo_link | contract producer/consumer, SDK import, base URL, topic subscriber |
| Markdown/ADR adapter | P1 | doc, decision | documents, references |
| CODEOWNERS/policy adapter | P1 | owner rule, policy rule | owns, governs, requires-review |
| Tree-sitter fallback | P2 | broad symbol/module | declares, imports, references |
| LSP adapter | P2 | symbol/reference/call hierarchy | definition, references, calls |
| CodeQL adapter | P2 | data-flow/control-flow node | taints, controls, calls |

Language adapters do not attempt full semantic analysis in one step. P1 captures
project structure, imports, references, calls, and test/build targets; P2 enriches
accuracy with LSP, CodeQL, and build-system evidence.

## Analysis Flow

```text
git diff or changed input
  -> changed paths, deleted paths, renamed paths, changed ranges
  -> normalize to EntityRef candidates
  -> select latest completed index_run_id and check freshness
  -> check workspace catalog for related repos and service boundaries
  -> if a contract/entity changed, find producer and consumer repo candidates
  -> map changed entities into relation graph
  -> bounded reverse traversal
  -> apply package/workflow/resource/workspace boundaries
  -> compute affected targets and confidence
  -> collect evidence spans and coverage gaps
  -> recommend test/review/docs/deploy actions
  -> return CLI summary, JSON report, graph export, MCP resource
```

## Relationship Visualization

Visualization is a projection for humans, not the source of analysis truth. The source
data remains in SQLite `entities`, `relations`, and `relation_evidence`; graph files or
screens are regenerated for a specific report, workspace, or entity scope.

| Surface | Phase | Purpose |
|---|---:|---|
| Mermaid export | P1 | Small impact graphs for PR descriptions, Markdown reports, and Obsidian notes. |
| DOT/Graphviz export | P1 | Layout larger graphs or save CI artifacts. |
| JSON graph export | P1 | Stable contract for web UIs, D3, Cytoscape, Gephi, and other tools. |
| MCP graph resource | P3 | Agents read `impact://graph/{id}` with pagination. |
| Web graph explorer | P4 | Optional UI for filtering by entity, repo, contract, confidence, and coverage gaps. |

Default visualization filters are `changed`, `affected`, `tests`, `deploy`, `contract`,
and `unknown`. Edges distinguish relation kind and confidence. Secret-like evidence is
never rendered in labels or tooltips.

## MCP And CLI Contract

### CLI

```bash
impact-trace init
impact-trace index
impact-trace workspace init
impact-trace workspace index
impact-trace analyze --base origin/main --head HEAD
impact-trace analyze --workspace --base origin/main --head HEAD
impact-trace analyze --changed src/file.ts --json
impact-trace graph export --report <id> --format mermaid
impact-trace graph export --entity impact://entity/{id} --depth 2 --format json
impact-trace explain impact://entity/{id}
impact-trace mcp serve
```

### MCP Tools

| Tool | Status | Purpose |
|---|---|---|
| `impact_trace_analyze_diff` | MVP | Analyze changed files. |
| `impact_trace_analyze_git_diff` | P0 | Analyze base/head diff as changed entities. |
| `impact_trace_explain_entity` | P1 | Explain one entity's relations and evidence. |
| `impact_trace_analyze_workspace_diff` | P3 | Analyze multi-repo diffs and contract consumer impact. |
| `impact_trace_get_graph` | P3 | Return a graph resource URI for a report/entity/workspace scope. |

### MCP Resources

| URI | Status | Purpose |
|---|---|---|
| `impact://report/{id}` | P1 | Paginated full report. |
| `impact://evidence/{id}` | P1 | Redacted evidence span and provenance. |
| `impact://entity/{id}` | P1 | Entity metadata and direct relations. |
| `impact://coverage/{indexRunId}` | P1 | Missing adapters and skipped files. |
| `impact://workspace/{id}` | P3 | Workspace repo/service catalog and coverage. |
| `impact://contract/{id}` | P3 | Contract version, producer, consumer, and compatibility evidence. |
| `impact://graph/{id}` | P3 | Visualization nodes/edges, filters, and legend with pagination. |

MCP tool responses should stay compact and agent-friendly. Large reports move to resources.

## Security And Trust Boundaries

Impact Trace reads local repositories, but repo content is untrusted.

| Risk | Control |
|---|---|
| Path traversal | Every file input passes root containment. |
| Symlink escape | Realpath validation and symlink policy tests remain required. |
| TOCTOU | Reduce validate-then-open paths and design atomic open/write strategies. |
| Partial index read | Separate running snapshots from completed snapshots. |
| Secret leakage | Redact before storage, add denylisted paths, binary detection, sensitivity classes. |
| Oversized repo DoS | Enforce file count, file size, depth, binary, and timeout limits. |
| Command execution | MCP never executes commands; actions are structured recommendations. |
| Cross-repo traversal | Only allowlisted workspace repos are read; no arbitrary remote clone or network call. |
| External contract | Third-party APIs use local spec files or user-provided snapshots only. |
| Visualization leakage | Graph labels and tooltips use redacted display names and provenance summaries only. |
| Future write tools | Capability objects separate repo read, vault write, and command execution. |

## Test And Quality Gates

| Gate | v1 Target |
|---|---:|
| Golden fixture affected-entity recall | >= 90% |
| Critical false negative | 0 |
| Test action precision | >= 70% |
| Stale-index detection | 100% on fixtures |
| Secret leak | 0 planted secrets |
| MCP read-only mutation | 0 writes |
| Unsupported coverage reporting | 100% on fixtures |
| Graph export determinism | 100% on fixtures |

Required fixture repos:

| Fixture | Contents |
|---|---|
| TS package | Re-exports, default exports, type-only imports, path aliases |
| JVM repo | Java, Kotlin, Maven, Gradle, annotations, test source sets |
| .NET repo | C#, solution/project references, NuGet packages, test project |
| Native repo | C, C++, header includes, CMake/Make/Bazel targets |
| Mixed-language repo | TS, Python, Go, Rust, Java, Kotlin, C#, C/C++, shell, YAML, Dockerfile, Markdown |
| CI/infra repo | GitHub Actions, Docker, Kubernetes, Terraform |
| Monorepo | Workspaces, package boundaries, package-level tests |
| Workspace contract repo | Provider repo, consumer repo, OpenAPI/protobuf/GraphQL/AsyncAPI contract |
| Event-driven repo | Producer service, consumer service, queue/topic schema |
| Graph visualization repo | Changed/affected/test/deploy/contract relations exported as Mermaid/DOT/JSON |
| Security repo | env files, Kubernetes Secret, Terraform vars, PEM, token-like content |
| Stale-index repo | Running index vs completed index conflicts |
| Delete/rename repo | Deleted files, renamed files, binary files, generated files |

## Roadmap

### P0: Entity Graph Core

Goal: make storage and reports ready for mixed-language and mixed-system indexing.

| Work | Done When |
|---|---|
| Migration runner | Schema version, failed migration, compatibility checks exist. |
| Add `entities`/`relations`/`relation_evidence` | File/symbol/import outputs are stored in the new model. |
| Persist `adapter_runs`/`index_coverage` | Adapter metadata and skipped reasons are in DB and reports. |
| Fix snapshot isolation | Running index cannot corrupt latest completed index. |
| Add performance indexes | Reverse traversal hot queries use indexes. |
| Version report contract | `reportVersion`, `schemaVersion`, repo/index/diff metadata exist. |
| Add resource limits | Oversized/binary/deep trees are skipped with coverage records. |
| Add git diff input | `--base`, `--head`, rename/delete/untracked are handled. |
| Add workspace catalog schema | Repo-local indexes can be grouped into one workspace. |
| Add contract entity baseline | OpenAPI/protobuf/GraphQL/AsyncAPI files are stored as `contract`, `endpoint`, and `event` entities. |

### P1: Mixed Repo Adapter Pack

Goal: connect the real code, config, workflow, and infrastructure boundaries in enterprise repos.

| Work | Done When |
|---|---|
| TypeScript semantic adapter | Compiler API extracts exports/imports/re-exports/path aliases/source spans. |
| Python/Go/Rust adapters | Package/module/symbol/import/reference relations are extracted. |
| Package/workspace adapter | npm/pnpm/yarn/bun workspaces and scripts/test runners are extracted. |
| Shell/Make adapter | Commands and generated artifacts become relations. |
| YAML/JSON/TOML adapter | Config keys and referenced paths/resources become relations. |
| CI adapter | Workflows, jobs, steps, test/deploy actions are extracted. |
| Docker/Kubernetes/Terraform adapter | Deployment/resource/config relations are extracted. |
| OpenAPI/protobuf/GraphQL/AsyncAPI adapter | Endpoint/service/event contracts and handler/client relations are extracted. |
| Cross-repo resolver | API/gRPC/event producer changes connect to consumer repos and generated SDK imports. |
| Compatibility analyzer | Contract diffs are classified as breaking/non-breaking/unknown. |
| Markdown/CODEOWNERS/policy adapter | Docs, owners, and policy relations are extracted. |
| Graph export | Mermaid, DOT, and JSON graphs are deterministic for report/entity scopes. |
| Recursive traversal | Multi-hop impact and fan-out warnings work. |

### P2: Enterprise Language Adapter Pack

Goal: expand enterprise language coverage to JVM, .NET, and native codebases.

| Work | Done When |
|---|---|
| Java/Kotlin adapter | Maven/Gradle modules, packages/classes/methods, annotations, and test source sets are extracted. |
| C#/.NET adapter | Solution/project references, namespaces/classes/methods/properties, and NuGet relations are extracted. |
| C/C++ adapter | Header includes, functions/types/macros, compile targets, and generated source relations are extracted. |
| Build-system resolver | Maven, Gradle, dotnet, CMake, Bazel, and Make targets connect to test/build/deploy actions. |
| LSP/CodeQL enrichment | Reference/call/data-flow evidence is added for supported languages. |

### P3: Agent-Ready MCP

Goal: let Claude Code and Codex safely consume large reports and choose actions.

| Work | Done When |
|---|---|
| MCP report/evidence/entity resources | Large payloads are paginated resources. |
| MCP workspace/contract resources | Repo catalogs and contract impact are available as resources. |
| MCP graph resource | Large relationship graphs are readable with pagination and filter metadata. |
| Workspace diff tool | Multi-repo changed entities and downstream consumer risk are summarized. |
| Compact tool response | Tool returns summary plus resource URIs. |
| Explain command | One entity can be explained with relations and evidence. |
| Action provider | CI/job/docs/owner review actions exist beyond npm. |
| Typed error envelope | Problem, cause, fix, and evidence ID are included. |
| Stale-index warning | Agents can see when the index is stale. |

### P4: Optional Projections And Human Memory

Goal: add optional surfaces after the core is stable.

| Work | Done When |
|---|---|
| Graph DB projection | Derived from a SQLite source index run with invalidation policy. |
| Web graph explorer | Filter entities/relations/workspaces/contracts by confidence and coverage. |
| CodeQL adapter | Data/control-flow evidence is added for supported languages. |
| Vector/search adapter | Similar code and docs search assist analysis. |
| Obsidian dry-run export | Managed notes, conflicts, and symlink guard exist. |
| Hotspot/history analytics | Churn, co-change, owner, and failure history influence reports. |

## Known Gaps

| Gap | Severity | Phase |
|---|---:|---|
| File-centric schema | High | P0 |
| Running index can mutate completed snapshot data | High | P0 |
| TOCTOU read/write gaps | High | P0 |
| Thin source spans and provenance | High | P0 |
| No git diff or stale-index detection | High | P0 |
| No cross-repo workspace/contract model | High | P0/P1 |
| Regex TS/JS extraction | High | P1 |
| No Java/Kotlin/C# adapters | High | P2 |
| No C/C++ and build-system relations | High | P2 |
| No shell/YAML/infra/policy adapters | High | P1 |
| No relation visualization export | Medium | P1/P3 |
| No MCP resources | Medium | P3 |
| Action provider is npm-centered | Medium | P3 |
| No open-source release automation | Medium | P3 |

## Decision Record

| Decision | Why | Rejected Alternative |
|---|---|---|
| Do not make graph DB the core. | Keeps install and migration simple. | Required Neo4j/FalkorDB/Kuzu runtime. |
| Store the canonical graph in SQLite. | Local-first, lightweight, testable. | Graph DB as source of truth. |
| Expand language adapters in tiers. | TS/JS, Python, Go, Rust, then Java, Kotlin, C#, C, and C++ all fit the same model. | Complete full semantic analysis for one language first. |
| Define multi-system model before deep TS work. | Real repos mix language, YAML, shell, infra, and policy. | Deep TypeScript adapter first. |
| Keep repo-local DBs and add a workspace catalog. | Preserves single-repo use while enabling multi-repo API/gRPC/event impact. | Start with a central server or required graph DB. |
| Stabilize read-only MCP before writes. | Agent write and command execution surfaces are risky. | Obsidian/write tools first. |
| Persist adapter metadata and coverage. | Missing analysis must be visible to agents. | Silently ignore adapter failures. |
| Return actions, not executable shell strings. | Repo-controlled strings should not become execution paths. | Raw command strings in reports. |

## Approval Criteria

This plan is v1-ready when:

1. P0 schema and migrations are implemented while the MVP report still works.
2. A mixed-language fixture creates `file`, `symbol`, `config`, `workflow`, `resource`, and `policy` entities.
3. Java/Kotlin, C#, and C/C++ fixtures create module/project/build-target relations.
4. A workspace contract fixture creates API/gRPC/event relations between provider and consumer repos.
5. `analyze --base --head` returns changed and affected entities.
6. Graph export creates deterministic Mermaid/JSON graphs from the same report.
7. MCP read-only tools return compact summaries plus report resource URIs.
8. Security fixtures produce zero raw secret leaks.
9. Missing adapters and skipped files appear clearly in reports.
