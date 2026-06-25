# Claude Handoff Entry Point

When opening this repository in Claude Code, start by reading:

```bash
sed -n '1,260p' .superpowers/sdd/CLAUDE_HANDOFF.md
```

That file is the current local handoff for the active goal and includes the latest
commit, verification evidence, completed slices, review history, and next-slice
constraints.

## Active Goal

Continue this goal until the broad objective is genuinely complete:

`$superpowers:subagent-driven-development $superpowers:using-superpowers $team-builder $superpowers:brainstorming 이 프로젝트에서 내가 원하는 구현 이상으로 더 확장성 있고 개선해야하고 발전할 수 있는 점들을 찾아서 진행해줄래 문서도 완벽하게 만들어주고 먼저 파악부터 해봐 뭘 해야하는지 파악하고 시작해야지`

## Current Known State

- Repo: current checkout
- Branch: `main`
- Use `git status --short --branch` and `git log --oneline --decorate -5` to
  confirm the current local and remote commit state.
- `.superpowers/` is local-only and ignored by git, but it contains the detailed
  progress and Claude handoff files for this ongoing goal.

## Operating Rules

- Follow the current gate in `.superpowers/sdd/CLAUDE_HANDOFF.md`. If that
  handoff says the design/spec is approved and an implementation plan exists,
  continue from the named plan instead of restarting discovery.
- Preserve user changes. Do not reset, checkout, or remove files unless the user
  explicitly asks.
- Keep finished slices verified and push only when the user has approved that
  external action.
- Do not leave demo servers, test watchers, Playwright sessions, or bench
  processes running in the background.
- Use the repo's existing patterns and update docs/tests with each shipped slice.

## Resume Commands

```bash
git status --short --branch
git log --oneline --decorate -5
ps -axo pid,ppid,stat,command | rg '(npm run|tsx|vite|playwright|impact-perf|impact-bench|parallax ui|node --test)' | rg -v '(Code Helper|Claude|Codex|mcp|rg \()' || true
sed -n '1,220p' IMPROVEMENT_OPPORTUNITIES.md
sed -n '1,260p' .superpowers/sdd/CLAUDE_HANDOFF.md
```
