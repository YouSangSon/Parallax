# MCP Docs Safety and CLI Graph Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining MCP/documentation drift gaps and give CLI JSON graph export the same bounded pagination contract already used by UI and MCP resources.

**Architecture:** Keep this as a boundary-hardening slice. Tests should catch future drift in packaged docs and agent-facing skill docs, while CLI graph pagination reuses the existing pure `paginateGraph` helper instead of introducing another parser. Documentation updates must clarify that MCP is source-tree-read-only, but MCP tools and resource reads may append local telemetry/context rows to `.parallax/impact.db`.

**Tech Stack:** TypeScript, Node.js 24, node:test, MCP stdio tests, Markdown docs, `scripts/docs-lint.js`, existing trilingual docs parity.

## Global Constraints

- Work on branch `improve/graph-pagination-docs`; do not edit `main` directly.
- Preserve local-first invariant I-1: all data stays in `<repo>/.parallax/impact.db`; no new network or cloud dependency.
- Preserve read-only agent surface invariant I-8/I-9: MCP must not modify source files and actions remain recommendations.
- Do not add dependencies.
- Use existing `paginateGraph(graph, { limit, cursor, requirePagination })` from `src/graph_pagination.ts`; do not duplicate graph limit/cursor parsing.
- Package-visible Markdown means root `README.md`, `README.ko.md`, `README.zh.md`, and `docs/**/*.md` excluding `docs/assets/`.
- For package-visible Markdown, relative non-image `.md` links must resolve only to root README variants or files under `docs/`, because the npm package does not ship `skills/`.
- Keep trilingual docs in English, Korean, and Chinese synchronized enough for `npm run docs:lint`.

---

## Task 1: Package Docs and Skill MCP Drift Guards

**Files:**
- Modify: `scripts/docs-lint.js`
- Modify: `tests/docs_lint.test.ts`
- Modify: `tests/mcp.test.ts`

**Interfaces:**
- Consumes: existing `iterLinks`, `resolveRepoMarkdownTarget`, `mcpDocsToolTables`, and `documentedMcpTools`.
- Produces: package-visible Markdown link guard in `scripts/docs-lint.js`; MCP parity coverage for `skills/parallax/SKILL.md`, `.ko.md`, and `.zh.md`.

- [ ] **Step 1: Add failing docs-lint test for unpackaged skill links**

In `tests/docs_lint.test.ts`, add a test after `tracked docs cannot satisfy trilingual parity with only untracked variants`:

```ts
test('package-visible docs cannot link to unpackaged skill Markdown', async () => {
  const repoRoot = await makeMarkdownRepo(
    {
      'README.md': '# Root\n\n**English** · [한국어](README.ko.md) · [中文](README.zh.md)\n',
      'README.ko.md': '# Root\n\n[English](README.md) · **한국어** · [中文](README.zh.md)\n',
      'README.zh.md': '# Root\n\n[English](README.md) · [한국어](README.ko.md) · **中文**\n',
      'docs/topic.md': [
        '# Topic',
        '',
        '**English** · [한국어](topic.ko.md) · [中文](topic.zh.md)',
        '',
        'See the private [skill](../skills/parallax/SKILL.md).',
        ''
      ].join('\n'),
      'docs/topic.ko.md': [
        '# Topic',
        '',
        '[English](topic.md) · **한국어** · [中文](topic.zh.md)',
        '',
        'See [root](../README.ko.md).',
        ''
      ].join('\n'),
      'docs/topic.zh.md': [
        '# Topic',
        '',
        '[English](topic.md) · [한국어](topic.ko.md) · **中文**',
        '',
        'See [root](../README.zh.md).',
        ''
      ].join('\n'),
      'skills/parallax/SKILL.md': '# Skill\n'
    },
    [
      'README.md',
      'README.ko.md',
      'README.zh.md',
      'docs/topic.md',
      'docs/topic.ko.md',
      'docs/topic.zh.md',
      'skills/parallax/SKILL.md'
    ]
  );

  const result = runDocsLint(repoRoot);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0, output);
  assert.match(output, /docs-lint: docs\/topic\.md:/);
  assert.match(output, /package-visible Markdown links to unpackaged target \.\.\/skills\/parallax\/SKILL\.md/);
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npm exec -- tsx --test tests/docs_lint.test.ts
```

Expected: FAIL because `scripts/docs-lint.js` currently only checks whether the `../skills/parallax/SKILL.md` target exists.

- [ ] **Step 3: Implement package-visible Markdown link guard**

In `scripts/docs-lint.js`, add helpers near `inTrilingualZone`:

```js
function isRootReadmeVariant(file) {
  return ['README.md', 'README.ko.md', 'README.zh.md'].includes(file);
}

function isPackageVisibleMarkdown(file) {
  return isRootReadmeVariant(file) || (file.startsWith('docs/') && !file.startsWith('docs/assets/'));
}

function isPackageSurfaceMarkdownTarget(file) {
  return isRootReadmeVariant(file) || (file.startsWith('docs/') && !file.startsWith('docs/assets/'));
}
```

Then add this check after `checkMarkdownLinkTargets`:

```js
function checkPackageSurfaceLinks(file, content) {
  if (!isPackageVisibleMarkdown(file)) return;
  for (const { isImage, target } of iterLinks(content)) {
    if (isImage) continue;
    if (!target.endsWith('.md')) continue;
    const resolved = resolveRepoMarkdownTarget(file, target);
    if (!isPackageSurfaceMarkdownTarget(resolved)) {
      report(file, `package-visible Markdown links to unpackaged target ${target}`);
    }
  }
}
```

Call `checkPackageSurfaceLinks(file, content)` in `run()` after `checkMarkdownLinkTargets(file, content)`.

- [ ] **Step 4: Add failing MCP skill-table parity coverage**

In `tests/mcp.test.ts`, replace `McpDocsToolTable` with:

```ts
type McpDocsToolTable = {
  filePath: string;
  toolsHeading: string;
  yesLabel: string;
  noLabel: string;
  readOnlyColumnIndex: number;
};
```

Extend `mcpDocsToolTables` with the three skill files:

```ts
  { filePath: 'skills/parallax/SKILL.md', toolsHeading: '## MCP tools surfaced (18)', yesLabel: '✅', noLabel: '❌', readOnlyColumnIndex: 1 },
  { filePath: 'skills/parallax/SKILL.ko.md', toolsHeading: '## MCP tools surfaced (18)', yesLabel: '✅', noLabel: '❌', readOnlyColumnIndex: 1 },
  { filePath: 'skills/parallax/SKILL.zh.md', toolsHeading: '## MCP tools surfaced (18)', yesLabel: '✅', noLabel: '❌', readOnlyColumnIndex: 1 }
```

Update the existing `docs/mcp*.md` entries to use `readOnlyColumnIndex: 2`.

Change `documentedMcpTools()` so the section ends at the next `## ` heading after `toolsHeading` rather than requiring a resources heading:

```ts
  const sectionEnd = lines.findIndex(
    (line, index) => index > toolsStart && line.startsWith('## ')
  );
  const toolsSection = lines.slice(toolsStart + 1, sectionEnd === -1 ? lines.length : sectionEnd);
```

Use `const readOnlyCell = cells[table.readOnlyColumnIndex];`.

- [ ] **Step 5: Run test and verify it passes**

Run:

```bash
npm exec -- tsx --test tests/docs_lint.test.ts tests/mcp.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/docs-lint.js tests/docs_lint.test.ts tests/mcp.test.ts
git commit -m "test: guard package docs and skill MCP parity"
```

## Task 2: CLI Graph JSON Pagination and CLI Reference Accuracy

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/parallax.test.ts`
- Modify: `docs/cli-reference.md`
- Modify: `docs/cli-reference.ko.md`
- Modify: `docs/cli-reference.zh.md`
- Modify: `docs/mcp.md`
- Modify: `docs/mcp.ko.md`
- Modify: `docs/mcp.zh.md`

**Interfaces:**
- Consumes: `paginateGraph` and `GraphPaginationInputError` from `src/graph_pagination.ts`.
- Produces: `parallax graph export --report <id> --format json --limit <n> [--cursor nodeOffset:edgeOffset]` with the same payload shape and validation as UI/MCP graph JSON pagination.

- [ ] **Step 1: Write failing CLI graph pagination tests**

In `tests/parallax.test.ts`, extend `exportImpactGraph renders report graph from SQLite relations without graph DB` after `assert.equal(jsonGraph.format, 'json');` by spawning the CLI from the fixture repo:

```ts
  const firstPage = spawnSync(process.execPath, [
    '--import',
    tsxLoaderPath,
    path.resolve('src/cli.ts'),
    'graph',
    'export',
    '--report',
    report.id,
    '--format',
    'json',
    '--limit',
    '1'
  ], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.equal(firstPage.status, 0, firstPage.stderr);
  const firstPageJson = JSON.parse(firstPage.stdout) as {
    page: { limit: number; returnedNodes: number; nextCursor: string | null };
  };
  assert.equal(firstPageJson.page.limit, 1);
  assert.equal(firstPageJson.page.returnedNodes, 1);
  assert.equal(typeof firstPageJson.page.nextCursor, 'string');

  const secondPage = spawnSync(process.execPath, [
    '--import',
    tsxLoaderPath,
    path.resolve('src/cli.ts'),
    'graph',
    'export',
    '--report',
    report.id,
    '--format',
    'json',
    '--limit',
    '1',
    '--cursor',
    firstPageJson.page.nextCursor!
  ], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.equal(secondPage.status, 0, secondPage.stderr);
  const secondPageJson = JSON.parse(secondPage.stdout) as { page: { cursor: string | null; limit: number } };
  assert.equal(secondPageJson.page.cursor, firstPageJson.page.nextCursor);
  assert.equal(secondPageJson.page.limit, 1);

  const invalidLimit = spawnSync(process.execPath, [
    '--import',
    tsxLoaderPath,
    path.resolve('src/cli.ts'),
    'graph',
    'export',
    '--report',
    report.id,
    '--format',
    'json',
    '--limit',
    'abc'
  ], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.equal(invalidLimit.status, 2);
  assert.match(invalidLimit.stderr, /graph page limit/);
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npm exec -- tsx --test tests/parallax.test.ts
```

Expected: FAIL because CLI help/parser does not yet support `--limit` or `--cursor` for graph export.

- [ ] **Step 3: Implement CLI graph pagination**

In `src/cli.ts`, import the helper:

```ts
import { GraphPaginationInputError, paginateGraph } from './graph_pagination.js';
```

In the `graph export` command block, replace `console.log(graph.rendered);` with:

```ts
    const limit = parseOptionalArg(args, '--limit');
    const cursor = parseOptionalArg(args, '--cursor');
    const requirePagination = limit !== undefined || cursor !== undefined;
    if (graph.format === 'json' && requirePagination) {
      try {
        console.log(JSON.stringify(paginateGraph(graph, { limit, cursor, requirePagination: true }), null, 2));
      } catch (error) {
        if (error instanceof GraphPaginationInputError) throw error;
        throw error;
      }
      return;
    }
    if (requirePagination) {
      throw new Error('graph export --limit/--cursor require --format json');
    }
    console.log(graph.rendered);
```

Add `--limit` and `--cursor` to `parsePositionals()` `valueFlags`.

Update `printHelp()` graph line to:

```text
  ${PACKAGE_NAME} graph export --report <id> [--format mermaid|json|dot]
                              [--limit 100] [--cursor nodeOffset:edgeOffset]
```

- [ ] **Step 4: Update CLI and MCP docs**

In all three `docs/cli-reference*.md` files:
- Replace the sentence that says every command prints JSON by default with wording that says most machine-oriented commands can print JSON through command-specific flags, while `analyze` defaults to a human summary and `graph export` defaults to Mermaid text.
- Update the graph command row to include `[--limit <n>] [--cursor <cursor>]`.
- Add a short paragraph after the graph table:
  - English: "`--limit` and `--cursor` apply only with `--format json`. They use the same `nodeOffset:edgeOffset` cursor and `1..500` limit contract as MCP/UI graph JSON pagination."
  - Korean/Chinese equivalents with the same values.

In all three `docs/mcp*.md` files, update the graph export paragraph so it says CLI graph JSON pagination uses the same contract, not that pagination is MCP/UI-only.

- [ ] **Step 5: Run targeted verification**

Run:

```bash
npm exec -- tsx --test tests/parallax.test.ts
npm run docs:lint
npm run check
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts tests/parallax.test.ts docs/cli-reference.md docs/cli-reference.ko.md docs/cli-reference.zh.md docs/mcp.md docs/mcp.ko.md docs/mcp.zh.md
git commit -m "feat: page CLI graph JSON export"
```

## Task 3: MCP Resource Telemetry Safety Wording

**Files:**
- Modify: `README.md`
- Modify: `README.ko.md`
- Modify: `README.zh.md`
- Modify: `docs/mcp.md`
- Modify: `docs/mcp.ko.md`
- Modify: `docs/mcp.zh.md`
- Modify: `docs/operations.md`
- Modify: `docs/operations.ko.md`
- Modify: `docs/operations.zh.md`

**Interfaces:**
- Consumes: current MCP behavior in `src/mcp.ts`, where tool responses and resource reads may append `context_tool_runs` and `context_resource_accesses` rows.
- Produces: trilingual public docs that clearly distinguish source-tree read-only behavior from local `.parallax/impact.db` telemetry writes.

- [ ] **Step 1: Update root README safety model**

In each root README safety table, revise the source-tree read-only row so it explicitly mentions both tool calls and resource reads:

```md
| **Source-tree read-only by default** | MCP never edits source files; analysis/search tools, context-pack reuse, and MCP resource reads may append context-pack or telemetry rows in `.parallax/impact.db`, while explicit memory commands write facts |
```

Use Korean and Chinese equivalents in localized files. Keep the exact distinction: source files untouched; local database telemetry/context rows may be appended.

- [ ] **Step 2: Update MCP read-only-first section**

In all three `docs/mcp*.md` files, update the read-only-first paragraph to state:
- `readOnlyHint: true` means source-tree read-only, not necessarily zero local DB writes.
- MCP resource reads may append `context_resource_accesses` telemetry rows.
- Analysis/search/context tools may append `context_tool_runs` and context-pack rows.

- [ ] **Step 3: Update operations MCP setup section**

In all three `docs/operations*.md` files, replace the sentence that only mentions analysis/search calls with wording that includes resource reads:

```md
MCP does not modify source files. Analysis/search/context calls may persist context-pack or tool telemetry rows, and MCP resource reads may persist resource-access telemetry rows in `.parallax/impact.db`.
```

Use Korean and Chinese equivalents.

- [ ] **Step 4: Run docs verification**

Run:

```bash
npm run docs:lint
npm exec -- tsx --test tests/mcp.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add README.md README.ko.md README.zh.md docs/mcp.md docs/mcp.ko.md docs/mcp.zh.md docs/operations.md docs/operations.ko.md docs/operations.zh.md
git commit -m "docs: clarify MCP resource telemetry writes"
```

## Task 4: Final Verification and Branch Review

**Files:**
- Review all changed files.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: verified branch ready for user review.

- [ ] **Step 1: Run final gates**

Run:

```bash
npm run lint
npm test
npm run test:dogfood
npm run bench
npm audit --audit-level=high
npm pack --dry-run --json
```

Expected: all pass.

- [ ] **Step 2: Generate final diff package**

Run:

```bash
git merge-base main HEAD
<subagent-driven-development-skill>/scripts/review-package <merge-base-sha> HEAD
```

Expected: a review package path under `.git/sdd/`.

- [ ] **Step 3: Final branch review**

Dispatch a reviewer with the final review package and the plan file. Fix Critical/Important findings and re-review.

- [ ] **Step 4: Completion summary**

Summarize:
- Changed files.
- Test commands and results.
- Remaining non-blocking follow-ups, including entity-kind classification and workspace-contract docs.
