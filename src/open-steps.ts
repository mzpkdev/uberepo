import * as fs from "node:fs"
import * as path from "node:path"
import { effect, terminal } from "cmdore"
import { type CarryEntry, runCarry } from "@/carry"
import { repositoryUrl, TASKS_DIR, type UberepoConfig } from "@/config"
import { currentGh, ghAvailable, prView } from "@/forge"
import git from "@/git"
import { type HookResult, runHook } from "@/hooks"
import {
    type BranchSpec,
    branchNameFor,
    type OpenRepo,
    resolveBranchMode
} from "@/open-plan"
import { type CloneRepo, cloneSource } from "@/sources"
import { participantBranch, sourceName, worktreePath } from "@/tasks"
import type { UbertaskBranch } from "@/ubertask"
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
// workspace config and root, the task, the resolved `--branch` spec
// (per-participant branch names, adopt-or-create resolved per participant inside
// the step), the fallback base for a CREATED branch (--from, else HEAD — adopted
// branches discover their base from the PR), the repo→URL map keyed by the bare
// repo name (for the on-demand clone and the hooks' UBEREPO_REPO_URL), the
// --no-hooks flag, and `clonedRepos`: the set of bare repo names already
// clone-attempted THIS run. The step consults + updates it so a repo backing
// several participants is cloned ONCE — the second participant sharing it never
// re-clones (faithful even under --dry-run, where the clone never lands on
// disk). The per-iteration locals (source/dest/relative/branch) are derived
// inside the step from the participant token.
export type OpenStepCtx = {
    config: UberepoConfig
    root: string
    task: string
    branchSpec: BranchSpec
    base: string
    urlByName: Map<string, string>
    noHooks?: boolean
    clonedRepos?: Set<string>
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
    // The branch this repo's worktree landed on (adopt-or-create), so the
    // shell can persist it in the note's `branches:` map. Present only when a
    // worktree actually landed this run (the `created` path); every skip path
    // omits it. Kept OFF OpenRepo so the JSON `repos[]` shape is unchanged —
    // the branch record is an internal carrier for the note write.
    branch?: UbertaskBranch
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
    // `name` is the participant token (`repo` or `repo@alias`). The worktree
    // folder is the token; the source clone is the bare repo, SHARED by every
    // participant of that repo.
    const repo = sourceName(name)
    const source = path.join(ctx.root, "source", repo)
    const dest = worktreePath(ctx.root, ctx.task, name)
    const relative = path.join(TASKS_DIR, ctx.task, name)
    const hooks: HookResult[] = []
    // On-demand clone: a target whose repo has no clone yet AND that this run has
    // not already cloned is cloned FIRST, as the same per-repo lifecycle op
    // `uberepo clone` runs (pre-clone gate → git clone → post-clone, identical
    // hook cwd/env contract), then opened below like any cloned repo. A target is
    // uncloned only when it was explicitly asked for — a scoped name, or a
    // --repos name on an unscoped task; an unscoped open never adds an uncloned
    // target on its own, so it still never clones implicitly. clonedRepos makes a
    // repo backing SEVERAL participants clone once: the first participant clones
    // and records the repo; the rest fall through to the open below.
    if (!fs.existsSync(source) && !ctx.clonedRepos?.has(repo)) {
        ctx.clonedRepos?.add(repo)
        // Under --dry-run the clone (git clone + its pre/post-clone hooks) is a
        // mutation, so it stays inside effect() and never runs — but the PLAN
        // must still report it. effect() resolves undefined when disabled, so
        // we fall back to a synthetic "would-clone" outcome: a clone entry the
        // summary surfaces, no hooks fired, and the open below proceeds against
        // the would-be source. A real run gets the actual CloneOutcome.
        const outcome = (await effect(() =>
            cloneSource({
                config: ctx.config,
                root: ctx.root,
                name: repo,
                url: ctx.urlByName.get(repo) ?? "",
                noHooks: ctx.noHooks
            })
        )) as Awaited<ReturnType<typeof cloneSource>> | undefined
        if (outcome === undefined) {
            // Dry-run: report the planned clone (no hooks fire, nothing lands on
            // disk) and plan the worktree against the would-be clone. A repo
            // with no clone on disk can't be probed for an existing branch, so
            // openCloned plans a fresh CREATE on the resolved branch name — the
            // faithful common-case outcome for a brand-new clone. The clone entry
            // is keyed by the bare repo (the clone unit), the worktree by the
            // participant.
            return await openCloned(name, ctx, {
                source,
                dest,
                relative,
                hooks,
                clone: { name: repo, status: "cloned" }
            })
        }
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
    // The bare repo backing this participant — the source/URL identity, shared
    // by every participant of the repo. Hooks still report under the participant
    // `name` (so two same-repo participants stay distinct in the JSON), but the
    // clone URL is keyed by the repo.
    const repoName = sourceName(name)
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
    const repo = git(source)
    // The branch this participant's worktree will live on: the --branch spec's
    // per-participant / all-repos name, else the participant default
    // (task/<task> bare, task/<task>@<alias> aliased). Then decide adopt-or-create
    // from whether that branch already exists locally or only on origin — the one
    // genuinely new git mechanic, kept in the pure planner. These are READS (git
    // rev-parse), so they always run, INCLUDING under --dry-run — the plan needs
    // the real adopt-or-create decision. The one exception is the dry-run
    // on-demand-clone path: `source` does not exist on disk (the clone is the
    // skipped mutation), so there is nothing to probe and the faithful plan is a
    // fresh CREATE on the resolved name.
    const branch = branchNameFor(
        ctx.branchSpec,
        name,
        participantBranch(ctx.task, name)
    )
    const mode = fs.existsSync(source)
        ? resolveBranchMode({
              local: await repo.branchExists(branch),
              remote: await repo.remoteBranchExists(branch)
          })
        : ({ mode: "create", track: false } as const)
    // pre-open GATES the worktree: a non-zero exit skips this repo (no worktree
    // is created), the run continues, and the command exits non-zero at the end.
    // The worktree does not exist yet, so the hook runs in the repo's source
    // clone while UBEREPO_REPO_PATH names the would-be worktree. Firing a hook
    // is a side effect, so it lives inside effect(): under --dry-run it does not
    // fire (resolves undefined), the gate is skipped, and the plan reports the
    // worktree this open WOULD create.
    const pre = (await effect(() =>
        runHook("pre-open", {
            config: ctx.config,
            workspace: ctx.root,
            task: ctx.task,
            cwd: source,
            repo: {
                name,
                path: dest,
                url: ctx.urlByName.get(repoName) ?? "",
                branch
            },
            noHooks: ctx.noHooks
        })
    )) as HookResult | undefined
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
    // The terminal line describes the planned action; under --dry-run it is
    // prefixed so a human reads it as a preview, not a fait accompli. The
    // wording is OUTSIDE effect() — the plan must always be surfaced — while the
    // worktree creation it describes is INSIDE.
    const verb = effect.enabled ? "Opening" : "Would open"
    if (mode.mode === "adopt") {
        terminal.log(
            `${verb} ${name} → ${relative} (adopting ${branch}${
                mode.track ? " from origin" : ""
            })`
        )
    } else {
        terminal.log(
            `${verb} ${name} → ${relative} (${branch} from ${ctx.base})`
        )
    }
    // Fail-fast: a creation error propagates, stopping before any later repo is
    // touched; already-created worktrees stay put. CREATE cuts a fresh branch
    // off the base; ADOPT attaches the worktree to the existing branch (with
    // tracking set up when it lives only on origin). The mutation is wrapped in
    // effect() — under --dry-run no worktree/branch is created, but the result
    // below still reports it as `created`.
    await effect(() => {
        if (mode.mode === "adopt") {
            return repo
                .worktree(dest)
                .create({ branch, attach: true, track: mode.track })
        }
        return repo.worktree(dest).create({ branch, from: ctx.base })
    })
    // Record what WOULD/DID land for the note's `branches:` map. A created
    // branch carries no base (consumers fall back to remoteDefault); an adopted
    // branch discovers its base from the head's open PR (gh) when there is one —
    // that base is what sync/diff/ship will rebase/compare/target against, the
    // escape from flattening a stacked branch onto remoteDefault. A hand-fed
    // --branch base is NOT inferred here; discovery is PR-only. Discovery is a
    // READ, but it queries gh in the worktree dir, which only exists once the
    // worktree was actually created — so it is gated on effect.enabled too,
    // leaving the dry-run plan to record the adopted branch with no base.
    const recorded: UbertaskBranch = {
        name: branch,
        adopted: mode.mode === "adopt"
    }
    if (mode.mode === "adopt" && effect.enabled) {
        const { base, pr } = await discoverPr(dest, branch)
        if (base !== undefined) {
            recorded.base = base
        }
        if (pr !== undefined) {
            recorded.pr = pr
        }
    }
    let carry: CarryEntry | undefined
    // Carry the configured untracked local files (.env and friends) from the
    // source clone into the fresh worktree BEFORE post-open fires, so a hook
    // like `npm ci && db:migrate` finds them in place. Pattern lookup is by the
    // bare repo (carry config is per-repo), so every participant of a repo
    // carries the same files; the carry ENTRY is tagged with the participant so
    // two same-repo participants stay distinct in the JSON. Copying files is a
    // mutation (and reads the worktree, which only exists after a real create),
    // so it is wrapped in effect(): a dry-run copies nothing and records no
    // carry entry.
    const carried = (await effect(() =>
        runCarry({
            config: ctx.config,
            name: repoName,
            source,
            worktree: dest
        })
    )) as Awaited<ReturnType<typeof runCarry>> | undefined
    if (carried) {
        carry = { repo: name, ...carried }
    }
    // post-open fires for the NEWLY-created worktree only, with cwd = the
    // worktree and branch = the resolved branch (task/<task> by default, or the
    // adopted/--branch name). A hook failure is recorded and the run
    // continues — the worktree already exists. Wrapped in effect(): a dry-run
    // fires no hook and records none.
    const result = (await effect(() =>
        runHook("post-open", {
            config: ctx.config,
            workspace: ctx.root,
            task: ctx.task,
            repo: {
                name,
                path: dest,
                url: ctx.urlByName.get(repoName) ?? "",
                branch
            },
            noHooks: ctx.noHooks
        })
    )) as HookResult | undefined
    if (result) {
        hooks.push(result)
    }
    return {
        repo: { name, status: "created" },
        clone,
        hooks,
        carry,
        opened: true,
        branch: recorded
    }
}

// The base ref AND PR url for a freshly-adopted branch, discovered from its
// open PR (`baseRefName` / `url`) in ONE prView call — both undefined when
// there is no PR / no gh. Mirrors context's opportunistic gh use: an up-front
// availability probe, then prView in the worktree (gh infers the repo from
// origin), with any gh failure reading as "no PR known" → both undefined → the
// consumers fall back to remoteDefault (base) and status shows no link (pr).
// PR-only on purpose (the accepted residual): a stacked branch with no PR yet
// records no base and can flatten on sync — the --branch base override is the
// escape hatch. `base` is the branch the PR targets (omitted when gh reports
// none); `pr` is the PR's url, persisted so status can surface the link offline.
const discoverPr = async (
    worktree: string,
    branch: string
): Promise<{ base?: string; pr?: string }> => {
    const run = currentGh()
    if (!(await ghAvailable(run))) {
        return {}
    }
    const view = await prView(run, worktree, branch)
    if (!view) {
        return {}
    }
    return {
        ...(view.baseRefName !== "" ? { base: view.baseRefName } : {}),
        pr: view.url
    }
}
