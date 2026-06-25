---
name: boot-uberepo
description: One-time setup for a fresh uberepo workspace — fill in AGENTS.md from the cloned repos and wire the hooks that bootstrap each task worktree. Run explicitly via /boot-uberepo.
user-invocable: true
disable-model-invocation: true
---

# Boot a uberepo workspace

One-time configuration for a fresh workspace, run by hand via `/boot-uberepo`. You
inspect the repos in `source/`, write the workspace `AGENTS.md`, and wire the hooks
that make every future `uberepo open` land a ready-to-run worktree — then strip the
unconfigured banner so this never needs running again. You do NOT open tasks, commit,
or push; once booted, the `using-uberepo` skill drives the task lifecycle.

## Before you start

- Run only on a workspace still carrying the `UBEREPO:UNCONFIGURED` marker in
  `AGENTS.md`. If it's gone, the workspace is already configured — don't redo it; at
  most refresh one section the user names.
- `uberepo sources --json` for the registered repos and their clone state. Note up
  front if `gh` is missing (`ship` needs it later) or git is older than 2.5.
- No `AGENTS.md` at all (workspace was `init --no-agents`)? Wire the hooks/carry and
  skip the fill.

## Steps

1. **Get the repos on disk** — you can't inspect what isn't in `source/`.
   - Nothing registered → ask the user for the repo URLs, then `uberepo add <url>...`.
   - Registered but not cloned → `uberepo clone` (idempotent).

2. **Inspect each `source/<repo>`** (read the key files, don't slurp whole trees):
   - `README*` → one line on what it is.
   - Package manifest + lockfile → the stack and the install / dev / test commands
     (`package.json` + `package-lock`/`pnpm-lock`/`yarn.lock`, `pyproject.toml`/
     `requirements.txt`, `go.mod`, `Cargo.toml`, `Gemfile`, …). A repo's CI
     (`.github/workflows/*`) is the most reliable source for the real commands —
     prefer it over a guess.
   - `.env.example` / `.env.sample` → the env the app needs (step 4).
   - `Dockerfile` / `compose` → service ports and bring-up.
   - Cross-repo: note where one manifest depends on a sibling's published package —
     that's a real edge for Architecture.

3. **Fill the three `AGENTS.md` sections**, replacing each section's HTML-comment
   prompt with content and deleting the comment:
   - **Repositories** — one row per repo: what it is.
   - **Tooling** — Bootstrap / Dev / Test per repo, from inspection (CI wins on a conflict).
   - **Architecture** — the cross-repo wiring no single clone shows. Write the edges
     you confirmed from manifests, then **ask the user** for what you can't infer: who
     calls whom at runtime and over what (REST, queue, shared DB), who owns each
     contract, the bring-up order. A diagram or a few lines — don't invent edges.

4. **Wire the bootstrap hooks + carry** into `uberepo.json`. This is the part of the
   manifest you hand-edit — `repositories` still goes through `add`/`remove`. The
   `hooks` map is **global: one command string runs in every repo's worktree.**
   - **Install on `post-open`**, so every fresh worktree has its deps. Uniform stack →
     the plain command (`npm ci`, `pnpm install`, `pip install -r requirements.txt`, …).
     Mixed stack → no single tool's command fits, so write a committed
     `.uberepo/hooks/post-open.sh` that dispatches on the files present in the worktree
     (`[ -f package.json ] && npm ci; [ -f go.mod ] && go mod download; …`) and wire
     `"post-open": "sh \"$UBEREPO_WORKSPACE/.uberepo/hooks/post-open.sh\""`. (POSIX /
     Git-Bash; a native-Windows `cmd` workspace needs a `.cmd` variant.)
   - **Carry the local env** — if any repo ships a `.env.example`, add a `carry` entry
     (`[".env"]`, or the per-repo object form if the names differ) so the gitignored
     `.env` follows into every worktree. Carry copies an *existing untracked* file, it
     won't create one — so in the same pass, list the keys from each `.env.example` and
     have the user drop a real `source/<repo>/.env`; carry propagates it from there.
   - **Test gate on `pre-ship` — propose, don't auto-wire.** Offer `pre-ship: <test>`
     (a failing suite blocks that repo's push); wire it only on a yes, since it changes
     whether `ship` is allowed. Same global-command rule as install.
   - Auto-wire install + carry, then **show the resulting `hooks`/`carry` block** so
     the user sees exactly what landed.

5. **(Optional) Smoke-test the wiring** — open a throwaway task on one repo
   (`uberepo open _bootcheck --repos <repo>`), confirm `post-open` installed cleanly,
   then `uberepo close _bootcheck --force` and remove any leftover `tasks/_bootcheck/`.
   Proves the bootstrap fires instead of hoping.

6. **Strip the banner** — once the sections are actually filled, remove the
   `UBEREPO:UNCONFIGURED` comment and the `> [!IMPORTANT]` banner from `AGENTS.md`.
   That's what makes boot one-and-done.

7. **Hand off** — point the user at `uberepo open <task>` (driven by the
   `using-uberepo` skill) for their first task.

## What to return

A short summary: the repos configured, that `AGENTS.md`'s three sections are filled,
the `hooks`/`carry` block you wrote (verbatim), any `.env` keys the user still has to
fill in `source/<repo>`, and the next step. If you were blocked — no repos registered —
say exactly what's needed (`uberepo add <url>...`), never a bare "couldn't continue".
Full hook and carry semantics live in the `using-uberepo` skill's `reference.md`.
