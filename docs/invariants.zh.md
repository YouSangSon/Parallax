# 不变原则 (Invariants)

> 即使项目重新开始也不会被打破的核心决策。新的决策须在不违反本文档的前提下做出。

---

## I-1. Local-first, single SQLite DB

所有数据都存储在唯一的 `<repo>/.parallax/impact.db` 中。不依赖外部服务（graph DB、hosted vector store、cloud sync）。首次启动时创建 fresh DB，schema migration 在打开 DB 时自动执行。

**为什么不能打破：**

- 把代码结构发送到外部服务，对许多团队来说是 non-starter。
- 一个外部依赖会让安装摩擦翻倍。SQLite 在任何地方都已经存在。
- 在飞机上 / SCIF / 防火墙之后也必须能工作。
- 单一文件易于复制、diff、archive 和 sandbox。

## I-2. Content-addressable fact id (SHA-256)

`fact.id = SHA-256(entity || attribute || value_blob || op)`。相同的 (entity, attribute, value, op) 元组始终得到相同的 id。dedup 成本为 0。

## I-3. ADD-only schema migration

不修改或删除已有的列。始终采用新增列/表的方式。以旧 schema 打开的 DB 也必须能继续读取。

## I-4. Redact-then-embed (zero-row policy)

检测到 secret 模式的值，必须在 redaction 之后才能进入 embedding 流水线。原始值在 fact value 中也以 redact 后的状态存储。在调用外部模型之前，redaction 必须无条件先行。

## I-5. Async work outside SQLite transaction

LLM 调用、embedding 计算、网络 fetch 等 long-running 作业都在 SQLite transaction 之外进行。把 DB 锁定时间保持在 ms 级别。

## I-6. Explicit triggers, no daemon

reflect/index/gc 等清理作业只能通过显式的 CLI/MCP 调用执行。不创建 background worker 或守护进程。用户始终知道何时有哪些作业在运行。

## I-7. No LLM/embedding SDKs (fetch only)

不把 OpenAI/Anthropic/HuggingFace SDK 加入依赖。需要时直接用 `fetch` 调用。避免让 SDK 更新左右项目的依赖体量。

## I-8. Read-only agent surface first

MCP 先把安全的 read-only 分析表面稳定下来。write 权限要经过单独的建模和评审之后再添加。通过默认值阻止 agent 误执行 destructive 操作。

## I-9. Actions are recommendations

不自动执行测试或评审 command。以 `command + args` 结构仅做推荐。执行的责任在于人或上层 agent。

## I-10. Evidence first, no silent certainty

所有影响度判断都必须同时带有 evidence + provenance + confidence。对于不知道的内容，要以 `unknown` / coverage gap / missing adapter 的形式明确显示出来。不把推测值当作事实返回。
分析报告还要一并暴露 adapter run 单位的 confidence 和 known gap，使 agent 和人能够区分 parser-backed 结果与 broad heuristic coverage。
