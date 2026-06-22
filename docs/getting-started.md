# Parallax - Getting Started

**English** · [한국어](getting-started.ko.md) · [中文](getting-started.zh.md)

This is the shortest useful path: initialize a repo, build the local index, analyze one change, inspect the saved report in the UI, then expose the same read-only surface to an MCP client or CI guardrail.

Assumption: the `parallax` CLI is already on your `PATH`.

## 1. Initialize the repo

From the repository you want to analyze:

```bash
parallax init
```

This creates the local `.parallax/` directory and the SQLite database at `.parallax/impact.db`.

## 2. Build the first index

```bash
parallax index
```

The first run scans the working tree and stores files, entities, relations, evidence, and coverage rows in the local database. Run `parallax index` again after a code or doc change to refresh the graph.

## 3. Analyze a change

Analyze an explicit changed file:

```bash
parallax analyze --changed src/auth/session.ts --depth 2
```

For machine use, emit JSON instead of a persisted report:

```bash
parallax analyze --changed src/auth/session.ts --depth 2 --json > report.json
```

The exact paths depend on your repo, but an impact report should look roughly like this:

```json
{
  "changedFiles": ["src/auth/session.ts"],
  "affectedFiles": [
    { "path": "src/routes/private.ts", "confidence": "proven", "depth": 1 },
    { "path": "tests/session.test.ts", "confidence": "inferred", "depth": 1 },
    { "path": "docs/auth-policy.md", "confidence": "heuristic", "depth": 1 }
  ]
}
```

The important signal is that Parallax ranks the likely blast radius across code, tests, docs, contracts, or config with evidence and confidence labels. By default, `analyze` exits with code `1` when any affected file is found.

## 4. Open the saved report in the UI

Use the persisted report flow when you want the local explorer:

```bash
parallax analyze --changed src/auth/session.ts --depth 2
parallax ui
```

Or open a specific saved report:

```bash
parallax ui --report <report-id> --port 3717
```

The UI shows the same result as a changed -> affected -> evidence -> action flow, which is useful when you want to inspect why a target was ranked or what to verify next.

## 5. MCP next step

Once the repo has a completed index, expose the same local store to an MCP client:

```bash
parallax mcp serve
```

Register that command as a stdio server in Claude Code, Codex, or another MCP client. The server resolves the repo from its current working directory, so launch it from the repo you want analyzed. See [mcp.md](mcp.md) for the full tool and resource surface.

## 6. CI or guardrail next step

For a branch or PR, analyze a git diff directly:

```bash
parallax analyze --base main --head HEAD --fail-on proven --json > report.json
```

Use `--fail-on` to decide which confidence levels should trip the guardrail. `proven` is the conservative starting point for CI because it only fails on high-confidence impact. The published schema for `report.json` ships with the package at [`../schemas/impact-report.schema.json`](../schemas/impact-report.schema.json); see [report-schema.md](report-schema.md) for validation details.

## See also

- [cli-reference.md](cli-reference.md) - every CLI command, flag, and exit code
- [mcp.md](mcp.md) - stdio server, tools, prompts, and resources
- [report-schema.md](report-schema.md) - JSON Schema for `analyze --json`
- [verification.md](verification.md) - release gate, docs lint, dogfood, and bench layers
