import { defineArgument, defineCommand, terminal } from "cmdore"
import { STACK_CHILD, STACK_INDENT } from "@/stack"
import {
    age,
    openTasks,
    stackOrder,
    stackParent,
    type Task,
    type TaskRepo,
    UBERTASK_FILENAME
} from "@/tasks"

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
        // Surface each task's stack structure in the JSON: a stacked child's
        // repo entry gains `parent` (the sibling token it sits on) and `base`
        // (that sibling's branch — the ref it's stacked on). Additive and only
        // present on a child, so a non-stacked task's payload is byte-identical
        // (every repo stays `{ name, branch?, dirty }`).
        terminal.json(shown.map(withStack))

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

// The stack edge for one repo of a task, surfaced from the note: `parent` is
// the in-scope sibling token its branch stacks on (its `base` names a sibling),
// and `base` is that sibling's branch — the ref it's stacked on, derived from
// the sibling's own TaskRepo so it's the exact branch on disk. Both undefined
// for a root or an unstacked task (no note / a plain `base`), so the spread
// adds nothing then. status carries no remote-default base of its own (it's a
// branch/dirty view), so `base` appears only for a stacked child.
const stackEdge = (
    task: Task,
    repo: TaskRepo
): { parent?: string; base?: string } => {
    const parent = stackParent(
        repo.name,
        task.note?.branches,
        task.note?.repos ?? []
    )
    if (parent === undefined) {
        return {}
    }
    const base = task.repos.find((other) => other.name === parent)?.branch
    return base !== undefined ? { parent, base } : { parent }
}

// A task's repos in topological (parent-before-child) order — the order both
// the printed tree and the JSON use, so the `└─` child always follows its
// parent even though `openTasks` lists worktrees in sorted folder order (a
// child can sort before its parent). With NO stack edges stackOrder preserves
// the input order, so a non-stacked task's array is byte-identical to before.
const orderedRepos = (task: Task): TaskRepo[] => {
    const order = stackOrder(
        task.repos.map((r) => r.name),
        task.note?.branches,
        task.note?.repos ?? []
    )
    const byName = new Map(task.repos.map((r) => [r.name, r]))
    return order.map((name) => byName.get(name) as TaskRepo)
}

// Enrich a task's repo entries with their stack edge for the JSON payload, in
// topological order. Additive: the `{ name, branch?, dirty }` shape is
// untouched; a stacked child simply gains `parent`/`base`. A root / unstacked
// task is byte-identical to before (same order, no extra keys).
const withStack = (task: Task): Task => ({
    ...task,
    repos: orderedRepos(task).map((repo) => ({
        ...repo,
        ...stackEdge(task, repo)
    }))
})

// Print a task heading followed by one indented, column-aligned line per repo:
// "<name>  <branch>  <clean|dirty>". When the task carries a durable note, the
// heading gains a freshness marker: "<task>  ubertask.yml · updated <age>" (its
// mtime as a relative age), and — when the note has a goal — a second indented
// "goal: <text>" line under the heading, truncated so it stays one line. Absent
// note → no marker; note present but goal unset → the marker, no goal line.
// A STACKED child swaps its leading indent for a `└─ ` connector so its row
// hangs off the parent printed just above it (worktrees are listed in sorted
// folder order, but a repo's aliased participants cluster, so a child sits by
// its parent); a non-stacked task keeps every row's plain indent byte-for-byte.
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
    const repos = orderedRepos(task)
    const width = repos.reduce((max, r) => Math.max(max, r.name.length), 0)
    for (const repo of repos) {
        const branch = repo.branch ?? "(detached)"
        const state = repo.dirty ? "dirty" : "clean"
        const lead =
            stackEdge(task, repo).parent !== undefined
                ? STACK_CHILD
                : STACK_INDENT
        terminal.log(`${lead}${repo.name.padEnd(width)}  ${branch}  ${state}`)
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
