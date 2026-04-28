# TODOS

## Deferred Scope

| Item | Reason Deferred | Revisit Trigger |
|---|---|---|
| Visual web graph explorer | Useful later, but MVP value is agent-readable evidence packets and CLI/MCP output. | After CLI and MCP reports are trusted on 5+ real repos. |
| Always-on graph database core | User clarified graph DB is not required; defaulting to a simpler local index reduces setup and maintenance risk. | Add when recursive dependency queries exceed SQLite/DuckDB ergonomics. |
| Full CodeQL query authoring | CodeQL is valuable for semantic analysis, but requiring it on day one would slow TTHW. | Add as optional adapter after TypeScript/Tree-sitter indexing works. |
| IDE extension | MCP/CLI covers Claude Code and Codex first. | Add when repeated workflows need inline editor affordances. |
| Remote team server | Local-first avoids secrets and setup risk for early users. | Add when multiple developers need shared cached analysis. |

## Open Questions

| Question | Default Answer |
|---|---|
| Initial language support | TypeScript/JavaScript first, with Tree-sitter fallback for Python/Go/Rust import maps. |
| Default storage | SQLite for canonical metadata and reports; DuckDB optional for analytical snapshots. |
| Obsidian integration shape | Write Markdown into a vault and optionally open notes via Obsidian URI. Avoid a required plugin in MVP. |
| Agent integration | CLI plus MCP server. MCP tools return compact evidence packets; MCP resources expose larger reports. |

