import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { Config } from "@/config"
import git, { type Repository } from "@/git"
import { force } from "@/options/force"
import { openTasks, type Task, taskBranch, worktreePath } from "@/tasks"
import { normalizeRepository } from "@/url"

// A task's repos paired with their source repository and on-disk worktree.
type Target = { name: string; repo: Repository; dest: string }

// Map a task's flat repo names to their source repositories + worktree paths.
// A repo only participates when it is registered in the config AND cloned
// (source/<name>); open tasks are derived from those same source registries,
// so this resolves every repo a task's worktrees live in.
const targetsOf = async (task: Task): Promise<Target[]> => {
    const config = await Config.read()
    const root = await Config.root()
    const byName = new Map<string, string>()
    for (const url of config.repositories) {
        const { name } = normalizeRepository(url)
        byName.set(name, path.join(root, "source", name))
    }
    const targets: Target[] = []
    for (const repo of task.repos) {
        const source = byName.get(repo.name)
        if (source) {
            targets.push({
                name: repo.name,
                repo: git(source),
                dest: worktreePath(root, task.name, repo.name)
            })
        }
    }
    return targets
}

// Whether a single repo's task branch is "done": merged into the repo's own
// remote default branch. Fetches first so "merged" reflects the latest origin
// default; a fetch failure (offline/no remote) is tolerated and we fall back
// to the last-known remote refs.
const repoDone = async (repo: Repository, branch: string): Promise<boolean> => {
    try {
        await repo.fetch()
    } catch {
        // Offline or no remote: classify against the last fetched refs.
    }
    const onto = await repo.remoteDefault()
    return Boolean(onto) && (await repo.isMerged(branch, onto as string))
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
            terminal.log("No open tasks.")
            return
        }

        // Classify every open task as prunable (atomic-done + clean) or kept.
        // A task is prunable only when no worktree is dirty AND every repo's
        // task branch is merged into its own remote default. Any dirty worktree
        // or any not-yet-merged repo keeps the task — that atomic+clean filter
        // is prune's safety net.
        const prunable: { task: Task; targets: Target[] }[] = []
        let kept = 0
        for (const task of tasks) {
            if (task.repos.some((repo) => repo.dirty)) {
                kept += 1
                continue
            }
            const branch = taskBranch(task.name)
            const targets = await targetsOf(task)
            let done = targets.length > 0
            for (const target of targets) {
                if (!(await repoDone(target.repo, branch))) {
                    done = false
                    break
                }
            }
            if (done) {
                prunable.push({ task, targets })
            } else {
                kept += 1
            }
        }

        if (prunable.length === 0) {
            terminal.log(
                `Nothing to prune — ${kept} ${
                    kept === 1 ? "task" : "tasks"
                } still active.`
            )
            return
        }

        // Preview by default: list what would go, change nothing.
        if (!argv.force) {
            for (const { task } of prunable) {
                const names = task.repos.map((repo) => repo.name).join(", ")
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
        for (const { task, targets } of prunable) {
            const branch = taskBranch(task.name)
            try {
                for (const { repo, dest } of targets) {
                    // The worktree must go before its branch: git refuses to
                    // delete a branch that is still checked out.
                    await repo.worktree(dest).remove()
                    await repo.deleteBranch(branch)
                }
                pruned += 1
                terminal.log(`Pruned ${task.name}`)
            } catch (error) {
                failed += 1
                const reason =
                    error instanceof Error ? error.message : String(error)
                terminal.warn(`${task.name}: could not prune — ${reason}`)
            }
        }

        terminal.log(`Pruned ${pruned} ${pruned === 1 ? "task" : "tasks"}.`)
        if (failed > 0) {
            terminal.warn(
                `Failed to prune ${failed} ${failed === 1 ? "task" : "tasks"}.`
            )
        }
    }
})
