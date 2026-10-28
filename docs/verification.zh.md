# Parallax — 验证与测试

[English](verification.md) · [한국어](verification.ko.md) · **中文**

Parallax 分层验证正确性——快速的 unit suite、typecheck、docs linter、确定性的 accuracy bench，以及把 Parallax 对自身重新索引的 dogfood guard。CI 在每次 push 和 pull request 上运行全部这些。本指南说明每一层捕获什么、何时运行——核心教训是：green unit test 对 engine 变更**必要但不充分**。

## script 一览

下面每条命令都是 `package.json` 中定义的 `npm run` script。

| 命令 | 作用 | 何时运行 |
| :--- | :--- | :--- |
| `npm test` | 通过 `tsx --test` 对 `tests/**/*.test.ts` 运行 Node test runner | 任何变更后；默认的快速 suite |
| `npm run check` | `tsc --noEmit` 类型检查，不产出文件 | commit 前；捕获类型回归 |
| `npm run audit:dependencies` | 运行 fail-closed 的 high-severity dependency audit gate | commit / PR 前及 CI 中 |
| `npm run lint` | 一起运行 `check` + `docs:lint` | commit / PR 前；完整的 static gate |
| `npm run docs:lint` | 对 tracked/untracked Markdown 运行 `scripts/docs-lint.js`，包括本地 `.md` 链接目标 | 编辑任何文档后 |
| `npm run verify` | 运行 canonical source-checkout release gate：lint、install smoke、fast tests、dogfood、bench 和 high-level audit | release 前和 CI |
| `npm run build` | `tsc -p tsconfig.json`，编译到 `dist/` | 发布或 smoke 测试 CLI 前 |
| `npm run bench` | 运行 `bench/impact-bench.ts`；accuracy 回归时以 non-zero 退出 | engine/adapter 变更后 |
| `npm run bench:report` | 将最新 bench JSON 渲染为 Markdown，并可选地与 baseline report 比较 | `npm run bench` 后，或用于 CI summary |
| `npm run bench:perf` | 运行 `bench/impact-perf.ts`；在合成 repo 上测量 full index、no-op incremental index、edited-file reindex、各 scan phase、analyze phase 耗时与 observed peak RSS（非确定性，不在 `verify` 中） | 处理 indexing/traversal 性能时 |
| `npm run test:dogfood` | 对 Parallax 自身 source 进行索引并断言内部 graph 存活 | engine 变更后（indexer/adapters/analyzer/store/graph） |
| `npm run test:mcp` | 运行 `tests/mcp.test.ts`（impact / context / memory / telemetry / 路径校验） | MCP surface 变更后 |
| `npm run test:ui` | 运行 `tests/ui.test.ts`（UI 快照、服务器、JSON 资源端点） | UI 变更后 |
| `npm run test:security` | 运行 `tests/security.test.ts`（路径包含约束、脱敏、dependency audit gate） | store / 路径 / 脱敏 / audit gate 变更后 |
| `npm run test:install-smoke` | 先 `npm run build` 再 `node dist/src/cli.js --help` | 发布前，确认打包后的 CLI 能启动 |

`bench:perf` 还按 full/no-op/edit 输出 `*_scan_body_reads`、`*_scan_body_bytes`、`*_scan_sample_reads` 和 `*_scan_sample_bytes`。这些指标统计扫描器成功读取的次数及文件 API 返回的字节数，包括可识别但无适配器支持的文件，以及超限文件的有限样本读取。不包含 Git/元数据操作、自定义适配器的直接读取或设备/缓存 I/O。非 Git no-op 与 clean same-HEAD 验证都会读取正文。Cache miss 可能扫描两次，时间和读取量会累加。完整 scan 的计数通过 `IndexOptions.perfObserver` 的可选第三个参数传入；失败的 scan 不提供计数。CLI/index 结果结构保持不变。

`test:fixtures` 是 `npm test` 的别名，`test:benchmark` 是 `npm run bench` 的别名。`npm run verify` 包含 `npm run audit:dependencies`，所以最后的 audit 阶段依赖 npm registry 和网络可用性。

Dependency gate 只放行 high/critical finding 为 0 且 exit code 为 0 的有效
npm audit v2 report。只有 low/moderate 的报告仍可通过，不设例外 allowlist。
High/critical finding、count 或 exit status 不一致、无效 JSON、command/network
失败都会 fail closed。Gate 不输出 raw npm 诊断；需要原始诊断时，请在本地
重新运行 `npm audit --audit-level=high --json`。

Security audit job 使用 `npm ci --ignore-scripts` 安装固定依赖，metadata 审计不需要
native lifecycle 下载。lock 不一致检查及 fail-closed audit 命令仍保留；Release
继续普通 `npm ci` 与完整运行验证。这不消除 registry 或 Release 网络失败。
参见 [npm 选项契约](https://docs.npmjs.com/cli/v11/commands/npm-ci/#ignore-scripts)。

## dogfood guard——真正的安全网

`tests/dogfood.integration.ts` 是最需要理解的一层。它之所以存在，是因为过去 green unit suite 曾与一个彻底损坏的内部依赖 graph 共存：真实的 NodeNext `./x.js` import 坍缩为 `external_entity`，使一个被大量 import 的模块报告了**零**个代码依赖者（dependent），而所有 unit test 仍然 green。unit suite 根本没有像用户那样去看真实的 engine 输出。

dogfood guard 填补了这个缺口。在每个 test 中，它：

1. 把 Parallax 自身的 `src/` 复制到一个隔离的临时 repo，然后在其上运行 `initProject` + `indexProject`——真实的用户路径。
2. 对 `src/store.ts` 调用 `analyzeDiff`，并断言 `src/` 下具有 `proven` confidence 的依赖者至少有 `MIN_PROVEN_SRC_DEPENDENTS`（5）个，且排名最高的 affected file 本身就是一个 `proven` 的 `src/` 依赖者（这同时保护了 confidence 优先的排序）。
3. 以只读方式打开正规 store，对 `relations` + `entities` 表运行 raw SQL：统计 target 为本地 `src/%` 实体且 `kind != 'external_entity'` 的 `DEPENDS_ON` edge 数量（必须超过 `MIN_INTERNAL_DEPENDS_ON_ROWS`，20），以及 `file:src/store.ts` 的 `proven` `src/%` 依赖者数量（必须达到下限 5）。

这些断言使用**下限（floor）而非精确计数**，因此正当的 refactor 不会破坏 test。判别标准是原始 bug 造成的 *坍缩到 ~0*，而非任何精确数字。SQL 刻意瞄准正规的 `relations` + `entities` 表以及 `external_entity` 坍缩——这正是它所防范的失败形态。

### 为什么它不在 `npm test` 里

默认 suite 对 `tests/**/*.test.ts` 进行 glob。该 guard 名为 `tests/dogfood.integration.ts`——它**不**匹配 `*.test.ts`，所以 glob 按设计跳过它（它也很慢，因为要重新索引整棵 source 树）。`npm run test:dogfood` 与 CI 通过直接指定文件来运行它。

**教训：** green 的 `npm test` 必要但不充分。对 engine 的任何变更——indexer、adapters、analyzer、store、graph、cross-repo——都不能只靠 unit green，必须经过 dogfood 验证，因为 unit suite 可能 green 而真实 graph 已经损坏。

## 增量正确性 gate

只有已验证的 scanner 输入与选定 Git 历史相同时才使用 `IndexResult.mode = 'incremental'`。
正文、unsupported 输入、skip sample、历史变化或旧输入未经验证时，使用 `mode = 'full'`
执行完整 extraction。
仅凭 `fileContentScope` 不能授权 changed-only extraction：它约束读取范围，
但不约束 emitted row 的 ownership。

回归 oracle 位于 `tests/incremental-index-oracle.test.ts`。它包含仅修改
`tsconfig.json` path alias 的 case，并要求 rerun graph 与同一 final tree 的
fresh index 完全一致。Component test 还覆盖 target-only adapter 先 emit、
随后移除 foreign-source relation 的 case。

无变化的运行保留 entity/contract 版本、adapter 诊断和导入的 SCIP 关系，
同时刷新 scanner 的 skipped 状态。重新导入 SCIP 会替换之前的关系，
co-change 刷新也会保留 runtime trace 提升的置信度。写入失败时先回滚全部 graph
更改，再记录失败的运行。Extractor/semantics revision 变化会触发完整重建；
外部 SCIP/trace 信息需要在重建后重新应用。

回滚由 SQL transaction/savepoint 负责。已删除无人消费的手动恢复 snapshot 与逐行
capture 查询/Map 复制；输入/事件复制、发布校验与失败 audit 保留。这不是 latency
或 RSS 改善率的测量结果。

```bash
node --import tsx --test tests/incremental-index-oracle.test.ts
```

在发布任何 graph/transaction 之前，写入事务会重新核对计划时的最新 completed
run ID（包括 null）和 main branch ID/head。不一致时返回
`index publication baseline changed; retry indexing`，不自动重试 adapter。
当前 completed ID 还必须小于本次 run ID，避免扫描期间被超越的旧 run 将行移回较小 cohort。
这防止并发 no-op carry 与逆序完成的 full index 覆盖当前 graph/head。
共享机器策略下，确定性数据库 oracle 在现有远程 CI 执行。这不保证 filesystem
snapshot 或所有 graph writer 的原子性。范围与概念参考见
[韩语说明](verification.ko.md#겹친-인덱싱의-발행-기준)。

Clean same-HEAD 复用先选择最新 completed cohort，校验 extractor/HEAD/resource 条件，
再读取当前有界 scanner 输入和选定 Git 历史，与该 graph 发布时的私有版本化 digest 比较。
捕获发生在 mutable adapter 分类之前；co-change 使用同一份历史。不会省略正文读取。

候选、验证与计数位于同一个 DEFERRED 读取 snapshot，hit/miss/异常均结束它，致命错误
关闭数据库。Miss 后先关闭 snapshot、分配新 run ID，再重新读取 scan/history，不发布
precheck 数据。保留的 hit 也会在关闭 snapshot 后用新的 autocommit 查询核对最新
completed ID；发生移动则按 miss 处理。最后核对之后完成的 writer 不在新鲜度保证内。
可能读取两次正文，并延长读取 snapshot；WAL 不占 writer slot，但这不是
整个 filesystem/Git 的原子 snapshot，也不保证返回后仍是最新结果。

Schema v17 增加 nullable receipt，不从旧 hash backfill。旧 NULL、未知或不匹配的记录
在下次 index 时触发 full；如其他 full rebuild 一样，需要重新应用 SCIP/trace augmentation。
之后真正相同的输入仍保留这些信息。现有 v16 读取 API 继续兼容。Co-change savepoint
失败时保留 best-effort completed audit，但不写入有效 receipt，下次 full 重试。
graph 发布失败会一起回滚 graph 与 receipt。

[PR #51](https://github.com/YouSangSon/Parallax/pull/51) 的 oracle 覆盖隐藏正文、mutable
分类和历史增加/删除。`parallax index --max-file-bytes 1000000` 仍可跳过 clean 结果复用，
但正文重新验证不再依赖此临时方法，也未启用选择性提取。原理、替代方案和范围见
[韩语说明](verification.ko.md#git-clean과-실제-본문-변경)。

Scanner 在同一已打开的 descriptor 上检查并限制正文/sample 读取。正文分配量不超过
已检查的大小；短读取会继续，EOF、大小或修改时间变化则使扫描失败。Linux/macOS
使用 no-follow 与 nonblocking flag；缺少 no-follow 的平台在读取前校验 leaf identity。
可选 sample 读取失败仍保留 skipped 状态，但最初打开文件失败会使整个扫描失败。
这不保证父目录或整个 filesystem 的原子 snapshot，Windows 执行也尚未验证。
`tests/scanner.test.ts` 只验证文件系统边界，不启动数据库或服务器。
概念参考为 Codex 在
[970111f 提交中的 descriptor 限量读取](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/exec-server/src/local_file_system_read.rs)；
Parallax 将这一原理用于现有同步 scanner，没有复制原始代码。

## 进程内 config 计算复用

在同一进程中重复调用公开 `indexProject()` API 时，可复用内置 config/infra 已完成的
纯计算。键包含仓库 root、目标的实际路径/语言/正文，以及保留顺序的 unique indexed
paths；其他文件正文不是输入。独立 CLI 进程不能共享缓存。wrapper 的
start/process/dispose、其他 adapter、scanner、当前 audit ID 和完整 publication 均照常
执行。输入变化仍返回 `mode = 'full'`。这不是通用 adapter 独立性、部分行 carry 或读取减少。

缓存最多保留 256 项、1 MiB 的键和序列化事件 UTF-16 payload，并非 RSS 上限。
超大结果继续计算但不缓存；部分消费或 generator 失败不写入。cold/hot 都返回新事件副本。
原始 snippet 只保留在进程内存：在 publisher 脱敏前持久化会泄露秘密，而提前脱敏后
重放可能改变 `facts.redacted` 审计值。计算完成后即使 publication 失败，计算结果仍可
复用，但不能证明 graph 已发布。重试仍执行原有 writer admission 和 publication。

Pure 测试观察实际 matching，而非时间阈值。远程 indexer oracle 要求 source 编辑复用
config 计算、config 编辑重算该目标、路径变化使 context 失效。它与 cold fresh root
比较 graph/version/coverage/count、当前关系 audit、脱敏 fact/provenance 和已保存 report。
SQL trigger 检查 miss/hit 的 publication 失败、回滚与恢复；实际 scanner 读取单独计数。
通用 stateful adapter 的完整处理回归继续保留。既有事件独立性测试使用不同 cold
namespace，防止缓存重放代替独立计算。

概念参考：Bazel 的[输入键 action cache](https://bazel.build/remote/caching)和
[hermeticity](https://bazel.build/basics/hermeticity)。仅采用完整识别输入后再复用的原则，
未引入其实现、依赖、远程缓存，也不声称通用 adapter 具有 hermeticity。

## accuracy bench

`bench/impact-bench.ts` 构建一个固定的 multi-language fixture（TypeScript/JavaScript、JVM/Spring Boot、Python、Go、Rust、OpenAPI 契约与 build manifest），对其索引，并将所得 graph 与一组 pin 住的期望 relation 对照打分。它 pin 住：

- **relation recall 与 precision**——每个期望的 relation 都必须匹配，且没有意料之外的 relation。
- **affected-file recall**——对变更文件的 `analyzeDiff` 必须呈现每个期望的依赖者。
- **evidence presence、span completeness 与 adapter attribution**——relation 必须携带 evidence/span 并归属到正确的 adapter。
- **retrieval 指标**——在 brief context budget 内 `searchContextForRepo` 的 recall/precision/MRR/nDCG。
- **semantic model recall/isolation**——使用确定性的 int8 fixture embedding，验证 embedding 模型名变化时 semantic recall 仍返回期望的 top fact，并且不会混入 cross-model decoy。

runner 写出一份确定性 JSON 报告，当 suite 未通过时设置 non-zero exit code。共有两个 surface：

- `tests/impact-bench.test.ts` 作为 `npm test` 的一部分运行 bench，并断言报告形态、pin 住的期望 relation 集合，以及 score/recall 阈值。
- `npm run bench` 直接运行 `bench/impact-bench.ts`，并在任何 recall/score 回归时以 non-zero 退出——这是 CI 使用的形式。

Deterministic bench 也包含 cross-repo、contract-diff、co-change 与 trace-promotion lane。cross-repo contract-impact lane 会构建 two-repo workspace fixture，通过 `analyzeContractDiff` persist breaking contract link，然后检查 `analyzeDiff` 与 report-scoped graph export 是否仍暴露 expected `web:src/client.ts` consumer impact。contract-diff quality lane 会运行 removed response required property、removed response optional property、added request required property、request enum-value removal、request format addition、response property type change、response nullable addition、response format change、response enum-value removal 的 paired OpenAPI v1/v2 fixture，以及 JSON Schema root-object 和 Avro top-level record required-property removal case，并通过 `contractDiffQuality` 报告 matched cases/changes。co-change quality lane 会构建一个小型 git-history fixture，其中 `src/alpha.ts` 与 `src/beta.ts` 反复共同变更，然后检查 `queryCoChanges` 与 `analyzeDiff` 是否都通过 `coChangeQuality` 将 `src/beta.ts` 暴露为 expected heuristic partner。trace-promotion lane 会 ingest 一个运行时观测到的 `src/beta.ts -> src/alpha.ts` edge，然后通过 `tracePromotionQuality` 验证被提升的 relation 会作为 proven impact 暴露。这些 lane 会 gate `summary.passed`，但不会 reweight 历史 `summary.score`。

凡是触及 relation 抽取、排序或 retrieval 的变更之后，都运行 `npm run bench`。

`npm run bench:report` 会把 `.parallax/bench/impact-bench-report.json` 转成紧凑的 Markdown summary。传入 `--baseline <json>` 时会包含相对上一份 report 的 delta column；传入 `--github-step-summary` 时会 append 到 GitHub Actions step summary。CI 在 pull request 中会先从 PR base SHA 生成 baseline report，然后在 `npm run verify` 之后报告 head-vs-base bench delta。

## performance bench

`bench/impact-perf.ts`（通过 `npm run bench:perf` 运行）在**确定性合成 repo**（`bench/synthetic-repo.ts`）上以递增规模测量 full index、no-op incremental index、edited-file reindex、各 scan phase 与 analyze 成本——一个 module hub 结构，改动 leaf 会波及所有 importer，从而压测 analyzer 的 reverse-dependency traversal。它与 accuracy bench 及 `npm run verify` **刻意分离**：耗时与 peak RSS 是非确定性的，绝不能进入字节一致的 `impact-bench-report.json`。用它来建立 baseline，或在处理 indexer/analyzer 时排查疑似回归；在 CI 中可对最差 index phase `/kfile` 成本使用宽松的 `--max-ms-per-kfile` ceiling 设闸。

```bash
npm run bench:perf -- --scales 1000,10000        # 自定义规模
npm run bench:perf -- --max-ms-per-kfile 2000    # 超过 ceiling 即失败
```

若要获得可比较的 large-repo baseline，请在 clean checkout 上使用 10k 与 50k 文件规模：

```bash
npm run bench:perf -- --scales 10000,50000
```

同时记录 command、commit、Node version、OS / hardware class，以及完整 output table。只有在已有项目 baseline 之后，才把 `--max-ms-per-kfile` 当作本地或 CI smoke ceiling；不要把 exact timing 或 RSS 接入 `npm run verify`。

输出表会分开显示 `full_index_ms`、`full_scan_ms`、`noop_incremental_ms`、`noop_scan_ms`、`edit_reindex_ms`、`edit_scan_ms`、`analyze_no_persist_ms`、`analyze_persist_ms`、`observed_peak_rss_mb`，以及 total phase 对应的 `/kfile` 耗时列。Peak RSS 使用 Node 内置 RSS reading 在 phase 边界采样，因此是实用的趋势信号，而不是精确 allocator trace。计时运行不在 verify 中，但合成 generator 和表格 formatter 由 `tests/synthetic-repo.test.ts` 在常规 verify 闸中守护。

### 路径 token 查询

2026-10-25 对真实 workflow 正文的 adapter 单独观测发现了逐路径重复搜索整个
正文的成本。基准 `5a6fbfb` 与候选 `808ce5f` 使用 Node `v24.14.0`、
`darwin/arm64`、256 MiB V8 old-space 上限和本地 Git 的固定 blob。Context 是已识别
语言的 tracked 路径，不是 scanner snapshot；未确认本地参考仓库是否与远端最新状态相同。

| 输入 | Context 路径 | Workflow 正文 / byte | 基准 start+process (ms) | 候选 start+process (ms) |
| --- | ---: | ---: | ---: | ---: |
| Parallax `5a6fbfb` | 281 | 5 / 6358 | 1.186 | 0.751 |
| [本地 Codex `970111f6`](https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97/.github/workflows) | 7336 | 28 / 317325 | 415.014 | 22.107 |

Codex 逆序观测为基准 410.206 / 候选 20.077 ms。这是包含启动、事件收集和计测的
单次配对观测，不是分布、adapter CPU 时间、端到端索引延迟或读取减少。原始
checkout 保持不变，没有启动本地 DB、app、模型或完整 suite。Codex 仅提供输入
数据，没有借用其实现代码。

每个 run 构建路径查询表，并用现有 ASCII 路径边界字符集的最大 token 查询
归一化正文。仍按原始路径顺序收集结果后执行原来的排序，保留排序相等和大小写
变体。特殊路径保留原 substring fallback，Docker COPY 和 evidence 计算不变。
两组 corpus 的正序、逆序、单文件处理以及 1298 个边界、Unicode、特殊路径组合的
完整事件数组与基准相同。集中测试检查原始 evidence 和忽略区间。本次没有修复
Unicode 小写展开和 CRLF 的既有坐标限制。未启用选择执行 flag、scanner 跳读或
carry SQL；其他语言 adapter 的独立 matcher 不在本次观测范围内。

### 原文 evidence 坐标修复

后续准确性修复按 LF 的顺序将搜索命中映射回原文，只构造一次原始行范围。
`İ` 转为小写时会从一个 UTF-16 单元展开为两个，因此搜索偏移不能直接索引原文。
希腊语末尾 sigma 依赖上下文，故保留整个正文的小写搜索。Docker 行遍历保留
实际 CRLF 宽度，延迟 stage source 的排除范围采用搜索坐标。
依据：[ECMAScript 小写转换](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.tolowercase)。

`tests/text-reference-evidence.test.ts` 覆盖展开、末尾 sigma、CRLF、UTF-16 列、
排除 source、空行及 fallback 路径与 stem。config/infra 版本 2 和共享 regex
版本 39 使未修改文件的旧 receipt 也执行 full 提取。
`tests/incremental-index-oracle.test.ts` 的四个 Git/非 Git oracle 注入实际旧事件
fixture，检查重建与 fresh graph 相同、已保存报告 snapshot 不变。仍需遵守既有
SCIP/trace 重新应用规则。本地不运行 DB/app，持久化 oracle 由必需的远程 CI 验证。
同一 Docker 行重复出现 source 字符串时，仍保留原 parser 选择首次出现位置的限制。

### Evidence 位置计算的数组分配

`offsetPosition()` 在同一 prefix 中遍历 LF 位置，不再创建行数组。
UTF-16 列和原有换行语义不变，因此保留共享 regex 版本 41。
修改前后的 19 项纯 evidence 检查均通过，覆盖空行、emoji、CRLF 边界、
独立 CR、U+2028/U+2029 和 EOF。

[CI 对比观测](https://github.com/YouSangSon/Parallax/actions/runs/40643803770)
在同一份不可变的 `23ec770` 源码归档上比较 baseline `be8df1a` 和候选
`c287c8b`。每个新 Node 24.21.0 进程限制为一个 CPU、1 GiB RAM、无 swap，
以 5 ms 间隔采样。两者均使用完整的 284 文件 startup context，处理相同的
11 个选定文件。5,718 个事件的逐文件 hash 和编码大小完全一致；编译后的
共享 adapter 是唯一不同的运行时文件。

| 观测 | Baseline | 候选 |
| --- | ---: | ---: |
| Profile 时长 | 11,820.212 ms | 10,352.266 ms |
| 文件处理区间之和 | 11,327.438 ms | 9,864.443 ms |
| Cgroup 内存峰值 | 225.82 MiB | 215.57 MiB |
| `offsetPosition` 自身 sample | 215 / 2,270 | 128 / 1,953 |

这是按 baseline、候选顺序各执行一次的观测，并非重复测量的性能分布。
处理区间包含事件 hash 计算，profile 包含采样开销；事件没有保留或写入 SQL。
两个进程都未触发内存限制或 OOM，所属资源已清理。这些结果不证明普遍加速、
VM 性能或此前整个源码 timeout 的原因。产品树已移除临时 harness；
CI 历史保留其源码及 profile 日志。必需的 release 验证保持不变。

### 历史版本的索引持久化诊断

两次 CI 诊断使用相同的 `23ec770` 源码和运行代码（shared adapter version 39）、
Node 24.21.0、1 CPU、1 GiB RAM 和零 swap。
[完整索引尝试](https://github.com/YouSangSon/Parallax/actions/runs/40652176355)
完成了全部 284 个文件的迭代并生成 26,571 个事件，但未在 90 秒内返回。
退出码为 124，没有生成 CPU profile，Verify 未执行。cgroup 没有触及内存限制或
发生 OOM。此前 VM 失败的原因仍需单独确认。

[缩小范围的诊断](https://github.com/YouSangSon/Parallax/actions/runs/40654547854)
仅从 `src/adapters/multi-language-regex.ts` 提取事件。持久化前确认其 2,070 个事件、
1,541,387 个编码字节与此前 SHA-256 一致。完整启动上下文、284 次正文读取
（4,698,579 bytes）、全部正文的秘密脱敏、metadata 和 scan-evidence 写入均保留。
其余 283 次提取调用返回空结果，并使用诊断专用 adapter version；这是部分图。

实际 indexer 在 5,298.948 ms 后返回，其中收集完成后的区间为 2,570.745 ms。
该区间包含 SQL 和后续记录工作，不是单独的 SQL CPU 时间。原始 287 个文件保持
字节一致，退出码为 0，任务资源清理通过，没有内存限制或 OOM 事件。CPU profile
包含 280 个 sample，其中 `persistEntityDescriptor` 直接执行 sample 为 25 个，
relation-evidence callback 为 18 个。虽然配置间隔为 50 ms，实际间隔仍有变化；
sample 数量不是耗时比例或 CPU 使用率。这些路径用于后续调查，不能证明完整索引
或 VM 加速。临时诊断代码不保留在产品树中。同一 head 的 canonical Verify 通过
832 项测试、dogfood 2/2、benchmark 和 dependency audit。

### 关系端点的索引执行编号更新

当关系端点重复出现且实体的索引执行编号已是当前值时，跳过 UPDATE。现有 INSERT
仍初始化新端点，后续执行中的首次引用仍推进编号。省去的 UPDATE 也避免了对应的
FTS 删除与插入；显式实体修改、version 行、搜索内容和发布事务保持原有路径。

`tests/index-publication.test.ts` 使用真实 indexer 和测试 DB 专用 trigger 观测写入。
修复前，两次完整执行产生了 11 次同值 freshness UPDATE。回归要求次数为零，同时
检查新增端点、重复引用、自引用、旧端点编号推进以及 version、关系和 evidence。
FTS 通过不会修复投影的只读连接检查，避免修复掩盖错误。这是可重复验证的写入次数
减少，不代表已经测得完整索引或 VM 加速。DB 检查在 CI 中运行。

### TypeScript 混合再导出循环

Default 与 named type resolver 交叉调用时共享已访问 export 的记录。
JSON tuple 键区分字符串 export 名称与含冒号的路径。循环分支终止后，
其他再导出仍可解析到具体声明。Named/namespace 查询缓存及 namespace/factory
遍历记录也使用 tuple 键，避免不同 export 被连接到错误文件，或被缓存的查询
失败遮蔽。共享 regex 版本 41 使旧提取 receipt 失效。
本地运行纯回归 `tests/typescript-export-cycle.test.ts`；Git/非 Git graph、
保存报告和 adapter audit 由现有 incremental oracle 在必需 CI 中验证。
实际捕获的版本 40 事件还验证未修改输入的重建及旧报告快照的保留。
此修复不证明先前 VM 整个源码 profile timeout 的原因。

### Docker source operand 范围

后续修复用 COPY/ADD operand 的原文范围替代上述首次出现位置的限制。前置
`--from` token/value 和所有 stage source operand 不参与通用本地引用匹配，
最后的 destination 仍然可见，避免重复 source、flag 值及 glob/URL 子串产生错误
本地关系。本地依赖只解析允许的 source 值。
依据：[Docker COPY source/destination 规则](https://docs.docker.com/reference/dockerfile/#copy)。

JSON 数组从原 payload 验证后，将字符串 lexeme 映射到原文范围，保留有效空白、
解码后的 escape 和实际引号。非法 JSON、非字符串数组或少于两个值的数组不会
进入第二个 lexer。Shell 引号和续行仍使用既有空白 token 文法，并非完整的
Dockerfile parser。config/infra 版本 3 增加 v2 cohort 的 Git/非 Git oracle，
检查错误 source 删除、destination 保留、fresh graph 相同和旧报告不变。
保留既有坐标/版本 oracle，本地不运行 DB/app。

### Config 提取成本观测

在添加选择性 config/infra carry 之前，`bench/config-extraction-profile.ts`
记录 baseline、修改一个 source 文件、修改一个 config 文件的 full 提取。
它使用包含 20 个 TypeScript 文件与 3 个 config 文件的新建非 Git 合成 fixture。
在获准的执行主机上构建 checkout，并传入已构建的 package 路径：

```bash
npm run build
node dist/bench/config-extraction-profile.js /path/to/built/parallax > config-profile.json
```

输出包括整个 index 调用耗时、所有 scan 累加的 read/byte 数、config 的
start/process/dispose 区间、各文件 event 数、runtime 模块 hash 与 host/Node 信息。
Process 区间包含 yield 之间消费者收集事件、等待与计测开销，不是 adapter CPU
时间，也不是净加速估计。`unchangedConfigWindowMs` 排除修改过的 config 文件。
没有跳过读取；该小案例不测量 Git 历史、cache precheck 或大型仓库。成功或普通
异常时会删除 fixture。时间观测不进入确定性 accuracy report 或通过阈值；远程
正确性测试只验证 phase/count，不评价性能。观测器和合成 generator 都属于 npm
payload 之外的 bench 文件。

2026-10-25 在获准 VM 上观测：PR #55 的合并提交 `5fc6cba`，Node
`v24.14.0 --max-old-space-size=512`，Ubuntu 24.04 / Linux 6.8.0-147-generic
`linux/x64`，Xeon Gold 6148，2 个逻辑 CPU、4 GB RAM。整个执行使用共享进程锁，
并以 cgroup 限制为 1 个 CPU / 1 GiB。npm archive SHA-256 为
`4f4ab3125c5b85edb149d4586f56c23de77ed0bb019574533c0b9953a3f44309`；
观测器另记录了 5 个加载的 runtime 模块 hash。命令：

```bash
node --max-old-space-size=512 profile-tool/config-extraction-profile.js package
```

| 阶段 | Index 调用 (ms) | Scan (ms) | 全部 config 处理区间 (ms) | 未修改 config 区间 (ms) | 正文读取 / byte |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 146.157 | 14.653 | 2.139 | 2.139 | 23 / 1258 |
| source-edit | 141.282 | 3.716 | 0.876 | 0.876 | 23 / 1258 |
| config-edit | 85.875 | 2.995 | 0.326 | 0.156 | 23 / 1231 |

每个阶段均为 full 提取、一次 scan、3 次非空 config 处理调用，sample 读取为零。
这些是依次执行的单次观测，包含启动与 cache 效应，不是统计比较。两个修改案例中，
未修改 config 的区间均小于 1 ms。该 fixture 不足以支持增加通用选择性 carry 的
复杂度；保留保守路径，仅在代表性工作负载证明 config 成本显著时重新考虑。
这不证明净加速、安全跳过读取或大型仓库性能。VM 使用临时 Node 和禁用 lifecycle
script 的锁定依赖，没有请求模型。CLI 帮助与错误的观测器调用另行检查；已验证强制
超时清理并移除执行 fixture。这不是默认 embedding 或生产环境 smoke。

工作台的导出失败与剪贴板失败分别验证：JSON/CSV/PNG 失败显示当前 UI 语言的
"导出失败"，复制失败显示"复制失败"。缺少图时仍须拒绝生成 PNG。纯 client 测试
使用平台 stub；真实 VM/浏览器观测和远程 rendered HTML 测试属于不同证据范围。

### 当前本地 baseline

于 2026-06-28 在 commit `f8f6060` 上采集，环境为 macOS Darwin 24.6.0、Apple M1 Max、10 CPU cores、32 GiB RAM、Node `v24.14.0`、npm `11.9.0`。

此 historical table 早于 scan phase column，并保留当时的
`edit_incremental_ms` 名称。Current output 将 changed-body phase 标为
`edit_reindex_ms`；比较时请在当前 checkout 重新运行命令。

命令：

```bash
npm run bench:perf -- --scales 1000,2000
```

| files | full_index_ms | noop_incremental_ms | edit_incremental_ms | analyze_no_persist_ms | analyze_persist_ms | affected | observed_peak_rss_mb | full_index_ms/kfile | noop_incremental_ms/kfile | edit_incremental_ms/kfile | analyze_no_persist_ms/kfile | analyze_persist_ms/kfile |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1000 | 5251 | 3655.8 | 3594.0 | 1947.0 | 1935.7 | 200 | 328 | 5251 | 3656 | 3594 | 1947 | 1936 |
| 2000 | 17526 | 14266.0 | 14179.2 | 7688.0 | 7707.7 | 200 | 261 | 8763 | 7133 | 7090 | 3844 | 3854 |

也尝试了标准 large-repo 命令 `npm run bench:perf -- --scales 10000`。在这台主机上约 20 分钟内没有输出表格，因此中断。由于 10k full-phase run 没能在本地限制内完成，未启动 50k run。在降低 analyzer/indexing 成本，或为 perf runner 增加 phase-split/progress mode 之前，请把此 baseline host 上的 10k/50k full-phase `bench:perf` 视为**尚不支持**。

## docs linter

`scripts/docs-lint.js`（通过 `npm run docs:lint` 运行）是针对 tracked Markdown 和未被 ignore 的本地 untracked Markdown 的 static gate。它强制：

- **无禁止内容**——本地机器路径、restore-point 元数据，以及 runtime redaction 覆盖的 secret family，例如 API key、service token、bearer/JWT credential、带 credential 的 database URL 和私钥。此扫描在包含 fenced code block 的 raw 文本上运行。
- **trilingual parity**——trilingual zone（`docs/` 中排除 `docs/assets/`、`skills/`，以及根 `README`/`CONTRIBUTING`/`SECURITY`）中的每篇文档都必须同时具备 `X.md`、`X.ko.md`、`X.zh.md` 三者。
- **switcher 存在**——每个文件都必须链接到它的另外两种语言变体（H1 下方的语言 switcher）。
- **same-language 内部链接**——在 `X.ko.md` 内，只要同语言 twin 存在，内部 `.md` 链接就必须指向 `.ko.md` 兄弟（在 `X.zh.md` 内则指向 `.zh.md`）。switcher 行是唯一允许的 cross-language 例外。链接检查会忽略 fenced code block，因此 code block 中的 markdown 链接*示例*是安全的。
- **本地 Markdown 目标存在**——非 image 的本地 `.md` 链接必须解析到 working tree 中的 Markdown 文件，包括尚未 staged 的新 untracked docs。

## 持续集成（CI）

CI 和 Release 的 CPU job 设置 `ONNXRUNTIME_NODE_INSTALL=skip`，跳过可选
GPU 文件下载，随后加载 native ONNX binding 并确认包内 CPU backend 可用。
此官方 [ONNX 安装选项](https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/js/node/script/install.js)
保留正常的 npm lifecycle script，也适用于 PR baseline 安装。不改变包版本
或用户安装默认值。该检查不运行模型，也不验证 GPU 推理；dependency audit
仍是独立的 metadata 检查。

`.github/workflows/ci.yml` 在每次向 `main` 的 push 与 pull request 上运行。`verify` job 在 Node.js 24 上按顺序运行：

```bash
npm ci
npm run verify
npm run bench:report -- --github-step-summary --allow-missing --baseline .parallax/bench/impact-bench-baseline.json
```

`npm run verify` 是 canonical source-checkout gate。它先运行 lint，然后运行 install smoke（唯一负责 build）、fast unit suite、dogfood、bench，最后运行依赖 registry 的 audit。在 pull request 中，CI 会先从 base SHA 准备 `.parallax/bench/impact-bench-baseline.json`，因此最后的 summary 会包含 score、relation、affected-file、retrieval 与 semantic recall delta。

## 如何添加测试

测试位于 `tests/` 下，遵循 **Arrange-Act-Assert** 模式——准备一个隔离的临时 repo，运行真实入口（`initProject` / `indexProject` / `analyzeDiff` / `searchContextForRepo`），然后对结果做断言。大多数 suite 会创建并清理一个临时目录，从而让每个 test 相互隔离。

- **unit 与 integration test** 是 `tests/*.test.ts`，在 `npm test` 下运行。
- **adapter 变更** 还必须在 `bench/impact-bench.ts` 的 bench fixture 中补充新的期望 relation，并遵循 [`extending-adapters.zh.md`](extending-adapters.zh.md) 中描述的 evidence/confidence 规范。
- **engine 变更**——indexer、adapters、analyzer、store、graph 或 cross-repo 任意层——都必须用 `npm run test:dogfood` 做 dogfood 验证，而不仅是 unit green。若你改变了 relation 的抽取或排序方式，请重新运行 `npm run bench`，并仅在变更为有意为之时更新 pin 住的期望值。

在开 PR 前，运行完整的本地 gate：

```bash
npm run verify
```

## 参见

- [extending-adapters.zh.md](extending-adapters.zh.md) — adapter contract、evidence/confidence 规范与 adapter 测试
- [invariants.zh.md](invariants.zh.md) — bench 检查的 evidence-first 与 deterministic-output 不变量
- [cli-reference.zh.md](cli-reference.zh.md) — 测试所行使的 CLI surface
- [README.zh.md](README.zh.md) — 文档索引
