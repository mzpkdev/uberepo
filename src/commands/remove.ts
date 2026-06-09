import { defineCommand, terminal } from "cmdore"
import { repository } from "@/arguments/repository"
import { CONFIG_FILENAME, Config } from "@/config"
import { normalizeRepository } from "@/url"

export default defineCommand({
    name: "remove",
    description: "Remove a repository from the uberepo workspace",
    arguments: [repository],
    async run(argv) {
        const config = await Config.read()
        const { key } = normalizeRepository(argv.repository)

        const present = config.repositories.some(
            (r) => normalizeRepository(r).key === key
        )
        if (!present) {
            terminal.warn(
                `${key} is not in ${CONFIG_FILENAME} — nothing to remove.`
            )
            return
        }

        await Config.edit((draft) => {
            draft.repositories = draft.repositories.filter(
                (r) => normalizeRepository(r).key !== key
            )
        })
        terminal.log(`Removed ${key} from ${CONFIG_FILENAME}`)
    }
})
