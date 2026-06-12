import * as fs from "node:fs"
import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { task } from "@/arguments/task"
import { Config, repositoryUrl } from "@/config"
import git from "@/git"
import { partitionScope, taskBranch, taskScope, worktreePath } from "@/tasks"
import { normalizeRepository } from "@/url"

// One commit a task branch carries beyond the comparison base: full sha plus
// subject line, newest first (plain `git log` order).
type DiffCommit = {
    sha: string
    subject: string
}

// One repo's slice of the task's footprint. `ok` carries the numbers: the
// commits ahead of the merge-base with the comparison base, the diffstat over
// that same range, and whether the worktree holds uncommitted changes (which
// are NOT in the diff). `skipped` = nothing to compare, with `reason`
// mirroring the human line: no worktree for the task, a vanished task branch,
// or an unresolvable origin default.
type DiffRepo =
    | {
          name: string
          branch: string
          ahead: number
          dirty: boolean
          files: number
          insertions: number
          deletions: number
          commits: DiffCommit[]
          status: "ok"
      }
    | {
          name: string
          branch: string
          status: "skipped"
          reason: string
      }

export default defineCommand({
    name: "diff",
    description:
        "Show a task's footprint: commits ahead and diffstat per repository",
    arguments: [task],
    async run(argv) {
        const config = await Config.read()
        const root = await Config.root()
        const branch = taskBranch(argv.task)

        // The repos that can actually be diffed: registered AND cloned
        // (source/<name> exists) AND holding this task's worktree, in stable
        // sorted order (matches status/ship).
        const present: string[] = []
        for (const entry of config.repositories) {
            const { name } = normalizeRepository(repositoryUrl(entry))
            const source = path.join(root, "source", name)
            const dest = worktreePath(root, argv.task, name)
            if (fs.existsSync(source) && fs.existsSync(dest)) {
                present.push(name)
            }
        }
        present.sort()

        // Honour the task's declared scope the way sync does: report only its
        // owned repos and warn about a stray worktree outside a non-empty
        // scope. Unlike sync, a scoped repo MISSING its worktree still gets a
        // line — the footprint should say "nothing here", not hide the repo.
        const scope = await taskScope(root, argv.task)
        const { inScope, strays } = partitionScope(present, scope)
        for (const name of strays) {
            terminal.warn(
                `${name}: worktree outside task scope (not in repos:) — skipping; close it or add it with open --repos`
            )
        }
        const missing = scope.filter((name) => !present.includes(name))
        const targets = [...new Set([...inScope, ...missing])].sort()

        // The comparison base, reported in the JSON: each repo resolves its
        // own origin default (by convention the same ref name across repos),
        // and the first resolved names the run. Empty until then.
        let base = ""

        if (targets.length === 0) {
            terminal.json({ task: argv.task, base, repos: [] })
            terminal.warn(`No open task ${argv.task} to diff.`)
            return
        }

        // Read-only by design: no fetch, no hooks, no carry. The comparison
        // runs against the last-fetched upstream state, exactly as the refs
        // stand on disk.
        const repos: DiffRepo[] = []
        for (const name of targets) {
            const source = path.join(root, "source", name)
            const dest = worktreePath(root, argv.task, name)
            if (!present.includes(name)) {
                repos.push({
                    name,
                    branch,
                    status: "skipped",
                    reason: "no worktree"
                })
                continue
            }
            const repo = git(source)

            // The comparison base is the same ref sync rebases onto by
            // default: origin's default branch, resolved from the local
            // origin/HEAD symref (e.g. origin/main).
            const resolved = await repo.remoteDefault()
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
            // detached worktree whose branch was deleted) — report, never
            // crash the cross-repo run.
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
                // histories — no merge base): one repo's failure becomes a
                // skip, never an abort of the whole report.
                repos.push({
                    name,
                    branch,
                    status: "skipped",
                    reason:
                        error instanceof Error ? error.message : String(error)
                })
            }
        }

        terminal.json({ task: argv.task, base, repos })
        print(argv.task, base, repos)
    }
})

// The commits on `branch` not reachable from `base` (`git log base..branch`,
// i.e. everything past the merge-base), newest first. %x00 separates sha from
// subject so the split is unambiguous — a subject can contain neither NUL nor
// a newline.
const aheadCommits = async (
    repo: ReturnType<typeof git>,
    base: string,
    branch: string
): Promise<DiffCommit[]> => {
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

// Print the task heading ("<task>  vs <base>" once a base resolved) followed
// by one indented, column-aligned line per repo — "<name>  <branch>  <N>
// commit(s) ahead  <N> file(s) +ins -del  <clean|dirty>" — then the commit
// subjects, each as "<sha7> <subject>". The diffstat chunk is omitted at 0
// ahead (all zeros by construction), and a skipped repo collapses to
// "<name>  skipped — <reason>". Dirty means uncommitted changes exist; they
// are NOT in the numbers shown.
const print = (task: string, base: string, repos: DiffRepo[]): void => {
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
