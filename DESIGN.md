# Design

## Active Slice: S1 Changed-Content Invalidation Safety

### Problem

Two independent assumptions make changed-only extraction unsafe:

- a `full-index` adapter's output for one owned file may depend on any indexed
  file body; a `tsconfig.json`-only alias edit can therefore stale an unchanged
  TypeScript edge;
- `fileContentScope = 'target-only'` constrains reads, not emitted-row ownership;
  a compliant adapter processing changed `a.ts` may emit a relation sourced from
  unchanged `b.ts`, which source-path carry-forward would preserve if it vanishes.

### Decision

Keep the existing full extraction/persistence path as the safety mechanism:

- no changed indexed bodies: retain the current incremental carry-forward and
  skip adapter startup;
- any changed indexed body: promote the effective run to full extraction and do
  not carry rows;
- include an indexer-semantics revision in `extractor_version` so a pre-fix
  completed cohort cannot be reused after upgrading.

This consumes the declared contract without adding a dependency graph or partial
adapter invalidation model.

### Data Flow

1. Scan and classify with the current conservative reader.
2. Compute the content-hash delta.
3. Promote any non-empty changed set to the existing full path.
5. Use the effective mode consistently for coverage, adapter processing,
   persistence, evidence, carry-forward, and the returned result.

### Measurement

The exact incremental-vs-fresh-full oracle is the correctness gate. Existing
`bench:perf` scan timings remain advisory and do not prove read reduction.
Deterministic body-read counts belong to a later slice, after a separate emitted-
row ownership contract and enforcement exist.

### Known Ceiling

Changed-body runs receive no incremental extraction speedup. Add narrower
invalidation only when a measured workload justifies an explicit emitted-row
ownership contract, runtime enforcement, and persistence oracle.

### Sources

- [Git status porcelain and untracked-file semantics](https://git-scm.com/docs/git-status)
- [Git index cache and racy-clean safeguards](https://git-scm.com/docs/git-update-index)
- [Node file-system discovery and stat semantics](https://nodejs.org/api/fs.html)
- [clangd background and per-file index model](https://clangd.llvm.org/design/indexing.html)
