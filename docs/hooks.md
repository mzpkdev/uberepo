# Hooks

Hooks run a shell command in every repo, around each git operation uberepo
performs there. They cover the per-repo setup and checks you'd otherwise do by
hand: installing dependencies, copying an untracked config, running the tests
before a push. (For the plain copy-local-config-into-worktrees case there is a
declarative alternative: [carry](carry.md), which runs before the `post-open`
and `post-sync` hooks so they can rely on the files being in place.)

## The `hooks` block

Declare hooks in `uberepo.json` as an object mapping an event name to one
command string. The map is global: the same command runs for every repo, and
there is no per-repo form. A value that isn't a string is rejected at config
read, as is an event name outside the ten below. Any subset of events is
fine, and a manifest without a `hooks` key runs no hooks at all.

```json
{
    "repositories": [
        "https://github.com/acme/api.git",
        "https://github.com/acme/web.git"
    ],
    "hooks": {
        "post-open": "npm install",
        "pre-ship": "npm test"
    }
}
```

## Events

Every lifecycle command has a pre and a post hook. A `pre-*` hook gates the
operation: a non-zero exit skips that repo (the operation never runs), the run
continues with the other repos, and the command exits non-zero. Fix the cause
and re-run; the skipped repos get picked up. A `post-*` hook fires after the
operation succeeds: a non-zero exit is logged and flips the exit code, but
nothing is undone. Hooks fire only for repos whose operation actually runs; a
repo the command itself skips (already cloned, already open, dirty, nothing to
ship) fires neither.

| Event | Fires | cwd |
| --- | --- | --- |
| `pre-clone` | before `uberepo clone` clones a repo | workspace root; `UBEREPO_REPO_PATH` names the would-be `source/<name>` |
| `post-clone` | after a fresh clone lands | `source/<name>` |
| `pre-open` | before `uberepo open` creates a worktree | `source/<name>`; `UBEREPO_REPO_PATH` names the would-be worktree |
| `post-open` | after a new worktree lands | `tasks/<task>/<name>` |
| `pre-sync` | before `uberepo sync` rebases a worktree | `tasks/<task>/<name>` |
| `post-sync` | after a clean rebase | `tasks/<task>/<name>` |
| `pre-ship` | before `uberepo ship` pushes a repo | `tasks/<task>/<name>` |
| `post-ship` | after the push and PR step succeed | `tasks/<task>/<name>` |
| `pre-close` | before `uberepo close` removes a worktree; a failure leaves it standing | `tasks/<task>/<name>` |
| `post-close` | after the worktree and branch are gone | `source/<name>`; `UBEREPO_REPO_PATH` still names the removed worktree |

## Environment

A hook inherits the full parent environment plus these variables:

| Variable | Value |
| --- | --- |
| `UBEREPO_EVENT` | the event name |
| `UBEREPO_TASK` | the task name (empty string for the clone events) |
| `UBEREPO_REPO` | the participant the event is about — the bare repo (`api`), or the `repo@alias` token when the repo carries an aliased branch in this task ([multi-branch](#a-repo-with-several-branches-in-one-task)) |
| `UBEREPO_REPO_PATH` | absolute path of the directory the event is about (usually also the cwd; see the table) |
| `UBEREPO_REPO_URL` | the repo's registered clone URL (resolved from the bare repo, so all of a repo's aliased participants share it) |
| `UBEREPO_BRANCH` | the participant's task branch — `task/<task>` by default, `task/<task>@<alias>` for an aliased participant, or the adopted / `--branch` name when one was set (empty string for the clone events) |
| `UBEREPO_WORKSPACE` | absolute path of the workspace root |
| `UBEREPO_PR_URL` | the PR's URL in `post-ship` once one is created or found; empty everywhere else, including under `--no-pr` |

The task-scoped variables are empty strings rather than unset, so a script can
read them without guarding.

### A repo with several branches in one task

A task can carry more than one branch in the *same* repo — two PRs out of `api`,
say — by giving each an alias with `@`: `uberepo open my-task --repos api@auth
api@cache`. Each `repo@alias` participant is its own worktree
(`tasks/<task>/api@auth`, flat — one level), on its own branch
(`task/<task>@auth`), and the hook fires once per participant. For those hooks
`UBEREPO_REPO` is the full `api@auth` token and `UBEREPO_BRANCH` is
`task/<task>@auth`, while `UBEREPO_REPO_URL` (and the `source/api` clone they all
branch from) still resolves from the bare repo. A bare `api` with no alias is
unchanged: `UBEREPO_REPO=api`, `UBEREPO_BRANCH=task/<task>`.

## Execution

The command runs through the platform shell (`sh -c` on POSIX, `cmd` on
Windows), so pipes and `$UBEREPO_*` expansion work as usual. Anchor any script
path with `$UBEREPO_WORKSPACE` instead of assuming the cwd.

Repos run one at a time, in order, and each repo's hook finishes before the
next repo starts. A failing `post-*` hook doesn't abort the run and doesn't
roll anything back, since the operation it followed already succeeded. A
failing `pre-*` hook skips only its own repo. Either way uberepo logs the
failure, continues with the remaining repos, and exits non-zero at the end.
With `--json` the hook's own output is suppressed and its exit code lands in
the `hooks` array of the command's JSON result.

To skip hooks for a single run, pass `--no-hooks` (accepted by all five
lifecycle commands) or set `UBEREPO_NO_HOOKS` to any non-empty value.

## Recipes

Dependencies in every fresh worktree:

```json
{ "hooks": { "post-open": "npm install" } }
```

A gitignored `.env`, copied into each base clone:

```json
{ "hooks": { "post-clone": "cp $UBEREPO_WORKSPACE/.env.shared .env" } }
```

The verify gate. Your test suite runs in every repo before anything is pushed;
a failing suite skips that repo's push and PR, and the ship exits non-zero:

```json
{ "hooks": { "pre-ship": "npm test" } }
```

The same command on `post-sync` runs it after every rebase instead, if you'd
rather hear about breakage right when it lands.

Every lifecycle command has a pre and a post hook; the ten events above are
the whole matrix.
