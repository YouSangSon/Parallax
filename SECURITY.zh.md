# Security Policy

[English](SECURITY.md) · [한국어](SECURITY.ko.md) · **中文**

Parallax 是一款读取并分析本地仓库的工具。安全问题的优先级高于普通 bug。

## 支持范围

当前的安全支持范围：

- `main` branch
- 最新 npm package 对应的代码

## 报告方式

请使用 GitHub Security Advisory 进行非公开报告。

Repository: https://github.com/YouSangSon/Parallax

Security-sensitive 示例：

- 读取 repo root 之外文件的 path traversal
- symlink escape
- MCP write capability 被意外暴露的问题
- 通过绕过 redaction 导致 secret 暴露在 report/MCP output 中的问题
- 在 `.parallax/` 内部 DB 或 report 中存储 raw secret 的问题

请勿在公开 issue 中提交真实的 secret、private repository path 或 exploit payload。

## 安全原则

- MCP 不进行 source/external write。作为例外，agent memory facts、branch lifecycle、reflection/repair、context telemetry 等 `.parallax/` 内部的 repo-local writes 仅在明确指定的 tool 中允许。
- Impact report 和 context pack 默认在 tool 响应中以 compact 形式返回，较大的 payload 通过 resource-on-demand 读取。
- project command execution 不在 MVP 范围内。
- 所有 file input 都必须经过 realpath containment check。
- evidence 在存储或输出前必须经过 redaction。
- docs lint 必须拦截 local machine path 和 secret-like content。

## 从外部 memory platform 学到的 guardrail

在评估 `rohitg00/agentmemory` 适用性的过程中，我们确认了 viewer XSS、shell installer RCE、default HTTP bind、unauthenticated mesh、export traversal、redaction gap 等 upstream advisory。Parallax 不引入该 platform，但将以下原则作为 core guardrail 保留。

- 默认执行路径是 CLI 和 MCP stdio。不会在 core 中隐式添加 HTTP server、stream server、WebSocket、proxy、background daemon。
- `curl | sh` 形式的 installer 不会作为文档或自动化的默认路径使用。
- 如果新增 local UI，必须是 opt-in，并默认采用 CSP nonce、no inline handler、escaped text rendering、不显示 raw secret。
- 如果新增外部 export/write 功能，仅靠 lexical path check 是不够的。基于 realpath/lstat 的 containment 和 symlink escape 测试是必需的。
- MCP `tools/list` 通过 exact surface test 固定，即使 list 中不存在的 agentmemory 式 export/write/mesh/team 工具被以 `tools/call` 直接调用，也必须失败。
- automatic hook capture 和 context injection 不是默认功能。即使将来构建 hook adapter，也要求 opt-in、bounded payload、fire-and-forget telemetry、short timeout。
