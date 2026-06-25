<!-- UBEREPO:UNCONFIGURED — this AGENTS.md is still the scaffold. Each section below
     has an HTML-comment prompt describing what to fill. Once filled, delete those
     prompts, this marker, and the banner. Running /boot-uberepo does it for you. -->

> [!IMPORTANT]
> **This workspace isn't configured yet.** Run **`/boot-uberepo`** to fill in the
> sections below, then delete this banner.

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

---

## Repositories

<!-- Fill: one row per repo — what each is.  e.g. | api | REST backend — owns auth + billing | -->

| Repo | What it is |
| --- | --- |

## Architecture

<!-- Fill: how the repos connect and how data flows. Who calls/consumes whom and over what
     (REST, published package, shared DB/queue), who owns each contract, and the data path
     across repos. A diagram or a few lines — whatever's clearest. -->

## Tooling

<!-- Fill: how to bootstrap each repo — install / dev / test (write commands, not prose).
     This is the source the hooks get wired from: install → post-open, test → pre-ship.
     e.g. | api | npm ci | npm run dev | npm test | -->

| Repo | Bootstrap | Dev | Test |
| --- | --- | --- | --- |
