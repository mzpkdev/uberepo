import * as fs from "node:fs"
import * as path from "node:path"
import { Config, TASKS_DIR } from "@/config"
import git from "@/git"
import type { Ubertask } from "@/ubertask"
import * as ubertask from "@/ubertask"
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

// The per-task durable note (ubertask.yml) when present: its parsed contents
// (goal / tickets / decisions / blockers — the `why` git can't regenerate) plus
// `mtime`, its last-modified time in epoch milliseconds (fs.stat) for freshness.
// The parsed fields are always present (goal "" / lists [] when unset), so the
// shape is stable. Absent file → omitted, so `note` undefined means none.
export type TaskNote = Ubertask & {
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

// A task's declared scope: the flat source/<name> repos it OWNS, read from its
// ubertask.yml `repos:`. [] means unscoped — commands fan out to every cloned
// repo with a worktree, the original behaviour. A missing/parseless note is
// also unscoped. Tolerant by the same logic as readNote: the note is a hint, so
// a half-edited one never breaks a command — it just reads as unscoped.
export const taskScope = async (
    root: string,
    task: string
): Promise<string[]> => {
    const file = path.join(root, TASKS_DIR, task, UBERTASK_FILENAME)
    const note = await ubertask.read(file)
    return note?.repos ?? []
}

// Split a task's worktree-bearing repos against its declared scope: the repos
// to operate on (in-scope ∩ has-worktree, or all worktree-bearing when
// unscoped) and the strays (worktrees OUTSIDE a non-empty scope). The caller
// warns about strays and acts only on `inScope`, so a drifted worktree is
// neither silently touched nor silently ignored. `present` is the set of repo
// names that currently have a worktree for the task; order is preserved.
export const partitionScope = (
    present: string[],
    scope: string[]
): { inScope: string[]; strays: string[] } => {
    if (scope.length === 0) {
        return { inScope: present, strays: [] }
    }
    const inScope: string[] = []
    const strays: string[] = []
    for (const name of present) {
        if (scope.includes(name)) {
            inScope.push(name)
        } else {
            strays.push(name)
        }
    }
    return { inScope, strays }
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

// The durable note for a task, or undefined when it has none: its parsed
// contents (the standing `why`) plus its mtime for freshness. Parsing is
// tolerant — a partial / hand-edited note yields its best interpretation rather
// than throwing, so a malformed note never breaks a read-only `status`.
const readNote = async (
    root: string,
    task: string
): Promise<TaskNote | undefined> => {
    const file = path.join(root, TASKS_DIR, task, UBERTASK_FILENAME)
    let stat: fs.Stats
    try {
        stat = await fs.promises.stat(file)
    } catch {
        return undefined
    }
    const parsed = await ubertask.read(file)
    // stat saw the file; a vanished file between stat and read (or a non-file)
    // is the only way read() comes back empty — treat it as "no note".
    if (!parsed) {
        return undefined
    }
    return { ...parsed, mtime: stat.mtimeMs }
}
