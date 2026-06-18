# Roadmap

**English** · [한국어](roadmap.ko.md) · [中文](roadmap.zh.md)

> Organize upcoming work thematically. Progress tracking stays at the git log and PR level.

This document records only the *direction we can move on without friction right now*. Big decisions are made without breaking [invariants.md](invariants.md).

---

## 1. Accuracy

The biggest gap right now is that there is no way for a person to know *when* regex/declaration-line based evidence is wrong.

- [ ] Full symbol/call span based on TS/JS Tree-sitter or the TypeScript parser
  - Progress: TypeScript parser based import, declaration, same-file/named-imported/direct-named-re-exported/star-re-exported/namespace-re-exported/default-imported/direct-default-re-exported/namespace-imported class/interface heritage type relation, imported call-site, local identifier call, method-reference alias call, same-class `this.method()`, same-file class `super.method()`, same-file class extends inherited instance/static method, static `ClassName.method()`, same-file/direct-new-or-const-alias-inferred/namespace-constructor-inferred/factory-wrapper-inferred/direct-factory-call-receiver/named-imported/direct-named-re-exported/star-re-exported/namespace-imported/namespace-re-exported/default-imported/direct-default-re-exported/awaited factory return type instance method call, interface/type-literal method/function-property/function-type-alias signature, same-file/named-imported/direct-named-re-exported/star-re-exported/namespace-re-exported/default-imported/direct-default-re-exported/namespace-imported interface/type-literal typed receiver method call, same-file interface extends typed receiver method call, same-file alias-backed interface extends typed receiver method call, same-file type reference alias typed receiver method call, same-file simple generic type reference typed receiver method call, same-file generic constraint typed receiver method call, same-file intersection type alias typed receiver method call, direct intersection typed receiver method call, same-file simple union typed receiver method call, array/`Array<T>`/`ReadonlyArray<T>` element typed receiver method call, declared typed local/class field receiver method call, typed local variable instance method call, typed/destructured/named-object parameter instance method call, assertion-wrapped/non-null/parenthesized typed receiver method call, string-literal element access method call, private member receiver method call, constructor parameter property instance method call, constructor assignment instance method call, object literal method/property callable declaration and receiver method call, class field arrow method caller/target, static class field arrow method call, typed class field instance method call, class field instance method call, same-file `new ClassName()` instance call, and direct `new ClassName().method()` call spans have landed. Wider dynamic dispatch and advanced type relations remain.
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

The package resolver has started to use npm lockfiles, but most lockfile ecosystems and semver impact are still open.

- [ ] Lockfile-based transitive dependency graph (npm/pip/poetry/go/cargo/maven/gradle)
  - Progress: npm `package-lock.json` v2/v3 transitive package entries are indexed as lockfile-derived `DEPENDS_ON` package relations with locked versions and evidence spans.
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
