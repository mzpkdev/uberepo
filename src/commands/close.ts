import * as fs from "node:fs"
import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { task } from "@/arguments/task"
import { Config } from "@/config"
import git from "@/git"
import { force } from "@/options/force"
import { taskBranch, worktreePath } from "@/tasks"
import { normalizeRepository } from "@/url"

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
        let found = false

        for (const url of config.repositories) {
            const { name } = normalizeRepository(url)
            const source = path.join(root, "source", name)
            const dest = worktreePath(root, argv.task, name)
            // Only repos that are cloned AND have this task's worktree
            // participate; everything else is silently irrelevant to close.
            if (!fs.existsSync(source) || !fs.existsSync(dest)) {
                continue
            }
            found = true

            const repo = git(source)
            const wt = repo.worktree(dest)

            // Without --force, pre-check safety so we never half-close a repo:
            // a dirty worktree or a branch with unmerged commits is skipped
            // intact, with a reason. --force closes regardless.
            if (!argv.force) {
                if (await wt.dirty()) {
                    terminal.log(`${name}: uncommitted changes — use --force`)
                    skipped += 1
                    continue
                }
                const into = await repo.remoteDefault()
                // No remote default to compare against → assume unmerged and
                // protect by default; --force overrides.
                if (!into || !(await repo.isMerged(branch, into))) {
                    terminal.log(`${name}: unmerged commits — use --force`)
                    skipped += 1
                    continue
                }
            }

            // Safe (or --force): the worktree must go before the branch, since
            // git refuses to delete a branch that is still checked out.
            await wt.remove({ force: argv.force })
            await repo.deleteBranch(branch, { force: argv.force })
            closed += 1
            terminal.log(`${name}: closed`)
        }

        if (!found) {
            terminal.warn(`No open task ${argv.task} to close.`)
            return
        }

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
