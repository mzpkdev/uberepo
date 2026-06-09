import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import git, { GitError, Repository, Worktree } from "@/git"

const exec = promisify(execFile)

// Run a git command with Node's child_process directly (NOT the wrapper under
// test) so test setup and assertions stay independent of git.ts.
const sh = async (cwd: string, ...args: string[]): Promise<string> => {
    const { stdout } = await exec("git", args, { cwd })
    return stdout.trim()
}

describe("Worktree.parse", () => {
    const porcelain = [
        "worktree /repo/source/api",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "",
        "worktree /repo/tasks/foo/api",
        "HEAD 2222222222222222222222222222222222222222",
        "branch refs/heads/task/foo",
        "",
        "worktree /repo/detached",
        "HEAD 3333333333333333333333333333333333333333",
        "detached",
        "",
        "worktree /repo/bare",
        "bare"
    ].join("\n")

    const repo = git("/repo")
    const worktrees = Worktree.parse(repo, porcelain)

    it("parses every block into a Worktree", () => {
        expect(worktrees).toHaveLength(4)
        expect(worktrees.every((wt) => wt instanceof Worktree)).toBe(true)
        expect(worktrees.every((wt) => wt.repo === repo)).toBe(true)
    })

    it("strips the refs/heads/ prefix from branch short-names", () => {
        expect(worktrees[0].branch).toBe("main")
        expect(worktrees[1].branch).toBe("task/foo")
    })

    it("records paths and heads", () => {
        expect(worktrees.map((wt) => wt.path)).toEqual([
            "/repo/source/api",
            "/repo/tasks/foo/api",
            "/repo/detached",
            "/repo/bare"
        ])
        expect(worktrees[0].head).toBe(
            "1111111111111111111111111111111111111111"
        )
        expect(worktrees[1].head).toBe(
            "2222222222222222222222222222222222222222"
        )
    })

    it("flags the detached worktree without a branch", () => {
        const detached = worktrees[2]
        expect(detached.detached).toBe(true)
        expect(detached.branch).toBeUndefined()
        expect(detached.bare).toBe(false)
    })

    it("flags the bare worktree", () => {
        const bare = worktrees[3]
        expect(bare.bare).toBe(true)
        expect(bare.branch).toBeUndefined()
        expect(bare.detached).toBe(false)
    })
})

describe("module exports", () => {
    it("exposes the public surface", () => {
        expect(typeof git).toBe("function")
        expect(typeof Repository).toBe("function")
        expect(typeof Worktree).toBe("function")
        expect(GitError.prototype).toBeInstanceOf(Error)
    })
})

describe("git integration", () => {
    let tmp: string
    let originPath: string

    // Build a fresh origin repo with one commit on `main` for each test.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "git-spec-"))
        originPath = path.join(tmp, "origin")
        await fsp.mkdir(originPath)
        await sh(originPath, "init")
        await sh(originPath, "config", "user.email", "test@example.com")
        await sh(originPath, "config", "user.name", "Test User")
        await fsp.writeFile(path.join(originPath, "README.md"), "hello\n")
        await sh(originPath, "add", "README.md")
        await sh(originPath, "commit", "-m", "initial commit")
        // Normalise the branch name regardless of the machine's git default.
        await sh(originPath, "branch", "-M", "main")
    })

    afterEach(async () => {
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    // Clone origin into <tmp>/clone and configure committer identity so that
    // operations producing commits (rebase) work on a clean machine.
    const cloneOrigin = async (): Promise<Repository> => {
        const dest = path.join(tmp, "clone")
        const repo = await git.clone(originPath, dest)
        await sh(dest, "config", "user.email", "clone@example.com")
        await sh(dest, "config", "user.name", "Clone User")
        return repo
    }

    describe("git()", () => {
        it("returns a Repository carrying the given path", () => {
            const repo = git(originPath)
            expect(repo).toBeInstanceOf(Repository)
            expect(repo.path).toBe(originPath)
        })
    })

    describe("git.clone", () => {
        it("clones a repo and returns a Repository with the committed file", async () => {
            const dest = path.join(tmp, "clone")
            const repo = await git.clone(originPath, dest)
            expect(repo).toBeInstanceOf(Repository)
            expect(repo.path).toBe(dest)
            expect(fs.existsSync(dest)).toBe(true)
            expect(fs.existsSync(path.join(dest, "README.md"))).toBe(true)
            expect(await sh(dest, "rev-parse", "HEAD")).toBe(
                await sh(originPath, "rev-parse", "HEAD")
            )
        })

        it("rejects with a GitError carrying a non-zero exit code on a bad url", async () => {
            const bad = path.join(tmp, "does-not-exist")
            const dest = path.join(tmp, "clone-fail")
            const error = await git.clone(bad, dest).catch((e) => e)
            expect(error).toBeInstanceOf(GitError)
            expect((error as GitError).exitCode).not.toBe(0)
        })
    })

    describe("raw", () => {
        it("returns a trimmed 40-char hex sha for rev-parse HEAD", async () => {
            const repo = await cloneOrigin()
            const sha = await repo.raw("rev-parse", "HEAD")
            expect(sha).toMatch(/^[0-9a-f]{40}$/)
            expect(sha).not.toMatch(/\s$/)
            expect(sha).toBe(sha.trim())
        })

        it("throws a GitError with exit code 128 on a failing rev-parse", async () => {
            const repo = await cloneOrigin()
            const error = await repo
                .raw("rev-parse", "--verify", "does-not-exist")
                .catch((e) => e)
            expect(error).toBeInstanceOf(GitError)
            expect((error as GitError).exitCode).toBe(128)
        })
    })

    describe("fetch", () => {
        it("advances the remote-tracking ref to origin's new HEAD", async () => {
            const repo = await cloneOrigin()
            // Add a new commit to origin after the clone.
            await fsp.writeFile(path.join(originPath, "second.txt"), "second\n")
            await sh(originPath, "add", "second.txt")
            await sh(originPath, "commit", "-m", "second commit")
            const originHead = await sh(originPath, "rev-parse", "HEAD")

            await repo.fetch()

            const tracked = await sh(repo.path, "rev-parse", "origin/main")
            expect(tracked).toBe(originHead)
        })
    })

    describe("worktree(path)", () => {
        it("returns a Worktree bound to the repo, not yet on disk", async () => {
            const repo = await cloneOrigin()
            const wtPath = path.join(tmp, "wt-pending")
            const wt = repo.worktree(wtPath)
            expect(wt).toBeInstanceOf(Worktree)
            expect(wt.repo).toBe(repo)
            expect(wt.path).toBe(wtPath)
            expect(fs.existsSync(wtPath)).toBe(false)
        })
    })

    describe("worktree.create", () => {
        it("creates the worktree + branch and returns the same instance", async () => {
            const repo = await cloneOrigin()
            const wtPath = path.join(tmp, "wt-x")
            const handle = repo.worktree(wtPath)
            const created = await handle.create({
                branch: "task/x",
                from: "HEAD"
            })
            expect(created).toBe(handle)
            expect(fs.existsSync(wtPath)).toBe(true)
            const branches = await sh(repo.path, "branch", "--list", "task/x")
            expect(branches).toContain("task/x")
        })
    })

    describe("worktrees()", () => {
        it("lists every worktree, including the freshly created one", async () => {
            const repo = await cloneOrigin()
            const wtPath = path.join(tmp, "wt-list")
            await repo.worktree(wtPath).create({
                branch: "task/x",
                from: "HEAD"
            })

            const worktrees = await repo.worktrees()
            expect(worktrees.length).toBeGreaterThanOrEqual(2)
            expect(worktrees.every((wt) => wt instanceof Worktree)).toBe(true)

            // macOS canonicalises /var -> /private/var, so compare realpaths.
            const real = fs.realpathSync(wtPath)
            const found = worktrees.find(
                (wt) => fs.realpathSync(wt.path) === real
            )
            expect(found).toBeDefined()
            expect(found?.branch).toBe("task/x")
            expect(found?.detached).toBe(false)
        })
    })

    describe("worktree.remove", () => {
        it("removes a clean worktree from a fresh listing", async () => {
            const repo = await cloneOrigin()
            const wtPath = path.join(tmp, "wt-remove")
            const wt = await repo.worktree(wtPath).create({
                branch: "task/rm",
                from: "HEAD"
            })

            await wt.remove()

            const real = fs.realpathSync(tmp)
            const after = await repo.worktrees()
            const stillThere = after.find(
                (w) =>
                    fs.realpathSync(path.dirname(w.path)) === real &&
                    path.basename(w.path) === "wt-remove"
            )
            expect(stillThere).toBeUndefined()
        })

        it("refuses to remove a dirty worktree unless forced", async () => {
            const repo = await cloneOrigin()
            const wtPath = path.join(tmp, "wt-dirty")
            const wt = await repo.worktree(wtPath).create({
                branch: "task/dirty",
                from: "HEAD"
            })
            // Modify a tracked file so the worktree is dirty.
            await fsp.writeFile(
                path.join(wtPath, "README.md"),
                "dirty change\n"
            )

            const error = await wt.remove().catch((e) => e)
            expect(error).toBeInstanceOf(GitError)
            expect(fs.existsSync(wtPath)).toBe(true)

            await expect(wt.remove({ force: true })).resolves.toBeUndefined()
            expect(fs.existsSync(wtPath)).toBe(false)
        })
    })

    describe("worktree.rebase", () => {
        it("rebases in the worktree dir, picking up the new main commit", async () => {
            const repo = await cloneOrigin()
            const wtPath = path.join(tmp, "wt-rebase")
            await repo.worktree(wtPath).create({
                branch: "task/x",
                from: "main"
            })

            // Add a new commit on the clone's main branch.
            await fsp.writeFile(
                path.join(repo.path, "feature.txt"),
                "feature\n"
            )
            await sh(repo.path, "add", "feature.txt")
            await sh(repo.path, "commit", "-m", "main moves forward")
            const newMainHead = await sh(repo.path, "rev-parse", "main")

            await repo.worktree(wtPath).rebase("main")

            // The worktree's branch must now contain the new main commit,
            // proving the rebase ran in the worktree dir, not the repo dir.
            const log = await sh(wtPath, "log", "--oneline")
            expect(log).toContain("main moves forward")
            const containing = await sh(
                wtPath,
                "branch",
                "--contains",
                newMainHead
            )
            expect(containing).toContain("task/x")
        })
    })

    describe("GitError shape", () => {
        it("carries args, exitCode, stderr and a descriptive message", async () => {
            const repo = await cloneOrigin()
            const error = (await repo
                .raw("rev-parse", "--verify", "nope")
                .catch((e) => e)) as GitError
            expect(error).toBeInstanceOf(GitError)
            expect(typeof error.exitCode).toBe("number")
            expect(typeof error.stderr).toBe("string")
            expect(Array.isArray(error.args)).toBe(true)
            expect(error.message).toContain("git")
            expect(error.message).toContain("rev-parse")
        })
    })
})
