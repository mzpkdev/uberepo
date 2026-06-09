import { defineCommand, terminal } from "cmdore"
import { CONFIG_FILENAME, Config } from "@/config"

export default defineCommand({
    name: "init",
    description: "Initialize the uberepo monorepo (config + source repos)",
    async run() {
        await Config.create()
        terminal.log(
            `Initialized uberepo: created ${CONFIG_FILENAME} in ${process.cwd()}`
        )
    }
})
