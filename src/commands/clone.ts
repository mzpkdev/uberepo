import * as fs from "node:fs"
import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { Config, repositoryUrl } from "@/config"
import type { HookResult } from "@/hooks"
import { noHooks } from "@/options/no-hooks"
import { repos } from "@/options/repos"
import { type CloneRepo, cloneSource } from "@/sources"
import { normalizeRepository } from "@/url"

export default defineCommand({
    name: "clone",
    description: "Clone every registered repository into source/",
    options: [repos, noHooks],
    async run(argv) {
        const config = await Config.read()
        const root = await Config.root()

        // Collision guard: fail loud BEFORE cloning anything if two distinct
        // repositories map to the same flat source/<name> folder. The map it
        // builds doubles as the registered-name index --repos validates against.
        const seen = new Map<string, { url: string; key: string }>()
        for (const entry of config.repositories) {
            const url = repositoryUrl(entry)
            const { key, name } = normalizeRepository(url)
            const prior = seen.get(name)
            if (prior && prior.key !== key) {
                throw new Error(
                    `${prior.url} and ${url} both clone to source/${name} — rename or remove one before cloning.`
                )
            }
            seen.set(name, { url, key })
        }

        // --repos clones only the named subset (flat names, the same names
        // sources/status use). Validate BEFORE cloning anything: an unknown
        // name fails loud with the registered set listed, so a typo never
        // half-clones a workspace.
        let subset: string[] | undefined
        if (argv.repos !== undefined) {
            subset = []
            for (const name of argv.repos) {
                if (!seen.has(name)) {
                    const known =
                        [...seen.keys()].join(", ") || "(none registered)"
                    throw new Error(
                        `${name} is not a registered repository — known: ${known}.`
                    )
                }
                if (!subset.includes(name)) {
                    subset.push(name)
                }
            }
        }

        if (config.repositories.length === 0) {
            terminal.json({ repos: [], hooks: [] })
            terminal.log("Nothing to clone — no repositories registered.")
            return
        }

        // The repos this run clones: the --repos subset when given (kept in
        // registration order, not flag order), else every registered repo.
        const targets = config.repositories.filter(
            (entry) =>
                subset === undefined ||
                subset.includes(normalizeRepository(repositoryUrl(entry)).name)
        )

        let cloned = 0
        const repos: CloneRepo[] = []
        // One entry per hook that actually ran (pre-clone and post-clone, for
        // repos that weren't already on disk — never an already-cloned skip).
        // A non-zero exit anywhere flips the command's exit code at the end
        // without aborting the remaining clones.
        const hooks: HookResult[] = []
        const failedHooks: HookResult[] = []
        for (const entry of targets) {
            const url = repositoryUrl(entry)
            const { name } = normalizeRepository(url)
            const dest = path.join(root, "source", name)
            if (fs.existsSync(dest)) {
                repos.push({ name, status: "skipped" })
                terminal.log(`Skipping ${url} — already at source/${name}`)
                continue
            }
            // The per-repo lifecycle op (pre-clone gate → git clone →
            // post-clone) lives in cloneSource, shared with open's on-demand
            // clones. A failed pre-clone skips the repo and the run continues;
            // hook exits are tallied for the end-of-run summary either way.
            const outcome = await cloneSource({
                config,
                root,
                name,
                url,
                noHooks: argv["no-hooks"]
            })
            for (const hook of outcome.hooks) {
                hooks.push(hook)
                if (hook.exit !== 0) {
                    failedHooks.push(hook)
                }
            }
            repos.push(outcome.repo)
            if (outcome.repo.status === "failed") {
                // Fail fast (unchanged behaviour): the repo is recorded as
                // failed, the JSON is emitted so the outcome is observable,
                // then the git error is rethrown so the human error path and
                // exit code are exactly as before.
                terminal.json({ repos, hooks })
                throw outcome.error
            }
            if (outcome.repo.status === "cloned") {
                cloned += 1
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
