import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { terminal } from "cmdore"
import { vi } from "vitest"
import clone from "@/commands/clone"
import { CONFIG_FILENAME } from "@/config"
import git, { Repository } from "@/git"

// Write a config file from a list of repositories, matching disk formatting.
const writeConfig = async (
    file: string,
    repositories: string[]
): Promise<void> => {
    await fsp.writeFile(file, `${JSON.stringify({ repositories }, null, 4)}\n`)
}

// Capture terminal.log/warn output for the duration of `fn`, then restore.
const captureOutput = async (
    fn: () => Promise<void>
): Promise<{ logs: string[]; warnings: string[] }> => {
    const originalLog = terminal.log
    const originalWarn = terminal.warn
    const logs: string[] = []
    const warnings: string[] = []
    terminal.log = (message?: string) => {
        logs.push(message ?? "")
    }
    terminal.warn = (message?: string) => {
        warnings.push(message ?? "")
    }
    try {
        await fn()
    } finally {
        terminal.log = originalLog
        terminal.warn = originalWarn
    }
    return { logs, warnings }
}

// Spy on git.clone so no network/git is hit. The mock records every
// (url, dest) call and creates `dest` on disk so skip-if-present is
// exercisable across a single run. `throwFor` makes the clone of a designated
// url reject (to test fail-fast).
const mockClone = (throwFor?: string) => {
    const calls: Array<{ url: string; dest: string }> = []
    const spy = vi
        .spyOn(git, "clone")
        .mockImplementation(async (url: string, dest: string) => {
            calls.push({ url, dest })
            if (url === throwFor) {
                throw new Error(`boom cloning ${url}`)
            }
            await fsp.mkdir(dest, { recursive: true })
            return new Repository(dest)
        })
    return { calls, spy }
}

describe("clone command", () => {
    let tmp: string
    let root: string
    let cwd: string
    let configPath: string

    // Build a fresh uberepo workspace and chdir into it for each test. `root`
    // is the realpath of the workspace: Config.root() resolves via
    // process.cwd(), which macOS canonicalises (/var -> /private/var), so
    // expected dests are built from the realpath, not the raw mkdtemp path.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "clone-spec-"))
        root = await fsp.realpath(tmp)
        configPath = path.join(tmp, CONFIG_FILENAME)
        await fsp.writeFile(configPath, `{\n    "repositories": []\n}\n`)
        cwd = process.cwd()
        process.chdir(tmp)
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        process.chdir(cwd)
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    it("clones every registered repo to <root>/source/<name>, in order", async () => {
        await writeConfig(configPath, [
            "https://github.com/acme/a.git",
            "https://github.com/acme/b.git",
            "https://github.com/acme/c.git"
        ])
        const { calls } = mockClone()
        await captureOutput(async () => {
            await clone.run({})
        })
        expect(calls).toEqual([
            {
                url: "https://github.com/acme/a.git",
                dest: path.join(root, "source", "a")
            },
            {
                url: "https://github.com/acme/b.git",
                dest: path.join(root, "source", "b")
            },
            {
                url: "https://github.com/acme/c.git",
                dest: path.join(root, "source", "c")
            }
        ])
    })

    it("derives the flat name from the last slug segment of ssh and https urls", async () => {
        await writeConfig(configPath, [
            "git@github.com:acme/api.git",
            "https://github.com/acme/web"
        ])
        const { calls } = mockClone()
        await captureOutput(async () => {
            await clone.run({})
        })
        expect(calls.map((c) => c.dest)).toEqual([
            path.join(root, "source", "api"),
            path.join(root, "source", "web")
        ])
    })

    it("skips a repo whose source/<name> already exists, clones the rest", async () => {
        await writeConfig(configPath, [
            "https://github.com/acme/api.git",
            "https://github.com/acme/web.git"
        ])
        await fsp.mkdir(path.join(tmp, "source", "api"), { recursive: true })
        const { calls } = mockClone()
        const { logs } = await captureOutput(async () => {
            await clone.run({})
        })
        expect(calls).toEqual([
            {
                url: "https://github.com/acme/web.git",
                dest: path.join(root, "source", "web")
            }
        ])
        expect(
            logs.some((l) => l.includes("Skipping") && l.includes("api"))
        ).toBe(true)
    })

    it("throws and clones nothing when two distinct repos collide on a flat name", async () => {
        await writeConfig(configPath, [
            "https://github.com/acme/api.git",
            "https://github.com/other/api.git"
        ])
        const { calls } = mockClone()
        let error: unknown
        try {
            await clone.run({})
        } catch (e) {
            error = e
        }
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain("source/api")
        expect((error as Error).message).toContain("github.com/acme/api")
        expect((error as Error).message).toContain("github.com/other/api")
        expect(calls).toHaveLength(0)
    })

    it("fails fast on the first clone error and never attempts later repos", async () => {
        await writeConfig(configPath, [
            "https://github.com/acme/a.git",
            "https://github.com/acme/b.git",
            "https://github.com/acme/c.git"
        ])
        const { calls } = mockClone("https://github.com/acme/b.git")
        let error: unknown
        try {
            await captureOutput(async () => {
                await clone.run({})
            })
        } catch (e) {
            error = e
        }
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain("github.com/acme/b.git")
        // a was attempted and b failed; c must never be attempted.
        expect(calls.map((c) => c.url)).toEqual([
            "https://github.com/acme/a.git",
            "https://github.com/acme/b.git"
        ])
        // The first repo's clone landed on disk before the failure.
        expect(
            await fsp
                .stat(path.join(tmp, "source", "a"))
                .then((s) => s.isDirectory())
        ).toBe(true)
    })

    it("roots source/ at the workspace root, not the current directory", async () => {
        await writeConfig(configPath, ["https://github.com/acme/api.git"])
        const nested = path.join(tmp, "packages", "deep")
        await fsp.mkdir(nested, { recursive: true })
        process.chdir(nested)
        const { calls } = mockClone()
        await captureOutput(async () => {
            await clone.run({})
        })
        expect(calls).toEqual([
            {
                url: "https://github.com/acme/api.git",
                dest: path.join(root, "source", "api")
            }
        ])
    })

    it("logs a nothing-to-clone message and never calls git.clone for an empty config", async () => {
        const { calls } = mockClone()
        const { logs } = await captureOutput(async () => {
            await clone.run({})
        })
        expect(calls).toHaveLength(0)
        expect(logs).toEqual(["Nothing to clone — no repositories registered."])
    })

    it("throws when no config exists in cwd or any parent", async () => {
        const orphan = await fsp.mkdtemp(
            path.join(os.tmpdir(), "clone-orphan-")
        )
        process.chdir(orphan)
        const { calls } = mockClone()
        try {
            let error: unknown
            try {
                await clone.run({})
            } catch (e) {
                error = e
            }
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toContain(CONFIG_FILENAME)
            expect(calls).toHaveLength(0)
        } finally {
            process.chdir(tmp)
            await fsp.rm(orphan, { recursive: true, force: true })
        }
    })
})
