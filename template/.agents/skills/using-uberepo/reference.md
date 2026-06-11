# uberepo reference

Full command + flag detail for the `using-uberepo` skill. Load this when you
need the exact flags, the conflict/refusal recovery steps, or the sharing flow.
`uberepo --help` (and `uberepo <command> --help`) is the live source of truth —
prefer it if this file and the CLI ever disagree.

## Workspace layout

    <workspace>/
    ├── uberepo.json          # manifest: the registered repository URLs
    ├── source/<name>/        # canonical clone of each repo — DON'T work here
    └── tasks/<task>/<name>/  # per-task worktree of each repo, on branch task/<task>

- `source/<name>/` is the shared base clone. Never edit, commit, branch, or run
  raw `git` in it.
- `tasks/<task>/<name>/` is where you work. If your CWD is under `tasks/<task>/`,
  you are already in a task worktree — commit there.
- One task = one branch (`task/<task>`) across every repo. Switch tasks by
  switching directories, not by `git checkout`.

## Discover state (machine-readable)

Re-read state before you report on it; don't scrape human-formatted text.

| Command | Returns |
| --- | --- |
| `uberepo sources --json` | Registered repos + whether each is cloned. |
| `uberepo status --json` | Open tasks; each worktree's branch + clean/dirty. |

Drop `--json` for a human-readable table. If `uberepo` isn't on `PATH`, it's
being run from source — check the workspace `README`.

## Task lifecycle

### `uberepo open <task>` — start a task

Creates the `tasks/<task>/<name>/` worktree and the `task/<task>` branch in every
cloned repo, off each clone's current HEAD.

- `--from <ref>` — base the branches off `<ref>` instead of current HEAD.
- Idempotent: re-running skips repos already opened and picks up repos cloned
  since the first run.

### Work — edit, commit, push (per repo)

Edit inside `tasks/<task>/<name>/`. **uberepo does NOT commit or push for you** —
`git add`/`commit`/`push` inside each repo's worktree. Follow that repo's own
`AGENTS.md`/`README` for its build, test, and commit conventions.

### `uberepo sync <task>` — rebase onto fresh upstreams

Fetches and rebases each worktree onto its repo's fresh default branch.

- `--from <ref>` — rebase onto `<ref>` instead of the default branch.
- **Refuses to start if any worktree is dirty** — commit or stash first.
- **Stops on conflict**: leaves that repo mid-rebase. Resolve it in that
  worktree (`git add` the resolved files, `git rebase --continue`), then re-run
  `uberepo sync <task>` to carry on with the remaining repos.

### `uberepo close <task>` — finish a task

Removes the worktrees and deletes the `task/<task>` branch in every repo.

- **Refuses any repo with uncommitted OR unmerged work.** Push your branches
  first.
- `--force` — skip the refusal. Only when you are certain the work is saved or
  pushed; this can drop commits.

## The task note — `ubertask.yml`

`open` seeds `tasks/<task>/ubertask.yml`: a per-task handoff note carrying the
durable context git can't regenerate — the goal, related links, deliberate
decisions, and known blockers. git holds the live state (what changed, what's
done, what's left); the note holds the *why*. It's gitignored and dies with the
task on `close`.

### Schema

    # ubertask.yml — durable task note. The "why"; git holds the "what".
    goal: |
      Kill the SSO redirect loop — users bounce /login ↔ /callback
    tickets:
      - https://acme.atlassian.net/browse/PROJ-1234
    decisions:
      - note: |
          keep /v1 alive — mobile still rides it
        repo: api
    blockers:
      - note: |
          dev server needs api on :8080 first or /callback 502s
        repo: web

- `goal` — one-line `|` block: what done looks like and why. Always set it.
- `tickets` — list of URLs (issue, PR, doc, thread).
- `decisions` / `blockers` — lists of `{ note: |, repo? }`. `note` is a `|` literal
  block (free text — colons, `#`, slashes need no quoting). `repo:` is optional —
  a `source/<name>` when the item is about one repo; omit it for cross-cutting items.

### Keep it honest

- **Resuming:** read the note for standing context, then reconcile against
  `git status`/`git diff`. It's a hint, not truth — reality wins; fix the note
  when they disagree.
- **Working:** set `goal` on `open`; append a `decision`/`blocker` the moment it
  lands, tagging `repo:` when it's repo-specific.
- **Don't store what git knows** — no progress, next-steps, changed files, or
  dates. `uberepo status` surfaces the note's freshness from its mtime.

## Set up / share a workspace

| Command | Effect |
| --- | --- |
| `uberepo init [name]` | Create a new workspace (manifest + agent files). |
| `uberepo add <url>...` | Register one or more repos in one call. |
| `uberepo remove <url>` | Unregister a repo. |
| `uberepo clone` | Clone every registered repo into `source/<name>` (skips ones already cloned). |
| `uberepo pull` | Fast-forward every cloned repo in `source/` to its origin (skips dirty or diverged repos). |

- `add`/`remove` match repos by host/owner/repo identity, so any URL form works.
  Don't hand-edit `uberepo.json` — use these.
- **Sharing:** commit `uberepo.json` (the stamped `.gitignore` keeps `source/`
  and `tasks/` out of git). A colleague clones the workspace repo and runs
  `uberepo clone` to rehydrate every registered repo into `source/`.

## Cleanup

- `uberepo prune` — preview tasks whose branches are fully merged.
- `uberepo prune --force` — remove those merged tasks.

## Refusal recovery (quick map)

| Refusal | Cause | Fix |
| --- | --- | --- |
| `sync` won't start | a worktree is dirty | commit or stash in that worktree, re-run |
| `sync` stopped mid-run | rebase conflict | resolve in the worktree, `git rebase --continue`, re-run `sync` |
| `close` refused | uncommitted/unmerged work | commit + push, then re-run; `--force` only if the work is truly saved |
| `prune` skipped a task | branch not fully merged | merge/push first, or leave it; `--force` removes regardless |
