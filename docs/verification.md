# Parallax — Verification & Testing

**English** · [한국어](verification.ko.md) · [中文](verification.zh.md)

Parallax verifies correctness in layers: a fast unit suite, a typecheck, a docs linter, a deterministic accuracy bench, and a dogfood guard that re-indexes Parallax against itself. CI runs all of them on every push and pull request. This guide explains each layer, what it catches, and when to run it — with the key lesson that green unit tests are necessary but **not** sufficient for engine changes.

## Scripts at a glance

Every command below is an `npm run` script defined in `package.json`.

| Command | What it does | When to run |
| :--- | :--- | :--- |
| `npm test` | Runs the Node test runner over `tests/**/*.test.ts` via `tsx --test` | After any change; the default fast suite |
| `npm run check` | `tsc --noEmit` typecheck, no output emitted | Before commit; catches type regressions |
| `npm run lint` | `check` + `docs:lint` together | Before commit / PR; the full static gate |
| `npm run docs:lint` | Runs `scripts/docs-lint.js` over tracked and untracked Markdown, including local `.md` link targets | After editing any doc |
| `npm run verify` | Runs the canonical source-checkout release gate: lint, install smoke, fast tests, dogfood, bench, and high-level audit | Before release and in CI |
| `npm run build` | `tsc -p tsconfig.json`, compiles to `dist/` | Before publishing or smoke-testing the CLI |
| `npm run bench` | Runs `bench/impact-bench.ts`; exits non-zero on accuracy regression | After engine/adapter changes |
| `npm run bench:report` | Renders the latest bench JSON as Markdown, optionally comparing it with a baseline report | After `npm run bench`, or in CI summaries |
| `npm run test:dogfood` | Indexes Parallax on its own source and asserts the internal graph survives | After engine changes (indexer/adapters/analyzer/store/graph) |
| `npm run test:mcp` | Runs `tests/mcp.test.ts` (impact / context / memory / telemetry / path validation) | After MCP surface changes |
| `npm run test:ui` | Runs `tests/ui.test.ts` (UI snapshot, server, JSON resource endpoints) | After UI changes |
| `npm run test:security` | Runs `tests/security.test.ts` (path containment + redaction) | After store / path / redaction changes |
| `npm run test:install-smoke` | `npm run build` then `node dist/src/cli.js --help` | Before release, to confirm the packaged CLI launches |

`test:fixtures` is an alias for `npm test`, and `test:benchmark` is an alias for `npm run bench`. `npm run verify` includes `npm audit --audit-level=high`, so its final audit stage depends on npm registry and network availability.

## The dogfood guard — the real safety net

`tests/dogfood.integration.ts` is the most important layer to understand. It exists because a green unit suite once coexisted with a totally broken internal dependency graph: real NodeNext `./x.js` imports collapsed to `external_entity`, so a heavily imported module reported **zero** code dependents while every unit test stayed green. The unit suite simply did not look at the real engine output the way a user does.

The dogfood guard closes that gap. For each test it:

1. Copies Parallax's own `src/` into an isolated temp repo, then runs `initProject` + `indexProject` on it — the real user path.
2. Calls `analyzeDiff` for `src/store.ts` and asserts there are at least `MIN_PROVEN_SRC_DEPENDENTS` (5) dependents under `src/` with `proven` confidence, and that the top-ranked affected file is itself a `proven` `src/` dependent (this also guards confidence-first ordering).
3. Opens the canonical store read-only and runs raw SQL over the `relations` + `entities` tables: it counts `DEPENDS_ON` edges whose target is a local `src/%` entity with `kind != 'external_entity'` (must exceed `MIN_INTERNAL_DEPENDS_ON_ROWS`, 20), and counts `proven` `src/%` dependents of `file:src/store.ts` (must reach the floor of 5).

The assertions use **floors, not exact counts**, so legitimate refactors do not break the test. The discriminator is the *collapse to ~0* the original bug produced, not any precise number. The SQL deliberately targets the canonical `relations` + `entities` tables and the `external_entity` collapse — that is exactly the failure mode it guards.

### Why it is not in `npm test`

The default suite globs `tests/**/*.test.ts`. The guard is named `tests/dogfood.integration.ts` — it does **not** match `*.test.ts`, so the glob skips it by design (it is also slow, since it re-indexes the whole source tree). `npm run test:dogfood` and CI run it by naming the file directly.

**The lesson:** a green `npm test` is necessary but not sufficient. Any change to the engine — indexer, adapters, analyzer, store, graph, or cross-repo — must be dogfood-verified, because the unit suite can stay green while the real graph is broken.

## The accuracy bench

`bench/impact-bench.ts` builds a fixed multi-language fixture (TypeScript/JavaScript, JVM/Spring Boot, Python, Go, Rust, OpenAPI contracts, and build manifests), indexes it, and scores the resulting graph against a pinned set of expected relations. It pins:

- **Relation recall and precision** — every expected relation must be matched, with no unexpected relations.
- **Affected-file recall** — `analyzeDiff` for the changed file must surface every expected dependent.
- **Evidence presence, span completeness, and adapter attribution** — relations must carry evidence/spans and be attributed to the right adapter.
- **Retrieval metrics** — `searchContextForRepo` recall/precision/MRR/nDCG within a brief context budget.
- **Semantic model recall/isolation** — deterministic int8 fixture embeddings verify that semantic recall returns the expected top fact and does not leak cross-model decoys when embedding model names change.

The runner writes a deterministic JSON report and sets a non-zero exit code when the suite does not pass. There are two surfaces:

- `tests/impact-bench.test.ts` runs the bench as part of `npm test` and asserts the report shape, the pinned expected relations, and the score/recall thresholds.
- `npm run bench` runs `bench/impact-bench.ts` directly and exits non-zero on any recall/score regression — this is the form CI uses.

Run `npm run bench` after any change that touches relation extraction, ranking, or retrieval.

`npm run bench:report` converts `.parallax/bench/impact-bench-report.json` into a compact Markdown summary. Pass `--baseline <json>` to include delta columns against a previous report, or `--github-step-summary` to append the summary to GitHub Actions' step summary. CI uses this on pull requests by generating a baseline report from the PR base SHA, then reporting the head-vs-base bench delta after `npm run verify`.

## The docs linter

`scripts/docs-lint.js` (run via `npm run docs:lint`) is a static gate over tracked Markdown plus local untracked Markdown that is not ignored. It enforces:

- **No forbidden content** — local machine paths, restore-point metadata, and runtime-redacted secret families such as API keys, service tokens, bearer/JWT credentials, database URLs with embedded credentials, and private keys. This scan runs on the raw text, including fenced code blocks.
- **Trilingual parity** — every doc in the trilingual zone (`docs/` excluding `docs/assets/`, `skills/`, and root `README`/`CONTRIBUTING`/`SECURITY`) must have all three of `X.md`, `X.ko.md`, `X.zh.md`.
- **Switcher presence** — each file must link to its other two language variants (the language switcher under the H1).
- **Same-language internal links** — inside `X.ko.md`, internal `.md` links must point to the `.ko.md` sibling (and `.zh.md` inside `X.zh.md`) whenever that same-language twin exists. The switcher line is the only allowed cross-language exception. Fenced code blocks are ignored for link checking, so markdown link *examples* in code blocks are safe.
- **Existing local Markdown targets** — non-image local `.md` links must resolve to a Markdown file in the working tree, including new untracked docs before they are staged.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request to `main`. The `verify` job, on Node.js 24, runs in order:

```bash
npm ci
npm run verify
npm run bench:report -- --github-step-summary --allow-missing --baseline .parallax/bench/impact-bench-baseline.json
```

`npm run verify` is the canonical source-checkout gate. It runs lint first, then install smoke (which owns the only build), the fast unit suite, dogfood, bench, and finally the registry-dependent audit. On pull requests, CI first prepares `.parallax/bench/impact-bench-baseline.json` from the base SHA so the final summary includes score, relation, affected-file, retrieval, and semantic recall deltas.

## How to add tests

Tests live under `tests/` and follow the **Arrange-Act-Assert** pattern: set up an isolated temp repo, run the real entry point (`initProject` / `indexProject` / `analyzeDiff` / `searchContextForRepo`), then assert on the result. Most suites create and tear down a temp directory so each test is isolated.

- **Unit and integration tests** are `tests/*.test.ts` and run under `npm test`.
- **Adapter changes** must also extend the bench fixture in `bench/impact-bench.ts` with the new expected relations, and follow the evidence/confidence discipline described in [`extending-adapters.md`](extending-adapters.md).
- **Engine changes** — anything under the indexer, adapters, analyzer, store, graph, or cross-repo layers — must be dogfood-verified with `npm run test:dogfood`, not just unit-green. If you change how relations are extracted or ranked, re-run `npm run bench` and update the pinned expectations only when the change is intended.

Before opening a PR, run the full local gate:

```bash
npm run verify
```

## See also

- [extending-adapters.md](extending-adapters.md) — adapter contract, evidence/confidence discipline, and adapter tests
- [invariants.md](invariants.md) — the evidence-first and deterministic-output invariants the bench checks
- [cli-reference.md](cli-reference.md) — the CLI surface the tests exercise
- [README.md](README.md) — the documentation index
