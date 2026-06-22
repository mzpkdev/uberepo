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

// True when dotted version `version` is at least `minimum`, comparing segment
// by numeric segment (so "2.40" >= "2.9" and "10.0" >= "9.9"). A missing
// segment reads as 0 ("2.38" == "2.38.0"); a non-numeric segment reads as 0
// too, so a garbled version string fails an honest minimum rather than passing.
export const versionAtLeast = (version: string, minimum: string): boolean => {
    const parse = (v: string): number[] =>
        v.split(".").map((segment) => {
            const n = Number.parseInt(segment, 10)
            return Number.isNaN(n) ? 0 : n
        })
    const a = parse(version)
    const b = parse(minimum)
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const left = a[i] ?? 0
        const right = b[i] ?? 0
        if (left !== right) {
            return left > right
        }
    }
    return true
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

    // True when this is a push that the remote rejected because the local branch
    // is not a fast-forward of the remote tip (someone else pushed, or a local
    // rebase diverged the branch). git prints "! [rejected]" with either
    // "(non-fast-forward)" or "(fetch first)" to stderr in that case. ship reads
    // this to turn a plain-push rejection into the "did you sync? --force" hint
    // rather than a raw GitError.
    isNonFastForward(): boolean {
        return (
            /\[rejected\]/.test(this.stderr) &&
            /(non-fast-forward|fetch first|stale info)/.test(this.stderr)
        )
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

    // The merge-base (most recent common ancestor) OID of two commits. Distinct
    // from isMerged: that asks the yes/no "is a an ancestor of b" via exit code,
    // this RETURNS the boundary commit. sync's restack snapshots merge-base(child,
    // parent) BEFORE the parent moves to use as the `git rebase --onto` upstream —
    // the cut point below which commits belong to the parent, above which to the
    // child. Trimmed OID.
    async mergeBase(a: string, b: string): Promise<string> {
        return this.raw("merge-base", a, b)
    }

    // Resolve any ref/revision to its OID (trimmed). sync reads a stacked
    // parent's NEW tip with this after the parent rebased, to restack the child
    // onto it. A bad ref throws a GitError (rev-parse exit 128), unlike the
    // tolerant remoteDefault/branchExists which swallow the miss.
    async revParse(ref: string): Promise<string> {
        return this.raw("rev-parse", ref)
    }

    // Point a ref at `sha` (create or move it), via `git update-ref`. sync uses
    // this to persist a stacked child's pre-move fork point under
    // refs/uberepo/restack/<task>/<leaf> — a local-only ref (outside
    // heads/remotes/tags, so never pushed) that both NAMES the cut point for the
    // `--onto` restack AND keeps the parent's OLD tip reachable across a
    // conflict-resume re-run (an unreferenced old tip could be pruned).
    async setRef(name: string, sha: string): Promise<void> {
        await run(["update-ref", name, sha], this.path)
    }

    // Delete a ref via `git update-ref -d`. sync deletes a child's persisted
    // fork-point ref the moment it successfully restacks (or is found already
    // restacked), so a clean run leaves no refs/uberepo/restack/* behind. `-d`
    // on a missing ref is a no-op-ish error; callers only delete refs they know
    // exist (snapshotted this run), so a miss is not expected here.
    async delRef(name: string): Promise<void> {
        await run(["update-ref", "-d", name], this.path)
    }

    // True when ref `name` currently exists (resolves to a commit). Mirrors
    // branchExists but for an arbitrary fully-qualified ref, so sync can ask
    // "does this child already have a persisted fork point?" (write-once: a
    // leftover from an interrupted run is KEPT, not overwritten). A missing ref
    // is a silent false.
    async refExists(name: string): Promise<boolean> {
        try {
            await this.raw("rev-parse", "--verify", "--quiet", name)
            return true
        } catch {
            return false
        }
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

    // True when the local branch exists. `--verify --quiet` makes a missing
    // ref a silent exit 1 (a GitError here), and the full refs/heads/ form
    // keeps a same-named file or tag from satisfying the check.
    async branchExists(branch: string): Promise<boolean> {
        try {
            await this.raw(
                "rev-parse",
                "--verify",
                "--quiet",
                `refs/heads/${branch}`
            )
            return true
        } catch {
            return false
        }
    }

    // True when a remote-tracking branch `<remote>/<branch>` exists (default
    // remote origin). Mirrors branchExists but against refs/remotes/, so open's
    // adopt path can tell "branch exists only on origin" (attach + track) from
    // "no such branch anywhere" (create fresh). A missing ref is a silent
    // false, exactly like branchExists.
    async remoteBranchExists(
        branch: string,
        remote = "origin"
    ): Promise<boolean> {
        try {
            await this.raw(
                "rev-parse",
                "--verify",
                "--quiet",
                `refs/remotes/${remote}/${branch}`
            )
            return true
        } catch {
            return false
        }
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

    // Forecast a 3-way merge of the `target` and `branch` TIPS without touching
    // any worktree or index (`git merge-tree --write-tree`, git >= 2.38 — gate
    // on git.version() before calling). Exit 0 = mergeable. Exit 1 with the
    // toplevel tree oid leading stdout = conflicts, whose paths are parsed
    // from the lines that follow (with --name-only: one conflicted path per
    // line until the blank line that opens the informational section). Exit 1
    // lands in the catch — exec treats any non-zero exit as a rejection — and
    // carries the payload on err.stdout, which is why this can't ride raw()
    // (GitError keeps stderr only). Everything else is a real GitError —
    // including an exit 1 WITHOUT a tree oid, which is how git reports an
    // unmergeable ref ("not something we can merge"), not a conflict. NOTE:
    // this merges tips in ONE step; a rebase replays commits one-by-one, so
    // the forecast can differ from reality on multi-commit branches.
    async mergeTree(
        target: string,
        branch: string
    ): Promise<{ conflicts: string[] }> {
        const args = ["merge-tree", "--write-tree", "--name-only"]
        try {
            await exec("git", [...args, target, branch], { cwd: this.path })
            return { conflicts: [] }
        } catch (error) {
            const err = error as {
                code?: number
                stdout?: string
                stderr?: string
            }
            const [oid, ...rest] = (err.stdout ?? "").split("\n")
            if (err.code === 1 && /^[0-9a-f]{40,64}$/.test(oid ?? "")) {
                const conflicts = new Set<string>()
                for (const line of rest) {
                    // The blank section break ends the conflicted-file list.
                    if (line === "") {
                        break
                    }
                    conflicts.add(line)
                }
                return { conflicts: [...conflicts] }
            }
            throw new GitError(
                [...args, target, branch],
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

    // Add this worktree, in one of two modes:
    //   - CREATE (default, or attach:false): cut a NEW branch `opts.branch` off
    //     `opts.from` — the original `worktree add -b <branch> <path> <from>`.
    //     `from` is required here (the base the fresh branch starts at).
    //   - ATTACH (attach:true): check out a branch that ALREADY exists rather
    //     than creating one — `worktree add <path> <branch>`. When the branch
    //     lives only on the remote (`track:true`), the `--track -b` form creates
    //     the local branch FROM `origin/<branch>` and sets it as upstream, so a
    //     plain `git push`/`sync` knows where the branch belongs. `from` is
    //     ignored in attach mode (the branch's own tip is the checkout point).
    // open decides which mode per repo (adopt vs create); this only executes it.
    async create(opts: {
        branch: string
        from?: string
        attach?: boolean
        track?: boolean
    }): Promise<this> {
        let args: string[]
        if (opts.attach) {
            args = opts.track
                ? [
                      "worktree",
                      "add",
                      "--track",
                      "-b",
                      opts.branch,
                      this.path,
                      `origin/${opts.branch}`
                  ]
                : ["worktree", "add", this.path, opts.branch]
        } else {
            args = [
                "worktree",
                "add",
                "-b",
                opts.branch,
                this.path,
                opts.from ?? "HEAD"
            ]
        }
        await run(args, this.repo.path)
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

    // Transplant a stacked child onto its parent's NEW tip via
    // `git rebase --onto <newbase> <upstream> [<branch>]`. `upstream` is the
    // child's PERSISTED fork point — merge-base(child, parent) captured before
    // the parent moved — so git replays ONLY the commits the child added beyond
    // that boundary (its own work), never the parent's commits, onto `newbase`
    // (the parent's new tip). A freshly-computed merge-base would be wrong after
    // a resume (see sync's restack), which is why the caller passes the saved
    // ref. Conflicts leave the worktree mid-rebase and throw a GitError, byte
    // for byte like rebase() above, so sync's one catch path handles both.
    async rebaseOnto(
        newbase: string,
        upstream: string,
        branch?: string
    ): Promise<void> {
        const args = ["rebase", "--onto", newbase, upstream]
        if (branch !== undefined) {
            args.push(branch)
        }
        await run(args, this.path)
    }

    // Push the worktree's current branch to `remote`, setting upstream (`-u`) so
    // the local branch tracks it. The plain form refuses a non-fast-forward (the
    // remote moved or a rebase diverged the branch); `force` upgrades to
    // `--force-with-lease`, which overwrites only when the remote tip is still
    // what we last saw — safe after a `sync`, but never the blind `--force`. The
    // ref is pushed explicitly (refs/heads/<branch>) so the push is unambiguous
    // regardless of any push.default config. A rejection surfaces as a GitError
    // whose isNonFastForward() lets the caller offer the --force hint.
    async push(
        branch: string,
        opts?: { remote?: string; force?: boolean }
    ): Promise<void> {
        const remote = opts?.remote ?? "origin"
        const args = ["push"]
        if (opts?.force) {
            args.push("--force-with-lease")
        }
        args.push("-u", remote, `refs/heads/${branch}:refs/heads/${branch}`)
        await run(args, this.path)
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
// The installed git's version as a dotted string (e.g. "2.49.0"), parsed out
// of `git version` ("git version 2.39.5 (Apple Git-154)" → "2.39.5"). Falls
// back to the raw trimmed output when nothing parses, so a caller's gate fails
// loudly with what git actually said. A property on the default export (like
// git.clone) so specs can pin the version a feature gate sees via vi.spyOn.
git.version = async (): Promise<string> => {
    const out = await run(["version"], process.cwd())
    return /(\d+(?:\.\d+)*)/.exec(out)?.[1] ?? out.trim()
}
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
