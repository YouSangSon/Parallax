# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Dogfood guard test that runs Parallax against its own internal dependency graph, plus a NodeNext `.js`-extension benchmark fixture.
- CI workflow running lint, build, test, dogfood, and benchmark on push and pull request.
- Shared `src/confidence.ts` module with a single `asConfidence` guard, and an adapter-registry safety net that documents and asserts the catch-all adapter stays registered last.
- MCP, CLI, and adapter-authoring reference docs, plus a `docs/` index, in English, Korean, and Chinese.

### Changed

- Corrected MCP / CLI / SKILL / schema documentation drift so docs match the source (tool tables, command and flag names, tool counts).
- Hardened `docs-lint` to enforce trilingual parity, language-switcher headers, and same-language internal links, and to ignore fenced code examples while still scanning them for secrets.
- Extracted the static CSS and client JavaScript out of `src/ui.ts` into dedicated `src/ui/styles.ts` and `src/ui/client.ts` modules (rendered HTML byte-for-byte unchanged), reducing `ui.ts` from ~5090 to ~3056 lines.

### Fixed

- Removed a nonexistent `--confidence` flag and other code-to-doc drift from the documentation set.
- Made the impact-graph builder's node upgrade immutable: `upsertRowNode` now rebuilds nodes instead of mutating them in place.

## Earlier milestones

Seeded from the project history:

- **Impact accuracy** — rank impact by confidence before path; resolve NodeNext `.js`-extension local imports to TypeScript source; resolve array-element typed, awaited-factory, and optional-chaining receiver calls.
- **Internationalization** — trilingual README and docs (English canonical, Korean, Chinese) and a runtime language switcher in the UI.
- **UI explorer** — first-glance impact triage, ranked impact route cards, selectable impact map with labeled nodes, and surfaced analysis trust and verification.
