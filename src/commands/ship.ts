import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { task } from "@/arguments/task"
import { Config, repositoryUrl, TASKS_DIR } from "@/config"
import {
    currentGh,
    type Gh,
    ghAvailable,
    prCreate,
    prList,
    pullRequestNumber,
    readPrTemplate
} from "@/forge"
import git, { GitError } from "@/git"
import { type HookResult, runHook } from "@/hooks"
import { base } from "@/options/base"
import { body } from "@/options/body"
import { bodyFile } from "@/options/body-file"
import { force } from "@/options/force"
import { noHooks } from "@/options/no-hooks"
import { noPr } from "@/options/no-pr"
import { repos } from "@/options/repos"
import { title } from "@/options/title"
import {
    baseFor,
    branchFor,
    taskParticipants,
    UBERTASK_FILENAME,
    worktreePath
} from "@/tasks"
import * as ubertask from "@/ubertask"
import { normalizeRepository } from "@/url"

// One repo's ship outcome.
//   status: shipped  — pushed and (unless --no-pr) its PR was created or already
//                      existed (an existing PR auto-reflects the new commits)
//           skipped  — nothing to ship (not ahead of base) or dirty
//           failed   — a push or gh call errored (loop continued, exit is non-zero)
//   pushed: whether the branch was pushed this run
//   pr:     present once a PR is known — its number, url, and whether this run
//           created it or it already existed (update == push only, never edited)
//   reason: the skip reason (mirrors the human line)
//   error:  the failure message (mirrors the human line)
type ShipRepo = {
    name: string
    branch: string
    pushed: boolean
    pr?: {
        number: number
        url: string
        action: "created" | "updated"
    }
    status: "shipped" | "skipped" | "failed"
    reason?: string
    error?: string
}

// A participant that passed pre-flight (clean, ahead of base) and is ready to
// push: its flat participant name (`repo` or `repo@alias`), the bare repo it
// belongs to (for the hooks' UBEREPO_REPO_URL), source clone, worktree, the
// branch to push (adopted/--branch, else its default), the gh-facing base
// branch, and the mutable outcome it writes its result into.
type Pending = {
    name: string
    repo: string
    source: string
    dest: string
    branch: string
    ghBase: string
    out: ShipRepo
}

// Write `contents` to a fresh temp file and return its path. gh reads the PR
// body from a file (--body-file) — never inlined — so a body with newlines /
// shell metacharacters is passed verbatim. Caller cleans the file up.
const writeTemp = async (contents: string): Promise<string> => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "uberepo-pr-"))
    const file = path.join(dir, "body.md")
    await fs.promises.writeFile(file, contents)
    return file
}

const removeTemp = async (file: string): Promise<void> => {
    await fs.promises.rm(path.dirname(file), { recursive: true, force: true })
}

// gh's --base wants a branch NAME, but remoteDefault() returns a ref like
// "origin/main". Strip a leading "<remote>/" so the PR targets `main`, not a ref
// gh can't resolve. An explicit --base is passed through untouched.
const ghBaseName = (ref: string): string => ref.replace(/^[^/]+\//, "")

export default defineCommand({
    name: "ship",
    description:
        "Push a task's branches and open a draft pull request per repo",
    arguments: [task],
    options: [repos, title, body, bodyFile, base, noPr, force, noHooks],
    async run(argv) {
        const config = await Config.read()
        const root = await Config.root()
        const run: Gh = currentGh()

        // Registered URL per flat name, so a fired hook can surface it as
        // UBEREPO_REPO_URL (mirrors open's map).
        const urlByName = new Map<string, string>()
        for (const entry of config.repositories) {
            const url = repositoryUrl(entry)
            urlByName.set(normalizeRepository(url).name, url)
        }
        // One entry per hook that actually ran (pre-ship and post-ship, for
        // repos that passed pre-flight — never a skipped one). A non-zero exit
        // is collected and flips the command's exit code at the end without
        // aborting the remaining repos.
        const hooks: HookResult[] = []
        const failedHooks: HookResult[] = []

        // --body and --body-file both override the body; allowing both would be
        // ambiguous. Reject up front (mirrors the design's mutual exclusion).
        if (argv.body !== undefined && argv["body-file"] !== undefined) {
            throw new Error(
                "--body and --body-file are mutually exclusive — pass only one."
            )
        }

        // gh is a hard prerequisite for the PR step. Verify it once up front so
        // ship never pushes a single branch before discovering gh is missing.
        // --no-pr skips every gh call, so it is the one mode that needs no gh.
        if (!argv["no-pr"] && !(await ghAvailable(run))) {
            throw new Error(
                "ship needs the GitHub CLI — https://cli.github.com, then 'gh auth login'"
            )
        }

        // The override body (read --body-file's file now, so a bad path fails
        // before anything is pushed). undefined means "no override" — fall back
        // to each repo's PR template, then empty.
        let overrideBody: string | undefined
        if (argv.body !== undefined) {
            overrideBody = argv.body
        } else if (argv["body-file"] !== undefined) {
            overrideBody = await fs.promises.readFile(argv["body-file"], "utf8")
        }

        // The durable note supplies the task's declared scope (which repos it
        // owns) and the goal (the title fallback). Nothing from the note is
        // injected into the PR body — the body is template-or-override only.
        const notePath = path.join(
            root,
            TASKS_DIR,
            argv.task,
            UBERTASK_FILENAME
        )
        const note = await ubertask.read(notePath)

        // The PR title for every PR this run: --title, else the note goal's
        // first line, else the task name (never titleless).
        const resolvedTitle = argv.title ?? goalTitle(note?.goal) ?? argv.task

        // Universe = the task's declared scope when non-empty, else every
        // PARTICIPANT (bare or aliased) that currently has a worktree for this
        // task. Then ∩ the --repos filter. A repo's several aliased participants
        // are each their own universe entry (each ships its own branch + PR);
        // they SHARE the source clone, base discovery, and PR template via their
        // common repo. participantByName maps a participant back to its
        // source/<repo> + repo for the pre-flight and push loops.
        const scope = note?.repos ?? []
        const participants = taskParticipants(config, root, argv.task)
        const participantByName = new Map(participants.map((p) => [p.name, p]))
        const present = participants.map((p) => p.name)
        const universe =
            scope.length > 0
                ? scope.filter((n) => present.includes(n))
                : present

        // The --repos filter is transient (it does NOT touch the note's scope):
        // it narrows this run to a subset of the universe. A name outside the
        // universe is an error (like open's unknown-name guard) — fail before
        // pushing anything, so a typo never half-ships.
        let targets = universe
        if (argv.repos !== undefined) {
            const filter: string[] = []
            for (const name of argv.repos) {
                if (!universe.includes(name)) {
                    const known = universe.join(", ") || "(none)"
                    throw new Error(
                        `${name} is not a repo in task ${argv.task} — known: ${known}.`
                    )
                }
                if (!filter.includes(name)) {
                    filter.push(name)
                }
            }
            targets = universe.filter((n) => filter.includes(n))
        }

        // The run-level base, reported in the JSON: an explicit --base wins;
        // otherwise it is filled with the first repo's resolved default branch
        // name (by convention the same across repos). Empty until resolved.
        let baseLabel = argv.base ? ghBaseName(argv.base) : ""

        if (targets.length === 0) {
            terminal.json({
                task: argv.task,
                base: baseLabel,
                repos: [],
                hooks: []
            })
            terminal.warn(`Nothing to ship for task ${argv.task}.`)
            return
        }

        // ── Pre-flight per PARTICIPANT: decide skip vs ship. A dirty worktree
        // or a branch not ahead of base is a per-participant skip (never aborts
        // the run). Same-repo participants share source/<repo> and so share base
        // discovery (remoteDefault) and the PR template (read from the worktree,
        // but the template lives in the repo) — they are NOT two independent
        // repos. `participant` carries the source/<repo> + repo for the name.
        const results: ShipRepo[] = []
        const pending: Pending[] = []
        for (const name of targets) {
            const participant = participantByName.get(name)
            // A scope name (note repos:) with no worktree on disk: skip it like
            // a missing participant rather than touching the wrong source dir.
            if (!participant) {
                results.push({
                    name,
                    branch: branchFor(argv.task, name, note?.branches),
                    pushed: false,
                    status: "skipped",
                    reason: "no worktree"
                })
                terminal.log(`${name}: no worktree — skipping`)
                continue
            }
            const source = participant.source
            const dest = worktreePath(root, argv.task, name)
            const repo = git(source)
            const wt = repo.worktree(dest)
            // This participant's branch to push (adopted/--branch, else its
            // default: task/<task> bare, task/<task>@<alias> aliased).
            const branch = branchFor(argv.task, name, note?.branches)

            // Resolve this participant's base: --base wins; then the persisted
            // per-participant base (an adopted branch's PR base — so "ahead"
            // counts against the PR's real target, not a flattened
            // remoteDefault); else its repo's remote default. No base at all →
            // can't compute "ahead", skip.
            const baseRef =
                argv.base ??
                baseFor(name, note?.branches) ??
                (await repo.remoteDefault())
            if (!baseRef) {
                results.push({
                    name,
                    branch,
                    pushed: false,
                    status: "skipped",
                    reason: "cannot resolve base — pass --base <ref>"
                })
                terminal.log(`${name}: cannot resolve base — pass --base <ref>`)
                continue
            }
            if (baseLabel === "") {
                baseLabel = ghBaseName(baseRef)
            }

            if (await wt.dirty()) {
                results.push({
                    name,
                    branch,
                    pushed: false,
                    status: "skipped",
                    reason: "uncommitted changes"
                })
                terminal.log(`${name}: uncommitted changes — skipping`)
                continue
            }

            // "ahead of base": any commit on the branch not in baseRef. None →
            // nothing to ship (GitHub rejects an empty PR), so skip.
            const ahead = await countAhead(repo, baseRef, branch)
            if (ahead === 0) {
                results.push({
                    name,
                    branch,
                    pushed: false,
                    status: "skipped",
                    reason: "nothing to ship"
                })
                terminal.log(`${name}: no commits ahead of base — skipping`)
                continue
            }

            const out: ShipRepo = {
                name,
                branch,
                pushed: false,
                status: "shipped"
            }
            results.push(out)
            pending.push({
                name,
                repo: participant.repo,
                source,
                dest,
                branch,
                ghBase: ghBaseName(baseRef),
                out
            })
        }

        // ── Single pass: push each shippable branch, then create-or-find its
        // PR. A push or gh failure for one repo is logged, flips that repo to
        // "failed", and the loop continues — never aborts the whole ship. An
        // existing PR is left untouched (push alone refreshes it), so a re-run
        // never clobbers a human-edited title or body.
        for (const item of pending) {
            // pre-ship GATES the ship: a non-zero exit skips this repo
            // (nothing is pushed, no PR is touched), the run continues, and
            // the command exits non-zero at the end. Runs in the worktree
            // about to be shipped.
            const pre = await runHook("pre-ship", {
                config,
                workspace: root,
                task: argv.task,
                repo: {
                    name: item.name,
                    path: item.dest,
                    url: urlByName.get(item.repo) ?? "",
                    branch: item.branch
                },
                noHooks: argv["no-hooks"]
            })
            if (pre) {
                hooks.push(pre)
                if (pre.exit !== 0) {
                    failedHooks.push(pre)
                    item.out.status = "skipped"
                    item.out.reason = "pre-ship hook failed"
                    terminal.log(
                        `${item.name}: pre-ship hook failed — skipping`
                    )
                    continue
                }
            }

            const repo = git(item.source)
            const wt = repo.worktree(item.dest)
            try {
                await wt.push(item.branch, { force: argv.force })
                item.out.pushed = true
                terminal.log(`${item.name}: pushed ${item.branch}`)
            } catch (error) {
                fail(item.out, pushError(error, argv.force))
                continue
            }

            // Push-only mode (--no-pr) never invokes gh — the repo is shipped
            // once pushed, and post-ship below fires with no PR URL.
            if (!argv["no-pr"]) {
                try {
                    const existing = await findOpenPr(
                        run,
                        item.dest,
                        item.branch
                    )
                    if (existing) {
                        // PR already open: push already refreshed it — do NOT
                        // edit its title or body (never clobber human edits).
                        item.out.pr = {
                            number: existing.number,
                            url: existing.url,
                            action: "updated"
                        }
                        terminal.log(
                            `${item.name}: PR #${existing.number} already open — pushed`
                        )
                    } else {
                        const tmp = await writeTemp(
                            bodyFor(item.dest, overrideBody)
                        )
                        let url: string
                        try {
                            url = await prCreate(run, item.dest, {
                                base: item.ghBase,
                                head: item.branch,
                                title: resolvedTitle,
                                bodyFile: tmp
                            })
                        } finally {
                            await removeTemp(tmp)
                        }
                        item.out.pr = {
                            number: pullRequestNumber(url) ?? 0,
                            url,
                            action: "created"
                        }
                        terminal.log(`${item.name}: created draft PR ${url}`)
                    }
                } catch (error) {
                    fail(item.out, ghError(error))
                }
            }

            // post-ship fires once this repo fully shipped: pushed, and its PR
            // created or found (unless --no-pr). A push/gh failure means no
            // post-ship. UBEREPO_PR_URL carries the PR's URL when one is in
            // hand, and is empty under --no-pr.
            if (item.out.status === "shipped") {
                const result = await runHook("post-ship", {
                    config,
                    workspace: root,
                    task: argv.task,
                    pr: item.out.pr?.url,
                    repo: {
                        name: item.name,
                        path: item.dest,
                        url: urlByName.get(item.repo) ?? "",
                        branch: item.branch
                    },
                    noHooks: argv["no-hooks"]
                })
                if (result) {
                    hooks.push(result)
                    if (result.exit !== 0) {
                        failedHooks.push(result)
                    }
                }
            }
        }

        terminal.json({
            task: argv.task,
            base: baseLabel,
            repos: results,
            hooks
        })

        const shipped = results.filter((r) => r.status === "shipped").length
        const failed = results.filter((r) => r.status === "failed")
        terminal.log(
            `Shipped task ${argv.task} in ${shipped} ${
                shipped === 1 ? "repository" : "repositories"
            }`
        )
        if (failed.length > 0) {
            const which = failed.map((r) => r.name).join(", ")
            terminal.error(
                `ship failed in ${failed.length} ${
                    failed.length === 1 ? "repository" : "repositories"
                }: ${which}`
            )
            process.exitCode = 1
        }
        // A failing post-ship never un-ships its repo (and a failing pre-ship
        // just left its repo unshipped), but the run is not clean: summarise
        // and exit non-zero so a wrapper/CI sees the failure.
        if (failedHooks.length > 0) {
            const which = failedHooks
                .map((h) => `${h.repo} (${h.event})`)
                .join(", ")
            terminal.error(
                `hooks failed in ${failedHooks.length} ${
                    failedHooks.length === 1 ? "repository" : "repositories"
                }: ${which}`
            )
            process.exitCode = 1
        }
    }
})

// Mark a repo's outcome as failed with a message, mirroring it to a human line.
// Never throws — ship's per-repo contract is continue-on-fail.
const fail = (out: ShipRepo, message: string): void => {
    out.status = "failed"
    out.error = message
    terminal.error(`${out.name}: ${message}`)
}

// The number of commits on `branch` not reachable from `baseRef`
// (`git rev-list --count <baseRef>..<branch>`). >0 means "ahead of base".
const countAhead = async (
    repo: ReturnType<typeof git>,
    baseRef: string,
    branch: string
): Promise<number> => {
    const out = await repo.raw("rev-list", "--count", `${baseRef}..${branch}`)
    return Number(out.trim())
}

// The first line of the note's goal (the goal is a `|` block), trimmed, or
// undefined when there is no goal — the second link in the title chain.
const goalTitle = (goal?: string): string | undefined => {
    if (goal === undefined) {
        return undefined
    }
    const first = goal.split("\n")[0]?.trim() ?? ""
    return first === "" ? undefined : first
}

// The resolved PR body: the override (--body / --body-file) when set, else the
// repo's .github PR template, else empty. Nothing is appended — this is the
// whole body.
const bodyFor = (worktree: string, override?: string): string => {
    if (override !== undefined) {
        return override
    }
    return readPrTemplate(worktree) ?? ""
}

// The OPEN PR for `head`, or undefined. A closed/merged PR is not reused — ship
// creates a fresh one — so only OPEN counts as "exists".
const findOpenPr = async (
    run: Gh,
    cwd: string,
    head: string
): Promise<{ number: number; url: string } | undefined> => {
    const prs = await prList(run, cwd, head)
    const open = prs.find((pr) => pr.state === "OPEN")
    if (!open) {
        return undefined
    }
    return { number: open.number, url: open.url }
}

// The human/JSON message for a failed push. A non-fast-forward rejection without
// --force gets the "did you sync?" hint; anything else surfaces git's stderr.
const pushError = (error: unknown, forced: boolean): string => {
    if (error instanceof GitError && error.isNonFastForward() && !forced) {
        return "branch diverged — did you sync? re-run with --force"
    }
    return error instanceof Error ? error.message : String(error)
}

// The message for a failed gh call. gh's stderr is surfaced as-is (auth errors
// included), so the operator sees exactly what gh reported.
const ghError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)
