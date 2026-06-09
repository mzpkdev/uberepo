import * as fs from "node:fs"
import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { task } from "@/arguments/task"
import { Config } from "@/config"
import git from "@/git"
import { from } from "@/options/from"
import { taskBranch, worktreePath } from "@/tasks"
import { normalizeRepository } from "@/url"

export default defineCommand({
    name: "sync",
    description: "Sync an open task's worktrees with their upstream branches",
    arguments: [task],
    options: [from],
    async run(argv) {
        const config = await Config.read()
        const root = await Config.root()
        const branch = taskBranch(argv.task)

        // The task's worktrees across cloned repos: a repo participates only
        // when it is both cloned (source/<name>) and has this task's worktree.
        const targets: { name: string; source: string; dest: string }[] = []
        for (const url of config.repositories) {
            const { name } = normalizeRepository(url)
            const source = path.join(root, "source", name)
            const dest = worktreePath(root, argv.task, name)
            if (!fs.existsSync(source) || !fs.existsSync(dest)) {
                continue
            }
            targets.push({ name, source, dest })
        }

        if (targets.length === 0) {
            terminal.warn(`No open task ${argv.task} to sync.`)
            return
        }

        // Pre-flight: refuse to touch anything if any of the task's worktrees
        // is dirty. Rebasing a dirty tree would either fail mid-way or strand
        // uncommitted work, so we clean preconditions before any side effect.
        const dirty: string[] = []
        for (const target of targets) {
            const wt = git(target.source).worktree(target.dest)
            if (await wt.dirty()) {
                dirty.push(target.name)
            }
        }
        if (dirty.length > 0) {
            for (const name of dirty) {
                terminal.log(
                    `${name}: uncommitted changes — commit or stash first`
                )
            }
            return
        }

        // Sync sequentially. On the first repo whose rebase conflicts we stop
        // and leave that rebase in progress (the signal for the user to resolve
        // or abort), deliberately not touching the repos that follow.
        let synced = 0
        for (const target of targets) {
            const { name, source, dest } = target
            const repo = git(source)
            const wt = repo.worktree(dest)

            // Resolve the rebase target before fetching. An explicit --from ref
            // wins; otherwise we resolve the remote default branch *name* (e.g.
            // origin/main) from the local origin/HEAD symref. Resolving first
            // means a missing/unconfigured origin yields a clean error instead
            // of a raw fetch failure, and never rebases onto a guessed target.
            // The name is stable across the fetch; fetch then advances what it
            // points at, so the rebase still lands on the freshest upstream.
            const onto = argv.from ?? (await repo.remoteDefault())
            if (!onto) {
                terminal.log(
                    `${name}: cannot resolve origin's default branch — pass --from <ref>`
                )
                return
            }

            await repo.fetch()
            terminal.log(`Syncing ${name} → rebasing ${branch} onto ${onto}`)
            try {
                await wt.rebase(onto)
            } catch {
                terminal.log(
                    `${name}: rebase conflict — resolve in ${dest} then re-run sync (or git rebase --abort)`
                )
                return
            }
            synced += 1
            terminal.log(`${name}: synced`)
        }

        terminal.log(
            `Synced task ${argv.task} in ${synced} ${
                synced === 1 ? "repository" : "repositories"
            }`
        )
    }
})
