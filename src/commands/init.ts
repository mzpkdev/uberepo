import * as fs from "node:fs"
import * as path from "node:path"
import { defineArgument, defineCommand, terminal } from "cmdore"
import { CONFIG_FILENAME, Config } from "@/config"
import { noAgents } from "@/options/no-agents"
import { UBERTASK_FILENAME } from "@/tasks"

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

// The subset of template/ paths (by first segment) that brief AI agents on the
// workspace; these are the only paths `--no-agents` suppresses. AGENTS.md and
// CLAUDE.md are top-level files; `.claude` and `.agents` are whole template
// subtrees that stamp into the workspace verbatim — `.claude` is the bundled
// Claude Code skill, `.agents` the cross-tool copy of the same skill read by
// Codex and Gemini. Everything else in template/ (currently just .gitignore —
// workspace hygiene needed to share a committed workspace regardless of AI
// tooling) always stamps.
const AGENT_PATHS = ["AGENTS.md", "CLAUDE.md", ".claude", ".agents"]

// Template files that are per-task SEEDS consumed by a command at runtime, not
// workspace files init stamps. ubertask.yml is the durable task note: `open`
// byte-copies it into each task dir (tasks/<task>/ubertask.yml); it must never
// land at the workspace root on init. Always skipped here, regardless of
// --no-agents (these top-level names are their own first path-segment).
const COMMAND_SEEDS = [UBERTASK_FILENAME]

// Recursively collect every FILE under `root`, as paths relative to `root`
// (posix-joined so the skip checks below see stable, /-separated keys).
const walkFiles = async (root: string, rel = ""): Promise<string[]> => {
    const entries = await fs.promises.readdir(path.join(root, rel), {
        withFileTypes: true
    })
    const files: string[] = []
    for (const entry of entries) {
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`
        if (entry.isDirectory()) {
            files.push(...(await walkFiles(root, childRel)))
        } else if (entry.isFile()) {
            files.push(childRel)
        }
    }
    return files
}

// Stamp every file from template/ into `dir`, never clobbering a file the user
// already has — each existing target is left untouched and logged as a skip.
// The walk is recursive so nested template assets (e.g. the `.claude/` skill
// tree) land too, copied to the same relative path verbatim. `skip` names first
// path-segments to leave unstamped (the agent paths under --no-agents); the walk
// surfaces dotfiles too, so template/.gitignore is picked up here. Returns the
// target-relative paths actually written, for the tidy success line. Adding a
// new default file is just dropping it in template/ — no change here.
const stampTemplate = async (
    dir: string,
    skip: readonly string[]
): Promise<string[]> => {
    const relPaths = await walkFiles(TEMPLATE_DIR)
    const written: string[] = []
    for (const relPath of relPaths) {
        const firstSegment = relPath.split("/")[0]
        if (skip.includes(firstSegment)) {
            continue
        }
        const target = path.join(dir, relPath)
        if (fs.existsSync(target)) {
            terminal.log(`Skipping ${relPath} — already exists`)
            continue
        }
        await fs.promises.mkdir(path.dirname(target), { recursive: true })
        await fs.promises.copyFile(path.join(TEMPLATE_DIR, relPath), target)
        written.push(relPath)
    }
    return written
}

// The JSON outcome of a successful init: the workspace directory, whether it
// was freshly created (always true on the success path — Config.create throws
// if uberepo.json already exists, so reaching here means a new workspace), and
// whether the agent files were seeded (false under --no-agents).
type InitJson = {
    workspace: string
    created: boolean
    agents: boolean
}

// Stamp the workspace files into a freshly-created workspace and report which
// manifest + files ended up written. .gitignore always lands (it keeps a
// committed workspace clean); --no-agents holds back AGENTS.md/CLAUDE.md and the
// whole `.claude/` and `.agents/` skill trees (the Claude Code skill and its
// cross-tool copy read by Codex/Gemini).
const finish = async (dir: string, agents: boolean): Promise<void> => {
    // Always hold back the per-task command seeds (ubertask.yml); --no-agents
    // additionally holds back the agent files.
    const skip = agents ? COMMAND_SEEDS : [...COMMAND_SEEDS, ...AGENT_PATHS]
    const written = [CONFIG_FILENAME, ...(await stampTemplate(dir, skip))]
    // JSON mirrors the structural outcome; the human line lists the files.
    const json: InitJson = { workspace: dir, created: true, agents }
    terminal.json(json)
    terminal.log(`Initialized uberepo in ${dir} — wrote ${written.join(", ")}`)
}

export default defineCommand({
    name: "init",
    description: "Initialize the uberepo monorepo (config + source repos)",
    arguments: [name],
    options: [noAgents],
    async run(argv) {
        // cmdore keys argv by the literal option name; arity-0 means a plain
        // boolean (absent → false). --no-agents holds back the agent files;
        // the rest of template/ stamps regardless.
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
