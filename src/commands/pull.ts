import * as fs from "node:fs"
import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { Config } from "@/config"
import git from "@/git"
import { normalizeRepository } from "@/url"

export default defineCommand({
    name: "pull",
    description: "Fast-forward every cloned source repository to its origin",
    async run() {
        const config = await Config.read()
        const root = await Config.root()

        let pulled = 0
        let current = 0
        let skipped = 0
        let cloned = 0

        for (const url of config.repositories) {
            const { name } = normalizeRepository(url)
            const source = path.join(root, "source", name)

            // A repo participates only when it is cloned (source/<name>);
            // registered-but-not-cloned repos are reported, not pulled.
            if (!fs.existsSync(source)) {
                terminal.log(`${name}: not cloned — run clone`)
                continue
            }
            cloned += 1

            const repo = git(source)

            // Never touch a dirty clone: a fast-forward against uncommitted work
            // could fail mid-way, and source/<name> is meant to stay a clean
            // read-only base. Skip intact, with a reason.
            if (await repo.dirty()) {
                terminal.log(`${name}: uncommitted changes — skipped`)
                skipped += 1
                continue
            }

            // Compare HEAD across the pull to classify the outcome: parsing
            // git's "Already up to date." line is locale-fragile, but the SHA
            // moving (or not) is unambiguous. pull() is --ff-only, so a diverged
            // branch or missing upstream throws rather than creating a merge.
            const before = await repo.raw("rev-parse", "--short", "HEAD")
            try {
                await repo.pull()
            } catch {
                terminal.log(`${name}: can't fast-forward — skipped`)
                skipped += 1
                continue
            }
            const after = await repo.raw("rev-parse", "--short", "HEAD")

            if (before === after) {
                terminal.log(`${name}: up to date`)
                current += 1
            } else {
                terminal.log(`${name}: pulled ${before} → ${after}`)
                pulled += 1
            }
        }

        if (cloned === 0) {
            terminal.log("Nothing to pull — no cloned repositories.")
            return
        }

        terminal.log(
            `${pulled} pulled · ${current} up to date · ${skipped} skipped`
        )
    }
})
