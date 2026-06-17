import type { UberepoConfig } from "@/config"
import git from "@/git"
import {
    baseFor,
    branchFor,
    partitionScope,
    readNote,
    taskParticipants,
    worktreePath
} from "@/tasks"

// A task's per-repo footprint — the read-only computation diff and context
// share. Read-only by design: no fetch, no hooks, no carry. The comparison
// runs against the last-fetched upstream state, exactly as the refs stand on
// disk, and one repo's failure becomes a skip with a reason, never an abort.

// One commit a task branch carries beyond the comparison base: full sha plus
// subject line, newest first (plain `git log` order).
export type FootprintCommit = {
    sha: string
    subject: string
}

// One repo's slice of the task's footprint, the "ok" arm: the commits ahead
// of the merge-base with the comparison base, the diffstat over that same
// range, and whether the worktree holds uncommitted changes (which are NOT in
// the diff).
export type FootprintOk = {
    name: string
    branch: string
    ahead: number
    dirty: boolean
    files: number
    insertions: number
    deletions: number
    commits: FootprintCommit[]
    status: "ok"
}

// The "skipped" arm: nothing to compare, with `reason` mirroring the human
// line — no worktree for the task, a vanished task branch, or an unresolvable
// origin default.
export type FootprintSkipped = {
    name: string
    branch: string
    status: "skipped"
    reason: string
}

export type FootprintRepo = FootprintOk | FootprintSkipped

// The whole footprint: the comparison base that named the run (each repo
// resolves its own origin default — by convention the same ref name across
// repos — and the first resolved wins; "" until then), the per-repo entries in
// stable sorted order, and the stray worktrees outside a non-empty scope (the
// caller warns about those — they are reported nowhere else).
export type TaskFootprint = {
    base: string
    repos: FootprintRepo[]
    strays: string[]
}

// Compute a task's footprint across its repos. Honours the task's declared
// scope the way sync does: only its owned repos are reported, and a stray
// worktree outside a non-empty scope comes back in `strays`. Unlike sync, a
// scoped repo MISSING its worktree still gets an entry — the footprint should
// say "nothing here", not hide the repo. `repos` is empty exactly when the
// task is not open (no worktrees and no declared scope).
export const taskFootprint = async (
    config: UberepoConfig,
    root: string,
    task: string
): Promise<TaskFootprint> => {
    // The note carries the scope AND the per-repo branches (adopt-or-create +
    // persisted base). Read once; a legacy note resolves every repo to
    // task/<task> with no base, exactly as before.
    const note = await readNote(root, task)
    const branches = note?.branches

    // The participants that can actually be reported: every tasks/<task>/<name>
    // folder (bare or aliased) whose repo is registered AND cloned, in stable
    // sorted folder order (matches status/ship; a repo's aliases cluster
    // together, which IS the group-by-repo grouping the report wants). The
    // source/<repo> path is shared by a repo's participants.
    const participants = taskParticipants(config, root, task)
    const sourceByName = new Map(participants.map((p) => [p.name, p.source]))
    const present = participants.map((p) => p.name)

    const scope = note?.repos ?? []
    const { inScope, strays } = partitionScope(present, scope)
    const missing = scope.filter((name) => !present.includes(name))
    const targets = [...new Set([...inScope, ...missing])].sort()

    let base = ""
    const repos: FootprintRepo[] = []
    for (const name of targets) {
        const dest = worktreePath(root, task, name)
        // This participant's branch (adopted/--branch, else its default).
        const branch = branchFor(task, name, branches)
        if (!present.includes(name)) {
            repos.push({
                name,
                branch,
                status: "skipped",
                reason: "no worktree"
            })
            continue
        }
        // Source is the shared source/<repo> clone (present, by the filter
        // above); several participants of one repo all read it.
        const repo = git(sourceByName.get(name) as string)

        // The comparison base: the persisted per-participant base (an adopted
        // branch's PR base) when recorded, else the same ref sync rebases onto
        // by default — origin's default branch, resolved from the local
        // origin/HEAD symref (e.g. origin/main).
        const resolved = baseFor(name, branches) ?? (await repo.remoteDefault())
        if (!resolved) {
            repos.push({
                name,
                branch,
                status: "skipped",
                reason: "cannot resolve origin's default branch"
            })
            continue
        }
        if (base === "") {
            base = resolved
        }

        // The task branch can vanish while its worktree dir lingers (a
        // detached worktree whose branch was deleted) — report, never crash
        // the cross-repo run.
        if (!(await repo.branchExists(branch))) {
            repos.push({
                name,
                branch,
                status: "skipped",
                reason: "branch missing"
            })
            continue
        }

        const dirty = await repo.worktree(dest).dirty()
        try {
            const commits = await aheadCommits(repo, resolved, branch)
            const stat = await diffstat(repo, resolved, branch)
            repos.push({
                name,
                branch,
                ahead: commits.length,
                dirty,
                files: stat.files,
                insertions: stat.insertions,
                deletions: stat.deletions,
                commits,
                status: "ok"
            })
        } catch (error) {
            // Safety net for the odd unreadable repo (e.g. unrelated
            // histories — no merge base): one repo's failure becomes a skip,
            // never an abort of the whole report.
            repos.push({
                name,
                branch,
                status: "skipped",
                reason: error instanceof Error ? error.message : String(error)
            })
        }
    }

    return { base, repos, strays }
}

// The commits on `branch` not reachable from `base` (`git log base..branch`,
// i.e. everything past the merge-base), newest first. %x00 separates sha from
// subject so the split is unambiguous — a subject can contain neither NUL nor
// a newline.
const aheadCommits = async (
    repo: ReturnType<typeof git>,
    base: string,
    branch: string
): Promise<FootprintCommit[]> => {
    const out = await repo.raw("log", "--format=%H%x00%s", `${base}..${branch}`)
    if (out === "") {
        return []
    }
    return out.split("\n").map((line) => {
        const [sha, subject] = line.split("\u0000")
        return { sha: sha ?? "", subject: subject ?? "" }
    })
}

// The diffstat over the same range the ahead-commits cover: merge-base(base,
// branch) → branch, via the three-dot form (`git diff --shortstat
// base...branch`). git prints "N files changed, N insertions(+), N
// deletions(-)", dropping any zero part entirely (and the whole line for an
// empty range), so each number is parsed independently and defaults to 0.
const diffstat = async (
    repo: ReturnType<typeof git>,
    base: string,
    branch: string
): Promise<{ files: number; insertions: number; deletions: number }> => {
    const out = await repo.raw("diff", "--shortstat", `${base}...${branch}`)
    const files = Number(/(\d+) files? changed/.exec(out)?.[1] ?? "0")
    const insertions = Number(/(\d+) insertions?\(\+\)/.exec(out)?.[1] ?? "0")
    const deletions = Number(/(\d+) deletions?\(-\)/.exec(out)?.[1] ?? "0")
    return { files, insertions, deletions }
}
