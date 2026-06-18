# Roadmap

[English](roadmap.md) · [한국어](roadmap.ko.md) · **中文**

> 以 thematic 方式整理接下来需要做的事。进度追踪通过 git log 和 PR 维度来维护。

本文档只记录*当前可以无阻碍推进的方向*。重大决策都在不破坏 [invariants.zh.md](invariants.zh.md) 的前提下进行。

---

## 1. 准确度 (Accuracy)

当前最大的空白在于：基于 regex/declaration-line 的 evidence *什么时候会出错*，人无法得知。

- [ ] 基于 TS/JS Tree-sitter 或 TypeScript parser 的 full symbol/call span
  - 进行中：基于 TypeScript parser 的 import、declaration、same-file/named-imported/direct-named-re-exported/star-re-exported/namespace-re-exported/default-imported/direct-default-re-exported/namespace-imported class/interface heritage type relation、imported call-site、local identifier call、method-reference alias call、same-class `this.method()`、same-file class `super.method()`、same-file class extends inherited instance/static method、static `ClassName.method()`、same-file/direct-new-or-const-alias-inferred/namespace-constructor-inferred/factory-wrapper-inferred/direct-factory-call-receiver/named-imported/direct-named-re-exported/star-re-exported/namespace-imported/namespace-re-exported/default-imported/direct-default-re-exported/awaited factory return type instance method call、interface/type-literal method/function-property/function-type-alias signature、same-file/named-imported/direct-named-re-exported/star-re-exported/namespace-re-exported/default-imported/direct-default-re-exported/namespace-imported interface/type-literal typed receiver method call、same-file interface extends typed receiver method call、same-file alias-backed interface extends typed receiver method call、same-file type reference alias typed receiver method call、same-file simple generic type reference typed receiver method call、same-file generic constraint typed receiver method call、same-file intersection type alias typed receiver method call、direct intersection typed receiver method call、same-file simple union typed receiver method call、array/`Array<T>`/`ReadonlyArray<T>` element typed receiver method call、declared typed local/class field receiver method call、typed local variable instance method call、typed/destructured/named-object parameter instance method call、assertion-wrapped/non-null/parenthesized typed receiver method call、string-literal element access method call、private member receiver method call、constructor parameter property instance method call、constructor assignment instance method call、class field arrow method caller/target、static class field arrow method call、typed class field instance method call、class field instance method call、same-file `new ClassName()` instance call、direct `new ClassName().method()` call span 均已 landed。更广泛的 dynamic dispatch 和 advanced type relation 仍待完成。
- [ ] 将 JVM/Spring Boot 的 endpoint·DI·persistence relation 升级为基于 parser 的实现
- [ ] 把 Python/Go/Rust 的 call/import resolution 从 declaration-only 扩展为 parser-backed
- [x] 每次 adapter run 都在 report 中明示 confidence label 与 known-gap
- [x] 将 NodeNext/ESM 的 `.js` 扩展名 local import 解析到 TypeScript source(`.ts`) —— 修复内部 import 依赖图全部漏成 `external_entity` 的问题
- [x] 将 impact report 的 `affected` 按 confidence(proven > inferred > heuristic) → depth → path 的顺序排序 —— 修复 proven 代码影响被埋在 heuristic 文档 mention 之下的问题（UI 的 first-glance target 也随之自动改善）

## 2. Workspace / Contract

cross-repo impact 还处于 v0 状态。仅在用户注册的 local repo 之间生效。

- [ ] 将 OpenAPI / GraphQL / Protobuf / AsyncAPI 的 contract diff 稳定到 *nested schema* 粒度
- [ ] 让 generated-client / event topology resolver 超越 heuristic
- [ ] 让 workspace catalog 把 monorepo 内部的 sub-package 当作 first-class 来识别
- [ ] 让 cross-repo link 的双向性 (provider→consumer, consumer→provider) 始终保持一致

## 3. Package / Build 解析度

manifest-only resolver 看不到 transitive/lockfile/semver。

- [ ] 基于 lockfile 的 transitive 依赖图 (npm·pip·poetry·go·cargo·maven·gradle)
- [ ] 用 semver/range 信息推断受影响的版本范围
- [ ] 标准化在不执行 build script 的情况下 dump dependency 图

## 4. Agent surface

MCP 已稳定为 read-only。接下来是深入审视 agent 可用性的阶段。

- [ ] 用使用 telemetry 验证 `context_for_change` 的 budget tuning (brief/standard/deep)
- [ ] 用于测量 context pack 结果 hit/miss 的 harness
- [ ] 研究将 write surface 拆分为独立权限模型后引入（遵循 [invariants.zh.md](invariants.zh.md) I-8）

## 5. UI Explorer

当前 UI 还停留在读取已保存 report 与 graph 的首个 explorer 水平。

- [x] changed → affected → evidence → action 流程的单屏验证
- [x] 把 policy / decision / PRD / requirement / proposal 这类 work-artifact lane 作为 first-class panel
- [x] 一键将 evidence resource jump 到原始文件/行
- [x] 扩展 inspector，对 selected impact 的 relation/evidence/action 做更深的 drill-down
- [x] saved report 之间的比较与 regression delta UI
- [x] 将 report delta 的 added path 直接连接到 source viewer 与 inspector/verification action，并将 removed path 连接到 source viewer
- [x] 让 report delta 的 wider/narrower 判定标准可通过 team policy 配置
- [x] 让 report delta policy preset 可在 UI 中比较
- [x] 在 impact map 中加入 primary flow summary、方向箭头、stage band，强化 first glance
- [x] 将 report delta preset 中选定的 policy 导出为 config patch
- [x] 把 impact map 提升为首个 viewport 的 primary surface，让变更 → 影响流程一眼可见
- [x] 将 impact map 的 fallback edge 也以 displayed path 表示，消除被误解为 "0 graph links" 的状态
- [x] 让 impact summary 也以 displayed path 为基准对齐，消除 summary 与 map 之间的术语不一致
- [x] 在首屏加入 changed root → affected targets → next verification 的 triage strip
- [x] 点击 triage strip 中的 top affected/verification target 时连接到 inspector/evidence 的选中
- [x] 让 impact map 的 edge/label 与 selected target 一同高亮，增强图的可解读性
- [x] 将初始 primary flow/inspector 统一为以 action-first selected target 为基准
- [x] 让 map legend row 也与 selected target 同步，并从服务端渲染起就显示 selected state
- [x] 在 Impact Summary 中加入将 coverage、adapter confidence、known gap 汇总的 Analysis Trust 概要

## 6. 回顾与测量

没有回归信号，就无法保证所有变更都正常工作。

- [x] 基于多语言 fixture 的 deterministic bench harness
  - 当前 gate：`bench/impact-bench.ts` 会构建固定的 TypeScript/JavaScript、JVM/Spring Boot、Python、Go、Rust、OpenAPI、build manifest fixture，并评分 relation recall/precision、affected-file recall、evidence/span coverage、adapter attribution、context-pack readiness 与 retrieval 质量。它由 `npm run bench`、`npm test` 以及 CI 的 `npm run verify` gate 执行。
- [x] 在 embedding 模型 / LLM provider 交叉时对 recall 质量的回归 detection
  - 当前 gate：deterministic bench 现在包含 semantic model matrix，检查每个模型的 recall@1 与 cross-model isolation。它是一个不依赖 live provider 调用的 offline gate，用来捕捉 embedding 模型 namespace 回归；LLM provider 的网络质量评估仍放在 CI 之外，而 provider contract 继续由 offline test 覆盖。
- [x] 在 CI 中每个 PR 自动报告 bench delta
  - 当前 gate：CI 会在 pull request 中准备 base SHA 的 bench report，在 head 上运行 canonical `npm run verify` gate，然后把 `npm run bench:report` Markdown append 到 GitHub Step Summary，展示 score、relation、affected-file、retrieval 与 semantic recall delta。

---

## 如果只挑下一个切片

在 `tests/` 与 `bench/` 中已有的 fixture 之上，把**准确度 (1)** 的第一项 —— *parser-backed TS/JS span* —— 收尾，是 ROI 最高的。因为其他所有轴都依赖 evidence span 的精度。
