# Parallax — 愿景

**一句话：** Parallax 是一个 **local-first impact context layer**，让 Claude Code、Codex 这样的 *AI 编码 agent* 和人看到同一张关系图谱——它连接代码、文档、政策、提案、决策，在减少 agent 反复读取 repo 所耗费的 context 的同时，通过 MCP 和 UI 告诉你代码变更前后*哪些会受到影响*。


## 命题 (thesis)

AI 编码 agent（Claude Code、Codex、Cursor 等）很强大，但问题在于*无状态*。每个会话都是 cold start——重新读取 repo，记不住尝试过什么，对“这个 commit 实际影响到哪里”也没有共享模型。在人看来同样如此：代码、文档、政策、提案、客户需求散落各处，很难在一个画面里看清变更的波及范围。Parallax 以 local-first 的方式填补这一缺口：

- **Impact context 轴** —— 在 agent（或人）即将改动文件/函数/配置/工作流/contract/政策/文档之前，连同 evidence + confidence 一起告诉你 *repo 内部和 repo 之间*有哪些会受到影响。同时用 precomputed graph 和 compact context pack 减少 agent 所用的 context。
- **Agent memory 轴** —— 每当 agent 观察/决策/撤回/总结/handoff 时，以 content-addressable fact + provenance 的形式存储，后续调用通过 entity / attribute / branch / 时间 / semantic similarity 来 recall。
- **Human UX 轴** —— 把同一张 relation graph 以人可探索的 UI 呈现。核心不是 graph DB，而是把存储在 SQLite 中的 canonical graph 投影成可过滤、可搜索、可对 evidence drill-down 的画面。

三个轴共享**同一个 SQLite 文件** `<repo>/.parallax/impact.db`。agent 通过 **MCP tools/resources** 读取，人通过 **CLI/graph export/UI** 查看。*代码分析器、memory、UI 并非各自为政，而是同一个 impact context layer 的不同 surface*。

## 产品形态

| Surface | 角色 | 用户得到什么 |
|---|---|---|
| **MCP server** | 向 Claude/Codex/Cursor 提供 compact impact context 和 resource URI | agent 在修改前后不会漏掉相关的代码、测试、文档、政策、提案，同时减少整文件 dump 和反复探索所耗的 context |
| **CLI** | 在本地执行 index/analyze/graph/export/remember/recall | 易于接入 CI、pre-commit、agent hook、手动验证 |
| **UI explorer** | 让人探索 relation graph、evidence、coverage gap、changed/affected path | 让代码之外的相关方也能看清“为什么这个文件和文档会受影响” |
| **Local SQLite store** | canonical source of truth | 无需 graph DB 或 cloud 即可复现，且不把敏感的 repo 信息发往外部 |

代表性行为：

1. 用户用 Claude/Codex 修改代码。
2. Parallax 把 diff 映射到 entity graph 上。
3. 连同 evidence 一起找出相关的代码、测试、config、CI、政策、文档、PRD/提案/决策记录。
4. MCP 给 agent 提供“做这个变更时需要知道的上下文”和“需要验证的 action”。
5. UI 以 changed → affected → evidence → action 的流程展示同样的结果。

## 为谁而做

| 对象 | 使用场景 |
|---|---|
| **AI 编码 agent**（Claude Code、Codex、Cursor、自定义 MCP 客户端） | 在修改代码前注入*影响上下文*；recall 相关的代码/文档/政策/提案；跨会话持久化观察 |
| **采用 agentic 工作流的工程师** | 在 CI / pre-commit 中做本地影响分析；审计“agent 做这个变更时知道些什么” |
| **reviewer / PM / 运维负责人** | 在 UI 中查看变更的影响路径与 evidence；确认代码变更对政策/文档/客户承诺的影响 |
| **工具构建者**（其他 MCP server、IDE 插件） | 用作位于一次性 agent 循环*之下*的 durable layer |

## 为什么是 local-first

Local-first 是根基——所有数据都在 `<repo>/.parallax/impact.db`。无外部服务，无 cloud sync，不强制 graph DB。原因：

1. **源代码是敏感的** —— 把私有 repo 的结构发往外部服务，对许多团队来说是 non-starter。
2. **安装成本** —— 每一个外部 dep（Postgres、Neo4j、hosted vector DB）都会让安装阻力翻倍。SQLite 在每台机器上都已存在。
3. **离线可靠性** —— agent 必须在飞机上、在 SCIF 里、在防火墙后面也能工作。
4. **单文件可移植性** —— `impact.db` 可复制、可 diff、可归档、可沙箱化。

代价：在大规模下会遇到 brute-force 的瓶颈。sqlite-vec ANN 是第一道应对；之后再探索 partitioning + retention 策略。

## 身份 invariants（没有新的决定就不会重新考虑的原则）

在提出大的变更之前先读 [invariants.md](invariants.md)。核心：local-first 单一 SQLite、content-addressable fact、ADD-only migration、redact-then-embed、fetch-only (no SDK)、explicit triggers (no daemon)、read-only agent surface first、actions are recommendations、evidence first。

## 三年愿景

**第 1 年（现在）：** 在 single repo + single agent 上让 MCP impact context 可靠地工作。影响分析对 TS/JS 做深，对其他语言做 broadly。agent memory 采用 deterministic stub embedding + 4 个 LLM provider + sqlite-vec ANN。MCP context pack 通过 `brief`/`standard`/`deep` budget 和 resource-on-demand 减少 agent 的 context 用量。UI 从读取已存储的 report/graph 的第一个 explorer 起步。

**第 2 年：** Cross-repo workspace catalog + multi-agent memory handoff。Adapter coverage 达到“tier-1 enterprise stack”（TS、Python、Go、Rust、Java/Kotlin、C#、C/C++ + YAML/Terraform/Kubernetes/OpenAPI/protobuf）。

**第 3 年：** MemoryBench harness 提供回归信号，使 memory 工作的质量*可度量地*改进（交叉比较 embedding 模型 / LLM provider / reflection 算法）。UI、graph DB projection、IDE/plugin surfaces 成为 first-class consumer，而 parallax 始终保持为 canonical SQLite source of truth。

## *不会*去做的事

这些条目经过审议后被否决——context 见 [invariants.md](invariants.md)。要重新提议需要另行讨论。

- **强制 graph DB。** Source of truth 保持为 SQLite。
- **强制 cloud sync。** Local-first 是身份，而非某个 phase。
- **Daemon / 后台进程。** 所有操作都由用户 trigger。
- **LLM/embedding SDK。** 只用 `fetch`，每个 provider 约 30 LOC。
- **自动修改代码。** 只做推荐，不去执行。
- **同时对所有语言做完整的 full semantic 分析。** Tier adapter（P1 → P2）在做深之前先确保广度。

## repo 导览指南

| 如果你是 ... | 起点 |
|---|---|
| 初次进入的 AI agent/工程师 | [README.md](../README.md) → 本文件 → [invariants.md](invariants.md) |
| 寻找下一项工作的 contributor | [roadmap.md](roadmap.md) |
| 对术语感到困惑的人 | [glossary.md](glossary.md) |
