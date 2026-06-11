import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

const run = async (
    args: string[],
    cwd: string,
    env?: NodeJS.ProcessEnv
): Promise<string> => {
    try {
        const { stdout } = await exec("git", args, {
            cwd,
            env: env ? { ...process.env, ...env } : process.env
        })
        return stdout
    } catch (error) {
        const err = error as { code?: number; stderr?: string }
        const exitCode = typeof err.code === "number" ? err.code : 1
        throw new GitError(args, exitCode, err.stderr ?? "")
    }
}

export class GitError extends Error {
    constructor(
        readonly args: string[],
        readonly exitCode: number,
        readonly stderr: string
    ) {
        super(
            `git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`
        )
        this.name = "GitError"
    }
}

export class Repository {
    constructor(readonly path: string) {}

    async fetch(remote = "origin"): Promise<void> {
        await run(["fetch", remote], this.path)
    }

    async rebase(onto: string): Promise<void> {
        await run(["rebase", onto], this.path)
    }

    // Fast-forward the current branch to its configured upstream. `--ff-only`
    // makes git refuse anything but a fast-forward — no upstream, or a diverged
    // branch that would need a merge commit, fails with a GitError instead of
    // merging. source/<name> is a read-only base (work happens in task
    // worktrees), so it should only ever advance, never gain a merge commit.
    async pull(): Promise<void> {
        await run(["pull", "--ff-only"], this.path)
    }

    async raw(...args: string[]): Promise<string> {
        return (await run(args, this.path)).trim()
    }

    // True when the repository has uncommitted changes (staged, unstaged, or
    // untracked). `git status --porcelain` prints one line per change and
    // nothing when the tree is clean, so non-empty output means dirty. Mirrors
    // Worktree.dirty() for the repo's own working tree.
    async dirty(): Promise<boolean> {
        const out = await run(["status", "--porcelain"], this.path)
        return out.trim().length > 0
    }

    // The remote default branch as a ref (e.g. "origin/main"), resolved from
    // origin/HEAD. Returns undefined when there is no remote, or origin/HEAD is
    // unset (no `git remote set-head`), so callers can fall back or error
    // rather than guess a target.
    async remoteDefault(): Promise<string | undefined> {
        try {
            return await this.raw("rev-parse", "--abbrev-ref", "origin/HEAD")
        } catch {
            return undefined
        }
    }

    // Delete a local branch. The plain `-d` form makes git itself refuse to
    // delete a branch that is not fully merged; `force` upgrades to `-D`, which
    // deletes regardless. A checked-out branch can never be deleted, so callers
    // must remove its worktree first.
    async deleteBranch(
        branch: string,
        opts?: { force?: boolean }
    ): Promise<void> {
        await run(["branch", opts?.force ? "-D" : "-d", branch], this.path)
    }

    // True when `branch` is an ancestor of `into` (i.e. fully merged into it).
    // `git merge-base --is-ancestor` signals the answer purely through its exit
    // code — 0 for yes, 1 for no — so 1 must be read as a clean `false` rather
    // than an error. Any other failure (bad ref, etc.) propagates as a GitError.
    async isMerged(branch: string, into: string): Promise<boolean> {
        try {
            await exec("git", ["merge-base", "--is-ancestor", branch, into], {
                cwd: this.path
            })
            return true
        } catch (error) {
            const err = error as { code?: number; stderr?: string }
            if (err.code === 1) {
                return false
            }
            throw new GitError(
                ["merge-base", "--is-ancestor", branch, into],
                typeof err.code === "number" ? err.code : 1,
                err.stderr ?? ""
            )
        }
    }

    worktree(path: string): Worktree {
        return new Worktree(this, path)
    }

    async worktrees(): Promise<Worktree[]> {
        return Worktree.parse(
            this,
            await run(["worktree", "list", "--porcelain"], this.path)
        )
    }
}

export class Worktree {
    head = ""
    branch?: string
    detached = false
    bare = false

    constructor(
        readonly repo: Repository,
        readonly path: string
    ) {}

    async create(opts: { branch: string; from: string }): Promise<this> {
        await run(
            ["worktree", "add", "-b", opts.branch, this.path, opts.from],
            this.repo.path
        )
        return this
    }

    async remove(opts?: { force?: boolean }): Promise<void> {
        const args = ["worktree", "remove", this.path]
        if (opts?.force) args.push("--force")
        await run(args, this.repo.path)
    }

    async rebase(onto: string): Promise<void> {
        await run(["rebase", onto], this.path)
    }

    // True when the worktree has uncommitted changes (staged, unstaged, or
    // untracked). `git status --porcelain` prints one line per change and
    // nothing when the tree is clean, so non-empty output means dirty.
    async dirty(): Promise<boolean> {
        const out = await run(["status", "--porcelain"], this.path)
        return out.trim().length > 0
    }

    static parse(repo: Repository, porcelain: string): Worktree[] {
        const worktrees: Worktree[] = []
        const blocks = porcelain.split(/\n\s*\n/)
        for (const block of blocks) {
            const lines = block
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
            if (lines.length === 0) continue
            let path = ""
            let head = ""
            let branch: string | undefined
            let detached = false
            let bare = false
            for (const line of lines) {
                if (line.startsWith("worktree ")) {
                    path = line.slice("worktree ".length)
                } else if (line.startsWith("HEAD ")) {
                    head = line.slice("HEAD ".length)
                } else if (line.startsWith("branch ")) {
                    const ref = line.slice("branch ".length)
                    branch = ref.startsWith("refs/heads/")
                        ? ref.slice("refs/heads/".length)
                        : ref
                } else if (line === "detached") {
                    detached = true
                } else if (line === "bare") {
                    bare = true
                }
            }
            if (!path) continue
            const wt = new Worktree(repo, path)
            wt.head = head
            wt.branch = branch
            wt.detached = detached
            wt.bare = bare
            worktrees.push(wt)
        }
        return worktrees
    }
}

const git = (path: string): Repository => new Repository(path)
git.clone = async (url: string, dest: string): Promise<Repository> => {
    // Fail fast on missing credentials instead of hanging on an interactive
    // password / host-key prompt.
    await run(["clone", url, dest], process.cwd(), {
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes"
    })
    return new Repository(dest)
}
export default git
