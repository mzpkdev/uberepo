# Working in this uberepo workspace

**TL;DR:** repos live in `source/`, you work in per-task worktrees under
`tasks/<task>/`, and you drive it with the `uberepo` CLI — never by hand.
First move: `uberepo status` (what's open) + `uberepo sources` (the repos).
`uberepo --help` lists every command and flag.

## Layout

    <workspace>/
    ├── uberepo.json          # manifest: the registered repositories
    ├── source/<name>/        # canonical clone of each repo — DON'T work here
    └── tasks/<task>/<name>/  # per-task worktree of each repo, on branch task/<task>

If your CWD is under `tasks/<task>/`, you're already in a task worktree — commit
there. `source/` is the shared base clone; leave it alone.

## One task = one branch across every repo

`uberepo open <task>` makes a `tasks/<task>/<name>/` worktree on branch
`task/<task>` in EVERY cloned repo. Switch tasks by switching directories, not by
`git checkout`.

## Each repo speaks for itself

Inside a repo's worktree, follow THAT repo's own `AGENTS.md` / `README` for build,
test, and style. This file only covers the workspace.

## Workflow

    uberepo open <task>     # worktree + task/<task> branch in every repo
    # work, then commit IN EACH repo's worktree (tasks/<task>/<name>/)
    uberepo sync <task>     # fetch + rebase the task onto each repo's fresh default
    uberepo close <task>    # remove worktrees + delete the branch when done

- Commit and push **per repo**, inside its worktree — uberepo does NOT commit or push for you.
- If `sync` hits a conflict it STOPS and leaves that repo mid-rebase: resolve there, then re-run.

## Live state — parse --json, don't scrape text

    uberepo sources --json   # registered repos + cloned-or-not
    uberepo status --json    # open tasks, each worktree's branch + clean/dirty

## Don't

- Don't edit/commit/branch in `source/` — work in `tasks/<task>/`.
- Don't hand-edit `uberepo.json` — use `add` / `remove`.
- Don't `rm` task dirs or run raw `git worktree` — use `open` / `close` (they guard unsaved work).
- Don't `--force` past a refusal unless the work is genuinely saved.
