import { execFile } from "node:child_process"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { terminal } from "cmdore"
import status from "@/commands/status"
import { CONFIG_FILENAME } from "@/config"

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
})
