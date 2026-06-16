# Parallax Extensibility, Security Gate, and Docs Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Parallax safer to ship, easier to extend, and documented from
the packaged `docs/` surface instead of hidden skill-only references.

**Architecture:** Keep runtime behavior conservative. First close verification
and security drift, then improve small API-boundary correctness, then move
architecture/operations knowledge into trilingual packaged docs.

**Tech Stack:** TypeScript, Node.js 24, node:test, SQLite, MCP stdio, Markdown
docs with trilingual parity enforced by `scripts/docs-lint.js`.

---

> Initiative: derived from a three-track read-only audit on 2026-06-16.
> Baseline at start: `npm run check` passed, `npm run docs:lint` passed,
> `npm audit --audit-level=high` failed with vulnerable `esbuild`, `hono`,
> and `protobufjs` transitive/direct packages.

## Theme

The current codebase is already a working local-first impact graph. The next
practical risk is **drift at the boundaries**: dependency audit is not enforced
in CI, the documented release smoke test is not in CI, CLI numeric flags accept
partial junk values, package-visible docs link to unpackaged `skills/` files,
and the architecture/operations path is not first-class under `docs/`.

## Guardrails (apply to every task)

- **Invariants** (`docs/invariants.md` I-1..I-10) must hold: local-first single
  SQLite, no daemon, fetch-only, read-only agent surface first, ADD-only
  migration, evidence-first.
- **Avoid behavior changes** in `src/adapters/multi-language-regex.ts`
  (actively developed, strict version-bump rhythm). The completed adapter
  extension added only the `selectionMode = 'catch-all'` metadata needed for
  registry enforcement; do not reach into the regex adapter's internals for
  shared behavior.
- **Dogfood bar** for any engine-touching change (indexer/adapters/analyzer/
  store/graph/cross_repo): `npm run build && node dist/src/cli.js index` on
  Parallax itself, then assert `relations` DEPENDS_ON into `src/%`
  (non-external, proven) is non-zero and a widely-imported module
  (`src/store.ts`) shows proven dependents. Green unit tests are NOT sufficient.
- **Behavior-preserving only** for autonomous code edits: consolidate
  byte-identical copies; do NOT silently reconcile already-drifted behavior
  (flag those as follow-ups instead).
- Every task ends with the narrow relevant test, then the final pass runs the
  canonical `npm run verify` gate.

## Done criterion (satisfies the goal)

1. `npm audit --audit-level=high` passes locally and CI runs it.
2. CI also runs `npm run test:install-smoke` after build.
3. CLI integer flags reject malformed values such as `2abc`, with tests.
4. Packaged docs no longer depend on unpackaged skill architecture links.
5. New trilingual packaged docs exist and are linked:
   `docs/architecture.md`, `docs/operations.md`, and
   `docs/release-checklist.md` plus `.ko.md` and `.zh.md` variants.
6. `docs/value-proposition*.md` no longer claims stale implementation status,
   stale passing-test counts, or stale dependency counts.
7. Final verification passes through the canonical `npm run verify` gate.

## Tasks (ordered for safety — verification spine first)

### T1 — Dependency audit and CI release gates
**Files:**
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`
- Verify: `package.json`

- [x] Run `npm audit fix`.
- [x] Confirm `npm audit --audit-level=high` passes.
- [x] Add `npm audit --audit-level=high` to CI after `npm ci`.
- [x] Add `npm run test:install-smoke` to CI after `npm run build`.
- [x] Verify with `npm audit --audit-level=high` and `npm run test:install-smoke`.

### T2 — Strict CLI integer parsing
**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/parallax.test.ts`

- [x] Add tests that spawn the CLI and assert malformed integer flags fail:
  `analyze --changed src/a.ts --depth 2abc`, `ui --port 3717x`, and
  `profile --entity src/a.ts --k 10x`.
- [x] Replace generic `parseIntegerArg` with exact non-negative integer parsing
  that rejects trailing characters.
- [x] Preserve the stricter `gc-branches --max-age` behavior.
- [x] Verify with the targeted tests and `npm run check`.

### T3 — Packaged architecture, operations, and release docs
**Files:**
- Create: `docs/architecture.md`
- Create: `docs/architecture.ko.md`
- Create: `docs/architecture.zh.md`
- Create: `docs/operations.md`
- Create: `docs/operations.ko.md`
- Create: `docs/operations.zh.md`
- Create: `docs/release-checklist.md`
- Create: `docs/release-checklist.ko.md`
- Create: `docs/release-checklist.zh.md`
- Modify: `docs/README.md`
- Modify: `docs/README.ko.md`
- Modify: `docs/README.zh.md`

- [x] Move the architecture deep-dive entry to packaged `docs/architecture*.md`.
- [x] Cover CLI -> indexer -> adapters -> SQLite -> analyzer -> MCP/UI.
- [x] Add operator runbook coverage for stale index, missing DB, MCP setup,
  Node 24 warnings, workspace catalog problems, and CI failures.
- [x] Add release checklist with lint, tests, dogfood, bench, install smoke,
  and audit.
- [x] Verify `npm run docs:lint`.

### T4 — Stale public docs cleanup
**Files:**
- Modify: `README.md`
- Modify: `README.ko.md`
- Modify: `README.zh.md`
- Modify: `docs/value-proposition.md`
- Modify: `docs/value-proposition.ko.md`
- Modify: `docs/value-proposition.zh.md`

- [x] Align README MCP safety wording with `docs/mcp.md`: source tree stays
  read-only, but analysis/search tools may persist context-pack/telemetry rows.
- [x] Update value proposition status so workspace and contract commands are
  described as active v0 features, not schema-only future work.
- [x] Remove stale exact test-count and dependency-count claims or replace them
  with commands/read locations that do not drift.
- [x] Verify `npm run docs:lint`.

### T5 — Final verification and review
**Files:**
- Review all changed files.

- [x] Run `npm run lint`.
- [x] Run `npm test`.
- [x] Run `npm run test:dogfood`.
- [x] Run `npm run bench`.
- [x] Run `npm run test:install-smoke`.
- [x] Run `npm audit --audit-level=high`.
- [x] Dispatch final reviewer subagent over the whole diff and fix any Critical
  or Important findings.

## Completed Extensions

Beyond the original T1-T5 scope, the completed cleanup also landed these
hardening extensions:

- Adapter registry extensibility contract and manifest tests.
- Docs lint coverage for tracked and untracked Markdown, trilingual parity,
  local Markdown links, and representative secret-like content parity with
  runtime redaction.
- Structured 400 errors for invalid pagination in UI graph JSON.
- Package surface narrowed to `dist/src`, with metadata tests asserting the
  public package surface.
- MCP docs drift guard that parses English, Korean, and Chinese MCP tool tables
  and compares tool names and read-only values against live `tools/list`.
- Public README and MCP docs no longer hard-code MCP tool counts or read-only
  lists.

## Final Verification Result

After the MCP/docs cleanup, `npm run verify` passed as the canonical final gate.
That successful run included lint, install smoke/build, the main test suite
(470 tests in that run), dogfood, bench, and high-level npm audit with 0
vulnerabilities.

## Explicitly OUT of scope (documented follow-ups, not done autonomously)
- Splitting `ui.ts` / `mcp.ts` large files (mechanical but large; behavior-
  risk; better as a human-reviewed slice).
- Reconciling already-drifted path->kind classification (analyzer vs indexer)
  — a real behavior change; needs a human decision, not a silent autonomous fix.
- Incremental indexing by content hash — DOGFOOD-SENSITIVE; defer until the
  dogfood guard (T1) has proven itself in CI.
- `knip`/dead-export linter — good follow-up; not required for this initiative.
