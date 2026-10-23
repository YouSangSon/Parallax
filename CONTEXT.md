# Context

`goal.md`가 단일 목표이고 `PLAN.md`가 현재 루프의 실행 순서다. 상세 후보와 장기 방향은 각각 `IMPROVEMENT_OPPORTUNITIES.md`와 `docs/roadmap.md`에 있다. 완료 주장은 `GATES.md`의 현재 증거로만 한다.

## Current Portfolio Loop — 2026-10-23

Base: PR #36 / `ab3c365`. Work continues on
`codex/parallax-portfolio-readiness` with no pre-existing working-tree edits.
The expired audit exception reproduced a release failure. A compatible
lockfile-only dependency refresh now reports zero vulnerabilities; the gate
rejects all high/critical findings. Focused security tests pass 9/9 and the
real default E5 q8 model produces a repeatable 768-byte/768-dimensional vector
on local macOS arm64. Clean install and canonical verification pass (697 tests,
2 dogfood tests, 78/78 bench relations, zero audit findings). The packed CLI and
stdio MCP also passed the session-change demo. Live UI inspection found low
contrast on unselected confidence badges; that bounded follow-up, remote PR
checks and portfolio evidence remain pending.
See `PLAN.md` for scope and `GATES.md` for current verification.

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
