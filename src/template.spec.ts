import * as fsp from "node:fs/promises"
import * as path from "node:path"

// The using-uberepo skill ships in two stamped copies: one under .claude/ (read
// by Claude Code) and a cross-tool mirror under .agents/ (read by Codex &
// Gemini). init stamps both verbatim, so they MUST stay byte-identical — this
// guard locks them together so an edit to one without the other fails CI.
const TEMPLATE_DIR = path.join(__dirname, "..", "template")
const CLAUDE_SKILL_DIR = path.join(
    TEMPLATE_DIR,
    ".claude",
    "skills",
    "using-uberepo"
)
const AGENT_SKILL_DIR = path.join(
    TEMPLATE_DIR,
    ".agents",
    "skills",
    "using-uberepo"
)

// Recursively collect every file under `dir` as a sorted list of POSIX-style
// relative paths, so the two skill copies can be compared set-against-set
// regardless of directory-entry order or nesting depth.
const walk = async (dir: string): Promise<string[]> => {
    const found: string[] = []
    const recurse = async (current: string): Promise<void> => {
        const entries = await fsp.readdir(current, { withFileTypes: true })
        for (const entry of entries) {
            const absolute = path.join(current, entry.name)
            if (entry.isDirectory()) {
                await recurse(absolute)
            } else {
                const relative = path.relative(dir, absolute)
                found.push(relative.split(path.sep).join("/"))
            }
        }
    }
    await recurse(dir)
    return found.sort()
}

describe("using-uberepo skill copies", () => {
    it("ship the same set of files under .claude/ and .agents/", async () => {
        const claudeFiles = await walk(CLAUDE_SKILL_DIR)
        const agentFiles = await walk(AGENT_SKILL_DIR)
        // Identical relative-file sets — neither copy may gain or drop a file
        // without the other matching it.
        expect(agentFiles).toEqual(claudeFiles)
        // Sanity floor: at minimum the two documented files must be present, so
        // an empty/wrong dir resolution can't make the set-equality pass vacuously.
        expect(claudeFiles).toContain("SKILL.md")
        expect(claudeFiles).toContain("reference.md")
    })

    it("keep every file byte-identical across the two copies", async () => {
        const claudeFiles = await walk(CLAUDE_SKILL_DIR)
        for (const relative of claudeFiles) {
            const claudeBytes = await fsp.readFile(
                path.join(CLAUDE_SKILL_DIR, relative)
            )
            const agentBytes = await fsp.readFile(
                path.join(AGENT_SKILL_DIR, relative)
            )
            // Compare raw bytes (not utf8 strings) so any encoding, BOM, or
            // line-ending drift between the copies is caught.
            expect(
                agentBytes.equals(claudeBytes),
                `${relative} differs between .claude/ and .agents/ copies`
            ).toBe(true)
        }
    })
})
