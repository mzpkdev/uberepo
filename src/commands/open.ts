import * as fs from "node:fs"
import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { task } from "@/arguments/task"
import { Config, TASKS_DIR } from "@/config"
import git from "@/git"
import { from } from "@/options/from"
import { taskBranch, UBERTASK_FILENAME, worktreePath } from "@/tasks"
import { normalizeRepository } from "@/url"

// The seed ubertask.yml lives in the repo's real template/ dir and is byte-copied
// into a task at runtime. Resolve it relative to THIS module — not process.cwd(),
// which is the workspace — exactly as init.ts resolves its template dir, so it
// works under `npm link`. tsc rejects import.meta.url under module: CommonJS, so
// __dirname (the real src/commands/ dir) + two levels up is the template root.
const UBERTASK_TEMPLATE = path.join(
    __dirname,
    "..",
    "..",
    "template",
    UBERTASK_FILENAME
)

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

        // Seed the task's durable note at the TASK level (sibling of the per-repo
        // worktree dirs), so it survives a fresh session as the standing "why".
        // No-clobber: open is idempotent / the recovery path, so an existing note
        // is never overwritten — only a brand-new task gets the seed. Byte-copy,
        // no YAML parsing. The task dir already exists (a worktree just landed
        // under it); mkdir -p covers the all-skipped case for safety.
        const note = path.join(root, TASKS_DIR, argv.task, UBERTASK_FILENAME)
        const noteRelative = path.join(TASKS_DIR, argv.task, UBERTASK_FILENAME)
        if (fs.existsSync(note)) {
            terminal.log(`Skipping ${noteRelative} — already exists`)
        } else {
            await fs.promises.mkdir(path.dirname(note), { recursive: true })
            await fs.promises.copyFile(UBERTASK_TEMPLATE, note)
            terminal.log(`Seeded ${noteRelative}`)
        }

        terminal.log(
            `Opened task ${argv.task} in ${opened} ${
                opened === 1 ? "repository" : "repositories"
            }`
        )
    }
})
