import * as fs from "node:fs"
import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { Config } from "@/config"
import git from "@/git"
import { normalizeRepository } from "@/url"

export default defineCommand({
    name: "clone",
    description: "Clone every registered repository into source/",
    async run() {
        const config = await Config.read()
        const root = await Config.root()

        if (config.repositories.length === 0) {
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
        for (const url of config.repositories) {
            const { name } = normalizeRepository(url)
            const dest = path.join(root, "source", name)
            if (fs.existsSync(dest)) {
                terminal.log(`Skipping ${url} — already at source/${name}`)
                continue
            }
            terminal.log(`Cloning ${url} → source/${name}`)
            await git.clone(url, dest)
            cloned += 1
        }

        terminal.log(
            `Cloned ${cloned} ${
                cloned === 1 ? "repository" : "repositories"
            } into source/`
        )
    }
})
