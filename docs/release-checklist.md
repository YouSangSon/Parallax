# Parallax — Release Checklist

**English** · [한국어](release-checklist.ko.md) · [中文](release-checklist.zh.md)

Use this checklist before publishing a package, cutting a release tag, or merging a change that alters engine behavior.

Source checkout note: these gates require the repository checkout. The npm package ships compiled artifacts, but not the TypeScript source targets invoked by these scripts, such as `tests/**/*.test.ts`, `bench/impact-bench.ts`, and `scripts/docs-lint.js`.

Package surface note: `package.json` runs `npm run build` through `prepack`, so `npm pack` and `npm publish` rebuild `dist/` from the current source before packaging `dist/src`.

## Required local gate

Run from the repository root of a source checkout:

```bash
npm run verify
```

`npm run verify` is the canonical aggregate gate. Its final audit stage depends on npm registry and network availability.

## What each gate proves

| Gate | Proves | Required when |
| :--- | :--- | :--- |
| `npm run lint` | TypeScript typecheck and docs lint pass. | Every change. |
| `npm run test:install-smoke` | Built CLI launches from `dist/`; this sub-gate owns the only build in `verify`. | Release and CI. |
| `npm test` | Fast unit and integration tests pass. | Every change. |
| `npm run test:dogfood` | Parallax can index itself and preserve the real dependency graph. | Engine changes. |
| `npm run bench` | Multi-language fixture recall, evidence, ranking, and retrieval stay within pinned expectations. | Adapter, analyzer, search, ranking, or retrieval changes. |
| `npm audit --audit-level=high` | Current lockfile has no high-level dependency advisory. | Release and CI. |

## Documentation gate

If any user-visible behavior changed:

1. Update the root README variants when the landing page promises changed.
2. Update `docs/cli-reference*.md` when CLI commands, flags, output, or exit codes changed.
3. Update `docs/mcp*.md` when MCP tools, resources, annotations, or side effects changed.
4. Update `docs/extending-adapters*.md` when adapter contracts changed.
5. Update `docs/architecture*.md` when subsystem boundaries or storage rules changed.
6. Run `npm run docs:lint`.

## Dependency gate

When `npm audit fix` changes `package-lock.json`:

1. Confirm `package.json` did not change unless a direct dependency range must change.
2. Review direct and transitive package bumps.
3. Run `npm run test:install-smoke`.
4. Run `npm audit --audit-level=high`.

## Engine-change gate

An engine change is any change under the indexer, adapters, analyzer, store, graph export, cross-repo resolver, MCP search, or context-pack ranking path.

For those changes:

1. Add focused tests that fail before the fix.
2. Run `npm test`.
3. Run `npm run test:dogfood`.
4. Run `npm run bench`.
5. Update benchmark expectations only when the behavior change is intentional and documented.

## Final review

Before merge:

1. Review `git diff --stat`.
2. Review `git diff`.
3. Confirm no local paths, secret-like strings, or generated reports are staged.
4. Confirm `.parallax/`, `dist/`, `node_modules/`, and `.worktrees/` remain untracked.
5. Confirm CI runs `npm run verify` after `npm ci`.
