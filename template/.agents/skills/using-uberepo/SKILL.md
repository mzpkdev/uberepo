---
name: using-uberepo
description: |
  Drive a multi-repo uberepo workspace through the `uberepo` CLI — open/sync/close
  per-task git worktrees across every repo, clone a workspace's repos, and share a
  workspace. Trigger when `uberepo.json` is present, the CWD is under `source/` or
  `tasks/<task>/`, or a task spans several repos managed by uberepo: 'open a task',
  'sync my task', 'close this task', 'set up the workspace', 'work across these
  repos'. Do NOT trigger for single-repo git work, or for the conventions of an
  individual repo inside a worktree — defer to that repo's own AGENTS.md/README.
---

# Using uberepo

Drive a uberepo workspace through the `uberepo` CLI. uberepo manages several git
repos together; each *task* gets its own git worktree in every repo, so you work
across them at once and switch tasks by switching directories — not `git checkout`.

## When to use

- `uberepo.json` is in the workspace root, or the CWD is under `source/` or
  `tasks/<task>/`.
- A task touches more than one repo and you need them on a matching branch.
- You're opening, syncing, closing, cloning, or sharing a uberepo workspace.

## When NOT to use

- Plain single-repo git work with no `uberepo.json` — use git directly.
- The build/test/commit conventions *inside* one repo's worktree — those live in
  that repo's own `AGENTS.md`/`README`, not here.

## How to run

1. **Orient.** Run `uberepo status --json` (open tasks + each worktree's
   branch/clean-dirty) and `uberepo sources --json` (registered repos +
   cloned-or-not); when clean/dirty isn't enough, `uberepo diff <task> --json`
   reports the task's footprint — commits ahead + diffstat per repo (read-only;
   uncommitted changes aren't counted). Parse the JSON; don't scrape human text.
   Re-read before reporting state. `--json` is a global flag on **every**
   command — pass it to any command for a single stable JSON object describing
   its outcome.
2. **Work the lifecycle** (one task = one `task/<task>` branch across every repo):
   - `uberepo open <task>` — worktree + `task/<task>` branch in every cloned repo.
     `--from <ref>` chooses a base; `--goal "<text>"` sets the task note's goal;
     `--repos <name>...` scopes the task to those repos (and is unioned in on
     re-open) — a scoped repo not yet cloned is cloned on demand first; unscoped
     opens never clone. Idempotent.
   - Edit in `tasks/<task>/<name>/`. **Commit and push per repo yourself** —
     uberepo does NOT commit or push. Follow each repo's own AGENTS.md/README.
   - `uberepo sync <task>` — rebase each worktree onto its fresh default branch.
     Refuses a dirty worktree; stops on conflict and leaves that repo mid-rebase.
     `--check` forecasts all that first, per repo (fetch only — no rebase, no
     hooks), so run it when you want to see the conflicts before hitting them.
   - `uberepo ship <task>` — push each repo's branch and open a **draft** PR per
     repo. Needs the GitHub CLI (`gh`) unless `--no-pr`. `--title`/`--body`
     override; otherwise title = goal's first line, body = the repo's `.github` PR
     template. Re-run to fill gaps: it skips repos with nothing to ship and leaves
     an existing PR untouched (push refreshes it).
   - `uberepo close <task>` — remove worktrees + delete the branch. Refuses
     uncommitted/unmerged work; `--force` only when the work is saved.
   - **Hooks (optional):** if `uberepo.json` has a `hooks` map, pre-/post- shell
     commands run per repo around every lifecycle op (`clone`/`open`/`sync`/
     `ship`/`close`). A failing pre-* hook skips that repo's op — a failed
     `pre-ship` blocks the push, a failed `pre-close` keeps the worktree; cwd =
     the repo/worktree, `UBEREPO_*` vars in the env (full tables in
     reference.md). A hook may already have installed deps or copied configs —
     check before redoing that work. `--no-hooks` skips them for a run; use it
     when the human asks, not by default.
   - **Carry (optional):** if `uberepo.json` has `carry` glob patterns
     (workspace-level and/or per repo), `open` copies the matching untracked
     local files (`.env`, certs) from `source/<name>` into each fresh worktree
     before its post-open hook, and `sync` re-copies missing ones. Existing
     worktree files are never overwritten. `close` warns when a carried file
     was edited in the task — those edits are lost with the worktree, so copy
     them out first if they matter (details in reference.md).
3. **For flags, sharing, and refusal-recovery**, read [reference.md](reference.md).
   `uberepo --help` lists every command and flag.

## The task note — `tasks/<task>/ubertask.yml`

A per-task handoff note carrying the durable context git can't: the `goal`,
`tickets`, deliberate `decisions`, and known `blockers`. `open` seeds it; it dies
with the task on `close`. It holds the *why*, not the *what* — git already shows
what changed, what's done, what's left.

- **Resuming a task:** read it first for the standing context, then reconcile
  against `git status`/`git diff`. It's a hint, not truth — if they disagree,
  reality wins, so fix the note.
- **While you work:** set `goal` when you open the task; append a `decision` or
  `blocker` the moment one lands, tagging `repo:` when it's about a single repo.
  Don't record progress, next-steps, or dates — git and the file's mtime cover those.

Schema, field rules, and an example: [reference.md](reference.md).

## Golden rules

- Work in `tasks/<task>/<name>/`, **never** in `source/` — `source/` is the
  shared base clone.
- Don't hand-edit `uberepo.json` (use `add`/`remove`), don't `rm` task dirs or run
  raw `git worktree` (use `open`/`close` — they guard unsaved work), and don't
  `--force` past a `sync`/`close`/`prune` refusal unless the work is genuinely saved.
- Keep `tasks/<task>/ubertask.yml` honest — it's the next session's handoff. A
  stale note that contradicts git is worse than no note.

## What to return

Plain prose or a short bulleted status — what you ran, each repo's resulting
branch/state, and any refusal hit verbatim plus its fix. On failure say what
refused and why (e.g. "sync stopped on a conflict in `<name>` — resolve and
re-run"), never a bare "done".

## Example

> "Sync task `auth-refactor`."

1. `uberepo status --json` → confirm `auth-refactor` is open and every worktree clean.
2. `uberepo sync auth-refactor`.
3. If it stops on a conflict in `api/`: resolve in `tasks/auth-refactor/api/`,
   `git add` + `git rebase --continue`, then re-run `uberepo sync auth-refactor`.
4. Report: each repo rebased onto its fresh default, or the repo + fix if it stopped.
