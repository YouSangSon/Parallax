# Roadmap

**English** · [한국어](roadmap.ko.md) · [中文](roadmap.zh.md)

> Organize upcoming work thematically. Progress tracking stays at the git log and PR level.

This document records only the *direction we can move on without friction right now*. Big decisions are made without breaking [invariants.md](invariants.md).

---

## 1. Accuracy

The biggest gap right now is that there is no way for a person to know *when* regex/declaration-line based evidence is wrong.

- [ ] Full symbol/call span based on TS/JS Tree-sitter or the TypeScript parser
  - Progress (parser-backed via the TypeScript compiler):
    - Imports, declarations, and class/interface heritage type relations across the same-file / named-import / direct-named-re-export / star-re-export / namespace-re-export / default-import / direct-default-re-export / namespace-import matrix
    - Call dispatch: imported call-sites, local identifier calls, method-reference alias calls, same-class `this.method()`, same-file `super.method()`, same-file class-extends inherited instance/static methods, and static `ClassName.method()`
    - Factory return-type instance method calls across the same-file / direct-new-or-const-alias-inferred / namespace-constructor-inferred / factory-wrapper-inferred / direct-factory-call-receiver / named-import / direct-named-re-export / star-re-export / namespace-import / namespace-re-export / default-import / direct-default-re-export / awaited matrix
    - Interface/type-literal method, function-property, and function-type-alias signatures, plus interface/type-literal typed receiver method calls across the same-file / named-import / direct-named-re-export / star-re-export / namespace-re-export / default-import / direct-default-re-export / namespace-import matrix
    - Type-relation receivers: interface-extends, alias-backed interface-extends, type-reference alias, simple-generic and generic-constraint references, intersection (alias and direct), and simple-union typed receivers
    - Collections: local/class-scoped array, `Array<T>`, `ReadonlyArray<T>`, `readonly T[]`, numeric tuple element, indexed collection alias, direct collection-binding alias, explicitly typed array/tuple destructuring, and destructuring from typed local collection bindings
    - Object bindings: typed local object property receivers, direct object-binding aliases, and destructuring from typed local object bindings
    - Members & instances: declared typed local/class-field receivers, typed local variables, typed/destructured/named-object parameters, assertion-wrapped/non-null/parenthesized receivers, string-literal element access, private members, constructor parameter-property and constructor-assigned fields, object-literal callable declarations and receivers, class-field arrow methods (instance and static), typed and plain class fields, same-file `new ClassName()` instances, and direct `new ClassName().method()` calls
  - Remaining: wider dynamic dispatch and advanced type relations
- [ ] Promote JVM/Spring Boot endpoint/DI/persistence relations to a parser-based approach
- [ ] Extend Python/Go/Rust call/import resolution from declaration-only to parser-backed
- [x] State the confidence label and known-gap in the report for each adapter run
- [x] Resolve NodeNext/ESM `.js` extension local imports to the TypeScript source (`.ts`) — fixed the issue where the internal import dependency graph was entirely falling through to `external_entity`
- [x] Sort the impact report's `affected` by confidence (proven > inferred > heuristic) → depth → path — fixed the issue where proven code impact was buried below heuristic document mentions (this also automatically improves the UI's first-glance target)

## 2. Workspace / Contract

Cross-repo impact is at a v0 state. It works only among the local repos the user has registered.

- [ ] Stabilize OpenAPI / GraphQL / Protobuf / AsyncAPI contract diff down to the *nested schema* level
- [ ] Take the generated-client / event topology resolver beyond heuristics
- [ ] Have the workspace catalog recognize sub-packages inside a monorepo as first-class
- [ ] Keep cross-repo links bidirectional (provider→consumer, consumer→provider) and always consistent

## 3. Package / Build resolution

The package resolver now covers manifest graphs across common ecosystems and npm lockfile transitive dependencies. Most non-npm lockfile ecosystems and semver impact are still open.

- [x] npm `package-lock.json` v2/v3 transitive dependency graph
  - Current gate: transitive package entries are indexed as lockfile-derived `DEPENDS_ON` package relations with locked versions and evidence spans.
- [ ] Extend lockfile-based transitive dependency graph to pip/poetry/go/cargo/maven/gradle lockfiles
- [ ] Infer the affected version range from semver/range information
- [ ] Standardize dumping the dependency graph without running build scripts

## 4. Agent surface

MCP has stabilized as read-only. Next is the stage of looking deeply at agent usability.

- [ ] Validate the budget tuning (brief/standard/deep) of `context_for_change` with usage telemetry
- [ ] A harness to measure the hit/miss of context pack results
- [ ] Consider introducing a write surface separated into its own permission model (compliant with [invariants.md](invariants.md) I-8)

## 5. UI Explorer

The UI right now is at the level of a first explorer that reads saved reports and graphs.

- [x] Validate a single screen for the changed → affected → evidence → action flow
- [x] Make work-artifact lanes such as policy / decision / PRD / requirement / proposal first-class panels
- [x] Jump to the original file/line in one click from an evidence resource
- [x] Expand the inspector to drill down more deeply into the relation/evidence/action of a selected impact
- [x] Comparison between saved reports and a regression delta UI
- [x] Wire the report delta's added paths directly to the source viewer and the inspector/verification action, and wire removed paths to the source viewer
- [x] Make the wider/narrower judgment criteria for the report delta configurable as team policy
- [x] Make report delta policy presets comparable in the UI
- [x] Strengthen first glance by adding a primary flow summary, direction arrows, and stage bands to the impact map
- [x] Export the policy selected in a report delta preset as a config patch
- [x] Raise the impact map to the primary surface of the first viewport so the change → impact flow is immediately visible
- [x] Display the impact map's fallback edges as displayed paths too, removing states that are misread like "0 graph links"
- [x] Align the impact summary to the displayed path basis as well, removing the terminology mismatch between the summary and the map
- [x] Add a changed root → affected targets → next verification triage strip on the first screen
- [x] Clicking a top affected/verification target in the triage strip connects to the inspector/evidence selection
- [x] Highlight impact map edges/labels together with the selected target to strengthen graph readability
- [x] Unify the initial primary flow/inspector to the action-first selected target
- [x] Sync the map legend row with the selected target too, and show the selected state starting from server rendering
- [x] Add an Analysis Trust summary to the Impact Summary that bundles coverage, adapter confidence, and known gap
- [x] Keep the workbench language switcher honest by localizing client-updated map, inspector, copy, source, and empty-state labels
- [x] Preserve selected report and language query state together across language and report navigation
- [x] Add a selected-impact verdict card that combines lane, confidence, evidence count, and verification readiness

## 6. Retrospective and measurement

Without regression signals, there is no guarantee that every change works.

- [x] A deterministic bench harness based on multi-language fixtures
  - Current gate: `bench/impact-bench.ts` builds a fixed TypeScript/JavaScript, JVM/Spring Boot, Python, Go, Rust, OpenAPI, and build-manifest fixture; scores relation recall/precision, affected-file recall, evidence/span coverage, adapter attribution, context-pack readiness, and retrieval quality; and is run by `npm run bench`, `npm test`, and the CI `npm run verify` gate.
- [x] Recall quality regression detection when crossing embedding models / LLM providers
  - Current gate: the deterministic bench now includes a semantic model matrix with per-model recall@1 and cross-model isolation checks. It is deliberately offline and catches embedding model namespace regressions without depending on live provider calls; LLM provider network quality remains outside CI, while provider contracts stay covered by offline tests.
- [x] Automatically report the bench delta on every PR in CI
  - Current gate: CI prepares a base-SHA bench report for pull requests, runs the canonical `npm run verify` gate on the head, then appends `npm run bench:report` Markdown to the GitHub Step Summary with score, relation, affected-file, retrieval, and semantic recall deltas.

---

## If we had to pick just the next slice

On top of the fixtures already present in `tests/` and `bench/`, closing the first item of **Accuracy (1)** — *parser-backed TS/JS span* — has the highest ROI. Every other axis depends on the precision of the evidence span.
