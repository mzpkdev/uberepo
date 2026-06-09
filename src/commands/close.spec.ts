import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { terminal } from "cmdore"
import close from "@/commands/close"
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

// Capture terminal.log + terminal.warn output for the duration of `fn`, then
// restore them. close uses log for per-repo lines + summary and warn for the
// not-found path, so both are needed.
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

describe("close command", () => {
    let tmp: string
    let root: string
    let cwd: string
    let configPath: string

    // Build a fresh uberepo workspace and chdir into it for each test. `root`
    // is the realpath of the workspace because macOS canonicalises /var ->
    // /private/var and git reports worktree paths under the realpath.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "close-spec-"))
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
    // wired to a local bare "upstream" repo as origin (no network) with
    // origin/HEAD set to main. This makes the unmerged check meaningful: a task
    // branch is "merged" only while its tip is an ancestor of origin/main.
    const makeSource = async (name: string): Promise<string> => {
        const upstream = path.join(root, "upstream", `${name}.git`)
        await fsp.mkdir(upstream, { recursive: true })
        await sh(upstream, "init", "--bare", "--initial-branch=main")

        const dir = path.join(root, "source", name)
        await fsp.mkdir(dir, { recursive: true })
        await sh(dir, "init")
        await sh(dir, "config", "user.email", "test@example.com")
        await sh(dir, "config", "user.name", "Test User")
        await fsp.writeFile(path.join(dir, "README.md"), `${name}\n`)
        await sh(dir, "add", "README.md")
        await sh(dir, "commit", "-m", "initial commit")
        await sh(dir, "branch", "-M", "main")
        await sh(dir, "remote", "add", "origin", upstream)
        await sh(dir, "push", "-u", "origin", "main")
        // Resolve refs/remotes/origin/HEAD so `rev-parse origin/HEAD` works.
        await sh(dir, "remote", "set-head", "origin", "main")
        return dir
    }

    // Register flat names in the config as github urls, without cloning.
    const register = async (names: string[]): Promise<void> => {
        await writeConfig(
            configPath,
            names.map((n) => `https://github.com/acme/${n}.git`)
        )
    }

    // Add a worktree for `task` to the source repo `name`, on branch
    // task/<task>, at <root>/tasks/<task>/<name>, branched off main (so its tip
    // is merged into origin/main).
    const openWorktree = async (
        name: string,
        task: string
    ): Promise<string> => {
        const source = path.join(root, "source", name)
        const wt = path.join(root, "tasks", task, name)
        await sh(source, "worktree", "add", "-b", `task/${task}`, wt, "main")
        return wt
    }

    // Whether the local branch task/<task> still exists in source repo `name`.
    const branchExists = async (
        name: string,
        task: string
    ): Promise<boolean> => {
        const source = path.join(root, "source", name)
        try {
            await sh(
                source,
                "show-ref",
                "--verify",
                "--quiet",
                `refs/heads/task/${task}`
            )
            return true
        } catch {
            return false
        }
    }

    // Realpath of <root>/tasks/<task>/<name>, for existence checks under the
    // canonicalised /private/var path on macOS.
    const taskDir = (task: string, name: string): string =>
        path.join(root, "tasks", task, name)

    it("closes a fully-merged task: removes every worktree and deletes the branch", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")

        const { logs } = await captureOutput(async () => {
            await close.run({ task: "alpha", force: false })
        })

        for (const name of ["api", "web"]) {
            expect(fs.existsSync(taskDir("alpha", name))).toBe(false)
            expect(await branchExists(name, "alpha")).toBe(false)
        }
        const joined = logs.join("\n")
        expect(joined).toContain("api: closed")
        expect(joined).toContain("web: closed")
        expect(joined).toContain("Closed task alpha in 2 repositories")
    })

    it("without --force, skips a repo with uncommitted changes; --force closes it", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        // Uncommitted change in the worktree makes it dirty -> unsafe.
        await fsp.writeFile(path.join(wt, "README.md"), "uncommitted\n")

        const { logs } = await captureOutput(async () => {
            await close.run({ task: "alpha", force: false })
        })

        // Skipped: worktree and branch both remain.
        expect(fs.existsSync(taskDir("alpha", "api"))).toBe(true)
        expect(await branchExists("api", "alpha")).toBe(true)
        const joined = logs.join("\n")
        expect(joined).toContain("api: uncommitted changes — use --force")
        expect(joined).toContain("Closed task alpha in 0 repositories")
        expect(joined).toContain("Skipped 1 repository")

        // --force closes the dirty repo regardless.
        const forced = await captureOutput(async () => {
            await close.run({ task: "alpha", force: true })
        })
        expect(fs.existsSync(taskDir("alpha", "api"))).toBe(false)
        expect(await branchExists("api", "alpha")).toBe(false)
        expect(forced.logs.join("\n")).toContain("api: closed")
    })

    it("without --force, skips a repo whose task branch has unmerged commits; --force closes it", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        // A committed-but-unpushed change on the task branch: its tip is no
        // longer an ancestor of origin/main, so the branch is unmerged.
        await fsp.writeFile(path.join(wt, "feature.txt"), "work\n")
        await sh(wt, "add", "feature.txt")
        await sh(wt, "commit", "-m", "feature work")

        const { logs } = await captureOutput(async () => {
            await close.run({ task: "alpha", force: false })
        })

        expect(fs.existsSync(taskDir("alpha", "api"))).toBe(true)
        expect(await branchExists("api", "alpha")).toBe(true)
        const joined = logs.join("\n")
        expect(joined).toContain("api: unmerged commits — use --force")
        expect(joined).toContain("Closed task alpha in 0 repositories")
        expect(joined).toContain("Skipped 1 repository")

        // --force closes the unmerged repo regardless.
        const forced = await captureOutput(async () => {
            await close.run({ task: "alpha", force: true })
        })
        expect(fs.existsSync(taskDir("alpha", "api"))).toBe(false)
        expect(await branchExists("api", "alpha")).toBe(false)
        expect(forced.logs.join("\n")).toContain("api: closed")
    })

    it("continues and reports: closes the safe repo, skips the unsafe one", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha") // safe (merged, clean)
        const webWt = await openWorktree("web", "alpha")
        // Make web unsafe via an uncommitted change.
        await fsp.writeFile(path.join(webWt, "README.md"), "uncommitted\n")

        const { logs } = await captureOutput(async () => {
            await close.run({ task: "alpha", force: false })
        })

        // api closed...
        expect(fs.existsSync(taskDir("alpha", "api"))).toBe(false)
        expect(await branchExists("api", "alpha")).toBe(false)
        // ...web left intact.
        expect(fs.existsSync(taskDir("alpha", "web"))).toBe(true)
        expect(await branchExists("web", "alpha")).toBe(true)
        const joined = logs.join("\n")
        expect(joined).toContain("api: closed")
        expect(joined).toContain("web: uncommitted changes — use --force")
        expect(joined).toContain("Closed task alpha in 1 repository")
        expect(joined).toContain("Skipped 1 repository")
    })

    it("warns and exits clean when the task is not found, touching nothing", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")

        const { logs, warnings } = await captureOutput(async () => {
            await close.run({ task: "ghost", force: false })
        })

        // The real task is untouched.
        expect(fs.existsSync(taskDir("alpha", "api"))).toBe(true)
        expect(await branchExists("api", "alpha")).toBe(true)
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain("ghost")
        expect(logs.some((l) => l.includes("Closed task"))).toBe(false)
    })

    it("--force closes everything regardless of dirty or unmerged state", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        const apiWt = await openWorktree("api", "alpha")
        const webWt = await openWorktree("web", "alpha")
        // api dirty, web unmerged — both would be skipped without --force.
        await fsp.writeFile(path.join(apiWt, "README.md"), "uncommitted\n")
        await fsp.writeFile(path.join(webWt, "feature.txt"), "work\n")
        await sh(webWt, "add", "feature.txt")
        await sh(webWt, "commit", "-m", "feature work")

        const { logs } = await captureOutput(async () => {
            await close.run({ task: "alpha", force: true })
        })

        for (const name of ["api", "web"]) {
            expect(fs.existsSync(taskDir("alpha", name))).toBe(false)
            expect(await branchExists(name, "alpha")).toBe(false)
        }
        const joined = logs.join("\n")
        expect(joined).toContain("Closed task alpha in 2 repositories")
        expect(joined).not.toContain("Skipped")
    })

    it("throws when no config exists in cwd or any parent", async () => {
        const orphan = await fsp.mkdtemp(
            path.join(os.tmpdir(), "close-orphan-")
        )
        process.chdir(orphan)
        try {
            let error: unknown
            try {
                await close.run({ task: "alpha", force: false })
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
