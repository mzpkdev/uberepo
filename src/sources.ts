import * as path from "node:path"
import { terminal } from "cmdore"
import type { UberepoConfig } from "@/config"
import git from "@/git"
import { type HookResult, runHook } from "@/hooks"

// One repo's clone outcome, as emitted in a command's JSON: cloned (a fresh
// clone landed), skipped (its pre-clone hook failed — `reason` set — or, on
// the clone command's already-on-disk path, source/<name> existed), or failed
// (git.clone threw — `error` carries the message). Shared by `clone` (its
// `repos` array) and `open` (its `clone` array for on-demand clones).
export type CloneRepo = {
    name: string
    status: "cloned" | "skipped" | "failed"
    reason?: string
    error?: string
}

// The full outcome of one repo's clone lifecycle op: the repo's CloneRepo
// entry, every hook that ran for it (pre-clone and, on success, post-clone),
// and — when status is "failed" — the thrown git error, so a fail-fast caller
// (clone) can rethrow it while a resilient caller (open) records it and moves
// on to the next repo.
export type CloneOutcome = {
    repo: CloneRepo
    hooks: HookResult[]
    error?: unknown
}

// Clone one registered repository into <root>/source/<name> as the full
// lifecycle op: pre-clone gate → git clone → post-clone. This is the per-repo
// machinery `uberepo clone` runs, extracted so `open` can clone a scoped repo
// on demand with the identical hook cwd/env contract. The caller owns the
// skip-if-already-cloned check and decides what a failure means (fail fast vs
// continue); a hook's non-zero exit is returned, never thrown, exactly like
// runHook.
export const cloneSource = async (ctx: {
    config: UberepoConfig
    root: string
    name: string
    url: string
    noHooks?: boolean
}): Promise<CloneOutcome> => {
    const dest = path.join(ctx.root, "source", ctx.name)
    const hooks: HookResult[] = []
    // pre-clone GATES the clone: a non-zero exit skips this repo (nothing is
    // cloned). source/<name> does not exist yet, so the hook runs at the
    // workspace root while UBEREPO_REPO_PATH names the would-be clone. No
    // task/branch is passed even when open triggers the clone — the clone
    // events' env contract is task-free, matching `uberepo clone`.
    const pre = await runHook("pre-clone", {
        config: ctx.config,
        workspace: ctx.root,
        cwd: ctx.root,
        repo: { name: ctx.name, path: dest, url: ctx.url },
        noHooks: ctx.noHooks
    })
    if (pre) {
        hooks.push(pre)
        if (pre.exit !== 0) {
            terminal.log(`Skipping ${ctx.url} — pre-clone hook failed`)
            return {
                repo: {
                    name: ctx.name,
                    status: "skipped",
                    reason: "pre-clone hook failed"
                },
                hooks
            }
        }
    }
    terminal.log(`Cloning ${ctx.url} → source/${ctx.name}`)
    try {
        await git.clone(ctx.url, dest)
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return {
            repo: { name: ctx.name, status: "failed", error: reason },
            hooks,
            error
        }
    }
    // post-clone fires for the FRESH clone only, with cwd = its source/<name>
    // and no task/branch. A non-zero exit is recorded for the caller — the
    // clone itself already landed, so it never undoes anything.
    const post = await runHook("post-clone", {
        config: ctx.config,
        workspace: ctx.root,
        repo: { name: ctx.name, path: dest, url: ctx.url },
        noHooks: ctx.noHooks
    })
    if (post) {
        hooks.push(post)
    }
    return { repo: { name: ctx.name, status: "cloned" }, hooks }
}
