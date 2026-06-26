# Cross-Repo Link Verification And Agent Query 구현 계획

[English](2026-06-26-cross-repo-link-verification-agent-query.md) · **한국어** · [中文](2026-06-26-cross-repo-link-verification-agent-query.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**목표:** W2+W6를 구현해 Parallax가 저장된 cross-repo link consistency를 검증하고, CLI/MCP에서 provider/consumer reverse query에 답하게 만든다.

**Architecture:** 기존 `cross_repo_links` table 위에 `src/cross_repo_links.ts` read model을 하나 둔다. Canonical link write는 directional row로 유지하고, `verifyCrossRepoLinks`, `consumersOf`, `providersFor` helper가 provider-to-consumer와 consumer-to-provider traversal을 제공한다. `resolveCrossRepoContracts`는 `persist?: boolean` option을 받아 CLI는 기존 persisted workflow를 유지하고 MCP는 non-persisting preview를 사용한다.

**Tech Stack:** TypeScript, Node.js `node:test`, SQLite `node:sqlite`, 기존 Parallax workspace/catalog API, Zod schema를 쓰는 MCP SDK, Markdown docs.

## Global Constraints

- Schema migration은 추가하지 않는다. 이 slice는 기존 `cross_repo_links`, `workspaces`, `workspace_repos`, `repos`를 읽는다.
- `cross_repo_links`에 duplicate inverse row를 쓰지 않는다.
- "Bidirectional"은 하나의 canonical directional row에서 양방향 traversal을 제공한다는 뜻이다.
- `workspace verify`, `workspace consumers`, `workspace providers`는 resolution이나 contract diff를 실행하지 않는다.
- `parallax_cross_repo_consumers`, `parallax_cross_repo_providers`는 `readOnlyHint: true`다.
- `parallax_resolve_cross_repo_contracts`는 non-persisting MCP preview이며 `cross_repo_links`를 clear/insert하면 안 된다.
- 기존 CLI `parallax workspace resolve-contracts`는 persisted behavior를 유지한다.
- MCP compact result는 absolute local path보다 service name, contract path, consumer path, `parallax://` resource를 우선한다.
- 영어/한국어/중국어 public docs는 의미가 같아야 한다.
- Final acceptance에는 `npm run verify`가 필요하다.

---

## File Structure

- Create `src/cross_repo_links.ts`: normalized read model, provenance parsing, diagnostics, `verifyCrossRepoLinks`, `consumersOf`, `providersFor`.
- Modify `src/cross_repo_resolver.ts`: `persist?: boolean` option 추가.
- Modify `src/index.ts`: 새 public API export.
- Modify `src/cli.ts`: `workspace verify`, `workspace consumers`, `workspace providers` 추가.
- Modify `src/mcp.ts`: `parallax_cross_repo_consumers`, `parallax_cross_repo_providers`, `parallax_resolve_cross_repo_contracts` 추가.
- Modify tests: `tests/cross-repo-links.test.ts`, `tests/cross-repo-resolver.test.ts`, `tests/mcp.test.ts`.
- Modify docs: `docs/cli-reference*.md`, `docs/mcp*.md`, `skills/parallax/SKILL*.md`, `docs/roadmap*.md`, `IMPROVEMENT_OPPORTUNITIES.md`.

### Task 1: Shared Cross-Repo Link Read Model

**Files:**
- Create: `src/cross_repo_links.ts`
- Create: `tests/cross-repo-links.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `verifyCrossRepoLinks`, `consumersOf`, `providersFor`, `CrossRepoLinkRecord`, `CrossRepoDiagnostic`, `CrossRepoConsumer`, `CrossRepoProvider`.
- Consumes: `openDatabase`, `listWorkspaces`, `workspaceResources`, `parseJsonObject`, `asConfidence`.

- [ ] **Step 1: 실패하는 read-model tests 작성**

Canonical English plan의 Task 1 Step 1에 있는 `tests/cross-repo-links.test.ts` 전체 scaffold와 다섯 개 test를 그대로 작성한다. Tests는 success verify, orphan breaking link, stale workspace membership, malformed provenance, `consumersOf`/`providersFor` bidirectional query를 포함해야 한다.

- [ ] **Step 2: 실패 확인**

```bash
node --import tsx --test tests/cross-repo-links.test.ts
```

Expected: `consumersOf`, `providersFor`, `verifyCrossRepoLinks` export가 없어 실패.

- [ ] **Step 3: `src/cross_repo_links.ts` 구현**

English plan의 Task 1 Step 3에 정의된 exported types와 public functions를 구현한다.

Required exported functions:

```ts
export function verifyCrossRepoLinks(options: CrossRepoLinkVerifyOptions): CrossRepoLinkVerifyResult;
export function consumersOf(options: CrossRepoConsumersOptions): CrossRepoConsumersResult;
export function providersFor(options: CrossRepoProvidersOptions): CrossRepoProvidersResult;
```

Verification loader는 `LEFT JOIN`을 사용해 stale link를 숨기지 않아야 한다.

- [ ] **Step 4: `src/index.ts` export 추가**

English plan Task 1 Step 4의 export block을 추가한다.

- [ ] **Step 5: focused tests 실행**

```bash
node --import tsx --test tests/cross-repo-links.test.ts
```

Expected: read-model tests pass.

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
- Produces: `workspace verify`, `workspace consumers`, `workspace providers`.

- [ ] **Step 1: 실패하는 CLI tests 추가**

English plan Task 2 Step 1의 두 tests를 `tests/cross-repo-links.test.ts`에 추가한다. Tests는 JSON verify success, orphan verify non-zero exit, consumer JSON query, provider human output을 검증한다.

- [ ] **Step 2: 실패 확인**

```bash
node --import tsx --test tests/cross-repo-links.test.ts --test-name-pattern "CLI workspace"
```

Expected: unknown workspace subcommand.

- [ ] **Step 3: CLI handler 구현**

`src/cli.ts`의 `workspace` block에 English plan Task 2 Step 3의 `verify`, `consumers`, `providers` branches를 추가한다. `printHelp()`와 workspace error string도 갱신한다.

- [ ] **Step 4: CLI focused tests 실행**

```bash
node --import tsx --test tests/cross-repo-links.test.ts --test-name-pattern "CLI workspace"
```

Expected: pass.

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
- Produces: `ResolveCrossRepoContractsOptions.persist?: boolean`, `parallax_cross_repo_consumers`, `parallax_cross_repo_providers`, `parallax_resolve_cross_repo_contracts`.

- [ ] **Step 1: Resolver preview test 추가**

English plan Task 3 Step 1의 `persist false` test를 `tests/cross-repo-resolver.test.ts`에 추가한다.

- [ ] **Step 2: Resolver `persist` option 구현**

`ResolveCrossRepoContractsOptions`에 `persist?: boolean`을 추가하고, `options.persist !== false`일 때만 `persistCrossRepoLinks(...)`를 호출한다.

- [ ] **Step 3: MCP failing tests 추가**

`tests/mcp.test.ts`에서 expected tools list, annotation assertions, query behavior tests, preview non-mutation test를 English plan Task 3 Step 3대로 추가한다.

- [ ] **Step 4: MCP tools 등록**

`src/mcp.ts`에 세 tool을 등록한다.

```ts
parallax_cross_repo_consumers
parallax_cross_repo_providers
parallax_resolve_cross_repo_contracts
```

첫 두 tool은 persisted links만 query하고, preview tool은 `resolveCrossRepoContracts({ persist: false })`를 호출한다.

- [ ] **Step 5: MCP docs/skill table 갱신**

`docs/mcp*.md`, `skills/parallax/SKILL*.md`에 세 tool row를 추가하고 skill heading count를 `20`에서 `23`으로 바꾼다.

- [ ] **Step 6: MCP focused tests 실행**

```bash
node --import tsx --test tests/cross-repo-resolver.test.ts --test-name-pattern "persist false"
npm run test:mcp -- --test-name-pattern "stdio server initializes|cross-repo consumers|resolve_cross_repo"
```

Expected: pass.

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

- [ ] **Step 1: CLI reference docs 갱신**

`docs/cli-reference*.md`에 `workspace verify`, `workspace consumers`, `workspace providers` rows와 persisted-link-only 설명 문단을 추가한다.

- [ ] **Step 2: Roadmap/backlog 갱신**

`docs/roadmap*.md`에서 cross-repo consistency item을 checked로 바꾼다. `IMPROVEMENT_OPPORTUNITIES.md`에서 W2/W6를 shipped로 갱신한다.

- [ ] **Step 3: Docs/focused verification 실행**

```bash
npm run docs:lint
node --import tsx --test tests/cross-repo-links.test.ts
node --import tsx --test tests/cross-repo-resolver.test.ts --test-name-pattern "persist false"
npm run test:mcp -- --test-name-pattern "stdio server initializes|cross-repo consumers|resolve_cross_repo"
```

Expected: pass.

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

Expected: all pass.

## Plan Self-Review

- Spec coverage: read model, diagnostics, CLI, MCP, docs/backlog, final verification을 모두 포함한다.
- Placeholder scan: canonical English plan을 source of truth로 사용하며, 이 companion에는 실행자가 선택해야 하는 빈 값이 없다.
- Type consistency: public names는 `verifyCrossRepoLinks`, `consumersOf`, `providersFor`, `parallax_cross_repo_consumers`, `parallax_cross_repo_providers`, `parallax_resolve_cross_repo_contracts`, `persist?: boolean`으로 일치한다.
- Boundary: repair, duplicate inverse row, automatic `analyzeDiff` contract diff, remote discovery, monorepo cataloging, MCP write persistence는 범위 밖이다.
