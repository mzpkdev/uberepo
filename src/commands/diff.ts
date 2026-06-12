import { defineCommand, terminal } from "cmdore"
import { task } from "@/arguments/task"
import { Config } from "@/config"
import { type FootprintRepo, taskFootprint } from "@/footprint"

export default defineCommand({
    name: "diff",
    description:
        "Show a task's footprint: commits ahead and diffstat per repository",
    arguments: [task],
    async run(argv) {
        const config = await Config.read()
        const root = await Config.root()

        // The shared per-repo computation (footprint.ts, also behind
        // `context`): per repo, the commits ahead of the merge-base with the
        // comparison base, the diffstat over that range, and the dirty flag.
        // Read-only by design: no fetch, no hooks, no carry.
        const { base, repos, strays } = await taskFootprint(
            config,
            root,
            argv.task
        )
        for (const name of strays) {
            terminal.warn(
                `${name}: worktree outside task scope (not in repos:) — skipping; close it or add it with open --repos`
            )
        }

        if (repos.length === 0) {
            terminal.json({ task: argv.task, base, repos: [] })
            terminal.warn(`No open task ${argv.task} to diff.`)
            return
        }

        terminal.json({ task: argv.task, base, repos })
        print(argv.task, base, repos)
    }
})

// Print the task heading ("<task>  vs <base>" once a base resolved) followed
// by one indented, column-aligned line per repo — "<name>  <branch>  <N>
// commit(s) ahead  <N> file(s) +ins -del  <clean|dirty>" — then the commit
// subjects, each as "<sha7> <subject>". The diffstat chunk is omitted at 0
// ahead (all zeros by construction), and a skipped repo collapses to
// "<name>  skipped — <reason>". Dirty means uncommitted changes exist; they
// are NOT in the numbers shown.
const print = (task: string, base: string, repos: FootprintRepo[]): void => {
    terminal.log(base === "" ? task : `${task}  vs ${base}`)
    const width = repos.reduce((max, r) => Math.max(max, r.name.length), 0)
    for (const repo of repos) {
        if (repo.status === "skipped") {
            terminal.log(
                `  ${repo.name.padEnd(width)}  skipped — ${repo.reason}`
            )
            continue
        }
        const ahead = `${repo.ahead} ${
            repo.ahead === 1 ? "commit" : "commits"
        } ahead`
        const stat = `${repo.files} ${
            repo.files === 1 ? "file" : "files"
        } +${repo.insertions} -${repo.deletions}`
        const state = repo.dirty ? "dirty" : "clean"
        const columns = [repo.name.padEnd(width), repo.branch, ahead]
        if (repo.ahead > 0) {
            columns.push(stat)
        }
        columns.push(state)
        terminal.log(`  ${columns.join("  ")}`)
        for (const commit of repo.commits) {
            terminal.log(`    ${commit.sha.slice(0, 7)} ${commit.subject}`)
        }
    }
}
