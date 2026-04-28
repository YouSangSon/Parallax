# Impact Trace Indexing Model

Korean version: [indexing-model.ko.md](indexing-model.ko.md)

## Goal

Impact Trace represents multiple languages, multiple system configurations, and
cross-repo API/gRPC/event contracts as a single impact graph. Files are only the
starting point. The final analysis units are functions, variables, classes, modules,
packages, shell commands, YAML workflows, Kubernetes resources, Terraform resources,
policy rules, docs, tests, contracts, and events. Language coverage starts with TS/JS
but expands through Python, Go, Rust, Java, Kotlin, C#, C, and C++ under the same model.

## Core Terms

| Term | Meaning | Why It Matters |
|---|---|---|
| Entity | Something that can change or be affected | Symbols, workflows, resources, and policies become first-class targets. |
| Relation | A directed connection between entities | Explains how impact propagates. |
| Evidence | Why a relation should be trusted | Agents see proof instead of guesses. |
| Adapter | Extracts entities and relations from a language or system | TS/JS, Python, Go, Rust, Java/Kotlin, C#, C/C++, shell, YAML, CI, Terraform can evolve independently. |
| Workspace | A product/service boundary that groups multiple repos | Tracks impact across projects connected by API, gRPC, and events. |
| Contract | A service contract such as OpenAPI, protobuf, GraphQL, or AsyncAPI | Determines whether provider changes can break consumers. |
| Coverage | What was indexed and what was skipped | Unknown areas are visible. |
| Visualization | A relationship view derived from the entity graph | Agents and humans inspect the same impact path. |
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
| Contract | `contract`, `event` | OpenAPI operation, protobuf method, GraphQL field, Kafka topic |
| External | `external_entity` | SaaS API, third-party service, unmanaged repo outside the workspace |
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
| `IMPLEMENTS` | Code, route handlers, or RPC handlers implement a contract. |
| `CONSUMES` | Clients, generated SDKs, workflows, or services use an API/RPC/event contract. |
| `PRODUCES` | Services or workflows produce events, artifacts, or API response contracts. |
| `BREAKS_COMPATIBILITY_WITH` | A changed contract is incompatible with an existing consumer baseline. |

## Entity ID Rules

Entity IDs must be deterministic. The same repo and the same index input should produce
the same IDs so reports and graph projections can be compared.

For workspaces that group multiple repos, IDs include a repo namespace. Repo-local IDs
stay short, while workspace reports add a `repo:<service-name>:` prefix to avoid
collisions.

| Entity | Example ID |
|---|---|
| File | `file:src/auth/session.ts` |
| Symbol | `symbol:typescript:src/auth/session.ts#function:validateSession` |
| Package | `package:npm:apps/web` |
| CI job | `workflow:github-actions:.github/workflows/ci.yml#job:test` |
| Kubernetes resource | `resource:kubernetes:apps/api/deployment/api` |
| Terraform resource | `resource:terraform:aws_lambda_function.auth_handler` |
| Policy rule | `policy:codeowners:/src/auth/*` |
| Workspace repo | `repo:billing-api` |
| OpenAPI contract | `repo:billing-api:contract:openapi:/paths/~1invoices/get` |
| Protobuf method | `repo:user-api:contract:protobuf:user.v1.UserService/GetUser` |
| Event topic | `repo:orders:event:kafka:order.created` |
| External API | `external:stripe:/v1/customers` |

## Language Adapter Scope

Every language adapter produces the same `Entity` and `Relation` output contract.
Accuracy can improve in tiers without splitting the report model by language.

| Language/Ecosystem | Key Entities | Key Relations |
|---|---|---|
| TypeScript/JavaScript | Module, function, class, variable, type, package | Imports, re-exports, references, calls |
| Python | Module, function, class, package | Imports, references, calls |
| Go | Package, function, method, interface | Imports, references, calls |
| Rust | Crate, module, function, trait, impl | Uses, references, calls |
| Java/Kotlin | Maven/Gradle module, package, class, method, field, annotation | Imports, references, calls, implements |
| C#/.NET | Solution, project, namespace, class, method, property | Project dependency, references, calls |
| C/C++ | Translation unit, header, function, type, macro, build target | Includes, references, calls, generates |
| Build systems | npm, pip, cargo, Maven, Gradle, dotnet, CMake, Make, Bazel target | Depends-on, verifies, generates |

## Workspace And Cross-Project Links

Each repo must remain independently indexable. A workspace index does not replace
repo-local DBs; it reads completed indexes from each repo and adds cross-repo relations.

| Link Type | Evidence | Generated Relations |
|---|---|---|
| REST/OpenAPI | `openapi.yaml`, route handler, generated client, base URL config | `IMPLEMENTS`, `CONSUMES`, `DOCUMENTS` |
| gRPC/protobuf | `.proto`, service implementation, generated stub import | `IMPLEMENTS`, `CONSUMES` |
| GraphQL | Schema, resolver, query/mutation document | `IMPLEMENTS`, `CONSUMES` |
| AsyncAPI/event | Topic/channel schema, producer call, consumer subscription | `PRODUCES`, `CONSUMES` |
| External SaaS | Local contract snapshot, SDK import, env/config key | `CONSUMES`, `REFERENCES` |

Contract diffs are classified as `breaking`, `non-breaking`, or `unknown`. The analyzer
connects potentially breaking changes to consumer repos, related tests, and owner review
actions.

## Relationship Visualization Model

Visualization is a projection of the canonical graph. It does not change storage; it
regenerates nodes and edges for a report, entity, or workspace scope.

| Export | Purpose |
|---|---|
| Mermaid | Small graphs for Markdown reports, PR descriptions, and Obsidian notes |
| DOT/Graphviz | Larger graph layouts, CI artifacts, image generation |
| JSON graph | Integration with web UIs, D3, Cytoscape, Gephi, and external tools |

Visualization nodes include entity kind, repo, display name, confidence, and coverage
status. Edges include relation kind, evidence count, and confidence. Raw secrets and long
source snippets are never included.

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
| Build/project system | Maven, Gradle, dotnet, CMake, Make, Bazel, and package-manager metadata. |
| Config/system | YAML, JSON, TOML, shell, Docker, Kubernetes, Terraform, CI. |
| Workspace/contract | Repo catalogs, OpenAPI, protobuf, GraphQL, AsyncAPI, event schemas. |
| Policy/governance | CODEOWNERS, OPA/Rego, permission manifests. |
| Action provider | Recommends test, review, docs, and deploy checks. |
| Projection | Derives graph DB, visual graph, vector DB, or Obsidian surfaces from SQLite. |

## Storage Requirements

| Requirement | Why |
|---|---|
| `entities` and `relations` are canonical | Enables general impact analysis without a graph DB. |
| `workspaces` and `workspace_repos` are thin layers above repo-local DBs | Keeps single-repo use simple while enabling cross-repo analysis. |
| `contracts`, `contract_versions`, and `cross_repo_links` exist | Stores producer/consumer impact for API/gRPC/event changes. |
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
| `workspace` | Optional workspace, related repos, service boundaries |
| `actions` | Test, review, docs, deploy recommendations |
| `evidence` | Redacted source spans and provenance |
| `coverage` | Missing adapters, skipped files, parse errors |
| `graph` | Optional Mermaid/DOT/JSON graph export URI or inline summary |

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
| Repo-local impact only | Workspace-aware API/gRPC/event contract impact |
| No graph visualization | Mermaid/DOT/JSON graph export plus optional web explorer |
