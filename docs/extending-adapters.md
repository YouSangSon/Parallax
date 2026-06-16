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
- `supports(file)` — returns `true` if this adapter handles the file.
- `start(ctx, files)` — returns an `AdapterRun` (or a `Promise<AdapterRun>`) for the index run.

The returned `AdapterRun` exposes `process(file)`, an async generator that yields `IndexEvent`s, plus an optional `dispose()`. Each `IndexEvent` is one of three kinds:

- `entity` — a `PendingEntity` (an `EntityDescriptor`: `kind`, optional `path`, `symbol`, `symbolKind`, `languageId`, `displayName`, `metadata`).
- `relation` — a `PendingRelation` with a `source` and `target` descriptor, a `RelationKind`, optional `metadata`, and `evidence`.
- `diagnostic` — a `warn` or `error` message, optionally tied to a file.

The orchestrator content-hashes each `EntityDescriptor` to compute its entity id, so the same descriptor always maps to the same entity.

## Capabilities

`AdapterCapability` is one of: `imports`, `exports`, `calls`, `references`, `types`, `symbols`, `docrefs`, `tests`, `packages`. An adapter declares the subset it can extract so coverage and gaps are explicit per adapter.

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

Use `registry.manifest()` when reviewing or testing adapter registration. It returns an immutable snapshot in registration order. Each entry exposes `order`, `id`, `version`, `capabilities`, `confidence` (default `unknown`), `knownGaps` (default empty), and `selectionMode` (default `targeted`). Callers can inspect it without being able to mutate registry state.

## Versioning and re-extraction

Each index run records an `extractor_version` signature composed from every active adapter's `id` and `version`. Bumping an adapter's `version` changes that recorded signature on the next `parallax index` run. Bump `version` whenever an adapter's extraction output changes so runs are not silently mixed across adapter versions.

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
- Register every targeted adapter before any catch-all adapter.
- Check `registry.manifest()` in focused tests or review notes to confirm order, capabilities, confidence, known gaps, and selection mode.
- Keep `knownGaps` current so the manifest communicates where coverage is heuristic or incomplete.

## See also

- [mcp.md](mcp.md) — the MCP surface that reads the indexed graph
- [cli-reference.md](cli-reference.md) — `parallax index` and analysis commands
- [invariants.md](invariants.md) — the evidence-first invariant (I-10)
- [glossary.md](glossary.md) — adapter, evidence, and confidence definitions
