---
name: parallax
description: Local-first code impact analyzer + agent memory layer for Claude Code, Codex, and other agentic coding tools. Use when you need to analyze how a code change ripples through a repository, persist agent decisions/observations as content-addressable facts, run reflective consolidation on long-running memory, or surface a per-entity profile of static (code structure) + dynamic (agent activity) + summary (LLM-consolidated) context. Single SQLite database, no cloud dependencies, MCP-native.
---

# Parallax Skill

Parallax 是面向 AI 编码 agent 的 local-first、代码感知的 memory 层。它将一个仓库索引为 entity 和 relation，以 content-addressable fact 的形式在 transaction DAG 上接收 agent 的 observation，并通过 MCP 工具和 CLI 暴露这个组合视图。

## When to invoke

- "这次改动会如何扩散?" → `analyze`
- "哪些 policy/proposal/decision 提到了这段代码?" → 对仓库本地的 Markdown 工作产物建立索引后，使用 analyze 或 MCP context 工具
- "记住/回忆某个 agent decision" → `remember` / `recall`
- "在不读取文件的情况下查找相关的已索引 context" → MCP `parallax_search_context`
- "这个 entity 直接触及了什么?" → MCP `parallax_explain_entity`，或使用 CLI `profile` 获取 memory context
- "总结较旧的 episodic fact" → `reflect` ()
- "追溯我为什么决定 X" → `trace`
- "把这个实验分支标记为废弃并清理它" → `branch --abandon`，然后 `gc-branches` ()

## Quickstart

```bash
# 1. Install (one-time, in the target repo)
npm install -g parallax          # or use this checkout via npm link

# 2. Initialize and index the repo
parallax init
parallax index

# 3. Analyze a code change
parallax analyze --changed src/auth/session.ts
# or use git diff:
parallax analyze --base main --head HEAD --json

# 4. Persist an agent observation
parallax remember --entity file:src/auth/session.ts \
                      --attribute observed --value '"compiled"'

# 5. Profile an entity (combined static + dynamic + summary view)
parallax profile --entity file:src/auth/session.ts

# 6. Run on a branch — no data copy on fork
parallax branch --name plan-A
parallax remember --branch plan-A --entity file:foo.ts \
                      --attribute concern --value '"TODO: refactor"'

# 7. Consolidate older facts (LLM call)
PARALLAX_REFLECTION_MODEL=stub parallax reflect --older-than-days 30

# 8. Speculative branch GC (soft-delete only — facts never destroyed)
parallax branch --abandon plan-A
parallax gc-branches
```

## MCP integration

将以下内容添加到你的 MCP 客户端配置中:

```json
{
  "mcpServers": {
    "parallax": {
      "type": "stdio",
      "command": "parallax",
      "args": ["mcp", "serve"]
    }
  }
}
```

或者通过 Claude Code CLI:

```bash
claude mcp add --transport stdio parallax -- parallax mcp serve
```

## MCP tools surfaced (15)

| Tool | Read-only? | What it does |
|---|---|---|
| `parallax_analyze_diff` | ✅ | 对一组变更文件运行 impact analysis |
| `parallax_context_for_change` | ✅ | 为变更文件返回一个受预算约束的紧凑 context pack |
| `parallax_search_context` | ✅ | 按 keyword/path/symbol/relation/evidence 搜索最新已索引的 entity，并返回带 resource link 的排序后 context |
| `parallax_remember` | ❌ | 在某个 branch 上持久化一条 agent fact (entity, attribute, value) |
| `parallax_recall` | ✅ | 按 branch / entity / attribute / 语义查询检索 fact (sqlite-vec ANN，brute-force 兜底) |
| `parallax_profile` | ✅ | 三桶式的 per-entity 视图 (static / dynamic / summary) —  |
| `parallax_explain_entity` | ✅ | 针对单个已索引 entity 的紧凑直接 incoming/outgoing relation 与 evidence 视图 |
| `parallax_branch` | ❌ | 从已有 branch fork 出一个新 branch (无数据拷贝) |
| `parallax_merge` | ❌ | 连接两个 branch head 的 multi-parent merge transaction |
| `parallax_abandon_branch` | ❌ | 将一个 branch 标记为 state='abandoned' (幂等，main 受保护) |
| `parallax_restore_branch` | ❌ | 逆转 abandon+gc —— 在一次原子调用中将 `state='active'` 且 `archived=0` () |
| `parallax_gc_branches` | ❌ | 归档已废弃 branch 的 transaction (soft-delete)。`maxAgeDays` 可选启用基于时间的自动废弃 () |
| `parallax_reflect` | ❌ | 用 LLM 按 entity 将较旧的 fact 总结为 summary fact |
| `parallax_repair_reflections` | ❌ | 协调由 SAVEPOINT 原子性缺口遗留的孤立 summary fact () |
| `parallax_trace` | ✅ | 沿 fact_provenance 边回溯到 evidence 源 |

只读 resource: `parallax://reports/{id}`、`parallax://entities/{id}`、`parallax://evidence/{id}`、`parallax://reports/{id}/graph/{format}`、`parallax://coverage/latest`。

## Identity and invariants

- **Local-first 单一 SQLite `.db` 文件。** 默认不访问外部网络。整个 memory 层都存放在 `<repo>/.parallax/impact.db`。
- **Content-addressable fact id。** `id = SHA-256(entity || attribute || value || op)`。相同的 observation 永远不会重复。
- **ADD-only schema migration。** 列和表只会被添加；任何东西都不会被删除。在 `src/store.ts` 中由 allowlist 守护的 `tryAddColumn` 辅助函数。
- **Soft-delete only。** Fact 永远不会被 DELETE。Branch GC 归档的是 *transaction* (`transactions.archived = 1`)，从而让 recall 不再展示它们，但底层的 fact 行仍然存在，并且可能被其他 branch 引用。
- **Redact-then-prompt gate。** 所有 LLM 的输入/输出都会经过 `redactSecrets()` (11 个 secret 家族: OpenAI/Stripe/GitHub/Slack/AWS/Google/npm/JWT/Bearer/DB URL/Private key)。被 redact 的 fact 会得到 value_blob='[REDACTED]' 和零 embedding 行。
- **async-outside-tx pattern。** Embedding 和 LLM 计算发生在 SQLite transaction 打开 *之前*；同步的 `withAgentMemoryDb` 回调只负责写入。

## Lifecycle of a fact

```
attribute_defs.is_code_relation = 1  →  static fact (indexer-emitted)
attribute_defs.is_code_relation = 0  →  dynamic fact (agent-decision)
attribute = 'reflection'              →  summary fact ( consolidation)
```

`profile` 工具沿这条轴对 fact 进行划分。关于 lifecycle 是被推导出来而非被存储这一原则，参见 `docs/invariants.md`。

## When NOT to use

- 跨多用户的云托管 memory → 改用 [supermemory](https://supermemory.ai)。
- PDF / 图像 / 视频抽取 —— 不在范围内；parallax 专注于代码。
- 实时分析 dashboard —— 这是一个本地的单用户工具。

## Reference docs

关于深入的架构细节，参见 `references/architecture.md`。

关于完整的设计依据与决策记录，参见:
- `docs/vision.md` / `docs/vision.ko.md` — one-page thesis (start here)
- `docs/roadmap.md` — 横跨两条轴 (impact analysis + agent memory) 的统一 roadmap
- `docs/glossary.md` — 厘清两条轴上的 branch/entity/transaction
- `docs/invariants.md` — load-bearing 원칙
- `docs/vision.ko.md` — 프로젝트 방향성
- `docs/roadmap.md` — 다음 작업
