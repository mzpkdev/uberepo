import { execFile } from "node:child_process"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { terminal } from "cmdore"
import { vi } from "vitest"
import diff from "@/commands/diff"
import { CONFIG_FILENAME } from "@/config"

const exec = promisify(execFile)

// The one stable JSON object diff emits. repos entries are a union: an "ok"
// entry carries the numbers, a "skipped" entry only its reason.
type DiffJson = {
    task: string
    base: string
    repos: {
        name: string
        branch: string
        status: "ok" | "skipped"
        reason?: string
        ahead?: number
        dirty?: boolean
        files?: number
        insertions?: number
        deletions?: number
        commits?: { sha: string; subject: string }[]
    }[]
}

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
// restore them. diff uses log for the heading/per-repo lines and warn for the
// stray-worktree and not-found paths, so both are needed.
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

describe("diff command", () => {
    let tmp: string
    let root: string
    let cwd: string
    let configPath: string

    // Build a fresh uberepo workspace and chdir into it for each test. `root`
    // is the realpath of the workspace because macOS canonicalises /var ->
    // /private/var and git reports worktree paths under the realpath.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "diff-spec-"))
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
    // origin/HEAD set to main, so `rev-parse origin/HEAD` resolves to
    // origin/main — the same way sync resolves its default rebase target.
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

    // Drop the origin remote so neither origin/main nor origin/HEAD resolves.
    const dropOrigin = async (name: string): Promise<void> => {
        const dir = path.join(root, "source", name)
        await sh(dir, "remote", "remove", "origin")
    }

    // Register flat names in the config as github urls, without cloning.
    const register = async (names: string[]): Promise<void> => {
        await writeConfig(
            configPath,
            names.map((n) => `https://github.com/acme/${n}.git`)
        )
    }

    // Add a worktree for `task` to the source repo `name`, on branch
    // task/<task>, at <root>/tasks/<task>/<name>, branched off main.
    const openWorktree = async (
        name: string,
        task: string
    ): Promise<string> => {
        const source = path.join(root, "source", name)
        const wt = path.join(root, "tasks", task, name)
        await sh(source, "worktree", "add", "-b", `task/${task}`, wt, "main")
        return wt
    }

    // Write a ubertask.yml at the task level declaring a scope (the repos: the
    // task owns), so the scope filtering can be exercised.
    const writeScope = async (task: string, repos: string[]): Promise<void> => {
        const dir = path.join(root, "tasks", task)
        await fsp.mkdir(dir, { recursive: true })
        const list = repos.map((r) => `  - ${r}`).join("\n")
        await fsp.writeFile(
            path.join(dir, "ubertask.yml"),
            `goal: |\n  g\n\nrepos:\n${list}\n`
        )
    }

    // Commit `contents` to `file` inside a worktree with `message`.
    const commit = async (
        wt: string,
        file: string,
        contents: string,
        message: string
    ): Promise<void> => {
        await fsp.writeFile(path.join(wt, file), contents)
        await sh(wt, "add", file)
        await sh(wt, "commit", "-m", message)
    }

    // Advance the shared upstream's main by one commit that touches `file`,
    // routed through a throwaway clone so it never disturbs the source repo or
    // its worktrees.
    const advanceUpstream = async (
        name: string,
        file: string,
        contents: string
    ): Promise<void> => {
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
    }

    it("reports commits ahead of the merge-base with origin's default, plus the diffstat over that range", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")

        // Two task commits: +2 lines in a new file, then +1/-1 in README.md.
        await commit(wt, "work.txt", "one\ntwo\n", "api first")
        await commit(wt, "README.md", "changed\n", "api second")

        // origin/main moves past the branch point and the source FETCHES it,
        // so a naive tip-to-tip diff would drag the upstream commit in. The
        // numbers must stay merge-base → branch only.
        await advanceUpstream("api", "upstream.txt", "up\n")
        await sh(path.join(root, "source", "api"), "fetch", "origin")

        const parsed = await captureJson<DiffJson>(async () => {
            await diff.run({ task: "alpha" })
        })

        expect(parsed.task).toBe("alpha")
        expect(parsed.base).toBe("origin/main")
        expect(parsed.repos).toHaveLength(1)
        const repo = parsed.repos[0]
        expect(repo.name).toBe("api")
        expect(repo.branch).toBe("task/alpha")
        expect(repo.status).toBe("ok")
        expect(repo.ahead).toBe(2)
        expect(repo.dirty).toBe(false)
        expect(repo.files).toBe(2)
        expect(repo.insertions).toBe(3)
        expect(repo.deletions).toBe(1)
        // Newest first, the plain `git log` order; the upstream commit is not
        // among them.
        expect(repo.commits?.map((c) => c.subject)).toEqual([
            "api second",
            "api first"
        ])
    })

    it("emits the exact documented JSON shape", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        await commit(wt, "work.txt", "hello\n", "add work")
        const sha = await sh(
            path.join(root, "source", "api"),
            "rev-parse",
            "task/alpha"
        )

        const parsed = await captureJson<DiffJson>(async () => {
            await diff.run({ task: "alpha" })
        })

        expect(parsed).toEqual({
            task: "alpha",
            base: "origin/main",
            repos: [
                {
                    name: "api",
                    branch: "task/alpha",
                    ahead: 1,
                    dirty: false,
                    files: 1,
                    insertions: 1,
                    deletions: 0,
                    commits: [{ sha, subject: "add work" }],
                    status: "ok"
                }
            ]
        })
    })

    it("renders a compact human summary: heading vs base, aligned repo line, then commit subjects", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        await commit(wt, "work.txt", "hello\n", "add work")
        const sha = await sh(
            path.join(root, "source", "api"),
            "rev-parse",
            "task/alpha"
        )

        const { logs } = await captureOutput(async () => {
            await diff.run({ task: "alpha" })
        })

        expect(logs[0]).toBe("alpha  vs origin/main")
        expect(logs[1]).toContain("api")
        expect(logs[1]).toContain("task/alpha")
        expect(logs[1]).toContain("1 commit ahead")
        expect(logs[1]).toContain("1 file +1 -0")
        expect(logs[1]).toContain("clean")
        expect(logs[2]).toBe(`    ${sha.slice(0, 7)} add work`)
    })

    it("reports a branch with no commits ahead as 0 ahead with an empty diffstat", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")

        const parsed = await captureJson<DiffJson>(async () => {
            await diff.run({ task: "alpha" })
        })
        expect(parsed.repos).toEqual([
            {
                name: "api",
                branch: "task/alpha",
                ahead: 0,
                dirty: false,
                files: 0,
                insertions: 0,
                deletions: 0,
                commits: [],
                status: "ok"
            }
        ])

        // The human line drops the all-zero diffstat chunk at 0 ahead.
        const { logs } = await captureOutput(async () => {
            await diff.run({ task: "alpha" })
        })
        const line = logs.find((l) => l.includes("api"))
        expect(line).toContain("0 commits ahead")
        expect(line).not.toContain("file")
    })

    it("flags a dirty worktree without counting its uncommitted changes", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        await commit(wt, "work.txt", "hello\n", "add work")
        // Uncommitted edit on top: flips `dirty`, must NOT move the numbers.
        await fsp.writeFile(path.join(wt, "README.md"), "uncommitted\n")

        const parsed = await captureJson<DiffJson>(async () => {
            await diff.run({ task: "alpha" })
        })
        const repo = parsed.repos[0]
        expect(repo.dirty).toBe(true)
        expect(repo.ahead).toBe(1)
        expect(repo.files).toBe(1)
        expect(repo.insertions).toBe(1)
        expect(repo.deletions).toBe(0)

        const { logs } = await captureOutput(async () => {
            await diff.run({ task: "alpha" })
        })
        expect(logs.find((l) => l.includes("api"))).toContain("dirty")
    })

    it("respects a declared scope: reports in-scope repos and warns about a stray worktree", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")
        // Scope owns api only; web's worktree is drift.
        await writeScope("alpha", ["api"])

        let parsed: DiffJson | undefined
        const { warnings } = await captureOutput(async () => {
            parsed = await captureJson<DiffJson>(async () => {
                await diff.run({ task: "alpha" })
            })
        })

        expect(parsed?.repos.map((r) => r.name)).toEqual(["api"])
        expect(warnings.join("\n")).toContain(
            "web: worktree outside task scope"
        )
    })

    it("reports a scoped repo with no worktree as skipped, not an error", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        // web is in the scope but was never opened (or its worktree is gone).
        await writeScope("alpha", ["api", "web"])

        const parsed = await captureJson<DiffJson>(async () => {
            await diff.run({ task: "alpha" })
        })

        expect(parsed.repos.map((r) => [r.name, r.status])).toEqual([
            ["api", "ok"],
            ["web", "skipped"]
        ])
        expect(parsed.repos[1]).toEqual({
            name: "web",
            branch: "task/alpha",
            status: "skipped",
            reason: "no worktree"
        })

        const { logs } = await captureOutput(async () => {
            await diff.run({ task: "alpha" })
        })
        expect(logs.find((l) => l.includes("web"))).toContain(
            "skipped — no worktree"
        )
    })

    it("reports a vanished task branch as skipped", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        // Detach the worktree, then delete the branch out from under it — the
        // worktree dir survives but task/alpha is gone.
        await sh(wt, "checkout", "--detach")
        await sh(path.join(root, "source", "api"), "branch", "-D", "task/alpha")

        const parsed = await captureJson<DiffJson>(async () => {
            await diff.run({ task: "alpha" })
        })

        expect(parsed.repos).toEqual([
            {
                name: "api",
                branch: "task/alpha",
                status: "skipped",
                reason: "branch missing"
            }
        ])
    })

    it("reports a repo without a resolvable origin default as skipped", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")
        await dropOrigin("api")

        const parsed = await captureJson<DiffJson>(async () => {
            await diff.run({ task: "alpha" })
        })

        expect(parsed.base).toBe("")
        expect(parsed.repos).toEqual([
            {
                name: "api",
                branch: "task/alpha",
                status: "skipped",
                reason: "cannot resolve origin's default branch"
            }
        ])
    })

    it("warns and emits an empty repos list when the task is not open", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")

        let parsed: DiffJson | undefined
        const { warnings } = await captureOutput(async () => {
            parsed = await captureJson<DiffJson>(async () => {
                await diff.run({ task: "ghost" })
            })
        })

        expect(parsed).toEqual({ task: "ghost", base: "", repos: [] })
        expect(warnings.join("\n")).toContain("ghost")
    })

    it("covers several repos in one stable, sorted report", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["web", "api"])
        const apiWt = await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")
        await commit(apiWt, "work.txt", "x\n", "api work")

        const parsed = await captureJson<DiffJson>(async () => {
            await diff.run({ task: "alpha" })
        })

        expect(parsed.repos.map((r) => r.name)).toEqual(["api", "web"])
        expect(parsed.repos[0].ahead).toBe(1)
        expect(parsed.repos[1].ahead).toBe(0)
    })

    it("a STACKED child's ahead-count is vs the PARENT branch, not main (no crash)", async () => {
        await makeSource("web")
        await register(["web"])
        // strings is a root with one commit; logos stacks on it (branched off
        // the parent branch) with its OWN single commit on top.
        const stringsWt = path.join(root, "tasks", "alpha", "web@strings")
        const source = path.join(root, "source", "web")
        await sh(
            source,
            "worktree",
            "add",
            "-b",
            "task/alpha@strings",
            stringsWt,
            "main"
        )
        await commit(stringsWt, "strings.txt", "s\n", "strings work")
        const logosWt = path.join(root, "tasks", "alpha", "web@logos")
        await sh(
            source,
            "worktree",
            "add",
            "-b",
            "task/alpha@logos",
            logosWt,
            "task/alpha@strings"
        )
        await commit(logosWt, "logos.txt", "l\n", "logos work")
        // The note declares the sibling edge logos.base = web@strings.
        await fsp.mkdir(path.join(root, "tasks", "alpha"), { recursive: true })
        await fsp.writeFile(
            path.join(root, "tasks", "alpha", "ubertask.yml"),
            "goal: |\n  stacked\n\nrepos:\n  - web@strings\n  - web@logos\n\nbranches:\n  web@logos:\n    name: task/alpha@logos\n    adopted: false\n    base: web@strings\n"
        )

        const parsed = await captureJson<DiffJson>(async () => {
            await diff.run({ task: "alpha" })
        })

        const byName = new Map(parsed.repos.map((r) => [r.name, r]))
        const logos = byName.get("web@logos")
        // The child is measured against its PARENT branch: exactly its own one
        // commit ahead (NOT 2, which is what comparing against main would give),
        // and it did NOT crash on the `web@strings` sibling token.
        expect(logos?.status).toBe("ok")
        expect(logos?.ahead).toBe(1)
        expect(logos?.commits?.map((c) => c.subject)).toEqual(["logos work"])
        // The root is measured against origin's default, as before.
        expect(byName.get("web@strings")?.ahead).toBe(1)
    })
})
