Status: DONE

Summary:
- Added reusable MCP output schemas in `src/mcp_output_schemas.ts`, keyed by the existing Parallax MCP tool names.
- Exposed `outputSchema` for every JSON-returning Parallax tool in `tools/list`.
- Updated successful JSON tool responses to include both `structuredContent` and the backward-compatible JSON text mirror in `content[0].text`.
- Preserved existing telemetry boundaries: existing `toolJsonResponse` paths still record telemetry, while memory/branch/doctor/telemetry direct JSON paths now return structured content without adding context tool telemetry.
- Extended MCP tests to assert advertised output schemas and representative `structuredContent` parity with parsed legacy text JSON.
- Documented structured output behavior in English, Korean, and Chinese MCP docs.

Verification:
- `npm run test:mcp` passed: 58/58 tests.
- `npm run check` passed.
- `npm run docs:lint` passed.
- `git diff --check` passed.

Concerns:
- None.
