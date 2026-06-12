import * as fs from "node:fs"
import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { task } from "@/arguments/task"
import { type CarryEntry, runCarry } from "@/carry"
import { Config, repositoryUrl } from "@/config"
import git from "@/git"
import { type HookResult, runHook } from "@/hooks"
import { from } from "@/options/from"
import { noHooks } from "@/options/no-hooks"
import { partitionScope, taskBranch, taskScope, worktreePath } from "@/tasks"
import { normalizeRepository } from "@/url"

// One repo's sync outcome. `rebased` = task branch replayed onto the upstream,
// `current` is reserved for an already-up-to-date repo, `conflict` = the rebase
// stopped on a conflict (left mid-rebase), `skipped` = not rebased (`reason`
// mirroring the human line: uncommitted changes, an unresolved upstream, or
// "not reached" for repos after the one that stopped the sequential run).
type SyncRepo = {
    name: string
    status: "rebased" | "current" | "conflict" | "skipped"
    reason?: string
}

export default defineCommand({
    name: "sync",
    description: "Sync an open task's worktrees with their upstream branches",
    arguments: [task],
    options: [from, noHooks],
    async run(argv) {
        const config = await Config.read()
        const root = await Config.root()
        const branch = taskBranch(argv.task)

        // The task's worktrees across cloned repos: a repo participates only
        // when it is both cloned (source/<name>) and has this task's worktree.
        // `url` is the registered URL, carried through so a fired post-sync hook
        // can surface it as UBEREPO_REPO_URL.
        const present: {
            name: string
            url: string
            source: string
            dest: string
        }[] = []
        for (const entry of config.repositories) {
            const url = repositoryUrl(entry)
            const { name } = normalizeRepository(url)
            const source = path.join(root, "source", name)
            const dest = worktreePath(root, argv.task, name)
            if (!fs.existsSync(source) || !fs.existsSync(dest)) {
                continue
            }
            present.push({ name, url, source, dest })
        }

        // Honour the task's declared scope: act only on its owned repos. A
        // worktree outside a non-empty scope is drift — warn about it (never
        // touch it silently, never silently skip the in-scope work) and proceed
        // on the in-scope intersection. Unscoped → every worktree-bearing repo.
        const scope = await taskScope(root, argv.task)
        const { inScope, strays } = partitionScope(
            present.map((t) => t.name),
            scope
        )
        for (const name of strays) {
            terminal.warn(
                `${name}: worktree outside task scope (not in repos:) — skipping; close it or add it with open --repos`
            )
        }
        const targets = present.filter((t) => inScope.includes(t.name))
        // The top-level rebase target: an explicit --from wins for every repo;
        // otherwise it is each repo's resolved origin default (by convention the
        // same branch name across repos). Filled in once resolved below so the
        // JSON names what the sync rebased onto. Empty until then.
        let onto = argv.from ?? ""

        if (targets.length === 0) {
            terminal.json({
                task: argv.task,
                onto,
                repos: [],
                hooks: [],
                carry: []
            })
            terminal.warn(`No open task ${argv.task} to sync.`)
            return
        }

        // Pre-flight: refuse to touch anything if any of the task's worktrees
        // is dirty. Rebasing a dirty tree would either fail mid-way or strand
        // uncommitted work, so we clean preconditions before any side effect.
        const dirty = new Set<string>()
        for (const target of targets) {
            const wt = git(target.source).worktree(target.dest)
            if (await wt.dirty()) {
                dirty.add(target.name)
            }
        }
        if (dirty.size > 0) {
            for (const target of targets) {
                if (dirty.has(target.name)) {
                    terminal.log(
                        `${target.name}: uncommitted changes — commit or stash first`
                    )
                }
            }
            // Nothing was rebased: dirty repos are skipped for that reason, the
            // clean ones were never reached (the pre-flight bailed first). No
            // worktree was rebased, so no post-sync hook or carry ran.
            const repos: SyncRepo[] = targets.map((target) =>
                dirty.has(target.name)
                    ? {
                          name: target.name,
                          status: "skipped",
                          reason: "uncommitted changes"
                      }
                    : {
                          name: target.name,
                          status: "skipped",
                          reason: "not reached"
                      }
            )
            terminal.json({
                task: argv.task,
                onto,
                repos,
                hooks: [],
                carry: []
            })
            return
        }

        // Sync sequentially. On the first repo whose rebase conflicts we stop
        // and leave that rebase in progress (the signal for the user to resolve
        // or abort), deliberately not touching the repos that follow.
        let synced = 0
        const repos: SyncRepo[] = []
        // One entry per hook that actually ran: pre-sync for every repo whose
        // rebase was attempted, post-sync for cleanly rebased repos only —
        // never dirty-skipped, conflicted, or not-reached ones. A non-zero
        // exit is collected and flips the command's exit code at the end
        // without aborting the remaining repos.
        const hooks: HookResult[] = []
        const failedHooks: HookResult[] = []
        // One entry per repo whose carry actually ran (a cleanly-rebased repo
        // with carry patterns). The never-overwrite rule makes this re-run a
        // missing-files-only repair: existing worktree files are kept, only
        // matches that vanished (or appeared in source since open) are copied.
        const carry: CarryEntry[] = []
        // Mark every target the sequential run never reached as skipped, append
        // them to the per-repo outcomes, and emit the JSON for an early return.
        // Carries the hooks and carry results that did land (for the
        // cleanly-rebased repos before the stop), keeping both contracts on
        // every exit path.
        const emitStopped = (): void => {
            const reached = new Set(repos.map((r) => r.name))
            for (const target of targets) {
                if (!reached.has(target.name)) {
                    repos.push({
                        name: target.name,
                        status: "skipped",
                        reason: "not reached"
                    })
                }
            }
            terminal.json({ task: argv.task, onto, repos, hooks, carry })
        }
        for (const target of targets) {
            const { name, url, source, dest } = target
            const repo = git(source)
            const wt = repo.worktree(dest)

            // Resolve the rebase target before fetching. An explicit --from ref
            // wins; otherwise we resolve the remote default branch *name* (e.g.
            // origin/main) from the local origin/HEAD symref. Resolving first
            // means a missing/unconfigured origin yields a clean error instead
            // of a raw fetch failure, and never rebases onto a guessed target.
            // The name is stable across the fetch; fetch then advances what it
            // points at, so the rebase still lands on the freshest upstream.
            const resolved = argv.from ?? (await repo.remoteDefault())
            if (!resolved) {
                repos.push({
                    name,
                    status: "skipped",
                    reason: "cannot resolve origin's default branch"
                })
                emitStopped()
                terminal.log(
                    `${name}: cannot resolve origin's default branch — pass --from <ref>`
                )
                return
            }
            // First resolved target names the run's onto (when --from is unset).
            if (onto === "") {
                onto = resolved
            }

            // pre-sync GATES the rebase: a non-zero exit skips this repo (its
            // worktree is left untouched), the run CONTINUES to the next repo
            // (unlike a conflict, nothing is half-done here), and the command
            // exits non-zero at the end.
            const pre = await runHook("pre-sync", {
                config,
                workspace: root,
                task: argv.task,
                repo: { name, path: dest, url, branch },
                noHooks: argv["no-hooks"]
            })
            if (pre) {
                hooks.push(pre)
                if (pre.exit !== 0) {
                    failedHooks.push(pre)
                    repos.push({
                        name,
                        status: "skipped",
                        reason: "pre-sync hook failed"
                    })
                    terminal.log(`${name}: pre-sync hook failed — skipping`)
                    continue
                }
            }

            await repo.fetch()
            terminal.log(
                `Syncing ${name} → rebasing ${branch} onto ${resolved}`
            )
            try {
                await wt.rebase(resolved)
            } catch {
                repos.push({ name, status: "conflict" })
                emitStopped()
                terminal.log(
                    `${name}: rebase conflict — resolve in ${dest} then re-run sync (or git rebase --abort)`
                )
                return
            }
            repos.push({ name, status: "rebased" })
            synced += 1
            terminal.log(`${name}: synced`)
            // Re-carry the configured untracked local files BEFORE post-sync
            // fires, mirroring open's ordering: existing files are never
            // overwritten, so this only fills in what the worktree is missing.
            const carried = await runCarry({
                config,
                name,
                source,
                worktree: dest
            })
            if (carried) {
                carry.push({ repo: name, ...carried })
            }
            // post-sync fires for the cleanly-rebased worktree only, with cwd =
            // the worktree and branch = task/<task>. A hook failure is recorded
            // and the loop continues — the rebase already landed.
            const result = await runHook("post-sync", {
                config,
                workspace: root,
                task: argv.task,
                repo: { name, path: dest, url, branch },
                noHooks: argv["no-hooks"]
            })
            if (result) {
                hooks.push(result)
                if (result.exit !== 0) {
                    failedHooks.push(result)
                }
            }
        }

        terminal.json({ task: argv.task, onto, repos, hooks, carry })
        terminal.log(
            `Synced task ${argv.task} in ${synced} ${
                synced === 1 ? "repository" : "repositories"
            }`
        )
        // A failing post-sync never undoes its rebase (and a failing pre-sync
        // just left its repo unrebased), but the run is not clean: summarise
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
