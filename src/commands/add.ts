import { defineCommand, terminal } from "cmdore"
import { repository } from "@/arguments/repository"
import { CONFIG_FILENAME, Config } from "@/config"
import { normalizeRepository } from "@/url"

export default defineCommand({
    name: "add",
    description: "Add a repository to the uberepo workspace",
    arguments: [repository],
    async run(argv) {
        const config = await Config.read()
        const { url, key } = normalizeRepository(argv.repository)
        const clash = config.repositories.some(
            (r) => normalizeRepository(r).key === key
        )
        if (clash) {
            terminal.warn(`${url} is already in ${CONFIG_FILENAME} — skipping.`)
            return
        }
        await Config.edit((draft) => {
            draft.repositories.push(url)
        })
        terminal.log(`Added ${url} to ${CONFIG_FILENAME}`)
    }
})
