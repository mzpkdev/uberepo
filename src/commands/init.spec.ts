import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import init from "@/commands/init"
import { CONFIG_FILENAME } from "@/config"

describe("init command", () => {
    let tmp: string
    let cwd: string
    let configPath: string

    // Build a fresh empty temp dir and chdir into it for each test, since init
    // reads process.cwd(); restore the original cwd in afterEach.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "init-spec-"))
        configPath = path.join(tmp, CONFIG_FILENAME)
        cwd = process.cwd()
        process.chdir(tmp)
    })

    afterEach(async () => {
        process.chdir(cwd)
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    it("creates uberepo.json with the default config bytes", async () => {
        await init.run({ name: undefined })
        const written = await fsp.readFile(configPath, "utf8")
        expect(written).toBe(`{\n    "repositories": []\n}\n`)
    })

    it("throws and leaves the existing config untouched when one exists", async () => {
        const existing = `{\n    "repositories": ["keep"]\n}\n`
        await fsp.writeFile(configPath, existing)

        let error: unknown
        try {
            await init.run({ name: undefined })
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
    })

    it("creates <name>/uberepo.json with the default bytes, making the dir", async () => {
        await init.run({ name: "lokalise-workdir" })
        const written = await fsp.readFile(
            path.join(tmp, "lokalise-workdir", CONFIG_FILENAME),
            "utf8"
        )
        expect(written).toBe(`{\n    "repositories": []\n}\n`)
        // The bare-cwd manifest must NOT have been written.
        await expect(fsp.access(configPath)).rejects.toThrow()
    })

    it("creates a nested <name>/uberepo.json, making parent dirs", async () => {
        await init.run({ name: path.join("a", "b") })
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
            await init.run({ name: "lokalise-workdir" })
        } catch (e) {
            error = e
        }
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain(CONFIG_FILENAME)
        expect((error as Error).message).toContain("refusing to overwrite.")

        expect(await fsp.readFile(target, "utf8")).toBe(existing)
    })
})
