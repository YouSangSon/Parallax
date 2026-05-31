<div align="center">

# 🛰️ Parallax

**Give coding agents a local map of what a change can break.**

一款影响力情报（impact intelligence）工具 —— 在 Claude Code、Codex、Cursor 等智能体改动代码之前，<br/>
先在本地索引你的仓库，并以证据呈现某个被改文件可能波及的代码、测试、文档与契约。

![status](https://img.shields.io/badge/status-MVP%20working-7c3aed)
![node](https://img.shields.io/badge/node-%3E%3D24.0.0-339933)
![storage](https://img.shields.io/badge/storage-SQLite%20%2B%20sqlite--vec-2563eb)
![mcp](https://img.shields.io/badge/MCP-stdio-14b8a6)
![license](https://img.shields.io/badge/license-MIT-3da639)

[English](README.md) · [한국어](README.ko.md) · **中文**

[🚀 快速开始](#-快速开始) · [✨ 主要功能](#-主要功能) · [🧱 核心概念](#-核心概念) · [🤖 MCP](#-mcp--agents) · [🔒 安全模型](#-安全模型) · [🗺️ Roadmap](#%EF%B8%8F-roadmap) · [📚 延伸阅读](#-延伸阅读)

<img src="docs/assets/parallax-ui-demo.png" alt="Parallax Impact Workbench UI showing ranked impact route cards, a graph-first impact map, analysis trust signals, impact summary, verification action, affected paths, and evidence" width="100%">

</div>

---

> **为什么需要它** —— AI 编码工具很快，但每次改动 `auth.ts` 中的一个函数时，它们都得靠猜：哪些测试、消费方、策略文档会随之变动。Parallax 把代码图谱和智能体记忆存储在仓库本地的 `.parallax/impact.db` 中，让智能体在改动*之前*就能以一个小巧的 context pack 确认“什么会受影响、为什么”。

---

## 🚀 快速开始

### 环境要求

| 项目 | 要求 | 备注 |
| :--- | :--- | :--- |
| **Node.js** | `>=24.0.0` | 使用内置的 `node:sqlite`，可能出现 experimental 警告 |
| **npm** | 以 package-lock 为准 | 用 `npm install` 搭建开发环境 |
| **仓库权限** | 本地读写 | 创建 `.parallax/` 目录与 SQLite DB |
| **外部服务** | 核心 impact 流程无需 | 基于模型/LLM 的记忆整理仅在显式调用时使用 |

```bash
# 1. 构建 Parallax
npm install
npm run build

# 2. 将当前 checkout 的 CLI 链接到 PATH
npm link

# 3. 在目标仓库中初始化并建立索引
cd /path/to/target-repo
parallax init
parallax index
```

分析单个被改文件：

```bash
parallax analyze --changed src/auth/session.ts --depth 2
```

也可以直接分析一个 git diff 范围：

```bash
parallax analyze --base main --head HEAD --json
```

Markdown 报告保存在仓库本地路径：

```text
.parallax/reports/
```

用本地 UI 直接打开最新报告：

```bash
parallax ui
parallax ui --report <report-id> --port 3717
```

> 💡 当存在受影响文件时，`analyze` 会返回退出码 `1`。这是有意为之，便于 CI 或智能体护栏将“存在影响”作为信号。

---

## ✨ 主要功能

### 🔎 影响分析（Impact analysis）

| 功能 | 行为 |
| :--- | :--- |
| **本地索引** | 在 `.parallax/impact.db` 中存储文件、entity、relation、evidence、coverage |
| **变更分析** | 通过有界的多跳图遍历分析 `--changed` 或 `--base/--head` 输入 |
| **以证据为先的报告** | 以 JSON/Markdown 输出 `changed`、`affected`、`actions`、`evidence`、`adapterInsights`、`warnings` |
| **相关测试推断** | 利用 import、文件名约定与 adapter 证据，推荐最可能受影响的测试 |
| **图导出** | 将已保存的报告导出为 Mermaid、JSON 或 DOT |
| **覆盖率告警** | 在报告中暴露 oversized 文件跳过、陈旧索引与 adapter 已知缺口 |

### 🧭 适配器覆盖（Adapter coverage）

| 领域 | 当前状态 |
| :--- | :--- |
| **TypeScript / JavaScript** | 正在扩展 parser 支撑的 import、declaration、class/interface 继承、调用点、typed/解构/具名对象 receiver、factory 返回、构造函数/字段调用 span |
| **JVM / Spring Boot** | endpoint、declaration、config、test 证据 span v0 |
| **Python / Go / Rust** | 以 declaration/test 关系为主的轻量适配器 |
| **Markdown / 工作产物** | 将 policy、proposal、PRD、decision 文档归类为一等 artifact 并与代码关联 |
| **Config / 基础设施** | 索引 system/config 候选：shell、YAML、JSON、TOML、Dockerfile、Makefile、Terraform、CODEOWNERS 等 |
| **包清单（manifest）** | 为 `package.json`、`pom.xml`、`build.gradle(.kts)`、`go.mod`、`Cargo.toml`、`pyproject.toml` 构建 manifest 图 |

### 🌐 工作区与契约（Workspace & contracts）

| 功能 | 说明 |
| :--- | :--- |
| **工作区目录** | 仅在 `.parallax/workspace.json` 中登记用户允许的本地仓库。无 clone/网络 |
| **跨仓库解析器** | 在已登记的仓库之间存储 provider endpoint ↔ consumer 文件链接 |
| **契约 diff** | 将 OpenAPI、GraphQL、Protobuf、AsyncAPI 的表层 diff 归类为 `breaking` / `non-breaking` / `unknown` |
| **消费方影响** | 将被删除的 endpoint/operation、字段删除/类型变更、新增必填请求字段等与已知 consumer 关联 |
| **事件拓扑提示** | 以紧凑载荷提供 AsyncAPI 生产者/消费者方向与 breaking 溯源 |

```bash
parallax workspace init --name platform --service api
parallax workspace add-repo ../web --name platform --service web
parallax workspace resolve-contracts --name platform --json
parallax workspace contract-diff --contract openapi.yaml --name platform --json
```

### 🧠 智能体记忆（Agent memory）

在同一个 SQLite DB 上，将智能体的决策、观察与依据存储为内容寻址（content-addressable）的 fact。

| 命令 | 作用 |
| :--- | :--- |
| `remember` | 存储关于某 entity 的决策/观察 fact；用 `supersedes` 替换陈旧 fact |
| `recall` | 按 entity、attribute、关键词或语义查询检索 fact |
| `branch` / `merge` | 无需复制数据即可对多个 plan 进行 fork/merge |
| `trace` | 沿 `fact_provenance` 边追溯某决策的推理链 |
| `profile` | 一次性返回某 entity 的 static facts、dynamic facts 与 summary facts |
| `reflect` | 用 LLM 概括陈旧 fact 并提升为 summary fact |

```bash
parallax remember --entity src/auth/session.ts \
  --attribute decision --value "允许 JWT 60s 时钟偏移" --confidence 0.9
parallax recall --entity src/auth/session.ts --json
parallax profile --entity src/auth/session.ts
```

---

## 🧱 核心概念

| 概念 | 一句话说明 |
| :--- | :--- |
| **Impact graph** | 连接文件/符号/契约的有向图；通过有界遍历计算变更的波及 |
| **Evidence** | 为每条关系附上其来源文件、行号与代码片段作为依据 |
| **Confidence** | 以 proven / inferred / heuristic 三级标注证据可信度 |
| **Context pack** | 将变更分析结果以便于智能体消费的小型 JSON 包交付 |
| **Work artifact** | 将 policy、PRD、decision 等文档与代码关联的一等对象 |
| **Adapter** | 按语言/格式划分的提取器，并报告自身的 confidence 与已知缺口 |

---

## 🤖 MCP & agents

Parallax 提供一个 MCP stdio 服务器。

```bash
parallax mcp serve
```

| MCP 工具 | 作用 |
| :--- | :--- |
| `impact_analyze` | 接收被改文件/diff，返回 impact 报告 |
| `context_for_change` | 按 budget 返回某次变更的 context pack |
| `impact_graph_export` | 以图格式导出已保存的报告 |
| `memory_remember` / `memory_recall` | 写入/读取智能体记忆 |
| `memory_profile` / `memory_trace` | 查询 entity 画像与其推理链 |

> 在 Claude Code、Codex 等 MCP 客户端中将其登记为 stdio 服务器即可直接使用。

---

## 🔒 安全模型

| 原则 | 内容 |
| :--- | :--- |
| **本地优先（Local-first）** | 所有索引与记忆数据都存储在仓库本地的 `.parallax/`，无外部传输 |
| **显式工作区** | 跨仓库仅覆盖用户登记的本地仓库，无 clone/网络 |
| **脱敏（Redaction）** | 类似密钥的字符串在存储前会被脱敏 |
| **默认只读** | MCP 默认只读；写入仅通过显式命令进行 |
| **确定性输出** | 相同输入产生相同报告，可在 CI 中复现 |

---

## 🧪 开发

```bash
npm run build
npm run check
npm test
npm run docs:lint
```

主要脚本：

| 脚本 | 作用 |
| :--- | :--- |
| `npm run build` | 将 TypeScript 编译到 `dist/` |
| `npm run check` | 仅类型检查，不产出文件 |
| `npm test` | 通过 `tsx` 运行 Node test runner 套件 |
| `npm run bench` | 基于多语言、Spring Boot、契约、包清单 fixture 的确定性 bench |
| `npm run docs:lint` | 检查被跟踪的 Markdown 中的本地元数据与类似密钥的内容 |
| `npm run test:mcp` | 验证 MCP impact/context/memory/telemetry/路径校验 |
| `npm run test:security` | 验证路径包含约束与脱敏 |
| `npm run test:ui` | 验证本地 UI 快照、服务器与 JSON 资源端点 |

发布前建议的检查：

```bash
npm run check
npm test
npm run docs:lint
npm audit --audit-level=high
```

---

## 🗺️ Roadmap

| 维度 | 下一目标 |
| :--- | :--- |
| **Accuracy** | 将 parser 支撑的 TS/JS span 扩展到更广的动态分发与高级类型关系 |
| **JVM / Python / Go / Rust** | 把以 declaration 为主的适配器提升为 parser 支撑的调用/import 解析 |
| **Workspace / Contract** | 稳定嵌套 schema diff；深化 generated-client/事件拓扑解析器 |
| **Package / Build** | 基于 lockfile、传递依赖与 semver/range 的包图 |
| **Agent surface** | context pack 的 budget 调优与 hit/miss 度量工具 |
| **UI Explorer** | 在单一界面更直接地探索 changed → affected → evidence → action 流程 |
| **Measurement** | fixture bench 增量与召回质量回归检测 |

详细 backlog 以 [`docs/roadmap.md`](docs/roadmap.md) 为准进行管理。

---

## ⚠️ 当前限制

| 领域 | 状态 |
| :--- | :--- |
| **完整语义分析** | 并非对所有语言都做类型感知分析；需查看各 adapter 的 confidence 与已知缺口 |
| **契约深度** | GraphQL/Protobuf/AsyncAPI 在 parser/LSP 级别的完整 generated-client 使用图属于后续工作 |
| **包解析** | 目前以 manifest 为主；基于 lockfile/传递依赖/semver 执行的解析器属于后续工作 |
| **图数据库** | 不在默认产品范围内；如需可作为从 SQLite 投影的可选能力扩展 |
| **外部写入** | Obsidian/GitHub/Jira 写同步尚未暴露在 MCP 接口上 |
| **代码修改** | Parallax 不直接修改代码；它为智能体提供影响范围与证据 |

---

## 📚 延伸阅读

| 文档 | 内容 |
| :--- | :--- |
| [`docs/vision.md`](docs/vision.md) | 项目愿景 |
| [`docs/value-proposition.md`](docs/value-proposition.md) | 价值主张与差异化 |
| [`docs/roadmap.md`](docs/roadmap.md) | 当前 backlog 与下一批切片 |
| [`docs/invariants.md`](docs/invariants.md) | local-first、脱敏、权限模型等不变量 |
| [`docs/glossary.md`](docs/glossary.md) | 术语表 |
| [`skills/parallax/SKILL.md`](skills/parallax/SKILL.md) | 面向 Claude Code / Codex 用户的 skill |

---

## License

MIT License。详情请见 [`LICENSE`](LICENSE)。
