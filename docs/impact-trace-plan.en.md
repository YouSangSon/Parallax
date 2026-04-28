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
Terraform, Kubernetes, OpenAPI, policy files, docs, and tests inside one repository.
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
| Multi-language by default | A real repo can contain many languages and system configs at once. |
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

## Problem

Agents can read code, but they rediscover the repo every session. They frequently miss:

1. Which tests and deployment paths connect to a changed function or setting
2. How shell scripts, YAML workflows, Terraform, and Kubernetes resources connect to code
3. Whether docs, policy, ownership, or CI jobs should be part of the impact report
4. Whether a claim is proven, inferred, heuristic, or unknown
5. Which tests, reviews, or docs updates should be recommended

Impact Trace solves this with a cached project map. It indexes the project first, then
walks the entity graph when a change arrives.

## Scope And Non-Scope

### In v1 Scope

| Included | Why |
|---|---|
| Canonical entity/relation schema | Required for mixed language and mixed system indexing. |
| Snapshot-safe indexing | Agents must not read half-written index data. |
| Git diff analysis | Manual changed file input is only an MVP surface. |
| TypeScript semantic adapter | First high-confidence language lane. |
| Config/system adapters | Shell, YAML, package, CI, Docker, Kubernetes, Terraform are real impact paths. |
| MCP read-only resources | Large reports should be resources, not one huge tool response. |
| Security/resource limits | Local repo content is untrusted input. |

### Not In v1 Scope

| Excluded | Why |
|---|---|
| Required graph database | Dual source-of-truth makes migration and consistency harder. |
| Required Obsidian plugin | Markdown/export work can follow after MCP analysis is stable. |
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
                     | Canonical SQLite Store       |
                     | repos, index_runs            |
                     | adapter_runs, entities       |
                     | relations, evidence_spans    |
                     | reports, coverage            |
                     +--------------+--------------+
                                    |
              +---------------------+----------------------+
              |                     |                      |
 +------------v-----------+ +-------v---------+ +----------v----------+
 | Language adapters      | | System adapters | | Optional projections |
 | TS, Python, Go, Rust   | | CI, YAML, K8s   | | graph, vector, OLAP  |
 | Tree-sitter, LSP       | | Terraform, API  | | CodeQL, Obsidian     |
 +------------------------+ +-----------------+ +---------------------+
```

## Canonical Data Model

The main v1 shift is from a file-edge store to an entity graph store.

### Required Tables

| Table | Purpose |
|---|---|
| `repos` | Repo root, remote, default branch, config hash. |
| `schema_versions` | Migration version, applied time, failure status. |
| `index_runs` | Git commit, dirty state, branch, status, times, config hash. |
| `adapter_runs` | Adapter ID/version, language or system ID, parser/tool version, config hash, errors. |
| `entities` | Unified file, symbol, package, test, doc, config, policy, workflow, resource, endpoint records. |
| `entity_versions` | Content hash, location, display name, source range, state per index run. |
| `relations` | `source_entity_id`, `target_entity_id`, relation kind, confidence, adapter run. |
| `relation_evidence` | Source spans, query results, command outputs, confidence rationale. |
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

## Adapter Strategy

A repository can contain multiple programming languages and multiple operational systems. Adapters
therefore include language, config, system, and policy adapters.

| Adapter | Phase | Entity | Relation |
|---|---:|---|---|
| File classifier | P0 | file, config candidate | languageId/systemId, skipped reason |
| Git diff adapter | P0 | changed file/entity | base/head, rename/delete/binary/untracked |
| TypeScript Compiler API | P1 | symbol, module, package | imports, re-exports, references, calls |
| Package/workspace adapter | P1 | package, script, workspace | depends-on, verifies, generates |
| Shell/Make adapter | P1 | script, command, target | calls, generates, configures |
| YAML/JSON/TOML adapter | P1 | config, workflow, resource | configures, references |
| GitHub Actions/GitLab CI adapter | P1 | workflow, job, step | verifies, deploys, calls |
| Docker/Kubernetes adapter | P1 | image, service, deployment, secret ref | configures, deploys, routes-to |
| Terraform adapter | P1 | module, variable, resource | depends-on, configures |
| OpenAPI/GraphQL/protobuf adapter | P1 | endpoint, schema field, service | implements, consumes, documents |
| Markdown/ADR adapter | P1 | doc, decision | documents, references |
| CODEOWNERS/policy adapter | P1 | owner rule, policy rule | owns, governs, requires-review |
| Tree-sitter fallback | P2 | broad symbol/module | declares, imports, references |
| LSP adapter | P2 | symbol/reference/call hierarchy | definition, references, calls |
| CodeQL adapter | P2 | data-flow/control-flow node | taints, controls, calls |

## Analysis Flow

```text
git diff or changed input
  -> changed paths, deleted paths, renamed paths, changed ranges
  -> normalize to EntityRef candidates
  -> select latest completed index_run_id and check freshness
  -> map changed entities into relation graph
  -> bounded reverse traversal
  -> apply package/workflow/resource boundaries
  -> compute affected targets and confidence
  -> collect evidence spans and coverage gaps
  -> recommend test/review/docs/deploy actions
  -> return CLI summary, JSON report, MCP resource
```

## MCP And CLI Contract

### CLI

```bash
impact-trace init
impact-trace index
impact-trace analyze --base origin/main --head HEAD
impact-trace analyze --changed src/file.ts --json
impact-trace explain impact://entity/{id}
impact-trace mcp serve
```

### MCP Tools

| Tool | Status | Purpose |
|---|---|---|
| `impact_trace_analyze_diff` | MVP | Analyze changed files. |
| `impact_trace_analyze_git_diff` | P0 | Analyze base/head diff as changed entities. |
| `impact_trace_explain_entity` | P1 | Explain one entity's relations and evidence. |

### MCP Resources

| URI | Status | Purpose |
|---|---|---|
| `impact://report/{id}` | P1 | Paginated full report. |
| `impact://evidence/{id}` | P1 | Redacted evidence span and provenance. |
| `impact://entity/{id}` | P1 | Entity metadata and direct relations. |
| `impact://coverage/{indexRunId}` | P1 | Missing adapters and skipped files. |

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

Required fixture repos:

| Fixture | Contents |
|---|---|
| TS package | Re-exports, default exports, type-only imports, path aliases |
| Mixed-language repo | TS, Python, shell, YAML, Dockerfile, Markdown |
| CI/infra repo | GitHub Actions, Docker, Kubernetes, Terraform |
| Monorepo | Workspaces, package boundaries, package-level tests |
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

### P1: Mixed Repo Adapter Pack

Goal: connect the real code, config, workflow, and infrastructure boundaries in enterprise repos.

| Work | Done When |
|---|---|
| TypeScript semantic adapter | Compiler API extracts exports/imports/re-exports/path aliases/source spans. |
| Package/workspace adapter | npm/pnpm/yarn/bun workspaces and scripts/test runners are extracted. |
| Shell/Make adapter | Commands and generated artifacts become relations. |
| YAML/JSON/TOML adapter | Config keys and referenced paths/resources become relations. |
| CI adapter | Workflows, jobs, steps, test/deploy actions are extracted. |
| Docker/Kubernetes/Terraform adapter | Deployment/resource/config relations are extracted. |
| Markdown/CODEOWNERS/policy adapter | Docs, owners, and policy relations are extracted. |
| Recursive traversal | Multi-hop impact and fan-out warnings work. |

### P2: Agent-Ready MCP

Goal: let Claude Code and Codex safely consume large reports and choose actions.

| Work | Done When |
|---|---|
| MCP report/evidence/entity resources | Large payloads are paginated resources. |
| Compact tool response | Tool returns summary plus resource URIs. |
| Explain command | One entity can be explained with relations and evidence. |
| Action provider | CI/job/docs/owner review actions exist beyond npm. |
| Typed error envelope | Problem, cause, fix, and evidence ID are included. |
| Stale-index warning | Agents can see when the index is stale. |

### P3: Optional Projections And Human Memory

Goal: add optional surfaces after the core is stable.

| Work | Done When |
|---|---|
| Graph DB projection | Derived from a SQLite source index run with invalidation policy. |
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
| Regex TS/JS extraction | High | P1 |
| No shell/YAML/infra/policy adapters | High | P1 |
| No MCP resources | Medium | P2 |
| Action provider is npm-centered | Medium | P2 |
| No open-source release automation | Medium | P2 |

## Decision Record

| Decision | Why | Rejected Alternative |
|---|---|---|
| Do not make graph DB the core. | Keeps install and migration simple. | Required Neo4j/FalkorDB/Kuzu runtime. |
| Store the canonical graph in SQLite. | Local-first, lightweight, testable. | Graph DB as source of truth. |
| Define multi-system model before deep TS work. | Real repos mix language, YAML, shell, infra, and policy. | Deep TypeScript adapter first. |
| Stabilize read-only MCP before writes. | Agent write and command execution surfaces are risky. | Obsidian/write tools first. |
| Persist adapter metadata and coverage. | Missing analysis must be visible to agents. | Silently ignore adapter failures. |
| Return actions, not executable shell strings. | Repo-controlled strings should not become execution paths. | Raw command strings in reports. |

## Approval Criteria

This plan is v1-ready when:

1. P0 schema and migrations are implemented while the MVP report still works.
2. A mixed-language fixture creates `file`, `symbol`, `config`, `workflow`, `resource`, and `policy` entities.
3. `analyze --base --head` returns changed and affected entities.
4. MCP read-only tools return compact summaries plus report resource URIs.
5. Security fixtures produce zero raw secret leaks.
6. Missing adapters and skipped files appear clearly in reports.
