# Security Policy

Parallax is a tool that reads and analyzes local repositories. Security issues take
higher priority than ordinary bugs.

## Supported Scope

Current security support scope:

- `main` branch
- Code as of the latest npm package

## How to Report

Please report privately using a GitHub Security Advisory.

Repository: https://github.com/YouSangSon/Parallax

Examples of security-sensitive issues:

- path traversal that reads files outside the repo root
- symlink escape
- MCP write capability being unintentionally exposed
- secrets being exposed in report/MCP output by bypassing redaction
- raw secrets being stored in the DB or reports inside `.parallax/`

Please do not post real secrets, private repository paths, or exploit payloads in
public issues.

## Security Principles

- MCP does not perform source/external writes. As exceptions, repo-local writes
  inside `.parallax/` such as agent memory facts, branch lifecycle,
  reflection/repair, and context telemetry are allowed only from explicitly
  designated tools.
- Impact reports and context packs are returned compactly in tool responses by
  default, and large payloads are read resource-on-demand.
- project command execution is out of scope for the MVP.
- All file input must pass a realpath containment check.
- evidence must be redacted before it is stored or output.
- docs lint must block local machine paths and secret-like content.

## Guardrails Learned from External Memory Platforms

While evaluating the applicability of `rohitg00/agentmemory`, we identified upstream
advisories such as viewer XSS, shell installer RCE, default HTTP bind,
unauthenticated mesh, export traversal, and redaction gaps. Parallax does not pull in
that platform, but we keep the following principles as core guardrails.

- The default execution paths are CLI and MCP stdio. HTTP server, stream server,
  WebSocket, proxy, and background daemon are not added implicitly to the core.
- `curl | sh` style installers are not used as a default path in documentation or
  automation.
- If a local UI is added, it must be opt-in, with CSP nonce, no inline handlers,
  escaped text rendering, and no display of raw secrets as defaults.
- If external export/write features are added, a lexical path check alone is not
  enough. realpath/lstat-based containment and symlink escape tests are mandatory.
- MCP `tools/list` is pinned with an exact surface test, and any agentmemory-style
  export/write/mesh/team tool not present in the list must fail even if invoked
  directly via `tools/call`.
- automatic hook capture and context injection are not default features. Even if a
  hook adapter is built in the future, it must require opt-in, bounded payloads,
  fire-and-forget telemetry, and short timeouts.
