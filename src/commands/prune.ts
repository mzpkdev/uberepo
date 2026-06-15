import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { Config, repositoryUrl } from "@/config"
import git, { type Repository } from "@/git"
import { force } from "@/options/force"
import {
    baseFor,
    branchFor,
    openTasks,
    partitionScope,
    type Task,
    worktreePath
} from "@/tasks"
import { normalizeRepository } from "@/url"

// A task's repos paired with their source repository, on-disk worktree, the
// branch the worktree is on (adopted/--branch, else task/<task>), whether that
// branch was ADOPTED (then never deleted), and the persisted per-repo base
// (undefined → fall back to remoteDefault in the merged-check).
type Target = {
    name: string
    repo: Repository
    dest: string
    branch: string
    adopted: boolean
    base?: string
}

// One task's prune outcome. `pruned` = removed (or, in preview mode where
// `forced` is false, would be removed — its branches are merged and its
// worktrees clean); `kept` = retained, `reason` saying why (dirty, unmerged,
// or — only when --force actually ran — the error that blocked removal). Read
// `forced` to tell a preview's `pruned` (a candidate) from a real removal.
type PruneTask = {
    task: string
    status: "pruned" | "kept"
    reason?: string
}

// Map a task's IN-SCOPE flat repo names to their source repositories + worktree
// paths. A repo only participates when it is registered in the config AND cloned
// (source/<name>); open tasks are derived from those same source registries, so
// this resolves every in-scope repo a task's worktrees live in. Worktrees
// outside the task's declared scope are NOT targets — prune leaves drift to the
// caller to warn about, never removing a stray as a side effect.
const targetsOf = async (task: Task): Promise<Target[]> => {
    const config = await Config.read()
    const root = await Config.root()
    const byName = new Map<string, string>()
    for (const entry of config.repositories) {
        const { name } = normalizeRepository(repositoryUrl(entry))
        byName.set(name, path.join(root, "source", name))
    }
    const branches = task.note?.branches
    const { inScope } = partitionScope(
        task.repos.map((repo) => repo.name),
        task.note?.repos ?? []
    )
    const targets: Target[] = []
    for (const name of inScope) {
        const source = byName.get(name)
        if (source) {
            targets.push({
                name,
                repo: git(source),
                dest: worktreePath(root, task.name, name),
                branch: branchFor(task.name, name, branches),
                adopted: branches?.[name]?.adopted ?? false,
                base: baseFor(name, branches)
            })
        }
    }
    return targets
}

// The in-scope worktree-bearing repos of a task, and the strays drifting outside
// a non-empty declared scope — the same split prune's targets use, surfaced so
// the dirty-check and the stray warning agree on what "the task" is.
const splitScope = (task: Task): { inScope: string[]; strays: string[] } =>
    partitionScope(
        task.repos.map((repo) => repo.name),
        task.note?.repos ?? []
    )

// Whether a single repo's task branch is "done" for pruning. An ADOPTED branch
// is always done: prune never deletes it (it predates the task), so its merge
// state must not pin the task open. Otherwise "done" = the created branch is
// merged into its base — the persisted per-repo base when one was recorded,
// else the repo's remote default. Fetches first so "merged" reflects the
// latest origin default; a fetch failure (offline/no remote) is tolerated and
// we classify against the last-known remote refs.
const repoDone = async (target: Target): Promise<boolean> => {
    if (target.adopted) {
        return true
    }
    try {
        await target.repo.fetch()
    } catch {
        // Offline or no remote: classify against the last fetched refs.
    }
    const onto = target.base ?? (await target.repo.remoteDefault())
    return (
        Boolean(onto) &&
        (await target.repo.isMerged(target.branch, onto as string))
    )
}

export default defineCommand({
    name: "prune",
    description:
        "Prune tasks whose branches have been merged, removing their worktrees",
    options: [force],
    async run(argv) {
        await Config.read()

        const tasks = await openTasks()
        if (tasks.length === 0) {
            terminal.json({ forced: argv.force, tasks: [] })
            terminal.log("No open tasks.")
            return
        }

        // Classify every open task as prunable (atomic-done + clean) or kept.
        // A task is prunable only when no worktree is dirty AND every repo's
        // task branch is merged into its own remote default. Any dirty worktree
        // or any not-yet-merged repo keeps the task — that atomic+clean filter
        // is prune's safety net.
        const prunable: { task: Task; targets: Target[] }[] = []
        // Per-task outcomes for the JSON view; the human path keeps its counts.
        // `kept` mirrors the previous counter (every retained task lands here).
        const kept: PruneTask[] = []
        for (const task of tasks) {
            // Drift: a worktree outside a non-empty scope is warned about and
            // left standing — prune evaluates and acts only on in-scope repos.
            const { inScope, strays } = splitScope(task)
            for (const name of strays) {
                terminal.warn(
                    `${task.name}/${name}: worktree outside task scope (not in repos:) — leaving it`
                )
            }
            // Dirty check over IN-SCOPE repos only: a dirty stray must not pin a
            // scoped task open, and a clean stray must not let it prune away.
            const inScopeRepos = task.repos.filter((repo) =>
                inScope.includes(repo.name)
            )
            if (inScopeRepos.some((repo) => repo.dirty)) {
                kept.push({ task: task.name, status: "kept", reason: "dirty" })
                continue
            }
            const targets = await targetsOf(task)
            let done = targets.length > 0
            for (const target of targets) {
                if (!(await repoDone(target))) {
                    done = false
                    break
                }
            }
            if (done) {
                prunable.push({ task, targets })
            } else {
                kept.push({
                    task: task.name,
                    status: "kept",
                    reason: "unmerged"
                })
            }
        }

        if (prunable.length === 0) {
            // Nothing prunable: every task is kept (with its reason recorded).
            terminal.json({ forced: argv.force, tasks: kept })
            terminal.log(
                `Nothing to prune — ${kept.length} ${
                    kept.length === 1 ? "task" : "tasks"
                } still active.`
            )
            return
        }

        // Preview by default: list what would go, change nothing. Name the
        // repos that will actually be pruned (the in-scope targets), so a scoped
        // task's preview never implies it'll touch a drifted stray.
        if (!argv.force) {
            // Preview JSON: prunable tasks read as `pruned` candidates (forced
            // is false, so the agent knows nothing was removed yet); the rest
            // keep their kept reasons. Order: candidates first, then kept.
            const tasks: PruneTask[] = [
                ...prunable.map(({ task }) => ({
                    task: task.name,
                    status: "pruned" as const
                })),
                ...kept
            ]
            terminal.json({ forced: argv.force, tasks })
            for (const { task, targets } of prunable) {
                const names = targets.map((target) => target.name).join(", ")
                terminal.log(`would prune ${task.name} (${names})`)
            }
            terminal.log(
                `Run prune --force to remove ${prunable.length} ${
                    prunable.length === 1 ? "task" : "tasks"
                }.`
            )
            return
        }

        // Apply: prune already verified merged+clean, so use the SAFE removal
        // forms (git is a backstop to our own filter). If a task errors, report
        // it and keep sweeping the rest rather than aborting everything.
        let pruned = 0
        let failed = 0
        const applied: PruneTask[] = []
        for (const { task, targets } of prunable) {
            try {
                for (const { repo, dest, branch, adopted } of targets) {
                    // The worktree must go before its branch: git refuses to
                    // delete a branch that is still checked out. An ADOPTED
                    // branch is never deleted — remove only its worktree (the
                    // data-loss guard, same as close).
                    await repo.worktree(dest).remove()
                    if (!adopted) {
                        await repo.deleteBranch(branch)
                    }
                }
                pruned += 1
                applied.push({ task: task.name, status: "pruned" })
                terminal.log(`Pruned ${task.name}`)
            } catch (error) {
                failed += 1
                const reason =
                    error instanceof Error ? error.message : String(error)
                // A prune that errored leaves the task standing — report it as
                // kept, carrying the failure as its reason.
                applied.push({ task: task.name, status: "kept", reason })
                terminal.warn(`${task.name}: could not prune — ${reason}`)
            }
        }

        // Outcomes for every open task: the ones we tried to prune (pruned or
        // kept-on-error), then the ones the safety filter kept up front.
        terminal.json({ forced: argv.force, tasks: [...applied, ...kept] })
        terminal.log(`Pruned ${pruned} ${pruned === 1 ? "task" : "tasks"}.`)
        if (failed > 0) {
            terminal.warn(
                `Failed to prune ${failed} ${failed === 1 ? "task" : "tasks"}.`
            )
        }
    }
})
