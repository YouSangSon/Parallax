# Parallax — Report JSON Schema

**English** · [한국어](report-schema.ko.md) · [中文](report-schema.zh.md)

`parallax analyze --json` prints an **impact report**. Parallax publishes a machine-readable [JSON Schema](https://json-schema.org/) for that output so consumers — CI gates, dashboards, other agents — can validate it without reverse-engineering the TypeScript types.

## The artifact

| | |
| :--- | :--- |
| Path | [`schemas/impact-report.schema.json`](../schemas/impact-report.schema.json) |
| Dialect | JSON Schema draft 2020-12 |
| `$id` | `https://raw.githubusercontent.com/YouSangSon/Parallax/main/schemas/impact-report.schema.json` |
| `version` | semantic version of the report shape (currently `1.3.0`) |

The schema describes the object emitted by `parallax analyze --json` (the `ImpactReport`): `id`, `indexRunId`, `changedFiles`, `affectedFiles`, `changed`, `affected`, `actions`, `evidence`, and the optional `adapterInsights`, `crossRepoImpacts`, and `warnings`. Note that `--json` does not persist the report, so the optional `reportPath` field is absent from that output.

The same artifact is published in the npm package, so packaged consumers can validate `report.json` without cloning the source checkout.

## SARIF projection

`parallax analyze --sarif-output <path>` writes SARIF 2.1.0 for GitHub Code Scanning, but SARIF is a pure projection from `ImpactReport`. It does not bump this report schema, add fields to `analyze --json`, or change the persisted report shape. Consumers that need Parallax's full data contract should keep validating `analyze --json`; consumers that need GitHub annotations should upload the SARIF file.

### `crossRepoImpacts`

Optional. Present when a changed provider contract matches persisted workspace `BREAKS_COMPATIBILITY_WITH` links. Each item includes `workspace`, `provider.serviceName`, `provider.contractPath`, `consumer.serviceName`, `consumer.path`, `change`, `confidence`, `evidence`, and `resources`. Absolute local repo paths are omitted from public report JSON.

## Validating output

Any JSON Schema validator works. For example, with [`ajv`](https://ajv.js.org/):

```bash
parallax analyze --changed src/store.ts --json > report.json
npx ajv-cli validate -s schemas/impact-report.schema.json -d report.json --spec=draft2020
```

## Versioning

The `version` field carries a semantic version of the report shape:

- **patch** — documentation-only or non-structural clarifications.
- **minor** — additive optional fields.
- **major** — a removed or renamed field, or a tightened type.

The schema is **closed** (`additionalProperties: false` at every level), so validation is strict — and the compatibility direction is one-way: an older report always validates against a newer schema, but a newer report (carrying a field added in a minor bump) is *rejected* by an older schema. Consumers should therefore track the latest schema within a major version rather than pinning to an exact minor. The `$id` stays stable across versions; the `version` field is the signal to compare against.

## How it stays in sync

The hand-written `ImpactReport` type in `src/types.ts` remains authoritative. The schema is mirrored in zod (`src/report_schema.ts`) and the artifact is generated from it:

```bash
npm run schemas:build   # regenerate schemas/impact-report.schema.json
```

Two guards keep the artifact honest, both wired into `npm run verify`:

- A **compile-time conformance** assertion (`tests/report-schema.test.ts`) fails `npm run check` if `ImpactReport` and the zod schema diverge.
- A **drift guard** (`npm run schemas:check`, part of `npm run lint`) fails if the committed artifact is stale. A test also validates a real `analyze --json` payload against the schema, so the published contract is checked against actual output, not just the type.

## Scope

This schema covers the impact report. The benchmark report (`parallax` quality metrics, emitted under `.parallax/bench/`) is an internal artifact and is not yet schematized.

## See also

- [cli-reference.md](cli-reference.md) — the `analyze --json` and `--sarif-output` flags
- [mcp.md](mcp.md) — the MCP server surface over the same store
