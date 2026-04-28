# Impact Trace Test Plan

Generated: 2026-04-28

Korean version: [impact-trace-test-plan.ko.md](impact-trace-test-plan.ko.md)

## Goal

The test plan verifies that Impact Trace produces safe, evidence-backed impact
analysis instead of plausible reports. A repository with multiple languages, shell
scripts, YAML, CI, infrastructure, and policy files is the default test shape.

## Test Pyramid

```text
unit
  -> path/security/redaction/schema/adapter parser
integration
  -> fixture repo indexing and analysis
contract
  -> CLI JSON, MCP tool/resource, report schema
accuracy
  -> golden diff recall/precision
security
  -> secret leak, path escape, read-only mutation, resource limit
```

## Unit Tests

| Area | Required Tests |
|---|---|
| Path safety | Outside-root path, absolute path, symlink escape, internal symlink policy |
| TOCTOU | Reads and writes fail safely when files/directories are swapped after validation. |
| Redaction | OpenAI/GitHub/Slack/AWS/JWT/Bearer/PEM/env/Kubernetes Secret/Terraform vars |
| Resource limits | Oversized file, binary file, deep tree, high file count, timeout |
| Migration runner | Schema version, failed migration, compatibility check |
| Entity IDs | Deterministic IDs for identical inputs |
| Relation model | Source/target entity, kind, confidence, adapter run, evidence link |
| Adapter coverage | Unsupported language/system, skipped reason, parse error |
| Git diff parser | Rename, delete, untracked, binary, changed ranges, merge-base |
| Action rendering | `command` and `args` are structured; `display` is non-authoritative. |

## Integration Fixture Matrix

| Fixture | Files Included | What It Proves |
|---|---|---|
| TS semantic | TS/JS, `tsconfig`, path alias, re-export | Symbol/import/reference/call relations |
| Mixed language | TS, Python, shell, YAML, Markdown | Coverage and relation merging across adapters |
| CI workflow | GitHub Actions, package scripts, shell step | Workflow/job/step/test action relations |
| Infra | Dockerfile, Compose, Kubernetes YAML, Terraform | Configures/deploys/resource relations |
| API contract | OpenAPI, GraphQL, route handler | Endpoint to implementation links |
| Policy | CODEOWNERS, OPA/Rego, permission config | owns/governs/requires-review relations |
| Monorepo | npm/pnpm/yarn/bun workspace | Package boundaries and package-level actions |
| Secret fixture | env files, K8s Secret, token-like text, PEM | Zero raw leaks in SQLite/MCP/Markdown |
| Snapshot fixture | Analyze/MCP read during indexing | Only completed indexes are read |
| Delete/rename fixture | Deleted, renamed, generated, binary file | Stale edge and deleted target handling |

## Contract Tests

| Surface | Verification |
|---|---|
| CLI human output | Short summary, affected count, report path |
| CLI JSON | `reportVersion`, `schemaVersion`, `repo`, `diff`, `changed`, `affected`, `actions`, `evidence`, `coverage` |
| Exit codes | `0` clean, `1` findings/risk, `2` user/config error, `3` internal error |
| MCP tools | Read-only annotation, compact response, deterministic errors |
| MCP resources | `impact://report/{id}`, `impact://evidence/{id}`, pagination, not found error |
| Report compatibility | Deprecated and new fields coexist during migrations |

## Security Tests

| Risk | Test |
|---|---|
| Path traversal | `../`, absolute path, encoded path, symlink path |
| TOCTOU | Symlink swap after validation, `.impact-trace` swap, report directory swap |
| Secret leakage | Inspect SQLite tables, Markdown reports, and MCP responses |
| Resource exhaustion | Exceed file size/count/depth/time limits and expect coverage skip |
| Read-only MCP | Uninitialized repo creates no workspace; initialized repo creates no reports/sidecars |
| Command execution | Actions are not executed and cannot become executable without an allowlisted runner |
| Prompt injection | Repo content is quoted as evidence, never followed as instructions |

## Accuracy Gates

| Metric | v1 Gate |
|---|---:|
| Affected-entity recall | >= 90% |
| Critical false negative | 0 |
| Test action precision | >= 70% |
| Stale-index detection | 100% on fixtures |
| Secret leak | 0 |
| Unsupported coverage reporting | 100% on fixtures |
| MCP read-only mutation | 0 |

## E2E Scenarios

1. Run `impact-trace init` in a mixed-language fixture.
2. `impact-trace index` stores entities, relations, evidence, and coverage.
3. `impact-trace analyze --base main --head feature --json` returns changed and affected entities.
4. An MCP client reads the same report through compact responses and resource URIs.
5. The report includes missing adapters, skipped files, and confidence labels.
6. The security fixture leaks no raw secret to SQLite, Markdown, or MCP.

## Regression Rule

Impact traversal bugs require a fixture diff before the fix. Security boundary bugs
require a failing security test before the fix. Adapter accuracy bugs require expected
relation output in a golden fixture.

## Verification Commands

```bash
npm test
npm run lint
npm run check
npm run test:fixtures
npm run test:security
npm run test:mcp
npm run test:benchmark
npm run test:install-smoke
npm audit --audit-level=high
npm run docs:lint
```
