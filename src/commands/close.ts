import * as fs from "node:fs"
import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { task } from "@/arguments/task"
import { Config } from "@/config"
import git from "@/git"
import { force } from "@/options/force"
import { partitionScope, taskBranch, taskScope, worktreePath } from "@/tasks"
import { normalizeRepository } from "@/url"

// One repo's close outcome: `closed` (worktree + branch removed) or `skipped`
// (left intact for safety, `reason` mirroring the human line: uncommitted
// changes, or unmerged commits). Only the task's in-scope worktree-bearing
// repos appear; a stray worktree outside a non-empty scope is warned about and
// left standing, never represented as a close target.
type CloseRepo = {
    name: string
    status: "closed" | "skipped"
    reason?: string
}

export default defineCommand({
    name: "close",
    description:
        "Close a task, removing its worktree from every source repository",
    arguments: [task],
    options: [force],
    async run(argv) {
        const config = await Config.read()
        const root = await Config.root()
        const branch = taskBranch(argv.task)

        let closed = 0
        let skipped = 0

        // Only repos that are cloned AND have this task's worktree participate;
        // everything else is silently irrelevant to close.
        const present: { name: string; source: string; dest: string }[] = []
        for (const url of config.repositories) {
            const { name } = normalizeRepository(url)
            const source = path.join(root, "source", name)
            const dest = worktreePath(root, argv.task, name)
            if (!fs.existsSync(source) || !fs.existsSync(dest)) {
                continue
            }
            present.push({ name, source, dest })
        }

        // Honour the task's declared scope: close only its owned repos. A
        // worktree outside a non-empty scope is drift — warn and leave it
        // standing rather than silently removing or ignoring it. Unscoped →
        // every worktree-bearing repo, the original behaviour.
        const scope = await taskScope(root, argv.task)
        const { inScope, strays } = partitionScope(
            present.map((t) => t.name),
            scope
        )
        for (const name of strays) {
            terminal.warn(
                `${name}: worktree outside task scope (not in repos:) — leaving it; close it explicitly or add it with open --repos`
            )
        }
        const found = inScope.length > 0
        const targets = present.filter((t) => inScope.includes(t.name))
        const repos: CloseRepo[] = []

        for (const { name, source, dest } of targets) {
            const repo = git(source)
            const wt = repo.worktree(dest)

            // Without --force, pre-check safety so we never half-close a repo:
            // a dirty worktree or a branch with unmerged commits is skipped
            // intact, with a reason. --force closes regardless.
            if (!argv.force) {
                if (await wt.dirty()) {
                    repos.push({
                        name,
                        status: "skipped",
                        reason: "uncommitted changes"
                    })
                    terminal.log(`${name}: uncommitted changes — use --force`)
                    skipped += 1
                    continue
                }
                const into = await repo.remoteDefault()
                // No remote default to compare against → assume unmerged and
                // protect by default; --force overrides.
                if (!into || !(await repo.isMerged(branch, into))) {
                    repos.push({
                        name,
                        status: "skipped",
                        reason: "unmerged commits"
                    })
                    terminal.log(`${name}: unmerged commits — use --force`)
                    skipped += 1
                    continue
                }
            }

            // Safe (or --force): the worktree must go before the branch, since
            // git refuses to delete a branch that is still checked out.
            await wt.remove({ force: argv.force })
            await repo.deleteBranch(branch, { force: argv.force })
            repos.push({ name, status: "closed" })
            closed += 1
            terminal.log(`${name}: closed`)
        }

        if (!found) {
            // No in-scope worktree for the task: nothing closed, empty repos.
            terminal.json({ task: argv.task, forced: argv.force, repos: [] })
            terminal.warn(`No open task ${argv.task} to close.`)
            return
        }

        terminal.json({ task: argv.task, forced: argv.force, repos })

        terminal.log(
            `Closed task ${argv.task} in ${closed} ${
                closed === 1 ? "repository" : "repositories"
            }`
        )
        if (skipped > 0) {
            terminal.log(
                `Skipped ${skipped} ${
                    skipped === 1 ? "repository" : "repositories"
                } with unsafe changes — use --force to close anyway.`
            )
        }
    }
})
