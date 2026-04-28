# Impact Trace Indexing Model

Korean version: [indexing-model.ko.md](indexing-model.ko.md)

## Goal

Impact Trace indexes the moving parts of an enterprise codebase and connects them
to each other. It is not only a file dependency tool. The intended model covers
functions, variables, classes, modules, tests, docs, policies, config, and
deployment resources as impactable units.

A graph database is optional. SQLite is the canonical store today. If graph
queries become valuable enough, a graph database should be a projection adapter
over the canonical entity/relation data.

## Core Concepts

| Concept | Meaning | Examples |
|---|---|---|
| Entity | Something that can change or be affected | file, symbol, module, test, doc, config, policy |
| Relation | A link between entities | depends-on, calls, verifies, documents, configures, generates |
| Evidence | Why a relation or finding is trusted | source snippet, import edge, test import, doc mention |
| Action | Verification or review to perform after a change | test command, policy review, owner review |
| Adapter | Extracts entities and relations from a language or system | TypeScript, Python, Go, Terraform, Kubernetes, OpenAPI |

## Current MVP

The built-in adapter currently focuses on TS/JS/Markdown.

| Target | Current State |
|---|---|
| TypeScript/JavaScript file | Indexed |
| TS/JS export symbol | Extracted with MVP regex logic |
| TS/JS import relation | Extracted from relative imports |
| Test relation | Inferred from imports and names |
| Markdown doc relation | Inferred from file-name mentions |
| Policy/config relation | Adapter not implemented yet |

The public report model is already intentionally language-neutral:

- `changed`: changed `EntityRef` values
- `affected`: impacted `ImpactTarget` values
- `actions`: structured `ImpactAction` recommendations
- `evidence`: relation and decision evidence
- `testCommands`: deprecated compatibility alias for older callers

## Enterprise Expansion

The same model can support broader codebase components through adapters.

| Adapter | Entity | Relation |
|---|---|---|
| Tree-sitter | file, symbol, module | depends-on, calls, declares |
| LSP | symbol, module | references, definition, call hierarchy |
| CodeQL | symbol, data-flow node | calls, taints, controls |
| Terraform | resource, module, variable | configures, depends-on |
| Kubernetes | deployment, service, configmap, secret ref | configures, routes-to |
| OpenAPI/GraphQL | endpoint, schema field, resolver | implements, consumes |
| CI/CD | job, workflow, artifact | verifies, deploys, generates |
| Policy-as-code | rule, package, control | governs, denies, requires-review |

## Analysis Flow

```text
changed input
  -> normalize to EntityRef
  -> select latest completed index_run_id
  -> reverse relation traversal
  -> compute affected targets
  -> collect and redact evidence
  -> recommend structured actions
  -> return CLI/MCP/Markdown report
```

## Design Principles

- Findings carry evidence and confidence.
- Unknowns are surfaced as `unknown` or coverage gaps.
- MCP is read-only in the MVP and does not execute commands.
- Command recommendations prefer structured `command` and `args`, not shell strings.
- Language-specific behavior stays inside adapters while the report model remains language-neutral.

