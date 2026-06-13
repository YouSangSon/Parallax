# Parallax — 价值主张文档

[English](value-proposition.md) · [한국어](value-proposition.ko.md) · **中文**

> **本文档的作用：** 一份压缩成一页的活文档，让公司内部开发大赛的评委能在 5 分钟内抓住 *是什么、为什么、有何不同*。随开发进展持续完善。
>
> **最后更新：** 2026-04-30
>
> **建议一并阅读的文档：**
> - 面向用户的 README: [`README.zh.md`](../README.zh.md)
> - 整体设计笔记: [`docs/agent-db-exploration.ko.md`](agent-db-exploration.ko.md)
> - 使用流程·示例: [`docs/agent-memory-cookbook.ko.md`]
> - 进展现状: [`docs/progress.ko.md`]
> - 下一个里程碑: [`docs/phase3-handoff.ko.md`](phase3-handoff.ko.md)

---

## 1. 一句话概括

> **一个本地工具，把"代码库地图"和"昨天想法的笔记"一起交到 AI 编码工具（Claude Code、Codex 等）手里。仅用单个 SQLite 文件，零外部依赖。**

## 2. 要解决的问题 — 两个烦恼

在实务中使用 AI 编码工具时，有两件事很碍眼。

### 问题 1. AI 在不知道"哪里会坏掉"的情况下改代码

改动 `auth.ts` 里的一个函数，可能会让另外 7 个使用该函数的文件一起坏掉。
人类开发者会用 grep 来确认，而 AI 只凭自己 head 里的猜测行事。

→ **必须事先展示变更影响范围。**

### 问题 2. AI 把昨天做的决定全忘光

即使今天 AI 判断 *"这段认证逻辑是因为安全问题才用 X 方式写的"* 并据此写了代码，
到了下一个 session，这个判断也消失了。聊天一结束就挥发掉。

→ **必须把决定、观察、依据永久保存并可检索。**

## 3. 核心洞察 — 两者其实是同一份数据

> **"代码影响范围分析"和"AI memory"两者归根结底都是在保存 *"X 如何连接到 Y，其证据是什么"*。**

仅凭这一个洞察，系统就变简单了。在**单个 SQLite 文件**里对两条轨道做*双写（dual-write）*。

- 索引器发现一行 `import` → 在 `relations` 表写一行 + **同时**在 `facts` 表写一行。同一个事务。
- 这样一来，AI 一旦问 *"为什么你认为这个文件受影响？"*，就能沿着 `fact_provenance` 链逆向回溯，一直到达原始代码片段。

没有 graph DB，没有 vector DB，没有外部缓存 —— 一个文件。

## 4. 四大核心价值

### V1. Local-first，单一文件，零外部依赖

所有东西都装进 `.parallax/impact.db` 这一个文件。
- 对公司内部安全策略友好 —— 代码和决定数据不离开用户 PC
- 备份：复制一个文件即可 / 也可以 commit 到 git 与团队共享
- 连 embedding 都在 in-process 完成（`@huggingface/transformers` ONNX）—— 零外部 API 调用

### V2. 把时间/分支/因果作为一等公民

借用 Datomic 和 git 的一个模式，用同一套机制实现三种功能。

| 功能 | 怎么做 |
|---|---|
| 时间旅行（"5 个回合前是什么样？"） | `as_of_tx` 递归 CTE |
| 分支（同时模拟多个 plan 后再采纳） | branch fork/merge，零数据复制 |
| 因果链（"这个决定的依据是什么？"） | `fact_provenance` BFS |

### V3. 代码图与 memory 的统一检索

不必分别查看多个工具，只需**一次查询**就能拿到 **"关于这个文件已知的一切"**：

- 谁 import 它（代码关系）
- AI 过去做的决定（memory）
- 该决定的依据片段（provenance）

这些一次性在同一个响应里返回。

### V4. 密钥保护自动化

在索引、保存阶段对密码、API 密钥、private key 模式自动 redaction。
此外还有 **redact-then-embed 门控**：一旦捕获到密钥，就根本不创建 embedding row —— 密钥也不会泄漏到向量空间。

## 5. 与同类服务的差异

按评委常会联想到的对比对象逐一梳理。

### vs. Claude 自带 memory / ChatGPT memory

| 维度 | Claude·GPT memory | Parallax |
|---|---|---|
| 存储形态 | 自由文本（markdown） | 结构化 fact（entity, attribute, value） |
| 时间/分支 | 无（覆盖即消失） | as_of 时间旅行 + branch |
| 因果追踪 | 无 | fact_provenance 链 |
| 代码图整合 | 无 —— 代码每次都靠 grep | 代码关系也在同一个 fact 表里 |
| 密钥处理 | 用户自己小心 | 自动 redaction + zero-row embedding |
| 数据所有权 | 外部服务基础设施 | 用户 PC 上的单一文件 |
| 使用其他 AI 工具 | 仅限 Claude/GPT | MCP 标准 —— Codex·Cursor 皆可 |
| 离线 | ❌ | ✅ |

小结：Claude·GPT memory 是 *"我（agent）与你（用户）之间的关系备忘"*。Parallax 是 *"我所改动的代码库的工作记忆"* —— 互为补充。

### vs. MCP memory server（社区标准 memory）

大多数 MCP memory 服务器是简单的 key-value 或文本 memory。
Parallax 则是**在 MCP 之上把时间/分支/因果/代码图作为一等公民叠加上去的** memory。

### vs. Sourcegraph / CodeQL

| 维度 | Sourcegraph·CodeQL | Parallax |
|---|---|---|
| 目的 | 静态分析·检索（给人看的工具） | AI agent 的决策记录 + 影响范围 |
| 基础设施 | 需要运行服务器 | 本地单一文件 |
| memory 层 | 无 | 一等公民 |
| MCP 整合 | 无（另有协议） | 标准 MCP stdio |

如果说现有工具是为 *检索代码的人* 准备的，那么 Parallax 是为 *改动代码的 AI* 准备的。

### vs. graph DB（Neo4j 等）+ vector DB 组合

自己搭建的话：graph DB 服务器 + vector DB + ETL 流水线 + 认证/权限。
Parallax 用一个 SQLite 文件 + sqlite-vec 扩展就表达出同样的本质。运维复杂度只有 1/10。

## 6. 当前状态 — 能用的 / 还不能用的

### 能用 ✅
- TypeScript/JavaScript/Markdown 精确索引
- 另外 9 种语言（Python·Go·Rust·Java·Kotlin·C#·C·C++）的 regex 启发式索引
- 基础设施/契约文件（Docker·Terraform·protobuf·GraphQL·CODEOWNERS 等）索引
- "变更文件 → 受影响文件" 的 bounded multi-hop 分析（cycle/fanout 保护）
- 把 AI 决定/观察持久化为 fact
- 时间旅行（`as_of_tx`）、retract dedup（`current_only`）、语义检索（`semantic`）
- 用于模拟多个假设的 branch fork/merge
- 密钥自动 redaction + zero-row embedding
- MCP stdio 服务器 —— Claude Code·Codex 即刻连接

### 进行中 / 未实现 🟡
- TypeScript Compiler API 语义 adapter（正则 → 精确语法分析）
- 多仓库聚合分析（workspace catalog）—— schema 已就绪
- API contract 追踪（OpenAPI/protobuf 变更影响）—— schema 已就绪
- 可视化的 web 图浏览器
- 旧 memory 自动摘要（reflective consolidation, ）
- 自动清理被弃用的 branch

测试：43 passing。4,114 LOC TypeScript。4 个外部依赖（MCP SDK、transformers.js、sqlite-vec、zod）。

## 7. 扩展路线图 — 把价值做大的方向

### A. 突破精度天花板（影响最大）
- TS Compiler API adapter → 连 path alias / re-export / dynamic import 都精确
- Tree-sitter / LSP 整合 → 几乎所有语言都能做语义解析
- CodeQL adapter → 连数据流都能追踪

### B. 扩展到代码之外 —— 微服务时代的核心
- 聚合多个仓库（`workspaces`/`workspace_repos`）—— schema 已具备
- API contract（OpenAPI/protobuf/GraphQL/AsyncAPI）→ 变更时自动识别下游 consumer
- CI/Docker/K8s/Terraform 基础设施变更影响范围

### C. 整合到公司业务产出 —— 最有野心的方向
- 把 PRD、会议纪要、决策记录、KPI 文档登记为 entity
- *"这份 PRD 变更 → 影响哪些代码函数和测试？"*
- *"这个代码变更 → 需要在哪些运营文档·客户资料中体现？"*
- 从代码影响范围工具 → 跃升为 **"全公司变更影响范围工具"**

### D. AI memory 自动化
- Reflective consolidation：像睡眠时大脑整理记忆一样，由 LLM 自动摘要、提升旧备忘
- Branch GC：自动清理为模拟而创建的 buried branch
- 基于重要度评分的 archive

### E. UX / 可视化
- web 图浏览器（点击探索影响范围图）
- VSCode·JetBrains 扩展（在编辑器内即时显示影响范围）
- 时间线视图（按时间顺序回放 AI 决定）
- Obsidian sync（把备忘同步到 vault）

### F. 外部系统对接
- Linear/Jira ticket entity → 自动映射 "这个变更会关闭哪个 ticket"
- 把 Slack thread 作为 evidence 关联
- GitHub PR 合并 = 自动记录 fact

### G. 团队模式 — 分布式 fact sync（未实现，后续实现待定）

目前以一人一 PC 为前提。在扩展到团队共享时，也在探索不丢掉 *single .db / local-first* 这一身份认同的方向。

**核心想法：** 不强制中央服务器，而是 **各自在本地 SQLite 上工作，只定期同步 fact** 的 git-like 分布式模型。

之所以自然，是因为：
- facts 已经是 **content-addressable**（id = `sha256(entity|attribute|value|op)`）—— 无论谁在哪里创建，相同的 fact 就是相同的 ID，自动 dedup
- transactions 已经是 **multi-parent DAG**（`transaction_parents`）—— 与 git 的 commit 图同构
- branches 已经是 **head 指针 + parent_branch** —— 与 git 的 branch 同构

也就是说 *SQLite 内部已经包含了类 git 的结构*，所以团队共享不是新的发明，而是自然的扩展。

**实现模式 —— `.db` 保持私有，只把 fact 以文本形式共享：**

```
[团队成员 A 本地]              [git repo]                  [团队成员 B 本地]
  impact.db    ──export──→     facts/                ←──import──    impact.db
  (.gitignore)                  *.jsonl                              (.gitignore)
                              (文本，可做 PR review)
```

`.db` 文件本身是 SQLite 内部页结构，git 处理不了（看不到 diff，也无法解决冲突）。因此 **只把 fact 数据以 JSONL 文本 export → commit/push 到 git** 才是自然的做法。

设想的使用流程：
```bash
# 团队成员 A
parallax remember --entity file:src/auth.ts --attribute decision --value '"X 方式"'
parallax export --since last-sync > facts/2026-04-30-A.jsonl
git add facts/ && git commit -m "share auth decisions" && git push

# 团队成员 B
git pull
parallax import facts/2026-04-30-A.jsonl
# → A 创建的 fact 合并进 B 的本地 .db。因为 content-addressable，所以自动 dedup。
```

**为什么不会冲突：** fact ID = `sha256(entity|attribute|value|op)`。A·B 各自独立做出相同的决定时，ID 相同 → 通过 `INSERT OR IGNORE` 自动 dedup。如果是不同的决定，ID 就不同 → 两者都保留。fact 是 append-only，所以根本不会出现 git 那种 *"同一行不同修改"* 的冲突模式。

**副作用 —— "把 AI 决定作为 PR 来 review"：** 因为 fact JSONL 是文本，可以直接在 git 界面里做代码 review。*"AI 做的这个决定接受吗？"* 通过一次 PR 就能处理。这正好直接回应了公司内部 *"不敢随便把活交给 AI"* 的顾虑，是一套对症的工作流。

**可选的共享策略选项：**
| 共享什么 | 适用 |
|---|---|
| A. 只共享代码图 fact（索引器生成的 imports/calls/declares） | 团队共享同一代码库，AI 决定各自保留 |
| B. + 包含 AI 决定 fact | 让团队共享 "为什么这样写？" |
| C. 只共享带 `--share` 标志或 `team-shared` branch 的 | 敏感决定保持私有，只 push 共享决定 |

C 最现实 —— 只 export 用户明确共享的 fact。

**通道选项（git 并非唯一答案）：**
| 通道 | 优点 | 缺点 |
|---|---|---|
| **git repo**（主推） | 熟悉，review·history 免费 | 手动 export/import |
| 独立 git repo（`<project>-facts`） | 不弄脏代码 repo | 要管理两个 repo |
| 公司内部 sync 服务器（HTTP） | 自动，实时 | 要运维一台服务器 |
| 共享文件夹（NAS, S3） | 几乎没有基础设施 | 冲突策略薄弱 |

**对比对象（供参考其他路线）：**
| 模型 | 类比 | local-first | 运维复杂度 |
|---|---|---|---|
| **分布式 fact sync（本方向）** | git | ✅ 保持 | ★★ |
| 中央 memory 服务器（Postgres 等） | Google Docs | ❌ 破坏 | ★★★★ |
| Turso/Litestream 这类 SQLite 分布式变体 | 混合 | △ | ★★ |

**状态：** 未实现，**后续实现待定**。由于 content-addressable 模型本身就能承接这种结构，所以 *在确定优先级时可以快速切入*。是（reflective consolidation, branch GC）之后的候选项。起步用 git 通道 + 手动 export/import → 验证可行后，再朝着新增 `parallax sync` 自动化 sidecar 的方向走。

**评委 Q&A 卡片：** *"规模一大，SQLite 不就撑不住了吗？"* → "*.db 本身不会传到 git 上。只把里面的 fact 以文本 export，而且因为是 content-addressable，所以没有合并冲突。附带还能带来把 AI 决定作为 PR 来 review 的工作流。*"

## 8. 想向评委强调的信息

1. **时机**：这是 AI 编码工具正式被采用的 *当下* 所需的基础设施层。AI 越多地改动代码，缺失影响范围/memory 的代价就急剧上升。

2. **简单**：单个 SQLite 文件 + MCP stdio。运维复杂度几乎为 0 —— 在公司内任何环境都没有引入摩擦。

3. **建立在标准之上**：不是自有协议，而是建立在 MCP 这个行业标准之上。Claude Code、Codex、Cursor 全都共享同一套 memory·影响范围基础。

4. **Local-first 安全**：公司内部代码/决定不向外流出 —— 容易通过安全审查。

5. **扩展位已钉进 schema**：workspace/contract/cross-repo/work-artifact 表已经包含在 migration 里。只要新增 adapter，上面的路线图就能快速推进。

## 9. 再用一句话

> 一个把 *代码库的地图* 和 *自身决定的日记* 一起交到 AI 手里的工具，单一文件、标准协议、本地优先。

---

## 附录：本文档的更新规则

- **新的核心功能开始工作** → 更新 §6（当前状态）。
- **差异化信息变得更准确** → 更新 §3、§5。
- **路线图项目进入可用状态** → 从 §7 移到 §6。
- **出现同类服务/竞品** → 在 §5 增加对比。
- **因用户访谈/评委反馈而改变强调点** → 更新 §8。

改动内容时，以 *"评委能否在 5 分钟内抓住核心"* 为准则。变长了就压缩。
