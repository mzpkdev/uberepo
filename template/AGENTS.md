# Working in this uberepo workspace

Several git repos managed together via the `uberepo` CLI. Each *task* gets its own
worktree in every repo — work across them at once, switch tasks by switching dirs,
never by hand. (A repo can carry more than one branch in a task via a `repo@alias`
participant — see Layout.) First move: `uberepo status` + `uberepo sources`.

## Layout

    <workspace>/
    ├── uberepo.json          # the registered repositories
    ├── source/<repo>/            # canonical clone — read-only, don't work here
    ├── tasks/<task>/<name>/      # per-task worktree, on branch task/<task> — work here
    └── tasks/<task>/ubertask.yml # task handoff note — keep it current

`<name>` is the participant: a bare repo (`web`, branch `task/<task>`) or a
`repo@alias` token (`web@auth`, branch `task/<task>@auth`) when a repo carries
several branches in one task. The folder is flat one level either way, and all of
a repo's participants share its one `source/<repo>` clone.

## Rules

- **Work in `tasks/<task>/`, never in `source/`.** That's where edits, commits, and
  pushes happen — per repo (uberepo doesn't push for you). `source/` is the shared base.
- **Don't manage repos or worktrees by hand** — use the commands, not `git clone` /
  `git worktree` / a hand-edited `uberepo.json`. They guard unsaved work; raw git doesn't.
- **Each repo speaks for itself** — inside a repo's worktree, follow that repo's own
  `AGENTS.md` / `README`. This file only covers the workspace.
- **Keep `tasks/<task>/ubertask.yml` current** — set `goal` when you start the task,
  append `decisions` / `blockers` as they come up; don't record progress or next-steps
  (git shows those). The `using-uberepo` skill carries the full reader/writer contract.

## Going deeper

`uberepo --help` lists every command and flag. Claude Code: the `using-uberepo` skill
in `.claude/skills/` carries the full lifecycle (open → sync → close), recovery, and sharing.
