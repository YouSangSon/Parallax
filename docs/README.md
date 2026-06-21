# Parallax — Documentation

**English** · [한국어](README.ko.md) · [中文](README.zh.md)

Parallax is a local-first code impact-analysis layer: a single SQLite store powers a CLI, an MCP server for coding agents, and a UI explorer. This index links the main packaged guides in `docs/`.

## Concepts and direction

| Document | Contents |
| :--- | :--- |
| [`vision.md`](vision.md) | Project vision |
| [`value-proposition.md`](value-proposition.md) | Value proposition and differentiation |
| [`roadmap.md`](roadmap.md) | Current backlog and next slices |
| [`invariants.md`](invariants.md) | Invariants like local-first, redaction, and the permission model |
| [`glossary.md`](glossary.md) | Glossary |
| [`architecture.md`](architecture.md) | Runtime architecture and extension map |

## Reference

| Document | Contents |
| :--- | :--- |
| [`mcp.md`](mcp.md) | MCP server, tools, and resources |
| [`cli-reference.md`](cli-reference.md) | Every CLI command, flag, and exit code |
| [`report-schema.md`](report-schema.md) | Published JSON Schema for `analyze --json` output |
| [`extending-adapters.md`](extending-adapters.md) | Authoring semantic adapters |
| [`verification.md`](verification.md) | Verification layers, test scripts, and the dogfood guard |
| [`operations.md`](operations.md) | Troubleshooting and operator runbook |
| [`release-checklist.md`](release-checklist.md) | Release, CI, audit, and package smoke checklist |

## Source checkout note

The repository checkout also contains TypeScript source files, tests, benchmark fixtures, and a Parallax skill for Claude Code / Codex users under `skills/`. Packaged docs do not link to `skills/` because the npm package ships the built CLI plus public docs, not the skill directory. Maintainer docs such as architecture and release checklist call out when they require a source checkout.

For the project landing page, see the [root README](../README.md).
