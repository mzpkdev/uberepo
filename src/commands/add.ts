import { defineCommand, terminal } from "cmdore"
import { repositories } from "@/arguments/repositories"
import { CONFIG_FILENAME, Config } from "@/config"
import { normalizeRepository } from "@/url"

export default defineCommand({
    name: "add",
    description: "Add one or more repositories to the uberepo workspace",
    arguments: [repositories],
    async run(argv) {
        const config = await Config.read()
        // Validate every URL first so a single bad one writes nothing.
        const normalized = argv.repositories.map(normalizeRepository)
        const seen = new Set(
            config.repositories.map((r) => normalizeRepository(r).key)
        )
        const toAdd: string[] = []
        const names: string[] = []
        const skipped: string[] = []
        for (const { url, key, name } of normalized) {
            if (seen.has(key)) {
                terminal.warn(
                    `${url} is already in ${CONFIG_FILENAME} — skipping.`
                )
                skipped.push(url)
                continue
            }
            seen.add(key)
            toAdd.push(url)
            names.push(name)
        }
        if (toAdd.length > 0) {
            await Config.edit((draft) => {
                for (const url of toAdd) {
                    draft.repositories.push(url)
                }
            })
        }
        // JSON mirrors the outcome: the flat names actually added, and the URLs
        // that were already registered and thus skipped (the warn lines above).
        terminal.json({ added: names, skipped })
        const summary = `Added ${toAdd.length} to ${CONFIG_FILENAME}: ${names.join(", ")}`
        terminal.log(
            skipped.length > 0
                ? `${summary} (${skipped.length} skipped)`
                : summary
        )
    }
})
