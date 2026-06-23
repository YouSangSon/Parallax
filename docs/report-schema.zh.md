# Parallax — 报告 JSON Schema

[English](report-schema.md) · [한국어](report-schema.ko.md) · **中文**

`parallax analyze --json` 会打印一份 **impact report**。Parallax 为该输出发布机器可读的 [JSON Schema](https://json-schema.org/)，让消费者（CI gate、仪表盘、其他 agent）无需逆向 TypeScript 类型即可校验输出。

## 产物

| | |
| :--- | :--- |
| 路径 | [`schemas/impact-report.schema.json`](../schemas/impact-report.schema.json) |
| Dialect | JSON Schema draft 2020-12 |
| `$id` | `https://raw.githubusercontent.com/YouSangSon/Parallax/main/schemas/impact-report.schema.json` |
| `version` | 报告形态的语义化版本（当前为 `1.1.0`） |

该 schema 描述 `parallax analyze --json` 输出的对象（`ImpactReport`）：`id`、`indexRunId`、`changedFiles`、`affectedFiles`、`changed`、`affected`、`actions`、`evidence`，以及可选的 `adapterInsights` / `warnings`。注意 `--json` 不会持久化报告，因此该输出中不含可选字段 `reportPath`。

同一份产物也会随 npm package 一起发布，因此 packaged consumer 无需克隆 source checkout 也能校验 `report.json`。

## 校验输出

任何 JSON Schema 校验器都可用。例如使用 [`ajv`](https://ajv.js.org/)：

```bash
parallax analyze --changed src/store.ts --json > report.json
npx ajv-cli validate -s schemas/impact-report.schema.json -d report.json --spec=draft2020
```

## 版本策略

`version` 字段携带报告形态的语义化版本：

- **patch** — 仅文档或非结构性澄清。
- **minor** — 新增可选字段。
- **major** — 移除/重命名字段或收紧类型。

该 schema 是**封闭的**（每一层都是 `additionalProperties: false`），因此校验严格，且兼容方向是单向的：旧报告始终能通过新 schema，但新报告（携带 minor 中新增的字段）会被旧 schema *拒绝*。因此消费者应跟踪某个 major 内的最新 schema，而不是锁定到精确的 minor。`$id` 在各版本间保持稳定；用于比较的信号是 `version` 字段。

## 如何保持同步

手写的 `ImpactReport` 类型（`src/types.ts`）保持权威。schema 以 zod（`src/report_schema.ts`）镜像，产物由其生成：

```bash
npm run schemas:build   # 重新生成 schemas/impact-report.schema.json
```

两个守卫保持产物诚实，且都接入 `npm run verify`：

- **编译期一致性** 断言（`tests/report-schema.test.ts`）：当 `ImpactReport` 与 zod schema 出现偏离时，使 `npm run check` 失败。
- **drift guard**（`npm run schemas:check`，属于 `npm run lint`）：当已提交产物陈旧时失败。还有一个测试用真实的 `analyze --json` 输出来校验 schema，因此发布的契约会与实际输出（而不仅是类型）对照。

## 范围

该 schema 覆盖 impact report。基准报告（输出到 `.parallax/bench/` 下的 `parallax` 质量指标）是内部产物，尚未 schema 化。

## 另见

- [cli-reference.zh.md](cli-reference.zh.md) — `analyze --json` 标志
- [mcp.zh.md](mcp.zh.md) — 同一存储之上的 MCP 服务器 surface
