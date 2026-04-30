# Supermemory Patterns — Selective Adoption Design (English)

> **Status:** Authored 2026-04-30 on branch `feat/supermemory-best-practices`.
> **Predecessors:** [phase4-handoff.en.md](phase4-handoff.en.md) · [decisions.en.md](decisions.en.md) · [phase3-design.ko.md](phase3-design.ko.md) (the canonical Phase-doc template — Korean only).
> **Korean original:** [supermemory-adoption.ko.md](supermemory-adoption.ko.md). The Korean is the working copy; this English version is a parallel translation.
> **Purpose:** Decide which patterns from [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory) to adopt, which to reject, and why — through a 4-perspective consensus review.

---

## 0. One-line summary

> "Of supermemory's six candidate patterns, *three* are adopted (P2 Profile, P3-Expose, P6 Skills). P1 (kind enum expansion) and P4 (pipeline state) are REJECTED because they conflict with our ADRs D-002 / D-005 / D-010. P5 (MemoryBench) is deferred to a separate branch."

---

## 1. Four-perspective evaluation (architect / typescript-reviewer / code-explorer / security)

### P1: `fact_provenance.kind` enum expansion → ❌ DEFER

**Consensus:** Do *not* add new semantic axes to the data model. supermemory's "Updates" is *already expressed* via our `op='retract' + 'assert'` pattern. "Derives" is *already expressed* via reflection's `kind='summary'`. Only "Extends" would be genuinely new — but no *killer query* requires it.

**Rejection grounds:** D-002 (content-addressable id — a fact cannot be mutated, a new fact always has a new id), D-010 (preserve + summary edge already unifies supersession into one path).

**Reconsider when:** A new ADR + a query that cannot be answered without an Extends edge.

### P2: User Profile API → ✅ ADOPT (modified)

**Consensus:** "Inject one entity's context into an agent prompt in a single call" is genuine value. With caveats:
- Avoid TypeScript reserved word: use `staticFacts` / `dynamicFacts` (not `static` / `dynamic`).
- Branch-scoped (block cross-branch leak).
- Honour the async-outside-tx pattern.
- Redacted facts surface as `[REDACTED]` (privacy parity with recall).

### P3: `is_static` flag → ✅ EXPOSE existing (no reimplementation)

**Code-explorer finding:** `attribute_defs.is_code_relation` is the *direct analog*. Code-extraction attributes (imports, calls, affects, depends_on) have `is_code_relation=1` (static); agent-decision attributes (observed, verified, reflection, ...) have `is_code_relation=0` (dynamic).

**Work:** No new column. Surface the lifecycle classification through documentation, CLI, and the new Profile API.

### P4: pipeline status state machine → ❌ REJECT

**Architect's emphasis:** `index_runs` is the *codebase indexer* pipeline, not the *memory ingestion* pipeline. supermemory's `queued → extracting → ... → done` describes *their* cloud-worker async processing. Our `remember()` is intentionally stateless under D-005 (`async outside, sync tx inside`). Two pipelines should not be conflated.

### P5: MemoryBench → 🟡 separate branch (Phase 5 candidate)

**Architect HIGH:** "We have *no* regression signal." But ETA 1+ week. Out of scope for this branch.

### P6: Skills packaging → ✅ ADOPT

**Consensus:** `skills/impact-trace/SKILL.md` is a *documentation/distribution layer* with no schema or code dependency. Risk = 0. Decisively lowers the market-entry cost.

---

## 2. What we ship in this branch (3 things)

### A. P3-EXPOSE: lifecycle classification as a first-class concept

**Schema change:** none. `attribute_defs.is_code_relation` has existed since v4.

**Code change:**
- `src/types.ts`: add `Lifecycle = 'static' | 'dynamic'` exported type.
- `src/agent_memory.ts`: add `factLifecycle(db, attribute)` helper that consults `is_code_relation`.
- `docs/decisions.ko.md` / `decisions.en.md`: add D-013 (lifecycle binary is already expressible through `is_code_relation`).

**Why:** building block for the Profile API; ships standalone.

### B. P2: Profile API

**Schema change:** none.

**New export (`src/profile.ts`):**

```typescript
export interface ProfileOptions {
  entity: string;
  branch?: string;        // default 'main'
  k?: number;             // default 50 per bucket
  asOfTx?: string;        // optional time-travel
}

export interface ProfileResult {
  readonly entity: string;
  readonly branch: string;
  readonly staticFacts: ReadonlyArray<RecalledFact>;   // attribute_defs.is_code_relation = 1
  readonly dynamicFacts: ReadonlyArray<RecalledFact>;  // attribute_defs.is_code_relation = 0
  readonly summaryFacts: ReadonlyArray<RecalledFact>;  // attribute = 'reflection' (Phase 3)
}

export async function profileEntity(
  repoRoot: string,
  options: ProfileOptions
): Promise<ProfileResult>;
```

**Design highlights:**
- *Three* buckets, not two. supermemory ships two but our Phase 3 reflection is a first-class citizen, so it gets its own bucket.
- Branch-scoped (default `'main'`); cross-branch leak blocked.
- Archived transactions auto-excluded (recall already does this).
- Redacted facts surface as `[REDACTED]` (parity with recall).
- async-outside-tx pattern: all SQL inside `withAgentMemoryDb`.

**CLI:**
```bash
impact-trace profile --entity file:src/auth/session.ts [--branch main] [--k 50]
```

**MCP tool:** `impact_trace_profile` (`readOnlyHint=true`).

### C. P6: Skills packaging

**`skills/impact-trace/SKILL.md`** — frontmatter (`name`, `description`) following the Claude Code skill convention.

**`skills/impact-trace/references/architecture.md`** — deep architecture reference, modelled on supermemory's `skills/supermemory/references/architecture.md`.

**Effect:** `npx skills add YouSangSon/Impact-trace` installs the skill in one line; Claude Code auto-invokes it for relevant prompts.

---

## 3. New ADR candidates

### D-013: lifecycle binary derives from `is_code_relation`; no new column

**Decision:** Do not add a new `is_static` / `lifecycle` column. The existing `attribute_defs.is_code_relation` is already a 1:1 mapping.

**Context:** supermemory uses an `isStatic` flag for memory lifetime. We already have the same information at the *attribute* level (code-extraction attributes are durable; agent-decision attributes are dynamic).

**Alternatives:**
- New `is_static` column — data duplication.
- Rename `is_code_relation` to `lifecycle TEXT` — non-destructive but breaks backward compat.

**Outcome:** Profile API derives the lifecycle at query time. No new column.

### D-014: Profile API is a separate export, not merged into recall

**Decision:** `profileEntity()` is its own function. `recall()` is *not* modified.

**Context:** supermemory's `recall + profile` is a single function. We separate them — recall is *raw history*, profile is an *aggregated snapshot*. Clean responsibility split.

**Alternatives:**
- `recall({ profile: true })` option — bloats one interface with two modes.
- Make recall always return profile shape — backward-compat break.

**Outcome:** Profile is *built on top of recall*. Separate function, separate responsibility.

---

## 4. Execution order

```mermaid
flowchart TD
  Start[New branch feat/supermemory-best-practices]
  Start --> Doc[1. Commit this design doc]
  Doc --> P3[2. P3-EXPOSE — types.ts + agent_memory helper + ADR D-013]
  P3 --> P2a[3. P2 — src/profile.ts]
  P2a --> P2b[4. P2 — CLI profile + MCP impact_trace_profile]
  P2b --> Test[5. tests — profile unit + CLI E2E + MCP wire]
  Test --> P6[6. P6 — skills/impact-trace/SKILL.md + references]
  P6 --> Final[7. progress.ko.md + decisions.{ko,en}.md updates]
  Final --> Push[8. git push origin feat/supermemory-best-practices — PR ready]
```

ETA: ~1 day.

---

## 5. NOT in scope (this branch)

- ❌ P1 kind enum expansion (REJECTED, ADR conflict)
- ❌ P4 pipeline state machine (REJECTED, wrong table)
- 🟡 P5 MemoryBench harness (Phase 5 candidate, separate branch)
- 🟡 supermemory connectors (Notion, Gmail) — local-first identity violation
- 🟡 multi-modal extractors (PDF, image, video) — outside our code-focused scope

---

## 6. Acceptance criteria

- [x] `npm run check` (typecheck) passes
- [x] `npm test` — 78 tests + new P2 tests pass (87 total)
- [x] `npm run lint` clean
- [x] CLI `impact-trace profile --entity X` works (E2E test)
- [x] MCP `impact_trace_profile` tool wires correctly (mcp.test added)
- [x] `skills/impact-trace/SKILL.md` follows the Claude Code skill convention
