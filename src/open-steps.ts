import * as fs from "node:fs"
import * as path from "node:path"
import { terminal } from "cmdore"
import { type CarryEntry, runCarry } from "@/carry"
import { repositoryUrl, TASKS_DIR, type UberepoConfig } from "@/config"
import git from "@/git"
import { type HookResult, runHook } from "@/hooks"
import type { OpenRepo } from "@/open-plan"
import { type CloneRepo, cloneSource } from "@/sources"
import { worktreePath } from "@/tasks"
import { normalizeRepository } from "@/url"

// The EFFECTFUL per-repo machinery of `open`, lifted out of the command's
// target loop so `run()` collapses to map-and-aggregate. `open-plan.ts` owns the
// PURE decisions (scope/targets/note/exit-code); this module owns the IO those
// decisions drive — enumerating sources off disk and opening one repo's
// worktree — returning each step's outcome as a VALUE instead of mutating the
// shared arrays the loop used to push into.

// The registered flat names (registration order) with their URLs, and which of
// them are already cloned. This is an IO helper — a per-repo `fs.existsSync`
// against source/<name> — so it lives here, not in the pure planner. The URL map
// lets a fired hook surface UBEREPO_REPO_URL and feeds the on-demand clones (the
// command's loops work in flat names).
export const collectSources = (
    config: UberepoConfig,
    root: string
): {
    registered: string[]
    cloned: string[]
    urlByName: Map<string, string>
} => {
    const registered: string[] = []
    const cloned: string[] = []
    const urlByName = new Map<string, string>()
    for (const entry of config.repositories) {
        const url = repositoryUrl(entry)
        const { name } = normalizeRepository(url)
        registered.push(name)
        urlByName.set(name, url)
        if (fs.existsSync(path.join(root, "source", name))) {
            cloned.push(name)
        }
    }
    return { registered, cloned, urlByName }
}

// Everything openRepoWorktree closes over from the command's run(): the
// workspace config and root, the task and its derived branch/base, the
// name→URL map (for the on-demand clone and the hooks' UBEREPO_REPO_URL), and
// the --no-hooks flag. The per-iteration locals (source/dest/relative) are
// derived inside the step from name + root + task.
export type OpenStepCtx = {
    config: UberepoConfig
    root: string
    task: string
    branch: string
    base: string
    urlByName: Map<string, string>
    noHooks?: boolean
}

// One repo's open outcome as a VALUE. The caller pushes `repo` into its repos
// array, `clone` (present only on the on-demand-clone path) into its clone
// array, spreads `hooks` into its hooks array, pushes `carry` (when carry ran)
// into its carry array, and counts `opened`. This mirrors exactly what the old
// target-loop body pushed inline.
export type OpenStepResult = {
    repo: OpenRepo
    clone?: CloneRepo
    hooks: HookResult[]
    carry?: CarryEntry
    opened: boolean
}

// Open (and, on demand, clone) one target repo's worktree — the command's old
// target-loop body, turned into a function that RETURNS its outcome. The three
// soft-skip exits (clone didn't land, worktree already open, pre-open hook
// failed) each return an early partial result; the success path returns the
// pre-open hook (if it ran), the created repo, the carry entry (if carry ran),
// and the post-open hook (if it ran). The worktree-create error is NOT caught —
// it propagates so the run fails fast before any later repo is touched.
export const openRepoWorktree = async (
    name: string,
    ctx: OpenStepCtx
): Promise<OpenStepResult> => {
    const source = path.join(ctx.root, "source", name)
    const dest = worktreePath(ctx.root, ctx.task, name)
    const relative = path.join(TASKS_DIR, ctx.task, name)
    const hooks: HookResult[] = []
    // On-demand clone: a target with no clone yet is cloned FIRST, as the same
    // per-repo lifecycle op `uberepo clone` runs (pre-clone gate → git clone →
    // post-clone, identical hook cwd/env contract), then opened below like any
    // cloned repo. A target is uncloned only when it was explicitly asked for —
    // a scoped name, or a --repos name on an unscoped task; an unscoped open
    // never adds an uncloned target on its own, so it still never clones
    // implicitly.
    if (!fs.existsSync(source)) {
        const outcome = await cloneSource({
            config: ctx.config,
            root: ctx.root,
            name,
            url: ctx.urlByName.get(name) ?? "",
            noHooks: ctx.noHooks
        })
        for (const hook of outcome.hooks) {
            hooks.push(hook)
        }
        if (outcome.repo.status !== "cloned") {
            // No clone landed (git failed, or the pre-clone gate held), so
            // there is no repo to open a worktree in: report the skip and let
            // the caller move on with the remaining repos — the failure flips
            // the exit code at the end, and a re-run picks the repo up (per-repo
            // resilience, like ship).
            return {
                repo: {
                    name,
                    status: "skipped",
                    reason:
                        outcome.repo.status === "failed"
                            ? "clone failed"
                            : outcome.repo.reason
                },
                clone: outcome.repo,
                hooks,
                opened: false
            }
        }
        return await openCloned(name, ctx, {
            source,
            dest,
            relative,
            hooks,
            clone: outcome.repo
        })
    }
    return await openCloned(name, ctx, { source, dest, relative, hooks })
}

// The open half of the step, shared by the already-cloned and the
// just-cloned-on-demand paths. `extra.clone` rides through so an on-demand
// clone's CloneRepo lands in the result even when the subsequent open skips.
const openCloned = async (
    name: string,
    ctx: OpenStepCtx,
    extra: {
        source: string
        dest: string
        relative: string
        hooks: HookResult[]
        clone?: CloneRepo
    }
): Promise<OpenStepResult> => {
    const { source, dest, relative, hooks, clone } = extra
    // Idempotent: an existing worktree dir is left untouched. This is also the
    // recovery path — re-running open skips the done repos and resumes after a
    // mid-run failure.
    if (fs.existsSync(dest)) {
        terminal.log(`Skipping ${name} — worktree already open at ${relative}`)
        return {
            repo: { name, status: "skipped" },
            clone,
            hooks,
            opened: false
        }
    }
    // pre-open GATES the worktree: a non-zero exit skips this repo (no worktree
    // is created), the run continues, and the command exits non-zero at the end.
    // The worktree does not exist yet, so the hook runs in the repo's source
    // clone while UBEREPO_REPO_PATH names the would-be worktree.
    const pre = await runHook("pre-open", {
        config: ctx.config,
        workspace: ctx.root,
        task: ctx.task,
        cwd: source,
        repo: {
            name,
            path: dest,
            url: ctx.urlByName.get(name) ?? "",
            branch: ctx.branch
        },
        noHooks: ctx.noHooks
    })
    if (pre) {
        hooks.push(pre)
        if (pre.exit !== 0) {
            terminal.log(`Skipping ${name} — pre-open hook failed`)
            return {
                repo: {
                    name,
                    status: "skipped",
                    reason: "pre-open hook failed"
                },
                clone,
                hooks,
                opened: false
            }
        }
    }
    terminal.log(
        `Opening ${name} → ${relative} (${ctx.branch} from ${ctx.base})`
    )
    // Fail-fast: a creation error propagates, stopping before any later repo is
    // touched; already-created worktrees stay put.
    const repo = git(source)
    await repo.worktree(dest).create({ branch: ctx.branch, from: ctx.base })
    let carry: CarryEntry | undefined
    // Carry the configured untracked local files (.env and friends) from the
    // source clone into the fresh worktree BEFORE post-open fires, so a hook
    // like `npm ci && db:migrate` finds them in place.
    const carried = await runCarry({
        config: ctx.config,
        name,
        source,
        worktree: dest
    })
    if (carried) {
        carry = { repo: name, ...carried }
    }
    // post-open fires for the NEWLY-created worktree only, with cwd = the
    // worktree and branch = task/<task>. A hook failure is recorded and the run
    // continues — the worktree already exists.
    const result = await runHook("post-open", {
        config: ctx.config,
        workspace: ctx.root,
        task: ctx.task,
        repo: {
            name,
            path: dest,
            url: ctx.urlByName.get(name) ?? "",
            branch: ctx.branch
        },
        noHooks: ctx.noHooks
    })
    if (result) {
        hooks.push(result)
    }
    return {
        repo: { name, status: "created" },
        clone,
        hooks,
        carry,
        opened: true
    }
}
