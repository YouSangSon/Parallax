# Parallax 术语表

[English](glossary.md) · [한국어](glossary.ko.md) · **中文**

本项目有两条轴（影响分析 + 代理记忆），它们共存于同一个 SQLite 之上，并使用*重叠的词汇*。本文档用于消除这种歧义。想要快速答案请看下表，想要精确定义请看下面的各节。

| 术语 | 影响分析轴 | 代理记忆轴 |
|---|---|---|
| **branch** | 无意义（该轴只处理 git branch） | `branches` 表中的一行 —— head_tx_id 所追踪的 *speculative line of work* |
| **entity** | `entities` 表 —— 代码中可识别的单元（file/symbol/module/contract/policy 等 21 种） | fact 的*主语*字符串（如 `'file:src/foo.ts'` 这样的自由标识符） |
| **transaction** | 无意义 | `transactions` 表中的一行 —— 一个 commit 单位的 *fact 集合*（通过 parent_tx_id 形成 DAG） |
| **relation** | `relations` 表 —— entity↔entity（DEPENDS_ON, CALLS, IMPLEMENTS, EXTENDS 等） | 不使用（改用 `fact_provenance` edge） |
| **fact** | 不使用 | `facts` 表 —— content-addressable 观察（`(entity, attribute, value, op)` 的 SHA-256） |
| **report** | `reports` 表 —— analyzer 生成的影响度分析结果 | 不使用 |

---

## 影响分析轴的核心术语

### entity (impact)
`entities` 表中的一行。是 file / symbol / module / package / test / doc / config / policy / workflow / resource / endpoint / contract / event / business_plan / ... 等 21 种中的一种。影响分析沿着 entity 之间的 relation graph 计算 blast radius。

### Entity kind classification

Parallax 在写入 report 或 graph export 之前，会通过一个 shared path policy 对 file-backed entity 进行分类。Test naming 最先匹配，Markdown work artifact 使用 artifact-specific kind，`CODEOWNERS` 是 policy，GitHub workflow YAML 是 workflow，OpenAPI/Swagger/AsyncAPI 文件以及 protobuf/GraphQL schema 是 contract，Dockerfile/Terraform 文件是 resource，package/build/config manifest 是 config。

### relation (impact)
`relations` 表。`(source_entity_id, target_entity_id, kind, confidence, adapter_run_id)`。kind 是 `RelationKind` 中定义的值之一，如 `DEPENDS_ON`、`DECLARES`、`CALLS`、`REFERENCES`、`VERIFIES`、`DOCUMENTS`、`CONFIGURES`、`OWNS`、`GOVERNS`、`IMPLEMENTS`、`EXTENDS`、`BREAKS_COMPATIBILITY_WITH` 等。

### relation_evidence
支撑某条 relation 的 source span / 命令输出 / confidence 依据。即“为什么提取了这条 relation”的 audit trail。

### contract / endpoint / event
`contracts`、`cross_repo_links` 表。把 OpenAPI / protobuf / GraphQL / AsyncAPI 建模为 entity，从而分析 *cross-repo* 影响（provider repo 的 API 变更 → consumer repo 损坏）。

### workspace
`workspaces`、`workspace_repos` —— 把多个 repo 归并为一个*产品/组织边界*的 logical 单元。在单个 repo 中无意义。

### adapter_run
一次 indexing pass 的元数据 —— adapter ID、version、confidence、known gap、error summary。用于追踪 coverage gap 以及各 adapter 的分析可信度。

---

## 代理记忆轴的核心术语

### fact
`facts` 表。一行 = 一次观察。**PK 是 SHA-256(`entity || attribute || value_blob || op`)**（D-002）。相同的 (entity, attribute, value, op) 元组永远得到相同的 id → 自动 dedup。

| 列 | 含义 |
|---|---|
| `id` | content-hash PK |
| `entity_id` | fact 的*主语* —— 自由字符串（`'file:src/foo.ts'`、`'task:T-1234'`、`'agent:claude'`） |
| `attribute` | *谓语* —— `'observed'`、`'verified'`、`'imports'`、`'reflection'` 等 |
| `value_blob` | JSON-encoded 值 |
| `op` | `'assert'` 或 `'retract'` |
| `tx_id` | 创建该 fact 的 transaction |
| `redacted` | 为 1 表示 value 以 `'[REDACTED]'` 存储（D-004） |

### transaction (memory)
`transactions` 表。一个 commit 单位的 *fact 集合*。`parent_tx_id`（linear）+ `transaction_parents(tx_id, parent_tx_id)`（multi-parent，用于 merge）。recall 通过 recursive CTE 进行 walk。

| 列 | 含义 |
|---|---|
| `id` | content-hash (parent_tx_id, branch_id, ts, agent) |
| `parent_tx_id` | 紧邻的前一个 tx（linear） |
| `branch_id` | 属于哪个 branch |
| `ts` | ISO 8601 `'YYYY-MM-DDTHH:mm:ss.sssZ'` |
| `agent` | 由谁创建（`'mcp:remember'`、`'reflect:branch=main'` 等） |
| `archived` | 为 1 表示已被 gc-branches archive（D-011） |

### branch (memory)
`branches` 表 —— agent 的 speculative line of work。与 git branch 是*独立的概念*。同一个 repo 中可以有多个 memory branch（`main`、`experiment-a`、`plan-B`）。每个 branch 的 head_tx_id 指向自己的 latest tx。

| 列 | 含义 |
|---|---|
| `name` | UNIQUE —— `'main'` 为 PROTECTED |
| `head_tx_id` | 最新 tx（为 NULL 表示空 branch） |
| `parent_branch_id` | fork 来源 |
| `state` | `'active'` / `'abandoned'`（D-011 soft-delete） |

### fact_provenance
fact 之间的 provenance chain。`(fact_id, source_fact_id, kind, tx_id)` —— `kind` 取 `'evidence'`（由 indexer/agent 生成的依据）、`'summary'`（Phase 3 reflective consolidation 的 source）、`'supersedes'`（新 fact 显式替换旧的 decision/summary/policy fact）。`tx_id` 是该 edge 被创建的 transaction，因此即使 content-addressed replacement fact 被复用，也能准确判断 branch/as-of visibility。`trace` 会同时返回 edge kind，而 recall/profile 的当前 view 会隐藏 superseded fact。

### reflection
`reflections` 表 —— Phase 3 reflective consolidation 的 audit row。*summary fact* 以 `facts.attribute = 'reflection'` 存储，reflections 表则记录模型/输入 fact 数量/创建时刻。若出现 orphan 状态，由 `reflect --repair`（D-015）进行补偿。

### profile
`profileEntity()` 的结果 —— 把一个 entity 的 facts 分割为 3-bucket：**staticFacts**（代码关系，`is_code_relation=1`）/ **dynamicFacts**（代理活动）/ **summaryFacts**（reflection）。通过 D-014 与 recall 分开 export。

### lifecycle
attribute 的 binary 分类 —— `'static'`（代码关系，永久）vs `'dynamic'`（代理活动，易失）。在 D-013 中无需新列，而是在 query-time 从 `attribute_defs.is_code_relation` derive。

### fact_embeddings (canonical) vs vec_facts_<model_slug> (ANN index)
| 表 | 角色 |
|---|---|
| `fact_embeddings(fact_id, model, vector BLOB int8, dim, created_at)` | **canonical** —— D-007 multi-model PK；brute-force recall 使用 |
| `vec_facts_<model_slug>(fact_id TEXT PK, embedding int8[<dim>])` | **ANN index**（D-018）—— sqlite-vec vec0，在首次 dual-write 时 lazy-created，per-model |

---

## 容易混淆的成对术语

### branch (git) vs branch (memory)
同一个单词，*完全不同的概念*。git branch 由 git 本身管理，parallax 不直接访问。memory branch 是 `branches` 表中的一行，通过 `branch --name foo` / `branch --abandon foo` / `branch --restore foo` / `merge` 命令来处理。

### entity (impact) vs entity_id (memory)
- impact 的 entity 是 `entities` 表中的 *struct*（id + kind + version + source span）。
- memory 的 `entity_id` 是*字符串* —— 可以是任何自由标识符（`'file:src/foo.ts'`、`'pr:42'`、`'concept:auth'`）。记忆轴*不读取* entity 表；当两条轴使用相同的字符串时（`'file:src/foo.ts'`）会自然形成 cross-reference，但并不强制。

### transaction (DB) vs transaction (memory)
- DB transaction：`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`。SQLite 级别的 atomic write 单位。
- memory transaction：`transactions` 表中的一行。*逻辑 commit unit* —— 一次 `remember()` 调用创建一个 memory tx，并在其中添加一个 fact。Memory tx 总是在一个 DB tx 之内创建。

### fact vs relation
- impact axis：relation（entity ↔ entity）。
- memory axis：fact（entity + attribute + value）。
- 二者是*不同的列集、不同的表*。这是有意的分离 —— relation 是 typed graph，fact 是 free-form key-value with content addressing。

### static fact vs dynamic fact vs summary fact
- **static fact** —— 用 `attribute_defs.is_code_relation = 1` 的 attribute 创建的 fact（`imports`、`calls`、`affects`、`depends_on`）。由 indexer 添加；表达代码结构。
- **dynamic fact** —— `is_code_relation = 0` 的 attribute（`observed`、`verified`、`concern`）。代理活动。
- **summary fact** —— `attribute = 'reflection'` 的 fact。由 Phase 3 reflective consolidation 生成的*原始内容的摘要*。通过 D-010 保留原始内容。

### reflect vs repair (vs reindex-vec)
- `reflect` —— 用 LLM 对陈旧的 facts 进行摘要（Phase 3，D-009 explicit trigger）。
- `reflect --repair` —— 对 orphan summary fact 进行补偿 sweep（D-015，Phase 4 P2）。
- `reindex-vec` —— 从已有的 `fact_embeddings` 对 `vec_facts_<model>` 表进行 backfill（D-018，Phase 4 P5）。
- 三者都*仅有显式 trigger*，没有 daemon（D-009）。

---

## SQLite 格式备注

- 所有 ts 都是 ISO 8601 UTC `'YYYY-MM-DDTHH:mm:ss.sssZ'`（`new Date().toISOString()`）。
- 例外：`branches.created_at` 仅在 `main` 行采用 SQLite `datetime('now')` 格式（`'YYYY-MM-DD HH:MM:SS'`）。由于 main 是 PROTECTED 而被排除在比较之外，因此没有影响。
- 所有 binary 数据都是 BLOB（vector 是 int8 packed Buffer）。
- 所有 JSON 数据都是 TEXT 列 + JSON.stringify（为了 D-002 content-hash 的稳定性，key 顺序采用 V8 默认）。
