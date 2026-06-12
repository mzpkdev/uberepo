import * as fs from "node:fs"
import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { task } from "@/arguments/task"
import { Config, TASKS_DIR } from "@/config"
import git from "@/git"
import { type HookResult, runHook } from "@/hooks"
import { from } from "@/options/from"
import { goal } from "@/options/goal"
import { noHooks } from "@/options/no-hooks"
import { repos } from "@/options/repos"
import {
    type TaskNote,
    taskBranch,
    UBERTASK_FILENAME,
    worktreePath
} from "@/tasks"
import * as ubertask from "@/ubertask"
import { normalizeRepository } from "@/url"

// One repo's open outcome: `created` (a fresh worktree landed) or `skipped`
// (its worktree was already open — the idempotent/recovery path — or its
// pre-open hook failed, with `reason` set on the hook path).
type OpenRepo = {
    name: string
    status: "created" | "skipped"
    reason?: string
}

// The seed ubertask.yml lives in the repo's real template/ dir and is byte-copied
// into a task at runtime. Resolve it relative to THIS module — not process.cwd(),
// which is the workspace — exactly as init.ts resolves its template dir, so it
// works under `npm link`. tsc rejects import.meta.url under module: CommonJS, so
// __dirname (the real src/commands/ dir) + two levels up is the template root.
const UBERTASK_TEMPLATE = path.join(
    __dirname,
    "..",
    "..",
    "template",
    UBERTASK_FILENAME
)

export default defineCommand({
    name: "open",
    description:
        "Open a task, creating its worktree in every source repository",
    arguments: [task],
    options: [from, goal, repos, noHooks],
    async run(argv) {
        const config = await Config.read()
        const root = await Config.root()
        const branch = taskBranch(argv.task)
        // Omitting --from branches each worktree off its clone's current HEAD.
        const base = argv.from ?? "HEAD"

        // Only cloned repos can grow a worktree; warn + skip the rest, the way
        // status does, so a partially-cloned workspace still opens what it can.
        // Remember each repo's registered URL so a fired hook can surface it as
        // UBEREPO_REPO_URL (the loop below works in flat names).
        const cloned: string[] = []
        const urlByName = new Map<string, string>()
        for (const url of config.repositories) {
            const { name } = normalizeRepository(url)
            urlByName.set(name, url)
            if (fs.existsSync(path.join(root, "source", name))) {
                cloned.push(name)
            } else {
                terminal.log(`Skipping ${name} — not cloned (run clone first)`)
            }
        }

        if (cloned.length === 0) {
            // No worktree is opened and no note is seeded on this path, so the
            // JSON carries an empty scope/repos, no hooks, and no note key.
            terminal.json({ task: argv.task, scope: [], repos: [], hooks: [] })
            terminal.log("Nothing to open — no cloned repositories.")
            return
        }

        // The task's durable note carries its declared scope; read it once up
        // front so a re-open without --repos can honour a previously-stored
        // scope and a re-open with --repos can UNION into it.
        const note = path.join(root, TASKS_DIR, argv.task, UBERTASK_FILENAME)
        const noteRelative = path.join(TASKS_DIR, argv.task, UBERTASK_FILENAME)
        const existing = await ubertask.read(note)
        const storedScope = existing?.repos ?? []

        // Validate --repos BEFORE creating anything: every supplied name must
        // resolve to a registered AND cloned repo (its source/<name> exists).
        // Mirror clone's pre-flight collision guard — fail loud and create
        // nothing on the first bad name, so a typo never half-opens a task.
        const suppliedScope: string[] = []
        if (argv.repos !== undefined) {
            for (const name of argv.repos) {
                if (!cloned.includes(name)) {
                    const known = cloned.join(", ") || "(none cloned)"
                    throw new Error(
                        `${name} is not a cloned repository — known: ${known}. Clone it (or fix the name) before scoping a task to it.`
                    )
                }
                if (!suppliedScope.includes(name)) {
                    suppliedScope.push(name)
                }
            }
        }

        // The effective scope is the UNION of any stored scope and the supplied
        // one (replacing would strand worktrees the task already owns). An empty
        // result means an unscoped task — fan out to every cloned repo, today's
        // behaviour. Order: stored first, then newly-supplied, for stable notes.
        const scope: string[] = [...storedScope]
        for (const name of suppliedScope) {
            if (!scope.includes(name)) {
                scope.push(name)
            }
        }
        const scoped = scope.length > 0
        // Worktree targets: the in-scope cloned repos (scope ∩ cloned, kept in
        // cloned's stable order) when scoped, else all cloned repos.
        const targets = scoped
            ? cloned.filter((n) => scope.includes(n))
            : cloned

        let opened = 0
        const repos: OpenRepo[] = []
        // One entry per hook that actually ran (pre-open and post-open, for
        // worktrees this run actually tried to create — never an already-open
        // skip). A non-zero exit is collected and flips the command's exit
        // code at the end without aborting the rest.
        const hooks: HookResult[] = []
        const failedHooks: HookResult[] = []
        for (const name of targets) {
            const dest = worktreePath(root, argv.task, name)
            const relative = path.join(TASKS_DIR, argv.task, name)
            // Idempotent: an existing worktree dir is left untouched. This is
            // also the recovery path — re-running open skips the done repos
            // and resumes after a mid-run failure.
            if (fs.existsSync(dest)) {
                repos.push({ name, status: "skipped" })
                terminal.log(
                    `Skipping ${name} — worktree already open at ${relative}`
                )
                continue
            }
            // pre-open GATES the worktree: a non-zero exit skips this repo (no
            // worktree is created), the run continues, and the command exits
            // non-zero at the end. The worktree does not exist yet, so the
            // hook runs in the repo's source clone while UBEREPO_REPO_PATH
            // names the would-be worktree.
            const pre = await runHook("pre-open", {
                config,
                workspace: root,
                task: argv.task,
                cwd: path.join(root, "source", name),
                repo: {
                    name,
                    path: dest,
                    url: urlByName.get(name) ?? "",
                    branch
                },
                noHooks: argv["no-hooks"]
            })
            if (pre) {
                hooks.push(pre)
                if (pre.exit !== 0) {
                    failedHooks.push(pre)
                    repos.push({
                        name,
                        status: "skipped",
                        reason: "pre-open hook failed"
                    })
                    terminal.log(`Skipping ${name} — pre-open hook failed`)
                    continue
                }
            }
            terminal.log(
                `Opening ${name} → ${relative} (${branch} from ${base})`
            )
            // Fail-fast: a creation error propagates, stopping before any
            // later repo is touched; already-created worktrees stay put.
            const repo = git(path.join(root, "source", name))
            await repo.worktree(dest).create({ branch, from: base })
            repos.push({ name, status: "created" })
            opened += 1
            // post-open fires for the NEWLY-created worktree only, with cwd =
            // the worktree and branch = task/<task>. A hook failure is recorded
            // and the loop continues — the worktree already exists.
            const result = await runHook("post-open", {
                config,
                workspace: root,
                task: argv.task,
                repo: {
                    name,
                    path: dest,
                    url: urlByName.get(name) ?? "",
                    branch
                },
                noHooks: argv["no-hooks"]
            })
            if (result) {
                hooks.push(result)
                if (result.exit !== 0) {
                    failedHooks.push(result)
                }
            }
        }

        // Seed the task's durable note at the TASK level (sibling of the per-repo
        // worktree dirs), so it survives a fresh session as the standing "why".
        // The task dir already exists (a worktree just landed under it); mkdir -p
        // covers the all-skipped case for safety.
        await fs.promises.mkdir(path.dirname(note), { recursive: true })
        // The scope only changes the note when --repos actually grew it past
        // what was already stored; re-running with the same (or no) scope leaves
        // the note's repos: line untouched, preserving the no-clobber contract.
        const scopeGrew = scope.length > storedScope.length
        if (argv.goal === undefined && !scopeGrew) {
            // Nothing to write into the note: preserve the original idempotent /
            // recovery contract — byte-copy the template only for a brand-new
            // task; an existing note is never touched. (No parse needed; the
            // bytes are the source.)
            if (existing) {
                terminal.log(`Skipping ${noteRelative} — already exists`)
            } else {
                await fs.promises.copyFile(UBERTASK_TEMPLATE, note)
                terminal.log(`Seeded ${noteRelative}`)
            }
        } else {
            // --goal and/or a grown scope mutate the note. On an existing note,
            // apply the changes IN PLACE (every other field is preserved). On a
            // fresh task, start from the parsed template seed so the new note
            // keeps the documented shape. Either way it's a parse → mutate →
            // serialize round-trip, never a blind overwrite.
            const target =
                existing ??
                ubertask.parse(
                    await fs.promises.readFile(UBERTASK_TEMPLATE, "utf8")
                )
            if (argv.goal !== undefined) {
                target.goal = argv.goal
            }
            target.repos = scope
            await ubertask.write(note, target)
            // Word the line for the change that actually happened: goal wins the
            // headline when set; otherwise it's a pure scope update.
            const what = argv.goal !== undefined ? "goal" : "scope"
            if (existing) {
                terminal.log(`Updated ${what} in ${noteRelative}`)
            } else {
                terminal.log(`Seeded ${noteRelative} (${what} set)`)
            }
        }

        // A note always lands on this path (seeded, copied, or updated above),
        // so read it back with its mtime to emit the same TaskNote shape #2
        // froze for status — the agent's open and status views then agree.
        const parsed = await ubertask.read(note)
        const stat = await fs.promises.stat(note)
        const finalNote: TaskNote | undefined = parsed
            ? { ...parsed, mtime: stat.mtimeMs }
            : undefined
        terminal.json({
            task: argv.task,
            scope,
            repos,
            hooks,
            // Omit the note key when absent, matching #2's omit-when-absent.
            ...(finalNote ? { note: finalNote } : {})
        })

        terminal.log(
            `Opened task ${argv.task} in ${opened} ${
                opened === 1 ? "repository" : "repositories"
            }`
        )
        // A failing post-open never removes its worktree (and a failing
        // pre-open just left its repo unopened), but the run is not clean:
        // summarise and exit non-zero so a wrapper/CI sees the failure.
        if (failedHooks.length > 0) {
            const which = failedHooks
                .map((h) => `${h.repo} (${h.event})`)
                .join(", ")
            terminal.error(
                `hooks failed in ${failedHooks.length} ${
                    failedHooks.length === 1 ? "repository" : "repositories"
                }: ${which}`
            )
            process.exitCode = 1
        }
    }
})
