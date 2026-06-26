<!-- UBEREPO:UNCONFIGURED — REQUIRED ACTION, DO NOT IGNORE. This AGENTS.md is an UNFILLED
     scaffold. If you are an AI agent, you MUST run /boot-uberepo before doing any real work in
     this workspace — it inspects the repos in source/ and fills every section below. You MUST
     fill EVERY "Fill:" section, ALWAYS from the real repos in source/, and you MUST NEVER invent,
     guess, or keep the example rows. When every section is filled you MUST delete all "Fill:"
     comments, this marker, AND the banner. NEVER leave this file half-configured. -->

> [!IMPORTANT]
> **This workspace is NOT configured.** You MUST run **`/boot-uberepo`** before working here —
> it fills the sections below from the real repos. Do this FIRST, then delete this banner.

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

<!-- REQUIRED: fill one row per repo — what each repo is. You MUST cover EVERY repo in source/
     and MUST NEVER invent one. The example row is FORMAT ONLY — do NOT keep it. Delete this
     comment once filled.  e.g. | api | REST backend — owns auth + billing | -->

| Repo | What it is |
| --- | --- |

## Architecture

<!-- REQUIRED: describe how the repos connect and how data flows — who calls/consumes whom and
     over what (REST, published package, shared DB/queue), who owns each contract, the data path
     across repos. You MUST ground every edge in the real code and MUST NEVER guess a connection;
     ALWAYS ask the human for any wiring you cannot verify. Delete this comment once filled. -->

## Tooling

<!-- REQUIRED: give the bootstrap / dev / test command for EVERY repo — commands, NOT prose.
     These are the source the hooks are wired from (install → post-open, test → pre-ship), so they
     MUST be the real, working commands and MUST NEVER be guesses. The example row is FORMAT ONLY —
     do NOT keep it. Delete this comment once filled.  e.g. | api | npm ci | npm run dev | npm test | -->

| Repo | Bootstrap | Dev | Test |
| --- | --- | --- | --- |
