# Parallax — Operations Runbook

**English** · [한국어](operations.ko.md) · [中文](operations.zh.md)

Use this runbook when Parallax behaves differently from the current working tree, MCP setup fails, the local database is missing, or CI fails. Parallax stores its operational state in `.parallax/impact.db`; source files remain in your repository.

## First check

Run these commands from the target repository root:

```bash
parallax doctor
npm run lint
npm test
```

`parallax doctor` is the fastest health report. It checks the database, schema version, latest index, coverage, adapter runs, vector state, and context telemetry.

## Missing database

Symptom:

- `parallax doctor` reports `database_missing`.
- MCP tools return an error about missing `.parallax/impact.db`.

Fix:

```bash
parallax init
parallax index
parallax doctor
```

If the database was accidentally deleted, re-indexing is enough. The database is derived from the local repository and explicit memory commands.

## Stale index

Symptom:

- `analyze` warns that the latest index was created from a different git commit.
- `analyze` warns that the working tree dirty state changed after indexing.
- A changed file is missing from the latest index.

Fix:

```bash
parallax index
parallax analyze --base main --head HEAD --json
```

If the warning remains, run `git status --short` and confirm whether generated files, renamed files, or ignored files changed after indexing.

## Skipped coverage

Symptom:

- `doctor` reports `coverage_skipped_paths`.
- The UI Analysis Trust panel shows coverage gaps.
- `parallax://coverage/latest` includes skipped rows.

Fix:

1. Inspect the skipped path and reason in `parallax doctor` or the UI.
2. If the file is intentionally too large, keep the gap documented.
3. If the file should be indexed, rerun with a higher limit:

```bash
parallax index --max-file-bytes 2000000
```

Do not raise the limit blindly for vendored or generated files. Add them to ignore rules or keep them outside the indexed tree when possible.

## Adapter failure

Symptom:

- `doctor` shows an adapter run with `failed`.
- `analyze` shows adapter errors in `adapterInsights`.

Fix:

1. Read the adapter `errorSummary`.
2. Reproduce with the smallest repository fixture possible.
3. Add a test under `tests/` before changing adapter behavior.
4. Run:

```bash
npm run check
npm test
npm run test:dogfood
npm run bench
```

Engine changes need dogfood and bench because unit tests can pass while the real graph is broken.

## MCP setup fails

Symptom:

- The MCP client cannot start `parallax mcp serve`.
- Tools are missing from the client.
- The server starts in the wrong repository.

Fix:

1. Confirm the CLI launches:

```bash
parallax --help
```

2. Confirm the working directory is the target repository root.
3. Run:

```bash
parallax init
parallax index
parallax mcp serve
```

4. Register the MCP server as a stdio command in the client. Use the same repository root the agent will edit.

MCP does not modify source files. Analysis/search/context calls may persist context-pack or tool telemetry rows, and MCP resource reads may persist resource-access telemetry rows in `.parallax/impact.db`.

## Node 24 SQLite warning

Symptom:

- Node prints an experimental warning for `node:sqlite`.

Meaning:

Parallax intentionally uses Node.js 24 built-in SQLite. The warning is expected on current Node releases and does not indicate data loss.

Action:

- Keep Node.js at `>=24.0.0`.
- Do not suppress the warning in CI unless it breaks machine parsing.

## Workspace catalog issues

Symptom:

- Cross-repo contract resolution returns no links.
- A repository path is rejected.
- A workspace lists unexpected services.

Fix:

```bash
parallax workspace list --json
parallax workspace init --name platform --service api --force
parallax workspace add-repo ../web --name platform --service web
parallax workspace resolve-contracts --name platform --json
```

Workspace entries are explicit local paths. Parallax does not clone repositories or scan paths the user did not register.

## CI failure triage

CI runs `npm ci` and then the aggregate `npm run verify` gate. Reproduce `npm run verify` locally from a source checkout, then use the first failing subcommand in the log to narrow the failure.

| Failing command | What it usually means | First fix |
| :--- | :--- | :--- |
| `npm run verify` | One of the release sub-gates failed | Re-run it locally, then jump to the first failing subcommand below. |
| `npm audit --audit-level=high` | Dependency advisory affects current lockfile | Run `npm audit fix`, review lockfile, rerun tests. |
| `npm run lint` | Typecheck or docs lint failed | Run the command locally and fix the first reported file. |
| `npm run build` | TypeScript compile output failed | Run `npm run check`, then fix type or module errors. |
| `npm test` | Fast unit/integration suite failed | Reproduce the named test file locally. |
| `npm run test:dogfood` | Real self-index graph regressed | Inspect indexer/adapters/analyzer/store changes first. |
| `npm run bench` | Accuracy or retrieval regression | Compare the bench report and update expectations only for intentional behavior changes. |
| `npm run test:install-smoke` | Packaged CLI does not launch | Run `npm run build && node dist/src/cli.js --help`. |

## Recovery rule

When unsure, prefer a fresh derived state:

```bash
rm -rf .parallax
parallax init
parallax index
parallax doctor
```

Only do this in a repository where you do not need local memory facts. If the database contains important decisions, export or back it up before deleting `.parallax`.
