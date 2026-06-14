# uberepo reference

Full command + flag detail for the `using-uberepo` skill. Load this when you
need the exact flags, the conflict/refusal recovery steps, or the sharing flow.
`uberepo --help` (and `uberepo <command> --help`) is the live source of truth —
prefer it if this file and the CLI ever disagree.

## Workspace layout

    <workspace>/
    ├── uberepo.json          # manifest: the registered repos, hooks, carry
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
| `uberepo diff <task> --json` | The task's footprint per repo: commits ahead of the origin default + diffstat. |
| `uberepo context <task> --json` | Everything to resume the task: the note + diff's per-repo footprint + PR state per branch. |

Drop `--json` for a human-readable table. If `uberepo` isn't on `PATH`, it's
being run from source — check the workspace `README`.

`--json` is a global flag on **every** command, not just the ones above — pass it
to any command to get a single stable JSON object describing its outcome (and no
human lines). See [JSON output](#json-output) for the full per-command schema.

### `uberepo diff <task>` — the task's footprint

Read-only report, per repo in the task's scope: the `task/<task>` branch, the
commits it carries beyond the merge-base with the comparison base (full sha +
subject, newest first), and the diffstat over that same range. The base is
resolved exactly like `sync`'s default rebase target — origin's default branch
(`origin/HEAD`, e.g. `origin/main`) — but **nothing is fetched**: the comparison
is against the last-fetched upstream state. A repo with no worktree or a
vanished task branch is reported as `skipped` with a reason, never an error,
and no hooks fire (it's not a lifecycle op). A `dirty` flag marks a worktree
with uncommitted changes — **those changes are NOT in the numbers**; commit
them to see them counted.

### `uberepo context <task>` — the resume-a-task handoff

One read-only blob of everything a fresh session needs to pick the task up:
the parsed note (goal / tickets / decisions / blockers + freshness), `diff`'s
per-repo footprint (branch, commits ahead, diffstat, dirty), and each branch's
PR state. Human mode prints a small **markdown document** — built to be piped
or pasted (Slack handoff, PR cover) — with empty sections omitted; `--json` is
the same data structured. PR state comes from `gh pr view`, run in each repo's
worktree: no `gh` on PATH → every PR field is silently omitted (no flag — the
degradation is automatic); a branch without a PR shows `no PR` (JSON: `pr`
absent); any `gh` error reads as no-PR, never an abort. Like `diff`: nothing
is fetched, no hooks fire, and a repo that can't be read is `skipped` with a
reason.

## Task lifecycle

### `uberepo open <task>` — start a task

Creates the `tasks/<task>/<name>/` worktree and the `task/<task>` branch in every
cloned repo, off each clone's current HEAD.

- `--from <ref>` — base the branches off `<ref>` instead of current HEAD.
- `--goal "<text>"` — set the task note's `goal` (creates/updates `ubertask.yml`).
- `--repos <name>...` — **ADDITIVE scope; it only ever grows, never narrows.**
  On a brand-new task it sets the initial scope (only the named repos get
  worktrees) and records it as the note's `repos:`. On a re-open the supplied
  names are unioned into the stored scope, never replacing it. An unscoped task
  (`repos: []` = every cloned repo, the maximal set) CANNOT be narrowed: naming
  `--repos` on it leaves it unscoped and simply clones+opens any named repo not
  already present, never stranding the worktrees it already owns. Omit `--repos`
  to leave the scope unchanged. No `--repos` ever = unscoped.
- **Named repos clone on demand.** A repo explicitly asked for (named by
  `--repos` now, or stored in the note's `repos:` on a re-open) that is
  registered but not yet cloned is cloned into `source/<name>` first — its
  `pre-clone`/`post-clone` hooks fire exactly as under `uberepo clone` — then
  opened like any other repo. ONLY explicitly named repos do this; an unscoped
  open with no `--repos` never clones anything. A failed on-demand clone is
  reported for that repo, the run continues with the rest, and the command exits
  non-zero at the end (re-running retries it). A `--repos` name that isn't
  registered at all is an error.
- Idempotent: re-running skips repos already opened and picks up repos cloned
  since the first run.
- If `uberepo.json` declares [carry](#carry--local-files-into-worktrees)
  patterns, matching untracked local files (`.env` and friends) are copied
  from `source/<name>` into each fresh worktree, before its `post-open` hook.

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
- `--check` — a conflict **forecast**: fetch (the one ref update), then predict
  each repo's rebase with `git merge-tree` — no rebase, no hooks, no carry, no
  worktree mutation. Per repo: `current` (the target is already contained —
  sync would no-op), `clean` (rebase likely clean), `conflicts` (+ the likely
  conflicted files), `dirty` (uncommitted changes — the real sync would refuse;
  `--check` never refuses, it flags the repo and keeps forecasting the rest),
  `skipped` (+ reason). It's a forecast, not a promise: merge-tree merges the
  two tips in one step while a real rebase replays commits one-by-one, so a
  multi-commit branch can differ. Exits 0 even when conflicts are forecast.
  Needs git >= 2.38.

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
  `open --repos` writes it and only ever GROWS it (additive — it never narrows an
  existing scope); `sync`/`close`/`prune` act only on these repos and warn about a
  worktree outside the scope. Empty (`repos: []`) = unscoped (every cloned repo)
  and stays empty — an unscoped task can't be narrowed by `--repos`. This is the
  task's scope — distinct from a decision/blocker item's `repo:`.
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

Run a shell command in each repo around every uberepo git op — install deps
after a clone, gate a push on the tests, clean up after a close. Declared in
`uberepo.json` as a `hooks` map of event → command **string** (a command line
run through the shell, so any interpreter works: `npm ci`, `bash x.sh`,
`python3 y.py`, an inline one-liner).

    {
      "repositories": ["git@github.com:acme/api.git"],
      "hooks": {
        "post-open": "npm install",
        "pre-ship":  "npm test"
      }
    }

Every lifecycle command has a **pre** and a **post** event (ten total). Each
fires **per repo**, and **only for repos that did the work** — never a skipped
one (already cloned, already open, dirty, nothing to ship).

- **pre-\* GATES the op:** a non-zero exit skips that repo (the op never runs),
  the run continues with the other repos, and the command exits non-zero. Fix
  the cause and re-run — the skipped repos are picked up. A failed `pre-close`
  leaves the worktree and branch standing.
- **post-\* reports:** fires right after the op succeeds; a non-zero exit is
  logged and flips the exit code, but nothing is rolled back.

| Event | Around | cwd |
| --- | --- | --- |
| `pre-clone` | a repo's fresh clone | workspace root (`UBEREPO_REPO_PATH` = the would-be `source/<name>`) |
| `post-clone` | after the clone lands | `source/<name>/` |
| `pre-open` | a new task worktree | `source/<name>/` (`UBEREPO_REPO_PATH` = the would-be worktree) |
| `post-open` | after the worktree lands | `tasks/<task>/<name>/` |
| `pre-sync` | a worktree's rebase | `tasks/<task>/<name>/` |
| `post-sync` | after a clean rebase | `tasks/<task>/<name>/` |
| `pre-ship` | a repo's push + PR | `tasks/<task>/<name>/` |
| `post-ship` | after push (and PR unless `--no-pr`) | `tasks/<task>/<name>/` |
| `pre-close` | a worktree's teardown | `tasks/<task>/<name>/` |
| `post-close` | after worktree + branch are gone | `source/<name>/` (`UBEREPO_REPO_PATH` = the removed worktree) |

The clone events fire wherever a clone actually happens — `uberepo clone`, or
an `open` cloning a scoped repo on demand — always with the same cwd and the
task-free env below.

An unknown event key is a config error (listing the valid events). A manifest
with no `hooks` key behaves exactly as before — hooks are entirely opt-in.

**Environment** — every hook inherits the parent environment plus:

| Var | Value |
| --- | --- |
| `UBEREPO_EVENT` | the event name (one of the ten above) |
| `UBEREPO_WORKSPACE` | absolute workspace root |
| `UBEREPO_REPO` | the repo's flat `source/<name>` name |
| `UBEREPO_REPO_PATH` | absolute path of the dir the event is about (usually the cwd; see table) |
| `UBEREPO_REPO_URL` | the repo's registered clone URL |
| `UBEREPO_TASK` | the task name (empty for the clone events) |
| `UBEREPO_BRANCH` | `task/<task>` (empty for the clone events) |
| `UBEREPO_PR_URL` | the PR's URL in `post-ship` once created/found; empty otherwise (incl. `--no-pr`) |

- **cwd gotcha:** a hook runs with its cwd set to the dir in the table, not the
  workspace root. Anchor any script path with `$UBEREPO_WORKSPACE`, not a bare
  relative path.
- **Failure:** a non-zero exit is logged, the run **continues** to the next
  repo, and the command exits non-zero with a summary. pre-* failure = that
  repo's op never ran (re-run picks it up); post-* failure = the op stands.
- **Kill switch:** pass `--no-hooks` (on `clone`/`open`/`sync`/`ship`/`close`),
  or set the `UBEREPO_NO_HOOKS` env var, to skip every hook for that run.

## Carry — local files into worktrees

A fresh worktree has only tracked files, so untracked local config (`.env`,
override files, certs) stays behind in `source/<name>`. The top-level `carry`
field in `uberepo.json` names the untracked files to copy into task worktrees.
It's an array (global — every repo carries it) **or** an object keyed by repo
name (per repo), never both; omit it and nothing is carried. A per-repo key
matching no registered repo is warned about. `repositories` is a plain list of
URL strings.

    {
      "repositories": [
        "git@github.com:acme/api.git",
        "git@github.com:acme/web.git"
      ],
      "carry": { "api": [".env*"], "web": ["certs/*.pem"] }
    }

- Patterns are relative to the repo root and anchored there; `*`/`?` don't
  cross `/`, `**` does (`**/.env*` = any depth). Dotfiles match normally.
- Only files git does NOT track (untracked + ignored) are copied; a pattern
  matching a tracked file is warned about and skipped, never copied.
- **Never overwrites**: a file already in the worktree is kept (your in-task
  edits win), so carry is idempotent.
- `open` carries into each fresh worktree **before its `post-open` hook**;
  `sync` re-carries (missing files only) **before `post-sync`** — hooks can
  rely on the files being there. `close` warns (warn-only, never blocks) when
  a carried file was modified in the task: those edits die with the worktree,
  so copy anything valuable out first.
- Carry gitignored files. A carried file that is NOT ignored counts as
  untracked work in the worktree — it will trip `sync`'s dirty refusal and
  `close`'s uncommitted-changes guard like any hand-made file.

## Set up / share a workspace

| Command | Effect |
| --- | --- |
| `uberepo init [name]` | Create a new workspace (manifest + agent files). |
| `uberepo add <url>...` | Register one or more repos in one call. |
| `uberepo remove <url>` | Unregister a repo. |
| `uberepo clone [--repos <name>...]` | Clone every registered repo into `source/<name>` (skips ones already cloned); `--repos` clones only the named ones (an unknown name is an error). |
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
| `clone` | `{ repos: [{ name, status: "cloned" \| "skipped" \| "failed", reason?, error? }], hooks: [{ event, repo, exit }] }` — fail-fast: at most one `failed` (last entry), then the command exits non-zero; `reason` (skip): `"pre-clone hook failed"`; `hooks` lists every hook that ran (pre and post); with `--repos <name>...` the same shape, just only the named repos |
| `pull` | `{ repos: [{ name, status: "updated" \| "current" \| "skipped", reason? }] }` — `reason`: `"not cloned"`, `"uncommitted changes"`, `"can't fast-forward"` |
| `status` | `[{ name, repos: [{ name, branch?, dirty }], note? }]` |
| `diff` | `{ task, base, repos: [{ name, branch, ahead, dirty, files, insertions, deletions, commits: [{ sha, subject }], status: "ok" \| "skipped", reason? }] }` — `base` is the resolved comparison ref (e.g. `origin/main`; `""` if never resolved); an `ok` repo carries the numbers (`commits` newest first, full `sha`; `dirty` = uncommitted changes, NOT counted in the numbers); a `skipped` repo carries only `name`, `branch`, `reason`: `"no worktree"`, `"branch missing"`, `"cannot resolve origin's default branch"` |
| `context` | `{ task, base, note?, repos: [{ name, branch, ahead, dirty, files, insertions, deletions, commits: [{ sha, subject }], pr?: { number, url, draft, state }, status: "ok" \| "skipped", reason? }] }` — `diff`'s footprint per repo (same fields, same skip reasons) plus `pr` when `gh` knows a PR for the branch (`draft` bool; `state`: gh's `OPEN`/`CLOSED`/`MERGED`); `pr` absent when the branch has no PR or `gh` is missing/failed (automatic degradation, never an error); `note` is the full task note (see below), omitted when the task has none |
| `open` | `{ task, scope: string[], repos: [{ name, status: "created" \| "skipped", reason? }], clone: [{ name, status: "cloned" \| "skipped" \| "failed", reason?, error? }], hooks: [{ event, repo, exit }], carry: [{ repo, copied, keptExisting, skippedTracked }], note? }` — `reason` (skip): `"pre-open hook failed"`, `"pre-clone hook failed"`, `"clone failed"`, `"not registered"`; `clone` has one entry per scoped repo cloned on demand this run (same entry shape as `clone`'s repos; a `failed` entry means that repo got no worktree, the run continued, and the exit code is non-zero); `hooks` lists every hook that ran (pre and post, the clone events included); `carry` has one entry per fresh worktree in a repo with carry patterns (`copied`/`keptExisting`/`skippedTracked`: string[] of repo-relative paths); `note` is the full task note (see below); absent only when nothing is cloned |
| `sync` | `{ task, onto, repos: [{ name, status: "rebased" \| "conflict" \| "skipped", reason? }], hooks: [{ event, repo, exit }], carry: [{ repo, copied, keptExisting, skippedTracked }] }` — `reason`: `"uncommitted changes"`, `"not reached"`, `"cannot resolve origin's default branch"`, `"pre-sync hook failed"`; `onto` is `""` if it bailed before resolving; `hooks` lists every hook that ran (pre and post); `carry` has one entry per cleanly-rebased repo with carry patterns |
| `sync --check` | `{ task, onto, check: true, repos: [{ name, status: "clean" \| "conflicts" \| "current" \| "dirty" \| "skipped", files?, reason? }] }` — a forecast: nothing was rebased, no hooks/carry keys; `files` (string[]) lists the likely-conflicted paths when merge-tree hit conflicts (also present on a `dirty` repo whose committed tips would conflict); `reason`: `"no worktree"`, `"branch missing"`, `"cannot resolve origin's default branch"`, or the per-repo error; exits 0 even when conflicts are forecast |
| `ship` | `{ task, base, repos: [{ name, branch, pushed: bool, pr?: { number, url, action: "created" \| "updated" }, status: "shipped" \| "skipped" \| "failed", reason?, error? }], hooks: [{ event, repo, exit }] }` — `reason` (skip): `"nothing to ship"`, `"uncommitted changes"`, `"cannot resolve base — pass --base <ref>"`, `"pre-ship hook failed"`; `error` set when `status` is `"failed"` (push/`gh` failure); `pr` present unless `--no-pr`; `action` is `"updated"` when the PR already existed (push-only, not edited); exits non-zero if any repo `failed` |
| `close` | `{ task, forced: bool, repos: [{ name, status: "closed" \| "skipped", reason? }], hooks: [{ event, repo, exit }], carry: [{ repo, modified }] }` — `reason`: `"uncommitted changes"`, `"unmerged commits"`, `"pre-close hook failed"`; `carry` lists carried files modified inside the task (warn-only — their edits are lost with the worktree) |
| `prune` | `{ forced: bool, tasks: [{ task, status: "pruned" \| "kept", reason? }] }` — `reason`: `"dirty"`, `"unmerged"`, or the failure message; when `forced` is false a `"pruned"` status means a preview candidate (nothing removed yet) |

The `note` object (in `status` and `open`) is the parsed `ubertask.yml` plus its
mtime: `{ goal, repos, tickets, decisions, blockers, mtime }`, where `decisions`
and `blockers` are `{ note, repo? }[]` and `mtime` is epoch-ms. It is omitted
when the task has no note file.
