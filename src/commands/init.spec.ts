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
        await init.run({})
        const written = await fsp.readFile(configPath, "utf8")
        expect(written).toBe(`{\n    "repositories": []\n}\n`)
    })

    it("throws and leaves the existing config untouched when one exists", async () => {
        const existing = `{\n    "repositories": ["keep"]\n}\n`
        await fsp.writeFile(configPath, existing)

        let error: unknown
        try {
            await init.run({})
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
})
