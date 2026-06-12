import * as fs from "node:fs"
import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { Config } from "@/config"
import git from "@/git"
import { type HookResult, runHook } from "@/hooks"
import { noHooks } from "@/options/no-hooks"
import { normalizeRepository } from "@/url"

// One repo's clone outcome: cloned (a fresh clone landed), skipped (source/<name>
// already existed, or its pre-clone hook failed — `reason` set on the hook
// path), or failed (git.clone threw — carries the error message). clone fails
// fast on a git error, so at most one repo is ever `failed`, and it is the last
// entry before the command rethrows.
type CloneRepo = {
    name: string
    status: "cloned" | "skipped" | "failed"
    reason?: string
    error?: string
}

export default defineCommand({
    name: "clone",
    description: "Clone every registered repository into source/",
    options: [noHooks],
    async run(argv) {
        const config = await Config.read()
        const root = await Config.root()

        if (config.repositories.length === 0) {
            terminal.json({ repos: [], hooks: [] })
            terminal.log("Nothing to clone — no repositories registered.")
            return
        }

        // Collision guard: fail loud BEFORE cloning anything if two distinct
        // repositories map to the same flat source/<name> folder.
        const seen = new Map<string, { url: string; key: string }>()
        for (const url of config.repositories) {
            const { key, name } = normalizeRepository(url)
            const prior = seen.get(name)
            if (prior && prior.key !== key) {
                throw new Error(
                    `${prior.url} and ${url} both clone to source/${name} — rename or remove one before cloning.`
                )
            }
            seen.set(name, { url, key })
        }

        let cloned = 0
        const repos: CloneRepo[] = []
        // One entry per hook that actually ran (pre-clone and post-clone, for
        // repos that weren't already on disk — never an already-cloned skip).
        // A non-zero exit anywhere flips the command's exit code at the end
        // without aborting the remaining clones.
        const hooks: HookResult[] = []
        const failedHooks: HookResult[] = []
        for (const url of config.repositories) {
            const { name } = normalizeRepository(url)
            const dest = path.join(root, "source", name)
            if (fs.existsSync(dest)) {
                repos.push({ name, status: "skipped" })
                terminal.log(`Skipping ${url} — already at source/${name}`)
                continue
            }
            // pre-clone GATES the clone: a non-zero exit skips this repo
            // (nothing is cloned), the run continues, and the command exits
            // non-zero at the end. source/<name> does not exist yet, so the
            // hook runs at the workspace root while UBEREPO_REPO_PATH names
            // the would-be clone.
            const pre = await runHook("pre-clone", {
                config,
                workspace: root,
                cwd: root,
                repo: { name, path: dest, url },
                noHooks: argv["no-hooks"]
            })
            if (pre) {
                hooks.push(pre)
                if (pre.exit !== 0) {
                    failedHooks.push(pre)
                    repos.push({
                        name,
                        status: "skipped",
                        reason: "pre-clone hook failed"
                    })
                    terminal.log(`Skipping ${url} — pre-clone hook failed`)
                    continue
                }
            }
            terminal.log(`Cloning ${url} → source/${name}`)
            try {
                await git.clone(url, dest)
            } catch (error) {
                // Fail fast (unchanged behaviour): record this repo as failed,
                // emit the JSON so the outcome is observable, then rethrow so
                // the human error path and exit code are exactly as before.
                const reason =
                    error instanceof Error ? error.message : String(error)
                repos.push({ name, status: "failed", error: reason })
                terminal.json({ repos, hooks })
                throw error
            }
            repos.push({ name, status: "cloned" })
            cloned += 1
            // post-clone fires for the FRESH clone only, with cwd = its
            // source/<name> and no task/branch. A hook failure is recorded and
            // the loop continues — the clone itself already landed.
            const result = await runHook("post-clone", {
                config,
                workspace: root,
                repo: { name, path: dest, url },
                noHooks: argv["no-hooks"]
            })
            if (result) {
                hooks.push(result)
                if (result.exit !== 0) {
                    failedHooks.push(result)
                }
            }
        }

        terminal.json({ repos, hooks })
        terminal.log(
            `Cloned ${cloned} ${
                cloned === 1 ? "repository" : "repositories"
            } into source/`
        )
        // A failing hook never rolls back a clone (a failing pre-clone just
        // left its repo uncloned), but the run is not clean: summarise and
        // exit non-zero so a wrapper/CI sees the failure.
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
