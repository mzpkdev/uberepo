import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { terminal } from "cmdore"
import remove from "@/commands/remove"
import { CONFIG_FILENAME } from "@/config"

const readConfig = async (file: string): Promise<unknown> => {
    return JSON.parse(await fsp.readFile(file, "utf8"))
}

// Write a config file from a list of repositories, matching disk formatting.
const writeConfig = async (
    file: string,
    repositories: string[]
): Promise<void> => {
    await fsp.writeFile(file, `${JSON.stringify({ repositories }, null, 4)}\n`)
}

// Capture terminal.warn output for the duration of `fn`, then restore it.
const captureWarnings = async (fn: () => Promise<void>): Promise<string[]> => {
    const original = terminal.warn
    const warnings: string[] = []
    terminal.warn = (message?: string) => {
        warnings.push(message ?? "")
    }
    try {
        await fn()
    } finally {
        terminal.warn = original
    }
    return warnings
}

describe("remove command", () => {
    let tmp: string
    let cwd: string
    let configPath: string

    // Build a fresh uberepo workspace and chdir into it for each test.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "remove-spec-"))
        configPath = path.join(tmp, CONFIG_FILENAME)
        await fsp.writeFile(configPath, `{\n    "repositories": []\n}\n`)
        cwd = process.cwd()
        process.chdir(tmp)
    })

    afterEach(async () => {
        process.chdir(cwd)
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    it("removes an entry stored in the same form as the input", async () => {
        await writeConfig(configPath, ["git@github.com:acme/api.git"])
        await remove.run({ repository: "git@github.com:acme/api.git" })
        expect(await readConfig(configPath)).toEqual({ repositories: [] })
    })

    it("removes an SSH entry when given the HTTPS form (seam-closer)", async () => {
        await writeConfig(configPath, ["git@github.com:acme/api.git"])
        await remove.run({ repository: "https://github.com/acme/api" })
        expect(await readConfig(configPath)).toEqual({ repositories: [] })
    })

    it("matches and removes despite a trailing slash and .git in the input", async () => {
        await writeConfig(configPath, ["https://github.com/acme/api"])
        await remove.run({ repository: "https://github.com/acme/api.git/" })
        expect(await readConfig(configPath)).toEqual({ repositories: [] })
    })

    it("removes ALL twins that share an identity", async () => {
        await writeConfig(configPath, [
            "git@github.com:acme/api.git",
            "https://github.com/acme/api"
        ])
        await remove.run({ repository: "https://github.com/acme/api.git" })
        expect(await readConfig(configPath)).toEqual({ repositories: [] })
    })

    it("warns and leaves the config unchanged when the repo is not present", async () => {
        await writeConfig(configPath, ["https://github.com/acme/api.git"])
        const before = await fsp.readFile(configPath, "utf8")
        const warnings = await captureWarnings(async () => {
            await remove.run({
                repository: "https://github.com/acme/other.git"
            })
        })
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain("github.com/acme/other")
        expect(await fsp.readFile(configPath, "utf8")).toBe(before)
    })

    it("rejects input that is not a URL and leaves the config unchanged", async () => {
        await writeConfig(configPath, ["https://github.com/acme/api.git"])
        const before = await fsp.readFile(configPath, "utf8")
        let error: unknown
        try {
            await remove.run({ repository: "not a url" })
        } catch (e) {
            error = e
        }
        expect(error).toBeInstanceOf(Error)
        expect(await fsp.readFile(configPath, "utf8")).toBe(before)
    })

    it("throws when no config exists in cwd or any parent", async () => {
        const orphan = await fsp.mkdtemp(
            path.join(os.tmpdir(), "remove-orphan-")
        )
        process.chdir(orphan)
        try {
            let error: unknown
            try {
                await remove.run({
                    repository: "https://github.com/acme/api.git"
                })
            } catch (e) {
                error = e
            }
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toContain(CONFIG_FILENAME)
        } finally {
            process.chdir(tmp)
            await fsp.rm(orphan, { recursive: true, force: true })
        }
    })

    it("removes one of several entries and leaves the others intact", async () => {
        await writeConfig(configPath, [
            "https://github.com/acme/a.git",
            "https://github.com/acme/b.git",
            "https://github.com/acme/c.git"
        ])
        await remove.run({ repository: "https://github.com/acme/b.git" })
        expect(await readConfig(configPath)).toEqual({
            repositories: [
                "https://github.com/acme/a.git",
                "https://github.com/acme/c.git"
            ]
        })
    })
})
