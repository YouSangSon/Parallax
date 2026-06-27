# Task 2 Report: Copilot Custom-Agent Install Package

Status: DONE

## Summary

Implemented the GitHub Copilot/custom-agent install package for Parallax as an explicit opt-in mode on `parallax install-agent`.

New interfaces:

- `planCopilotAgentPackage(options)`
- `installCopilotAgentPackage(options)`

The planner returns planned writes with target-relative `path`, `content`, and `action` (`create`, `overwrite`, or `skip`). The installer is a thin layer over that plan and only writes files marked `create` or `overwrite`.

## Behavior

- `parallax install-agent` remains compatible with the existing MCP config merge/install behavior.
- `parallax install-agent --copilot-package --target <repo> [--dry-run] [--force]` plans or installs:
  - `.github/copilot-instructions.md`
  - `.github/agents/parallax-impact.agent.md`
  - optional MCP config snippet when `--config <path>` is supplied
- Copilot package writes are scoped to the explicit target repo.
- Dry-run prints planned relative paths and actions.
- Existing files are skipped unless `--force` is supplied.
- Forced MCP snippet generation preserves existing unrelated `mcpServers` entries.
- The generated instructions mention `parallax_context_for_change`, `parallax_search_context`, `parallax_query_entities`, and SARIF CI usage.
- The generated custom-agent frontmatter includes `name`, `description`, and `tools`.

## Files Changed

- `src/agent_config.ts`
- `src/index.ts`
- `src/cli.ts`
- `tests/agent-config.test.ts`
- `docs/cli-reference.md`
- `docs/cli-reference.ko.md`
- `docs/cli-reference.zh.md`
- `docs/mcp.md`
- `docs/mcp.ko.md`
- `docs/mcp.zh.md`
- `docs/roadmap.md`
- `docs/roadmap.ko.md`
- `docs/roadmap.zh.md`
- `IMPROVEMENT_OPPORTUNITIES.md`

## Verification

Passed:

```bash
node --import tsx --test tests/agent-config.test.ts
npm run check
npm run docs:lint
git diff --check
```

Additional smoke check:

```bash
node --import tsx src/cli.ts install-agent --copilot-package --target <temp-dir> --config .mcp.json --dry-run
```

The smoke check printed planned paths/actions and did not create files in the target.

## Concerns

None.

## Review Finding Fix

Fixed the dry-run planner path for existing Copilot package MCP config files. `planCopilotAgentPackage` now determines whether `.mcp.json` would be skipped before reading existing config content, so invalid or non-object JSON is not parsed when `force` is false.

Regression coverage added:

```bash
node --import tsx --test tests/agent-config.test.ts
```

Required verification passed:

```bash
node --import tsx --test tests/agent-config.test.ts
npm run check
npm run docs:lint
git diff --check
```
