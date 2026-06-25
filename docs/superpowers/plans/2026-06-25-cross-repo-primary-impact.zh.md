# Cross-Repo Primary Impact 实施计划

**中文** · [English](2026-06-25-cross-repo-primary-impact.md) · [한국어](2026-06-25-cross-repo-primary-impact.ko.md)

> **For agentic workers:** 执行本计划时使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。代码级详细步骤和准确片段保留在 canonical 英文文档中。

**目标:** 将已保存 workspace breaking-contract consumer 直接呈现在主 `analyzeDiff` report、graph export、MCP report payload 和 UI workbench 中。

**架构:** 添加 additive 的 `crossRepoImpacts` report 字段，并增加一个 read-only analyzer lane，把现有 `BREAKS_COMPATIBILITY_WITH` workspace link 转换为 affected target 与 relation-bearing evidence。Contract diff 重新计算仍属于独立 workflow；`analyzeDiff` 只读取已持久化 link，并用 deterministic warning 报告 malformed provenance。

**技术栈:** TypeScript、Node.js `node:test`、SQLite via `node:sqlite`、zod report schema、现有 Parallax workspace/contract-diff resolver、三语 Markdown 文档。

## 全局约束

- 不从 `analyzeDiff` 运行 `analyzeContractDiff`、`resolveCrossRepoContracts` 或任何 workspace mutation。
- 只有 changed file 匹配当前 repo latest completed index run 中的 provider contract path 时，才运行 cross-repo lane。
- 只使用指向同一 provider repo 和 contract path 的已保存 `BREAKS_COMPATIBILITY_WITH` link。
- invalid/legacy provenance 不得 throw；跳过并用一个 deterministic warning 报告 skipped count。
- 不在 report field、UI label、docs example 或 screenshot 中暴露 absolute local repo path。
- `crossRepoImpacts` 是 optional/additive；旧 persisted report 继续可读。
- cross-repo evidence 必须包含 `subject`、`target`、`relationKind`、`relationConfidence`、`extractorId: 'cross-repo-contract-impact'`，让 graph export 能从 report JSON 重建 edge。
- 本 slice 不添加新 command 或 MCP write surface。
- English、Korean、Chinese 文档语义必须一致。
- 最终验收需要通过 `npm run schemas:build`、`npm run lint`、`npm test`、`npm run test:mcp`、`npm run test:ui`、`npm run verify`。

## 文件结构

- 新建 `src/workspace_resources.ts`，让 MCP/UI/analyzer 共享 `parallax://workspaces/{name}` URI helper。
- 新建 `src/cross_repo_impact.ts`，作为 read-only loader，将 saved breaking link 映射为 `CrossRepoImpactCandidate`。
- 修改 `src/types.ts`、`src/index.ts`、`src/report_schema.ts`、`schemas/impact-report.schema.json`，加入 `CrossRepoImpact` 与 schema `1.3.0`。
- 修改 `src/analyzer.ts`，对每个 changed contract 调用 loader，并合并到 `affectedFiles`、`affected`、`evidence`、warning 和 report payload。
- 修改 `src/mcp_resources.ts`、`src/ui/data.ts`，用共享 helper 替换重复 workspace URI helper。
- 修改 `src/ui.ts`、`src/ui/shared.ts`、`src/ui/panels.ts`、`src/ui/client.ts`，更新 cross-repo preview/lane/source-link 行为。
- 修改 `tests/report-schema.test.ts`、`tests/contract-diff.test.ts`、`tests/ui.test.ts`，加入 schema/analyzer/graph/malformed/UI regression。
- 实施完成后更新 `docs/cli-reference*`、`docs/mcp*`、`docs/report-schema*`、`docs/roadmap*`、`IMPROVEMENT_OPPORTUNITIES.md`。

## Task 1: Report contract 与 workspace resource helper

修改范围:

- `src/workspace_resources.ts`
- `src/types.ts`
- `src/index.ts`
- `src/report_schema.ts`
- `schemas/impact-report.schema.json`
- `src/mcp_resources.ts`
- `src/ui/data.ts`
- `tests/report-schema.test.ts`

核心结果:

- 添加 `CrossRepoImpact` type 与 optional `ImpactReport.crossRepoImpacts`。
- 将 `IMPACT_REPORT_SCHEMA_VERSION` 升级到 `1.3.0`。
- 让 MCP/UI/analyzer 共享 `workspaceResources(workspaceName)` helper。
- 重新生成 schema artifact。

验证:

```bash
npm run schemas:build
node --import tsx --test tests/report-schema.test.ts
npm run schemas:check
npm run check
```

提交:

```bash
git commit -m "feat(report): add cross-repo impact schema"
```

## Task 2: Analyzer cross-repo lane

修改范围:

- `src/cross_repo_impact.ts`
- `src/analyzer.ts`
- `tests/contract-diff.test.ts`

核心结果:

- 实现 `loadCrossRepoImpactsForChangedContract(...)`。
- 通过 provider-owned workspace fixture 生成真实 persisted `BREAKS_COMPATIBILITY_WITH` link。
- `analyzeDiff` 将 `web:src/client.ts` 这类 external consumer 加入 `crossRepoImpacts`、`affectedFiles`、`affected` 和 relation-bearing `evidence`。
- graph export 从 persisted report evidence 重建 `BREAKS_COMPATIBILITY_WITH` edge。
- malformed provenance 被跳过并生成单条 warning。

验证:

```bash
node --import tsx --test tests/contract-diff.test.ts --test-name-pattern "analyzeDiff surfaces persisted cross-repo|malformed cross-repo|non-contract changed"
npm run check
```

提交:

```bash
git commit -m "feat(analyze): surface cross-repo contract impact"
```

## Task 3: UI preview、lane label、external evidence source

修改范围:

- `src/ui.ts`
- `src/ui/data.ts`
- `src/ui/shared.ts`
- `src/ui/panels.ts`
- `src/ui/client.ts`
- `tests/ui.test.ts`

核心结果:

- 添加 `UiReportPreview.crossRepoImpacts`。
- 在 workbench impact lane 中添加 `Cross-repo consumers`，并加入 Korean/Chinese label。
- 对 `cross-repo-contract-impact` evidence 和 external affected path 不生成本地 `/source?path=...` 链接。
- UI bootstrap/report HTML 显示 workspace resource URI。

验证:

```bash
node --import tsx --test tests/ui.test.ts --test-name-pattern "cross-repo consumer impacts|list-first report workbench"
```

提交:

```bash
git commit -m "feat(ui): show cross-repo consumer impact"
```

## Task 4: Public docs、verification、review、push

修改范围:

- `docs/cli-reference.md`, `docs/cli-reference.ko.md`, `docs/cli-reference.zh.md`
- `docs/mcp.md`, `docs/mcp.ko.md`, `docs/mcp.zh.md`
- `docs/report-schema.md`, `docs/report-schema.ko.md`, `docs/report-schema.zh.md`
- `docs/roadmap.md`, `docs/roadmap.ko.md`, `docs/roadmap.zh.md`
- `IMPROVEMENT_OPPORTUNITIES.md`

核心结果:

- CLI/MCP docs 说明 `crossRepoImpacts` 来自已保存 workspace breaking link。
- 将 report schema docs 的 current version 更新为 `1.3.0`。
- 在 roadmap/backlog 中将 W1 标记为 shipped。
- 将最终 verify 结果与 review 状态写入 `.superpowers/sdd/progress.md` 和 `.superpowers/sdd/CLAUDE_HANDOFF.md`。

最终验证:

```bash
npm run schemas:build
npm run schemas:check
npm run docs:lint
npm run lint
npm test
npm run test:mcp
npm run test:ui
npm run verify
git diff --check
```

提交并 push:

```bash
git commit -m "docs: document cross-repo primary impact"
git push origin main
```
