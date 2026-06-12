import { defineArgument, defineCommand, terminal } from "cmdore"
import { age, openTasks, type Task, UBERTASK_FILENAME } from "@/tasks"

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
// heading gains a freshness marker: "<task>  ubertask.yml · updated <age>" (its
// mtime as a relative age), and — when the note has a goal — a second indented
// "goal: <text>" line under the heading, truncated so it stays one line. Absent
// note → no marker; note present but goal unset → the marker, no goal line.
const print = (task: Task) => {
    const heading = task.note
        ? `${task.name}  ${UBERTASK_FILENAME} · updated ${age(task.note.mtime)}`
        : task.name
    terminal.log(heading)
    if (task.note && task.note.goal !== "") {
        terminal.log(`  goal: ${truncate(task.note.goal)}`)
    }
    // Surface the task's declared scope (the repos it owns) when set. An empty
    // scope is unscoped — every cloned repo — so there's nothing to single out.
    if (task.note && task.note.repos.length > 0) {
        terminal.log(`  scope: ${task.note.repos.join(", ")}`)
    }
    const width = task.repos.reduce((max, r) => Math.max(max, r.name.length), 0)
    for (const repo of task.repos) {
        const branch = repo.branch ?? "(detached)"
        const state = repo.dirty ? "dirty" : "clean"
        terminal.log(`  ${repo.name.padEnd(width)}  ${branch}  ${state}`)
    }
}

// Collapse a (possibly multi-line) goal to a single line and cap its length, so
// the heading's goal line never wraps or runs long. Whitespace/newlines fold to
// single spaces; anything past the cap becomes an ellipsis. The note carries
// the full text — this is a glance, not the source of truth.
const GOAL_MAX = 72
const truncate = (goal: string): string => {
    const line = goal.replace(/\s+/g, " ").trim()
    return line.length > GOAL_MAX ? `${line.slice(0, GOAL_MAX - 1)}…` : line
}
