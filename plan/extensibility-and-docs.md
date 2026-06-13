# Plan — Drift-proof correctness & complete docs

> Initiative: improvements beyond the current roadmap that make Parallax more
> extensible, more verifiably correct, and fully documented. Derived from a
> three-track read-only audit (code-health, docs, verification) on
> 2026-06-13. Baseline at start: build clean, 457 tests pass.

## Theme

Every audit track surfaced the same root problem: **drift**. The same logic is
re-encoded across engine files (and has already diverged); the README's MCP/CLI
docs describe names and flags that no longer exist in code; the one real graph
regression that already happened has no automated guard; there is no CI. This
plan stops the drift (collapse duplicate sources of truth) and *enforces*
non-drift (dogfood guard, CI, parity lint), then completes the documentation.

## Guardrails (apply to every task)

- **Invariants** (`docs/invariants.md` I-1..I-10) must hold: local-first single
  SQLite, no daemon, fetch-only, read-only agent surface first, ADD-only
  migration, evidence-first.
- **Do NOT touch** `src/adapters/multi-language-regex.ts` (actively developed,
  strict version-bump rhythm). Shared modules import *from* a new file; never
  reach into the regex adapter's internals.
- **Dogfood bar** for any engine-touching change (indexer/adapters/analyzer/
  store/graph/cross_repo): `npm run build && node dist/src/cli.js index` on
  Parallax itself, then assert `relations` DEPENDS_ON into `src/%`
  (non-external, proven) is non-zero and a widely-imported module
  (`src/store.ts`) shows proven dependents. Green unit tests are NOT sufficient.
- **Behavior-preserving only** for autonomous code edits: consolidate
  byte-identical copies; do NOT silently reconcile already-drifted behavior
  (flag those as follow-ups instead).
- Every task ends: `npm run build` clean, `npm test` >= 457 pass (+ new tests),
  `npm run docs:lint` green.

## Done criterion (satisfies the goal)

1. `npm run build` clean; `npm test` >= 457 pass plus the new dogfood test.
2. `npm run bench` passes, including a NodeNext `.js` importer fixture.
3. `npm run docs:lint` passes NEW checks: trilingual parity + switcher presence
   + same-language internal links.
4. A CI workflow runs lint + test + bench + dogfood.
5. Zero code<->doc drift on the audited items (MCP table, CLI flags, tool count,
   schema-version table, secret-family count).
6. New trilingual docs exist and are linked: `docs/mcp.md`,
   `docs/cli-reference.md`, `docs/extending-adapters.md`, `docs/README.md`
   (index), plus root `CHANGELOG.md`.
7. Full dogfood (build + self-index + impact.db assertions) green.

## Tasks (ordered for safety — verification spine first)

### T1 — Dogfood guard test + bench `.js` fixture  [engine-output / not engine-mutating]
Create `tests/dogfood.test.ts` that builds is NOT needed (tests run via tsx),
but at runtime: `init` + `index` Parallax-on-itself into a temp/working copy,
then assert via the real `analyzeDiff` path AND raw read-only SQL on
`relations`+`entities` (NOT `edges`/`IMPORTS`). Use FLOORS not exact counts:
- proven dependents of `src/store.ts` >= 5 (measured 16 / 30 via analyze).
- COUNT(relations DEPENDS_ON, target.path LIKE 'src/%', target.kind !=
  'external_entity') > 0 (measured 186).
Add `test:dogfood` script. Also add ONE `.js`-suffixed importer to
`bench/impact-bench.ts` session fixtures (the only blind spot) + its expected
`DEPENDS_ON` label, so the bench also catches the `.js`-strip regression class.
Verify: `npm run test:dogfood` green; `npm run bench` green.

### T2 — CI workflow  [no engine]
`.github/workflows/ci.yml`: on push/PR, Node 24, `npm ci`, `npm run lint`,
`npm test`, `npm run test:dogfood`, `npm run bench`. (bench/dogfood already set
non-zero exit on failure.)
Verify: workflow YAML valid; commands match package.json scripts.

### T3 — Shared `src/confidence.ts` + adapter-registry safety net  [engine-touching -> DOGFOOD]
(a) Extract the byte-identical `asConfidence()` + `confidenceRank()` into
`src/confidence.ts`; replace the identical copies in analyzer.ts, graph.ts,
mcp.ts (and ui.ts server-side; leave the browser-inline JS copy). Behavior
preserving by construction.
(b) Adapter seam: add a doc comment on `createDefaultRegistry` +
`MultiLanguageRegexAdapter.supports` documenting the "catch-all registered last"
contract; add a test asserting `registry.list().at(-1)` is the catch-all and a
`.ts` ScannedFile picks the TS adapter.
Verify: `npm run check`; `npm test`; DOGFOOD (report confidence fields + self
index DEPENDS_ON unchanged).

### T4 — Fix code<->doc drift (en/ko/zh)  [docs only]
- README MCP tool table: replace the 7 legacy names with the real 18
  `parallax_*` tools; move graph export to a "resources" note (it is the
  `parallax_graphs` resource, not a tool). All three languages.
- README `remember --confidence 0.9`: the flag does not exist -> remove it (and
  align "supersedes" wording to `--supersedes-fact-ids`). All three languages.
- `skills/parallax/SKILL.md` "(15)" -> "(18)" + add the 3 missing rows
  (`parallax_contract_diff`, `parallax_context_telemetry`, `parallax_doctor`).
  All three languages.
- `skills/parallax/references/architecture.md`: schema table add v8-v15;
  "11 secret families" -> "12". All three languages.
- Add `architecture.md` to the README Read-more table. All three languages.
Verify: spot-check each cited name/flag against src; `npm run docs:lint`.

### T5 — Drift-proof docs tooling + fix existing doc-convention gaps  [tooling + docs]
Extend `scripts/docs-lint.js` to additionally enforce, for tracked docs under
README/CONTRIBUTING/SECURITY/docs/skills:
- trilingual parity (X.md <-> X.ko.md <-> X.zh.md all present),
- language switcher header present on every localized conceptual doc,
- internal links in a `.ko.md`/`.zh.md` point to same-language targets.
Then FIX the violations the new lint surfaces: add switcher headers to the 27
localized docs; repair the localized Read-more / cross-doc links that leak to
English (README.zh/ko, docs/vision.*, docs/roadmap.*, value-proposition.*).
Verify: `npm run docs:lint` green after fixes; deliberately break one to prove
the check fails, then restore.

### T6 — New trilingual docs (completion)  [docs only]
- `docs/mcp.md` (+ko/zh): authoritative table of all 18 tools + 9 resources,
  read-only/destructive hints, derived from `src/mcp.ts`.
- `docs/cli-reference.md` (+ko/zh): every command + flags + exit codes
  (analyze exits 1 on impact), JSON shapes; from `src/cli.ts` `printHelp`.
- `docs/extending-adapters.md` (+ko/zh): how to author a `SemanticAdapter`
  (`src/adapters/types.ts`), register it, capabilities, confidence/knownGaps,
  the catch-all-last contract; the literal "more extensible" guide.
- `CHANGELOG.md` (root, Keep a Changelog) seeded from git history.
- `docs/README.md` (+ko/zh): docs index / table of contents.
- Wire new docs into README Read-more + docs index, all languages.
Verify: `npm run docs:lint` green (parity + links); links resolve.

### T7 — Final review + finishing  [no code]
Full-suite + dogfood + bench + docs:lint; final code review subagent over the
whole diff; then finishing-a-development-branch.

## Explicitly OUT of scope (documented follow-ups, not done autonomously)
- Splitting `ui.ts` / `mcp.ts` monster files (mechanical but large; behavior-
  risk; better as a human-reviewed slice).
- Reconciling already-drifted path->kind classification (analyzer vs indexer)
  — a real behavior change; needs a human decision, not a silent autonomous fix.
- Incremental indexing by content hash — DOGFOOD-SENSITIVE; defer until the
  dogfood guard (T1) has proven itself in CI.
- `knip`/dead-export linter — good follow-up; not required for this initiative.
