import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import init from "@/commands/init"
import { CONFIG_FILENAME } from "@/config"

const AGENTS_FILENAME = "AGENTS.md"
const CLAUDE_FILENAME = "CLAUDE.md"

// The on-disk template/ files are the single source of truth for what init
// stamps — read them straight off disk (resolved relative to this spec, the
// same way init resolves them relative to itself) and assert the stamped
// output is byte-identical. An empty/wrong resolution here would surface as a
// read error or a mismatch.
const TEMPLATE_DIR = path.join(__dirname, "..", "..", "template")

describe("init command", () => {
    let tmp: string
    let cwd: string
    let configPath: string
    let agentsTemplate: string
    let claudeTemplate: string

    beforeAll(async () => {
        agentsTemplate = await fsp.readFile(
            path.join(TEMPLATE_DIR, AGENTS_FILENAME),
            "utf8"
        )
        claudeTemplate = await fsp.readFile(
            path.join(TEMPLATE_DIR, CLAUDE_FILENAME),
            "utf8"
        )
    })

    // Build a fresh empty temp dir and chdir into it for each test, since init
    // reads process.cwd(); restore the original cwd in afterEach.
    beforeEach(async () => {
        // realpath: macOS tmpdir lives under /var -> /private/var, and init
        // resolves paths through process.cwd()'s realpath, so canonicalise the
        // root we assert against here too.
        tmp = await fsp.realpath(
            await fsp.mkdtemp(path.join(os.tmpdir(), "init-spec-"))
        )
        configPath = path.join(tmp, CONFIG_FILENAME)
        cwd = process.cwd()
        process.chdir(tmp)
    })

    afterEach(async () => {
        process.chdir(cwd)
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    it("creates uberepo.json with the default config bytes", async () => {
        await init.run({ name: undefined, "no-agents": false })
        const written = await fsp.readFile(configPath, "utf8")
        expect(written).toBe(`{\n    "repositories": []\n}\n`)
    })

    it("stamps AGENTS.md and CLAUDE.md in cwd alongside uberepo.json", async () => {
        await init.run({ name: undefined, "no-agents": false })

        expect(await fsp.readFile(configPath, "utf8")).toBe(
            `{\n    "repositories": []\n}\n`
        )
        // Byte-for-byte against the on-disk template — proves the stamp copies
        // the real template file (not an empty/garbled resolution).
        expect(
            await fsp.readFile(path.join(tmp, AGENTS_FILENAME), "utf8")
        ).toBe(agentsTemplate)
        expect(
            await fsp.readFile(path.join(tmp, CLAUDE_FILENAME), "utf8")
        ).toBe(claudeTemplate)
    })

    it("stamps AGENTS.md and CLAUDE.md into <name>/ with uberepo.json", async () => {
        await init.run({ name: "lokalise-workdir", "no-agents": false })
        const dir = path.join(tmp, "lokalise-workdir")

        expect(
            await fsp.readFile(path.join(dir, CONFIG_FILENAME), "utf8")
        ).toBe(`{\n    "repositories": []\n}\n`)
        expect(
            await fsp.readFile(path.join(dir, AGENTS_FILENAME), "utf8")
        ).toBe(agentsTemplate)
        expect(
            await fsp.readFile(path.join(dir, CLAUDE_FILENAME), "utf8")
        ).toBe(claudeTemplate)
    })

    it("writes only uberepo.json when --no-agents is set", async () => {
        await init.run({ name: undefined, "no-agents": true })

        expect(await fsp.readFile(configPath, "utf8")).toBe(
            `{\n    "repositories": []\n}\n`
        )
        await expect(
            fsp.access(path.join(tmp, AGENTS_FILENAME))
        ).rejects.toThrow()
        await expect(
            fsp.access(path.join(tmp, CLAUDE_FILENAME))
        ).rejects.toThrow()
    })

    it("leaves an existing AGENTS.md untouched but still stamps CLAUDE.md", async () => {
        const custom = "# my own agents file\nleave me alone\n"
        await fsp.writeFile(path.join(tmp, AGENTS_FILENAME), custom)

        await init.run({ name: undefined, "no-agents": false })

        // The user's AGENTS.md is preserved verbatim — never clobbered.
        expect(
            await fsp.readFile(path.join(tmp, AGENTS_FILENAME), "utf8")
        ).toBe(custom)
        // ...but the other two files are still created.
        expect(await fsp.readFile(configPath, "utf8")).toBe(
            `{\n    "repositories": []\n}\n`
        )
        expect(
            await fsp.readFile(path.join(tmp, CLAUDE_FILENAME), "utf8")
        ).toBe(claudeTemplate)
    })

    it("throws and leaves the existing config untouched when one exists", async () => {
        const existing = `{\n    "repositories": ["keep"]\n}\n`
        await fsp.writeFile(configPath, existing)

        let error: unknown
        try {
            await init.run({ name: undefined, "no-agents": false })
        } catch (e) {
            error = e
        }
        expect(error).toBeInstanceOf(Error)
        // The path embedded in the message is process.cwd()'s realpath, which
        // macOS canonicalises (/var -> /private/var); assert on the stable
        // filename + refusal phrasing rather than the volatile absolute path.
        expect((error as Error).message).toContain(CONFIG_FILENAME)
        expect((error as Error).message).toContain("refusing to overwrite.")

        expect(await fsp.readFile(configPath, "utf8")).toBe(existing)
        // The throw aborts before any template files are stamped.
        await expect(
            fsp.access(path.join(tmp, AGENTS_FILENAME))
        ).rejects.toThrow()
    })

    it("creates <name>/uberepo.json with the default bytes, making the dir", async () => {
        await init.run({ name: "lokalise-workdir", "no-agents": false })
        const written = await fsp.readFile(
            path.join(tmp, "lokalise-workdir", CONFIG_FILENAME),
            "utf8"
        )
        expect(written).toBe(`{\n    "repositories": []\n}\n`)
        // The bare-cwd manifest must NOT have been written.
        await expect(fsp.access(configPath)).rejects.toThrow()
    })

    it("creates a nested <name>/uberepo.json, making parent dirs", async () => {
        await init.run({ name: path.join("a", "b"), "no-agents": false })
        const written = await fsp.readFile(
            path.join(tmp, "a", "b", CONFIG_FILENAME),
            "utf8"
        )
        expect(written).toBe(`{\n    "repositories": []\n}\n`)
    })

    it("throws and leaves <name>/uberepo.json untouched when it exists", async () => {
        const dir = path.join(tmp, "lokalise-workdir")
        await fsp.mkdir(dir, { recursive: true })
        const existing = `{\n    "repositories": ["keep"]\n}\n`
        const target = path.join(dir, CONFIG_FILENAME)
        await fsp.writeFile(target, existing)

        let error: unknown
        try {
            await init.run({ name: "lokalise-workdir", "no-agents": false })
        } catch (e) {
            error = e
        }
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain(CONFIG_FILENAME)
        expect((error as Error).message).toContain("refusing to overwrite.")

        expect(await fsp.readFile(target, "utf8")).toBe(existing)
    })
})
