import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { terminal } from "cmdore"
import { vi } from "vitest"
import sources from "@/commands/sources"
import { CONFIG_FILENAME } from "@/config"

// Write a config file from a list of repositories, matching disk formatting.
const writeConfig = async (
    file: string,
    repositories: string[]
): Promise<void> => {
    await fsp.writeFile(file, `${JSON.stringify({ repositories }, null, 4)}\n`)
}

// Simulate cloned repos by creating source/<name> directories (no git needed —
// the command only checks for directory existence).
const markCloned = async (root: string, names: string[]): Promise<void> => {
    for (const name of names) {
        await fsp.mkdir(path.join(root, "source", name), { recursive: true })
    }
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
    let root: string
    let cwd: string
    let configPath: string

    // Build a fresh uberepo workspace and chdir into it for each test. `root`
    // is the realpath of the workspace: Config.root() resolves via
    // process.cwd(), which macOS canonicalises (/var -> /private/var), so
    // source/<name> paths are built from the realpath, not the raw mkdtemp path.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "sources-spec-"))
        root = await fsp.realpath(tmp)
        configPath = path.join(tmp, CONFIG_FILENAME)
        await fsp.writeFile(configPath, `{\n    "repositories": []\n}\n`)
        cwd = process.cwd()
        process.chdir(tmp)
    })

    afterEach(async () => {
        // jsonMode is global state on the shared `terminal` export; leaking it
        // true would silence terminal.log in every other suite. Always reset.
        terminal.jsonMode = false
        vi.restoreAllMocks()
        process.chdir(cwd)
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    it("marks each repo ✓ when source/<name> exists and — when it doesn't", async () => {
        await writeConfig(configPath, [
            "https://github.com/acme/api.git",
            "https://github.com/acme/web.git",
            "https://github.com/acme/cli.git"
        ])
        await markCloned(root, ["api", "cli"])
        const logs = await captureLogs(async () => {
            await sources.run({})
        })
        expect(logs.slice(0, 3)).toEqual([
            "✓ api  https://github.com/acme/api.git",
            "— web  https://github.com/acme/web.git",
            "✓ cli  https://github.com/acme/cli.git"
        ])
    })

    it("ends with a tally of registered/cloned/missing counts", async () => {
        await writeConfig(configPath, [
            "https://github.com/acme/api.git",
            "https://github.com/acme/web.git",
            "https://github.com/acme/cli.git"
        ])
        await markCloned(root, ["api", "cli"])
        const logs = await captureLogs(async () => {
            await sources.run({})
        })
        expect(logs[logs.length - 1]).toBe(
            "\n3 registered · 2 cloned · 1 missing"
        )
    })

    it("prints the stored URL verbatim alongside each name", async () => {
        await writeConfig(configPath, [
            "git@github.com:acme/api.git",
            "https://github.com/acme/web"
        ])
        await markCloned(root, ["api"])
        const logs = await captureLogs(async () => {
            await sources.run({})
        })
        expect(logs.slice(0, 2)).toEqual([
            "✓ api  git@github.com:acme/api.git",
            "— web  https://github.com/acme/web"
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

    it("emits a single JSON array of { name, url, cloned } under --json and no human lines", async () => {
        await writeConfig(configPath, [
            "https://github.com/acme/api.git",
            "https://github.com/acme/web.git",
            "https://github.com/acme/cli.git"
        ])
        await markCloned(root, ["api", "cli"])

        const written: string[] = []
        const writeSpy = vi
            .spyOn(process.stdout, "write")
            .mockImplementation((chunk: string | Uint8Array): boolean => {
                written.push(chunk.toString())
                return true
            })

        terminal.jsonMode = true
        try {
            await sources.run({})
        } finally {
            // Reset before any assertion can throw, so a failing expect()
            // never leaks jsonMode into sibling suites.
            terminal.jsonMode = false
        }

        const output = written.join("")
        // Exactly one JSON line; no human tally/log lines leaked to stdout.
        expect(written).toEqual([`${output}`])
        expect(output.endsWith("\n")).toBe(true)
        expect(output).not.toContain("registered")
        expect(output).not.toContain("✓")
        expect(JSON.parse(output)).toEqual([
            {
                name: "api",
                url: "https://github.com/acme/api.git",
                cloned: true
            },
            {
                name: "web",
                url: "https://github.com/acme/web.git",
                cloned: false
            },
            {
                name: "cli",
                url: "https://github.com/acme/cli.git",
                cloned: true
            }
        ])

        writeSpy.mockRestore()
    })
})
