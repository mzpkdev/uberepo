import * as fs from "node:fs"
import * as path from "node:path"
import {
    Config,
    type RepositoryEntry,
    repositoryUrl,
    TASKS_DIR
} from "@/config"
import git from "@/git"
import type { Ubertask } from "@/ubertask"
import * as ubertask from "@/ubertask"
import { normalizeRepository } from "@/url"

// The on-disk location of a participant's worktree for a task:
// <root>/tasks/<task>/<name>, where <name> is the FLAT folder name — a bare
// repo (`web`) or an aliased participant (`autopilot@bug-fix`). Folders are one
// level deep, bare and aliased alike: the typed token IS the folder name. A repo
// may now contribute SEVERAL participants to one task (two PRs in one repo), each
// its own folder; the shared source clone they branch from is source/<repo> (see
// sourceName). open/close build their target paths from this.
export const worktreePath = (
    root: string,
    task: string,
    name: string
): string => path.join(root, TASKS_DIR, task, name)

// The separator that nests an alias under a repo, used IDENTICALLY in CLI args,
// the note's `repos:` list, the branch name, and the folder name. `@` on purpose:
// `:` is illegal in Windows filenames, and `/` collides in git's ref store (a
// bare `task/T` and a nested `task/T/x` can't coexist — "cannot lock ref"),
// whereas `task/T@x` sits beside `task/T` cleanly.
export const ALIAS_SEPARATOR = "@"

// A task PARTICIPANT split into its parts: the registered repo it clones from
// (`source/<repo>`) and the optional alias that distinguishes one of a repo's
// several branches/worktrees in this task. A bare token (`web`) has no alias; an
// aliased token (`autopilot@bug-fix`) splits on the FIRST `@`. The repo segment
// is what every source/<…> and registration lookup keys on; the alias is what the
// branch leaf and (with the repo) the folder name carry.
export type Participant = {
    repo: string
    alias?: string
}

// Split a participant token into { repo, alias? }. The alias is everything after
// the first `@` (name validation forbids `@` inside either part at open time, so
// a well-formed token has at most one). A token with no `@`, or a trailing `@`
// with nothing after it, is a bare repo with no alias.
export const splitParticipant = (token: string): Participant => {
    const at = token.indexOf(ALIAS_SEPARATOR)
    if (at === -1) {
        return { repo: token }
    }
    const repo = token.slice(0, at)
    const alias = token.slice(at + 1)
    return alias === "" ? { repo } : { repo, alias }
}

// The registered repo a participant token clones from — its `source/<repo>`
// segment. THE seam that keeps aliases task-local: every source-clone lookup,
// every config/registration match, and carry all route a participant through
// here, so `autopilot@bug-fix` and `autopilot@add-feature` share the one
// source/autopilot clone and never appear in the manifest.
export const sourceName = (token: string): string =>
    splitParticipant(token).repo

// The on-disk root of a task: <root>/tasks/<task> — the dir holding the durable
// note (ubertask.yml) and, as siblings, the per-repo worktree dirs. close
// removes it once every in-scope worktree is torn down, so the note dies with
// the task.
export const taskPath = (root: string, task: string): string =>
    path.join(root, TASKS_DIR, task)

// The branch convention a task's BARE worktrees live on, by default. An aliased
// participant defaults to taskBranch@<alias> instead — see participantBranch. A
// participant can also override either (adopt a pre-existing branch) — see
// branchFor.
export const taskBranch = (task: string): string => `task/${task}`

// The DEFAULT branch a participant's worktree lives on, before any note
// override: `task/<task>` for a bare participant (`web`), and
// `task/<task>@<alias>` for an aliased one (`autopilot@bug-fix`). The alias is
// the branch leaf — joined with `@`, the same separator the folder uses and the
// one git tolerates beside a bare `task/<task>` (a `/` leaf would collide in the
// ref store). This is the fallback branchFor lands on when the note records no
// override for the participant.
export const participantBranch = (task: string, name: string): string => {
    const { alias } = splitParticipant(name)
    return alias === undefined
        ? taskBranch(task)
        : `${taskBranch(task)}${ALIAS_SEPARATOR}${alias}`
}

// The branch one PARTICIPANT's worktree lives on for a task: the override
// recorded in the note's `branches:` map (keyed by the FULL participant token,
// so a repo's several aliased branches stay distinct) when present, else the
// participant's default (`task/<task>` bare, `task/<task>@<alias>` aliased).
// This is THE resolver every command routes its branch-name derivation through,
// so a participant that adopted a pre-existing branch (recorded at open time) is
// operated on under that branch everywhere — push, rebase, merged-check, diff —
// while one with no record keeps the convention. `branches` is the parsed note's
// map ({} for a legacy or unscoped note), so a task that never adopted resolves
// to the participant default exactly as before for bare repos.
export const branchFor = (
    task: string,
    name: string,
    branches?: Record<string, { name: string }>
): string => branches?.[name]?.name ?? participantBranch(task, name)

// The persisted per-participant base for a task, or undefined when none is
// recorded. Only an ADOPTED branch whose PR base was discovered carries a base;
// a created branch records none. Keyed by the FULL participant token (so each of
// a repo's aliased branches can carry its own base). Threaded into the EXISTING
// `override ?? remoteDefault()` chain at every base consumer as
// `argv.from ?? baseFor(...) ?? remoteDefault()` — so a legacy task (no
// `branches:`) yields undefined and falls straight through to remoteDefault, the
// original behaviour. NOT a resolver of its own: it returns the stored value,
// the caller keeps its remoteDefault() tail.
export const baseFor = (
    name: string,
    branches?: Record<string, { base?: string }>
): string | undefined => branches?.[name]?.base

// The parent participant a stacked branch sits on, or undefined when the base is
// a remote ref (e.g. `develop`) or unset. A base VALUE that names another
// participant in the task's declared scope is a stack edge; anything else is not.
// Pure — `scope` is the task's participant set (note.repos). Validation guarantees
// a written stack base is same-repo + in-scope, so an in-scope base is a sibling.
// This is the SOLE classifier every consumer (ship's base translation, sync's
// flatten guard, footprint's comparison base) routes a participant's stored base
// through to tell "stack on a sibling" from "rebase/PR against a remote ref": a
// sibling token is never a git ref, so handing it to git would crash — the
// callers translate it to the parent's branch name instead (branchFor).
export const stackParent = (
    name: string,
    branches: Record<string, { base?: string }> | undefined,
    scope: string[]
): string | undefined => {
    const base = baseFor(name, branches)
    return base !== undefined && scope.includes(base) ? base : undefined
}

// Order a set of present participants so every stack PARENT comes before its
// children — the order sync's restack must walk (a child can only rebase onto a
// parent that already moved). Each participant has ≤1 stack parent (its base),
// so the edges form a FOREST; this is a stable topological sort of it. Within
// the constraint the INPUT order is preserved (the caller passes stable sorted
// folder order), so non-stacked participants keep today's order and a root sits
// exactly where it did, with its subtree threaded in right after it. `present`
// is the participants on disk and in scope; `branches`/`scope` come from the
// note. Pure — no git, no fs. Cross-repo edges can't occur (validation forbids
// them), but the sort is per the full set and harmless if a base points outside
// `present` (treated as a root). A cycle is impossible by the same validation;
// were one ever present, the guard below still emits every node exactly once
// rather than looping.
export const stackOrder = (
    present: string[],
    branches: Record<string, { base?: string }> | undefined,
    scope: string[]
): string[] => {
    const inScope = new Set(present)
    // parent token (in-scope sibling) for each present child, else undefined.
    const parentOf = new Map<string, string | undefined>()
    for (const name of present) {
        const parent = stackParent(name, branches, scope)
        // A base naming a sibling that is NOT actually present (e.g. its
        // worktree was closed) can't be a usable parent here — treat the node
        // as a root so it still rebases against its remote target.
        parentOf.set(
            name,
            parent !== undefined && inScope.has(parent) ? parent : undefined
        )
    }
    const ordered: string[] = []
    const emitted = new Set<string>()
    // Emit a node after its parent chain. `seen` breaks any (validation-
    // forbidden) cycle so a malformed note degrades to "emit once" not a hang.
    const emit = (name: string, seen: Set<string>): void => {
        if (emitted.has(name) || seen.has(name)) {
            return
        }
        seen.add(name)
        const parent = parentOf.get(name)
        if (parent !== undefined) {
            emit(parent, seen)
        }
        if (!emitted.has(name)) {
            emitted.add(name)
            ordered.push(name)
        }
    }
    for (const name of present) {
        emit(name, new Set<string>())
    }
    return ordered
}

// The per-task durable note: <root>/tasks/<task>/ubertask.yml — a sibling of the
// per-repo worktree dirs (NOT inside any worktree, NOT one-per-repo). Holds the
// "why" git can't regenerate; open seeds it, status surfaces its freshness.
export const UBERTASK_FILENAME = "ubertask.yml"

// One PARTICIPANT's slice of a task: its flat folder `name` (`repo` or
// `repo@alias` — a repo may contribute several), the branch its worktree is on
// (if any), and whether that worktree has uncommitted changes. Derived from
// `git worktree list`, so `name` is the on-disk folder, the participant identity
// every per-task command keys on.
//
// The trailing fields are the ENRICHED view openTasks({ enrich: true }) adds
// for `status --json` — all deterministic local-git, no network. They are
// ABSENT on an unenriched read (prune), so its payload stays byte-identical:
// `head` (abbreviated HEAD sha) and `detached` ride the worktree listing for
// free; `committedAt` (HEAD's ISO 8601 committer date) is the freshness signal;
// `pushed` says whether origin/<branch> exists, and `ahead`/`behind` (present
// only when pushed) count the branch's drift from it. A detached participant
// (no branch) carries none of pushed/ahead/behind.
export type TaskRepo = {
    name: string
    branch?: string
    dirty: boolean
    head?: string
    detached?: boolean
    committedAt?: string
    pushed?: boolean
    ahead?: number
    behind?: number
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
//
// `dirty` and `lastActive` are the ENRICHED task-level rollups openTasks({
// enrich: true }) adds for `status --json` — `dirty` is true when ANY repo is
// dirty (the one badge a dashboard wants per task), and `lastActive` is the
// most recent of every repo's `committedAt` and the note's mtime, as ISO 8601
// (the timestamp a dashboard sorts on). Both ABSENT on an unenriched read.
export type Task = {
    name: string
    repos: TaskRepo[]
    note?: TaskNote
    dirty?: boolean
    lastActive?: string
}

// A coarse, human relative age for an epoch-ms timestamp: "just now", "5m ago",
// "2h ago", "3d ago". Coarse on purpose — the note's freshness is a hint about
// staleness, not a precise clock; finer units would just be noise. Lives next
// to TaskNote.mtime, the timestamp it formats (status and context both use it).
export const age = (mtime: number): string => {
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

// One participant of a task that is present on disk: its folder name (`repo` or
// `repo@alias`, the identity every per-task command keys on), the bare repo it
// clones from, that repo's source/<repo> path, and its registered URL.
export type TaskParticipant = {
    name: string
    repo: string
    source: string
    url: string
}

// The participants a task currently HAS on disk: every tasks/<task>/<name> subdir
// whose backing repo (sourceName(name)) is registered AND cloned. This is the
// participant-aware replacement for the old "iterate registered repos, keep the
// ones with a worktree" loop — a repo can now back SEVERAL participant folders in
// one task, so the truth is the folders, not the manifest. Returned in stable
// sorted folder order (matches status/diff). A folder whose repo isn't registered
// or isn't cloned is skipped here (close/ship/sync never act on it); the note's
// scope partition still flags it as a stray when it's outside scope. Synchronous
// fs (existsSync/readdirSync), mirroring the loops it replaces.
export const taskParticipants = (
    config: { repositories: RepositoryEntry[] },
    root: string,
    task: string
): TaskParticipant[] => {
    // Registered repo → URL, the manifest's unit. Several participants may share
    // one repo, so this is keyed by the bare name.
    const urlByRepo = new Map<string, string>()
    for (const entry of config.repositories) {
        const url = repositoryUrl(entry)
        urlByRepo.set(normalizeRepository(url).name, url)
    }
    let folders: string[] = []
    try {
        folders = fs
            .readdirSync(taskPath(root, task), { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
    } catch {
        // No task dir → no participants.
        return []
    }
    const participants: TaskParticipant[] = []
    for (const name of folders.sort()) {
        const repo = sourceName(name)
        const url = urlByRepo.get(repo)
        const source = path.join(root, "source", repo)
        if (url === undefined || !fs.existsSync(source)) {
            continue
        }
        participants.push({ name, repo, source, url })
    }
    return participants
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
//
// `enrich` opts into the `status --json` view: extra deterministic local-git
// fields per repo (head/detached/committedAt/pushed/ahead/behind) and the
// task-level dirty/lastActive rollups. It costs a few more git calls per
// worktree, so the cheaper callers (prune) leave it off and get the exact
// shape they always did.
export const openTasks = async (options?: {
    cwd?: string
    enrich?: boolean
}): Promise<Task[]> => {
    const { cwd, enrich = false } = options ?? {}
    const config = await Config.read({ cwd })
    const root = await Config.root({ cwd })

    const byTask = new Map<string, Map<string, TaskRepo>>()
    for (const entry of config.repositories) {
        const { name } = normalizeRepository(repositoryUrl(entry))
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
            const entry: TaskRepo = {
                name: parsed.name,
                branch: worktree.branch,
                dirty: await worktree.dirty()
            }
            // Enriched (status --json): deterministic local-git fields, no
            // network. head/detached ride the listing for free; committedAt is
            // one `git log -1`; pushed + ahead/behind interrogate the
            // remote-tracking ref (origin/<branch>) — skipped wholesale for a
            // detached worktree (no branch to track), and ahead/behind only
            // once the branch is actually pushed.
            if (enrich) {
                entry.head = worktree.head.slice(0, 7)
                entry.detached = worktree.detached
                entry.committedAt = await worktree.committedAt()
                if (worktree.branch !== undefined) {
                    entry.pushed = await repo.remoteBranchExists(
                        worktree.branch
                    )
                    if (entry.pushed) {
                        const { ahead, behind } = await worktree.aheadBehind(
                            worktree.branch
                        )
                        entry.ahead = ahead
                        entry.behind = behind
                    }
                }
            }
            repos.set(parsed.name, entry)
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
            const task: Task = { name, repos, ...(note ? { note } : {}) }
            // Enriched task-level rollups (status --json): the dirty badge (any
            // repo dirty) and lastActive — the most recent of every repo's
            // committedAt and the note's mtime, as ISO 8601. Both stay absent
            // on an unenriched read, so prune's payload is byte-identical.
            if (enrich) {
                task.dirty = repos.some((repo) => repo.dirty)
                const times = repos
                    .map((repo) =>
                        repo.committedAt ? Date.parse(repo.committedAt) : 0
                    )
                    .concat(note ? [note.mtime] : [])
                const latest = Math.max(0, ...times)
                if (latest > 0) {
                    task.lastActive = new Date(latest).toISOString()
                }
            }
            return task
        })
    )
}

// The durable note for a task, or undefined when it has none: its parsed
// contents (the standing `why`) plus its mtime for freshness. Parsing is
// tolerant — a partial / hand-edited note yields its best interpretation rather
// than throwing, so a malformed note never breaks a read-only `status`.
// Exported so `context` emits the exact same TaskNote object status/open do.
export const readNote = async (
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
