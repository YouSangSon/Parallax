# Parallax — 验证与测试

[English](verification.md) · [한국어](verification.ko.md) · **中文**

Parallax 分层验证正确性——快速的 unit suite、typecheck、docs linter、确定性的 accuracy bench，以及把 Parallax 对自身重新索引的 dogfood guard。CI 在每次 push 和 pull request 上运行全部这些。本指南说明每一层捕获什么、何时运行——核心教训是：green unit test 对 engine 变更**必要但不充分**。

## script 一览

下面每条命令都是 `package.json` 中定义的 `npm run` script。

| 命令 | 作用 | 何时运行 |
| :--- | :--- | :--- |
| `npm test` | 通过 `tsx --test` 对 `tests/**/*.test.ts` 运行 Node test runner | 任何变更后；默认的快速 suite |
| `npm run check` | `tsc --noEmit` 类型检查，不产出文件 | commit 前；捕获类型回归 |
| `npm run lint` | 一起运行 `check` + `docs:lint` | commit / PR 前；完整的 static gate |
| `npm run docs:lint` | 对 tracked/untracked Markdown 运行 `scripts/docs-lint.js`，包括本地 `.md` 链接目标 | 编辑任何文档后 |
| `npm run verify` | 运行 canonical source-checkout release gate：lint、install smoke、fast tests、dogfood、bench 和 high-level audit | release 前和 CI |
| `npm run build` | `tsc -p tsconfig.json`，编译到 `dist/` | 发布或 smoke 测试 CLI 前 |
| `npm run bench` | 运行 `bench/impact-bench.ts`；accuracy 回归时以 non-zero 退出 | engine/adapter 变更后 |
| `npm run bench:report` | 将最新 bench JSON 渲染为 Markdown，并可选地与 baseline report 比较 | `npm run bench` 后，或用于 CI summary |
| `npm run bench:perf` | 运行 `bench/impact-perf.ts`；在合成 repo 上测量 full index、no-op incremental index、edited-file incremental index 与 analyze phase 耗时（非确定性，不在 `verify` 中） | 处理 indexing/traversal 性能时 |
| `npm run test:dogfood` | 对 Parallax 自身 source 进行索引并断言内部 graph 存活 | engine 变更后（indexer/adapters/analyzer/store/graph） |
| `npm run test:mcp` | 运行 `tests/mcp.test.ts`（impact / context / memory / telemetry / 路径校验） | MCP surface 变更后 |
| `npm run test:ui` | 运行 `tests/ui.test.ts`（UI 快照、服务器、JSON 资源端点） | UI 变更后 |
| `npm run test:security` | 运行 `tests/security.test.ts`（路径包含约束 + 脱敏） | store / 路径 / 脱敏变更后 |
| `npm run test:install-smoke` | 先 `npm run build` 再 `node dist/src/cli.js --help` | 发布前，确认打包后的 CLI 能启动 |

`test:fixtures` 是 `npm test` 的别名，`test:benchmark` 是 `npm run bench` 的别名。`npm run verify` 包含 `npm audit --audit-level=high`，所以最后的 audit 阶段依赖 npm registry 和网络可用性。

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

Deterministic bench 也包含 cross-repo contract-impact lane。该 lane 构建 two-repo workspace fixture，通过 `analyzeContractDiff` persist breaking contract link，然后检查 `analyzeDiff` 与 report-scoped graph export 是否仍暴露 expected `web:src/client.ts` consumer impact。该 lane 不会 reweight 历史 `summary.score`，而是通过 `crossRepoContracts.summary.passed` gate `summary.passed`。

凡是触及 relation 抽取、排序或 retrieval 的变更之后，都运行 `npm run bench`。

`npm run bench:report` 会把 `.parallax/bench/impact-bench-report.json` 转成紧凑的 Markdown summary。传入 `--baseline <json>` 时会包含相对上一份 report 的 delta column；传入 `--github-step-summary` 时会 append 到 GitHub Actions step summary。CI 在 pull request 中会先从 PR base SHA 生成 baseline report，然后在 `npm run verify` 之后报告 head-vs-base bench delta。

## performance bench

`bench/impact-perf.ts`（通过 `npm run bench:perf` 运行）在**确定性合成 repo**（`bench/synthetic-repo.ts`）上以递增规模测量 full index、no-op incremental index、edited-file incremental index 与 analyze 成本——一个 module hub 结构，改动 leaf 会波及所有 importer，从而压测 analyzer 的 reverse-dependency traversal。它与 accuracy bench 及 `npm run verify` **刻意分离**：耗时与 peak RSS 是非确定性的，绝不能进入字节一致的 `impact-bench-report.json`。用它来建立 baseline，或在处理 indexer/analyzer 时排查疑似回归；在 CI 中可对最差 index phase `/kfile` 成本使用宽松的 `--max-ms-per-kfile` ceiling 设闸。

```bash
npm run bench:perf -- --scales 1000,10000        # 自定义规模
npm run bench:perf -- --max-ms-per-kfile 2000    # 超过 ceiling 即失败
```

输出表会分开显示 `full_index_ms`、`noop_incremental_ms`、`edit_incremental_ms`、`analyze_no_persist_ms`、`analyze_persist_ms` 以及对应的 `/kfile` 列。计时运行不在 verify 中，但合成 generator 和表格 formatter 由 `tests/synthetic-repo.test.ts` 在常规 verify 闸中守护。

## docs linter

`scripts/docs-lint.js`（通过 `npm run docs:lint` 运行）是针对 tracked Markdown 和未被 ignore 的本地 untracked Markdown 的 static gate。它强制：

- **无禁止内容**——本地机器路径、restore-point 元数据，以及 runtime redaction 覆盖的 secret family，例如 API key、service token、bearer/JWT credential、带 credential 的 database URL 和私钥。此扫描在包含 fenced code block 的 raw 文本上运行。
- **trilingual parity**——trilingual zone（`docs/` 中排除 `docs/assets/`、`skills/`，以及根 `README`/`CONTRIBUTING`/`SECURITY`）中的每篇文档都必须同时具备 `X.md`、`X.ko.md`、`X.zh.md` 三者。
- **switcher 存在**——每个文件都必须链接到它的另外两种语言变体（H1 下方的语言 switcher）。
- **same-language 内部链接**——在 `X.ko.md` 内，只要同语言 twin 存在，内部 `.md` 链接就必须指向 `.ko.md` 兄弟（在 `X.zh.md` 内则指向 `.zh.md`）。switcher 行是唯一允许的 cross-language 例外。链接检查会忽略 fenced code block，因此 code block 中的 markdown 链接*示例*是安全的。
- **本地 Markdown 目标存在**——非 image 的本地 `.md` 链接必须解析到 working tree 中的 Markdown 文件，包括尚未 staged 的新 untracked docs。

## 持续集成（CI）

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
