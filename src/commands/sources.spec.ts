import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { terminal } from "cmdore"
import sources from "@/commands/sources"
import { CONFIG_FILENAME } from "@/config"

// Write a config file from a list of repositories, matching disk formatting.
const writeConfig = async (
    file: string,
    repositories: string[]
): Promise<void> => {
    await fsp.writeFile(file, `${JSON.stringify({ repositories }, null, 4)}\n`)
}

// Capture terminal.log output for the duration of `fn`, then restore it.
const captureLogs = async (fn: () => Promise<void>): Promise<string[]> => {
    const original = terminal.log
    const logs: string[] = []
    terminal.log = (message?: string) => {
        logs.push(message ?? "")
    }
    try {
        await fn()
    } finally {
        terminal.log = original
    }
    return logs
}

describe("sources command", () => {
    let tmp: string
    let cwd: string
    let configPath: string

    // Build a fresh uberepo workspace and chdir into it for each test.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "sources-spec-"))
        configPath = path.join(tmp, CONFIG_FILENAME)
        await fsp.writeFile(configPath, `{\n    "repositories": []\n}\n`)
        cwd = process.cwd()
        process.chdir(tmp)
    })

    afterEach(async () => {
        process.chdir(cwd)
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    it("lists every registered repo, one log line each, in config order", async () => {
        await writeConfig(configPath, [
            "https://github.com/acme/a.git",
            "https://github.com/acme/b.git",
            "https://github.com/acme/c.git"
        ])
        const logs = await captureLogs(async () => {
            await sources.run({})
        })
        expect(logs).toEqual([
            "https://github.com/acme/a.git",
            "https://github.com/acme/b.git",
            "https://github.com/acme/c.git"
        ])
    })

    it("prints the stored URL verbatim", async () => {
        await writeConfig(configPath, [
            "git@github.com:acme/api.git",
            "https://github.com/acme/web"
        ])
        const logs = await captureLogs(async () => {
            await sources.run({})
        })
        expect(logs).toEqual([
            "git@github.com:acme/api.git",
            "https://github.com/acme/web"
        ])
    })

    it("logs the empty-config message and nothing else", async () => {
        const logs = await captureLogs(async () => {
            await sources.run({})
        })
        expect(logs).toEqual([
            `No repositories registered in ${CONFIG_FILENAME}.`
        ])
    })

    it("throws when no config exists in cwd or any parent", async () => {
        const orphan = await fsp.mkdtemp(
            path.join(os.tmpdir(), "sources-orphan-")
        )
        process.chdir(orphan)
        try {
            let error: unknown
            try {
                await sources.run({})
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
})
