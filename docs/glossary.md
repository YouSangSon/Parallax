# Parallax Glossary

**English** · [한국어](glossary.ko.md) · [中文](glossary.zh.md)

This project has two axes (impact analysis + agent memory) that live on top of the same SQLite database and use *overlapping vocabulary*. This document resolves that ambiguity. For a quick answer, look at the table below; for the precise definition, read the sections that follow.

| Term | Impact analysis axis | Agent memory axis |
|---|---|---|
| **branch** | Not meaningful (this axis only deals with the git branch) | A row in the `branches` table — a *speculative line of work* tracked by head_tx_id |
| **entity** | The `entities` table — an identifiable unit of code (file/symbol/module/contract/policy and 21 kinds in total) | The *subject* string of a fact (a free-form identifier such as `'file:src/foo.ts'`) |
| **transaction** | Not meaningful | A row in the `transactions` table — a *bundle of facts* in a single commit unit (forms a DAG via parent_tx_id) |
| **relation** | The `relations` table — entity↔entity (DEPENDS_ON, CALLS, IMPLEMENTS, EXTENDS, etc.) | Not used (uses the `fact_provenance` edge instead) |
| **fact** | Not used | The `facts` table — a content-addressable observation (`(entity, attribute, value, op)` SHA-256) |
| **report** | The `reports` table — impact analysis results produced by the analyzer | Not used |

---

## Core terms of the impact analysis axis

### entity (impact)
A row in the `entities` table. One of 21 kinds: file / symbol / module / package / test / doc / config / policy / workflow / resource / endpoint / contract / event / business_plan / ... and so on. Impact analysis computes the blast radius by following the relation graph between entities.

### Entity kind classification

Parallax classifies file-backed entities through one shared path policy before writing reports or graph exports. Test naming wins first, Markdown work artifacts use their artifact-specific kind, `CODEOWNERS` is policy, GitHub workflow YAML is workflow, OpenAPI/Swagger/AsyncAPI files plus protobuf/GraphQL schemas are contracts, Dockerfile/Terraform files are resources, and package/build/config manifests are config.

### relation (impact)
The `relations` table. `(source_entity_id, target_entity_id, kind, confidence, adapter_run_id)`. kind is one of the values defined in `RelationKind`, such as `DEPENDS_ON`, `DECLARES`, `CALLS`, `REFERENCES`, `VERIFIES`, `DOCUMENTS`, `CONFIGURES`, `OWNS`, `GOVERNS`, `IMPLEMENTS`, `EXTENDS`, `BREAKS_COMPATIBILITY_WITH`.

### relation_evidence
The source span / command output / confidence basis that backs a relation. The audit trail for "why was this relation extracted."

### contract / endpoint / event
The `contracts`, `cross_repo_links` tables. By modeling OpenAPI / protobuf / GraphQL / AsyncAPI as entities, it analyzes *cross-repo* impact (an API change in a provider repo → breakage in a consumer repo).

### workspace
`workspaces`, `workspace_repos` — a logical unit that groups multiple repos into a single *product/organization boundary*. Not meaningful in a single repo.

### adapter_run
Metadata for a single indexing pass — adapter ID, version, confidence, known gap, error summary. Tracks coverage gaps and per-adapter analysis confidence.

---

## Core terms of the agent memory axis

### fact
The `facts` table. One row = one observation. **The PK is SHA-256(`entity || attribute || value_blob || op`)** (D-002). The same (entity, attribute, value, op) tuple always yields the same id → automatic dedup.

| Column | Meaning |
|---|---|
| `id` | content-hash PK |
| `entity_id` | the *subject* of the fact — a free-form string (`'file:src/foo.ts'`, `'task:T-1234'`, `'agent:claude'`) |
| `attribute` | the *predicate* — `'observed'`, `'verified'`, `'imports'`, `'reflection'`, etc. |
| `value_blob` | JSON-encoded value |
| `op` | `'assert'` or `'retract'` |
| `tx_id` | the transaction that created this fact |
| `redacted` | if 1, the value is stored as `'[REDACTED]'` (D-004) |

### transaction (memory)
The `transactions` table. A *bundle of facts* in a single commit unit. `parent_tx_id` (linear) + `transaction_parents(tx_id, parent_tx_id)` (multi-parent, for merge). recall walks it with a recursive CTE.

| Column | Meaning |
|---|---|
| `id` | content-hash (parent_tx_id, branch_id, ts, agent) |
| `parent_tx_id` | the immediately preceding tx (linear) |
| `branch_id` | which branch it belongs to |
| `ts` | ISO 8601 `'YYYY-MM-DDTHH:mm:ss.sssZ'` |
| `agent` | who created it (`'mcp:remember'`, `'reflect:branch=main'`, etc.) |
| `archived` | if 1, archived by gc-branches (D-011) |

### branch (memory)
The `branches` table — an agent's speculative line of work. A *concept distinct from* the git branch. Multiple memory branches are possible in the same repo (`main`, `experiment-a`, `plan-B`). Each branch's head_tx_id points to its own latest tx.

| Column | Meaning |
|---|---|
| `name` | UNIQUE — `'main'` is PROTECTED |
| `head_tx_id` | latest tx (NULL for an empty branch) |
| `parent_branch_id` | the fork origin |
| `state` | `'active'` / `'abandoned'` (D-011 soft-delete) |

### fact_provenance
The provenance chain between facts. `(fact_id, source_fact_id, kind, tx_id)` — `kind` takes `'evidence'` (the basis created by the indexer/agent), `'summary'` (the source of Phase 3 reflective consolidation), or `'supersedes'` (a new fact explicitly replacing an older decision/summary/policy fact). `tx_id` is the transaction in which the edge was created, so branch/as-of visibility is judged accurately even when a content-addressed replacement fact is reused. `trace` also returns the edge kind, and the current view of recall/profile hides superseded facts.

### reflection
The `reflections` table — the audit row for Phase 3 reflective consolidation. The *summary fact* is stored with `facts.attribute = 'reflection'`, and the reflections table records the model / the number of input facts / the creation time. When an orphan state occurs, `reflect --repair` (D-015) corrects it.

### profile
The result of `profileEntity()` — splits one entity's facts into 3 buckets: **staticFacts** (code relations, `is_code_relation=1`) / **dynamicFacts** (agent activity) / **summaryFacts** (reflection). Exported separately from recall via D-014.

### lifecycle
A binary classification of an attribute — `'static'` (code relation, permanent) vs `'dynamic'` (agent activity, volatile). In D-013 it is derived at query time from `attribute_defs.is_code_relation` without a new column.

### fact_embeddings (canonical) vs vec_facts_<model_slug> (ANN index)
| Table | Role |
|---|---|
| `fact_embeddings(fact_id, model, vector BLOB int8, dim, created_at)` | **canonical** — D-007 multi-model PK; used by brute-force recall |
| `vec_facts_<model_slug>(fact_id TEXT PK, embedding int8[<dim>])` | **ANN index** (D-018) — sqlite-vec vec0, lazy-created at first dual-write, per-model |

---

## Commonly confused pairs

### branch (git) vs branch (memory)
Same word, *completely different concepts*. The git branch is managed by git itself and parallax does not access it directly. The memory branch is a row in the `branches` table and is handled with the `branch --name foo` / `branch --abandon foo` / `branch --restore foo` / `merge` commands.

### entity (impact) vs entity_id (memory)
- The impact entity is a *struct* in the `entities` table (id + kind + version + source span).
- The memory `entity_id` is a *string* — any free-form identifier is allowed (`'file:src/foo.ts'`, `'pr:42'`, `'concept:auth'`). The memory axis *does not read* the entity table; if the two axes use the same string (`'file:src/foo.ts'`) they naturally cross-reference, but it is not enforced.

### transaction (DB) vs transaction (memory)
- DB transaction: `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`. The atomic write unit at the SQLite level.
- memory transaction: a row in the `transactions` table. A *logical commit unit* — one `remember()` call creates one memory tx, and adds one fact within it. A memory tx is always created within a single DB tx.

### fact vs relation
- impact axis: relation (entity ↔ entity).
- memory axis: fact (entity + attribute + value).
- The two are *different column sets, different tables*. An intentional separation — relation is a typed graph, fact is free-form key-value with content addressing.

### static fact vs dynamic fact vs summary fact
- **static fact** — a fact created with an attribute where `attribute_defs.is_code_relation = 1` (`imports`, `calls`, `affects`, `depends_on`). Added by the indexer; expresses code structure.
- **dynamic fact** — an attribute where `is_code_relation = 0` (`observed`, `verified`, `concern`). Agent activity.
- **summary fact** — a fact where `attribute = 'reflection'`. A *summary of the originals* produced by Phase 3 reflective consolidation. The originals are preserved via D-010.

### reflect vs repair (vs reindex-vec)
- `reflect` — summarizes old facts with an LLM (Phase 3, D-009 explicit trigger).
- `reflect --repair` — an orphan summary fact correction sweep (D-015, Phase 4 P2).
- `reindex-vec` — backfills the `vec_facts_<model>` table from the existing `fact_embeddings` (D-018, Phase 4 P5).
- All three have *explicit triggers* only, with no daemon (D-009).

---

## SQLite format notes

- Every ts is ISO 8601 UTC `'YYYY-MM-DDTHH:mm:ss.sssZ'` (`new Date().toISOString()`).
- Exception: `branches.created_at` uses the SQLite `datetime('now')` format (`'YYYY-MM-DD HH:MM:SS'`) only for the `main` row. main is PROTECTED so it is excluded from comparisons, hence no impact.
- All binary data is a BLOB (vectors are an int8 packed Buffer).
- All JSON data is a TEXT column + JSON.stringify (for D-002 content-hash stability, key order follows the V8 default).
