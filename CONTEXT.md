# Context

`goal.md`가 단일 목표이고 `PLAN.md`가 현재 루프의 실행 순서다. 상세 후보와 장기 방향은 각각 `IMPROVEMENT_OPPORTUNITIES.md`와 `docs/roadmap.md`에 있다. 완료 주장은 `GATES.md`의 현재 증거로만 한다.

## Current State

- Branch: `codex/parallax-correctness-security-ui`; this loop started from local
  `main` at `b804d72`, 40 commits ahead of the recorded `origin/main`.
- Worktree was clean at loop start. The user authorized pushing this branch,
  opening a PR to `main`, and merging after all local and PR gates pass;
  deployment, publishing, credentials, and live-money actions remain out of scope.
- Current loop: close verification and cleanup for the corrected S1, dependency
  audit, and UI checkpoint, then land it through the authorized PR.
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
