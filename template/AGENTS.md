# Working in this uberepo workspace

Several git repos managed together via the `uberepo` CLI. Each *task* gets its own
worktree in every repo — work across them at once, switch tasks by switching dirs,
never by hand. First move: `uberepo status` + `uberepo sources`.

## Layout

    <workspace>/
    ├── uberepo.json          # the registered repositories
    ├── source/<name>/        # canonical clone — read-only, don't work here
    └── tasks/<task>/<name>/  # per-task worktree, on branch task/<task> — work here

## Rules

- **Work in `tasks/<task>/`, never in `source/`.** That's where edits, commits, and
  pushes happen — per repo (uberepo doesn't push for you). `source/` is the shared base.
- **Don't manage repos or worktrees by hand** — use the commands, not `git clone` /
  `git worktree` / a hand-edited `uberepo.json`. They guard unsaved work; raw git doesn't.
- **Each repo speaks for itself** — inside a repo's worktree, follow that repo's own
  `AGENTS.md` / `README`. This file only covers the workspace.

## Going deeper

`uberepo --help` lists every command and flag. Claude Code: the `using-uberepo` skill
in `.claude/skills/` carries the full lifecycle (open → sync → close), recovery, and sharing.
