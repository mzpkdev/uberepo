import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { terminal } from "cmdore"
import { vi } from "vitest"
import prune from "@/commands/prune"
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
// restore them. prune uses log for the would-prune/summary lines and warn for
// per-task removal failures, so both are needed.
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

describe("prune command", () => {
    let tmp: string
    let root: string
    let cwd: string
    let configPath: string

    // Build a fresh uberepo workspace and chdir into it for each test. `root`
    // is the realpath of the workspace because macOS canonicalises /var ->
    // /private/var and git reports worktree paths under the realpath.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "prune-spec-"))
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
    // origin/main. The bare repo is the shared truth we advance to simulate
    // other people merging work.
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
    // is already an ancestor of origin/main -> merged).
    const openWorktree = async (
        name: string,
        task: string
    ): Promise<string> => {
        const source = path.join(root, "source", name)
        const wt = path.join(root, "tasks", task, name)
        await sh(source, "worktree", "add", "-b", `task/${task}`, wt, "main")
        return wt
    }

    // Land a task branch in origin/main: commit on the task worktree, merge it
    // into the source's main, then push main to the bare upstream. After this
    // `isMerged(task/<task>, origin/main)` is true even though the task branch
    // has its own commit. The worktree stays checked out on the task branch.
    const landTask = async (name: string, task: string): Promise<void> => {
        const source = path.join(root, "source", name)
        const wt = path.join(root, "tasks", task, name)
        const file = `${task}-${name}.txt`
        await fsp.writeFile(path.join(wt, file), "landed work\n")
        await sh(wt, "add", file)
        await sh(wt, "commit", "-m", `${task}: work`)
        // Merge the task branch into the source's main (fast-forward), then
        // publish main upstream so origin/main advances to include it.
        await sh(source, "merge", "--ff-only", `task/${task}`)
        await sh(source, "push", "origin", "main")
        // Refresh origin/main on the source so isMerged sees the latest.
        await sh(source, "fetch", "origin")
    }

    // Leave a committed-but-unpushed commit on the task branch, so its tip is
    // NOT an ancestor of origin/main -> the branch is unmerged (active).
    const activateTask = async (name: string, task: string): Promise<void> => {
        const wt = path.join(root, "tasks", task, name)
        const file = `${task}-${name}-active.txt`
        await fsp.writeFile(path.join(wt, file), "active work\n")
        await sh(wt, "add", file)
        await sh(wt, "commit", "-m", `${task}: active work`)
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

    // Write a ubertask.yml at the task level declaring a scope (the repos: the
    // task owns), so prune can be exercised against a scoped task.
    const writeScope = async (task: string, repos: string[]): Promise<void> => {
        const dir = path.join(root, "tasks", task)
        await fsp.mkdir(dir, { recursive: true })
        const list = repos.map((r) => `  - ${r}`).join("\n")
        await fsp.writeFile(
            path.join(dir, "ubertask.yml"),
            `goal: |\n  g\n\nrepos:\n${list}\n`
        )
    }

    it("preview lists a merged task, omits an unmerged task, and removes nothing", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "done")
        await landTask("api", "done")
        await openWorktree("api", "active")
        await activateTask("api", "active")

        const { logs } = await captureOutput(async () => {
            await prune.run({ force: false })
        })

        const joined = logs.join("\n")
        expect(joined).toContain("would prune done (api)")
        expect(joined).not.toContain("would prune active")
        expect(joined).toContain("Run prune --force to remove 1 task.")
        // Nothing was removed: both worktrees and branches survive.
        expect(fs.existsSync(taskDir("done", "api"))).toBe(true)
        expect(fs.existsSync(taskDir("active", "api"))).toBe(true)
        expect(await branchExists("api", "done")).toBe(true)
        expect(await branchExists("api", "active")).toBe(true)
    })

    it("atomic: keeps a task where one repo is merged but another is not", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")
        // api merged, web still has unpushed work -> the task is not done.
        await landTask("api", "alpha")
        await activateTask("web", "alpha")

        const { logs } = await captureOutput(async () => {
            await prune.run({ force: false })
        })

        const joined = logs.join("\n")
        expect(joined).not.toContain("would prune alpha")
        expect(joined).toContain("Nothing to prune — 1 task still active.")
        // Nothing removed in either repo.
        for (const name of ["api", "web"]) {
            expect(fs.existsSync(taskDir("alpha", name))).toBe(true)
            expect(await branchExists(name, "alpha")).toBe(true)
        }
    })

    it("respects a declared scope: prunes only in-scope repos, warns about a stray, and leaves it standing", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")
        // Both merged, but the task owns api only; web's worktree is drift.
        await landTask("api", "alpha")
        await landTask("web", "alpha")
        await writeScope("alpha", ["api"])

        // Preview names only the in-scope repo and warns about the stray.
        const preview = await captureOutput(async () => {
            await prune.run({ force: false })
        })
        expect(preview.logs.join("\n")).toContain("would prune alpha (api)")
        expect(preview.warnings.join("\n")).toContain(
            "alpha/web: worktree outside task scope"
        )

        // --force prunes api (in scope) and leaves web (the stray) untouched.
        const applied = await captureOutput(async () => {
            await prune.run({ force: true })
        })
        expect(applied.logs.join("\n")).toContain("Pruned alpha")
        expect(applied.warnings.join("\n")).toContain(
            "alpha/web: worktree outside task scope"
        )
        expect(fs.existsSync(taskDir("alpha", "api"))).toBe(false)
        expect(await branchExists("api", "alpha")).toBe(false)
        expect(fs.existsSync(taskDir("alpha", "web"))).toBe(true)
        expect(await branchExists("web", "alpha")).toBe(true)
    })

    it("a dirty stray does not pin a scoped task open (dirty-check is in-scope only)", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        const webWt = await openWorktree("web", "alpha")
        await landTask("api", "alpha") // in-scope, merged + clean
        await writeScope("alpha", ["api"])
        // Dirty the OUT-OF-SCOPE stray: it must not keep the task active.
        await fsp.writeFile(path.join(webWt, "README.md"), "uncommitted\n")

        const { logs } = await captureOutput(async () => {
            await prune.run({ force: false })
        })
        // Scoped to api (merged + clean) -> prunable despite the dirty stray.
        expect(logs.join("\n")).toContain("would prune alpha (api)")
    })

    it("--force prunes a merged task across every repo and leaves an unmerged task", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        // done: merged in both repos. active: unmerged.
        await openWorktree("api", "done")
        await openWorktree("web", "done")
        await landTask("api", "done")
        await landTask("web", "done")
        await openWorktree("api", "active")
        await activateTask("api", "active")

        const { logs } = await captureOutput(async () => {
            await prune.run({ force: true })
        })

        const joined = logs.join("\n")
        expect(joined).toContain("Pruned done")
        expect(joined).toContain("Pruned 1 task.")
        // done is gone everywhere: worktrees removed AND branches deleted.
        for (const name of ["api", "web"]) {
            expect(fs.existsSync(taskDir("done", name))).toBe(false)
            expect(await branchExists(name, "done")).toBe(false)
        }
        // active is untouched.
        expect(fs.existsSync(taskDir("active", "api"))).toBe(true)
        expect(await branchExists("api", "active")).toBe(true)
    })

    it("--force keeps a merged task whose worktree is dirty", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        await landTask("api", "alpha")
        // Uncommitted change makes the (otherwise merged) worktree dirty.
        await fsp.writeFile(path.join(wt, "README.md"), "uncommitted\n")

        const { logs } = await captureOutput(async () => {
            await prune.run({ force: true })
        })

        const joined = logs.join("\n")
        expect(joined).toContain("Nothing to prune — 1 task still active.")
        expect(joined).not.toContain("Pruned alpha")
        // Dirty worktree and its branch survive even under --force.
        expect(fs.existsSync(taskDir("alpha", "api"))).toBe(true)
        expect(await branchExists("api", "alpha")).toBe(true)
    })

    it("reports no open tasks when there are none", async () => {
        await makeSource("api")
        await register(["api"])
        // No worktrees opened.

        const { logs } = await captureOutput(async () => {
            await prune.run({ force: false })
        })

        expect(logs).toContain("No open tasks.")
        expect(logs.join("\n")).not.toContain("would prune")
        expect(logs.join("\n")).not.toContain("Pruned")
    })

    it("reports nothing to prune when tasks exist but none are merged", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")
        await openWorktree("api", "beta")
        await activateTask("api", "alpha")
        await activateTask("api", "beta")

        const { logs } = await captureOutput(async () => {
            await prune.run({ force: true })
        })

        const joined = logs.join("\n")
        expect(joined).toContain("Nothing to prune — 2 tasks still active.")
        expect(joined).not.toContain("Pruned")
        // Nothing removed.
        for (const task of ["alpha", "beta"]) {
            expect(fs.existsSync(taskDir(task, "api"))).toBe(true)
            expect(await branchExists("api", task)).toBe(true)
        }
    })

    it("throws when no config exists in cwd or any parent", async () => {
        const orphan = await fsp.mkdtemp(
            path.join(os.tmpdir(), "prune-orphan-")
        )
        process.chdir(orphan)
        try {
            let error: unknown
            try {
                await prune.run({ force: false })
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

    describe("adopted branches", () => {
        // Open a worktree on a pre-existing branch and record it ADOPTED.
        const adoptWorktree = async (
            name: string,
            task: string,
            branch: string
        ): Promise<string> => {
            const source = path.join(root, "source", name)
            await sh(source, "branch", branch, "main")
            const wt = path.join(root, "tasks", task, name)
            await sh(source, "worktree", "add", wt, branch)
            const dir = path.join(root, "tasks", task)
            await fsp.mkdir(dir, { recursive: true })
            await fsp.writeFile(
                path.join(dir, "ubertask.yml"),
                `goal: |\n  g\n\nbranches:\n  ${name}:\n    name: ${branch}\n    adopted: true\n`
            )
            return wt
        }

        const namedBranchExists = async (
            name: string,
            branch: string
        ): Promise<boolean> => {
            const source = path.join(root, "source", name)
            try {
                await sh(
                    source,
                    "show-ref",
                    "--verify",
                    "--quiet",
                    `refs/heads/${branch}`
                )
                return true
            } catch {
                return false
            }
        }

        it("prunes the task (worktree removed) but NEVER deletes the adopted branch", async () => {
            await makeSource("api")
            await register(["api"])
            // An adopted branch with its own UNMERGED commit: a created branch
            // would keep the task ("unmerged"), but an adopted branch is always
            // "done" for prune — yet the branch survives the removal.
            const wt = await adoptWorktree("api", "alpha", "feature/login")
            await fsp.writeFile(path.join(wt, "x.txt"), "work\n")
            await sh(wt, "add", "x.txt")
            await sh(wt, "commit", "-m", "adopted work")

            const json = await captureJson<PruneJson>(async () => {
                await prune.run({ force: true })
            })

            expect(json).toEqual({
                forced: true,
                tasks: [{ task: "alpha", status: "pruned" }]
            })
            expect(fs.existsSync(wt)).toBe(false)
            expect(await namedBranchExists("api", "feature/login")).toBe(true)
        })
    })

    type PruneJson = {
        forced: boolean
        tasks: { task: string; status: string; reason?: string }[]
    }

    describe("--json", () => {
        it("emits { forced:false, tasks:[] } under --json when there are no open tasks", async () => {
            await makeSource("api")
            await register(["api"])

            const json = await captureJson<PruneJson>(async () => {
                await prune.run({ force: false })
            })
            expect(json).toEqual({ forced: false, tasks: [] })
        })

        it("preview --json: prunable tasks read as pruned candidates, kept ones carry reasons", async () => {
            await makeSource("api")
            await register(["api"])
            // done: merged → prunable. active: unmerged → kept.
            await openWorktree("api", "done")
            await landTask("api", "done")
            await openWorktree("api", "active")
            await activateTask("api", "active")

            const json = await captureJson<PruneJson>(async () => {
                await prune.run({ force: false })
            })
            // forced:false signals nothing was removed; candidates first (the
            // prunable list, sorted), then the kept tasks with their reasons.
            expect(json).toEqual({
                forced: false,
                tasks: [
                    { task: "done", status: "pruned" },
                    { task: "active", status: "kept", reason: "unmerged" }
                ]
            })
        })

        it("force --json: prunes the merged task and keeps the unmerged one", async () => {
            await makeSource("api")
            await register(["api"])
            await openWorktree("api", "done")
            await landTask("api", "done")
            await openWorktree("api", "active")
            await activateTask("api", "active")

            const json = await captureJson<PruneJson>(async () => {
                await prune.run({ force: true })
            })
            expect(json).toEqual({
                forced: true,
                tasks: [
                    { task: "done", status: "pruned" },
                    { task: "active", status: "kept", reason: "unmerged" }
                ]
            })
        })

        it("keeps a merged-but-dirty task under --json with reason:dirty", async () => {
            await makeSource("api")
            await register(["api"])
            const wt = await openWorktree("api", "done")
            await landTask("api", "done")
            // Uncommitted change makes the otherwise-merged worktree dirty.
            await fsp.writeFile(path.join(wt, "README.md"), "uncommitted\n")

            const json = await captureJson<PruneJson>(async () => {
                await prune.run({ force: true })
            })
            expect(json).toEqual({
                forced: true,
                tasks: [{ task: "done", status: "kept", reason: "dirty" }]
            })
        })
    })

    describe("aliased participants (multiple branches per repo)", () => {
        // Open an aliased worktree on branch task/<task>@<alias>, off main.
        const openAliased = async (
            name: string,
            task: string,
            alias: string
        ): Promise<string> => {
            const source = path.join(root, "source", name)
            const wt = path.join(root, "tasks", task, `${name}@${alias}`)
            await sh(
                source,
                "worktree",
                "add",
                "-b",
                `task/${task}@${alias}`,
                wt,
                "main"
            )
            return wt
        }

        // Commit one file on an aliased participant's worktree (so its branch
        // has work of its own), without disturbing any sibling worktree.
        const commitAliased = async (
            name: string,
            task: string,
            alias: string
        ): Promise<void> => {
            const wt = path.join(root, "tasks", task, `${name}@${alias}`)
            const file = `${alias}.txt`
            await fsp.writeFile(path.join(wt, file), "landed\n")
            await sh(wt, "add", file)
            await sh(wt, "commit", "-m", `${alias}: work`)
        }

        // Land every named aliased branch into origin/main so each reads as
        // merged, via ONE detached scratch worktree (source/<repo> itself holds
        // main, so the scratch is detached, merges each branch in, and pushes
        // the combined main once).
        const landAll = async (
            name: string,
            task: string,
            aliases: string[]
        ): Promise<void> => {
            const source = path.join(root, "source", name)
            const scratch = path.join(root, "_merge", name)
            await fsp.mkdir(path.dirname(scratch), { recursive: true })
            await sh(source, "worktree", "add", "--detach", scratch, "main")
            for (const alias of aliases) {
                await sh(scratch, "merge", "--no-edit", `task/${task}@${alias}`)
            }
            // Publish the combined history as main upstream.
            await sh(scratch, "push", "origin", "HEAD:main")
            await sh(source, "worktree", "remove", "--force", scratch)
            await sh(source, "fetch", "origin")
            // Advance the source's LOCAL main too, so `git branch -d` (which
            // checks ancestry against HEAD/main, not origin/main) sees each
            // landed branch as fully merged. The source holds main checked out,
            // so fast-forward it to the freshly fetched origin/main.
            await sh(source, "merge", "--ff-only", "origin/main")
        }

        const aliasedBranchExists = async (
            name: string,
            branch: string
        ): Promise<boolean> => {
            try {
                await sh(
                    path.join(root, "source", name),
                    "show-ref",
                    "--verify",
                    "--quiet",
                    `refs/heads/${branch}`
                )
                return true
            } catch {
                return false
            }
        }

        it("prunes a task with several participants of one repo, removing every worktree + branch", async () => {
            await makeSource("autopilot")
            await register(["autopilot"])
            await openAliased("autopilot", "alpha", "bug-fix")
            await openAliased("autopilot", "alpha", "add-feature")
            await commitAliased("autopilot", "alpha", "bug-fix")
            await commitAliased("autopilot", "alpha", "add-feature")
            await landAll("autopilot", "alpha", ["bug-fix", "add-feature"])
            await writeScope("alpha", [
                "autopilot@bug-fix",
                "autopilot@add-feature"
            ])

            const json = await captureJson<PruneJson>(async () => {
                await prune.run({ force: true })
            })

            expect(json.tasks).toEqual([{ task: "alpha", status: "pruned" }])
            // Both participant worktrees + their branches are gone...
            expect(fs.existsSync(taskDir("alpha", "autopilot@bug-fix"))).toBe(
                false
            )
            expect(
                fs.existsSync(taskDir("alpha", "autopilot@add-feature"))
            ).toBe(false)
            expect(
                await aliasedBranchExists("autopilot", "task/alpha@bug-fix")
            ).toBe(false)
            expect(
                await aliasedBranchExists("autopilot", "task/alpha@add-feature")
            ).toBe(false)
            // ...but the SHARED source clone survives.
            expect(fs.existsSync(path.join(root, "source", "autopilot"))).toBe(
                true
            )
        })
    })
})
