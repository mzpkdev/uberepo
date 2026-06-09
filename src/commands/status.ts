import { defineArgument, defineCommand, terminal } from "cmdore"
import { openTasks, type Task } from "@/tasks"

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

        if (argv.task) {
            const wanted = tasks.find((t) => t.name === argv.task)
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
// "<name>  <branch>  <clean|dirty>".
const print = (task: Task) => {
    terminal.log(task.name)
    const width = task.repos.reduce((max, r) => Math.max(max, r.name.length), 0)
    for (const repo of task.repos) {
        const branch = repo.branch ?? "(detached)"
        const state = repo.dirty ? "dirty" : "clean"
        terminal.log(`  ${repo.name.padEnd(width)}  ${branch}  ${state}`)
    }
}
