import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import git, { GitError, Repository, versionAtLeast, Worktree } from "@/git"

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

describe("versionAtLeast", () => {
    it("compares segment by numeric segment, not lexicographically", () => {
        expect(versionAtLeast("2.38.0", "2.38")).toBe(true)
        expect(versionAtLeast("2.38", "2.38.0")).toBe(true)
        expect(versionAtLeast("2.37.9", "2.38")).toBe(false)
        expect(versionAtLeast("2.40", "2.9")).toBe(true)
        expect(versionAtLeast("10.0", "9.9")).toBe(true)
        expect(versionAtLeast("2.39.5", "2.38")).toBe(true)
        expect(versionAtLeast("3.0", "2.38")).toBe(true)
        expect(versionAtLeast("1.9.9", "2.38")).toBe(false)
    })

    it("reads a garbled version as 0, failing an honest minimum", () => {
        expect(versionAtLeast("garbage", "2.38")).toBe(false)
        expect(versionAtLeast("", "2.38")).toBe(false)
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

    describe("git.version", () => {
        it("resolves the installed git's dotted version string", async () => {
            const version = await git.version()
            // Whatever git is installed, the parse must yield bare dotted
            // numerics (no "git version " prefix, no platform suffix).
            expect(version).toMatch(/^\d+(\.\d+)+$/)
        })
    })

    describe("branchExists", () => {
        it("answers for refs/heads only — a tag never satisfies it", async () => {
            const repo = await cloneOrigin()
            await sh(repo.path, "branch", "topic")
            await sh(repo.path, "tag", "tagged")
            expect(await repo.branchExists("main")).toBe(true)
            expect(await repo.branchExists("topic")).toBe(true)
            expect(await repo.branchExists("missing")).toBe(false)
            expect(await repo.branchExists("tagged")).toBe(false)
        })
    })

    describe("mergeTree", () => {
        // A topic branch whose README edit collides with main's, plus a clean
        // sibling that only adds its own file — both built in the clone.
        const diverge = async (repo: Repository): Promise<void> => {
            await sh(repo.path, "switch", "-c", "conflicting", "main")
            await fsp.writeFile(
                path.join(repo.path, "README.md"),
                "from topic\n"
            )
            await sh(repo.path, "commit", "-am", "topic edits readme")
            await sh(repo.path, "switch", "-c", "clean", "main")
            await fsp.writeFile(path.join(repo.path, "own.txt"), "own\n")
            await sh(repo.path, "add", "own.txt")
            await sh(repo.path, "commit", "-m", "clean adds own file")
            await sh(repo.path, "switch", "main")
            await fsp.writeFile(
                path.join(repo.path, "README.md"),
                "from main\n"
            )
            await sh(repo.path, "commit", "-am", "main edits readme")
        }

        it("reports no conflicts for a mergeable pair of tips", async () => {
            const repo = await cloneOrigin()
            await diverge(repo)
            expect(await repo.mergeTree("main", "clean")).toEqual({
                conflicts: []
            })
        })

        it("reports the conflicted paths for colliding tips, touching no worktree", async () => {
            const repo = await cloneOrigin()
            await diverge(repo)
            const before = await sh(repo.path, "status", "--porcelain")
            expect(await repo.mergeTree("main", "conflicting")).toEqual({
                conflicts: ["README.md"]
            })
            // Pure forecast: no checkout, no index change, no MERGE_* state.
            expect(await sh(repo.path, "status", "--porcelain")).toBe(before)
        })

        it("throws a GitError for an unknown ref instead of misreading it as conflicts", async () => {
            const repo = await cloneOrigin()
            // git reports "not something we can merge" with exit 1 and NO tree
            // oid on stdout — the oid, not the exit code, separates a conflict
            // payload from a real error.
            const error = await repo
                .mergeTree("does-not-exist", "main")
                .catch((e) => e)
            expect(error).toBeInstanceOf(GitError)
            expect((error as GitError).exitCode).not.toBe(0)
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

    describe("worktree.create — attach mode (adoption)", () => {
        it("attaches to an EXISTING local branch without creating one (no -b)", async () => {
            const repo = await cloneOrigin()
            // A pre-existing local branch with its own commit — the adopt case.
            await sh(repo.path, "branch", "feature/login", "main")
            const wtPath = path.join(tmp, "wt-adopt-local")

            const handle = await repo
                .worktree(wtPath)
                .create({ branch: "feature/login", attach: true })

            expect(handle.path).toBe(wtPath)
            expect(fs.existsSync(wtPath)).toBe(true)
            // The worktree is checked out ON that branch, and no NEW branch was
            // cut — the branch count is unchanged from the one we made.
            const head = await sh(wtPath, "rev-parse", "--abbrev-ref", "HEAD")
            expect(head).toBe("feature/login")
            expect(await repo.branchExists("feature/login")).toBe(true)
        })

        it("creates a tracking local branch from origin/<name> when origin-only", async () => {
            // Push a branch to origin, then DELETE the local ref so it lives
            // only on the remote — exactly open's origin-only adopt path.
            const repo = await cloneOrigin()
            await sh(repo.path, "switch", "-c", "feature/remote", "main")
            await sh(repo.path, "push", "-u", "origin", "feature/remote")
            await sh(repo.path, "switch", "main")
            await sh(repo.path, "branch", "-D", "feature/remote")
            expect(await repo.branchExists("feature/remote")).toBe(false)
            expect(await repo.remoteBranchExists("feature/remote")).toBe(true)

            const wtPath = path.join(tmp, "wt-adopt-remote")
            await repo
                .worktree(wtPath)
                .create({ branch: "feature/remote", attach: true, track: true })

            // The local branch now exists, is checked out, and tracks origin.
            expect(fs.existsSync(wtPath)).toBe(true)
            expect(await sh(wtPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
                "feature/remote"
            )
            const upstream = await sh(
                wtPath,
                "rev-parse",
                "--abbrev-ref",
                "feature/remote@{upstream}"
            )
            expect(upstream).toBe("origin/feature/remote")
        })

        it("create (no attach) still cuts a fresh branch with -b, as before", async () => {
            const repo = await cloneOrigin()
            const wtPath = path.join(tmp, "wt-create-default")
            await repo
                .worktree(wtPath)
                .create({ branch: "task/new", from: "HEAD" })
            expect(await repo.branchExists("task/new")).toBe(true)
        })
    })

    describe("remoteBranchExists", () => {
        it("is true only for a branch present on the remote", async () => {
            const repo = await cloneOrigin()
            await sh(repo.path, "switch", "-c", "shipped", "main")
            await sh(repo.path, "push", "-u", "origin", "shipped")
            await sh(repo.path, "switch", "main")
            expect(await repo.remoteBranchExists("shipped")).toBe(true)
            expect(await repo.remoteBranchExists("never-pushed")).toBe(false)
        })
    })

    describe("committedAt", () => {
        it("returns HEAD's strict ISO 8601 committer date, agreeing with git", async () => {
            const repo = await cloneOrigin()
            const wtPath = path.join(tmp, "wt-date")
            const wt = await repo
                .worktree(wtPath)
                .create({ branch: "task/d", from: "HEAD" })

            const at = await wt.committedAt()
            expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
            // The wrapper agrees with git's own %cI for the worktree's HEAD.
            expect(at).toBe(
                await sh(wtPath, "log", "-1", "--format=%cI", "HEAD")
            )
        })
    })

    describe("aheadBehind", () => {
        it("counts commits ahead of and behind origin/<branch>", async () => {
            const repo = await cloneOrigin()
            // A branch pushed to origin, then attached in a worktree.
            await sh(repo.path, "switch", "-c", "feature", "main")
            await sh(repo.path, "push", "-u", "origin", "feature")
            await sh(repo.path, "switch", "main")
            const wtPath = path.join(tmp, "wt-ab")
            const wt = await repo
                .worktree(wtPath)
                .create({ branch: "feature", attach: true })

            // In sync with origin right after the push.
            expect(await wt.aheadBehind("feature")).toEqual({
                ahead: 0,
                behind: 0
            })

            // One local commit → ahead by one, behind none.
            await fsp.writeFile(path.join(wtPath, "a.txt"), "a\n")
            await sh(wtPath, "add", "a.txt")
            await sh(wtPath, "commit", "-m", "local ahead")
            expect(await wt.aheadBehind("feature")).toEqual({
                ahead: 1,
                behind: 0
            })

            // Advance origin/feature and fetch → now also behind by one.
            await sh(originPath, "switch", "feature")
            await fsp.writeFile(path.join(originPath, "b.txt"), "b\n")
            await sh(originPath, "add", "b.txt")
            await sh(originPath, "commit", "-m", "remote ahead")
            await sh(originPath, "switch", "main")
            await repo.fetch()
            expect(await wt.aheadBehind("feature")).toEqual({
                ahead: 1,
                behind: 1
            })
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

    describe("mergeBase", () => {
        it("returns the common ancestor OID of two divergent branches", async () => {
            const repo = await cloneOrigin()
            const base = await sh(repo.path, "rev-parse", "main")
            // Two branches off the same main commit, each with its own commit.
            await sh(repo.path, "switch", "-c", "a", "main")
            await fsp.writeFile(path.join(repo.path, "a.txt"), "a\n")
            await sh(repo.path, "add", "a.txt")
            await sh(repo.path, "commit", "-m", "a work")
            await sh(repo.path, "switch", "-c", "b", "main")
            await fsp.writeFile(path.join(repo.path, "b.txt"), "b\n")
            await sh(repo.path, "add", "b.txt")
            await sh(repo.path, "commit", "-m", "b work")

            const mb = await repo.mergeBase("a", "b")
            expect(mb).toMatch(/^[0-9a-f]{40}$/)
            // The common ancestor is the shared main commit they branched from.
            expect(mb).toBe(base)
        })

        it("throws a GitError on an unknown ref (distinct from a no-op answer)", async () => {
            const repo = await cloneOrigin()
            const error = await repo.mergeBase("main", "nope").catch((e) => e)
            expect(error).toBeInstanceOf(GitError)
            expect((error as GitError).exitCode).not.toBe(0)
        })
    })

    describe("revParse", () => {
        it("resolves a ref to a trimmed OID", async () => {
            const repo = await cloneOrigin()
            const sha = await repo.revParse("main")
            expect(sha).toMatch(/^[0-9a-f]{40}$/)
            expect(sha).toBe(sha.trim())
            // It agrees with git's own rev-parse.
            expect(sha).toBe(await sh(repo.path, "rev-parse", "main"))
        })

        it("throws a GitError on a bad ref", async () => {
            const repo = await cloneOrigin()
            const error = await repo.revParse("does-not-exist").catch((e) => e)
            expect(error).toBeInstanceOf(GitError)
        })
    })

    describe("setRef / refExists / delRef", () => {
        it("creates, reports, and deletes an arbitrary local ref", async () => {
            const repo = await cloneOrigin()
            const sha = await repo.revParse("main")
            const name = "refs/uberepo/restack/demo/api"

            expect(await repo.refExists(name)).toBe(false)
            await repo.setRef(name, sha)
            expect(await repo.refExists(name)).toBe(true)
            // It points exactly where we set it.
            expect(await repo.revParse(name)).toBe(sha)
            // Such a ref lives OUTSIDE heads/remotes/tags, so it is never a
            // branch and a plain push would not send it.
            expect(await repo.branchExists("api")).toBe(false)

            await repo.delRef(name)
            expect(await repo.refExists(name)).toBe(false)
        })

        it("setRef moves an existing ref to a new sha", async () => {
            const repo = await cloneOrigin()
            const first = await repo.revParse("main")
            const name = "refs/uberepo/restack/demo/web"
            await repo.setRef(name, first)
            // Advance main, then re-point the ref.
            await fsp.writeFile(path.join(repo.path, "x.txt"), "x\n")
            await sh(repo.path, "add", "x.txt")
            await sh(repo.path, "commit", "-m", "advance")
            const second = await repo.revParse("main")
            expect(second).not.toBe(first)
            await repo.setRef(name, second)
            expect(await repo.revParse(name)).toBe(second)
        })
    })

    describe("worktree.rebaseOnto", () => {
        // Build a `main ← parent ← child` stack in the clone, advance main, and
        // rebase parent onto main; then rebaseOnto replays ONLY the child's own
        // commit onto the parent's new tip, never duplicating the parent's.
        it("replays only the child's own commits onto the new base (no parent-commit duplication)", async () => {
            const repo = await cloneOrigin()
            // parent off main, with its own commit.
            await sh(repo.path, "switch", "-c", "parent", "main")
            await fsp.writeFile(path.join(repo.path, "parent.txt"), "p\n")
            await sh(repo.path, "add", "parent.txt")
            await sh(repo.path, "commit", "-m", "parent work")
            // child off parent, with its own commit.
            await sh(repo.path, "switch", "-c", "child", "parent")
            await fsp.writeFile(path.join(repo.path, "child.txt"), "c\n")
            await sh(repo.path, "add", "child.txt")
            await sh(repo.path, "commit", "-m", "child work")
            // Free both branches from the clone's main tree so they can be
            // checked out in worktrees below.
            await sh(repo.path, "switch", "main")
            // Snapshot the fork point BEFORE the parent moves.
            const fork = await repo.mergeBase("child", "parent")

            // Add the child to a worktree so rebaseOnto runs there (mirrors how
            // sync drives a per-participant worktree).
            const wtPath = path.join(tmp, "wt-child")
            await sh(repo.path, "worktree", "add", wtPath, "child")

            // main advances; parent rebases onto it (now parent has a NEW tip).
            await fsp.writeFile(path.join(repo.path, "main.txt"), "m\n")
            await sh(repo.path, "add", "main.txt")
            await sh(repo.path, "commit", "-m", "main moves")
            const parentWtPath = path.join(tmp, "wt-parent")
            await sh(repo.path, "worktree", "add", parentWtPath, "parent")
            await repo.worktree(parentWtPath).rebase("main")
            const parentNewTip = await repo.revParse("parent")

            // Restack the child onto the parent's new tip via the saved fork.
            await repo.worktree(wtPath).rebaseOnto(parentNewTip, fork, "child")

            // The child now sits directly on the parent's new tip.
            expect(await repo.revParse("child^")).toBe(parentNewTip)
            // And carries ONLY its own commit: "parent work" appears once
            // (parent's), "child work" once, "main moves" reachable.
            const log = await sh(wtPath, "log", "--format=%s", "child")
            const subjects = log.split("\n").filter((l) => l !== "")
            expect(subjects[0]).toBe("child work")
            expect(subjects.filter((s) => s === "child work")).toHaveLength(1)
            expect(subjects.filter((s) => s === "parent work")).toHaveLength(1)
            expect(subjects).toContain("main moves")
        })

        it("throws a GitError on a conflict, leaving the worktree mid-rebase (like rebase())", async () => {
            const repo = await cloneOrigin()
            // parent edits README; child edits the SAME line differently, so a
            // restack onto a parent that moved README conflicts.
            await sh(repo.path, "switch", "-c", "parent", "main")
            await fsp.writeFile(path.join(repo.path, "README.md"), "parent\n")
            await sh(repo.path, "commit", "-am", "parent readme")
            await sh(repo.path, "switch", "-c", "child", "parent")
            await fsp.writeFile(path.join(repo.path, "README.md"), "child\n")
            await sh(repo.path, "commit", "-am", "child readme")
            // Free both branches from the clone's main tree for the worktrees.
            await sh(repo.path, "switch", "main")
            const fork = await repo.mergeBase("child", "parent")

            const wtPath = path.join(tmp, "wt-conflict")
            await sh(repo.path, "worktree", "add", wtPath, "child")
            // Move the parent so its README differs from the fork.
            const parentWtPath = path.join(tmp, "wt-parent-conflict")
            await sh(repo.path, "worktree", "add", parentWtPath, "parent")
            await fsp.writeFile(
                path.join(parentWtPath, "README.md"),
                "parent moved\n"
            )
            await sh(parentWtPath, "commit", "-am", "parent moves readme")
            const parentNewTip = await repo.revParse("parent")

            const error = await repo
                .worktree(wtPath)
                .rebaseOnto(parentNewTip, fork, "child")
                .catch((e) => e)
            expect(error).toBeInstanceOf(GitError)
            // Mid-rebase state left under the worktree's gitdir (rebase-merge
            // or rebase-apply), exactly like Worktree.rebase on a conflict.
            const gitFile = await fsp.readFile(
                path.join(wtPath, ".git"),
                "utf8"
            )
            const gitdir = path.resolve(
                wtPath,
                (
                    gitFile.match(/^gitdir:\s*(.+)$/m) as RegExpMatchArray
                )[1].trim()
            )
            expect(
                fs.existsSync(path.join(gitdir, "rebase-merge")) ||
                    fs.existsSync(path.join(gitdir, "rebase-apply"))
            ).toBe(true)
            await sh(wtPath, "rebase", "--abort")
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
