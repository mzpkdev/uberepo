import { execFile } from "node:child_process"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { terminal } from "cmdore"
import { vi } from "vitest"
import status from "@/commands/status"
import { CONFIG_FILENAME } from "@/config"
import { type Task, UBERTASK_FILENAME } from "@/tasks"

const exec = promisify(execFile)

// Run a git command directly (NOT the wrapper under test) so test setup stays
// independent of git.ts.
const sh = async (cwd: string, ...args: string[]): Promise<string> => {
    const { stdout } = await exec("git", args, { cwd })
    return stdout.trim()
}

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

describe("status command", () => {
    let tmp: string
    let root: string
    let cwd: string
    let configPath: string

    // Build a fresh uberepo workspace and chdir into it for each test. `root`
    // is the realpath of the workspace because macOS canonicalises /var ->
    // /private/var and git reports worktree paths under the realpath.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "status-spec-"))
        root = await fsp.realpath(tmp)
        configPath = path.join(root, CONFIG_FILENAME)
        await fsp.writeFile(configPath, `{\n    "repositories": []\n}\n`)
        cwd = process.cwd()
        process.chdir(root)
    })

    afterEach(async () => {
        // jsonMode is global state on the shared `terminal` export; leaking it
        // true would silence terminal.log in every other suite. Always reset.
        terminal.jsonMode = false
        vi.restoreAllMocks()
        process.chdir(cwd)
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    // Create a real git repo at <root>/source/<name> with one commit on main,
    // register it in the config (as a github url with that flat name), and
    // return its path.
    const makeSource = async (name: string): Promise<string> => {
        const dir = path.join(root, "source", name)
        await fsp.mkdir(dir, { recursive: true })
        await sh(dir, "init")
        await sh(dir, "config", "user.email", "test@example.com")
        await sh(dir, "config", "user.name", "Test User")
        await fsp.writeFile(path.join(dir, "README.md"), `${name}\n`)
        await sh(dir, "add", "README.md")
        await sh(dir, "commit", "-m", "initial commit")
        await sh(dir, "branch", "-M", "main")
        return dir
    }

    // Register a flat name in the config as a github url, without cloning.
    const register = async (names: string[]): Promise<void> => {
        await writeConfig(
            configPath,
            names.map((n) => `https://github.com/acme/${n}.git`)
        )
    }

    // Add a worktree for `task` to the source repo `name`, on branch
    // task/<task>, at <root>/tasks/<task>/<name>.
    const openWorktree = async (
        name: string,
        task: string
    ): Promise<string> => {
        const source = path.join(root, "source", name)
        const wt = path.join(root, "tasks", task, name)
        await sh(source, "worktree", "add", "-b", `task/${task}`, wt, "main")
        return wt
    }

    // Write a ubertask.yml at the task level (sibling of the worktree dirs),
    // optionally backdating its mtime so freshness assertions are deterministic.
    const writeNote = async (
        task: string,
        contents = "goal: |\n  do the thing\n",
        mtime?: Date
    ): Promise<string> => {
        const dir = path.join(root, "tasks", task)
        await fsp.mkdir(dir, { recursive: true })
        const file = path.join(dir, UBERTASK_FILENAME)
        await fsp.writeFile(file, contents)
        if (mtime) {
            await fsp.utimes(file, mtime, mtime)
        }
        return file
    }

    it("groups worktrees by task and renders branch + clean/dirty per repo", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")
        await openWorktree("api", "beta")

        const logs = await captureLogs(async () => {
            await status.run({ task: undefined })
        })

        // Tasks come back sorted: alpha (api, web) then beta (api).
        expect(logs[0]).toBe("alpha")
        expect(logs[1]).toContain("api")
        expect(logs[1]).toContain("task/alpha")
        expect(logs[1]).toContain("clean")
        expect(logs[2]).toContain("web")
        expect(logs[2]).toContain("task/alpha")
        // A blank separator line between tasks, then beta.
        expect(logs[3]).toBe("")
        expect(logs[4]).toBe("beta")
        expect(logs[5]).toContain("api")
        expect(logs[5]).toContain("task/beta")
    })

    it("filters to a single task when one is supplied", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")
        await openWorktree("api", "beta")

        const logs = await captureLogs(async () => {
            await status.run({ task: "beta" })
        })

        expect(logs[0]).toBe("beta")
        expect(logs.some((l) => l === "alpha")).toBe(false)
        expect(logs.join("\n")).toContain("task/beta")
    })

    it("reports a dirty worktree as dirty", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        await fsp.writeFile(path.join(wt, "README.md"), "uncommitted\n")

        const logs = await captureLogs(async () => {
            await status.run({ task: undefined })
        })

        const line = logs.find((l) => l.includes("api"))
        expect(line).toBeDefined()
        expect(line).toContain("dirty")
        expect(line).not.toContain("clean")
    })

    it("surfaces ubertask.yml with a freshness age on the task heading", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")
        // Backdate the note ~2h so the relative age is deterministic.
        await writeNote("alpha", undefined, new Date(Date.now() - 2 * 3600_000))

        const logs = await captureLogs(async () => {
            await status.run({ task: undefined })
        })

        // The marker rides the task heading line (logs[0]), not a repo line.
        expect(logs[0]).toContain("alpha")
        expect(logs[0]).toContain(`${UBERTASK_FILENAME} · updated 2h ago`)
    })

    it("shows the note's goal on its own line under the heading", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")
        await writeNote("alpha", "goal: |\n  ship the new login flow\n")

        const logs = await captureLogs(async () => {
            await status.run({ task: undefined })
        })

        // Heading first, then an indented goal line, THEN the repo lines.
        expect(logs[0]).toContain("alpha")
        expect(logs[1]).toBe("  goal: ship the new login flow")
        expect(logs[2]).toContain("api")
    })

    it("truncates a long goal to a single line with an ellipsis", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")
        const long = "x".repeat(200)
        await writeNote("alpha", `goal: |\n  ${long}\n`)

        const logs = await captureLogs(async () => {
            await status.run({ task: undefined })
        })

        const goalLine = logs.find((l) => l.startsWith("  goal: "))
        expect(goalLine).toBeDefined()
        expect((goalLine as string).endsWith("…")).toBe(true)
        // Far shorter than the raw 200-char goal — it was capped, not printed whole.
        expect((goalLine as string).length).toBeLessThan(90)
    })

    it("shows the freshness marker but no goal line for a goal-less note", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")
        // A note with empty fields (e.g. the bare seed with goal cleared).
        await writeNote("alpha", "goal: |\n\ntickets: []\n")

        const logs = await captureLogs(async () => {
            await status.run({ task: undefined })
        })

        expect(logs[0]).toContain(`${UBERTASK_FILENAME} · updated`)
        // No goal line: the next line is the repo line, not "  goal: ".
        expect(logs.some((l) => l.startsWith("  goal:"))).toBe(false)
        expect(logs[1]).toContain("api")
    })

    it("omits the note marker when the task has no ubertask.yml", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")

        const logs = await captureLogs(async () => {
            await status.run({ task: undefined })
        })

        // Bare task heading — no note file, so no marker anywhere in the output.
        expect(logs[0]).toBe("alpha")
        expect(logs.join("\n")).not.toContain(UBERTASK_FILENAME)
    })

    it("prints a friendly message when there are no open tasks", async () => {
        await makeSource("api")
        await register(["api"])

        const logs = await captureLogs(async () => {
            await status.run({ task: undefined })
        })

        expect(logs).toEqual(["No open tasks."])
    })

    it("prints a clear line for a task that does not exist", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")

        const logs = await captureLogs(async () => {
            await status.run({ task: "ghost" })
        })

        expect(logs).toHaveLength(1)
        expect(logs[0]).toContain("ghost")
        expect(logs[0].toLowerCase()).toContain("no such open task")
    })

    it("skips registered repos that are not cloned", async () => {
        await makeSource("api")
        await openWorktree("api", "alpha")
        // web is registered but never cloned; it must not appear or throw.
        await register(["api", "web"])

        const logs = await captureLogs(async () => {
            await status.run({ task: undefined })
        })

        expect(logs.join("\n")).toContain("api")
        expect(logs.some((l) => l.includes("web"))).toBe(false)
    })

    it("throws when no config exists in cwd or any parent", async () => {
        const orphan = await fsp.mkdtemp(
            path.join(os.tmpdir(), "status-orphan-")
        )
        process.chdir(orphan)
        try {
            let error: unknown
            try {
                await status.run({ task: undefined })
            } catch (e) {
                error = e
            }
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toContain(CONFIG_FILENAME)
        } finally {
            process.chdir(root)
            await fsp.rm(orphan, { recursive: true, force: true })
        }
    })

    // Run `fn` with jsonMode enabled, capturing everything written to stdout.
    // Resets jsonMode in finally before any assertion can throw, so a failing
    // expect() never leaks jsonMode true into sibling suites.
    const captureJson = async (fn: () => Promise<void>): Promise<string[]> => {
        const written: string[] = []
        vi.spyOn(process.stdout, "write").mockImplementation(
            (chunk: string | Uint8Array): boolean => {
                written.push(chunk.toString())
                return true
            }
        )
        terminal.jsonMode = true
        try {
            await fn()
        } finally {
            terminal.jsonMode = false
        }
        return written
    }

    it("emits the full Task[] under --json and leaks no human lines", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")
        await openWorktree("api", "beta")

        const written = await captureJson(async () => {
            await status.run({ task: undefined })
        })

        const output = written.join("")
        // Exactly one write — the single JSON line — proves no human heading or
        // per-repo column line leaked to stdout (those go through terminal.log,
        // which jsonMode silences).
        expect(written).toEqual([output])
        expect(output.endsWith("\n")).toBe(true)
        // A leaked human line would carry the "clean"/"dirty" state words; the
        // JSON only has them as the `dirty` key, never the literal "clean".
        expect(output).not.toContain("clean")

        const parsed = JSON.parse(output) as Task[]
        expect(parsed).toEqual([
            {
                name: "alpha",
                repos: [
                    { name: "api", branch: "task/alpha", dirty: false },
                    { name: "web", branch: "task/alpha", dirty: false }
                ]
            },
            {
                name: "beta",
                repos: [{ name: "api", branch: "task/beta", dirty: false }]
            }
        ])
    })

    it("emits only the named task as a single-element array under --json", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")
        await openWorktree("api", "beta")

        const written = await captureJson(async () => {
            await status.run({ task: "beta" })
        })

        const parsed = JSON.parse(written.join("")) as Task[]
        expect(parsed).toEqual([
            {
                name: "beta",
                repos: [{ name: "api", branch: "task/beta", dirty: false }]
            }
        ])
    })

    it("reflects a dirty worktree in the JSON payload", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        await fsp.writeFile(path.join(wt, "README.md"), "uncommitted\n")

        const written = await captureJson(async () => {
            await status.run({ task: undefined })
        })

        const parsed = JSON.parse(written.join("")) as Task[]
        expect(parsed).toEqual([
            {
                name: "alpha",
                repos: [{ name: "api", branch: "task/alpha", dirty: true }]
            }
        ])
    })

    it("includes the parsed note + mtime in the JSON payload", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")
        const mtime = new Date(Date.now() - 2 * 3600_000)
        await writeNote("alpha", undefined, mtime)

        const written = await captureJson(async () => {
            await status.run({ task: undefined })
        })

        const parsed = JSON.parse(written.join("")) as Task[]
        // The note carries its parsed fields (goal + the always-present empty
        // lists) alongside mtime — the stable shape downstream JSON consumers
        // read. Default writeNote content is `goal: | / do the thing`.
        // mtime is asserted separately with rounding: some filesystems (APFS)
        // store utimes at sub-ms precision that reads back as X.999, so an
        // exact equality against the integer set time is flaky.
        const [task] = parsed
        expect(Math.round(task.note?.mtime ?? 0)).toBe(mtime.getTime())
        expect(parsed).toEqual([
            {
                name: "alpha",
                repos: [{ name: "api", branch: "task/alpha", dirty: false }],
                note: {
                    goal: "do the thing",
                    repos: [],
                    branches: {},
                    tickets: [],
                    decisions: [],
                    blockers: [],
                    mtime: expect.any(Number)
                }
            }
        ])
    })

    it("surfaces a task's declared scope: a `scope:` line in human output, `repos` in JSON", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")
        // A note that owns only `api` and `web` (the task's declared scope).
        await writeNote(
            "alpha",
            "goal: |\n  scoped goal\n\nrepos:\n  - api\n  - web\n"
        )

        const logs = await captureLogs(async () => {
            await status.run({ task: "alpha" })
        })
        // Human view singles out the owned repos on a `scope:` line.
        expect(logs.join("\n")).toContain("scope: api, web")

        const written = await captureJson(async () => {
            await status.run({ task: "alpha" })
        })
        const parsed = JSON.parse(written.join("")) as Task[]
        // JSON carries the same scope under note.repos (flows from Ubertask).
        expect(parsed[0].note?.repos).toEqual(["api", "web"])
    })

    it("omits the `scope:` line for an unscoped task (repos: [])", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")
        await writeNote("alpha", "goal: |\n  g\n\nrepos: []\n")

        const logs = await captureLogs(async () => {
            await status.run({ task: "alpha" })
        })
        // Unscoped → nothing to single out; no scope line.
        expect(logs.join("\n")).not.toContain("scope:")
    })

    it("omits the note key from the JSON payload when absent", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")

        const written = await captureJson(async () => {
            await status.run({ task: undefined })
        })

        const parsed = JSON.parse(written.join("")) as Task[]
        // No note file → the `note` key is absent entirely (not null/empty).
        expect(parsed).toEqual([
            {
                name: "alpha",
                repos: [{ name: "api", branch: "task/alpha", dirty: false }]
            }
        ])
        expect(parsed[0]).not.toHaveProperty("note")
    })

    it("emits an empty array under --json when there are no open tasks", async () => {
        await makeSource("api")
        await register(["api"])

        const written = await captureJson(async () => {
            await status.run({ task: undefined })
        })

        expect(JSON.parse(written.join(""))).toEqual([])
    })

    it("emits an empty array under --json for a task that does not exist", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")

        const written = await captureJson(async () => {
            await status.run({ task: "ghost" })
        })

        expect(JSON.parse(written.join(""))).toEqual([])
    })

    describe("aliased participants (multiple branches per repo)", () => {
        // Open an aliased worktree on branch task/<task>@<alias>.
        const openAliased = async (
            name: string,
            task: string,
            alias: string
        ): Promise<string> => {
            const source = path.join(root, "source", name)
            const wt = path.join(root, "tasks", task, `${name}@${alias}`)
            await sh(
                source,
                "worktree",
                "add",
                "-b",
                `task/${task}@${alias}`,
                wt,
                "main"
            )
            return wt
        }

        it("lists each of a repo's participants under the task, branch per participant", async () => {
            await makeSource("autopilot")
            await makeSource("web")
            await register(["autopilot", "web"])
            await openAliased("autopilot", "alpha", "bug-fix")
            await openAliased("autopilot", "alpha", "add-feature")
            await openWorktree("web", "alpha")

            const parsed = JSON.parse(
                (
                    await captureJson(async () => {
                        await status.run({ task: "alpha" })
                    })
                ).join("")
            ) as Task[]

            // Derived from `git worktree list`, sorted by folder — a repo's
            // participants cluster, each carrying its own aliased branch.
            expect(parsed[0].repos).toEqual([
                {
                    name: "autopilot@add-feature",
                    branch: "task/alpha@add-feature",
                    dirty: false
                },
                {
                    name: "autopilot@bug-fix",
                    branch: "task/alpha@bug-fix",
                    dirty: false
                },
                { name: "web", branch: "task/alpha", dirty: false }
            ])
        })
    })
})
