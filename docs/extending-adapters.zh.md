# Parallax — 扩展适配器

[English](extending-adapters.md) · [한국어](extending-adapters.ko.md) · **中文**

Parallax 通过 **semantic adapter** 提取其 entity/relation graph。每个 adapter 负责一种语言或文件格式，把扫描到的文件转化为 entity、relation 和 diagnostic。本指南描述 adapter 契约、adapter 如何注册与选择，以及它们必须遵循的 evidence/confidence 纪律，并附一个最小示例。

## adapter 契约

adapter 实现 `SemanticAdapter` 接口（`src/adapters/types.ts`）：

- `id` — 唯一且稳定的标识符。用相同 `id` 注册两个 adapter 会 throw。
- `version` — adapter 版本字符串（见[版本管理](#版本管理与重新提取)）。
- `capabilities` — 此 adapter 能产生的 `AdapterCapability` 值。
- `confidence?` — adapter 的默认 confidence 标签（省略时回退为 `unknown`）。
- `knownGaps?` — 关于此 adapter *不*解析什么的人类可读说明。
- `supports(file)` — 若此 adapter 处理该文件则返回 `true`。
- `start(ctx, files)` — 为该 index run 返回一个 `AdapterRun`（或 `Promise<AdapterRun>`）。

返回的 `AdapterRun` 暴露 `process(file)`——一个 yield `IndexEvent` 的 async generator——以及可选的 `dispose()`。每个 `IndexEvent` 是三种 kind 之一：

- `entity` — 一个 `PendingEntity`（`EntityDescriptor`：`kind`、可选 `path`、`symbol`、`symbolKind`、`languageId`、`displayName`、`metadata`）。
- `relation` — 带有 `source` 与 `target` descriptor、一个 `RelationKind`、可选 `metadata` 与 `evidence` 的 `PendingRelation`。
- `diagnostic` — 一条 `warn` 或 `error` 消息，可选地关联到某文件。

orchestrator 对每个 `EntityDescriptor` 做 content-hash 来计算其 entity id，因此相同的 descriptor 总是映射到相同的 entity。

## Capability

`AdapterCapability` 是以下之一：`imports`、`exports`、`calls`、`references`、`types`、`symbols`、`docrefs`、`tests`、`packages`。adapter 声明它能提取的子集，使 coverage 与 gap 按 adapter 显式呈现。

## Evidence 与 confidence（不变量 I-10）

每个 relation 都应携带 `evidence`——一个 source 文件、span 与 snippet——以及一个 confidence 标签。`Confidence` 有四个级别：

- `proven` — 由 parser 级 fact 支撑。
- `inferred` — 推导得出但有充分支撑。
- `heuristic` — 宽泛的基于模式的 coverage。
- `unknown` — 缺少 confidence 时的回退。

这强制了不变量 **I-10**（见 [invariants.zh.md](invariants.zh.md)）：每个 impact 判断都同时携带 evidence + provenance + confidence，未知之物以 `unknown` 显式呈现而非当作 fact。adapter 的每次 run 的 confidence 与 `knownGaps` 都会被记录，使 agent 与人能区分 parser 支撑的结果与宽泛的 heuristic coverage。

## 注册与选择顺序

adapter 存放于 registry（`src/adapters/registry.ts`），由 `src/indexer.ts` 中的 `createDefaultRegistry()` 组装。选择在注册顺序中是 **first-match-wins**——`pickAdapter(file)` 返回首个 `supports()` 为 `true` 的已注册 adapter。

这使注册顺序 load-bearing。默认 registry 按以下顺序注册：build-system/package adapter、config/infra adapter、TypeScript/JavaScript adapter、JVM/Spring adapter、Python adapter、Go adapter、Rust adapter，最后是 multi-language regex adapter。最后那个 adapter 是一个 `supports()` 永远返回 `true` 的 **catch-all**，因此必须 LAST 注册——任何注册在 catch-all 之后的 adapter 都不可达。registry 的安全网记录并 assert 了这一顺序。

## 版本管理与重新提取

每次 index run 都会记录一个由所有活跃 adapter 的 `id` 与 `version` 组成的 `extractor_version` 签名。提升某 adapter 的 `version` 会在下一次 `parallax index` run 中改变该记录的签名。每当 adapter 的提取输出改变时就提升 `version`，以免运行在 adapter 版本之间被悄悄混淆。

## 最小示例

一个处理 `.example` 文件、发出一个 `file` entity 和一个带 evidence 的 `IMPORTS` relation 的小 adapter：

```ts
import type {
  AdapterCapability,
  AdapterRun,
  ExtractCtx,
  IndexEvent,
  SemanticAdapter
} from './types.js';
import type { ScannedFile } from '../types.js';

const capabilities: readonly AdapterCapability[] = ['imports'];

export class ExampleAdapter implements SemanticAdapter {
  readonly id = 'example';
  readonly version = '0.1.0';
  readonly capabilities = capabilities;
  readonly confidence = 'heuristic';
  readonly knownGaps = ['only resolves a single literal import form'];

  supports(file: ScannedFile): boolean {
    return file.relativePath.endsWith('.example');
  }

  start(_ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun {
    return {
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        // 1) 将文件声明为 entity。
        yield { kind: 'entity', entity: { kind: 'file', path: file.relativePath } };

        // 2) 发出一个由 evidence 支撑的 relation。
        const match = /^import\s+(\S+)/m.exec(file.content);
        if (match) {
          yield {
            kind: 'relation',
            relation: {
              source: { kind: 'file', path: file.relativePath },
              target: { kind: 'file', path: match[1]! },
              kind: 'IMPORTS',
              evidence: [
                {
                  file: file.relativePath,
                  snippet: match[0],
                  startLine: 1,
                  confidence: 'heuristic'
                }
              ]
            }
          };
        }
      }
    };
  }
}
```

在 `createDefaultRegistry()` 中把它注册在 catch-all adapter **之前**，使其 `supports()` 先被参考。

## 另见

- [mcp.zh.md](mcp.zh.md) — 读取已索引 graph 的 MCP surface
- [cli-reference.zh.md](cli-reference.zh.md) — `parallax index` 与分析命令
- [invariants.zh.md](invariants.zh.md) — evidence-first 不变量（I-10）
- [glossary.zh.md](glossary.zh.md) — adapter、evidence、confidence 定义
