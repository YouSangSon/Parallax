# TODOS

## P0: Entity Graph Core

| Item | Why | Exit Criteria |
|---|---|---|
| Add migration runner | Current bootstrap migrations cannot safely evolve schema. | Ordered migrations, compatibility check, failed migration record. |
| Add canonical `entities` and `relations` tables | Current file-edge model cannot represent policy, CI, infra, endpoint, resource entities. | Existing TS/JS/Markdown output is written to both old report and new entity graph. |
| Add `adapter_runs` and `index_coverage` | Reports must show which adapters ran and what was skipped. | DB and JSON report include adapter metadata, skipped paths, parse errors. |
| Fix snapshot isolation | Running indexes can mutate data used by completed indexes. | Analyze/MCP read only latest completed immutable snapshot. |
| Add performance indexes | Reverse traversal will scan on large repos. | Analyzer hot queries use indexes for source/target/relation lookup. |
| Add report versioning | MCP/CLI clients need upgrade-safe contracts. | Report includes `reportVersion`, `schemaVersion`, repo metadata, diff metadata. |
| Add resource limits | Large or malicious repos can exhaust memory/time. | Oversized/binary/deep/high-count files are skipped with coverage reason. |
| Add git diff input | Manual `--changed` is MVP-only. | `--base`, `--head`, rename/delete/untracked/binary cases are covered. |
| Add workspace catalog schema | Enterprise systems can span multiple repos. | `workspaces` and `workspace_repos` group repo-local indexes without requiring a central server. |
| Add contract entity baseline | API/gRPC/event contracts must be first-class impact targets. | OpenAPI/protobuf/GraphQL/AsyncAPI files create `contract`, `endpoint`, and `event` entities. |

## P1: Mixed Repo Adapter Pack

| Item | Why | Exit Criteria |
|---|---|---|
| TypeScript semantic adapter | Regex extraction misses too many real edges. | Compiler API handles exports, re-exports, path aliases, source spans. |
| Python/Go/Rust adapters | Core language coverage must move beyond TS/JS. | Package/module/symbol/import/reference relations are indexed. |
| Package/workspace adapter | Test and package actions require workspace context. | npm/pnpm/yarn/bun workspaces and scripts are indexed. |
| Build-system adapter | Non-JS repos depend on build metadata for impact and test selection. | npm, pip, cargo, Maven, Gradle, dotnet, CMake, Make, and Bazel targets are modeled. |
| Shell/Make adapter | Enterprise repos rely on scripts for build/test/deploy. | Commands, targets, generated artifacts become entities/relations. |
| YAML/JSON/TOML adapter | Config files often control runtime behavior. | Referenced paths/resources/config keys become relations. |
| CI adapter | Tests and deploys often live in workflow files. | Workflow/job/step entities and verify/deploy actions exist. |
| Docker/Kubernetes/Terraform adapter | Infra changes are side effects too. | Resource/configure/deploy relations are indexed. |
| OpenAPI/protobuf/GraphQL/AsyncAPI adapter | Services are often connected by contracts, not imports. | Provider handlers, clients, schemas, topics, and compatibility evidence are indexed. |
| Cross-repo resolver | Provider changes can break consumers in another repo. | API/gRPC/event producer changes surface downstream consumer repos and tests. |
| Markdown/CODEOWNERS/policy adapter | Docs and ownership affect required review. | docs/owner/policy relations and review actions exist. |
| Graph export | Humans need to inspect the same relationship paths agents use. | Mermaid, DOT, and JSON graph exports are deterministic and redacted. |
| Recursive traversal | Direct one-hop lookup under-reports impact. | Bounded traversal, cycle detection, fan-out warning. |

## P2: Enterprise Language Adapter Pack

| Item | Why | Exit Criteria |
|---|---|---|
| Java/Kotlin adapter | JVM services are common in enterprise backends. | Maven/Gradle modules, packages, classes, methods, annotations, and tests are indexed. |
| C#/.NET adapter | .NET projects need solution/project-level impact. | Solution/project references, namespaces, classes, methods, properties, and NuGet relations are indexed. |
| C/C++ adapter | Native code impact depends on includes and build targets. | Headers, translation units, functions, macros, CMake/Make/Bazel targets are indexed. |
| LSP/CodeQL enrichment | Deep reference/call/data-flow evidence should improve high-risk reports. | Supported languages add reference/call/data-flow evidence with provenance. |

## P3: Agent-Ready MCP And Release

| Item | Why | Exit Criteria |
|---|---|---|
| MCP resources | Large reports should not be one JSON text blob. | `impact://report`, `impact://evidence`, `impact://entity`, `impact://coverage`, `impact://workspace`, `impact://contract`, `impact://graph`. |
| Compact MCP tool response | Agents need summaries first, details on demand. | Tool returns summary and resource URIs. |
| Workspace diff tool | Agents need downstream impact across connected repos. | Tool summarizes changed entities and consumer risk across allowlisted workspace repos. |
| Action provider framework | npm-only action generation is too narrow. | CI/job/docs/owner review actions are supported. |
| Typed errors | Users and agents need problem, cause, fix. | CLI/MCP errors use stable envelope. |
| Open-source release automation | External contributors need predictable package flow. | CI, npm publish workflow, changelog/release notes. |
| Example repos | Docs need copy-paste realistic workflows. | mixed-language and CI/infra examples exist. |

## Deferred Scope

| Item | Reason Deferred | Revisit Trigger |
|---|---|---|
| Visual web graph explorer | MVP value is agent-readable evidence packets and CLI/MCP output. | Reports are trusted on 5+ real repos. |
| Always-on graph database core | Graph DB is optional; SQLite keeps install and migration simple. | Recursive graph queries exceed SQLite/projection ergonomics. |
| Full CodeQL query authoring | Powerful but heavy for first-run setup. | Entity graph and semantic adapters are stable. |
| IDE extension | MCP/CLI covers Claude Code and Codex first. | Repeated workflows need inline editor affordances. |
| Remote team server | Local-first avoids source and secret risk early. | Multiple developers need shared cached analysis. |
| Obsidian write sync | Write surfaces need stronger capability model first. | Read-only MCP and Markdown reports are stable. |
