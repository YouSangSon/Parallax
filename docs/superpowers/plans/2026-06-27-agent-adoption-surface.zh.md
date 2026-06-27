# Agent Adoption Surface 实施计划

[English](2026-06-27-agent-adoption-surface.md) · [한국어](2026-06-27-agent-adoption-surface.ko.md) · **中文**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按顺序交付 7 个 adoption slice，让 Parallax impact graph 进入 GitHub Code Scanning、Copilot/custom-agent 安装、结构化 MCP 输出、repo-map context card、foreground status/watch UX、更丰富的 docs impact，以及确定性的 security-routing recommendation。

**Architecture:** `ImpactReport` 保持为权威分析产物，SARIF、MCP structured result、repo map 和 routing recommendation 都是纯 projection layer。继续遵守 local-first SQLite、read-only-first agent surface、explicit trigger、recommendation-only action 模型。每个 slice 必须能独立测试、独立评审、独立落地。

**Tech Stack:** TypeScript、Node.js `node:test`、`node:sqlite` SQLite、带 Zod input schema 的 MCP SDK、SARIF 2.1.0 JSON、GitHub Actions composite action metadata、三语 Markdown 文档。

## Global Constraints

- Node runtime 保持 `>=24.0.0`。
- 不引入 background daemon 或 implicit listener；`watch` 必须是显式 foreground CLI process。
- MCP tool 不修改 source tree。已有 MCP telemetry/context-pack local database write 继续允许并继续记录在文档中。
- 不自动执行 Semgrep、OpenRewrite、CodeQL 或 GitHub upload。Parallax 只输出文件、命令和 recommendation，外部工具由用户运行。
- 输出必须 deterministic：stable sort、stable rule id、stable partial fingerprint、bounded snippet。
- `docs/` 公共文档保持 `X.md`、`X.ko.md`、`X.zh.md` 三语同步。
- 修改 `docs/mcp*.md` 时，MCP tools table 必须与 `tools/list` 测试一致。
- 修改 `ImpactReport` shape 时，同一 task 内更新 `src/report_schema.ts`、`schemas/impact-report.schema.json`、`docs/report-schema*.md` 和 schema tests。
- SARIF output 使用 `2.1.0`。GitHub upload 文档必须避免在同一个 SARIF 文件中重复相同 tool/category run。
- 外部依据按 2026-06-27 验证：GitHub SARIF upload/support 文档、GitHub Copilot custom-agent 文档、MCP `outputSchema`/`structuredContent` 文档，以及 Semgrep MCP deprecation notice。

---

## Scope Check

这不是单个小功能，而是 7 个 adoption slice 的有序计划。用户明确要求按 1 到 7 执行，所以用一个 ordered ledger 管理。每个 task 都必须交付可运行、可测试的软件，评审通过后再进入下一个 task。

## Grill Decisions

1. **因为 MCP structured output 有利于 agent package，要不要把 Task 3 提到 Task 2 之前？** 不。请求顺序是 1 到 7。Task 2 先基于当前 MCP tool 名称提供可用的 Copilot/custom-agent package，Task 3 再为相同 tool 名称增加 structured output。
2. **SARIF 要不要改变 stored report schema？** 不。SARIF 是从 `ImpactReport` 派生的 projection，不扰动 `analyze --json` 和 report schema。
3. **SARIF 要不要只输出到 stdout？** 不。先提供 `--sarif-output <path>`，避免 CI log 和 machine JSON 混在一起。
4. **status/watch 能不能创建 daemon？** 不。invariant 和 security test 禁止 implicit daemon。`status` 是 read-only，`watch` 只能 foreground 运行。
5. **Semgrep/OpenRewrite routing 能不能执行工具？** 不。使用现有 `ImpactAction` recommendation 模型，只提供结构化 command/args。

## File Structure

- `src/sarif.ts` 从 `ImpactReport` 生成 SARIF 2.1.0。
- `src/cli.ts` 依次增加 `analyze --sarif-output`、`install-agent` package flag、`repo-map`、`status`、`watch`。
- `src/index.ts` 导出每个 slice 的 public helper。
- `action.yml` 提供可选 GitHub composite action，用于生成 Parallax SARIF。
- `src/agent_config.ts` 生成 MCP config、Copilot instructions、custom-agent file plan。
- `src/mcp_output_schemas.ts` 保存 MCP `outputSchema`。
- `src/mcp.ts` 增加 `outputSchema`、`structuredContent`，后续增加 `parallax_repo_map`。
- `src/repo_map.ts` 生成 token-budgeted repo map/context card。
- `src/status.ts` 提供 read-only status summary 和 foreground watch loop。
- `src/adapters/multi-language-regex.ts`、`src/artifacts.ts`、`src/work_artifacts.ts`、`src/ui/data.ts`、`src/context_pack.ts` 扩展 docs/knowledge-base impact graph。
- `src/routing_recommendations.ts` 生成 Semgrep/OpenRewrite/CodeQL recommendation rule。

---

### Task 1: SARIF Export And GitHub Action

**Files:** `src/sarif.ts`、`tests/sarif.test.ts`、`action.yml`、`src/cli.ts`、`src/index.ts`、`tests/parallax.test.ts`、三语 README、`docs/cli-reference*.md`、`docs/report-schema*.md`、`docs/roadmap*.md`、`IMPROVEMENT_OPPORTUNITIES.md`

**Interfaces:** `impactReportToSarif(report, options)` 和 CLI `parallax analyze --sarif-output <path> [--sarif-category <category>]`。

- [ ] **Step 1: 编写失败的 SARIF serializer test**

`tests/sarif.test.ts` 使用 `ImpactReport` fixture 验证 SARIF `version: "2.1.0"`、`tool.driver.name: "Parallax"`、`automationDetails.id`、affected file location、region、stable `partialFingerprints.parallaxImpact` 和 evidence id。

- [ ] **Step 2: 确认失败**

Run: `node --import tsx --test tests/sarif.test.ts`

Expected: 因为 `src/sarif.ts` 不存在而 FAIL。

- [ ] **Step 3: 实现 `src/sarif.ts`**

使用 `node:crypto` hash 生成 fingerprint，实现按 confidence 的 rule id、changed/evidence related locations、基于 relation path 的 code flow、bounded snippet、repo-relative URI normalization。

- [ ] **Step 4: 增加 public export**

在 `src/index.ts` 导出 `impactReportToSarif`、`SarifLog`、`SarifOptions`。

- [ ] **Step 5: 增加 CLI 文件输出**

在 `src/cli.ts` 的 `analyze` 中增加 `--sarif-output <path>` 和 `--sarif-category <category>`。与 `--json` 同时使用时给出明确错误。创建 parent directory 并写入 pretty JSON。stdout 保持现有 human summary。

- [ ] **Step 6: 编写 CLI regression test**

在 `tests/parallax.test.ts` 中创建 temp repo，运行 `analyze --changed ... --sarif-output parallax.sarif --sarif-category unit`，验证 SARIF file 的 version、category、URI。

- [ ] **Step 7: 增加 GitHub composite action**

`action.yml` 接受 `changed`、`sarif-output`、`sarif-category`、`fail-on` input，只运行 `npx parallax analyze ... --sarif-output ...`。SARIF upload 在 README workflow snippet 中用 `github/codeql-action/upload-sarif@v3` 单独展示。

- [ ] **Step 8: 更新文档**

在三语文档中记录 CLI flag、SARIF 是 projection 而非 report schema bump、GitHub Code Scanning workflow 示例、roadmap/backlog 状态。

- [ ] **Step 9: 验证并 commit**

```bash
node --import tsx --test tests/sarif.test.ts
node --import tsx --test tests/parallax.test.ts --test-name-pattern "SARIF|CLI analyze"
npm run check
npm run docs:lint
git diff --check
git commit -m "feat: export impact reports as sarif"
```

### Task 2: Copilot Custom-Agent Install Package

**Files:** `src/agent_config.ts`、`src/cli.ts`、`tests/agent-config.test.ts`、`docs/cli-reference*.md`、`docs/mcp*.md`、`docs/roadmap*.md`、`IMPROVEMENT_OPPORTUNITIES.md`

**Interfaces:** `planCopilotAgentPackage(options)`、`installCopilotAgentPackage(options)`、CLI `parallax install-agent --copilot-package --target <repo> [--dry-run] [--force]`。

- [ ] 测试 dry-run、no-overwrite、`--force`、生成的 `.github/copilot-instructions.md`、`.github/agents/parallax-impact.agent.md` 和 MCP config snippet。
- [ ] Template generation 用 pure function，filesystem write 只做薄封装。
- [ ] CLI 输出 planned relative path 和 action。
- [ ] 文档说明该命令不访问 GitHub，只写 target repo 文件。
- [ ] Verify: `node --import tsx --test tests/agent-config.test.ts && npm run check && npm run docs:lint && git diff --check`。
- [ ] Commit: `git commit -m "feat: generate copilot agent package"`。

### Task 3: MCP Output Schemas And Structured Content

**Files:** `src/mcp_output_schemas.ts`、`src/mcp.ts`、`tests/mcp.test.ts`、`docs/mcp*.md`

**Interfaces:** 每个 tool 的 `outputSchema`，`toolJsonResponse(value)` 的 `structuredContent`，并保留现有 `content[0].text` mirror。

- [ ] 测试 `tools/list` 暴露 representative tool 的 `outputSchema`。
- [ ] 测试 tool call 的 `structuredContent` 等于 `JSON.parse(content[0].text)`。
- [ ] 现有 JSON-returning tool 统一走 shared helper。
- [ ] Verify: `npm run test:mcp && npm run check && npm run docs:lint && git diff --check`。
- [ ] Commit: `git commit -m "feat: expose structured mcp outputs"`。

### Task 4: Repo Map And Context Card

**Files:** `src/repo_map.ts`、`tests/repo-map.test.ts`、`src/types.ts`、`src/index.ts`、`src/cli.ts`、`src/mcp.ts`、`tests/mcp.test.ts`、`docs/cli-reference*.md`、`docs/mcp*.md`、`docs/roadmap*.md`、`IMPROVEMENT_OPPORTUNITIES.md`

**Interfaces:** `buildRepoMap(options): RepoMap`、CLI `parallax repo-map --changed <files> [--query <text>] [--budget <tokens>] [--json]`、MCP `parallax_repo_map`。

- [ ] 测试 changed root、affected file、test、docs、work artifact、evidence、action、`parallax://` resource ranking 和 omitted count。
- [ ] 复用 `buildContextPack`、`searchContext`、graph resource。
- [ ] token budget 用 `Math.ceil(text.length / 4)` 估算并写入文档。
- [ ] Verify: `node --import tsx --test tests/repo-map.test.ts && npm run test:mcp && npm run check && npm run docs:lint && git diff --check`。
- [ ] Commit: `git commit -m "feat: build token-budgeted repo maps"`。

### Task 5: Status And Foreground Watch UX

**Files:** `src/status.ts`、`tests/status.test.ts`、`src/cli.ts`、`src/index.ts`、`tests/security.test.ts`、`docs/cli-reference*.md`、`docs/operations*.md`、必要时 `docs/invariants*.md`

**Interfaces:** `getProjectStatus(options): ProjectStatus`、CLI `parallax status [--json]`、CLI `parallax watch --changed <files> [--interval <seconds>]`。

- [ ] 测试 latest index run、coverage、adapter health、vector state、telemetry count、next command。
- [ ] 复用 `doctorProject()` projection。
- [ ] `watch` 只做 foreground polling，并在 SIGINT 退出。
- [ ] Security test 继续保证 implicit daemon/listener 禁止规则。
- [ ] Verify: `node --import tsx --test tests/status.test.ts && npm run test:security && npm run check && npm run docs:lint && git diff --check`。
- [ ] Commit: `git commit -m "feat: add explicit status and watch ux"`。

### Task 6: Docs And Knowledge-Base Impact Graph

**Files:** `src/adapters/multi-language-regex.ts`、`src/artifacts.ts`、`src/work_artifacts.ts`、`src/ui/data.ts`、`src/context_pack.ts`、`tests/parallax.test.ts`、`tests/work_artifacts.test.ts`、`tests/ui.test.ts`、`tests/mcp.test.ts`、`docs/architecture*.md`、`docs/glossary*.md`

**Interfaces:** Markdown wiki link、Markdown link、ADR/policy/PRD heading anchor、ownership reference、requirement id 都提取为带 evidence 的 relation。

- [ ] 增加 fixture：code change 暴露 policy/ADR/PRD docs impact，doc change 暴露 governed code/tests/resources。
- [ ] 每条新 relation 都包含 evidence file/span、extractor id、confidence、bounded snippet。
- [ ] UI payload 只暴露 resource URI 和 freshness，不暴露 full body。
- [ ] Verify: relevant `parallax`、`work_artifacts`、UI、MCP tests，加 `npm run bench`、`npm run check`、`npm run docs:lint`。
- [ ] Commit: `git commit -m "feat: expand docs impact graph"`。

### Task 7: Semgrep And OpenRewrite Routing Recommendations

**Files:** `src/routing_recommendations.ts`、`tests/routing-recommendations.test.ts`、`src/analyzer.ts`、`src/index.ts`、`docs/report-schema*.md`、`docs/verification*.md`、`docs/roadmap*.md`、`IMPROVEMENT_OPPORTUNITIES.md`

**Interfaces:** `recommendRoutingActions(reportInputs): ImpactAction[]`，优先使用现有 `ImpactAction.kind: 'review'`。

- [ ] 测试 security-sensitive TypeScript/Python path 推荐 Semgrep，Java build/API route 推荐 OpenRewrite，docs-only/generated change 不产生无关 scanner recommendation。
- [ ] 实现基于 path/language/evidence 的 deterministic rule，并与已有 action dedupe。
- [ ] 在 `analyzeDiff()` 的 action 后 append recommendation。
- [ ] Verify: `node --import tsx --test tests/routing-recommendations.test.ts && node --import tsx --test tests/parallax.test.ts --test-name-pattern "actions|command" && npm run schemas:check && npm run check && npm run docs:lint && git diff --check`。
- [ ] Commit: `git commit -m "feat: recommend security routing actions"`。

## Final Program Verification

Task 7 和所有 per-task review 完成后：

```bash
npm run verify
git status --short --branch
```

最后用 `superpowers:requesting-code-review` 进行 whole-branch review。通过后确认 `origin/main` 可 fast-forward，再 push 到 `main`。

