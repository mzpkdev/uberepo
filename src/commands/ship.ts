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
    stackParent,
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
//   base:   this entry's resolved gh base — the remote default branch for a
//           root, or the PARENT participant's branch for a stacked child (its PR
//           is opened against the sibling, not main). Present once resolved, so
//           the --json per-repo output is truthful even when the run mixes roots
//           and children (the run-level baseLabel can only carry the roots').
//   reason: the skip reason (mirrors the human line)
//   error:  the failure message (mirrors the human line)
type ShipRepo = {
    name: string
    branch: string
    pushed: boolean
    base?: string
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
// branch, and the mutable outcome it writes its result into. A STACKED child
// also carries its parent's participant token and branch: the create loop opens
// its PR against `ghBase` = the parent branch, which must already be on the
// remote — so the loop skips the child when the parent neither pushed this run
// nor pre-exists on origin (see the parent-dependency guard).
type Pending = {
    name: string
    repo: string
    source: string
    dest: string
    branch: string
    ghBase: string
    parent?: { token: string; branch: string }
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

// Order participants parent-BEFORE-child so a stacked child is shipped after the
// sibling it stacks on. ship's push + PR-create is ONE loop pass, and a child's
// `gh pr create --base task/<task>@parent` needs the parent branch already on
// the remote — so the parent must be pushed earlier in the same pass, which a
// parent-first order over the single pass guarantees. A stable topological sort
// of the per-repo stack forest (edges from stackParent): repeatedly emit any
// not-yet-emitted participant all of whose in-scope parents are already emitted,
// scanning in the input order so non-stacked participants and independent
// chains keep their original relative order. `scope` is the task's participant
// set, the universe stackParent classifies a base against. Pure.
const parentFirstOrder = (
    names: string[],
    branches: Record<string, { base?: string }> | undefined,
    scope: string[]
): string[] => {
    // Each participant's parent token, but only for parents that are also in
    // THIS run's set — a parent outside the run can't gate the child's position
    // (it isn't being ordered here; the remote-existence guard handles it).
    const inRun = new Set(names)
    const parentOf = new Map<string, string>()
    for (const name of names) {
        const parent = stackParent(name, branches, scope)
        if (parent !== undefined && inRun.has(parent)) {
            parentOf.set(name, parent)
        }
    }
    const ordered: string[] = []
    const emitted = new Set<string>()
    // Bounded by names.length passes (each pass emits at least one unless a
    // cycle blocks progress — validation forbids cycles, but the guard below
    // keeps a malformed note from looping forever: it appends the remainder).
    while (ordered.length < names.length) {
        let progressed = false
        for (const name of names) {
            if (emitted.has(name)) {
                continue
            }
            const parent = parentOf.get(name)
            if (parent === undefined || emitted.has(parent)) {
                ordered.push(name)
                emitted.add(name)
                progressed = true
            }
        }
        if (!progressed) {
            // A residual cycle (shouldn't happen post-validation): append the
            // rest in input order rather than spin, so ship still runs.
            for (const name of names) {
                if (!emitted.has(name)) {
                    ordered.push(name)
                    emitted.add(name)
                }
            }
            break
        }
    }
    return ordered
}

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

        // Order parent-before-child within each repo so a stacked child ships
        // AFTER the sibling it stacks on. push + PR-create is a single pass, and
        // a child's `gh pr create --base task/<task>@parent` needs the parent
        // branch already on the remote — so the parent must be pushed earlier in
        // the same pass. Non-stacked participants keep their sorted order. The
        // per-repo result order in the JSON follows suit (results are pushed in
        // this order), which reads naturally: a parent above its children.
        targets = parentFirstOrder(targets, note?.branches, scope)

        // The run-level base, reported in the JSON: an explicit --base wins;
        // otherwise it is filled with the first repo's resolved default branch
        // name (by convention the same across repos). Empty until resolved.
        // This is the ROOTS' base; a stacked child's own base (its parent
        // branch) rides on its per-repo `base` field, not this scalar.
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

            // Classify this participant's base: a sibling participant in scope
            // (a `--stack` edge) makes it a STACKED CHILD; otherwise its base is
            // a remote ref (an adopted branch's PR base, or the remote default).
            const parentToken = stackParent(name, note?.branches, scope)

            // Resolve the base ref to count "ahead" against AND the gh base the
            // PR targets. Two shapes:
            //   - stacked child: both are the PARENT's local branch (e.g.
            //     task/<task>@strings). "ahead" then counts the child's commits
            //     BEYOND its parent (a non-empty stacked PR), and the gh base is
            //     that branch verbatim — NOT ghBaseName-stripped (it's a local
            //     branch, not origin/...). --base is intentionally NOT honoured
            //     for a stacked child: the edge names its base.
            //   - root: --base wins; then the persisted remote base (an adopted
            //     branch's PR base — so "ahead" counts against the PR's real
            //     target, not a flattened remoteDefault); else the remote
            //     default. The gh base is ghBaseName-stripped. No base at all →
            //     can't compute "ahead", skip.
            let baseRef: string | undefined
            let ghBase: string
            let parent: { token: string; branch: string } | undefined
            if (parentToken !== undefined) {
                const parentBranch = branchFor(
                    argv.task,
                    parentToken,
                    note?.branches
                )
                baseRef = parentBranch
                ghBase = parentBranch
                parent = { token: parentToken, branch: parentBranch }
            } else {
                baseRef =
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
                    terminal.log(
                        `${name}: cannot resolve base — pass --base <ref>`
                    )
                    continue
                }
                ghBase = ghBaseName(baseRef)
                // Only a ROOT contributes to the run-level base scalar; a
                // stacked child's base is its parent branch, carried per-entry.
                if (baseLabel === "") {
                    baseLabel = ghBase
                }
            }

            if (await wt.dirty()) {
                results.push({
                    name,
                    branch,
                    base: ghBase,
                    pushed: false,
                    status: "skipped",
                    reason: "uncommitted changes"
                })
                terminal.log(`${name}: uncommitted changes — skipping`)
                continue
            }

            // "ahead of base": any commit on the branch not in baseRef. None →
            // nothing to ship (GitHub rejects an empty PR), so skip. For a
            // stacked child baseRef is the parent branch, so this counts the
            // child's own commits beyond the parent.
            const ahead = await countAhead(repo, baseRef, branch)
            if (ahead === 0) {
                results.push({
                    name,
                    branch,
                    base: ghBase,
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
                base: ghBase,
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
                ghBase,
                parent,
                out
            })
        }

        // ── Single pass: push each shippable branch, then create-or-find its
        // PR. A push or gh failure for one repo is logged, flips that repo to
        // "failed", and the loop continues — never aborts the whole ship. An
        // existing PR is left untouched (push alone refreshes it), so a re-run
        // never clobbers a human-edited title or body. Parent-first order (set
        // above) means a stacked child is reached AFTER its parent in this same
        // pass, so the parent's push has already happened — recorded in
        // `pushedParents` so the child knows whether its `--base` branch exists
        // on the remote yet.
        const pushedParents = new Set<string>()
        for (const item of pending) {
            // Parent-dependency guard: a stacked child's PR is opened against
            // its parent's branch (`item.ghBase`), which `gh pr create` requires
            // to already be ON THE REMOTE. If the parent did NOT push this run
            // (skipped: not-ahead / dirty / pre-ship-fail / push-fail) AND its
            // branch isn't already on origin, the create would fail — so skip
            // the child up front with an actionable reason instead. This is
            // ship's one cross-participant dependency; the eventual restack is
            // Phase 3's job.
            if (item.parent && !pushedParents.has(item.parent.token)) {
                const repo = git(item.source)
                if (!(await repo.remoteBranchExists(item.parent.branch))) {
                    item.out.status = "skipped"
                    item.out.reason = `parent ${item.parent.token} not on remote — ship it first`
                    terminal.log(
                        `${item.name}: parent ${item.parent.token} not on remote — ship it first`
                    )
                    continue
                }
            }

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
                // This participant's branch is now on the remote, so any child
                // stacking on it (reached later in this parent-first pass) can
                // safely open its PR against it.
                pushedParents.add(item.name)
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
                        // This also means a PR first opened FLAT then later
                        // declared stacked keeps its old base: we never run
                        // `gh pr edit --base` to re-stack an existing PR. That
                        // residual is accepted for this slice (re-stacking open
                        // PRs is out of scope until the sync restack lands).
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

        // Persist each shipped participant's PR url into the durable note, so
        // status can surface the link offline (no gh call). Read-modify-write
        // ONCE after the loop: only participants that got a PR this run
        // (item.out.pr is the same url the JSON reports) touch the note, so a
        // --repos subset / --no-pr run preserves every other entry. A task with
        // no note file (rare — open seeds one) skips persistence entirely.
        const fresh = await ubertask.read(notePath)
        if (fresh) {
            let changed = false
            for (const item of pending) {
                const url = item.out.pr?.url
                if (url === undefined) {
                    continue
                }
                const existing = fresh.branches[item.name]
                if (existing) {
                    // Preserve name/adopted/base — only stamp the pr on.
                    existing.pr = url
                } else {
                    // Materialize a minimal entry to hold the pr; branchFor
                    // reconstructs the participant's resolved branch name.
                    fresh.branches[item.name] = {
                        name: branchFor(argv.task, item.name, fresh.branches),
                        adopted: false,
                        pr: url
                    }
                }
                changed = true
            }
            if (changed) {
                await ubertask.write(notePath, fresh)
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
