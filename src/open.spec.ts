import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { effect, terminal } from "cmdore"
import openCmd from "@/commands/open"

const exec = promisify(execFile)

const sh = async (cwd: string, ...args: string[]): Promise<string> => {
    const { stdout } = await exec("git", args, { cwd })
    return stdout.trim()
}

// The argv shape `open`'s run() consumes. Only the keys a test sets matter; the
// rest default to undefined, exactly as cmdore would hand them over.
type OpenArgv = {
    task: string
    from?: string
    goal?: string
    repos?: string[]
    branch?: string[]
    "no-hooks"?: boolean
}

// Drive the open command end-to-end against the workspace `cwd`, capturing the
// terminal.json payload (open emits exactly one) and the log lines. effect()
// is toggled to match `dryRun`, mirroring what the framework does for the
// global --dry-run flag, and restored after along with cwd and the terminal.
const runOpen = async (
    cwd: string,
    argv: OpenArgv,
    opts?: { dryRun?: boolean }
): Promise<{ json: unknown; logs: string[] }> => {
    const previousCwd = process.cwd()
    const previousEffect = effect.enabled
    const previousJsonMode = terminal.jsonMode
    const log = terminal.log
    const json = terminal.json
    const logs: string[] = []
    let payload: unknown
    process.chdir(cwd)
    effect.enabled = !opts?.dryRun
    // open only emits terminal.json when jsonMode is on; flip it so the payload
    // is captured, exactly as `--json` would.
    terminal.jsonMode = true
    terminal.log = (message?: string) => {
        logs.push(message ?? "")
    }
    terminal.json = (data: unknown) => {
        payload = data
    }
    try {
        await openCmd.run(argv as never)
        return { json: payload, logs }
    } finally {
        process.chdir(previousCwd)
        effect.enabled = previousEffect
        terminal.jsonMode = previousJsonMode
        terminal.log = log
        terminal.json = json
        process.exitCode = undefined
    }
}

describe("open command — dry-run is a real preview, never a mutation", () => {
    let tmp: string
    let root: string

    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "open-spec-"))
        root = await fsp.realpath(tmp)
    })

    afterEach(async () => {
        await fsp.rm(tmp, { recursive: true, force: true })
        effect.enabled = true
    })

    const url = (name: string): string =>
        `https://example.test/acme/${name}.git`

    // A pre-cloned source/<name> with a real origin, plus a uberepo.json
    // registering it. open never has to clone (source exists), so the fake host
    // is never contacted.
    const makeWorkspace = async (
        names: string[],
        opts?: { remoteBranch?: Record<string, string> }
    ): Promise<void> => {
        await fsp.writeFile(
            path.join(root, "uberepo.json"),
            JSON.stringify({ repositories: names.map(url) })
        )
        for (const name of names) {
            const seed = path.join(root, "_seed", name)
            await fsp.mkdir(seed, { recursive: true })
            await sh(seed, "init")
            await sh(seed, "config", "user.email", "test@example.com")
            await sh(seed, "config", "user.name", "Test User")
            await fsp.writeFile(path.join(seed, "README.md"), `${name}\n`)
            await sh(seed, "add", "README.md")
            await sh(seed, "commit", "-m", "init")
            const remoteBranch = opts?.remoteBranch?.[name]
            if (remoteBranch) {
                await sh(seed, "branch", remoteBranch)
            }
            const bare = path.join(root, "_remote", `${name}.git`)
            await sh(root, "clone", "--bare", seed, bare)
            const head = await sh(seed, "symbolic-ref", "--short", "HEAD")
            await sh(bare, "symbolic-ref", "HEAD", `refs/heads/${head}`)
            await sh(root, "clone", bare, path.join(root, "source", name))
        }
    }

    it("dry-run creates NO task dir, worktree, branch, or note — but the JSON reports the plan", async () => {
        await makeWorkspace(["api", "web"])

        const { json } = await runOpen(root, { task: "t1" }, { dryRun: true })

        // Nothing on disk.
        expect(fs.existsSync(path.join(root, "tasks"))).toBe(false)
        expect(
            (await sh(path.join(root, "source", "api"), "branch")).includes(
                "task/t1"
            )
        ).toBe(false)
        // The JSON is the faithful plan: both repos would be created, and the
        // would-be note rides along (so an --json consumer sees the outcome).
        expect(json).toMatchObject({
            task: "t1",
            repos: [
                { name: "api", status: "created" },
                { name: "web", status: "created" }
            ],
            clone: [],
            hooks: [],
            carry: []
        })
        expect(json).toHaveProperty("note")
    })

    it("dry-run plans an ADOPT for an on-origin --branch without writing the note's branches", async () => {
        await makeWorkspace(["api"], { remoteBranch: { api: "feat/sso" } })

        const { json } = await runOpen(
            root,
            { task: "t2", branch: ["api=feat/sso"] },
            { dryRun: true }
        )

        // The plan records the adopted branch in the would-be note...
        expect(json).toMatchObject({
            note: { branches: { api: { name: "feat/sso", adopted: true } } }
        })
        // ...but nothing was written to disk and no local branch was cut.
        expect(fs.existsSync(path.join(root, "tasks", "t2"))).toBe(false)
        expect(
            (await sh(path.join(root, "source", "api"), "branch")).includes(
                "feat/sso"
            )
        ).toBe(false)
    })

    it("a REAL open after a dry-run still creates the worktree and persists the note", async () => {
        await makeWorkspace(["api"], { remoteBranch: { api: "feat/sso" } })

        // First a dry-run (must be a no-op)...
        await runOpen(
            root,
            { task: "t3", branch: ["api=feat/sso"] },
            {
                dryRun: true
            }
        )
        expect(fs.existsSync(path.join(root, "tasks", "t3"))).toBe(false)

        // ...then the real open lands everything.
        const { json } = await runOpen(root, {
            task: "t3",
            branch: ["api=feat/sso"]
        })

        const dest = path.join(root, "tasks", "t3", "api")
        expect(fs.existsSync(dest)).toBe(true)
        expect(await sh(dest, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
            "feat/sso"
        )
        const note = await fsp.readFile(
            path.join(root, "tasks", "t3", "ubertask.yml"),
            "utf8"
        )
        expect(note).toContain("name: feat/sso")
        expect(note).toContain("adopted: true")
        expect(json).toMatchObject({
            repos: [{ name: "api", status: "created" }]
        })
    })

    it("real open honors every repeated --branch spec (the cmdore-accumulation contract)", async () => {
        await makeWorkspace(["api", "web"], {
            remoteBranch: { api: "feat/sso" }
        })

        await runOpen(root, {
            task: "t4",
            branch: ["api=feat/sso", "web=feat/web"]
        })

        // Both names reached open and each repo adopted/created the right one.
        expect(
            await sh(
                path.join(root, "tasks", "t4", "api"),
                "rev-parse",
                "--abbrev-ref",
                "HEAD"
            )
        ).toBe("feat/sso")
        expect(
            await sh(
                path.join(root, "tasks", "t4", "web"),
                "rev-parse",
                "--abbrev-ref",
                "HEAD"
            )
        ).toBe("feat/web")
    })

    it("ERRORS loudly when a --branch names a repo outside the open's scope (no silent default, no partial write)", async () => {
        await makeWorkspace(["api", "web"])

        // Scope to api only, but name web in --branch: web can't be honored, so
        // the run must abort before creating anything.
        await expect(
            runOpen(root, {
                task: "t5",
                repos: ["api"],
                branch: ["web=feat/x"]
            })
        ).rejects.toThrow("names a repo outside this open's scope")

        // Nothing was created — the guard fires before any worktree/note write.
        expect(fs.existsSync(path.join(root, "tasks", "t5"))).toBe(false)
    })
})
