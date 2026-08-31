# Context

`goal.md`가 단일 목표이고 `PLAN.md`가 현재 루프의 실행 순서다. 상세 후보와 장기 방향은 각각 `IMPROVEMENT_OPPORTUNITIES.md`와 `docs/roadmap.md`에 있다. 완료 주장은 `GATES.md`의 현재 증거로만 한다.

## Current State

- Branch: `codex/parallax-correctness-security-ui`; fetched `origin/main` is
  pinned at `d847ca91770891fe5b4af5ff26c146bbd4a075dd` and is an ancestor of the
  branch; it was 42 commits ahead before the current corrective checkpoint.
- Worktree was clean at loop start. The user authorized pushing this branch,
  opening a PR to `main`, and merging after all local and PR gates pass;
  deployment, publishing, credentials, and live-money actions remain out of scope.
- Current loop: PR #35 is open and mergeable. The four new CodeQL findings are
  corrected locally, including SCIP snapshot serialization and honest explicit
  input-file handling. The canonical gate and owned cleanup pass; checkpoint,
  push, require all remote checks, then merge through the authorized PR.
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
