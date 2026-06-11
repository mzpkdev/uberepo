import { defineArgument, defineCommand, terminal } from "cmdore"
import { openTasks, type Task, UBERTASK_FILENAME } from "@/tasks"

const task = defineArgument({
    name: "task",
    required: false,
    description: "Task (worktree set) name"
})

export default defineCommand({
    name: "status",
    description: "Show open tasks and the state of their worktrees",
    arguments: [task],
    async run(argv) {
        const tasks = await openTasks()

        // The exact set the human view renders: every task, or just the named
        // one when filtered. JSON emits this same list so both views agree
        // (nonexistent task / no open tasks -> []).
        const shown = argv.task
            ? tasks.filter((t) => t.name === argv.task)
            : tasks
        terminal.json(shown)

        if (argv.task) {
            const wanted = shown[0]
            if (!wanted) {
                terminal.log(`No such open task: ${argv.task}`)
                return
            }
            print(wanted)
            return
        }

        if (tasks.length === 0) {
            terminal.log("No open tasks.")
            return
        }

        tasks.forEach((t, index) => {
            if (index > 0) {
                terminal.log("")
            }
            print(t)
        })
    }
})

// Print a task heading followed by one indented, column-aligned line per repo:
// "<name>  <branch>  <clean|dirty>". When the task carries a durable note, the
// heading gains a freshness marker: "<task>  ubertask.yml · updated <age>" — its
// mtime as a relative age, NOT its contents (git owns the live state). Absent
// note → the marker is simply omitted.
const print = (task: Task) => {
    const heading = task.note
        ? `${task.name}  ${UBERTASK_FILENAME} · updated ${age(task.note.mtime)}`
        : task.name
    terminal.log(heading)
    const width = task.repos.reduce((max, r) => Math.max(max, r.name.length), 0)
    for (const repo of task.repos) {
        const branch = repo.branch ?? "(detached)"
        const state = repo.dirty ? "dirty" : "clean"
        terminal.log(`  ${repo.name.padEnd(width)}  ${branch}  ${state}`)
    }
}

// A coarse, human relative age for an epoch-ms timestamp: "just now", "5m ago",
// "2h ago", "3d ago". Coarse on purpose — the note's freshness is a hint about
// staleness, not a precise clock; finer units would just be noise.
const age = (mtime: number): string => {
    const seconds = Math.max(0, Math.round((Date.now() - mtime) / 1000))
    if (seconds < 60) {
        return "just now"
    }
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) {
        return `${minutes}m ago`
    }
    const hours = Math.floor(minutes / 60)
    if (hours < 24) {
        return `${hours}h ago`
    }
    const days = Math.floor(hours / 24)
    return `${days}d ago`
}
