import * as fs from "node:fs"
import * as path from "node:path"
import { Config, TASKS_DIR } from "@/config"
import git from "@/git"
import { normalizeRepository } from "@/url"

// The on-disk location of a repo's worktree for a task:
// <root>/tasks/<task>/<name>, where <name> is the flat folder a repo clones
// to under source/. open/close build their target paths from this.
export const worktreePath = (
    root: string,
    task: string,
    name: string
): string => path.join(root, TASKS_DIR, task, name)

// The branch convention a task's worktrees live on.
export const taskBranch = (task: string): string => `task/${task}`

// The per-task durable note: <root>/tasks/<task>/ubertask.yml — a sibling of the
// per-repo worktree dirs (NOT inside any worktree, NOT one-per-repo). Holds the
// "why" git can't regenerate; open seeds it, status surfaces its freshness.
export const UBERTASK_FILENAME = "ubertask.yml"

// One source repository's participation in a task: which flat name it clones
// to, the branch its worktree is on (if any), and whether that worktree has
// uncommitted changes.
export type TaskRepo = {
    name: string
    branch?: string
    dirty: boolean
}

// The per-task durable note (ubertask.yml) when present, surfaced as freshness
// only: `mtime` is its last-modified time in epoch milliseconds (fs.stat). The
// file is never parsed — git holds the live state; this is just "how stale is
// the standing context". Absent file → omitted, so `note` undefined means none.
export type TaskNote = {
    mtime: number
}

// A task and the per-repo worktrees that make it up. `repos` is ordered by
// flat name for stable output. `note` carries the durable note's freshness when
// the task has a ubertask.yml; it is omitted entirely when there is none.
export type Task = {
    name: string
    repos: TaskRepo[]
    note?: TaskNote
}

// Parse a worktree path of the form <root>/tasks/<task>/<name> into its task
// and name segments. Returns undefined when the path is not under
// <root>/tasks/ or does not have exactly the expected depth.
const parseTaskPath = (
    root: string,
    worktree: string
): { task: string; name: string } | undefined => {
    const tasksRoot = path.join(root, TASKS_DIR)
    const relative = path.relative(tasksRoot, worktree)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return undefined
    }
    const segments = relative.split(path.sep)
    if (segments.length !== 2 || !segments[0] || !segments[1]) {
        return undefined
    }
    return { task: segments[0], name: segments[1] }
}

// Enumerate the open tasks of a workspace, deriving truth from git rather than
// from stray directories: for each registered repo that is actually cloned
// (source/<name> exists), read its real worktree registry and keep the
// worktrees living under <root>/tasks/. Worktrees are grouped by task, and
// both tasks and their repos come back in stable (sorted) order.
export const openTasks = async (options?: {
    cwd?: string
}): Promise<Task[]> => {
    const config = await Config.read(options)
    const root = await Config.root(options)

    const byTask = new Map<string, Map<string, TaskRepo>>()
    for (const url of config.repositories) {
        const { name } = normalizeRepository(url)
        const source = path.join(root, "source", name)
        if (!fs.existsSync(source)) {
            continue
        }
        const repo = git(source)
        for (const worktree of await repo.worktrees()) {
            const parsed = parseTaskPath(root, worktree.path)
            if (!parsed) {
                continue
            }
            const repos = byTask.get(parsed.task) ?? new Map<string, TaskRepo>()
            repos.set(parsed.name, {
                name: parsed.name,
                branch: worktree.branch,
                dirty: await worktree.dirty()
            })
            byTask.set(parsed.task, repos)
        }
    }

    return Promise.all(
        [...byTask.keys()].sort().map(async (name) => {
            const repos = [
                ...(byTask.get(name) as Map<string, TaskRepo>).values()
            ].sort((a, b) => a.name.localeCompare(b.name))
            const note = await readNote(root, name)
            // Spread keeps `note` off the object entirely when absent, so the
            // JSON shape gains the key only for tasks that actually have one.
            return { name, repos, ...(note ? { note } : {}) }
        })
    )
}

// The durable note's freshness for a task, or undefined when it has none. Reads
// only fs.stat mtime — never the file contents (git owns the live state); the
// note is a standing hint whose staleness is all status needs to surface.
const readNote = async (
    root: string,
    task: string
): Promise<TaskNote | undefined> => {
    const file = path.join(root, TASKS_DIR, task, UBERTASK_FILENAME)
    try {
        const stat = await fs.promises.stat(file)
        return { mtime: stat.mtimeMs }
    } catch {
        return undefined
    }
}
