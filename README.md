<p align="center"><img src=".github/assets/banner.svg" alt="überepo — switch tasks, not branches" width="100%"></p>
<p align="center">A multi-repo workspace where one task owns one branch in <i>every</i> repo —<br>and every command speaks JSON, so your coding agent can drive it too.</p>

---

## The problem with five repos

Marketing rebranded. "Acme" is now "Akko" — new logo, new name, same Tuesday. The old name lives in five repos. So you start the dance:
```text
cd api      && git checkout -b big-rename
cd ../web   && git checkout -b big-rename
cd ../types && git checkout -b big-rename
cd ../svc-a && git checkout -b big-rename
cd ../svc-b && git checkout -b big-rename
```
Then a "quick fix" lands on `main` and you do the whole dance again in reverse, stashing as you go. One stray `git checkout` and you're committing to `main` like an animal.

Here's the mismatch: **a branch is a per-repo idea. Your task isn't.**  
Your task is "ship the rebrand" — it doesn't care that it happens to touch five repositories.

## So überepo flips it

One task = one branch in **every** repo, each in its own git worktree:
```bash
uberepo open big-rename
```
That's the five checkouts. One command.  
Every repo gets a `task/big-rename` worktree under `tasks/big-rename/`; you switch tasks by changing folders, and your `main` checkout never moves. On disk:
```text
my-workspace/
├── uberepo.json                    # the manifest: which repos, which hooks, what to carry
├── source/                         # one canonical clone per repo
│   ├── api/
│   └── web/
└── tasks/
    └── big-rename/                 # one task...
        ├── ubertask.yml            # ...its handoff note
        ├── api/                    # ...and a worktree per repo, on task/big-rename
        └── web/
```
**Tasks are first-class. Repos are just the participants.**

### More than one branch in a repo

Usually a repo joins a task once, on one branch. When you need two branches in
the *same* repo for one task — two stacked PRs, a fix and a follow-up — give each
an alias with `@`:
```bash
uberepo open big-rename --repos web@strings web@logos api
```
`web` now contributes two participants, each its own worktree and branch, while
`api` stays a plain single-branch participant:
```text
tasks/big-rename/
├── ubertask.yml
├── web@strings/      # branch task/big-rename@strings
├── web@logos/        # branch task/big-rename@logos
└── api/              # branch task/big-rename
```
The `repo@alias` token is the same everywhere — the `--repos` argument, the
branch leaf (`task/big-rename@strings`), and the worktree folder (flat, one level
deep). Both branches push from the one shared `source/web` clone; `ship` opens a
PR per branch, `close` tears down both worktrees and keeps the clone. A bare
`web` (no `@`) is unchanged.

### Stacked PRs

Those two branches are often a *stack*: `logos` builds on `strings`, so its PR
should target `strings`'s branch, not `main`. Declare the edge once, on `open`:
```bash
uberepo open big-rename --stack web@logos=web@strings
```
That records `web@logos`'s base as the sibling `web@strings` in the note (a
stack edge, not a remote ref). From then on the whole lifecycle keeps the stack
honest:
- **`ship`** opens `web@logos`'s PR against `task/big-rename@strings` (the
  parent's branch), and pushes the parent first — a child whose parent isn't on
  the remote yet is skipped with *"parent not on remote — ship it first"*.
- **`sync`** rebases the forest bottom-up — parent first, then each child onto
  its freshly-moved parent — so a rebase upstream ripples through the stack
  without flattening it.
- **`status`/`diff`/`context`** nest the child under its parent in a `└─` tree,
  and `diff`/`context` measure the child's commits against the parent's branch,
  not `main`.

The edge must stay same-repo, in-scope, and acyclic — a cross-repo, out-of-scope,
or cycle-forming `--stack` is rejected when you declare it. A participant with no
`--stack` is an ordinary root, exactly as before.

## Why not a monorepo?

Sometimes you can't merge the repos — separate owners, separate CI, separate deploy cadences — so überepo works with the ones you're stuck with, each keeping its own conventions and PR flow.

**If you *can* merge everything into a monorepo, do that. überepo is for when you can't.**
## Why not just "use worktrees"?

If it's one repo and one session, do exactly that.  
Across five repos it falls apart: every session invents its own branch names and layout, and none of it survives to the next session or the next agent.

überepo is "use worktrees" written down once. A task is one folder with a worktree per repo inside, the handoff note and `status --json` tell a fresh session where things stand, and the chores are commands: `sync` rebases everything, `ship` pushes and opens the PRs, `close` tears it down.

**A `CLAUDE.md` can hold a convention. It can't hold machinery.**
## Quickstart

```bash
npm install -g uberepo
```
```bash
# ── once ──────────────────────────────────────────
# 1. new workspace
uberepo init my-workspace && cd my-workspace
# 2. register repos (yes, the org is still acme)
uberepo add https://github.com/acme/api.git https://github.com/acme/web.git
# 3. clone into source/
uberepo clone

# ── every task ────────────────────────────────────
# 4. branch + worktree in every repo
uberepo open big-rename --goal "Acme → Akko. Every string, every logo, every invoice."
# 5. do the work; commits are yours, in each worktree
# 6. rebase onto fresh upstreams
uberepo sync big-rename
# 7. push + draft PR per repo (needs gh)
uberepo ship big-rename --title "Acme → Akko"
# 8. PRs merged? tear it down
uberepo close big-rename
```
**The loop, end to end:**
```text
  ╭──────╮      ╭──────╮      ╭──────╮      ╭───────╮
  │ open │ ───▶ │ sync │ ───▶ │ ship │ ───▶ │ close │
  ╰──────╯      ╰───▲──╯      ╰──┬───╯      ╰───────╯
                    │            │
                    ╰────────────╯
                  iterate until merged
```
## Built so your agent can drive it

überepo doesn't just tolerate coding agents — it's built for them.
- **Tasks carry handoff notes.** Every task gets `tasks/<task>/ubertask.yml` — goal, scope, tickets, decisions, blockers; one session writes it, the next (or you, on Monday morning) reads it and knows where things stand.
- **One command rehydrates a session.** `uberepo context <task>` replays the whole handoff — the note, each repo's commits-ahead and diffstat, each branch's PR state — as a paste-ready markdown brief, or `--json` for the agent.
- **Runs are idempotent and resumable.** `open`, `clone`, and `ship` skip what's already done — an agent can re-run after a crash and not make a mess.
- **It ships its own playbook.** `uberepo init` stamps a `using-uberepo` skill into the workspace, so agents know the lifecycle without you explaining it. (`--no-agents` skips it.)
- **Every command speaks JSON.** Add `--json` to anything and get structured output instead of pretty text — `uberepo status --json`:
```json
[{
  "name": "big-rename",
  "repos": [{ "name": "api", "branch": "task/big-rename", "dirty": false }],
  "note": { "goal": "Acme → Akko. Every string, every logo, every invoice." }
}]
```
And the handoff note itself, `tasks/big-rename/ubertask.yml` — the "why"; git holds the "what":
```yaml
goal: |
  Acme → Akko. Every string, every logo, every invoice.
repos:
  - api
  - web
branches:
  api:
    name: feat/akko-rename
    adopted: true
    base: develop
tickets:
  - https://example.com/ACME-1234
decisions:
  - note: |
      The database stays acme_prod. We are not renaming the database. Ever.
    repo: api
```
## Commands

**Set up the workspace**

| Command | What it does |
| --- | --- |
| `uberepo init [<name>] [--no-agents]` | Create a workspace. `--no-agents` skips the agent skill files. |
| `uberepo add <repo>...` | Register one or more repository URLs. |
| `uberepo remove <repo>` | Unregister a repository. |
| `uberepo sources` | List registered repos and their clone status. |
| `uberepo clone` | Clone every registered repo into `source/` — or just `--repos <name>...`. Idempotent. |
| `uberepo pull` | Fast-forward all source clones (skips dirty ones). |

**Run a task**

| Command | What it does |
| --- | --- |
| `uberepo open <task>` | Branch + worktree in every repo. Takes `--goal`, `--repos`, `--from`, `--branch`, `--stack`; repos scoped via `--repos` clone on demand. A `--repos repo@alias` token gives one repo a second branch in the task ([below](#more-than-one-branch-in-a-repo)). `--branch <repo>=<name>` (or a bare `--branch <name>` for all repos) **adopts** an existing branch instead of creating `task/<task>` — `close`/`prune` then keep that branch. `--stack <child>=<parent>` stacks one participant's branch on a sibling's, so `ship`/`sync` target and rebase it against the parent ([below](#stacked-prs)). |
| `uberepo status [<task>]` | Show open tasks, their branches, and clean/dirty state. |
| `uberepo diff <task>` | Show the task's footprint: commits ahead + diffstat per repo. |
| `uberepo exec <task> -- <cmd>...` | Run one command inside every one of the task's worktrees. `--repos` narrows it; `--bail` stops at the first failure. Exits non-zero if any repo's command did. |
| `uberepo context <task>` | Everything to resume a task — note, per-repo state, PR state — as a paste-ready markdown brief. |
| `uberepo sync <task>` | Rebase the task's worktrees onto fresh upstreams. `--check` forecasts the conflicts without rebasing. |
| `uberepo ship <task>` | Push every branch and open a draft PR per repo (needs `gh`). |
| `uberepo close <task>` | Remove the worktrees and delete the task branch. |
| `uberepo prune` | Remove merged-and-clean tasks. Previews by default; `--force` to commit. |

Every command accepts `--json`. The lifecycle commands (`clone`, `open`, `sync`, `ship`, `close`) accept `--no-hooks`.
## How it works

No daemon. No database. No lock file. State lives in git (branches + worktrees), in `uberepo.json` (the manifest), and in `ubertask.yml` (the task note). überepo itself is a thin, opinionated layer over `git worktree`:
- **Worktrees do the heavy lifting.** Every task branch is a real `git worktree` checkout — überepo reads git's own registry, so there's nothing to desync.
- **Hooks handle the setup grind.** Wire pre-/post- hooks around every lifecycle command (`clone`, `open`, `sync`, `ship`, `close`) into `uberepo.json`; überepo fires them per repo with `UBEREPO_TASK` and `UBEREPO_REPO_*` in the environment — `npm install`, a `.env`, a test gate before `ship` ([full reference](docs/hooks.md)).
- **Carry brings your local config along.** Fresh worktrees hold only tracked files; list glob patterns under `carry` in `uberepo.json` — one array for every repo, or an object keyed by repo name for per-repo sets — and überepo copies the matching untracked files — `.env`, override files, local certs — from `source/<name>` into every task worktree on `open` and `sync`, never overwriting your in-task edits ([full reference](docs/carry.md)).
- **It never commits for you.** Branches and worktrees are überepo's job; the commits and pushes stay yours (or your agent's). A coordinator, not a backseat driver.

---

Requires git ≥ 2.5 (when worktrees landed). The `gh` CLI is needed only for `ship`.  
Licensed [MIT](LICENSE) © Mateusz Pietrzak.
