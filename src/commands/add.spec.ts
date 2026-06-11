import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { terminal } from "cmdore"
import { vi } from "vitest"
import add from "@/commands/add"
import { CONFIG_FILENAME } from "@/config"

const readConfig = async (file: string): Promise<unknown> => {
    return JSON.parse(await fsp.readFile(file, "utf8"))
}

// Run `fn` with jsonMode enabled, returning the single parsed JSON object the
// command wrote to stdout. Resets jsonMode in finally before any assertion can
// throw, so a failing expect() never leaks jsonMode into sibling suites.
const captureJson = async <T>(fn: () => Promise<void>): Promise<T> => {
    const written: string[] = []
    const spy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: string | Uint8Array): boolean => {
            written.push(chunk.toString())
            return true
        })
    terminal.jsonMode = true
    try {
        await fn()
    } finally {
        terminal.jsonMode = false
        spy.mockRestore()
    }
    const output = written.join("")
    expect(written).toEqual([output])
    expect(output.endsWith("\n")).toBe(true)
    return JSON.parse(output) as T
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

describe("add command", () => {
    let tmp: string
    let cwd: string
    let configPath: string

    // Build a fresh uberepo workspace and chdir into it for each test.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "add-spec-"))
        configPath = path.join(tmp, CONFIG_FILENAME)
        await fsp.writeFile(configPath, `{\n    "repositories": []\n}\n`)
        cwd = process.cwd()
        process.chdir(tmp)
    })

    afterEach(async () => {
        // jsonMode is global state on the shared terminal export; reset it
        // defensively so a leak never silences terminal.log in other suites.
        terminal.jsonMode = false
        vi.restoreAllMocks()
        process.chdir(cwd)
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    it("appends the repository to an empty config", async () => {
        await add.run({ repositories: ["git@github.com:acme/api.git"] })
        expect(await readConfig(configPath)).toEqual({
            repositories: ["git@github.com:acme/api.git"]
        })
    })

    it("appends without dropping existing repositories", async () => {
        await fsp.writeFile(
            configPath,
            `{\n    "repositories": ["https://github.com/acme/a.git"]\n}\n`
        )
        await add.run({ repositories: ["https://github.com/acme/b.git"] })
        expect(await readConfig(configPath)).toEqual({
            repositories: [
                "https://github.com/acme/a.git",
                "https://github.com/acme/b.git"
            ]
        })
    })

    it("stores a normal https URL", async () => {
        await add.run({ repositories: ["https://github.com/acme/api.git"] })
        expect(await readConfig(configPath)).toEqual({
            repositories: ["https://github.com/acme/api.git"]
        })
    })

    it("stores the user's transport verbatim, only trimming and stripping trailing slashes", async () => {
        await add.run({
            repositories: ["  ssh://git@example.com/acme/api.git/  "]
        })
        expect(await readConfig(configPath)).toEqual({
            repositories: ["ssh://git@example.com/acme/api.git"]
        })
    })

    it("preserves 4-space indentation and a trailing newline", async () => {
        await add.run({ repositories: ["https://github.com/acme/api.git"] })
        const written = await fsp.readFile(configPath, "utf8")
        expect(written).toBe(
            `{\n    "repositories": [\n        "https://github.com/acme/api.git"\n    ]\n}\n`
        )
    })

    it("warns and does not duplicate when the same identity is already present", async () => {
        await add.run({ repositories: ["https://github.com/acme/api.git"] })
        const warnings = await captureWarnings(async () => {
            await add.run({ repositories: ["https://github.com/acme/api.git"] })
        })
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain("github.com/acme/api")
        expect(await readConfig(configPath)).toEqual({
            repositories: ["https://github.com/acme/api.git"]
        })
    })

    it("dedupes SSH (scp-like) and HTTPS forms of the same repo to one entry", async () => {
        await add.run({ repositories: ["git@github.com:foo/bar.git"] })
        const warnings = await captureWarnings(async () => {
            await add.run({ repositories: ["https://github.com/foo/bar.git"] })
        })
        expect(warnings).toHaveLength(1)
        expect(await readConfig(configPath)).toEqual({
            repositories: ["git@github.com:foo/bar.git"]
        })
    })

    it("dedupes trailing-slash and .git variants of the same repo", async () => {
        await add.run({ repositories: ["https://github.com/foo/bar"] })
        const warnings = await captureWarnings(async () => {
            await add.run({ repositories: ["https://github.com/foo/bar.git/"] })
        })
        expect(warnings).toHaveLength(1)
        expect(await readConfig(configPath)).toEqual({
            repositories: ["https://github.com/foo/bar"]
        })
    })

    it("rejects input that is not a URL", async () => {
        let error: unknown
        try {
            await add.run({ repositories: ["not a url"] })
        } catch (e) {
            error = e
        }
        expect(error).toBeInstanceOf(Error)
        // Nothing should have been written.
        expect(await readConfig(configPath)).toEqual({ repositories: [] })
    })

    it("rejects an unsupported scheme", async () => {
        let error: unknown
        try {
            await add.run({ repositories: ["ftp://x/y"] })
        } catch (e) {
            error = e
        }
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain("ftp:")
        expect(await readConfig(configPath)).toEqual({ repositories: [] })
    })

    it("adds multiple new URLs in one call, preserving order", async () => {
        await add.run({
            repositories: [
                "git@github.com:acme/api.git",
                "https://github.com/acme/web"
            ]
        })
        expect(await readConfig(configPath)).toEqual({
            repositories: [
                "git@github.com:acme/api.git",
                "https://github.com/acme/web"
            ]
        })
        // Same 4-space-indent formatting as the single-arg path.
        const written = await fsp.readFile(configPath, "utf8")
        expect(written).toBe(
            `{\n    "repositories": [\n        "git@github.com:acme/api.git",\n        "https://github.com/acme/web"\n    ]\n}\n`
        )
    })

    it("dedupes two URL forms of the same repo within one batch", async () => {
        const warnings = await captureWarnings(async () => {
            await add.run({
                repositories: [
                    "git@github.com:acme/api.git",
                    "https://github.com/acme/api"
                ]
            })
        })
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain("github.com/acme/api")
        expect(await readConfig(configPath)).toEqual({
            repositories: ["git@github.com:acme/api.git"]
        })
    })

    it("skips a URL already in the manifest while adding the new ones in the batch", async () => {
        await add.run({ repositories: ["https://github.com/acme/api.git"] })
        const warnings = await captureWarnings(async () => {
            await add.run({
                repositories: [
                    "git@github.com:acme/api.git",
                    "https://github.com/acme/web.git"
                ]
            })
        })
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain("git@github.com:acme/api.git")
        expect(await readConfig(configPath)).toEqual({
            repositories: [
                "https://github.com/acme/api.git",
                "https://github.com/acme/web.git"
            ]
        })
    })

    it("rejects the whole batch and writes nothing when any URL is malformed", async () => {
        let error: unknown
        try {
            await add.run({
                repositories: [
                    "https://github.com/acme/api.git",
                    "not a url",
                    "https://github.com/acme/web.git"
                ]
            })
        } catch (e) {
            error = e
        }
        expect(error).toBeInstanceOf(Error)
        // Nothing should have been written — validation happens before any edit.
        expect(await readConfig(configPath)).toEqual({ repositories: [] })
    })

    it("walks up parent directories to find the config", async () => {
        const nested = path.join(tmp, "packages", "deep")
        await fsp.mkdir(nested, { recursive: true })
        process.chdir(nested)
        await add.run({ repositories: ["https://github.com/acme/nested.git"] })
        expect(await readConfig(configPath)).toEqual({
            repositories: ["https://github.com/acme/nested.git"]
        })
    })

    it("throws when no config exists in cwd or any parent", async () => {
        const orphan = await fsp.mkdtemp(path.join(os.tmpdir(), "add-orphan-"))
        process.chdir(orphan)
        try {
            let error: unknown
            try {
                await add.run({
                    repositories: ["https://github.com/acme/api.git"]
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

    it("emits { added, skipped } under --json: names added, URLs already present skipped", async () => {
        await add.run({ repositories: ["https://github.com/acme/api.git"] })
        const json = await captureJson<{ added: string[]; skipped: string[] }>(
            async () => {
                await add.run({
                    repositories: [
                        "https://github.com/acme/api.git",
                        "https://github.com/acme/web.git"
                    ]
                })
            }
        )
        // api was already registered (skipped, by URL); web is freshly added
        // (by flat name, the same token the human summary lists).
        expect(json).toEqual({
            added: ["web"],
            skipped: ["https://github.com/acme/api.git"]
        })
    })

    it("emits empty skipped under --json when every repo is new", async () => {
        const json = await captureJson<{ added: string[]; skipped: string[] }>(
            async () => {
                await add.run({
                    repositories: [
                        "git@github.com:acme/api.git",
                        "https://github.com/acme/web.git"
                    ]
                })
            }
        )
        expect(json).toEqual({ added: ["api", "web"], skipped: [] })
    })
})
