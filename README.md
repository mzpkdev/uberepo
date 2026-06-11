<p align="center">
  <img src=".github/assets/banner.svg" alt="überepo — switch tasks, not branches" width="100%">
</p>

<p align="center">
  A multi-repo workspace where one task owns one branch in <i>every</i> repo —<br>
  and every command speaks JSON, so your coding agent can drive it too.
</p>

---

## The problem with five repos

Marketing rebranded. "Acme" is now "Akko" — new logo, new name, same Tuesday. The old name lives in the web app, the API's email templates, the shared types, and two services that stamp it on invoices and notifications. One rename. Five repos. So you start the dance:

```text
cd api      && git checkout -b big-rename
cd ../web   && git checkout -b big-rename
cd ../types && git checkout -b big-rename
cd ../svc-a && git checkout -b big-rename
cd ../svc-b && git checkout -b big-rename
```

Then a "quick fix" lands on `main` and you do the whole thing again in reverse, stashing as you go.  
Which repo am I on? Did I push `types`? One stray `git checkout` and you're committing to `main` like an animal.

Here's the mismatch: **a branch is a per-repo idea. Your task isn't.**  
Your task is "ship the rebrand" — it doesn't care that it happens to touch five repositories.

## So überepo flips it

One task = one branch in **every** repo, each in its own git worktree:

```bash
uberepo open big-rename
```

That's the five checkouts. One command.  
Every repo gets a `task/big-rename` branch living in its own directory under `tasks/big-rename/`.  
You switch tasks by changing folders — not by checkout-dancing across repos. Your `main` checkout never moves, because worktrees don't stomp on each other.

On disk, a task is just a folder:

```text
my-workspace/
├── uberepo.json                    # the manifest: which repos, which hooks
├── source/                         # one canonical clone per repo
│   ├── api/
│   └── web/
└── tasks/
    └── big-rename/                 # one task...
        ├── ubertask.yml            # ...its handoff note
        ├── api/                    # ...and a worktree per repo, on task/big-rename
        └── web/
```

Tasks are first-class. Repos are just the participants.

## Why not a monorepo?

Sometimes you can't have one — separate ownership, separate CI, separate deploy cadences, an open-source upstream you don't control.  
Submodules and meta-repos bolt the repos together, but you're still branch-dancing inside each one.  
überepo doesn't ask you to move anything: the repos you're stuck with stay where they are, each keeping its own conventions and its own PR flow.

If you *can* merge everything into a monorepo, do that. überepo is for when you can't.

## Quickstart

```bash
npm install -g uberepo
```

```bash
# ── once ──────────────────────────────────────────

# 1. carve out a workspace
uberepo init my-workspace && cd my-workspace

# 2. tell it which repos play (list as many as you want)
#    (the GitHub org is still acme — nobody ever renames the org)
uberepo add https://github.com/acme/api.git https://github.com/acme/web.git

# 3. clone them all into source/
uberepo clone

# ── every task ────────────────────────────────────

# 4. open a task — branch + worktree in every repo, in one shot
uberepo open big-rename --goal "Acme → Akko. Every string, every logo, every invoice."

# 5. do the work. überepo does NOT commit or push for you — edit and
#    commit inside each worktree, following that repo's own conventions:
#       tasks/big-rename/api/
#       tasks/big-rename/web/

# 6. rebase the whole task onto fresh upstreams
uberepo sync big-rename

# 7. push every branch + open a draft PR per repo (needs the gh CLI)
uberepo ship big-rename --title "Acme → Akko"

# 8. once the PRs merge, tear it all down
uberepo close big-rename
```

The loop, end to end:

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

**Every command speaks JSON.** Add `--json` to anything and get structured output instead of pretty text. No scraping terminal strings, no regex against human prose.

```bash
uberepo status --json
```

```json
[
  {
    "name": "big-rename",
    "repos": [
      { "name": "api", "branch": "task/big-rename", "dirty": false },
      { "name": "web", "branch": "task/big-rename", "dirty": true }
    ],
    "note": {
      "goal": "Acme → Akko. Every string, every logo, every invoice.",
      "repos": ["api", "web"],
      "tickets": [],
      "decisions": [],
      "blockers": []
    }
  }
]
```

**Tasks carry handoff notes.** Every task gets a `tasks/<task>/ubertask.yml` — the durable context git can't show you: the goal, which repos are in scope, ticket links, decisions made, what's blocked. One agent session writes it; the next one — or you, on Monday morning — reads it and knows exactly where things stand.

```yaml
# ubertask.yml — durable task note. The "why"; git holds the "what".
goal: |
  Acme → Akko. Every string, every logo, every invoice.

repos:
  - api
  - web

tickets:
  - https://example.com/ACME-1234

decisions:
  - note: |
      The database stays acme_prod. We are not renaming the database. Ever.
    repo: api

blockers: []
```

**Runs are idempotent and resumable.** `open`, `clone`, and `ship` skip what's already done and pick up where they left off. An agent can re-run a command after a crash and not make a mess.

**It ships its own playbook.** `uberepo init` stamps a `using-uberepo` skill into the workspace so Claude Code and other agents know the entire lifecycle without you explaining it. (Pass `--no-agents` to skip that.)

## Commands

**Set up the workspace**

| Command | What it does |
| --- | --- |
| `uberepo init [<name>] [--no-agents]` | Create a workspace. `--no-agents` skips the agent skill files. |
| `uberepo add <repo>...` | Register one or more repository URLs. |
| `uberepo remove <repo>` | Unregister a repository. |
| `uberepo sources` | List registered repos and their clone status. |
| `uberepo clone` | Clone every registered repo into `source/`. Idempotent. |
| `uberepo pull` | Fast-forward all source clones (skips dirty ones). |

**Run a task**

| Command | What it does |
| --- | --- |
| `uberepo open <task>` | Branch + worktree in every repo. Takes `--goal`, `--repos`, `--from`. |
| `uberepo status [<task>]` | Show open tasks, their branches, and clean/dirty state. |
| `uberepo sync <task>` | Rebase the task's worktrees onto fresh upstreams. |
| `uberepo ship <task>` | Push every branch and open a draft PR per repo (needs `gh`). |
| `uberepo close <task>` | Remove the worktrees and delete the task branch. |
| `uberepo prune` | Remove merged-and-clean tasks. Previews by default; `--force` to commit. |

Every command accepts `--json`. Commands that run hooks (`clone`, `open`, `sync`) accept `--no-hooks`.

## How it works

No daemon. No database. No lock file. State lives in git (branches + worktrees), in `uberepo.json` (the manifest), and in `ubertask.yml` (the task note). überepo itself is a thin, opinionated layer over `git worktree`:

- **Worktrees do the heavy lifting.** Each task branch is a real `git worktree` checkout. überepo lists open tasks by reading git's own worktree registry — delete a worktree directory and the task simply vanishes from `status`. Nothing to desync.
- **Hooks handle the setup grind.** Wire `post-clone`, `post-open`, and `post-sync` commands into `uberepo.json` and überepo fires them per repo with `UBEREPO_TASK` and `UBEREPO_REPO_*` in the environment — `npm install`, copy a `.env`, whatever each repo needs to come alive.
- **It never commits for you.** überepo moves branches and worktrees around. The commits and pushes are yours (or your agent's), following each repo's conventions. It's a coordinator, not a backseat driver.

---

Requires git ≥ 2.5 (when worktrees landed). The `gh` CLI is needed only for `ship`.  
Licensed [MIT](LICENSE) © Mateusz Pietrzak.
