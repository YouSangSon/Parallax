# Parallax — Value Proposition

**English** · [한국어](value-proposition.ko.md) · [中文](value-proposition.zh.md)

> **What this document is for:** A living one-pager, compressed so that an internal hackathon judge can grasp *what it is, why it matters, and how it's different* in 5 minutes. It keeps getting refined as development progresses.
>
> **Last updated:** 2026-04-30
>
> **Companion documents:**
> - User-facing README: [`README.md`](../README.md)
> - Big-picture design notes: [`docs/agent-db-exploration.ko.md`](agent-db-exploration.ko.md)
> - Usage flows and examples: [`docs/agent-memory-cookbook.ko.md`]
> - Current progress: [`docs/progress.ko.md`]
> - Next milestone: [`docs/phase3-handoff.ko.md`](phase3-handoff.ko.md)

---

## 1. One-line summary

> **A local tool that hands AI coding tools (Claude Code, Codex, etc.) both a "map of the codebase" and a "notebook of yesterday's thinking" at the same time. All in a single SQLite file, with no external dependencies.**

## 2. The problem we're solving — two frustrations

Using AI coding tools in real work, two things grate on you.

### Problem 1. The AI touches code without knowing "what breaks"

Change one function in `auth.ts`, and the 7 other files that use that function can break with it.
A human developer checks with grep, but the AI moves on guesses inside its own head.

→ **We need to show the change's impact up front.**

### Problem 2. The AI forgets every decision it made yesterday

Even if today the AI judges *"I wrote this auth logic the X way because of a security issue"* and writes the code accordingly,
that judgment is gone in the next session. It evaporates when the chat ends.

→ **We need to persist decisions, observations, and evidence — and make them searchable.**

## 3. The key insight — the two are actually the same data

> **"Code impact analysis" and "AI memory" both ultimately come down to storing *"how X connects to Y, and what the evidence is."***

This single insight simplifies the system. We *dual-write* two tracks into **one SQLite file**.

- The indexer finds an `import` line → one row in the `relations` table + **at the same time** one row in the `facts` table. Same transaction.
- Then the moment the AI asks *"why did you think this file was impacted?"*, it walks the `fact_provenance` chain backward all the way down to the original code snippet.

No graph DB, no vector DB, no external cache — one file.

## 4. Four core values

### V1. Local-first, single file, zero external dependencies

Everything lives in one file: `.parallax/impact.db`.
- Friendly to internal security policy — code and decision data never leave the user's PC
- Backup: copy a single file / commit it to git to share with the team
- Even embeddings run in-process (`@huggingface/transformers` ONNX) — zero external API calls

### V2. Time/branch/causality as first-class citizens

A single pattern borrowed from Datomic and git drops three features out of one mechanism.

| Feature | How |
|---|---|
| Time travel ("what did it look like 5 turns ago?") | `as_of_tx` recursive CTE |
| Branching (simulate multiple plans in parallel, then adopt one) | branch fork/merge, zero data copy |
| Causal chain ("what's the basis for this decision?") | `fact_provenance` BFS |

### V3. Unified search across the code graph and memory

Instead of looking at several tools separately, get **"everything known about this file"** in a single query:

- Who imports it (code relations)
- Decisions the AI made in the past (memory)
- The evidence snippet behind that decision (provenance)

This all comes back in one response.

### V4. Automated secret protection

Patterns for passwords, API keys, and private keys are automatically redacted at the indexing/storage stage.
There's also a **redact-then-embed gate**: if a secret is caught, the embedding row itself is never created — so the secret can't leak into the vector space either.

## 5. How we differ from similar services

Organized by the comparison points a judge is likely to bring up.

### vs. Claude's own memory / ChatGPT memory

| Axis | Claude/GPT memory | Parallax |
|---|---|---|
| Storage form | Free text (markdown) | Structured fact (entity, attribute, value) |
| Time/branch | None (overwrite and it's gone) | as_of time travel + branch |
| Causal tracing | None | fact_provenance chain |
| Code graph integration | None — code is grepped every time | Code relations live in the same fact table |
| Secret handling | User has to be careful | Automatic redaction + zero-row embedding |
| Data ownership | External service infrastructure | A single file on the user's PC |
| Use with other AI tools | Claude/GPT only | MCP standard — Codex and Cursor alike |
| Offline | ❌ | ✅ |

In short: Claude/GPT memory is *"a memo of the relationship between me (the agent) and you (the user)."* Parallax is *"working memory of the codebase I touch"* — a complementary relationship.

### vs. MCP memory server (the community-standard memory)

Most MCP memory servers are simple key-value or text memory.
Parallax is memory that **puts time/branch/causality/code-graph as first-class citizens on top of MCP**.

### vs. Sourcegraph / CodeQL

| Axis | Sourcegraph/CodeQL | Parallax |
|---|---|---|
| Purpose | Static analysis and search (a tool for humans to look at) | An AI agent's decision record + impact |
| Infrastructure | Requires running a server | Local single file |
| Memory layer | None | First-class citizen |
| MCP integration | None (separate protocol) | Standard MCP stdio |

If existing tools are for *people searching code*, Parallax is for *the AI touching code*.

### vs. A graph DB (Neo4j, etc.) + vector DB combo

Build it yourself and you get: a graph DB server + a vector DB + an ETL pipeline + auth/permissions.
Parallax expresses the same essence with a single SQLite file + the sqlite-vec extension. One-tenth the operational complexity.

## 6. Current status — what works / what doesn't

### Works ✅
- Accurately indexes TypeScript/JavaScript/Markdown
- regex-heuristic indexing for 9 additional languages (Python, Go, Rust, Java, Kotlin, C#, C, C++)
- Indexes infrastructure/contract files (Docker, Terraform, protobuf, GraphQL, CODEOWNERS, etc.)
- "changed files → impacted files" bounded multi-hop analysis (cycle/fanout protection)
- Persists AI decisions/observations as facts
- Time travel (`as_of_tx`), retract dedup (`current_only`), semantic search (`semantic`)
- branch fork/merge for simulating multiple hypotheses
- Automatic secret redaction + zero-row embedding
- MCP stdio server — connects to Claude Code and Codex immediately

### In progress / not yet implemented 🟡
- TypeScript Compiler API semantic adapter (regex → precise syntactic analysis)
- Analyzing multiple repositories together (workspace catalog) — schema is ready
- API contract tracking (impact of OpenAPI/protobuf changes) — schema is ready
- Visual web graph explorer
- Automatic summarization of stale memory (reflective consolidation, )
- Automatic cleanup of abandoned branches

Tests: 43 passing. 4,114 LOC TypeScript. 4 external dependencies (MCP SDK, transformers.js, sqlite-vec, zod).

## 7. Expansion roadmap — directions that grow the value

### A. Breaking the accuracy ceiling (highest impact)
- TS Compiler API adapter → precise down to path alias / re-export / dynamic import
- Tree-sitter / LSP integration → semantic parsing for nearly every language
- CodeQL adapter → tracing all the way down to data flow

### B. Expanding beyond code — essential for the microservice era
- Bundling multiple repositories (`workspaces`/`workspace_repos`) — schema already exists
- API contracts (OpenAPI/protobuf/GraphQL/AsyncAPI) → automatically identify downstream consumers on change
- Impact of CI/Docker/K8s/Terraform infrastructure changes

### C. Integrating company work artifacts too — the most ambitious direction
- Register PRDs, meeting notes, decision records, and KPI documents as entities
- *"this PRD change → which code functions and tests are impacted?"*
- *"this code change → which ops docs and customer materials need updating?"*
- Code impact tool → a leap to a **"company-wide change impact tool"**

### D. AI memory automation
- Reflective consolidation: just as the brain tidies up during sleep, the LLM automatically summarizes and promotes stale memos
- Branch GC: automatically clean up buried branches created for simulation
- Importance-score-based archiving

### E. UX / visualization
- Web graph explorer (click-to-explore the impact graph)
- VSCode/JetBrains extensions (show impact instantly inside the editor)
- Timeline view (replay AI decisions in chronological order)
- Obsidian sync (memos into the vault)

### F. External system integration
- Linear/Jira ticket entities → automatically map "which ticket does this change close"
- Link Slack threads as evidence
- GitHub PR merge = automatic fact recording

### G. Team mode — distributed fact sync (not implemented, under consideration for the future)

Today it assumes one person per PC. Even when expanding to team sharing, we're considering directions that don't abandon the *single .db / local-first* identity.

**Core idea:** A git-like distributed model where, without forcing a central server, **everyone works in their own local SQLite and only periodically syncs facts**.

Why this is natural:
- facts are already **content-addressable** (id = `sha256(entity|attribute|value|op)`) — no matter who creates them where, the same fact gets the same ID, with automatic dedup
- transactions are already a **multi-parent DAG** (`transaction_parents`) — isomorphic to git's commit graph
- branches are already a **head pointer + parent_branch** — isomorphic to git's branches

In other words, *a git-like structure is already inside SQLite*, so team sharing isn't a new invention but a natural extension.

**Implementation pattern — keep `.db` private, share only facts as text:**

```
[teammate A local]             [git repo]                  [teammate B local]
  impact.db    ──export──→     facts/                ←──import──    impact.db
  (.gitignore)                  *.jsonl                              (.gitignore)
                              (text, reviewable in a PR)
```

The `.db` file itself is SQLite's internal page structure, so git can't handle it (no visible diffs and no way to resolve conflicts). That's why it's natural to **export only the fact data as JSONL text → commit/push it to git**.

Hypothetical usage flow:
```bash
# teammate A
parallax remember --entity file:src/auth.ts --attribute decision --value '"X 방식"'
parallax export --since last-sync > facts/2026-04-30-A.jsonl
git add facts/ && git commit -m "share auth decisions" && git push

# teammate B
git pull
parallax import facts/2026-04-30-A.jsonl
# → the fact A created is merged into B's local .db. Content-addressable, so automatic dedup.
```

**Why there are no conflicts:** fact ID = `sha256(entity|attribute|value|op)`. If A and B independently make the same decision, the ID is identical → automatic dedup via `INSERT OR IGNORE`. If the decisions differ, the IDs differ → both are preserved. Because facts are append-only, git's *"same line, different edits"* conflict pattern simply never arises.

**Side effect — "review AI decisions as a PR":** because the fact JSONL is text, you review it as code directly in the git interface. *"Do we accept this decision the AI made?"* is handled with a single PR. A workflow that directly answers the internal worry that *"it's scary to leave things to the AI carelessly."*

**Selective sharing policy options:**
| What to share | Suitable for |
|---|---|
| A. Code graph facts only (imports/calls/declares created by the indexer) | A team sharing the same codebase, AI decisions kept per-person |
| B. + including AI decision facts | The team shares "why was it written this way?" |
| C. Only the `--share` flag or the `team-shared` branch | Sensitive decisions stay private, only shared decisions get pushed |

C is the most realistic — export only facts the user has explicitly shared.

**Channel options (git isn't the only answer):**
| Channel | Pros | Cons |
|---|---|---|
| **git repo** (main recommendation) | Familiar, review/history for free | Manual export/import |
| Separate git repo (`<project>-facts`) | Doesn't pollute the code repo | Managing two repos |
| Internal sync server (HTTP) | Automatic, real-time | Running one server |
| Shared folder (NAS, S3) | Almost no infrastructure | Weak conflict policy |

**Comparison points (for reference, the other roads):**
| Model | Analogy | local-first | Operational complexity |
|---|---|---|---|
| **Distributed fact sync (this direction)** | git | ✅ preserved | ★★ |
| Central memory server (Postgres, etc.) | Google Docs | ❌ broken | ★★★★ |
| SQLite distributed variants like Turso/Litestream | hybrid | △ | ★★ |

**Status:** Not implemented, **under consideration for the future**. Because the content-addressable model already accommodates the structure, it can *be entered quickly when priorities are decided*. A candidate for after (reflective consolidation, branch GC). Start with the git channel + manual export/import → once validated, add a `parallax sync` automation sidecar.

**Judge Q&A card:** *"Won't SQLite stop scaling once things get big?"* → "*We don't put the .db itself in git. We export only the facts inside it as text, and since they're content-addressable there are no merge conflicts. As a side benefit, a workflow for reviewing AI decisions as PRs comes along with it.*"

## 8. The messages we want to emphasize to judges

1. **Timing**: This is the infrastructure layer needed *right now*, as AI coding tools enter serious adoption. The more the AI touches code, the more sharply the cost of missing impact/memory grows.

2. **Simplicity**: A single SQLite file + MCP stdio. Operational complexity is near zero — no adoption friction in any internal environment.

3. **Built on a standard**: Not a proprietary protocol but built on MCP, the industry standard. Claude Code, Codex, and Cursor all share the same memory/impact foundation.

4. **Local-first security**: Internal code/decisions don't go outside — easy to pass security review.

5. **Room to expand baked into the schema**: workspace/contract/cross-repo/work-artifact tables are already included in the migrations. Just add an adapter and the roadmap above moves fast.

## 9. Once more, in a single sentence

> A single-file, standard-protocol, local-first tool that hands the AI both *a map of the codebase* and *a diary of its own decisions*.

---

## Appendix: rules for updating this document

- **A new core feature starts working** → update §6 (Current status).
- **The differentiation message gets more precise** → update §3, §5.
- **A roadmap item enters into working state** → move it from §7 to §6.
- **A similar service/competitor appears** → add a comparison to §5.
- **An emphasis shifts based on user interviews/judge feedback** → update §8.

When changing the content, the yardstick is *"can a judge grasp the core in 5 minutes."* If it gets long, compress it.
