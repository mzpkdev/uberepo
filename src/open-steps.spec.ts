import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { effect, terminal } from "cmdore"
import type { UberepoConfig } from "@/config"
import { parseBranchSpecs } from "@/open-plan"
import { type OpenStepCtx, openRepoWorktree } from "@/open-steps"

const exec = promisify(execFile)

// Run a git command directly (NOT the wrapper under test) so test setup and
// assertions stay independent of git.ts.
const sh = async (cwd: string, ...args: string[]): Promise<string> => {
    const { stdout } = await exec("git", args, { cwd })
    return stdout.trim()
}

// Swallow terminal.log/warn/error for the duration of `fn` so the step's plan
// lines don't pollute the test output, restoring them after.
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const log = terminal.log
    const warn = terminal.warn
    const error = terminal.error
    terminal.log = () => {}
    terminal.warn = () => {}
    terminal.error = () => {}
    try {
        return await fn()
    } finally {
        terminal.log = log
        terminal.warn = warn
        terminal.error = error
    }
}

// Run `fn` with effect() disabled (the state cmdore sets under --dry-run),
// restoring the previous flag after. This is exactly what the framework does
// around a command's run() when --dry-run is passed.
const dryRun = async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = effect.enabled
    effect.enabled = false
    try {
        return await fn()
    } finally {
        effect.enabled = previous
    }
}

describe("openRepoWorktree — effect()-wrapped dry-run vs real run", () => {
    let tmp: string
    let root: string

    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "open-steps-spec-"))
        // realpath because macOS canonicalises /var -> /private/var.
        root = await fsp.realpath(tmp)
    })

    afterEach(async () => {
        await fsp.rm(tmp, { recursive: true, force: true })
        // Never leak a disabled effect into another test.
        effect.enabled = true
    })

    const url = (name: string): string =>
        `https://example.test/acme/${name}.git`

    // A bare "remote" with one commit, optionally carrying a pre-existing
    // branch, then a working clone at source/<name> pointed at it — the role
    // source/<name> plays in a real workspace, with a real origin so the
    // adopt-from-origin path can be exercised.
    const makeRepo = async (
        name: string,
        opts?: { remoteBranch?: string }
    ): Promise<string> => {
        const seed = path.join(root, "_seed", name)
        await fsp.mkdir(seed, { recursive: true })
        await sh(seed, "init")
        await sh(seed, "config", "user.email", "test@example.com")
        await sh(seed, "config", "user.name", "Test User")
        await fsp.writeFile(path.join(seed, "README.md"), `${name}\n`)
        await sh(seed, "add", "README.md")
        await sh(seed, "commit", "-m", "initial commit")
        if (opts?.remoteBranch) {
            await sh(seed, "branch", opts.remoteBranch)
        }
        const bare = path.join(root, "_remote", `${name}.git`)
        await sh(root, "clone", "--bare", seed, bare)
        const head = await sh(seed, "symbolic-ref", "--short", "HEAD")
        await sh(bare, "symbolic-ref", "HEAD", `refs/heads/${head}`)
        const source = path.join(root, "source", name)
        await sh(root, "clone", bare, source)
        return source
    }

    const ctx = (over: Partial<OpenStepCtx> = {}): OpenStepCtx => ({
        config: { repositories: [url("api")] },
        root,
        task: "alpha",
        branchSpec: parseBranchSpecs(undefined),
        base: "HEAD",
        urlByName: new Map([["api", url("api")]]),
        ...over
    })

    it("dry-run: creates NO worktree on disk but reports the planned create", async () => {
        await makeRepo("api")
        const dest = path.join(root, "tasks", "alpha", "api")

        const result = await quiet(() =>
            dryRun(() => openRepoWorktree("api", ctx()))
        )

        // The plan is faithful: a created worktree on the default branch.
        expect(result.repo).toEqual({ name: "api", status: "created" })
        expect(result.opened).toBe(true)
        expect(result.branch).toEqual({ name: "task/alpha", adopted: false })
        // Nothing landed on disk: no worktree dir, no extra branch, no carry.
        expect(fs.existsSync(dest)).toBe(false)
        expect(result.carry).toBeUndefined()
        const branches = await sh(path.join(root, "source", "api"), "branch")
        expect(branches).not.toContain("task/alpha")
    })

    it("dry-run: fires NO hooks but the plan is unaffected", async () => {
        await makeRepo("api")
        const marker = path.join(root, "HOOKS_FIRED")
        const config: UberepoConfig = {
            repositories: [url("api")],
            hooks: {
                "pre-open": `sh -c 'echo x >> "${marker}"'`,
                "post-open": `sh -c 'echo x >> "${marker}"'`
            }
        }

        const result = await quiet(() =>
            dryRun(() => openRepoWorktree("api", ctx({ config })))
        )

        // No hook fired (the marker file was never written) and none recorded.
        expect(fs.existsSync(marker)).toBe(false)
        expect(result.hooks).toEqual([])
        // The plan still reports the worktree it WOULD create.
        expect(result.repo.status).toBe("created")
        expect(result.opened).toBe(true)
    })

    it("dry-run: an on-origin branch is reported as a would-ADOPT, no local branch cut", async () => {
        // feat/sso exists on the remote → a real open ADOPTS + tracks it. The
        // dry-run plan must still say adopted:true without creating it locally.
        await makeRepo("api", { remoteBranch: "feat/sso" })

        const result = await quiet(() =>
            dryRun(() =>
                openRepoWorktree(
                    "api",
                    ctx({ branchSpec: parseBranchSpecs(["api=feat/sso"]) })
                )
            )
        )

        expect(result.repo.status).toBe("created")
        expect(result.branch).toEqual({ name: "feat/sso", adopted: true })
        // The local branch was NOT created (adopt is a mutation, skipped).
        const branches = await sh(path.join(root, "source", "api"), "branch")
        expect(branches).not.toContain("feat/sso")
    })

    it("real run: actually creates the worktree on the resolved branch", async () => {
        await makeRepo("api")
        const dest = path.join(root, "tasks", "alpha", "api")

        const result = await quiet(() => openRepoWorktree("api", ctx()))

        expect(result.repo).toEqual({ name: "api", status: "created" })
        expect(fs.existsSync(dest)).toBe(true)
        // The worktree is checked out on task/alpha.
        const branch = await sh(dest, "rev-parse", "--abbrev-ref", "HEAD")
        expect(branch).toBe("task/alpha")
    })

    it("real run: every repeated --branch spec is honored per repo (adopt + create)", async () => {
        // api adopts an on-origin branch; web creates a fresh one. Both names
        // were supplied as repeated --branch tokens, which cmdore accumulates.
        await makeRepo("api", { remoteBranch: "feat/sso" })
        await makeRepo("web")
        const spec = parseBranchSpecs(["api=feat/sso", "web=feat/web"])
        const urlByName = new Map([
            ["api", url("api")],
            ["web", url("web")]
        ])
        const config: UberepoConfig = {
            repositories: [url("api"), url("web")]
        }

        const apiOut = await quiet(() =>
            openRepoWorktree(
                "api",
                ctx({ config, branchSpec: spec, urlByName })
            )
        )
        const webOut = await quiet(() =>
            openRepoWorktree(
                "web",
                ctx({ config, branchSpec: spec, urlByName })
            )
        )

        // api landed on the ADOPTED feat/sso; web on the CREATED feat/web.
        expect(apiOut.branch).toEqual({ name: "feat/sso", adopted: true })
        expect(webOut.branch).toEqual({ name: "feat/web", adopted: false })
        const apiBranch = await sh(
            path.join(root, "tasks", "alpha", "api"),
            "rev-parse",
            "--abbrev-ref",
            "HEAD"
        )
        const webBranch = await sh(
            path.join(root, "tasks", "alpha", "web"),
            "rev-parse",
            "--abbrev-ref",
            "HEAD"
        )
        expect(apiBranch).toBe("feat/sso")
        expect(webBranch).toBe("feat/web")
    })
})
