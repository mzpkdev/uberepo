import * as fs from "node:fs"
import * as path from "node:path"
import { defineArgument, defineCommand, terminal } from "cmdore"
import { CONFIG_FILENAME, Config } from "@/config"
import { noAgents } from "@/options/no-agents"

const name = defineArgument({
    name: "name",
    required: false,
    description: "Directory to create the workspace in (default: current)"
})

// The default workspace files live in a real `template/` directory at the repo
// root and are stamped into the workspace at runtime. Resolve it relative to
// THIS module — not process.cwd(), which is the workspace being created. The
// project runs from source under tsx (module: CommonJS), so __dirname is the
// real src/commands/ dir; template/ is two levels up. (import.meta.url is not
// usable here: tsc rejects it as TS1343 under module: CommonJS.)
const TEMPLATE_DIR = path.join(__dirname, "..", "..", "template")

// Stamp every file from template/ into `dir`, never clobbering a file the user
// already has — each existing target is left untouched and logged as a skip.
// Returns the filenames actually written, for the tidy success line. Adding a
// new default file is just dropping it in template/ — no change here.
const stampTemplate = async (dir: string): Promise<string[]> => {
    const entries = await fs.promises.readdir(TEMPLATE_DIR, {
        withFileTypes: true
    })
    const written: string[] = []
    for (const entry of entries) {
        if (!entry.isFile()) {
            continue
        }
        const filename = entry.name
        const target = path.join(dir, filename)
        if (fs.existsSync(target)) {
            terminal.log(`Skipping ${filename} — already exists`)
            continue
        }
        await fs.promises.copyFile(path.join(TEMPLATE_DIR, filename), target)
        written.push(filename)
    }
    return written
}

// Stamp the AI-agent context files into a freshly-created workspace (unless
// opted out) and report which manifest + files ended up written.
const finish = async (dir: string, agents: boolean): Promise<void> => {
    const written = [CONFIG_FILENAME]
    if (agents) {
        written.push(...(await stampTemplate(dir)))
    }
    terminal.log(`Initialized uberepo in ${dir} — wrote ${written.join(", ")}`)
}

export default defineCommand({
    name: "init",
    description: "Initialize the uberepo monorepo (config + source repos)",
    arguments: [name],
    options: [noAgents],
    async run(argv) {
        // cmdore keys argv by the literal option name; arity-0 means a plain
        // boolean (absent → false). Files are stamped unless --no-agents is set.
        const agents = !argv["no-agents"]
        if (argv.name !== undefined) {
            if (argv.name.trim() === "") {
                throw new Error("init: <name> cannot be empty.")
            }
            const dir = path.resolve(process.cwd(), argv.name)
            await fs.promises.mkdir(dir, { recursive: true })
            // Config.create throws if uberepo.json already exists, aborting
            // before any template files are stamped — so they only land in a
            // fresh workspace.
            await Config.create({ cwd: dir })
            await finish(dir, agents)
            return
        }
        const dir = process.cwd()
        await Config.create({ cwd: dir })
        await finish(dir, agents)
    }
})
