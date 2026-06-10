import * as fs from "node:fs"
import * as path from "node:path"
import { defineArgument, defineCommand, terminal } from "cmdore"
import { CONFIG_FILENAME, Config } from "@/config"

const name = defineArgument({
    name: "name",
    required: false,
    description: "Directory to create the workspace in (default: current)"
})

export default defineCommand({
    name: "init",
    description: "Initialize the uberepo monorepo (config + source repos)",
    arguments: [name],
    async run(argv) {
        if (argv.name !== undefined) {
            if (argv.name.trim() === "") {
                throw new Error("init: <name> cannot be empty.")
            }
            const dir = path.resolve(process.cwd(), argv.name)
            await fs.promises.mkdir(dir, { recursive: true })
            await Config.create({ cwd: dir })
            terminal.log(
                `Initialized uberepo: created ${CONFIG_FILENAME} in ${dir}`
            )
            return
        }
        await Config.create()
        terminal.log(
            `Initialized uberepo: created ${CONFIG_FILENAME} in ${process.cwd()}`
        )
    }
})
