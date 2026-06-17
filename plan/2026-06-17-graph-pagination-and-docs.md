# Shared Graph Pagination and MCP Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce UI/MCP graph pagination drift and fix MCP side-effect documentation so future graph consumers and agent users share one accurate contract.

**Architecture:** Extract graph JSON pagination into a pure shared module that returns page metadata and throws transport-neutral input errors. Keep UI and MCP responsible for their own error envelopes. Update trilingual skill/docs surfaces after the behavior-preserving refactor.

**Tech Stack:** TypeScript, Node.js 24, node:test, MCP stdio, Markdown docs with trilingual parity.

## Global Constraints

- Work on branch `improve/graph-pagination-docs`; do not edit `main` directly.
- Preserve public graph JSON page shape: `{ reportId, indexRunId, format, nodes, edges, page }`.
- Preserve UI invalid pagination response shape: HTTP 400 JSON with `error.code === "invalid_request"`.
- Preserve MCP invalid pagination error code: `invalid_pagination`.
- Do not change graph export behavior for non-JSON formats.
- Do not change source-tree write behavior; docs must keep saying MCP tools do not modify source files.
- Run targeted tests after each task and `npm run verify` before final completion.

---

## Task 1: Shared Graph Pagination Helper

**Files:**
- Create: `src/graph_pagination.ts`
- Create: `tests/graph_pagination.test.ts`

**Interfaces:**
- Produces: `paginateGraph(graph: GraphExport, options?: { limit?: string | null; cursor?: string | null; requirePagination?: boolean }): GraphPagePayload | GraphExport`
- Produces: `GraphPaginationInputError` with message text matching the existing UI/MCP validation messages.
- Consumes: `GraphExport` from `src/graph.ts`.

- [x] **Step 1: Write failing unit tests**

Create `tests/graph_pagination.test.ts` with these cases:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GraphExport } from '../src/graph.js';
import { GraphPaginationInputError, paginateGraph } from '../src/graph_pagination.js';

function makeGraph(): GraphExport {
  return {
    reportId: 'report-1',
    indexRunId: 7,
    format: 'json',
    rendered: '{"full":true}',
    nodes: [
      { id: 'node-1', label: 'node 1', kind: 'file' },
      { id: 'node-2', label: 'node 2', kind: 'file' }
    ],
    edges: [
      { from: 'node-1', to: 'node-2', label: 'DEPENDS_ON' },
      { from: 'node-2', to: 'node-1', label: 'REFERENCES' }
    ]
  };
}

test('paginateGraph returns the original graph when pagination is not required and no params are provided', () => {
  const graph = makeGraph();
  assert.equal(paginateGraph(graph), graph);
});

test('paginateGraph returns the first page with stable metadata', () => {
  const page = paginateGraph(makeGraph(), { limit: '1', requirePagination: true });
  assert.deepEqual(page.nodes.map((node) => node.id), ['node-1']);
  assert.deepEqual(page.edges.map((edge) => edge.label), ['DEPENDS_ON']);
  assert.deepEqual(page.page, {
    cursor: null,
    nextCursor: '1:1',
    limit: 1,
    totalNodes: 2,
    totalEdges: 2,
    returnedNodes: 1,
    returnedEdges: 1
  });
});

test('paginateGraph accepts a returned cursor for the next page', () => {
  const page = paginateGraph(makeGraph(), { limit: '1', cursor: '1:1', requirePagination: true });
  assert.deepEqual(page.nodes.map((node) => node.id), ['node-2']);
  assert.deepEqual(page.edges.map((edge) => edge.label), ['REFERENCES']);
  assert.equal(page.page.cursor, '1:1');
  assert.equal(page.page.nextCursor, null);
});

test('paginateGraph rejects invalid limits and cursors with transport-neutral input errors', () => {
  const cases = [
    { options: { limit: 'abc' }, message: /limit/ },
    { options: { cursor: 'bad' }, message: /cursor/ },
    { options: { cursor: '9007199254740992:0' }, message: /safe non-negative integer/ },
    { options: { cursor: '999:0' }, message: /outside/ }
  ];

  for (const item of cases) {
    assert.throws(
      () => paginateGraph(makeGraph(), { ...item.options, requirePagination: true }),
      (error: unknown) => {
        assert.ok(error instanceof GraphPaginationInputError);
        assert.match(error.message, item.message);
        return true;
      }
    );
  }
});
```

- [x] **Step 2: Run the new test and verify it fails**

Run:

```bash
tsx --test tests/graph_pagination.test.ts
```

Expected: fail because `src/graph_pagination.ts` does not exist yet.

- [x] **Step 3: Implement the shared helper**

Create `src/graph_pagination.ts` with the existing validation messages from `src/ui.ts` and `src/mcp_resources.ts`. The implementation must:

- Return the original `GraphExport` object when neither `limit` nor `cursor` is present and `requirePagination` is not true.
- Default `limit` to `100` when pagination is required.
- Reject non-integer, less-than-1, or greater-than-500 limits.
- Reject cursors not shaped as `number:number`.
- Reject unsafe or negative offsets.
- Reject offsets beyond graph bounds.
- Return the same `page` metadata keys and values currently emitted by UI and MCP.

- [x] **Step 4: Run tests and typecheck**

Run:

```bash
tsx --test tests/graph_pagination.test.ts
npm run check
```

Expected: both pass.

- [x] **Step 5: Commit**

```bash
git add src/graph_pagination.ts tests/graph_pagination.test.ts
git commit -m "refactor: share graph pagination helper"
```

## Task 2: Wire UI and MCP to the Shared Helper

**Files:**
- Modify: `src/ui.ts`
- Modify: `src/mcp_resources.ts`
- Modify: `tests/ui.test.ts`
- Modify: `tests/mcp.test.ts`

**Interfaces:**
- Consumes: `paginateGraph` and `GraphPaginationInputError` from `src/graph_pagination.ts`.
- Produces: no new public API. Existing UI and MCP page JSON shapes must remain unchanged.

- [x] **Step 1: Add integration assertions before wiring**

In `tests/ui.test.ts`, extend `UI graph JSON API rejects invalid pagination query params with structured JSON` so it also asserts every invalid response uses HTTP 400 and `error.code === "invalid_request"`. The current test already checks this; keep it as the behavior lock.

In `tests/mcp.test.ts`, keep the existing invalid graph cursor assertion and add a `limit=abc` invalid request assertion that expects `error.code === "invalid_pagination"`.

- [x] **Step 2: Run targeted integration tests**

Run:

```bash
tsx --test tests/ui.test.ts tests/mcp.test.ts
```

Expected: pass before refactor, proving the behavior lock exists.

- [x] **Step 3: Replace duplicated pagination logic**

Update `src/ui.ts`:

- Import `GraphPaginationInputError` and `paginateGraph`.
- In `uiApiResponse`, replace the local limit/cursor slicing block with:

```ts
return paginateGraph(graph, {
  limit: url.searchParams.get('limit'),
  cursor: url.searchParams.get('cursor'),
  requirePagination: true
});
```

- In the server catch block, map `GraphPaginationInputError` to the existing UI envelope:

```ts
if (error instanceof GraphPaginationInputError) {
  response.writeHead(400, jsonHeaders());
  response.end(JSON.stringify({ error: { code: 'invalid_request', message: error.message } }));
  return;
}
```

- Remove `parseGraphPageLimit`, `parseGraphPageCursor`, `parseGraphCursorOffset`, `validateGraphPageCursor`, and the local `GraphPageCursor` type from `src/ui.ts`.

Update `src/mcp_resources.ts`:

- Import `GraphPaginationInputError` and `paginateGraph`.
- In `graphResourceText`, keep returning `graph.rendered` for non-JSON formats.
- For JSON, call `paginateGraph(graph, { limit, cursor, requirePagination })` where `requirePagination` is true only if the URI has `limit` or `cursor`.
- Wrap `GraphPaginationInputError` with `typedMcpError(error, 'invalid_pagination')`.
- Remove duplicated local pagination parsing helpers and cursor type.

- [x] **Step 4: Run targeted tests**

Run:

```bash
tsx --test tests/graph_pagination.test.ts tests/ui.test.ts tests/mcp.test.ts
npm run check
```

Expected: all pass.

- [x] **Step 5: Commit**

```bash
git add src/ui.ts src/mcp_resources.ts tests/ui.test.ts tests/mcp.test.ts tests/graph_pagination.test.ts
git commit -m "refactor: reuse graph pagination across UI and MCP"
```

## Task 3: Correct MCP Side-Effect Docs and Graph Pagination Docs

**Files:**
- Modify: `docs/mcp.md`
- Modify: `docs/mcp.ko.md`
- Modify: `docs/mcp.zh.md`
- Modify: `skills/parallax/SKILL.md`
- Modify: `skills/parallax/SKILL.ko.md`
- Modify: `skills/parallax/SKILL.zh.md`

**Interfaces:**
- Consumes: current MCP `readOnlyHint` annotations from `src/mcp.ts`.
- Produces: trilingual docs that accurately distinguish pure reads from DB side effects and explain graph JSON pagination query params.

- [x] **Step 1: Lock current MCP annotation behavior**

Run:

```bash
tsx --test tests/mcp.test.ts
```

Expected: pass, including the MCP docs/tool annotation parity tests.

- [x] **Step 2: Update MCP docs**

In `docs/mcp.md`, `docs/mcp.ko.md`, and `docs/mcp.zh.md`, add one short paragraph after the graph export paragraph explaining:

- JSON graph resources can be paged with `?limit=100&cursor=nodeOffset:edgeOffset`.
- `limit` defaults to 100 for paged requests and must be 1 through 500.
- `nextCursor` is returned in `page.nextCursor`.
- Invalid pagination returns MCP `invalid_pagination`; UI maps the same validation to `invalid_request`.

- [x] **Step 3: Update skill MCP tables**

In `skills/parallax/SKILL.md`, `skills/parallax/SKILL.ko.md`, and `skills/parallax/SKILL.zh.md`, update the MCP tool table so `Read-only?` matches `docs/mcp*.md` and `src/mcp.ts`:

- `parallax_analyze_diff`: `❌`
- `parallax_context_for_change`: `❌`
- `parallax_search_context`: `❌`
- `parallax_explain_entity`: `❌`
- `parallax_context_telemetry`: `✅`
- Keep explicit memory write, branch, merge, reflect, repair, restore, and contract diff tools as `❌`.
- Keep recall, profile, doctor, trace as `✅`.

- [x] **Step 4: Run docs and MCP checks**

Run:

```bash
npm run docs:lint
tsx --test tests/mcp.test.ts
```

Expected: both pass.

- [x] **Step 5: Commit**

```bash
git add docs/mcp.md docs/mcp.ko.md docs/mcp.zh.md skills/parallax/SKILL.md skills/parallax/SKILL.ko.md skills/parallax/SKILL.zh.md
git commit -m "docs: align MCP side effect and pagination docs"
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
```

Expected: all pass.

- [ ] **Step 2: Generate final diff package**

Run:

```bash
git merge-base main HEAD
<subagent-driven-development-skill>/scripts/review-package <merge-base-sha> HEAD
```

Expected: a review package path under `.git/sdd/`.

- [ ] **Step 3: Final review**

Dispatch a reviewer over the full branch diff. Fix any Critical or Important findings and rerun the relevant tests.

- [ ] **Step 4: Completion summary**

Summarize:

- Changed files.
- Test commands and results.
- Any remaining non-blocking follow-ups, including lockfile/transitive package graph and dogfood performance budget.
