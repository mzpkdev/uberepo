import * as fs from "node:fs"
import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { task } from "@/arguments/task"
import { Config, TASKS_DIR } from "@/config"
import git from "@/git"
import { from } from "@/options/from"
import { taskBranch, worktreePath } from "@/tasks"
import { normalizeRepository } from "@/url"

export default defineCommand({
    name: "open",
    description:
        "Open a task, creating its worktree in every source repository",
    arguments: [task],
    options: [from],
    async run(argv) {
        const config = await Config.read()
        const root = await Config.root()
        const branch = taskBranch(argv.task)
        // Omitting --from branches each worktree off its clone's current HEAD.
        const base = argv.from ?? "HEAD"

        // Only cloned repos can grow a worktree; warn + skip the rest, the way
        // status does, so a partially-cloned workspace still opens what it can.
        const cloned: string[] = []
        for (const url of config.repositories) {
            const { name } = normalizeRepository(url)
            if (fs.existsSync(path.join(root, "source", name))) {
                cloned.push(name)
            } else {
                terminal.log(`Skipping ${name} — not cloned (run clone first)`)
            }
        }

        if (cloned.length === 0) {
            terminal.log("Nothing to open — no cloned repositories.")
            return
        }

        let opened = 0
        for (const name of cloned) {
            const dest = worktreePath(root, argv.task, name)
            const relative = path.join(TASKS_DIR, argv.task, name)
            // Idempotent: an existing worktree dir is left untouched. This is
            // also the recovery path — re-running open skips the done repos
            // and resumes after a mid-run failure.
            if (fs.existsSync(dest)) {
                terminal.log(
                    `Skipping ${name} — worktree already open at ${relative}`
                )
                continue
            }
            terminal.log(
                `Opening ${name} → ${relative} (${branch} from ${base})`
            )
            // Fail-fast: a creation error propagates, stopping before any
            // later repo is touched; already-created worktrees stay put.
            const repo = git(path.join(root, "source", name))
            await repo.worktree(dest).create({ branch, from: base })
            opened += 1
        }

        terminal.log(
            `Opened task ${argv.task} in ${opened} ${
                opened === 1 ? "repository" : "repositories"
            }`
        )
    }
})
