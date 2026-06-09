import { defineCommand, terminal } from "cmdore"
import { CONFIG_FILENAME, Config } from "@/config"

export default defineCommand({
    name: "sources",
    description: "List the source repositories registered in the workspace",
    async run() {
        const config = await Config.read()
        if (config.repositories.length === 0) {
            terminal.log(`No repositories registered in ${CONFIG_FILENAME}.`)
            return
        }
        for (const repo of config.repositories) {
            terminal.log(repo)
        }
    }
})
