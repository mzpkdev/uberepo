# uberepo reference

Full command + flag detail for the `using-uberepo` skill. Load this when you
need the exact flags, the conflict/refusal recovery steps, or the sharing flow.
`uberepo --help` (and `uberepo <command> --help`) is the live source of truth —
prefer it if this file and the CLI ever disagree.

## Workspace layout

    <workspace>/
    ├── uberepo.json          # manifest: the registered repos, hooks, carry
    ├── source/<repo>/        # canonical clone of each repo — DON'T work here
    └── tasks/<task>/<name>/  # per-task worktree, on branch task/<task> (or task/<task>@<alias>)

- `source/<repo>/` is the shared base clone. Never edit, commit, branch, or run
  raw `git` in it.
- `tasks/<task>/<name>/` is where you work. `<name>` is the **participant**: a bare
  repo (`web`, branch `task/<task>`) or a `repo@alias` token (`web@auth`, branch
  `task/<task>@auth`) when one repo carries several branches in the task. The folder
  is flat one level either way, and all of a repo's participants share its one
  `source/<repo>` clone. Under `tasks/<task>/`, you're already in a worktree — commit there.
- One task = one branch per participant: `task/<task>` for a plain repo, an extra
  `repo@alias` participant for another branch in the same repo. Switch by switching
  directories, not by `git checkout`.

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
them to see them counted. A **stacked** participant ([`--stack`](#uberepo-open-task--start-a-task))
is compared against its **parent's branch**, not the repo default, so its
ahead-count/diffstat are its own commits beyond the sibling it sits on; the
human output nests it under its parent in a `└─` tree, and `--json` carries the
edge as `parent`/`base` per entry.

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
reason — and a **stacked** child is measured against its parent's branch, nested
under it in the markdown (and carrying `parent`/`base` in `--json`), exactly as
`diff` does.

## Task lifecycle

### `uberepo open <task>` — start a task

Creates the `tasks/<task>/<name>/` worktree and the `task/<task>` branch in every
cloned repo, off each clone's current HEAD.

- `--from <ref>` — base the branches off `<ref>` instead of current HEAD.
- `--branch <repo>=<name>` (repeatable; a bare `--branch <name>` applies to every
  repo in scope) names the branch instead of `task/<task>`. If that branch already
  exists (local **or** `origin/<name>`) uberepo **adopts** it — the worktree attaches
  to the existing branch (an origin-only branch becomes a local tracking branch)
  rather than creating one; otherwise it's created normally. Adopted branches are
  recorded in the note's [`branches:`](#schema) map, and `close`/`prune` **keep**
  them (they remove the worktree but never delete an adopted branch — it's a real
  branch, usually with an open PR). uberepo also reads an adopted branch's **base**
  from its PR (`gh pr view`), so `sync`/`diff`/`ship` use that base (e.g. for a
  stacked branch) instead of the repo default. Unset → `task/<task>`. Mixing the two
  forms, or naming a repo outside the task's scope, is an error.
- `--goal "<text>"` — set the task note's `goal` (creates/updates `ubertask.yml`).
- `--repos <name>...` — **ADDITIVE scope; it only ever grows, never narrows.**
  On a brand-new task it sets the initial scope (only the named repos get
  worktrees) and records it as the note's `repos:`. On a re-open the supplied
  names are unioned into the stored scope, never replacing it. An unscoped task
  (`repos: []` = every cloned repo, the maximal set) CANNOT be narrowed: naming
  `--repos` on it leaves it unscoped and simply clones+opens any named repo not
  already present, never stranding the worktrees it already owns. Omit `--repos`
  to leave the scope unchanged. No `--repos` ever = unscoped.
- **`repo@alias` — several branches in one repo.** A `--repos` entry (and a `repos:`
  note entry) is `repo` or `repo@alias`. The same repo may appear several times with
  different aliases; each is its own **participant** — its own worktree
  (`tasks/<task>/repo@alias/`, flat) and branch (`task/<task>@alias`) — and they all
  share the one `source/<repo>` clone. Bare `repo` is unchanged (`task/<task>`). A
  repo or alias name may not contain `@`, `:`, or glob chars (`[ ] * ?`), be a Windows
  reserved name (`con`/`prn`/`aux`/`nul`/`com1`–`9`/`lpt1`–`9`), or end in a dot or
  space; participants must be unique case-insensitively.
- **`--stack <child>=<parent>` — stack one branch on a sibling.** Repeatable. Records
  the **child** participant's [`branches:`](#schema) `base` as the **parent**
  participant token (`--stack web@logos=web@strings` → `web@logos`'s base is
  `web@strings`) — a *stack edge*, a sibling reference rather than a remote ref. From
  then on `ship` opens the child's PR against the parent's branch and `sync` rebases
  the child onto the freshly-moved parent (see those commands). An explicit `--stack`
  **overrides** a PR-discovered base for that participant. Both ends must be in the
  task's scope and the **same repo** (a branch can only stack on a sibling of its own
  repo), and the edges must stay **acyclic** — a parent outside scope, a cross-repo
  pairing, or a cycle is rejected up front with the offending edge named (fix it with
  `--repos`/the right token, or drop the `--stack`). A participant with no `--stack`
  is an ordinary root.
- **Named repos clone on demand.** A repo explicitly asked for (named by
  `--repos` now, or stored in the note's `repos:` on a re-open) that is
  registered but not yet cloned is cloned into `source/<repo>` first — its
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
  from `source/<repo>` into each fresh worktree, before its `post-open` hook.

### Work — edit, commit, push (per repo)

Edit inside `tasks/<task>/<name>/`. **uberepo does NOT commit or push for you** —
`git add`/`commit`/`push` inside each repo's worktree. Follow that repo's own
`AGENTS.md`/`README` for its build, test, and commit conventions.

### `uberepo exec <task> -- <cmd>...` — run a command in every worktree

Runs one command in each of the task's worktrees, in turn — `npm test`, a lint
script, a codemod — so one invocation drives the whole task's repos instead of
`cd`-ing through each. uberepo runs the command; what it does is yours to own.

- **`--` is required**, and splits uberepo's own flags from the command —
  everything after it is the command, run verbatim. `uberepo exec <task> --json
  -- npm test --watch`: `--json` is uberepo's, `npm test --watch` is the command.
- **No shell.** The command runs as a bare program + arguments (the way uberepo
  runs `git`), not through `sh` — so `;`, `|`, `&&`, and globs are literal args,
  not operators. Need a shell? Run `... -- sh -c "<line>"`.
- `--repos <name>...` — run only in this subset. A **transient filter** for this
  run (it does NOT change the note's `repos:` scope); a name not in the task is an
  error. Like `ship`, an in-scope repo with no worktree simply doesn't take part.
- `--bail` — stop at the first repo whose command exits non-zero. Default: run
  every repo and report each.
- Each command inherits the same `UBEREPO_*` env a hook gets (`UBEREPO_TASK`,
  `UBEREPO_REPO`, `UBEREPO_REPO_PATH`, `UBEREPO_REPO_URL`, `UBEREPO_BRANCH`,
  `UBEREPO_WORKSPACE`) — minus the hook-only `UBEREPO_EVENT`/`UBEREPO_PR_URL`.
- Runs **sequentially** in scope order. A non-zero exit in any repo flips exec's
  own exit code (so a wrapper/CI sees it) but the run continues unless `--bail`.
  Human mode streams each repo's output live under a `▸ <repo>  $ <cmd>` header;
  `--json` captures per-repo `stdout`/`stderr`/`exitCode` and prints no live output.
  Not a lifecycle op: no hooks, no carry, no fetch.

### `uberepo sync <task>` — rebase onto fresh upstreams

Fetches and rebases each worktree onto its repo's fresh default branch.

- `--from <ref>` — rebase onto `<ref>` instead of the default branch.
- **Refuses to start if any worktree is dirty** — commit or stash first.
- **Stacks rebase bottom-up.** A [stacked](#uberepo-open-task--start-a-task)
  participant doesn't rebase onto the repo default — it rebases onto its
  **parent's** freshly-moved branch, and sync walks the per-repo stack forest
  **topologically** (every parent before its children) so a rebase ripples up
  the stack without flattening it. A repo with no commits ahead (already
  restacked / up-to-date) is reported `current`. If an ancestor's rebase
  conflicts (or is otherwise not reached), its descendants are pruned with
  `"parent not synced"` — fix the parent, then re-run to carry the stack the
  rest of the way.
- **A conflict isolates — it doesn't halt the run**: the conflicting repo is
  left mid-rebase and its stacked descendants are pruned (`"parent not synced"`),
  but every other repo and independent root in the same run still rebases.
  Resolve it in that worktree (`git add` the resolved files, `git rebase
  --continue`, or `git rebase --abort` to back out), then re-run `uberepo sync
  <task>` to finish the conflicted branch and carry its stack the rest of the way.
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

### `uberepo ship <task>` — push + open a draft PR per branch

Pushes each participant's branch and opens a **draft** pull request for it. One PR
per branch — a repo with several participants gets several PRs, grouped under it and
sharing its base discovery and PR-template lookup; nothing is merged.

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
  e.g. `main`). A [stacked](#uberepo-open-task--start-a-task) child ignores this:
  its PR always targets its **parent's branch** (e.g. `task/<task>@strings`), and
  ship pushes the **parents first** so the base exists. A child whose parent isn't
  on the remote yet is **skipped** with `parent <token> not on remote — ship it
  first` — ship the parent, then re-run.
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

Removes every participant's worktree and deletes its branch in every repo — a repo
with several participants loses all of them, but the shared `source/<repo>` clone
stays and an adopted branch is never deleted.

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
    branches:
      api:
        name: fix/sso-loop
        adopted: true
        base: develop
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
- `repos` — the task's declared **scope**: the participants it owns, each a bare repo
  or a `repo@alias` token (`source/<repo>` is the shared clone behind it).
  `open --repos` writes it and only ever GROWS it (additive — it never narrows an
  existing scope); `sync`/`close`/`prune` act only on these repos and warn about a
  worktree outside the scope. Empty (`repos: []`) = unscoped (every cloned repo)
  and stays empty — an unscoped task can't be narrowed by `--repos`. This is the
  task's scope — distinct from a decision/blocker item's `repo:`.
- `branches` — branch overrides, keyed by the **participant token** (`web` or
  `web@auth`): each entry is `{ name, adopted, base? }`. A participant on its default
  branch — `task/<task>` (bare) or `task/<task>@<alias>` (aliased) — records nothing
  and resolves by default; an entry appears only when adoption or `--branch` deviates
  from it. `adopted: true` marks a pre-existing branch uberepo attached to rather
  than created — `close`/`prune` keep it; `base` is its rebase/PR target, auto-filled
  from the branch's PR for adopted branches, else the repo default. `base` may also
  name **another participant token** in the task (`web@logos`'s `base: web@strings`) —
  a **stack edge** written by [`open --stack`](#uberepo-open-task--start-a-task), not a
  remote ref: `ship`/`sync`/`diff`/`context` then target/rebase/compare the participant
  against that sibling's branch instead of a remote default.
- `tickets` — list of URLs (issue, PR, doc, thread).
- `decisions` / `blockers` — lists of `{ note: |, repo? }`. `note` is a `|` literal
  block (free text — colons, `#`, slashes need no quoting). `repo:` is optional —
  a `source/<repo>` when the item is about one repo; omit it for cross-cutting items.

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
| `pre-clone` | a repo's fresh clone | workspace root (`UBEREPO_REPO_PATH` = the would-be `source/<repo>`) |
| `post-clone` | after the clone lands | `source/<repo>/` |
| `pre-open` | a new task worktree | `source/<repo>/` (`UBEREPO_REPO_PATH` = the would-be worktree) |
| `post-open` | after the worktree lands | `tasks/<task>/<name>/` |
| `pre-sync` | a worktree's rebase | `tasks/<task>/<name>/` |
| `post-sync` | after a clean rebase | `tasks/<task>/<name>/` |
| `pre-ship` | a repo's push + PR | `tasks/<task>/<name>/` |
| `post-ship` | after push (and PR unless `--no-pr`) | `tasks/<task>/<name>/` |
| `pre-close` | a worktree's teardown | `tasks/<task>/<name>/` |
| `post-close` | after worktree + branch are gone | `source/<repo>/` (`UBEREPO_REPO_PATH` = the removed worktree) |

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
| `UBEREPO_REPO` | the participant: the bare repo name (`web`), or the `repo@alias` token (`web@auth`) for an aliased worktree |
| `UBEREPO_REPO_PATH` | absolute path of the dir the event is about (usually the cwd; see table) |
| `UBEREPO_REPO_URL` | the repo's registered clone URL |
| `UBEREPO_TASK` | the task name (empty for the clone events) |
| `UBEREPO_BRANCH` | the participant's branch — `task/<task>` (bare) or `task/<task>@<alias>` (aliased) by default, or the adopted / `--branch` name when one was set (empty for the clone events) |
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
override files, certs) stays behind in `source/<repo>`. The top-level `carry`
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
| `uberepo clone [--repos <name>...]` | Clone every registered repo into `source/<repo>` (skips ones already cloned); `--repos` clones only the named ones (an unknown name is an error). |
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
| `sync` stopped mid-run | rebase conflict | resolve in the worktree, `git rebase --continue` (or `--abort`), re-run `sync` |
| `sync` pruned a stacked child | its parent's restack conflicted (`"parent not synced"`) | resolve the parent's conflict, `git rebase --continue`, then re-run `sync` — the child restacks once the parent lands |
| `close` refused | uncommitted/unmerged work | commit + push, then re-run; `--force` only if the work is truly saved |
| `prune` skipped a task | branch not fully merged | merge/push first, or leave it; `--force` removes regardless |

## JSON output

Pass `--json` to any command for one JSON object describing its outcome — no
human lines. Stable, additive contract; parse this instead of scraping text.
Optional keys (`reason`, `error`, `note`) are omitted when they don't apply.

Per-participant `name`/`repo` fields carry the **participant token** — the bare repo
(`web`) or the `repo@alias` form (`web@auth`) — so a repo's several branches stay
distinct in the output.

| Command | JSON shape |
| --- | --- |
| `init` | `{ workspace, created: true, agents: bool }` |
| `add` | `{ added: string[], skipped: string[] }` — `added` = flat names added; `skipped` = URLs already registered |
| `remove` | `{ removed: string[], notFound: string[] }` — each the normalized host/owner/repo key |
| `sources` | `[{ name, url, cloned }]` |
| `clone` | `{ repos: [{ name, status: "cloned" \| "skipped" \| "failed", reason?, error? }], hooks: [{ event, repo, exit }] }` — fail-fast: at most one `failed` (last entry), then the command exits non-zero; `reason` (skip): `"pre-clone hook failed"`; `hooks` lists every hook that ran (pre and post); with `--repos <name>...` the same shape, just only the named repos |
| `pull` | `{ repos: [{ name, status: "updated" \| "current" \| "skipped", reason? }] }` — `reason`: `"not cloned"`, `"uncommitted changes"`, `"can't fast-forward"` |
| `status` | `[{ name, repos: [{ name, branch?, dirty, parent?, base? }], note? }]` — a repo entry gains `parent` (the sibling token its branch stacks on) and `base` (that sibling's branch) only when it's a stacked child; a repo's entries come parent-before-child |
| `diff` | `{ task, base, repos: [{ name, branch, parent?, base, ahead, dirty, files, insertions, deletions, commits: [{ sha, subject }], status: "ok" \| "skipped", reason? }] }` — top-level `base` is the resolved comparison ref (e.g. `origin/main`; `""` if never resolved); each entry's per-row `base` is the ref IT was compared against (a stacked child's parent branch, else the run base), and `parent` (present only on a stacked child) is the sibling token it sits on (entries are ordered parent-before-child); an `ok` repo carries the numbers (`commits` newest first, full `sha`; `dirty` = uncommitted changes, NOT counted in the numbers); a `skipped` repo carries only `name`, `branch`, the per-row `base`/`parent`, and `reason`: `"no worktree"`, `"branch missing"`, `"cannot resolve origin's default branch"` |
| `context` | `{ task, base, note?, repos: [{ name, branch, parent?, base, ahead, dirty, files, insertions, deletions, commits: [{ sha, subject }], pr?: { number, url, draft, state }, status: "ok" \| "skipped", reason? }] }` — `diff`'s footprint per repo (same fields, same per-row `base`/`parent` stack edge, same skip reasons, same parent-before-child order) plus `pr` when `gh` knows a PR for the branch (`draft` bool; `state`: gh's `OPEN`/`CLOSED`/`MERGED`); `pr` absent when the branch has no PR or `gh` is missing/failed (automatic degradation, never an error); `note` is the full task note (see below), omitted when the task has none |
| `open` | `{ task, scope: string[], repos: [{ name, status: "created" \| "skipped", reason? }], clone: [{ name, status: "cloned" \| "skipped" \| "failed", reason?, error? }], hooks: [{ event, repo, exit }], carry: [{ repo, copied, keptExisting, skippedTracked }], note? }` — `reason` (skip): `"pre-open hook failed"`, `"pre-clone hook failed"`, `"clone failed"`, `"not registered"`; `clone` has one entry per scoped repo cloned on demand this run (same entry shape as `clone`'s repos; a `failed` entry means that repo got no worktree, the run continued, and the exit code is non-zero); `hooks` lists every hook that ran (pre and post, the clone events included); `carry` has one entry per fresh worktree in a repo with carry patterns (`copied`/`keptExisting`/`skippedTracked`: string[] of repo-relative paths); `note` is the full task note (see below); absent only when nothing is cloned |
| `exec` | `{ task, command: string[], repos: [{ name, branch, exitCode?, status: "ok" \| "failed" \| "skipped", stdout?, stderr? }] }` — `command` is the argv after `--`; one entry per worktree it ran in, in sequence: `status` is `"ok"` (exit 0) or `"failed"` (non-zero), each carrying the child's `exitCode` and captured `stdout`/`stderr`. Exits non-zero if any repo failed; `--bail` stops after the first. A `skipped` entry (no `exitCode`) is an in-scope repo with no worktree — like `ship`, those normally don't appear at all |
| `sync` | `{ task, onto, repos: [{ name, base?, status: "rebased" \| "current" \| "conflict" \| "skipped", reason? }], hooks: [{ event, repo, exit }], carry: [{ repo, copied, keptExisting, skippedTracked }] }` — `status` adds `current` (already restacked / up-to-date — nothing to rebase); a stacked child carries the per-entry `base` it was rebased onto (its parent's branch); `reason`: `"uncommitted changes"`, `"not reached"`, `"parent not synced"` (a stacked descendant pruned because an ancestor wasn't reached), `"cannot resolve origin's default branch"`, `"pre-sync hook failed"`; entries come parent-before-child; `onto` is `""` if it bailed before resolving; `hooks` lists every hook that ran (pre and post); `carry` has one entry per cleanly-rebased repo with carry patterns |
| `sync --check` | `{ task, onto, check: true, repos: [{ name, status: "clean" \| "conflicts" \| "current" \| "dirty" \| "skipped", files?, reason? }] }` — a forecast: nothing was rebased, no hooks/carry keys; `files` (string[]) lists the likely-conflicted paths when merge-tree hit conflicts (also present on a `dirty` repo whose committed tips would conflict); `reason`: `"no worktree"`, `"branch missing"`, `"cannot resolve origin's default branch"`, or the per-repo error; exits 0 even when conflicts are forecast |
| `ship` | `{ task, base, repos: [{ name, branch, base?, pushed: bool, pr?: { number, url, action: "created" \| "updated" }, status: "shipped" \| "skipped" \| "failed", reason?, error? }], hooks: [{ event, repo, exit }] }` — top-level `base` is the run default; a stacked child carries the per-entry `base` its PR targets (its parent's branch); `reason` (skip): `"nothing to ship"`, `"uncommitted changes"`, `"parent <token> not on remote — ship it first"` (a stacked child whose parent isn't pushed yet), `"cannot resolve base — pass --base <ref>"`, `"pre-ship hook failed"`; `error` set when `status` is `"failed"` (push/`gh` failure); parents are shipped before children; `pr` present unless `--no-pr`; `action` is `"updated"` when the PR already existed (push-only, not edited); exits non-zero if any repo `failed` |
| `close` | `{ task, forced: bool, repos: [{ name, status: "closed" \| "skipped", reason? }], hooks: [{ event, repo, exit }], carry: [{ repo, modified }] }` — `reason`: `"uncommitted changes"`, `"unmerged commits"`, `"pre-close hook failed"`; `carry` lists carried files modified inside the task (warn-only — their edits are lost with the worktree) |
| `prune` | `{ forced: bool, tasks: [{ task, status: "pruned" \| "kept", reason? }] }` — `reason`: `"dirty"`, `"unmerged"`, or the failure message; when `forced` is false a `"pruned"` status means a preview candidate (nothing removed yet) |

The `note` object (in `status` and `open`) is the parsed `ubertask.yml` plus its
mtime: `{ goal, repos, tickets, decisions, blockers, mtime }`, where `decisions`
and `blockers` are `{ note, repo? }[]` and `mtime` is epoch-ms. It is omitted
when the task has no note file.
