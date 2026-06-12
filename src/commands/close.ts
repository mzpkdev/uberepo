import * as fs from "node:fs"
import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { task } from "@/arguments/task"
import { carryDrift } from "@/carry"
import { Config, repositoryUrl } from "@/config"
import git from "@/git"
import { type HookResult, runHook } from "@/hooks"
import { force } from "@/options/force"
import { noHooks } from "@/options/no-hooks"
import { partitionScope, taskBranch, taskScope, worktreePath } from "@/tasks"
import { normalizeRepository } from "@/url"

// One repo's close outcome: `closed` (worktree + branch removed) or `skipped`
// (left intact, `reason` mirroring the human line: uncommitted changes,
// unmerged commits, or a failed pre-close hook). Only the task's in-scope
// worktree-bearing repos appear; a stray worktree outside a non-empty scope is
// warned about and left standing, never represented as a close target.
type CloseRepo = {
    name: string
    status: "closed" | "skipped"
    reason?: string
}

// Carried files whose worktree copy diverged from the source copy at close
// time: untracked local config edited inside the task, about to vanish with
// the worktree. One entry per repo that has any. Warn-only — never a blocker,
// since the files were never git's to protect.
type CarryModified = {
    repo: string
    modified: string[]
}

export default defineCommand({
    name: "close",
    description:
        "Close a task, removing its worktree from every source repository",
    arguments: [task],
    options: [force, noHooks],
    async run(argv) {
        const config = await Config.read()
        const root = await Config.root()
        const branch = taskBranch(argv.task)

        let closed = 0
        let skipped = 0

        // Only repos that are cloned AND have this task's worktree participate;
        // everything else is silently irrelevant to close. The registered URL
        // rides along so a fired hook can surface it as UBEREPO_REPO_URL.
        const present: {
            name: string
            source: string
            dest: string
            url: string
        }[] = []
        for (const entry of config.repositories) {
            const url = repositoryUrl(entry)
            const { name } = normalizeRepository(url)
            const source = path.join(root, "source", name)
            const dest = worktreePath(root, argv.task, name)
            if (!fs.existsSync(source) || !fs.existsSync(dest)) {
                continue
            }
            present.push({ name, source, dest, url })
        }

        // Honour the task's declared scope: close only its owned repos. A
        // worktree outside a non-empty scope is drift — warn and leave it
        // standing rather than silently removing or ignoring it. Unscoped →
        // every worktree-bearing repo, the original behaviour.
        const scope = await taskScope(root, argv.task)
        const { inScope, strays } = partitionScope(
            present.map((t) => t.name),
            scope
        )
        for (const name of strays) {
            terminal.warn(
                `${name}: worktree outside task scope (not in repos:) — leaving it; close it explicitly or add it with open --repos`
            )
        }
        const found = inScope.length > 0
        const targets = present.filter((t) => inScope.includes(t.name))
        const repos: CloseRepo[] = []
        // One entry per hook that actually ran (pre-close and post-close, for
        // repos whose teardown was attempted — never a safety-skipped one). A
        // non-zero exit is collected and flips the command's exit code at the
        // end without aborting the remaining repos.
        const hooks: HookResult[] = []
        const failedHooks: HookResult[] = []
        const carry: CarryModified[] = []

        for (const { name, source, dest, url } of targets) {
            const repo = git(source)
            const wt = repo.worktree(dest)

            // Without --force, pre-check safety so we never half-close a repo:
            // a dirty worktree or a branch with unmerged commits is skipped
            // intact, with a reason. --force closes regardless.
            if (!argv.force) {
                if (await wt.dirty()) {
                    repos.push({
                        name,
                        status: "skipped",
                        reason: "uncommitted changes"
                    })
                    terminal.log(`${name}: uncommitted changes — use --force`)
                    skipped += 1
                    continue
                }
                const into = await repo.remoteDefault()
                // No remote default to compare against → assume unmerged and
                // protect by default; --force overrides.
                if (!into || !(await repo.isMerged(branch, into))) {
                    repos.push({
                        name,
                        status: "skipped",
                        reason: "unmerged commits"
                    })
                    terminal.log(`${name}: unmerged commits — use --force`)
                    skipped += 1
                    continue
                }
            }

            // pre-close GATES the teardown: a non-zero exit leaves the
            // worktree and branch standing, the run continues, and the
            // command exits non-zero at the end. Runs in the worktree that is
            // about to be removed — its last chance to say no.
            const pre = await runHook("pre-close", {
                config,
                workspace: root,
                task: argv.task,
                repo: { name, path: dest, url, branch },
                noHooks: argv["no-hooks"]
            })
            if (pre) {
                hooks.push(pre)
                if (pre.exit !== 0) {
                    failedHooks.push(pre)
                    repos.push({
                        name,
                        status: "skipped",
                        reason: "pre-close hook failed"
                    })
                    terminal.log(`${name}: pre-close hook failed — skipping`)
                    continue
                }
            }

            // Carried local files live outside git, so the dirty/unmerged
            // guards never see an edited .env — surface the divergence while
            // the bytes still exist. Warn-only: close proceeds regardless.
            const modified = await carryDrift({
                config,
                name,
                source,
                worktree: dest
            })
            if (modified.length > 0) {
                carry.push({ repo: name, modified })
                terminal.warn(
                    `${name}: carried files modified in this task; changes will be lost — ${modified.join(", ")}`
                )
            }
            // Safe (or --force): the worktree must go before the branch, since
            // git refuses to delete a branch that is still checked out.
            await wt.remove({ force: argv.force })
            await repo.deleteBranch(branch, { force: argv.force })
            repos.push({ name, status: "closed" })
            closed += 1
            terminal.log(`${name}: closed`)
            // post-close fires after the worktree and branch are gone. The
            // worktree dir no longer exists, so the hook runs in the repo's
            // source clone while UBEREPO_REPO_PATH still names the removed
            // worktree (so a hook can clean up anything keyed by that path).
            const result = await runHook("post-close", {
                config,
                workspace: root,
                task: argv.task,
                cwd: source,
                repo: { name, path: dest, url, branch },
                noHooks: argv["no-hooks"]
            })
            if (result) {
                hooks.push(result)
                if (result.exit !== 0) {
                    failedHooks.push(result)
                }
            }
        }

        if (!found) {
            // No in-scope worktree for the task: nothing closed, empty repos.
            terminal.json({
                task: argv.task,
                forced: argv.force,
                repos: [],
                hooks: [],
                carry: []
            })
            terminal.warn(`No open task ${argv.task} to close.`)
            return
        }

        terminal.json({
            task: argv.task,
            forced: argv.force,
            repos,
            hooks,
            carry
        })

        terminal.log(
            `Closed task ${argv.task} in ${closed} ${
                closed === 1 ? "repository" : "repositories"
            }`
        )
        if (skipped > 0) {
            terminal.log(
                `Skipped ${skipped} ${
                    skipped === 1 ? "repository" : "repositories"
                } with unsafe changes — use --force to close anyway.`
            )
        }
        // A failing post-close can't resurrect the worktree (and a failing
        // pre-close deliberately left its repo open), but the run is not
        // clean: summarise and exit non-zero so a wrapper/CI sees the failure.
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
