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

`--json` is a global flag on **every** command, not just the two above — pass it
to any command to get a single stable JSON object describing its outcome (and no
human lines). See [JSON output](#json-output) for the full per-command schema.

## Task lifecycle

### `uberepo open <task>` — start a task

Creates the `tasks/<task>/<name>/` worktree and the `task/<task>` branch in every
cloned repo, off each clone's current HEAD.

- `--from <ref>` — base the branches off `<ref>` instead of current HEAD.
- `--goal "<text>"` — set the task note's `goal` (creates/updates `ubertask.yml`).
- `--repos <name>...` — scope the task to these repos (their `source/<name>`):
  only they get worktrees, and the set is recorded as the note's `repos:`. On
  re-open, supplied names are unioned into the stored scope, never replacing it;
  omit `--repos` to leave the scope unchanged. No `--repos` ever = unscoped (every
  cloned repo).
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

### `uberepo ship <task>` — push + open a draft PR per repo

Pushes each repo's `task/<task>` branch and opens a **draft** pull request for it.
One PR per repo; nothing is merged.

- **Requires the GitHub CLI** (`gh`) unless `--no-pr`: install https://cli.github.com
  then `gh auth login`. ship shells out to `gh` (it does not call the API), running
  it in each repo's worktree so `gh` infers the repo from its origin. Without `gh`
  (and not `--no-pr`) it errors and does nothing.
- **Draft is always on.** PRs open as drafts; mark them ready in the GitHub UI.
- `--repos <name>...` — ship only this subset of the task's repos. A **transient
  filter** for this run: it does NOT change the note's `repos:` scope. A name not in
  the task is an error.
- `--title <text>` — PR title for every PR this run. Otherwise the title resolves:
  `--title` → the note's `goal` (first line) → the task name (never titleless).
- `--body <text>` / `--body-file <path>` — PR body for every PR this run (mutually
  exclusive). Otherwise the body is the repo's `.github` PR template, else empty.
  The template is looked up case-insensitively as `pull_request_template.md` in
  `.github/`, the repo root, or `docs/` (a multi-template `PULL_REQUEST_TEMPLATE/`
  directory is ignored). `gh` does NOT auto-apply templates, so ship reads the file
  and passes it as the body. **Nothing else is appended to the body.**
- `--base <ref>` — base branch for the PRs (default: each repo's remote default,
  e.g. `main`).
- `--no-pr` — push only; skip every `gh` call. The one mode that needs no `gh`.
- `--force` — push with `--force-with-lease` (needed after a `sync`/rebase diverges
  the already-pushed branch). The default push is plain and refuses a diverged push
  with a "did you sync? re-run with --force" hint.

Per repo: a branch with no commits ahead of base is **skipped** (an empty PR is
rejected); a dirty worktree is **skipped** (`uncommitted changes`); otherwise the
branch is pushed and, unless `--no-pr`, a draft PR is **created**. **Idempotent
re-run:** if a PR already exists for the branch, ship just pushes (the PR
auto-reflects the new commits) and **leaves the existing PR's title and body
untouched** — it never clobbers human edits. A push/`gh` failure in one repo is
reported and the run continues to the rest, then exits non-zero.

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
    repos:
      - api
      - web
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
- `repos` — the task's declared **scope**: the `source/<name>` repos it owns.
  `open --repos` writes it; `sync`/`close`/`prune` act only on these repos and warn
  about a worktree outside the scope. Empty (`repos: []`) = unscoped (every cloned
  repo). This is the task's scope — distinct from a decision/blocker item's `repo:`.
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

## Lifecycle hooks

Run a shell command in each repo right after a uberepo git op lands — e.g. install
deps after a clone, relink after a sync. Declared in `uberepo.json` as a `hooks` map
of event → command **string** (a command line run through the shell, so any
interpreter works: `npm ci`, `bash x.sh`, `python3 y.py`, an inline one-liner).

    {
      "repositories": ["git@github.com:acme/api.git"],
      "hooks": {
        "post-clone": "npm ci",
        "post-open":  "bash $UBEREPO_WORKSPACE/.uberepo/setup.sh",
        "post-sync":  "python3 $UBEREPO_WORKSPACE/.uberepo/relink.py"
      }
    }

The three valid events (each fires **per repo**, right after that repo's git op
*succeeds*, and **only for repos that did the work** — never a skipped one):

| Event | Fires after | cwd |
| --- | --- | --- |
| `post-clone` | a repo is freshly cloned | `source/<name>/` |
| `post-open` | a task worktree is newly created | `tasks/<task>/<name>/` |
| `post-sync` | a task worktree is cleanly rebased | `tasks/<task>/<name>/` |

An unknown event key is a config error (listing the valid events). A manifest with
no `hooks` key behaves exactly as before — hooks are entirely opt-in.

**Environment** — every hook inherits the parent environment plus:

| Var | Value |
| --- | --- |
| `UBEREPO_EVENT` | the event name (`post-clone` / `post-open` / `post-sync`) |
| `UBEREPO_WORKSPACE` | absolute workspace root |
| `UBEREPO_REPO` | the repo's flat `source/<name>` name |
| `UBEREPO_REPO_PATH` | absolute path of the repo/worktree (also the cwd) |
| `UBEREPO_REPO_URL` | the repo's registered clone URL |
| `UBEREPO_TASK` | the task name (empty for `post-clone`) |
| `UBEREPO_BRANCH` | `task/<task>` (empty for `post-clone`) |

- **cwd gotcha:** a hook runs with its cwd set to the **repo/worktree**, not the
  workspace root. Anchor any script path with `$UBEREPO_WORKSPACE` (as above), not a
  bare relative path.
- **Failure:** a non-zero hook exit is logged and the run **continues** to the next
  repo; the command then exits non-zero with a summary. The git op is never rolled
  back — the clone/worktree is already valid, so just fix the cause and re-run.
- **Kill switch:** pass `--no-hooks` (on `clone`/`open`/`sync`), or set the
  `UBEREPO_NO_HOOKS` env var, to skip every hook for that run.

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

## JSON output

Pass `--json` to any command for one JSON object describing its outcome — no
human lines. Stable, additive contract; parse this instead of scraping text.
Optional keys (`reason`, `error`, `note`) are omitted when they don't apply.

| Command | JSON shape |
| --- | --- |
| `init` | `{ workspace, created: true, agents: bool }` |
| `add` | `{ added: string[], skipped: string[] }` — `added` = flat names added; `skipped` = URLs already registered |
| `remove` | `{ removed: string[], notFound: string[] }` — each the normalized host/owner/repo key |
| `sources` | `[{ name, url, cloned }]` |
| `clone` | `{ repos: [{ name, status: "cloned" \| "skipped" \| "failed", error? }], hooks: [{ event, repo, exit }] }` — fail-fast: at most one `failed` (last entry), then the command exits non-zero; `hooks` has one entry per freshly-cloned repo whose `post-clone` ran |
| `pull` | `{ repos: [{ name, status: "updated" \| "current" \| "skipped", reason? }] }` — `reason`: `"not cloned"`, `"uncommitted changes"`, `"can't fast-forward"` |
| `status` | `[{ name, repos: [{ name, branch?, dirty }], note? }]` |
| `open` | `{ task, scope: string[], repos: [{ name, status: "created" \| "skipped" }], hooks: [{ event, repo, exit }], note? }` — `hooks` has one entry per newly-created worktree whose `post-open` ran; `note` is the full task note (see below); absent only when nothing is cloned |
| `sync` | `{ task, onto, repos: [{ name, status: "rebased" \| "conflict" \| "skipped", reason? }], hooks: [{ event, repo, exit }] }` — `reason`: `"uncommitted changes"`, `"not reached"`, `"cannot resolve origin's default branch"`; `onto` is `""` if it bailed before resolving; `hooks` has one entry per cleanly-rebased repo whose `post-sync` ran |
| `ship` | `{ task, base, repos: [{ name, branch, pushed: bool, pr?: { number, url, action: "created" \| "updated" }, status: "shipped" \| "skipped" \| "failed", reason?, error? }] }` — `reason` (skip): `"nothing to ship"`, `"uncommitted changes"`, `"cannot resolve base — pass --base <ref>"`; `error` set when `status` is `"failed"` (push/`gh` failure); `pr` present unless `--no-pr`; `action` is `"updated"` when the PR already existed (push-only, not edited); exits non-zero if any repo `failed` |
| `close` | `{ task, forced: bool, repos: [{ name, status: "closed" \| "skipped", reason? }] }` — `reason`: `"uncommitted changes"`, `"unmerged commits"` |
| `prune` | `{ forced: bool, tasks: [{ task, status: "pruned" \| "kept", reason? }] }` — `reason`: `"dirty"`, `"unmerged"`, or the failure message; when `forced` is false a `"pruned"` status means a preview candidate (nothing removed yet) |

The `note` object (in `status` and `open`) is the parsed `ubertask.yml` plus its
mtime: `{ goal, repos, tickets, decisions, blockers, mtime }`, where `decisions`
and `blockers` are `{ note, repo? }[]` and `mtime` is epoch-ms. It is omitted
when the task has no note file.
