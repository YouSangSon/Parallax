# Impact Trace Indexing Model

Korean version: [indexing-model.ko.md](indexing-model.ko.md)

## Goal

Impact Trace represents multiple languages and multiple system configurations inside
one repository as a single impact graph. Files are only the starting point. The final
analysis units are functions, variables, classes, modules, packages, shell commands,
YAML workflows, Kubernetes resources, Terraform resources, policy rules, docs, and tests.

## Core Terms

| Term | Meaning | Why It Matters |
|---|---|---|
| Entity | Something that can change or be affected | Symbols, workflows, resources, and policies become first-class targets. |
| Relation | A directed connection between entities | Explains how impact propagates. |
| Evidence | Why a relation should be trusted | Agents see proof instead of guesses. |
| Adapter | Extracts entities and relations from a language or system | TS, shell, YAML, CI, Terraform can evolve independently. |
| Coverage | What was indexed and what was skipped | Unknown areas are visible. |
| Action | Recommended verification or review work | Tests, owner reviews, policy reviews, and docs updates are structured. |

## Entity Classification

| Category | Entity Kind | Examples |
|---|---|---|
| Code | `file`, `symbol`, `module`, `package` | `validateSession`, `auth/session.ts`, npm workspace |
| Test | `test` | Test file, test case, CI test job |
| Docs | `doc` | README, ADR, runbook |
| Config | `config` | YAML, JSON, TOML, env, `tsconfig`, package script |
| Workflow | `workflow` | GitHub Actions workflow, job, step, Make target |
| Infra | `resource` | Docker image, Kubernetes deployment, Terraform resource |
| API | `endpoint` | REST route, GraphQL field, protobuf service |
| Governance | `policy` | CODEOWNERS rule, OPA/Rego rule, permission manifest |

## Relation Classification

| Relation | Description |
|---|---|
| `DEPENDS_ON` | The source entity needs the target entity. |
| `CALLS` | A source symbol or command invokes the target. |
| `REFERENCES` | A config key, path, resource name, or symbol is referenced. |
| `VERIFIES` | A test or CI job verifies the target entity. |
| `DOCUMENTS` | A document describes the target entity. |
| `CONFIGURES` | A config controls runtime, workflow, or resource behavior. |
| `GENERATES` | A build or script creates an artifact. |
| `DEPLOYS` | A workflow deploys an artifact or resource. |
| `OWNS` | Ownership or review path is assigned. |
| `GOVERNS` | A policy controls allowed changes or required review. |

## Entity ID Rules

Entity IDs must be deterministic. The same repo and the same index input should produce
the same IDs so reports and graph projections can be compared.

| Entity | Example ID |
|---|---|
| File | `file:src/auth/session.ts` |
| Symbol | `symbol:typescript:src/auth/session.ts#function:validateSession` |
| Package | `package:npm:apps/web` |
| CI job | `workflow:github-actions:.github/workflows/ci.yml#job:test` |
| Kubernetes resource | `resource:kubernetes:apps/api/deployment/api` |
| Terraform resource | `resource:terraform:aws_lambda_function.auth_handler` |
| Policy rule | `policy:codeowners:/src/auth/*` |

## Adapter Layers

Adapters share the same output contract.

```text
Repo files
  -> file classifier
  -> adapter selection
  -> entities
  -> relations
  -> evidence spans
  -> coverage records
```

| Adapter Family | Role |
|---|---|
| Language semantic | TypeScript Compiler API, LSP, CodeQL produce high-confidence symbols/references. |
| Syntax fallback | Tree-sitter provides broad symbol/import coverage across languages. |
| Config/system | YAML, JSON, TOML, shell, Docker, Kubernetes, Terraform, CI. |
| Policy/governance | CODEOWNERS, OPA/Rego, permission manifests. |
| Action provider | Recommends test, review, docs, and deploy checks. |
| Projection | Derives graph DB, vector DB, or Obsidian surfaces from SQLite. |

## Storage Requirements

| Requirement | Why |
|---|---|
| `entities` and `relations` are canonical | Enables general impact analysis without a graph DB. |
| `adapter_runs` are stored | Shows which adapter version read which inputs. |
| `relation_evidence` stores source spans | Reports can show line-level proof. |
| `index_coverage` stores skipped reasons | Unsupported languages and oversized files are visible. |
| Running and completed indexes are isolated | Analysis never reads partial state. |
| Reports use versioned contracts | MCP clients and CLI automation can upgrade safely. |

## Report Model

| Field | Role |
|---|---|
| `reportVersion` | Report JSON contract version |
| `schemaVersion` | SQLite schema compatibility |
| `repo` | Root, remote, branch, commit, dirty state |
| `diff` | Base/head, changed ranges, rename/delete data |
| `changed` | Changed entities |
| `affected` | Impacted entities and relation paths |
| `actions` | Test, review, docs, deploy recommendations |
| `evidence` | Redacted source spans and provenance |
| `coverage` | Missing adapters, skipped files, parse errors |

## Difference From Current MVP

| Current MVP | Target Model |
|---|---|
| File path centered | Entity ID centered |
| `edges.target_path` reverse lookup | `relations.target_entity_id` graph traversal |
| Regex TS/JS extraction | Semantic adapter plus fallback adapter |
| Whole-file snippet evidence | Source span evidence |
| `changedFiles` input | Git diff, entity input, patch input |
| npm test action | Runner/action provider |
| Single MCP tool JSON text | Compact tool plus paginated resources |

