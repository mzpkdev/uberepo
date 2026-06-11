import { execFile } from "node:child_process"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { terminal } from "cmdore"
import { vi } from "vitest"
import pull from "@/commands/pull"
import { CONFIG_FILENAME } from "@/config"

const exec = promisify(execFile)

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
// restore them. pull uses log for per-repo lines + summary; warn is captured
// too so a stray warning would surface.
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

describe("pull command", () => {
    let tmp: string
    let root: string
    let cwd: string
    let configPath: string

    // Build a fresh uberepo workspace and chdir into it for each test. `root`
    // is the realpath of the workspace because macOS canonicalises /var ->
    // /private/var and git reports paths under the realpath.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pull-spec-"))
        root = await fsp.realpath(tmp)
        configPath = path.join(root, CONFIG_FILENAME)
        await fsp.writeFile(configPath, `{\n    "repositories": []\n}\n`)
        cwd = process.cwd()
        process.chdir(root)
    })

    afterEach(async () => {
        terminal.jsonMode = false
        vi.restoreAllMocks()
        process.chdir(cwd)
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    // Create a real git repo at <root>/source/<name> with one commit on main,
    // wired to a local bare "upstream" repo as origin (no network) with
    // origin/HEAD set to main and main tracking origin/main (push -u). The bare
    // repo is the shared truth we can advance to simulate other people merging.
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
        // push -u sets branch.main.{remote,merge} so `git pull --ff-only` has a
        // configured upstream to fast-forward against.
        await sh(dir, "push", "-u", "origin", "main")
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

    // Advance the shared upstream's main by one commit that touches `file`,
    // routed through a throwaway clone so it never disturbs the source repo.
    // Returns the new origin/main commit sha.
    const advanceUpstream = async (
        name: string,
        file: string,
        contents: string
    ): Promise<string> => {
        const upstream = path.join(root, "upstream", `${name}.git`)
        const pusher = path.join(root, "pusher", name)
        await fsp.mkdir(path.dirname(pusher), { recursive: true })
        await sh(path.dirname(pusher), "clone", upstream, pusher)
        await sh(pusher, "config", "user.email", "other@example.com")
        await sh(pusher, "config", "user.name", "Other User")
        await fsp.writeFile(path.join(pusher, file), contents)
        await sh(pusher, "add", file)
        await sh(pusher, "commit", "-m", `upstream: ${file}`)
        await sh(pusher, "push", "origin", "main")
        await fsp.rm(pusher, { recursive: true, force: true })
        return sh(upstream, "rev-parse", "main")
    }

    // sha the source repo `name`'s current HEAD points at.
    const headSha = (name: string): Promise<string> => {
        const source = path.join(root, "source", name)
        return sh(source, "rev-parse", "HEAD")
    }

    // Number of parents of `name`'s current HEAD commit. A merge commit has 2+;
    // a fast-forward or a plain commit has exactly 1, so this catches an
    // accidental merge.
    const headParentCount = async (name: string): Promise<number> => {
        const source = path.join(root, "source", name)
        const parents = await sh(
            source,
            "rev-list",
            "--parents",
            "-n",
            "1",
            "HEAD"
        )
        // "<commit> <parent1> [<parent2> ...]" — parents are every field but
        // the first.
        return parents.split(/\s+/).length - 1
    }

    it("fast-forwards a clone when origin has advanced", async () => {
        await makeSource("api")
        await register(["api"])
        const before = await headSha("api")
        const tip = await advanceUpstream("api", "upstream.txt", "api\n")
        expect(tip).not.toBe(before)

        const { logs, warnings } = await captureOutput(async () => {
            await pull.run({})
        })

        // HEAD moved to the new upstream tip via a fast-forward.
        expect(await headSha("api")).toBe(tip)
        expect(await headParentCount("api")).toBe(1)
        const joined = logs.join("\n")
        expect(joined).toContain("api: pulled")
        expect(joined).toContain("1 pulled · 0 up to date · 0 skipped")
        expect(warnings).toHaveLength(0)
    })

    it("reports up to date when origin has not moved, leaving HEAD unchanged", async () => {
        await makeSource("api")
        await register(["api"])
        const before = await headSha("api")

        const { logs } = await captureOutput(async () => {
            await pull.run({})
        })

        expect(await headSha("api")).toBe(before)
        const joined = logs.join("\n")
        expect(joined).toContain("api: up to date")
        expect(joined).not.toContain("api: pulled")
        expect(joined).toContain("0 pulled · 1 up to date · 0 skipped")
    })

    it("skips a dirty clone, leaving HEAD and the working tree untouched", async () => {
        const dir = await makeSource("api")
        await register(["api"])
        const before = await headSha("api")
        // Uncommitted change to a tracked file, and origin advances so a pull
        // would otherwise have something to fast-forward.
        await fsp.writeFile(path.join(dir, "README.md"), "uncommitted\n")
        await advanceUpstream("api", "upstream.txt", "api\n")

        const { logs } = await captureOutput(async () => {
            await pull.run({})
        })

        const joined = logs.join("\n")
        expect(joined).toContain("api: uncommitted changes — skipped")
        expect(joined).not.toContain("api: pulled")
        expect(joined).toContain("0 pulled · 0 up to date · 1 skipped")
        // Nothing pulled: HEAD is unchanged and the dirty edit is intact.
        expect(await headSha("api")).toBe(before)
        expect(await fsp.readFile(path.join(dir, "README.md"), "utf8")).toBe(
            "uncommitted\n"
        )
    })

    it("skips a diverged clone (can't fast-forward), creating no merge commit", async () => {
        const dir = await makeSource("api")
        await register(["api"])
        // Origin gains a commit the clone doesn't have...
        await advanceUpstream("api", "upstream.txt", "from upstream\n")
        // ...and the clone gains a local commit on main origin doesn't have.
        // The two branches now diverge, so --ff-only must refuse.
        await fsp.writeFile(path.join(dir, "local.txt"), "local work\n")
        await sh(dir, "add", "local.txt")
        await sh(dir, "commit", "-m", "local work on main")
        const before = await headSha("api")

        const { logs } = await captureOutput(async () => {
            await pull.run({})
        })

        const joined = logs.join("\n")
        expect(joined).toContain("api: can't fast-forward — skipped")
        expect(joined).not.toContain("api: pulled")
        expect(joined).toContain("0 pulled · 0 up to date · 1 skipped")
        // The local branch tip is unchanged and no merge was created.
        expect(await headSha("api")).toBe(before)
        expect(await headParentCount("api")).toBe(1)
    })

    it("skips a registered-but-not-cloned repo while still pulling the cloned ones", async () => {
        // api is cloned; web is registered but never cloned.
        await makeSource("api")
        await register(["api", "web"])
        const tip = await advanceUpstream("api", "upstream.txt", "api\n")

        const { logs } = await captureOutput(async () => {
            await pull.run({})
        })

        const joined = logs.join("\n")
        expect(joined).toContain("web: not cloned — run clone")
        // The cloned repo still fast-forwarded.
        expect(await headSha("api")).toBe(tip)
        expect(joined).toContain("api: pulled")
        // Tally counts only cloned repos; the not-cloned web is excluded.
        expect(joined).toContain("1 pulled · 0 up to date · 0 skipped")
    })

    it("logs a nothing-to-pull message when no registered repo is cloned", async () => {
        // Both registered, neither cloned.
        await register(["api", "web"])

        const { logs } = await captureOutput(async () => {
            await pull.run({})
        })

        const joined = logs.join("\n")
        expect(joined).toContain("Nothing to pull — no cloned repositories.")
        // Each registered repo is still flagged as not cloned.
        expect(joined).toContain("api: not cloned — run clone")
        expect(joined).toContain("web: not cloned — run clone")
        // No tally line on the nothing-to-pull path.
        expect(joined).not.toContain("skipped")
    })

    it("throws when no config exists in cwd or any parent", async () => {
        const orphan = await fsp.mkdtemp(path.join(os.tmpdir(), "pull-orphan-"))
        process.chdir(orphan)
        try {
            let error: unknown
            try {
                await pull.run({})
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

    type PullJson = {
        repos: { name: string; status: string; reason?: string }[]
    }

    it("emits updated/current per repo under --json", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        // api's upstream advances (→ updated); web's does not (→ current).
        await advanceUpstream("api", "upstream.txt", "api\n")

        const json = await captureJson<PullJson>(async () => {
            await pull.run({})
        })
        expect(json).toEqual({
            repos: [
                { name: "api", status: "updated" },
                { name: "web", status: "current" }
            ]
        })
    })

    it("emits skipped with the matching reason for dirty and not-cloned repos under --json", async () => {
        const dir = await makeSource("api")
        // web is registered but never cloned (no source/web).
        await register(["api", "web"])
        // Make api dirty so it is skipped for uncommitted changes.
        await fsp.writeFile(path.join(dir, "README.md"), "uncommitted\n")

        const json = await captureJson<PullJson>(async () => {
            await pull.run({})
        })
        expect(json).toEqual({
            repos: [
                {
                    name: "api",
                    status: "skipped",
                    reason: "uncommitted changes"
                },
                { name: "web", status: "skipped", reason: "not cloned" }
            ]
        })
    })

    it("emits { repos:[] } under --json when nothing is registered", async () => {
        const json = await captureJson<PullJson>(async () => {
            await pull.run({})
        })
        expect(json).toEqual({ repos: [] })
    })
})
