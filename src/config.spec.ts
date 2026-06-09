import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { CONFIG_FILENAME, Config } from "@/config"

const configPath = (dir: string): string => path.join(dir, CONFIG_FILENAME)

const writeConfig = async (dir: string, raw: string): Promise<void> => {
    await fsp.writeFile(configPath(dir), raw)
}

describe("Config", () => {
    let tmp: string

    // Build a fresh temp workspace root for each test; never touch process.cwd.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "config-spec-"))
    })

    afterEach(async () => {
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    describe("read", () => {
        it("reads a config in the given workspace directory", async () => {
            await writeConfig(tmp, `{\n    "repositories": ["a", "b"]\n}\n`)
            const config = await Config.read({ cwd: tmp })
            expect(config).toEqual({ repositories: ["a", "b"] })
        })

        it("walks up parent directories from a nested subdir", async () => {
            await writeConfig(tmp, `{\n    "repositories": ["root"]\n}\n`)
            const nested = path.join(tmp, "packages", "deep")
            await fsp.mkdir(nested, { recursive: true })
            const config = await Config.read({ cwd: nested })
            expect(config).toEqual({ repositories: ["root"] })
        })

        it("throws the not-in-workspace error outside any workspace", async () => {
            const orphan = await fsp.mkdtemp(
                path.join(os.tmpdir(), "config-orphan-")
            )
            try {
                const error = await Config.read({ cwd: orphan }).catch((e) => e)
                expect(error).toBeInstanceOf(Error)
                expect((error as Error).message).toBe(
                    `No ${CONFIG_FILENAME} found in ${orphan} or any parent directory — run this inside a uberepo workspace.`
                )
            } finally {
                await fsp.rm(orphan, { recursive: true, force: true })
            }
        })

        it("throws a friendly error on malformed JSON", async () => {
            await writeConfig(tmp, "{ not json")
            const error = await Config.read({ cwd: tmp }).catch((e) => e)
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toContain(
                `${configPath(tmp)} isn't valid JSON:`
            )
        })

        it("throws when repositories is not an array", async () => {
            await writeConfig(tmp, `{ "repositories": "oops" }`)
            const error = await Config.read({ cwd: tmp }).catch((e) => e)
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toBe(
                `${configPath(tmp)}: "repositories" must be an array of strings`
            )
        })

        it("defaults a missing repositories field to an empty array", async () => {
            await writeConfig(tmp, `{}`)
            const config = await Config.read({ cwd: tmp })
            expect(config).toEqual({ repositories: [] })
        })
    })

    describe("edit", () => {
        it("mutates and persists, writing exact 4-space + newline bytes", async () => {
            await writeConfig(tmp, `{\n    "repositories": []\n}\n`)
            await Config.edit(
                (draft) => {
                    draft.repositories.push("x")
                },
                { cwd: tmp }
            )
            const written = await fsp.readFile(configPath(tmp), "utf8")
            const expected = { repositories: ["x"] }
            expect(written).toBe(`${JSON.stringify(expected, null, 4)}\n`)
        })

        it("returns the saved config", async () => {
            await writeConfig(tmp, `{\n    "repositories": ["a"]\n}\n`)
            const saved = await Config.edit(
                (draft) => {
                    draft.repositories.push("b")
                },
                { cwd: tmp }
            )
            expect(saved).toEqual({ repositories: ["a", "b"] })
        })

        it("awaits an async mutator before writing", async () => {
            await writeConfig(tmp, `{\n    "repositories": []\n}\n`)
            const saved = await Config.edit(
                async (draft) => {
                    await Promise.resolve()
                    draft.repositories.push("async")
                },
                { cwd: tmp }
            )
            expect(saved).toEqual({ repositories: ["async"] })
            expect(await Config.read({ cwd: tmp })).toEqual({
                repositories: ["async"]
            })
        })
    })

    describe("create", () => {
        it("writes the default config to a fresh directory", async () => {
            const config = await Config.create({ cwd: tmp })
            expect(config).toEqual({ repositories: [] })
            const written = await fsp.readFile(configPath(tmp), "utf8")
            expect(written).toBe(`{\n    "repositories": []\n}\n`)
        })

        it("throws when a config already exists", async () => {
            await Config.create({ cwd: tmp })
            const error = await Config.create({ cwd: tmp }).catch((e) => e)
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toContain(CONFIG_FILENAME)
        })
    })
})
