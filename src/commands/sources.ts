import * as fs from "node:fs"
import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { CONFIG_FILENAME, Config, repositoryUrl } from "@/config"
import { normalizeRepository } from "@/url"

export default defineCommand({
    name: "sources",
    description:
        "List the registered repositories and whether each is cloned into source/",
    async run() {
        const config = await Config.read()
        const root = await Config.root()
        const rows = config.repositories.map((entry) => {
            const url = repositoryUrl(entry)
            const { name } = normalizeRepository(url)
            return {
                name,
                url,
                cloned: fs.existsSync(path.join(root, "source", name))
            }
        })

        terminal.json(rows)

        if (rows.length === 0) {
            terminal.log(`No repositories registered in ${CONFIG_FILENAME}.`)
            return
        }
        const width = Math.max(...rows.map((r) => r.name.length))
        for (const r of rows) {
            terminal.log(
                `${r.cloned ? "✓" : "—"} ${r.name.padEnd(width)}  ${r.url}`
            )
        }
        const cloned = rows.filter((r) => r.cloned).length
        terminal.log(
            `\n${rows.length} registered · ${cloned} cloned · ${rows.length - cloned} missing`
        )
    }
})
