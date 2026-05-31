# Contributing to Parallax

Contributions are welcome. Parallax is a local-first tool that helps agentic
coding tools see the impact scope and test candidates more accurately before
they change code.

## Development Environment

What you need:

- Node.js `>=24.0.0`
- npm

Getting started:

```bash
npm install
npm run build
npm test
```

## How We Work

Please check this scope before making changes.

- The MVP focuses on `init`, `index`, `analyze`, and the read-only MCP.
- Obsidian write sync, graph DB, and the CodeQL adapter are still deferred scope.
- We do not add MCP write tools by default.
- file input must pass the repo root containment check.
- evidence must be redacted before it is stored or printed.

## Pull Request Checklist

Please run the commands below before opening a PR.

```bash
npm run lint
npm test
npm run test:security
npm run test:mcp
npm run test:install-smoke
npm audit --audit-level=high
```

Even for documentation-only changes, please run at least the following.

```bash
npm run docs:lint
```

## Testing Principles

- For new features, add tests first.
- When you change a security boundary, add a regression test to `tests/security.test.ts`.
- When you change the MCP surface, add a contract test to `tests/mcp.test.ts`.
- When you change impact analysis results, add a fixture-based test.

## Commit Messages

Recommended format:

```text
feat: add diff parser
fix: reject symlink escapes
docs: update MCP usage
test: cover redaction edge cases
```
