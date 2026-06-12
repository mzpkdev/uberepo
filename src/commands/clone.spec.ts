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

// Write a config carrying repositories AND a hooks map, matching disk
// formatting, so the hook wiring can be exercised end to end.
const writeConfigWithHooks = async (
    file: string,
    repositories: string[],
    hooks: Record<string, string>
): Promise<void> => {
    await fsp.writeFile(
        file,
        `${JSON.stringify({ repositories, hooks }, null, 4)}\n`
    )
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
        terminal.jsonMode = false
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
            await clone.run({ "no-hooks": false })
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
            await clone.run({ "no-hooks": false })
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
            await clone.run({ "no-hooks": false })
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
            await clone.run({ "no-hooks": false })
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
                await clone.run({ "no-hooks": false })
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
            await clone.run({ "no-hooks": false })
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
            await clone.run({ "no-hooks": false })
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
                await clone.run({ "no-hooks": false })
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

    type CloneJson = {
        repos: { name: string; status: string; error?: string }[]
        hooks: { event: string; repo: string; exit: number }[]
    }

    it("emits { repos:[] } under --json for an empty config", async () => {
        mockClone()
        const json = await captureJson<CloneJson>(async () => {
            await clone.run({ "no-hooks": false })
        })
        expect(json).toEqual({ repos: [], hooks: [] })
    })

    it("emits cloned vs skipped per repo under --json", async () => {
        await writeConfig(configPath, [
            "https://github.com/acme/api.git",
            "https://github.com/acme/web.git"
        ])
        // api already on disk → skipped; web → freshly cloned.
        await fsp.mkdir(path.join(tmp, "source", "api"), { recursive: true })
        mockClone()
        const json = await captureJson<CloneJson>(async () => {
            await clone.run({ "no-hooks": false })
        })
        expect(json).toEqual({
            repos: [
                { name: "api", status: "skipped" },
                { name: "web", status: "cloned" }
            ],
            hooks: []
        })
    })

    it("emits the failing repo as status:failed with its error under --json, then rethrows", async () => {
        await writeConfig(configPath, [
            "https://github.com/acme/a.git",
            "https://github.com/acme/b.git",
            "https://github.com/acme/c.git"
        ])
        mockClone("https://github.com/acme/b.git")

        // The failed path emits JSON and rethrows, so capture stdout directly
        // (the shared captureJson awaits a clean return) and assert both.
        const written: string[] = []
        const spy = vi
            .spyOn(process.stdout, "write")
            .mockImplementation((chunk: string | Uint8Array): boolean => {
                written.push(chunk.toString())
                return true
            })
        terminal.jsonMode = true
        let error: unknown
        try {
            await clone.run({ "no-hooks": false })
        } catch (e) {
            error = e
        } finally {
            terminal.jsonMode = false
            spy.mockRestore()
        }

        expect(error).toBeInstanceOf(Error)
        const json = JSON.parse(written.join("")) as CloneJson
        // a cloned, b failed (fail-fast: c never attempted, so it is absent).
        expect(json.repos).toEqual([
            { name: "a", status: "cloned" },
            {
                name: "b",
                status: "failed",
                error: "boom cloning https://github.com/acme/b.git"
            }
        ])
    })

    describe("hooks", () => {
        it("fires post-clone ONLY for freshly cloned repos, not skipped ones", async () => {
            await writeConfigWithHooks(
                configPath,
                [
                    "https://github.com/acme/api.git",
                    "https://github.com/acme/web.git"
                ],
                { "post-clone": "touch hooked" }
            )
            // api already on disk → skipped (no hook); web → cloned (hook runs).
            await fsp.mkdir(path.join(tmp, "source", "api"), {
                recursive: true
            })
            mockClone()
            await captureOutput(async () => {
                await clone.run({ "no-hooks": false })
            })
            // The skipped repo never got the hook...
            await expect(
                fsp.stat(path.join(root, "source", "api", "hooked"))
            ).rejects.toThrow()
            // ...the freshly-cloned one did, in its own source/<name> dir.
            const stat = await fsp.stat(
                path.join(root, "source", "web", "hooked")
            )
            expect(stat.isFile()).toBe(true)
        })

        it("includes the hooks array (cloned repos only) under --json", async () => {
            await writeConfigWithHooks(
                configPath,
                [
                    "https://github.com/acme/api.git",
                    "https://github.com/acme/web.git"
                ],
                { "post-clone": "true" }
            )
            await fsp.mkdir(path.join(tmp, "source", "api"), {
                recursive: true
            })
            mockClone()
            const json = await captureJson<CloneJson>(async () => {
                await clone.run({ "no-hooks": false })
            })
            // api skipped → no hook entry; web cloned → one exit-0 entry.
            expect(json.hooks).toEqual([
                { event: "post-clone", repo: "web", exit: 0 }
            ])
        })

        it("does not run hooks under --no-hooks", async () => {
            await writeConfigWithHooks(
                configPath,
                ["https://github.com/acme/web.git"],
                { "post-clone": "touch hooked" }
            )
            mockClone()
            const json = await captureJson<CloneJson>(async () => {
                await clone.run({ "no-hooks": true })
            })
            expect(json.hooks).toEqual([])
            await expect(
                fsp.stat(path.join(root, "source", "web", "hooked"))
            ).rejects.toThrow()
        })

        it("continues past a failing hook and exits non-zero, leaving clones intact", async () => {
            await writeConfigWithHooks(
                configPath,
                [
                    "https://github.com/acme/api.git",
                    "https://github.com/acme/web.git"
                ],
                // api's hook fails; web's still runs (loop continues).
                {
                    "post-clone":
                        'test "$UBEREPO_REPO" = api && exit 1 || touch ok'
                }
            )
            mockClone()
            const previousExit = process.exitCode
            process.exitCode = undefined
            let json: CloneJson
            try {
                json = await captureJson<CloneJson>(async () => {
                    await clone.run({ "no-hooks": false })
                })
                // The failing hook flips the command's exit code...
                expect(process.exitCode).toBe(1)
            } finally {
                process.exitCode = previousExit
            }
            // ...both repos were still cloned (no rollback)...
            const repos = json.repos
            expect(repos).toEqual([
                { name: "api", status: "cloned" },
                { name: "web", status: "cloned" }
            ])
            // ...and the loop continued: web's hook ran after api's failure.
            expect(json.hooks).toEqual([
                { event: "post-clone", repo: "api", exit: 1 },
                { event: "post-clone", repo: "web", exit: 0 }
            ])
            const stat = await fsp.stat(path.join(root, "source", "web", "ok"))
            expect(stat.isFile()).toBe(true)
        })

        it("pre-clone failure skips the clone, exits non-zero, and a re-run picks it up", async () => {
            await writeConfigWithHooks(
                configPath,
                ["https://github.com/acme/api.git"],
                // The gate holds while the block file exists.
                { "pre-clone": 'test ! -f "$UBEREPO_WORKSPACE/block"' }
            )
            await fsp.writeFile(path.join(root, "block"), "")
            const { calls } = mockClone()

            const previousExit = process.exitCode
            process.exitCode = undefined
            let json: CloneJson
            try {
                json = await captureJson<CloneJson>(async () => {
                    await clone.run({ "no-hooks": false })
                })
                expect(process.exitCode).toBe(1)
            } finally {
                process.exitCode = previousExit
            }
            // The gate held: git.clone never ran, the repo is skipped.
            expect(calls).toEqual([])
            expect(json.repos).toEqual([
                {
                    name: "api",
                    status: "skipped",
                    reason: "pre-clone hook failed"
                }
            ])
            expect(json.hooks).toEqual([
                { event: "pre-clone", repo: "api", exit: 1 }
            ])

            // Fix the cause and re-run: the skipped repo is picked up.
            await fsp.rm(path.join(root, "block"))
            const rerun = await captureJson<CloneJson>(async () => {
                await clone.run({ "no-hooks": false })
            })
            expect(rerun.repos).toEqual([{ name: "api", status: "cloned" }])
            expect(calls).toEqual([
                {
                    url: "https://github.com/acme/api.git",
                    dest: path.join(root, "source", "api")
                }
            ])
        })

        it("runs pre-clone at the workspace root with UBEREPO_REPO_PATH naming the would-be clone", async () => {
            await writeConfigWithHooks(
                configPath,
                ["https://github.com/acme/api.git"],
                {
                    "pre-clone":
                        'echo "$PWD|$UBEREPO_REPO_PATH|$UBEREPO_EVENT" > "$UBEREPO_WORKSPACE/pre.txt"'
                }
            )
            mockClone()
            await captureJson<CloneJson>(async () => {
                await clone.run({ "no-hooks": false })
            })
            const line = (
                await fsp.readFile(path.join(root, "pre.txt"), "utf8")
            ).trim()
            expect(line).toBe(
                `${root}|${path.join(root, "source", "api")}|pre-clone`
            )
        })

        it("does not run pre-clone under --no-hooks", async () => {
            await writeConfigWithHooks(
                configPath,
                ["https://github.com/acme/api.git"],
                { "pre-clone": "exit 1" }
            )
            mockClone()
            const json = await captureJson<CloneJson>(async () => {
                await clone.run({ "no-hooks": true })
            })
            expect(json.repos).toEqual([{ name: "api", status: "cloned" }])
            expect(json.hooks).toEqual([])
        })
    })
})
