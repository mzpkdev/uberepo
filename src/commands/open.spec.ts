import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { terminal } from "cmdore"
import open from "@/commands/open"
import { CONFIG_FILENAME } from "@/config"

const exec = promisify(execFile)

// Run a git command directly (NOT the wrapper under test) so test setup and
// assertions stay independent of git.ts.
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

describe("open command", () => {
    let tmp: string
    let root: string
    let cwd: string
    let configPath: string

    // Build a fresh uberepo workspace and chdir into it for each test. `root`
    // is the realpath of the workspace because macOS canonicalises /var ->
    // /private/var and git reports worktree paths under the realpath.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "open-spec-"))
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

    // Create a real git repo at <root>/source/<name> with one commit on main
    // and return its path. Registration is done separately via register().
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

    // Register flat names in the config as github urls, without cloning.
    const register = async (names: string[]): Promise<void> => {
        await writeConfig(
            configPath,
            names.map((n) => `https://github.com/acme/${n}.git`)
        )
    }

    // Realpath of <root>/tasks/<task>/<name>, for comparing against the path
    // git reports (which is canonicalised under /private/var on macOS).
    const worktreeReal = async (task: string, name: string): Promise<string> =>
        fs.realpathSync(path.join(root, "tasks", task, name))

    // The short branch name a source repo's worktree for `task` sits on.
    const branchAt = async (name: string, task: string): Promise<string> => {
        const wt = path.join(root, "tasks", task, name)
        return sh(wt, "rev-parse", "--abbrev-ref", "HEAD")
    }

    it("opens a worktree in every cloned repo on branch task/<task>", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])

        const logs = await captureLogs(async () => {
            await open.run({ task: "alpha", from: undefined })
        })

        for (const name of ["api", "web"]) {
            const dir = path.join(root, "tasks", "alpha", name)
            expect(fs.existsSync(dir)).toBe(true)
            expect(await branchAt(name, "alpha")).toBe("task/alpha")
        }
        expect(logs.join("\n")).toContain("Opened task alpha in 2 repositories")
    })

    it("respects --from, branching off the given ref instead of HEAD", async () => {
        const dir = await makeSource("api")
        // Commit a second time on main; tag the FIRST commit so --from points
        // at a ref that is strictly behind current HEAD.
        const firstSha = await sh(dir, "rev-parse", "HEAD")
        await sh(dir, "tag", "base", firstSha)
        await fsp.writeFile(path.join(dir, "second.txt"), "second\n")
        await sh(dir, "add", "second.txt")
        await sh(dir, "commit", "-m", "second commit")
        const headSha = await sh(dir, "rev-parse", "HEAD")
        expect(headSha).not.toBe(firstSha)
        await register(["api"])

        await captureLogs(async () => {
            await open.run({ task: "alpha", from: "base" })
        })

        const wt = path.join(root, "tasks", "alpha", "api")
        // The worktree branched off the tag, so its tip is the first commit,
        // not the repo's current HEAD.
        expect(await sh(wt, "rev-parse", "HEAD")).toBe(firstSha)
        expect(fs.existsSync(path.join(wt, "second.txt"))).toBe(false)
    })

    it("defaults the base to the clone's current HEAD when --from is omitted", async () => {
        const dir = await makeSource("api")
        await fsp.writeFile(path.join(dir, "second.txt"), "second\n")
        await sh(dir, "add", "second.txt")
        await sh(dir, "commit", "-m", "second commit")
        const headSha = await sh(dir, "rev-parse", "HEAD")
        await register(["api"])

        await captureLogs(async () => {
            await open.run({ task: "alpha", from: undefined })
        })

        const wt = path.join(root, "tasks", "alpha", "api")
        expect(await sh(wt, "rev-parse", "HEAD")).toBe(headSha)
        expect(fs.existsSync(path.join(wt, "second.txt"))).toBe(true)
    })

    it("is idempotent and picks up a repo cloned after the first run", async () => {
        await makeSource("api")
        await register(["api"])

        const first = await captureLogs(async () => {
            await open.run({ task: "alpha", from: undefined })
        })
        expect(first.join("\n")).toContain("Opened task alpha in 1 repository")
        const apiReal = await worktreeReal("alpha", "api")

        // A second repo is cloned + registered only AFTER the first open.
        await makeSource("web")
        await register(["api", "web"])

        const second = await captureLogs(async () => {
            await open.run({ task: "alpha", from: undefined })
        })

        // api is left exactly as it was (same path, not recreated)...
        expect(await worktreeReal("alpha", "api")).toBe(apiReal)
        expect(second.join("\n")).toContain("already open")
        // ...while web is opened on the second run.
        expect(fs.existsSync(path.join(root, "tasks", "alpha", "web"))).toBe(
            true
        )
        expect(await branchAt("web", "alpha")).toBe("task/alpha")
        expect(second.join("\n")).toContain("Opened task alpha in 1 repository")
    })

    it("warns and skips an uncloned repo while opening the cloned ones", async () => {
        await makeSource("api")
        // web is registered but never cloned.
        await register(["api", "web"])

        const logs = await captureLogs(async () => {
            await open.run({ task: "alpha", from: undefined })
        })

        expect(fs.existsSync(path.join(root, "tasks", "alpha", "api"))).toBe(
            true
        )
        expect(fs.existsSync(path.join(root, "tasks", "alpha", "web"))).toBe(
            false
        )
        const joined = logs.join("\n")
        expect(joined).toContain("Skipping web — not cloned")
        expect(joined).toContain("Opened task alpha in 1 repository")
    })

    it("fails fast: a later repo is not opened once one repo errors", async () => {
        await makeSource("api")
        await makeSource("web")
        // Order matters: api is first. An invalid --from makes its worktree
        // creation fail, which must abort before web is ever attempted.
        await register(["api", "web"])

        let error: unknown
        await captureLogs(async () => {
            try {
                await open.run({ task: "alpha", from: "does-not-exist" })
            } catch (e) {
                error = e
            }
        })

        expect(error).toBeInstanceOf(Error)
        // api failed mid-creation; web was never reached.
        expect(fs.existsSync(path.join(root, "tasks", "alpha", "web"))).toBe(
            false
        )
    })

    it("throws when no config exists in cwd or any parent", async () => {
        const orphan = await fsp.mkdtemp(path.join(os.tmpdir(), "open-orphan-"))
        process.chdir(orphan)
        try {
            let error: unknown
            try {
                await open.run({ task: "alpha", from: undefined })
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
