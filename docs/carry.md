# Carry

A fresh worktree contains only tracked files. The untracked local config a
repo needs to boot — `.env`, `docker-compose.override.yml`, a local cert —
stays behind in `source/<name>`, so a just-opened task worktree can't run the
app. Carry copies the untracked files you name from each repo's source clone
into its task worktrees, automatically, on `open` and `sync`.

## The `carry` patterns

Declare glob patterns in `uberepo.json`, at the workspace level (applies to
every repo), per repo (an entry can be a `{ "url", "carry" }` object instead
of a bare URL string), or both — a repo's effective set is the union of the
two. Patterns must be non-empty strings; anything else is rejected at config
read.

```json
{
    "repositories": [
        "https://github.com/acme/api.git",
        {
            "url": "https://github.com/acme/web.git",
            "carry": ["certs/*.pem"]
        }
    ],
    "carry": [".env*", "config/local.json"]
}
```

Patterns are matched against paths relative to the repo root, anchored there:
`.env*` matches only root-level `.env` files, `certs/*.pem` only directly
inside `certs/`. `*` and `?` never cross a `/`; `**` does (`**/.env*` carries
`.env` files at any depth). Dotfiles need no special casing — `config/*`
matches `config/.secret`.

## What is (and isn't) copied

- **Only files git does NOT track**: the union of the source clone's untracked
  and ignored files. A pattern that matches a *tracked* file (say `.env*`
  catching a committed `.env.example`) is warned about and skipped — the
  worktree already checked that file out, and copying would stomp it.
- **Never over an existing file.** A match that already exists in the worktree
  is left untouched and counted as kept, not an error. That makes carry
  idempotent: re-running is a missing-files-only repair and your in-task edits
  always win.
- Relative paths are preserved (parent directories are created as needed), and
  so is the file mode — a `0600` key stays `0600`.

Carry copies; it never symlinks. The worktree gets its own bytes, so editing a
carried file in a task never mutates the copy in `source/<name>`.

## When it runs

- **`open`** carries into each *newly created* worktree, after the worktree
  lands and **before its [`post-open` hook](hooks.md) fires** — a hook like
  `npm ci && npm run db:migrate` can rely on the `.env` being in place. An
  already-open (skipped) worktree is not re-carried.
- **`sync`** re-runs carry for each cleanly rebased worktree, again before its
  `post-sync` hook. With the never-overwrite rule this only fills in files the
  worktree is missing — a file added to `source/<name>` after `open`, or one
  you deleted in the task.
- **`close`** copies nothing, but before removing each worktree it compares
  the carried files against their source copies; any whose bytes differ —
  normally because you edited them inside the task — are listed in a warning
  ("modified in this task; changes will be lost"). It's warn-only — close proceeds, because these files were never
  git's to protect. Copy anything you care about back by hand first.

Carry isn't a hook: `--no-hooks` doesn't skip it. To stop carrying, remove the
patterns from `uberepo.json`.

Under `--json`, `open` and `sync` report a `carry` array with one
`{ repo, copied, keptExisting, skippedTracked }` entry per repo carry ran in —
a freshly created worktree on `open`, a cleanly rebased one on `sync` — and
`close` reports `{ repo, modified }` entries for repos with divergent carried
files.

## Carry gitignored files

Carry is built for files your `.gitignore` already excludes. A carried file
that is *not* ignored shows up as untracked in the worktree, and from there
git treats it like any hand-made change: `sync` refuses to start on it and
`close` calls it uncommitted work. Ignored files (the usual `.env` case) trip
neither.

## Carry vs. a hook

`post-open: "cp $UBEREPO_WORKSPACE/.env.shared .env"` still works, and is the
right tool when the file needs templating or per-task values. Carry is the
declarative version of the plain-copy case: per-repo file sets, tracked-file
protection, no-overwrite semantics, and the close-time loss warning come free.
