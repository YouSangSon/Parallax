# Parallax — 发布检查清单

[English](release-checklist.md) · [한국어](release-checklist.ko.md) · **中文**

在发布 package、创建 release tag 或合并会改变 engine behavior 的变更前，使用此检查清单。

Source checkout 说明：这些 gate 需要 repository checkout。npm package 会发布 compiled artifact，但不发布这些 script 调用的 TypeScript source target，例如 `tests/**/*.test.ts`、`bench/impact-bench.ts` 和 `scripts/docs-lint.js`。

## 必需本地 gate

在 source checkout 的仓库根目录运行：

```bash
npm run verify
```

`npm run verify` 是 canonical aggregate gate。最后的 audit 阶段依赖 npm registry 和网络可用性。

## 每个 gate 证明什么

| Gate | 证明 | 何时必需 |
| :--- | :--- | :--- |
| `npm run lint` | TypeScript typecheck 和 docs lint 通过。 | 每次变更。 |
| `npm run test:install-smoke` | 构建后的 CLI 能从 `dist/` 启动；这个 sub-gate 是 `verify` 中唯一负责 build 的步骤。 | Release 和 CI。 |
| `npm test` | 快速 unit 和 integration test 通过。 | 每次变更。 |
| `npm run test:dogfood` | Parallax 能 index 自己并保留真实 dependency graph。 | Engine 变更。 |
| `npm run bench` | Multi-language fixture 的 recall、evidence、ranking 和 retrieval 保持在固定期望内。 | Adapter、analyzer、search、ranking 或 retrieval 变更。 |
| `npm audit --audit-level=high` | 当前 lockfile 没有 high-level dependency advisory。 | Release 和 CI。 |

## 文档 gate

如果用户可见行为发生变化：

1. Landing page 承诺变化时，更新 root README variants。
2. CLI command、flag、output 或 exit code 变化时，更新 `docs/cli-reference*.md`。
3. MCP tool、resource、annotation 或 side effect 变化时，更新 `docs/mcp*.md`。
4. Adapter 契约变化时，更新 `docs/extending-adapters*.md`。
5. Subsystem boundary 或 storage rule 变化时，更新 `docs/architecture*.md`。
6. 运行 `npm run docs:lint`。

## Dependency gate

当 `npm audit fix` 修改 `package-lock.json` 时：

1. 除非 direct dependency range 必须改变，否则确认 `package.json` 没有变化。
2. 审查 direct 和 transitive package bump。
3. 运行 `npm run test:install-smoke`。
4. 运行 `npm audit --audit-level=high`。

## Engine-change gate

Engine change 指 indexer、adapter、analyzer、store、graph export、cross-repo resolver、MCP search 或 context-pack ranking path 下的任何变更。

此类变更需要：

1. 添加在修复前会失败的聚焦测试。
2. 运行 `npm test`。
3. 运行 `npm run test:dogfood`。
4. 运行 `npm run bench`。
5. 只有当行为变化是有意且已文档化时，才更新 benchmark expectation。

## 最终 review

合并前：

1. 审查 `git diff --stat`。
2. 审查 `git diff`。
3. 确认没有 local path、secret-like string 或 generated report 被 staged。
4. 确认 `.parallax/`、`dist/`、`node_modules/` 和 `.worktrees/` 保持 untracked。
5. 确认 CI 在 `npm ci` 后运行 `npm run verify`。
