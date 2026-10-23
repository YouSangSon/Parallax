# Context

`goal.md`가 단일 목표이고 `PLAN.md`가 현재 루프의 실행 순서다. 상세 후보와 장기 방향은 각각 `IMPROVEMENT_OPPORTUNITIES.md`와 `docs/roadmap.md`에 있다. 완료 주장은 `GATES.md`의 현재 증거로만 한다.

## Current Portfolio Loop — 2026-10-23

The dependency remediation landed as PR #38 / `27865fe`: compatible locked
updates remove all audit findings, and high/critical findings are rejected
without an exception. Native local E5 q8 inference was verified separately
from the suite's embedding stub.

Packaged CLI and stdio MCP passed the session-change workflow. Live workbench
inspection led to a two-rule CSS fix: preserve confidence badge backgrounds
and darken heuristic text. PR #39's canonical verification and desktop/mobile
contrast checks passed; see `GATES.md` for scope and limitations.

Native browser follow-up closed the clipboard, file download, source new-tab
and Back/Forward evidence gaps. Inspecting the saved PNG exposed a light
canvas behind pale graph labels; the export now reuses the existing graph
background variable. The corresponding native files and contrast evidence
are retained with the portfolio records. The PNG follow-up's full local command
failed on 13 deadline waits; all 13 passed in focused recovery, and the remaining
dogfood, benchmark and audit commands passed separately, as recorded in `GATES.md`.

Portfolio evidence is maintained separately in the resume repository under
`자료수집/2026-10-23/parallax-portfolio/README.md`.
Each PR's checks and merge record own remote landing evidence. Local workflow
proof does not establish production adoption or paid-model savings. Selective
indexing remains deferred under the existing emitted-row ownership gate.

## Prior Completed State

- Landing state: PR #35 squash-merged the verified tree to `main` as
  `4f289a6e9e145efa2814dd7f3eb68e4e30a0bef3`. Its tree exactly matched the
  tested branch head `eb21527c1f84e0119dbc804be82e22bc77472c57` after fetch.
- Worktree was clean at loop start. The user authorized pushing this branch,
  opening a PR to `main`, and merging after all local and PR gates pass;
  deployment, publishing, credentials, and live-money actions remain out of scope.
- Prior loop: complete. The four new CodeQL findings were corrected,
  including SCIP snapshot serialization and honest explicit input-file
  handling; canonical local verification, owned cleanup, all five remote
  checks, and the authorized merge passed.
- Confirmed defect: changing only `tsconfig.json` can leave an unchanged TypeScript
  file's alias-resolved edge stale because full-index adapter context was not
  invalidated.
- Safe boundary: any changed indexed body uses the existing full extraction
  path. `target-only` constrains reads but not emitted-row ownership, so it is not
  sufficient to authorize changed-only carry-forward.
- The local `.superpowers/sdd/CLAUDE_HANDOFF.md` predates the current head and is historical until refreshed.
- The bounded UI audit corrections are implemented and recorded in `GATES.md`.

## Load Order

1. `goal.md`
2. `PLAN.md`
3. `GATES.md`
4. `CONTEXT.md`
5. `DESIGN.md`
6. `docs/CODEX-NAVIGATION-GUIDE.md`
7. Only then follow the links needed for the current plan item.
