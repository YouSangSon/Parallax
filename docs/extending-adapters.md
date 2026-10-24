# Parallax — Extending Adapters

**English** · [한국어](extending-adapters.ko.md) · [中文](extending-adapters.zh.md)

Parallax extracts its entity/relation graph through **semantic adapters**. Each adapter owns one language or file format and turns scanned files into entities, relations, and diagnostics. This guide describes the adapter contract, how adapters are registered and selected, and the evidence/confidence discipline they must follow, with a minimal worked example.

## The adapter contract

An adapter implements the `SemanticAdapter` interface (`src/adapters/types.ts`):

- `id` — a unique, stable identifier. Registering two adapters with the same `id` throws.
- `version` — the adapter version string (see [Versioning](#versioning-and-re-extraction)).
- `capabilities` — the `AdapterCapability` values this adapter can produce.
- `confidence?` — the adapter's default confidence label (falls back to `unknown` when omitted).
- `knownGaps?` — human-readable notes on what this adapter does *not* resolve.
- `selectionMode?` — `targeted` by default for bounded language/file adapters, or `catch-all` for terminal fallback adapters.
- `fileContentScope?` — `full-index` by default; set `target-only` only when the adapter needs content from the current `process(file)` input, and uses `ctx.indexedFiles` / `files` only for path-level context.
- `outputOwnership?` — `unrestricted` by default; `processed-file` opts into the enforced file-owned output contract below.
- `supports(file)` — returns `true` if this adapter handles the file.
- `start(ctx, files)` — returns an `AdapterRun` (or a `Promise<AdapterRun>`) for the index run.

The returned `AdapterRun` exposes `process(file)`, an async generator that yields `IndexEvent`s, plus an optional `dispose()`. Each `IndexEvent` is one of three kinds:

- `entity` — a `PendingEntity` (an `EntityDescriptor`: `kind`, optional `path`, `symbol`, `symbolKind`, `languageId`, `displayName`, `metadata`).
- `relation` — a `PendingRelation` with a `source` and `target` descriptor, a `RelationKind`, optional `metadata`, and `evidence`.
- `diagnostic` — a `warn` or `error` message, optionally tied to a file.

The orchestrator content-hashes each `EntityDescriptor` to compute its entity id, so the same descriptor always maps to the same entity.

## Capabilities

`AdapterCapability` is one of: `imports`, `exports`, `calls`, `references`, `types`, `symbols`, `docrefs`, `tests`, `packages`. An adapter declares the subset it can extract so coverage and gaps are explicit per adapter.

## File content scope

`fileContentScope` makes the adapter's cross-file content contract explicit:

- `full-index` — the adapter may inspect content from any scanned file through `ctx.indexedFiles`, `files`, import resolution, package/lockfile discovery, or other startup state. This is the default for source compatibility and for safety.
- `target-only` — the adapter reads content only from the file currently passed to `process(file)`. It may still use indexed path sets for reference resolution, but it must not read another file's `content` during `start()` or while processing a target file.

Use `target-only` only after checking the implementation. For example, config/infra path-reference extraction uses indexed file paths to validate references but does not read other indexed file contents. Build-system/package and TypeScript/JavaScript adapters stay `full-index` because they build lockfile/package catalogs, import resolvers, and cross-file targets from indexed content.

## Output ownership

Reading only a target file does not prove that its emitted rows belong to that file.
`outputOwnership = 'processed-file'` is a separate, opt-in contract:

- Explicit entities and relation sources must use the current `process(file)` path
  and a file-based entity kind (including workflow/resource/contract). Symbols,
  modules, packages, and external identities are not supported by this contract.
- A relation target may be file-based on that same path, or a bare
  `{ kind: 'file', path }` reference to another indexed file. Foreign target metadata
  and unindexed placeholders are rejected.
- Every explicit evidence path and diagnostic file must be the current file.
  Diagnostics without a file are rejected; omitted relation evidence still uses
  the current file as fallback.
- Inputs are frozen copies; yielded events must support `structuredClone` and are
  snapshotted before validation. Later generator/dispose mutations cannot rewrite
  an accepted event. A violation or clone failure fails the run before publishing
  its graph, while retaining failed-run audit metadata.

Only config/infra opts in initially. Undeclared adapters retain their existing
unrestricted behavior. The resolved ownership declaration participates in the
extractor signature, so changing it forces validation even for unchanged files.
This contract does not yet enable changed-only extraction: changed bodies still
use full extraction until fresh-index equivalence and read-count gates pass.

Neither declaration proves process-order independence. A run-local counter emitted
in each file's own metadata gives B the value 2 after A, but 1 when processing only
B, without reading another body or emitting another file's rows. Selective replay
needs a separate explicit proof of file independence; changed-body full fallback
continues to preserve stateful processing and startup context.

The pure config/infra selection tests compare full, reversed and single-file
processing with unreadable context bodies/hashes, including an edited target.
They also show that removing an indexed path changes an unchanged Dockerfile's
relations. This is bounded adapter-event evidence, not a general independence
declaration or a persisted graph/saved-report oracle. Path-set changes still
require invalidation; runtime selective extraction remains disabled.

## Evidence and confidence (invariant I-10)

Every relation should carry `evidence` — a source file, span, and snippet — and a confidence label. `Confidence` has four levels:

- `proven` — backed by a parser-grade fact.
- `inferred` — derived but well-supported.
- `heuristic` — broad pattern-based coverage.
- `unknown` — the fallback when confidence is absent.

This enforces invariant **I-10** (see [invariants.md](invariants.md)): every impact judgment carries evidence plus provenance plus confidence, and what is unknown is surfaced as `unknown` rather than presented as fact. An adapter's per-run confidence and `knownGaps` are recorded so agents and people can tell parser-backed results from broad heuristic coverage.

## Registration and selection order

Adapters live in a registry (`src/adapters/registry.ts`) and are assembled by `createDefaultRegistry()` in `src/indexer.ts`. Selection is **first-match-wins** in registration order: `pickAdapter(file)` returns the first registered adapter whose `supports()` returns `true`.

This makes registration order load-bearing. The default registry registers, in order: the build-system/package adapter, the config/infra adapter, the TypeScript/JavaScript adapter, the JVM/Spring adapter, the Python adapter, the Go adapter, the Rust adapter, and finally the multi-language regex adapter. That last adapter is a **catch-all** whose `supports()` always returns `true`, so it MUST be registered LAST — any adapter registered after a catch-all is unreachable. The registry enforces this ordering.

The registry now makes that contract explicit. `selectionMode` is optional for source compatibility and defaults to `targeted`; adapters that intentionally serve as terminal fallback coverage set `selectionMode = 'catch-all'`. `AdapterRegistry.register()` rejects any adapter registered after an existing catch-all adapter, and the error names both the new adapter and the catch-all that blocks it. Duplicate `id` validation still runs first and keeps the existing duplicate-id error.

Use `registry.manifest()` when reviewing or testing adapter registration. It returns an immutable snapshot in registration order. Each entry exposes `order`, `id`, `version`, `capabilities`, `confidence` (default `unknown`), `knownGaps` (default empty), `selectionMode` (default `targeted`), `fileContentScope` (default `full-index`), and `outputOwnership` (default `unrestricted`). Callers can inspect it without being able to mutate registry state.

## Versioning and re-extraction

Each index run records an `extractor_version` signature composed from every active adapter's `id`, `version`, resolved `outputOwnership`, and the indexer semantics revision. Bumping an adapter's `version` changes that recorded signature on the next `parallax index` run. Bump `version` whenever an adapter's extraction output changes so runs are not silently mixed across adapter versions.

## Minimal worked example

A tiny adapter that handles `.example` files, emitting one `file` entity and one `IMPORTS` relation with evidence:

```ts
import type {
  AdapterCapability,
  AdapterRun,
  ExtractCtx,
  IndexEvent,
  SemanticAdapter
} from './types.js';
import type { ScannedFile } from '../types.js';

const capabilities: readonly AdapterCapability[] = ['imports'];

export class ExampleAdapter implements SemanticAdapter {
  readonly id = 'example';
  readonly version = '0.1.0';
  readonly capabilities = capabilities;
  readonly confidence = 'heuristic';
  readonly selectionMode = 'targeted';
  readonly fileContentScope = 'target-only';
  readonly knownGaps = ['only resolves a single literal import form'];

  supports(file: ScannedFile): boolean {
    return file.relativePath.endsWith('.example');
  }

  start(_ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun {
    return {
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        // 1) Declare the file as an entity.
        yield { kind: 'entity', entity: { kind: 'file', path: file.relativePath } };

        // 2) Emit a relation with evidence backing it.
        const match = /^import\s+(\S+)/m.exec(file.content);
        if (match) {
          yield {
            kind: 'relation',
            relation: {
              source: { kind: 'file', path: file.relativePath },
              target: { kind: 'file', path: match[1]! },
              kind: 'IMPORTS',
              evidence: [
                {
                  file: file.relativePath,
                  snippet: match[0],
                  startLine: 1,
                  confidence: 'heuristic'
                }
              ]
            }
          };
        }
      }
    };
  }
}
```

Register it in `createDefaultRegistry()` **before** the catch-all adapter so its `supports()` is consulted first.

## Adapter checklist

Before adding or changing an adapter:

- Use a unique `id` and bump `version` whenever extraction output changes.
- Prefer `selectionMode = 'targeted'` for language/file-specific adapters; reserve `catch-all` for the final fallback adapter.
- Keep `fileContentScope = 'full-index'` unless the adapter only reads target-file content and uses indexed files as path metadata.
- Register every targeted adapter before any catch-all adapter.
- Check `registry.manifest()` in focused tests or review notes to confirm order, capabilities, confidence, known gaps, selection mode, and file content scope.
- Keep `knownGaps` current so the manifest communicates where coverage is heuristic or incomplete.

## See also

- [mcp.md](mcp.md) — the MCP surface that reads the indexed graph
- [cli-reference.md](cli-reference.md) — `parallax index` and analysis commands
- [invariants.md](invariants.md) — the evidence-first invariant (I-10)
- [glossary.md](glossary.md) — adapter, evidence, and confidence definitions
