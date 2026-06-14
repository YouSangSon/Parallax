# Parallax 架构

[English](architecture.md) · [한국어](architecture.ko.md) · **中文**

深入剖析 Parallax 底层的工作原理。当你需要扩展系统、调试出乎意料的查询结果，或理解某个 invariant 背后的设计理由时，请阅读本文。

## 核心概念：构建在 SQLite 之上的代码感知 fact graph

Parallax 将所有内容以 content-addressable 的 fact 形式存储在单个 SQLite 数据库（`<repo>/.parallax/impact.db`）内的一个 transaction DAG 上。同一个数据库还保存：

- **代码结构**（entities、relations、evidence）——由 indexer 生成。
- **Agent 活动**（facts、transactions、fact_provenance、fact_embeddings）——在 MCP/CLI 命令被调用时写入。
- **反思式整合**（reflections audit、summary facts）——Phase 3 的 LLM pass。
- **Branch 生命周期**（branches.state、transactions.archived）——Phase 3 的推测性 branch GC。

三条主轴：

```
ENTITY ←──── FACT ────→ TRANSACTION
              │              │
              ↓              ↓
           PROVENANCE     BRANCH (head pointer)
              │              │
              ↓              ↓
           SOURCE        TX_PARENTS (DAG)
            FACT
```

## Schema 版本

| Version | Added | Why |
|---|---|---|
| v1-v3 | repos, files, symbols, edges, evidence, reports | MVP 代码 indexer |
| v4 | facts, transactions, branches, fact_provenance, embeddings, attribute_defs | Phase 1 agent memory |
| v5 | transaction_parents | 多 parent 的 merge transaction |
| v6 | fact_embeddings (model-agnostic, composite PK) | Phase 2 —— 自由切换模型 |
| v7 | branches.state, transactions.archived, fact_provenance.kind, reflections | Phase 3 —— reflection + branch GC |
| v8-v9 | (与 v7 reflection/branch-GC migration 一同应用的版本标记，无独立 DDL) | Phase 3/4 GC 排序 |
| v10 | context_tool_runs, context_resource_accesses | 本地 MCP context access telemetry（append-only） |
| v11-v14 | search_entities_fts, search_relation_evidence_fts, search_facts_fts + sync trigger | 用于 read-only context search 的持久化 FTS5 search projection |
| v15 | context_packs | 持久化的 MCP context pack（content-addressed 复用） |
| v16 | adapter_runs.confidence, adapter_runs.known_gaps_json | 在 adapter 级别报告 confidence 与已知 gap |

所有 migration 都是 **ADD-only**（只新增）。`src/store.ts` 中的 `tryAddColumn` helper 强制执行一份 `(table, column, definition)` 三元组的 allowlist，使未来的 ALTER 调用无法意外扩大 DDL 的影响面。

## Content-addressable fact id

```
fact.id = SHA-256(entity || ' ' || attribute || ' ' || value_blob || ' ' || op)
```

含义：fact 不存在原地更新。更新一个值意味着在一个新 transaction 上写入一个*新的* fact（其 id 因值不同而不同）。content-addressable 的设计理由参见 `docs/invariants.md` I-2。

实际后果：
- "User prefers React" → "User prefers Vue" 会产生两个 fact，两者都可被检索到。`--current-only` 这条 recall 路径按 `(entity, attribute, value_blob)` 分区，因此去重后只保留最新的那一个。
- 撤回一个旧 fact 会创建一行 `op='retract'`，其 content hash 骨架相同，但 op 被翻转。
- `as_of_tx` 时间旅行之所以可行，是因为每个 id 对应的 fact 都是不可变的。

## Agent memory 的六张表

```
attribute_defs   ← typed registry of attributes (name, value_type, is_code_relation, description)
branches         ← named heads with state ('active'|'abandoned'|'merged') and parent_branch_id
transactions     ← commits on a branch DAG (id, parent_tx_id, branch_id, ts, agent, archived)
transaction_parents ← multi-parent edges for merge transactions
facts            ← content-addressable rows (id, entity_id, attribute, value_blob, op, tx_id, redacted)
fact_provenance  ← causal links (fact_id, source_fact_id, kind ∈ {evidence, summary})
fact_embeddings  ← model-agnostic vectors (fact_id, model, vector, dim, created_at) — composite PK
reflections      ← audit of LLM consolidation passes (id, branch_id, model, summary_fact_id, source_fact_count, criteria_json, created_at)
```

## async-outside-tx invariant

`node:sqlite`（DatabaseSync）是同步的。如果在同步的 `withAgentMemoryDb` 回调内部运行了 `await`，数据库 handle 会过早关闭，导致被 await 的写入静默失败。

模式（来自 `src/agent_memory.ts:rememberOnRepo`、`src/reflection.ts:reflectFacts`）：

```typescript
// 1. Compute async work (embeddings, LLM calls) FIRST
const embedding = await computeEmbedding(text);
const summary   = await summarize(prompt);

// 2. Then open one short sync transaction
withAgentMemoryDb(repoRoot, false, (db) => {
  // BEGIN IMMEDIATE / COMMIT inside, sync only
});
```

这就是决策 D-005。每一个将 async 工作与 DB 写入混合在一起的新函数都必须遵循它。

## Recall 路径

`src/agent_memory.ts:recall()` 从一个由条件构成的小型 DSL 生成单条 SQL 语句。三种正交模式：

1. **Branch + filter**（默认）：`WHERE t.branch_id = ? AND t.archived = 0 AND f.entity_id = ? AND f.attribute = ?`
2. **as_of_tx 时间旅行**：用一个从给定 tx 出发、沿 `transaction_parents` 游走的递归 CTE 替换 branch filter；archived=0 仍然生效。
3. **--current-only**：用一个 `ROW_NUMBER() OVER (PARTITION BY entity_id, attribute, value_blob ORDER BY ts DESC)` filter 包裹结果，只保留 `rn=1 AND op='assert'`。

`recallSemantic()` 是一条独立路径：调用方预先计算好 query embedding，SQL 对按 `model = ?` 过滤的 `fact_embeddings` 做 JOIN，返回带 int8 向量的行，函数在 JS 中用 int8 点积进行排序（由于向量经过 L2 归一化，因此 ≈cosine similarity）。

`trace()` 是第三条路径：从一个 fact 出发，沿 `fact_provenance` 边做 BFS。同样会过滤 `t.archived = 0`（在 Phase 3 的 architect-review pass 中加入）。

## Profile API（Phase 4）

`src/profile.ts:profileEntity()` 返回三个 readonly 数组：

- `staticFacts`：`is_code_relation = 1`（indexer 产出的代码结构）
- `dynamicFacts`：`is_code_relation = 0` 且 `attribute != 'reflection'`（agent 活动）
- `summaryFacts`：`attribute = 'reflection'`（Phase 3 LLM 整合的产物）

实现说明：单条 SELECT 按 `t.ts DESC, f.id ASC` 拉取所有匹配的 fact，随后内存中的循环将其分桶。每个桶各自独立地以 `k`（默认 50，最大 200）为上限截断。

这就是决策 D-014：profile 构建在 recall 之上，而不是合并进 recall。recall 仍然是一个原始的 history 视图；profile 是一份聚合后的快照。

## Reflection 流水线（Phase 3）

```
reflectFacts(repoRoot, options)
  ├── collectCandidates: stream facts via iterate(),
  │   group per entity, cap at MAX_FACTS_PER_ENTITY (default 50, env override)
  ├── per-entity:
  │   ├── renderUserPrompt: bullet list + truncation footer
  │   ├── summarize: LLM call (stub | ollama | anthropic | openai), redact in/out
  │   ├── computeEmbedding: vector for the summary
  │   └── push draft (no DB write yet)
  └── persistReflections: per-draft SAVEPOINT around
      remember() + UPDATE provenance kind='summary' + INSERT reflections audit
```

内存复杂度：`O(unique_entities × MAX_FACTS_PER_ENTITY)`，这得益于流式 iterate 加上 per-entity 上限。没有这两者，百万级 fact 的 repo 会占用数 GB。

## Branch GC

仅做软删除。`gcBranches()` 找出满足 `state='abandoned' AND name != 'main'` 的 branch，并为每个 branch 的 transaction 设置 `transactions.archived = 1`。**Fact 永远不会被删除**，因为它们是 content-addressable 的，并可能被其他（active 的）branch 引用。把 fact 从 recall 中隐藏起来，正是 `archived = 0` 过滤所完成的工作。

`abandonBranch('main')` 会抛错——受保护 branch 的 invariant 存在于两个地方：函数内的 guard，以及 `gcBranches` SQL 中的 `WHERE name != 'main'` 子句。

## Redact-then-(everything)

`src/security.ts:redactSecrets()` 在三个点位被应用：

1. **存储**（`remember`）：如果脱敏改变了字符串，fact 会以 `value_blob='[REDACTED]'`、`redacted=1` 存储，并且 **不向 fact_embeddings 添加任何行**（zero-row 策略，D-004）。
2. **Embedding**（`reembed`/`computeEmbedding` 的调用方）：被脱敏的 fact 会被排除在 embedding 输入之外。
3. **LLM**（`reflection`）：脱敏在 fetch 之前对 system prompt + user prompt 运行，并在将 LLM 原始输出存为 summary fact 之前对其运行。

12 个 secret family：OpenAI / Stripe / GitHub / Slack / AWS access key / AWS secret / Google API / npm / JWT / Bearer / DB URL / Private key block。

## LLM provider 抽象

`src/llm.ts:summarize()` 根据 `PARALLAX_REFLECTION_MODEL` 的前缀进行分派：

| Prefix | Provider | Endpoint default |
|---|---|---|
| `stub` | In-process deterministic summary | (none) |
| `ollama:<model>` | Ollama local HTTP | `http://localhost:11434/api/chat` |
| `anthropic:<model>` | Anthropic Messages | `https://api.anthropic.com/v1/messages` |
| `openai:<model>` | OpenAI Chat Completions | `https://api.openai.com/v1/chat/completions` |

所有 provider 都使用 Node 24+ 原生的 `fetch`——没有任何 SDK 依赖（D-012）。Anthropic/OpenAI 的 base URL 会被断言为 `https://`。这三个网络 provider 都把 fetch 包裹在 try/catch 中，并应用一个 30s 的 `AbortSignal.timeout`（可通过环境变量 `PARALLAX_LLM_TIMEOUT_MS` 覆盖）。

## 决策速查表

| ID | Decision | What it constrains |
|---|---|---|
| D-001 | local-first single SQLite | no external services |
| D-002 | content-addressable fact id | facts are immutable per id |
| D-003 | ADD-only migration | tryAddColumn allowlist |
| D-004 | redact-then-embed zero-row | redacted → no embedding row |
| D-005 | async outside SQLite tx | embedding/LLM happens first |
| D-006 | multi-parent transactions | branch merge via transaction_parents |
| D-007 | model-agnostic embeddings | composite PK lets multiple models coexist |
| D-008 | multi-provider LLM via prefix sentinel | stub / ollama / anthropic / openai |
| D-009 | explicit reflect trigger | no daemon |
| D-010 | preserve original facts in reflection | summary fact + kind='summary' edge |
| D-011 | soft-delete branch GC | transactions.archived, never DELETE facts |
| D-012 | no LLM/embedding SDKs | fetch only |
| D-013 | lifecycle from is_code_relation | no new is_static column |
| D-014 | profile is built on top of recall | separate function, not a recall mode |
| D-015 | reflect --repair as separate trigger | not auto-on-reflect |
| D-016 | branch --restore bundles state + tx unarchive | one atomic call |
| D-017 | auto-abandon piggybacks on gc-branches --max-age | opt-in flag, no default |
| D-018 | sqlite-vec ANN with per-model vec0 | lazy create, brute-force fallback |

承重原则参见 `docs/invariants.md`。

## 代码库布局

`src/` 按职责组织。这张地图展示每个关注点所在的位置，便于你知道该阅读或扩展哪个文件。

**Entry & orchestration**

| Path | 职责 |
|---|---|
| `src/index.ts` | Public API barrel —— 重新导出受支持的编程接口 |
| `src/cli.ts` | CLI dispatch（命令 if-chain、flag 解析、帮助文本） |
| `src/indexer.ts` | 索引流水线 + `createDefaultRegistry`（按顺序接线各 adapter） |
| `src/analyzer.ts` | 在已索引图上计算 impact |
| `src/graph.ts` | 图 export |
| `src/store.ts` | SQLite schema、ADD-only 迁移与 DB 访问辅助函数 |
| `src/types.ts` | 共享类型定义 |
| `src/confidence.ts` | 共享 confidence 守卫（`asConfidence`，强制转换为合法的 `Confidence`） |

**MCP surface**

| Path | 职责 |
|---|---|
| `src/mcp.ts` | MCP 服务器：tool/resource 注册 + context-pack 粘合 |
| `src/mcp_search.ts` | 搜索子系统 —— keyword/FTS/semantic/graph-proximity 排序 + 行查询 |
| `src/mcp_shared.ts` | `mcp.ts` 与 `mcp_search.ts` 共享的 DB 辅助函数 |
| `src/context_pack.ts` | Context-pack 构建 / freshness / compaction 流水线 |

**Adapters**（`src/adapters/`）

| Path | 职责 |
|---|---|
| `src/adapters/registry.ts` | First-match-wins 派发，catch-all 置于最后 |
| `src/adapters/types.ts` | `SemanticAdapter` 契约（descriptor、pending entity/relation/evidence） |
| `src/adapters/multi-language-regex.ts` | 宽泛的 multi-language catch-all adapter |
| `src/adapters/config-infra.ts` | Config / infrastructure 文件 adapter |
| `src/adapters/build-system-package.ts` | Build-system / package-manifest adapter 入口 |
| `src/adapters/build-system/{npm,maven,gradle,go,cargo,python}.ts` | 各生态系统的 manifest 解析器 |
| `src/adapters/build-system/{shared,types}.ts` | 各生态系统解析器共享的辅助函数与类型 |

**Contracts**

| Path | 职责 |
|---|---|
| `src/contract_diff.ts` | 编排器 —— 派发到各格式的分类器 |
| `src/contract_diff/{openapi,asyncapi,protobuf,graphql}.ts` | 各格式的兼容性分类器（生成 diff 变更） |
| `src/contract_diff/{shared,types}.ts` | 分类器共享的辅助函数与类型 |
| `src/{openapi,graphql,protobuf,asyncapi}_compat.ts` | 抽取结构化兼容性签名（供分类器消费）的低层解析器 |

**Agent memory**

| Path | 职责 |
|---|---|
| `src/agent_memory.ts` | remember/recall/trace + branch + `withAgentMemoryDb` |
| `src/reflection.ts` | Phase 3 LLM 整合流水线（summary fact） |
| `src/profile.ts` | Phase 4 聚合的 entity 快照（构建在 recall 之上） |
| `src/branch_gc.ts` | Soft-delete branch GC（`gcBranches`） |
| `src/session_import.ts` | 将 Codex/Claude 会话记录导入为 fact |
| `src/embeddings.ts` | Embedding provider 抽象（prefix-sentinel） |
| `src/llm.ts` | LLM provider 抽象（`summarize`，prefix-sentinel） |

**Workspace & cross-repo**

| Path | 职责 |
|---|---|
| `src/workspace.ts` | Workspace 目录（具名的 multi-repo 成员关系 + trust policy） |
| `src/cross_repo_resolver.ts` | 在 workspace 范围内解析 cross-repo 契约链接（例如 `CONSUMES_HTTP_ENDPOINT`） |

**UI**（`src/ui.ts` + `src/ui/`）

| Path | 职责 |
|---|---|
| `src/ui.ts` | UI 服务器 + `renderUiHtml` 组合 + 快照构建 |
| `src/ui/styles.ts`、`src/ui/client.ts` | 抽取出的静态 CSS / 客户端 JS |
| `src/ui/impact_map.ts` | Impact-map 渲染 |
| `src/ui/report_delta.ts` | Report-delta 策略 + 渲染 |
| `src/ui/shared.ts` | 共享的 UI 呈现辅助函数 |

**Supporting**

| Path | 职责 |
|---|---|
| `src/security.ts` | 秘密 redaction + 边界处的 path/root 归一化 |
| `src/artifacts.ts` | Work-artifact（markdown doc/policy/proposal/…）分类 |
| `src/git-snapshot.ts` | Git commit/branch/dirty 快照捕获 |
| `src/doctor.ts` | 环境/健康诊断 |
| `src/init.ts` | 项目初始化（`.parallax/` config + DB） |
| `src/branding.ts` | 产品/包名称、`.parallax` 数据目录、`PARALLAX_*` env 读取器 |

## 扩展时首先该看哪里

- 新表 → `src/store.ts:migrate()`（并更新 tryAddColumn 的 allowlist）
- 新 CLI 命令 → `src/cli.ts` 的 if-chain + `valueFlags` Set + `printHelp`
- 新 MCP tool → `src/mcp.ts` 的 `server.registerTool` 块（如实标注 readOnlyHint/destructiveHint）
- 新 adapter → 实现 `src/adapters/types.ts` 中的 `SemanticAdapter` 契约，并在 `src/indexer.ts:createDefaultRegistry` 中注册（顺序很重要 —— catch-all 保持最后）；多文件 adapter 可参照 `src/adapters/build-system/`
- 类似 profile 的新聚合 API → 考虑构建在 `recall`/`recallSemantic`/`trace` 之上，而不是复制粘贴它们的 SQL
- 新的外部集成（LLM、embedding 等）→ 仿照 `src/llm.ts` 或 `src/embeddings.ts` 中的 prefix-sentinel 模式
- 改变 invariant 的新行为 → 先在 `docs/invariants.md` 中更新并附上设计理由
