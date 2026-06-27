# Agent Adoption Surface Implementation Plan

**English** · [한국어](2026-06-27-agent-adoption-surface.ko.md) · [中文](2026-06-27-agent-adoption-surface.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the seven researched adoption slices so Parallax exposes its impact graph through GitHub Code Scanning, Copilot/custom-agent setup, structured MCP results, repo-map context cards, foreground status/watch UX, richer docs impact, and deterministic security-routing recommendations.

**Architecture:** Keep `ImpactReport` as the authoritative analysis product and add pure projection layers for SARIF, MCP structured results, repo maps, and routing recommendations. Preserve the local-first SQLite design, read-only-first agent surface, explicit-trigger invariant, and recommendation-only action model. Each slice must be independently testable and releasable on `main`.

**Tech Stack:** TypeScript, Node.js `node:test`, SQLite via `node:sqlite`, MCP SDK with Zod input schemas, SARIF 2.1.0 JSON, GitHub Actions composite action metadata, trilingual Markdown docs.

## Global Constraints

- Node runtime remains `>=24.0.0`.
- Do not introduce a background daemon or implicit listener; `watch` must be an explicit foreground CLI process.
- Do not modify source trees from MCP tools. Existing MCP telemetry/context-pack local database writes remain allowed and must stay documented.
- Do not execute Semgrep, OpenRewrite, CodeQL, or GitHub uploads automatically. Parallax only emits files, commands, and recommendations unless the user runs the external tool.
- Deterministic outputs are required: stable sorting, stable rule ids, stable partial fingerprints, and bounded snippets.
- Public docs in `docs/` stay trilingual: `X.md`, `X.ko.md`, and `X.zh.md`.
- If `docs/mcp*.md` changes, keep the MCP tools table aligned with `tools/list` tests.
- If `ImpactReport` shape changes, update `src/report_schema.ts`, `schemas/impact-report.schema.json`, `docs/report-schema*.md`, and schema tests in the same task.
- SARIF output must use SARIF version `2.1.0`; GitHub upload instructions must avoid multiple runs with the same tool/category in one SARIF file.
- External references verified on 2026-06-27: GitHub SARIF upload docs, GitHub SARIF support docs, GitHub Copilot custom-agent docs, MCP tool `outputSchema`/`structuredContent` docs, and Semgrep MCP repository deprecation notice.

---

## Scope Check

This is a seven-slice adoption program rather than one tightly coupled subsystem. The user explicitly requested items 1 through 7 in order, so this plan keeps one ordered execution ledger. Each task below must end in working, testable software and can be reviewed independently before the next task starts.

## Grill Decisions

1. **Should Task 3 run before Task 2 because MCP structured output helps agent packages?** No. The requested order is 1 through 7. Task 2 ships a useful Copilot/custom-agent install package against the current MCP tool names; Task 3 upgrades those same tools with structured outputs without changing names.
2. **Should SARIF be a stored report schema change?** No. SARIF is a projection from `ImpactReport`. This avoids a schema bump and keeps `analyze --json` stable.
3. **Should SARIF be stdout-only?** No. Add `--sarif-output <path>` to avoid mixing CI logs with machine JSON. A later `--sarif` stdout alias can be added only if tests prove it does not conflict with `--json`.
4. **Should status/watch introduce a daemon?** No. `docs/invariants.md` and security tests forbid implicit daemons. `status` is read-only and `watch` is foreground-only.
5. **Should Semgrep/OpenRewrite routing execute tools?** No. Existing `ImpactAction` already models recommendations with structured `command` and `args`; executing external scanners would violate the recommendation-only invariant.

## File Structure

- Create `src/sarif.ts`: pure SARIF 2.1.0 serializer from `ImpactReport`.
- Modify `src/cli.ts`: add `analyze --sarif-output`, `install-agent` package flags, `repo-map`, `status`, `watch`, and routing/status help text as slices land.
- Modify `src/index.ts`: export new public helpers after each slice.
- Create `action.yml`: optional GitHub composite action that runs Parallax and emits SARIF for upload.
- Modify `src/agent_config.ts`: generate MCP client config, Copilot instructions, and custom-agent files without overwriting unless explicitly allowed.
- Create `src/mcp_output_schemas.ts`: shared JSON Schema objects for MCP `outputSchema`.
- Modify `src/mcp.ts`: add `outputSchema`, `structuredContent`, and later `parallax_repo_map`.
- Create `src/repo_map.ts`: token-budgeted repo map/context card builder.
- Create `src/status.ts`: read-only status summary and foreground watch loop.
- Modify `src/adapters/multi-language-regex.ts`, `src/artifacts.ts`, `src/work_artifacts.ts`, `src/ui/data.ts`, and `src/context_pack.ts`: richer docs/knowledge-base impact graph.
- Create `src/routing_recommendations.ts`: deterministic Semgrep/OpenRewrite/CodeQL recommendation rules.
- Extend tests under `tests/*.test.ts` next to each touched surface.
- Update `docs/cli-reference*.md`, `docs/mcp*.md`, `docs/report-schema*.md`, `docs/operations*.md`, `docs/roadmap*.md`, `IMPROVEMENT_OPPORTUNITIES.md`, and README sections as each surface becomes real.

---

### Task 1: SARIF Export And GitHub Action

**Files:**
- Create: `src/sarif.ts`
- Create: `tests/sarif.test.ts`
- Create: `action.yml`
- Modify: `src/cli.ts`
- Modify: `src/index.ts`
- Modify: `tests/parallax.test.ts`
- Modify: `tests/package_metadata.test.ts` only if package metadata tests require action visibility
- Modify: `README.md`, `README.ko.md`, `README.zh.md`
- Modify: `docs/cli-reference.md`, `docs/cli-reference.ko.md`, `docs/cli-reference.zh.md`
- Modify: `docs/report-schema.md`, `docs/report-schema.ko.md`, `docs/report-schema.zh.md`
- Modify: `docs/roadmap.md`, `docs/roadmap.ko.md`, `docs/roadmap.zh.md`
- Modify: `IMPROVEMENT_OPPORTUNITIES.md`

**Interfaces:**
- Consumes: `ImpactReport`, `AffectedFile`, `Evidence`, `package.json` metadata.
- Produces:
  - `export interface SarifOptions { category?: string; toolVersion?: string; informationUri?: string; checkoutRoot?: string; }`
  - `export function impactReportToSarif(report: ImpactReport, options?: SarifOptions): SarifLog`
  - CLI flag `parallax analyze --sarif-output <path> [--sarif-category <category>]`

- [ ] **Step 1: Write failing SARIF serializer tests**

Create `tests/sarif.test.ts` with focused fixtures:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { impactReportToSarif } from '../src/sarif.js';
import type { ImpactReport } from '../src/types.js';

function reportFixture(): ImpactReport {
  return {
    id: 'report-1',
    indexRunId: 'run-1',
    changedFiles: ['src/api.ts'],
    changed: [{ path: 'src/api.ts' }],
    affectedFiles: [{
      path: 'src/client.ts',
      reason: 'imports changed API',
      confidence: 'proven',
      depth: 1,
      relationPath: ['src/api.ts', 'src/client.ts']
    }],
    affected: [{ path: 'src/client.ts' }],
    actions: [{
      kind: 'test',
      title: 'Run client tests',
      command: 'npm',
      args: ['test', '--', 'tests/client.test.ts'],
      runnerId: 'npm-test',
      display: 'npm test -- tests/client.test.ts'
    }],
    testCommands: ['npm test -- tests/client.test.ts'],
    evidence: [{
      id: 'ev-1',
      file: 'src/client.ts',
      kind: 'import',
      snippet: 'import { loadUsers } from "./api";',
      confidence: 'proven',
      startLine: 4,
      endLine: 4,
      startCol: 1,
      endCol: 35,
      subject: 'src/client.ts',
      target: 'src/api.ts',
      relationKind: 'IMPORTS',
      relationConfidence: 'proven',
      extractorId: 'test-fixture'
    }],
    warnings: ['fixture warning']
  };
}

test('impactReportToSarif maps affected files into GitHub-compatible results', () => {
  const sarif = impactReportToSarif(reportFixture(), {
    category: 'parallax-pr',
    toolVersion: '0.1.0',
    informationUri: 'https://github.com/YouSangSon/Parallax#readme'
  });

  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs.length, 1);
  assert.equal(sarif.runs[0]?.tool.driver.name, 'Parallax');
  assert.equal(sarif.runs[0]?.automationDetails?.id, 'parallax-pr');
  assert.equal(sarif.runs[0]?.results.length, 1);
  const result = sarif.runs[0]?.results[0];
  assert.equal(result?.ruleId, 'parallax.impact.proven');
  assert.equal(result?.level, 'warning');
  assert.equal(result?.locations?.[0]?.physicalLocation?.artifactLocation?.uri, 'src/client.ts');
  assert.equal(result?.locations?.[0]?.physicalLocation?.region?.startLine, 4);
  assert.ok(result?.partialFingerprints?.parallaxImpact);
  assert.deepEqual(result?.properties?.evidenceIds, ['ev-1']);
});

test('impactReportToSarif emits empty runs for no-impact reports', () => {
  const report = reportFixture();
  report.affectedFiles = [];
  report.affected = [];

  const sarif = impactReportToSarif(report);

  assert.equal(sarif.runs[0]?.results.length, 0);
  assert.equal(sarif.runs[0]?.invocations?.[0]?.executionSuccessful, true);
});
```

- [ ] **Step 2: Run the failing serializer tests**

Run: `node --import tsx --test tests/sarif.test.ts`

Expected: FAIL because `src/sarif.ts` does not exist.

- [ ] **Step 3: Implement `src/sarif.ts` minimally**

Create `src/sarif.ts` with local SARIF types, stable hashing via `node:crypto`, bounded snippets, repo-relative URI normalization, rule ids by confidence, `relatedLocations` from changed files/evidence, `codeFlows` from `relationPath`, and `partialFingerprints.parallaxImpact` derived from affected path, reason, confidence, relation path, and evidence ids.

- [ ] **Step 4: Export the helper**

Modify `src/index.ts`:

```ts
export { impactReportToSarif } from './sarif.js';
export type { SarifLog, SarifOptions } from './sarif.js';
```

- [ ] **Step 5: Add CLI file output**

Modify `src/cli.ts` so `analyze` accepts:

```text
--sarif-output <path>
--sarif-category <category>
```

Rules:
- `--json` and `--sarif-output` cannot be used together.
- `--sarif-output` writes pretty JSON to the requested path and creates parent directories.
- `--sarif-output` keeps the normal human summary on stdout.
- Exit-code behavior still comes from `--fail-on`.
- `parsePositionals` treats both new flags as value flags.

- [ ] **Step 6: Add CLI regression tests**

Extend `tests/parallax.test.ts` with a CLI test that runs `analyze --changed src/api.ts --sarif-output parallax.sarif --sarif-category unit` in a temp repo, parses the SARIF file, and asserts version, automation category, result URI, and no markdown report persistence when the command is configured to avoid persistence if the final implementation chooses that behavior.

- [ ] **Step 7: Add GitHub composite action metadata**

Create `action.yml` with inputs:

```yaml
name: Parallax Impact SARIF
description: Generate a Parallax impact SARIF file for GitHub Code Scanning upload.
inputs:
  changed:
    description: Comma-separated changed file list passed to parallax analyze.
    required: true
  sarif-output:
    description: Path to write the SARIF file.
    required: false
    default: parallax.sarif
  sarif-category:
    description: GitHub Code Scanning category/run automation id.
    required: false
    default: parallax
  fail-on:
    description: Confidence threshold for non-zero exit.
    required: false
    default: proven
runs:
  using: composite
  steps:
    - shell: bash
      run: npx parallax analyze --changed "${{ inputs.changed }}" --sarif-output "${{ inputs.sarif-output }}" --sarif-category "${{ inputs.sarif-category }}" --fail-on "${{ inputs.fail-on }}"
```

Keep upload to `github/codeql-action/upload-sarif` in docs, not inside the action, so the user controls `security-events: write`.

- [ ] **Step 8: Update docs and roadmap**

Document:
- CLI flags and conflict rules in all `docs/cli-reference*.md`.
- SARIF as a projection, not a report schema version bump, in all `docs/report-schema*.md`.
- GitHub workflow snippet in README files:

```yaml
permissions:
  contents: read
  security-events: write
steps:
  - uses: actions/checkout@v4
  - run: npm install -g parallax
  - run: parallax analyze --changed "src/api.ts" --sarif-output parallax.sarif --sarif-category parallax-pr --fail-on proven
  - uses: github/codeql-action/upload-sarif@v3
    with:
      sarif_file: parallax.sarif
      category: parallax-pr
```

- [ ] **Step 9: Verify and commit**

Run:

```bash
node --import tsx --test tests/sarif.test.ts
node --import tsx --test tests/parallax.test.ts --test-name-pattern "SARIF|CLI analyze"
npm run check
npm run docs:lint
git diff --check
```

Commit:

```bash
git add src/sarif.ts src/index.ts src/cli.ts tests/sarif.test.ts tests/parallax.test.ts action.yml README.md README.ko.md README.zh.md docs/cli-reference.md docs/cli-reference.ko.md docs/cli-reference.zh.md docs/report-schema.md docs/report-schema.ko.md docs/report-schema.zh.md docs/roadmap.md docs/roadmap.ko.md docs/roadmap.zh.md IMPROVEMENT_OPPORTUNITIES.md
git commit -m "feat: export impact reports as sarif"
```

---

### Task 2: Copilot Custom-Agent Install Package

**Files:**
- Modify: `src/agent_config.ts`
- Modify: `src/cli.ts`
- Modify: `tests/agent-config.test.ts`
- Modify: `docs/cli-reference.md`, `docs/cli-reference.ko.md`, `docs/cli-reference.zh.md`
- Modify: `docs/mcp.md`, `docs/mcp.ko.md`, `docs/mcp.zh.md`
- Modify: `docs/roadmap.md`, `docs/roadmap.ko.md`, `docs/roadmap.zh.md`
- Modify: `IMPROVEMENT_OPPORTUNITIES.md`

**Interfaces:**
- Produces `planCopilotAgentPackage(options)` and `installCopilotAgentPackage(options)`.
- CLI adds `parallax install-agent --copilot-package --target <repo> [--dry-run] [--force]`.
- Planned files in the target repo: `.github/copilot-instructions.md`, `.github/agents/parallax-impact.agent.md`, and MCP config snippet when `--config` is provided.

- [ ] **Step 1: Write failing package-plan tests**

Add tests asserting dry-run returns planned writes, existing files are not overwritten without `--force`, generated agent frontmatter contains `name`, `description`, and `tools`, and instructions mention `parallax_context_for_change`, `parallax_search_context`, `parallax_query_entities`, and SARIF CI usage from Task 1.

- [ ] **Step 2: Implement pure planners before filesystem writes**

Keep template generation in `src/agent_config.ts` as pure functions returning `{ path, content, action }[]`. File writes must be a thin layer over that plan.

- [ ] **Step 3: Wire CLI and docs**

`--dry-run` prints the planned relative paths and actions. `--force` is explicit. Docs must say the command writes only the target repository files and does not call GitHub.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --import tsx --test tests/agent-config.test.ts
npm run check
npm run docs:lint
git diff --check
```

Commit: `git commit -m "feat: generate copilot agent package"`

---

### Task 3: MCP Output Schemas And Structured Content

**Files:**
- Create: `src/mcp_output_schemas.ts`
- Modify: `src/mcp.ts`
- Modify: `tests/mcp.test.ts`
- Modify: `docs/mcp.md`, `docs/mcp.ko.md`, `docs/mcp.zh.md`

**Interfaces:**
- Produces reusable output schema constants keyed by existing MCP tool names.
- `toolJsonResponse(value)` returns both `content[0].text` and `structuredContent`.
- `tools/list` exposes `outputSchema` for JSON-returning Parallax tools.

- [ ] **Step 1: Write failing MCP schema tests**

Extend `tests/mcp.test.ts` to assert representative tools expose `outputSchema` and tool calls return `structuredContent` equal to `JSON.parse(content[0].text)`.

- [ ] **Step 2: Centralize schemas**

Add conservative JSON schemas for existing outputs. Prefer exact top-level required fields and permissive nested objects where existing report shapes already evolve.

- [ ] **Step 3: Convert direct text-only returns**

Route direct JSON returns through `toolJsonResponse` unless the result is intentionally text-only. Preserve backward-compatible text mirrors.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm run test:mcp
npm run check
npm run docs:lint
git diff --check
```

Commit: `git commit -m "feat: expose structured mcp outputs"`

---

### Task 4: Repo Map And Context Card

**Files:**
- Create: `src/repo_map.ts`
- Create: `tests/repo-map.test.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Modify: `src/cli.ts`
- Modify: `src/mcp.ts`
- Modify: `tests/mcp.test.ts`
- Modify: `docs/cli-reference.md`, `docs/cli-reference.ko.md`, `docs/cli-reference.zh.md`
- Modify: `docs/mcp.md`, `docs/mcp.ko.md`, `docs/mcp.zh.md`
- Modify: `docs/roadmap.md`, `docs/roadmap.ko.md`, `docs/roadmap.zh.md`
- Modify: `IMPROVEMENT_OPPORTUNITIES.md`

**Interfaces:**
- Produces `buildRepoMap(options): RepoMap`.
- CLI adds `parallax repo-map --changed <files> [--query <text>] [--budget <tokens>] [--json]`.
- MCP adds read-only `parallax_repo_map`.

- [ ] **Step 1: Write failing ranking and budget tests**

Tests must prove changed roots, affected files, tests, docs, work artifacts, evidence, verification actions, and `parallax://` resources are ranked into a bounded context card with omitted counts.

- [ ] **Step 2: Build from existing context/search primitives**

Reuse `buildContextPack`, `searchContext`, and graph resources rather than a new index. Token budget can be approximated by `Math.ceil(text.length / 4)` and must be documented as an estimate.

- [ ] **Step 3: Add CLI and MCP surfaces**

CLI supports human summary and `--json`. MCP uses `structuredContent` from Task 3 and read-only annotations.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --import tsx --test tests/repo-map.test.ts
npm run test:mcp
npm run check
npm run docs:lint
git diff --check
```

Commit: `git commit -m "feat: build token-budgeted repo maps"`

---

### Task 5: Status And Foreground Watch UX

**Files:**
- Create: `src/status.ts`
- Create: `tests/status.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/index.ts`
- Modify: `tests/security.test.ts`
- Modify: `docs/cli-reference.md`, `docs/cli-reference.ko.md`, `docs/cli-reference.zh.md`
- Modify: `docs/operations.md`, `docs/operations.ko.md`, `docs/operations.zh.md`
- Modify: `docs/invariants.md`, `docs/invariants.ko.md`, `docs/invariants.zh.md` only to clarify foreground watch

**Interfaces:**
- Produces `getProjectStatus(options): ProjectStatus`.
- CLI adds `parallax status [--json]`.
- CLI adds `parallax watch --changed <files> [--interval <seconds>]` as explicit foreground polling.

- [ ] **Step 1: Write failing status tests**

Tests assert status summarizes latest index run, coverage, adapter run health, vector state, telemetry counts, and next recommended command without exiting non-zero for warnings.

- [ ] **Step 2: Reuse doctor data**

Implement status as a narrower read-only projection over `doctorProject()` where possible. Do not duplicate store probes without a test reason.

- [ ] **Step 3: Add foreground watch**

`watch` must print one status/analyze cycle at a time, sleep with `setTimeout`, stop on SIGINT, and never open HTTP/listener APIs. Security tests must keep the daemon invariant intact.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --import tsx --test tests/status.test.ts
npm run test:security
npm run check
npm run docs:lint
git diff --check
```

Commit: `git commit -m "feat: add explicit status and watch ux"`

---

### Task 6: Docs And Knowledge-Base Impact Graph

**Files:**
- Modify: `src/adapters/multi-language-regex.ts`
- Modify: `src/artifacts.ts`
- Modify: `src/work_artifacts.ts`
- Modify: `src/ui/data.ts`
- Modify: `src/context_pack.ts`
- Modify: `tests/parallax.test.ts`
- Modify: `tests/work_artifacts.test.ts`
- Modify: `tests/ui.test.ts`
- Modify: `tests/mcp.test.ts`
- Modify: `docs/architecture.md`, `docs/architecture.ko.md`, `docs/architecture.zh.md`
- Modify: `docs/glossary.md`, `docs/glossary.ko.md`, `docs/glossary.zh.md`

**Interfaces:**
- Extends Markdown extraction for wiki links, Markdown links, ADR/policy/PRD heading anchors, ownership references, and requirement ids.
- Preserves existing `DOCUMENTS`, `GOVERNS`, `PROPOSES`, and `REQUIRES` relations unless a more precise existing relation kind already applies.

- [ ] **Step 1: Write failing docs graph tests**

Add fixtures proving a changed code file surfaces impacted policy/ADR/PRD docs, and a changed doc surfaces code/tests/resources it governs.

- [ ] **Step 2: Extend extraction with evidence**

Every new relation must include evidence file, span when available, extractor id, confidence, and bounded snippets.

- [ ] **Step 3: Project docs graph into UI/MCP/context packs**

Show docs impacts as work artifacts with resource URIs and freshness signals. Do not expose full artifact body in UI payloads.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --import tsx --test tests/parallax.test.ts --test-name-pattern "Markdown|policy|proposal|decision|knowledge"
node --import tsx --test tests/work_artifacts.test.ts
npm run test:ui
npm run test:mcp
npm run bench
npm run check
npm run docs:lint
git diff --check
```

Commit: `git commit -m "feat: expand docs impact graph"`

---

### Task 7: Semgrep And OpenRewrite Routing Recommendations

**Files:**
- Create: `src/routing_recommendations.ts`
- Create: `tests/routing-recommendations.test.ts`
- Modify: `src/analyzer.ts`
- Modify: `src/index.ts`
- Modify: `docs/report-schema.md`, `docs/report-schema.ko.md`, `docs/report-schema.zh.md`
- Modify: `docs/verification.md`, `docs/verification.ko.md`, `docs/verification.zh.md`
- Modify: `docs/roadmap.md`, `docs/roadmap.ko.md`, `docs/roadmap.zh.md`
- Modify: `IMPROVEMENT_OPPORTUNITIES.md`

**Interfaces:**
- Produces `recommendRoutingActions(reportInputs): ImpactAction[]`.
- Uses existing `ImpactAction.kind: 'review'` unless tests prove a new enum is necessary.
- Emits structured commands such as `semgrep scan --config auto --sarif --output semgrep.sarif <paths>` and `openrewrite run <recipe> --plain-text-mask <paths>` as recommendations only.

- [ ] **Step 1: Write failing recommendation tests**

Tests assert security-sensitive TypeScript/Python paths recommend Semgrep, Java build/API routes recommend OpenRewrite, and generated/docs-only changes do not produce irrelevant scanner recommendations.

- [ ] **Step 2: Implement deterministic routing**

Rules are path/language/evidence based, sorted by runner id and display text, and deduplicated against existing `actions`.

- [ ] **Step 3: Merge into analyze actions**

Append recommendations after test actions. Keep command and args separate and preserve the command-injection-safe pattern already tested for actions.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --import tsx --test tests/routing-recommendations.test.ts
node --import tsx --test tests/parallax.test.ts --test-name-pattern "actions|command"
npm run schemas:check
npm run check
npm run docs:lint
git diff --check
```

Commit: `git commit -m "feat: recommend security routing actions"`

---

## Final Program Verification

After Task 7 and all per-task reviews:

```bash
npm run verify
git status --short --branch
```

Run a final whole-branch review using `superpowers:requesting-code-review`. If clean, push `main` after confirming the branch still matches `origin/main` or after resolving any non-fast-forward update.

