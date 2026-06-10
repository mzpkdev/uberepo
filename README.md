<p align="center">
  <strong>uberepo</strong><br>
  One workspace for all your repos. Built for local dev.
</p>

<p align="center">
  Every repo clones into one place; every <em>task</em> gets its own set of git worktrees — so you work across repos at once and switch tasks without <code>git checkout</code> thrash.
</p>

---

## The idea

Real work rarely fits in one repo. A single change touches the API, the web app, maybe a shared library — and the moment you want to jump to a second task, `git checkout` forces you to stash, rebuild, and lose your place in every repo at once.

uberepo gives each task its own worktree in every repo. Open a task and you get a clean branch (`task/<name>`) checked out across the whole workspace, side by side with whatever else you have open. Switch tasks by switching directories, not branches. Nothing gets stashed; nothing gets clobbered.

```text
tasks/login-bug/   →  api, web, ... all on  task/login-bug
tasks/new-billing/ →  api, web, ... all on  task/new-billing
```

Both open at the same time. No checkout in sight.

## Install

uberepo isn't published to npm — clone it and run it from source (it executes directly via `tsx`, so there's no build step).

```bash
# Clone with the cmdore submodule (vendored in lib/)
git clone --recurse-submodules https://github.com/mzpkdev/uberepo
cd uberepo

# Install dependencies
npm install

# Run it (any of these work)
npm run dev -- <command>     # e.g. npm run dev -- init
node bin/uberepo.mjs <command>

# Or put `uberepo` on your PATH for the lifecycle below
npm link
```

Already cloned without `--recurse-submodules`? Populate `lib/` first with `git submodule update --init`, then `npm install`.

## Quickstart

A full task lifecycle, start to finish:

```bash
# 1. Create the workspace manifest (uberepo.json) in the current directory
uberepo init

# 2. Register a couple of repositories (SSH or HTTPS — your choice)
uberepo add git@github.com:acme/api.git
uberepo add https://github.com/acme/web

# 3. Clone everything registered into source/
uberepo clone

# 4. Open a task — a worktree on branch task/login-bug in every repo
uberepo open login-bug

#    ...edit, commit, and push inside tasks/login-bug/api, tasks/login-bug/web...

# 5. See what's open and which worktrees are dirty
uberepo status

# 6. Pull the latest main into the task and rebase your work onto it
uberepo sync login-bug

# 7. Done? Remove the task's worktrees and delete its branch
uberepo close login-bug

# 8. Periodically sweep merged-and-clean tasks (preview, then apply)
uberepo prune
uberepo prune --force
```

## Commands

| Command | Arguments / flags | What it does |
| --- | --- | --- |
| `init` | `[name]` `[--no-agents]` | Create the workspace manifest. With a name, creates `<name>/uberepo.json`; without, uses the current directory. Also seeds `AGENTS.md` + `CLAUDE.md` to brief AI agents on the workspace (`--no-agents` to skip; never overwrites an existing one). |
| `add` | `<repository>` | Register a repo URL. Validates and normalizes the URL; detects duplicates by identity, so SSH and HTTPS forms of the same repo never double-add. |
| `remove` | `<repository>` | Unregister a repo, matched by that same identity — any URL form works. |
| `sources` | — | List registered repositories and whether each is cloned into `source/`. |
| `clone` | — | Clone every registered repo into `source/<name>`. Skips already-cloned repos; fails fast on a missing credential instead of hanging on an auth prompt. |
| `status` | `[task]` | Show open tasks and each worktree's branch and clean/dirty state. Optional task filter. |
| `open` | `<task>` `[--from <ref>]` | Create the task's worktree (branch `task/<task>`) in every cloned repo, branched off each clone's current `HEAD` or `--from <ref>`. Idempotent. |
| `close` | `<task>` `[--force]` | Remove the task's worktrees and delete its branch. Skips any repo with uncommitted or unmerged work unless `--force`; closes the safe ones and reports the rest. |
| `sync` | `<task>` `[--from <ref>]` | Fetch and rebase each of the task's worktrees onto the repo's fresh remote default branch, or `--from <ref>`. Stops at the first conflict for you to resolve. |
| `prune` | `[--force]` | Find tasks whose branches are fully merged and clean. Previews them by default; removes worktrees and branches with `--force`. |

`--from` is aliased `-b`; `--force` is aliased `-f`. Any command accepts `--json` for machine-readable output.

## Workspace layout

`init` writes a manifest; `clone` and `open` build the tree around it:

```text
<workspace>/
├── uberepo.json          # the manifest: { "repositories": [...] }
├── source/
│   ├── api               # each repo cloned flat as source/<name>
│   └── web
└── tasks/
    └── <task>/           # one worktree set per task
        ├── api           # on branch  task/<task>
        └── web
```

The manifest is plain JSON:

```json
{
    "repositories": [
        "git@github.com:acme/api.git",
        "https://github.com/acme/web"
    ]
}
```

Commands work from anywhere inside the workspace — uberepo walks up from the current directory to find `uberepo.json`.

## How it works

- **Flat sources.** Each repo clones to `source/<name>`, where `<name>` is the last path segment of its URL. `clone` refuses to start if two different repos would collide on the same folder.
- **Identity-based dedupe.** `add` and `remove` compare repos by host, owner, and name — not by literal string — so `git@github.com:acme/api.git` and `https://github.com/acme/api` are recognized as the same repo.
- **Worktree per task.** `open` creates `tasks/<task>/<name>` as a git worktree on branch `task/<task>` in every cloned repo. Reopening is idempotent and doubles as the recovery path after a partial run. `status` reads the truth from git's own worktree registry, not from stray directories.
- **Safe by default.** `close` and `prune` won't touch a repo with uncommitted or unmerged work unless you pass `--force`. `sync` refuses to run if any of the task's worktrees is dirty, and stops at the first rebase conflict rather than charging ahead.

## Built with

- [cmdore](https://github.com/mzpkdev/cmdore) — a TypeScript CLI framework, vendored in `lib/` as a git submodule.
- TypeScript on Node, run directly through [`tsx`](https://github.com/privatenumber/tsx) — no build step.
- Tested with [Vitest](https://vitest.dev) (`npm test`); linted and formatted with [Biome](https://biomejs.dev) (`npm run lint`, `npm run format`); type-checked with `npm run typecheck`.
