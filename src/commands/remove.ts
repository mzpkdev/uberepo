import { defineCommand, terminal } from "cmdore"
import { repository } from "@/arguments/repository"
import { CONFIG_FILENAME, Config, repositoryUrl } from "@/config"
import { normalizeRepository } from "@/url"

export default defineCommand({
    name: "remove",
    description: "Remove a repository from the uberepo workspace",
    arguments: [repository],
    async run(argv) {
        const config = await Config.read()
        const { key } = normalizeRepository(argv.repository)

        const present = config.repositories.some(
            (r) => normalizeRepository(repositoryUrl(r)).key === key
        )
        if (!present) {
            // JSON mirrors the no-op outcome: nothing removed, the key reported
            // as not found. Keyed by the normalized key, the same token the
            // human line names.
            terminal.json({ removed: [], notFound: [key] })
            terminal.warn(
                `${key} is not in ${CONFIG_FILENAME} — nothing to remove.`
            )
            return
        }

        await Config.edit((draft) => {
            draft.repositories = draft.repositories.filter(
                (r) => normalizeRepository(repositoryUrl(r)).key !== key
            )
        })
        terminal.json({ removed: [key], notFound: [] })
        terminal.log(`Removed ${key} from ${CONFIG_FILENAME}`)
    }
})
