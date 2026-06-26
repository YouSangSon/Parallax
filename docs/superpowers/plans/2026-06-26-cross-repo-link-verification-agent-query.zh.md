# Cross-Repo Link Verification And Agent Query 实施计划

[English](2026-06-26-cross-repo-link-verification-agent-query.md) · [한국어](2026-06-26-cross-repo-link-verification-agent-query.ko.md) · **中文**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标:** 实施 W2+W6，让 Parallax 能验证已持久化 cross-repo link consistency，并通过 CLI/MCP 回答 provider/consumer reverse queries。

**Architecture:** 在现有 `cross_repo_links` table 上增加一个 `src/cross_repo_links.ts` read model。Canonical link write 继续使用 directional row；`verifyCrossRepoLinks`、`consumersOf`、`providersFor` 提供 provider-to-consumer 与 consumer-to-provider traversal。`resolveCrossRepoContracts` 增加 `persist?: boolean` option，使 CLI 保持现有 persisted workflow，而 MCP 使用 non-persisting preview。

**Tech Stack:** TypeScript、Node.js `node:test`、SQLite `node:sqlite`、现有 Parallax workspace/catalog API、使用 Zod schema 的 MCP SDK、Markdown docs。

## Global Constraints

- 不增加 schema migration；本 slice 读取现有 `cross_repo_links`、`workspaces`、`workspace_repos`、`repos`。
- 不向 `cross_repo_links` 写入 duplicate inverse row。
- "Bidirectional" 指从一个 canonical directional row 提供双向 traversal。
- `workspace verify`、`workspace consumers`、`workspace providers` 不运行 resolution 或 contract diff。
- `parallax_cross_repo_consumers` 与 `parallax_cross_repo_providers` 必须设置 `readOnlyHint: true`。
- `parallax_resolve_cross_repo_contracts` 是 non-persisting MCP preview，不得 clear/insert `cross_repo_links`。
- 现有 CLI `parallax workspace resolve-contracts` 保持 persisted behavior。
- MCP compact result 优先使用 service name、contract path、consumer path 与 `parallax://` resource，而不是 absolute local path。
- 英文、韩文、中文 public docs 必须 meaning-equivalent。
- Final acceptance 需要 `npm run verify`。

---

## File Structure

- Create `src/cross_repo_links.ts`: normalized read model, provenance parsing, diagnostics, `verifyCrossRepoLinks`, `consumersOf`, `providersFor`.
- Modify `src/cross_repo_resolver.ts`: 添加 `persist?: boolean` option。
- Modify `src/index.ts`: export 新 public API。
- Modify `src/cli.ts`: 添加 `workspace verify`、`workspace consumers`、`workspace providers`。
- Modify `src/mcp.ts`: 添加 `parallax_cross_repo_consumers`、`parallax_cross_repo_providers`、`parallax_resolve_cross_repo_contracts`。
- Modify tests: `tests/cross-repo-links.test.ts`、`tests/cross-repo-resolver.test.ts`、`tests/mcp.test.ts`。
- Modify docs: `docs/cli-reference*.md`、`docs/mcp*.md`、`skills/parallax/SKILL*.md`、`docs/roadmap*.md`、`IMPROVEMENT_OPPORTUNITIES.md`。

### Task 1: Shared Cross-Repo Link Read Model

**Files:**
- Create: `src/cross_repo_links.ts`
- Create: `tests/cross-repo-links.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `verifyCrossRepoLinks`、`consumersOf`、`providersFor`、`CrossRepoLinkRecord`、`CrossRepoDiagnostic`、`CrossRepoConsumer`、`CrossRepoProvider`。
- Consumes: `openDatabase`、`listWorkspaces`、`workspaceResources`、`parseJsonObject`、`asConfidence`。

- [ ] **Step 1: 编写 failing read-model tests**

照 canonical English plan 的 Task 1 Step 1 创建 `tests/cross-repo-links.test.ts` scaffold 与五个 tests。Coverage 必须包含 verify success、orphan breaking link、stale workspace membership、malformed provenance、`consumersOf`/`providersFor` bidirectional query。

- [ ] **Step 2: 确认失败**

```bash
node --import tsx --test tests/cross-repo-links.test.ts
```

Expected: 因 `consumersOf`、`providersFor`、`verifyCrossRepoLinks` 尚未 export 而失败。

- [ ] **Step 3: 实现 `src/cross_repo_links.ts`**

按 English plan Task 1 Step 3 定义 exported types 与 public functions。

Required exported functions:

```ts
export function verifyCrossRepoLinks(options: CrossRepoLinkVerifyOptions): CrossRepoLinkVerifyResult;
export function consumersOf(options: CrossRepoConsumersOptions): CrossRepoConsumersResult;
export function providersFor(options: CrossRepoProvidersOptions): CrossRepoProvidersResult;
```

Verification loader 必须使用 `LEFT JOIN`，不能隐藏 stale links。

- [ ] **Step 4: 添加 `src/index.ts` exports**

添加 English plan Task 1 Step 4 的 export block。

- [ ] **Step 5: 运行 focused tests**

```bash
node --import tsx --test tests/cross-repo-links.test.ts
```

Expected: read-model tests pass。

- [ ] **Step 6: Commit**

```bash
git add src/cross_repo_links.ts src/index.ts tests/cross-repo-links.test.ts
git commit -m "feat(workspace): verify cross-repo links"
```

### Task 2: CLI Workspace Verification And Reverse Query Commands

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/cross-repo-links.test.ts`

**Interfaces:**
- Produces: `workspace verify`、`workspace consumers`、`workspace providers`。

- [ ] **Step 1: 添加 failing CLI tests**

把 English plan Task 2 Step 1 的两个 tests 添加到 `tests/cross-repo-links.test.ts`。Tests 覆盖 JSON verify success、orphan verify non-zero exit、consumer JSON query、provider human output。

- [ ] **Step 2: 确认失败**

```bash
node --import tsx --test tests/cross-repo-links.test.ts --test-name-pattern "CLI workspace"
```

Expected: unknown workspace subcommand。

- [ ] **Step 3: 实现 CLI handler**

在 `src/cli.ts` 的 `workspace` block 中添加 English plan Task 2 Step 3 的 `verify`、`consumers`、`providers` branches。同步更新 `printHelp()` 与 workspace error string。

- [ ] **Step 4: 运行 CLI focused tests**

```bash
node --import tsx --test tests/cross-repo-links.test.ts --test-name-pattern "CLI workspace"
```

Expected: pass。

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cross-repo-links.test.ts
git commit -m "feat(cli): query cross-repo workspace links"
```

### Task 3: MCP Cross-Repo Query Tools And Resolution Preview

**Files:**
- Modify: `src/cross_repo_resolver.ts`
- Modify: `src/index.ts`
- Modify: `src/mcp.ts`
- Modify: `tests/cross-repo-resolver.test.ts`
- Modify: `tests/mcp.test.ts`
- Modify: `docs/mcp*.md`
- Modify: `skills/parallax/SKILL*.md`

**Interfaces:**
- Produces: `ResolveCrossRepoContractsOptions.persist?: boolean`、`parallax_cross_repo_consumers`、`parallax_cross_repo_providers`、`parallax_resolve_cross_repo_contracts`。

- [ ] **Step 1: 添加 resolver preview test**

把 English plan Task 3 Step 1 的 `persist false` test 添加到 `tests/cross-repo-resolver.test.ts`。

- [ ] **Step 2: 实现 resolver `persist` option**

给 `ResolveCrossRepoContractsOptions` 添加 `persist?: boolean`，仅在 `options.persist !== false` 时调用 `persistCrossRepoLinks(...)`。

- [ ] **Step 3: 添加 MCP failing tests**

按 English plan Task 3 Step 3 更新 `tests/mcp.test.ts` 的 expected tools list、annotation assertions、query behavior tests 与 preview non-mutation test。

- [ ] **Step 4: 注册 MCP tools**

在 `src/mcp.ts` 注册三个 tools：

```ts
parallax_cross_repo_consumers
parallax_cross_repo_providers
parallax_resolve_cross_repo_contracts
```

前两个 tools 只 query persisted links；preview tool 调用 `resolveCrossRepoContracts({ persist: false })`。

- [ ] **Step 5: 更新 MCP docs/skill table**

在 `docs/mcp*.md`、`skills/parallax/SKILL*.md` 中添加三个 tool rows，并把 skill heading count 从 `20` 改为 `23`。

- [ ] **Step 6: 运行 MCP focused tests**

```bash
node --import tsx --test tests/cross-repo-resolver.test.ts --test-name-pattern "persist false"
npm run test:mcp -- --test-name-pattern "stdio server initializes|cross-repo consumers|resolve_cross_repo"
```

Expected: pass。

- [ ] **Step 7: Commit**

```bash
git add src/cross_repo_resolver.ts src/index.ts src/mcp.ts tests/cross-repo-resolver.test.ts tests/mcp.test.ts docs/mcp.md docs/mcp.ko.md docs/mcp.zh.md skills/parallax/SKILL.md skills/parallax/SKILL.ko.md skills/parallax/SKILL.zh.md
git commit -m "feat(mcp): preview and query cross-repo links"
```

### Task 4: Public Docs, Backlog Status, And Verification

**Files:**
- Modify: `docs/cli-reference*.md`
- Modify: `docs/roadmap*.md`
- Modify: `IMPROVEMENT_OPPORTUNITIES.md`
- Optional: `docs/verification*.md`

- [ ] **Step 1: 更新 CLI reference docs**

在 `docs/cli-reference*.md` 中添加 `workspace verify`、`workspace consumers`、`workspace providers` rows，以及 persisted-link-only 说明段落。

- [ ] **Step 2: 更新 roadmap/backlog**

在 `docs/roadmap*.md` 中将 cross-repo consistency item 改为 checked。`IMPROVEMENT_OPPORTUNITIES.md` 中将 W2/W6 更新为 shipped。

- [ ] **Step 3: 运行 docs/focused verification**

```bash
npm run docs:lint
node --import tsx --test tests/cross-repo-links.test.ts
node --import tsx --test tests/cross-repo-resolver.test.ts --test-name-pattern "persist false"
npm run test:mcp -- --test-name-pattern "stdio server initializes|cross-repo consumers|resolve_cross_repo"
```

Expected: pass。

- [ ] **Step 4: Docs commit**

```bash
git add docs/cli-reference.md docs/cli-reference.ko.md docs/cli-reference.zh.md docs/roadmap.md docs/roadmap.ko.md docs/roadmap.zh.md IMPROVEMENT_OPPORTUNITIES.md
git commit -m "docs: document cross-repo link verification"
```

- [ ] **Step 5: Final verification**

```bash
npm run lint
npm test -- --test-name-pattern "workspace|cross-repo|MCP"
npm run test:mcp
npm run bench
npm run verify
```

Expected: all pass。

## Plan Self-Review

- Spec coverage: 包含 read model、diagnostics、CLI、MCP、docs/backlog、final verification。
- Placeholder scan: canonical English plan 是 source of truth；本 companion 没有需要执行者自行补空的值。
- Type consistency: public names 一致为 `verifyCrossRepoLinks`、`consumersOf`、`providersFor`、`parallax_cross_repo_consumers`、`parallax_cross_repo_providers`、`parallax_resolve_cross_repo_contracts`、`persist?: boolean`。
- Boundary: repair、duplicate inverse row、automatic `analyzeDiff` contract diff、remote discovery、monorepo cataloging、MCP write persistence 均 out of scope。
