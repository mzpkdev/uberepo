import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { terminal } from "cmdore"
import { vi } from "vitest"
import sync from "@/commands/sync"
import { CONFIG_FILENAME } from "@/config"
import git from "@/git"

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
// restore them. sync uses log for per-repo lines + summary and warn for the
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

describe("sync command", () => {
    let tmp: string
    let root: string
    let cwd: string
    let configPath: string

    // Build a fresh uberepo workspace and chdir into it for each test. `root`
    // is the realpath of the workspace because macOS canonicalises /var ->
    // /private/var and git reports worktree paths under the realpath.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "sync-spec-"))
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
    // origin/main. The bare repo is the shared truth we can advance to simulate
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

    // Drop the origin remote so neither origin/main nor origin/HEAD resolves,
    // forcing sync to require --from.
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

    // Register flat names AND a hooks map, so the hook wiring can be exercised.
    const registerWithHooks = async (
        names: string[],
        hooks: Record<string, string>
    ): Promise<void> => {
        await fsp.writeFile(
            configPath,
            `${JSON.stringify(
                {
                    repositories: names.map(
                        (n) => `https://github.com/acme/${n}.git`
                    ),
                    hooks
                },
                null,
                4
            )}\n`
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
    // task owns), so sync/close/prune can be exercised against a scoped task.
    const writeScope = async (task: string, repos: string[]): Promise<void> => {
        const dir = path.join(root, "tasks", task)
        await fsp.mkdir(dir, { recursive: true })
        const list = repos.map((r) => `  - ${r}`).join("\n")
        await fsp.writeFile(
            path.join(dir, "ubertask.yml"),
            `goal: |\n  g\n\nrepos:\n${list}\n`
        )
    }

    // Advance the shared upstream's main by one commit that touches `file`,
    // routed through a throwaway clone so it never disturbs the source repo or
    // its worktrees. Returns the new origin/main commit sha.
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

    // sha the local branch task/<task> in source repo `name` points at.
    const branchSha = (name: string, task: string): Promise<string> => {
        const source = path.join(root, "source", name)
        return sh(source, "rev-parse", `task/${task}`)
    }

    // True when commit `sha` is reachable from the task branch's tip.
    const reachable = async (
        name: string,
        task: string,
        sha: string
    ): Promise<boolean> => {
        const source = path.join(root, "source", name)
        try {
            await sh(source, "merge-base", "--is-ancestor", sha, `task/${task}`)
            return true
        } catch {
            return false
        }
    }

    // True when a worktree has a rebase in progress (rebase-merge or
    // rebase-apply state dir under the worktree's gitdir). Worktrees keep this
    // state under .git/worktrees/<id>/, so resolve the gitdir from the file.
    const rebaseInProgress = async (wt: string): Promise<boolean> => {
        const gitFile = path.join(wt, ".git")
        const stat = await fsp.stat(gitFile)
        let gitdir: string
        if (stat.isDirectory()) {
            gitdir = gitFile
        } else {
            const text = await fsp.readFile(gitFile, "utf8")
            const match = text.match(/^gitdir:\s*(.+)$/m)
            if (!match) return false
            gitdir = path.resolve(wt, match[1].trim())
        }
        return (
            fs.existsSync(path.join(gitdir, "rebase-merge")) ||
            fs.existsSync(path.join(gitdir, "rebase-apply"))
        )
    }

    it("syncs a task: rebases each task branch onto the advanced origin default", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        const apiWt = await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")

        // Each task branch gets its own local commit, so a real replay happens.
        await fsp.writeFile(path.join(apiWt, "work.txt"), "api work\n")
        await sh(apiWt, "add", "work.txt")
        await sh(apiWt, "commit", "-m", "api task work")
        const webWt = path.join(root, "tasks", "alpha", "web")
        await fsp.writeFile(path.join(webWt, "work.txt"), "web work\n")
        await sh(webWt, "add", "work.txt")
        await sh(webWt, "commit", "-m", "web task work")

        // Others merged new work to main in both upstreams.
        const apiTip = await advanceUpstream("api", "upstream.txt", "api\n")
        const webTip = await advanceUpstream("web", "upstream.txt", "web\n")

        const { logs } = await captureOutput(async () => {
            await sync.run({
                task: "alpha",
                from: undefined,
                "no-hooks": false,
                check: false
            })
        })

        // The new origin/main tip is now reachable from each task branch.
        expect(await reachable("api", "alpha", apiTip)).toBe(true)
        expect(await reachable("web", "alpha", webTip)).toBe(true)
        // ...and the task's own work survived the replay.
        expect(fs.existsSync(path.join(apiWt, "work.txt"))).toBe(true)
        expect(fs.existsSync(path.join(webWt, "work.txt"))).toBe(true)

        const joined = logs.join("\n")
        expect(joined).toContain("Syncing api → rebasing task/alpha onto")
        expect(joined).toContain("api: synced")
        expect(joined).toContain("web: synced")
        expect(joined).toContain("Synced task alpha in 2 repositories")
    })

    it("respects a declared scope: syncs in-scope repos and warns about a stray worktree", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        const apiWt = await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")
        // Scope owns api only; web's worktree is drift.
        await writeScope("alpha", ["api"])

        // Local work on both so a rebase would replay if it ran.
        await fsp.writeFile(path.join(apiWt, "work.txt"), "api work\n")
        await sh(apiWt, "add", "work.txt")
        await sh(apiWt, "commit", "-m", "api task work")
        const apiTip = await advanceUpstream("api", "upstream.txt", "api\n")
        const webBefore = await branchSha("web", "alpha")
        const webTip = await advanceUpstream("web", "upstream.txt", "web\n")

        const { logs, warnings } = await captureOutput(async () => {
            await sync.run({
                task: "alpha",
                from: undefined,
                "no-hooks": false,
                check: false
            })
        })

        const joined = logs.join("\n")
        // api (in scope) was synced...
        expect(await reachable("api", "alpha", apiTip)).toBe(true)
        expect(joined).toContain("api: synced")
        expect(joined).toContain("Synced task alpha in 1 repository")
        // ...web (the stray) was warned about and left untouched.
        expect(warnings.join("\n")).toContain(
            "web: worktree outside task scope"
        )
        expect(joined).not.toContain("web: synced")
        expect(await branchSha("web", "alpha")).toBe(webBefore)
        expect(await reachable("web", "alpha", webTip)).toBe(false)
    })

    it("--from rebases onto the given ref instead of the origin default", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        const source = path.join(root, "source", "api")

        // A diverging branch in the source repo to target with --from. The task
        // branch should land on top of it, NOT on origin/main.
        await sh(source, "branch", "feature", "main")
        await sh(source, "switch", "feature")
        await fsp.writeFile(path.join(source, "base.txt"), "base\n")
        await sh(source, "add", "base.txt")
        await sh(source, "commit", "-m", "feature base")
        const featureTip = await sh(source, "rev-parse", "feature")
        await sh(source, "switch", "main")

        // Advance origin/main too, to prove sync did NOT target it.
        const originTip = await advanceUpstream("api", "upstream.txt", "x\n")

        // Local work on the task branch so the rebase replays something.
        await fsp.writeFile(path.join(wt, "work.txt"), "work\n")
        await sh(wt, "add", "work.txt")
        await sh(wt, "commit", "-m", "task work")

        const { logs } = await captureOutput(async () => {
            await sync.run({
                task: "alpha",
                from: "feature",
                "no-hooks": false,
                check: false
            })
        })

        expect(await reachable("api", "alpha", featureTip)).toBe(true)
        expect(await reachable("api", "alpha", originTip)).toBe(false)
        expect(logs.join("\n")).toContain(
            "Syncing api → rebasing task/alpha onto feature"
        )
        expect(logs.join("\n")).toContain("api: synced")
    })

    it("dirty pre-flight: stops, reports, and makes no changes anywhere", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        const apiWt = await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")

        // web is clean; remember its branch sha to prove it was untouched.
        const webBefore = await branchSha("web", "alpha")
        // api is dirty via an uncommitted change.
        await fsp.writeFile(path.join(apiWt, "README.md"), "uncommitted\n")

        // Advance both upstreams: had sync run, it would have rebased.
        await advanceUpstream("api", "upstream.txt", "api\n")
        const webTip = await advanceUpstream("web", "upstream.txt", "web\n")

        const { logs, warnings } = await captureOutput(async () => {
            await sync.run({
                task: "alpha",
                from: undefined,
                "no-hooks": false,
                check: false
            })
        })

        const joined = logs.join("\n")
        expect(joined).toContain(
            "api: uncommitted changes — commit or stash first"
        )
        // No rebase ran: no per-repo "Syncing"/"synced" or summary, no warn.
        expect(joined).not.toContain("Syncing")
        expect(joined).not.toContain(": synced")
        expect(joined).not.toContain("Synced task")
        expect(warnings).toHaveLength(0)
        // The clean repo (web) was left exactly as it was — not rebased.
        expect(await branchSha("web", "alpha")).toBe(webBefore)
        expect(await reachable("web", "alpha", webTip)).toBe(false)
    })

    it("Decision A: a conflicting repo is left mid-rebase, but an INDEPENDENT repo still rebases (no global stop)", async () => {
        // "api" sorts before "web", so api is processed first. Under the old
        // contract api's conflict halted the run and web was "not reached";
        // Decision A prunes only api's (empty) subtree and continues to web.
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        const apiWt = await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")

        // Engineer a conflict on api: upstream and the task branch each change
        // README.md (which already exists from the initial commit) differently.
        await advanceUpstream("api", "README.md", "from upstream\n")
        await fsp.writeFile(path.join(apiWt, "README.md"), "from task\n")
        await sh(apiWt, "add", "README.md")
        await sh(apiWt, "commit", "-m", "task edits readme")

        // web is an independent root: own file + advanced upstream → it rebases
        // cleanly even though api conflicted first.
        const webWt = path.join(root, "tasks", "alpha", "web")
        await fsp.writeFile(path.join(webWt, "work.txt"), "web work\n")
        await sh(webWt, "add", "work.txt")
        await sh(webWt, "commit", "-m", "web task work")
        const webTip = await advanceUpstream("web", "upstream.txt", "web\n")

        const previousExit = process.exitCode
        process.exitCode = undefined
        let logs: string[]
        try {
            ;({ logs } = await captureOutput(async () => {
                await sync.run({
                    task: "alpha",
                    from: undefined,
                    "no-hooks": false,
                    check: false
                })
            }))
            expect(process.exitCode).toBe(1)
        } finally {
            process.exitCode = previousExit
        }

        const joined = logs.join("\n")
        // Message names the repo and its path, and offers resolve/abort.
        expect(joined).toContain("api: rebase conflict")
        expect(joined).toContain(apiWt)
        expect(joined).toContain("git rebase --abort")
        // The run reports the stop but did NOT skip web.
        expect(joined).toContain("stopped on a conflict in api")
        // web WAS synced (the per-forest independence Decision A buys).
        expect(joined).toContain("web: synced")
        // api is left mid-rebase (the resolve/abort signal for the user).
        expect(await rebaseInProgress(apiWt)).toBe(true)
        // web took the advanced upstream — it was not held back by api.
        expect(await reachable("web", "alpha", webTip)).toBe(true)

        // Clean up the in-progress rebase so afterEach can remove the tree.
        await sh(apiWt, "rebase", "--abort")
    })

    it("errors without --from when origin's default cannot be resolved, rebasing nothing", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        // Local work, then sever origin so neither origin/main nor origin/HEAD
        // resolves.
        await fsp.writeFile(path.join(wt, "work.txt"), "work\n")
        await sh(wt, "add", "work.txt")
        await sh(wt, "commit", "-m", "task work")
        const before = await branchSha("api", "alpha")
        await dropOrigin("api")

        const { logs } = await captureOutput(async () => {
            await sync.run({
                task: "alpha",
                from: undefined,
                "no-hooks": false,
                check: false
            })
        })

        const joined = logs.join("\n")
        expect(joined).toContain(
            "api: cannot resolve origin's default branch — pass --from <ref>"
        )
        // The repo is a per-repo skip (no flatten, nothing half-done): no
        // "Syncing api"/"api: synced" line for it. With no resolvable target it
        // contributes 0 to the synced count — the run summarises "in 0
        // repositories" rather than the old global stop.
        expect(joined).not.toContain("api: synced")
        expect(joined).toContain("Synced task alpha in 0 repositories")
        // Nothing was rebased: branch tip unchanged, no rebase left running.
        expect(await branchSha("api", "alpha")).toBe(before)
        expect(await rebaseInProgress(wt)).toBe(false)
    })

    it("warns and exits clean when the task is not found, touching nothing", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")
        const before = await branchSha("api", "alpha")

        const { logs, warnings } = await captureOutput(async () => {
            await sync.run({
                task: "ghost",
                from: undefined,
                "no-hooks": false,
                check: false
            })
        })

        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain("ghost")
        expect(logs.some((l) => l.includes("Synced task"))).toBe(false)
        expect(logs.some((l) => l.includes("Syncing"))).toBe(false)
        // The real task is untouched.
        expect(await branchSha("api", "alpha")).toBe(before)
    })

    it("throws when no config exists in cwd or any parent", async () => {
        const orphan = await fsp.mkdtemp(path.join(os.tmpdir(), "sync-orphan-"))
        process.chdir(orphan)
        try {
            let error: unknown
            try {
                await sync.run({
                    task: "alpha",
                    from: undefined,
                    "no-hooks": false,
                    check: false
                })
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

    type SyncJson = {
        task: string
        onto: string
        repos: { name: string; status: string; reason?: string }[]
        hooks: { event: string; repo: string; exit: number }[]
        carry: {
            repo: string
            copied: string[]
            keptExisting: string[]
            skippedTracked: string[]
        }[]
    }

    describe("--json", () => {
        it("emits rebased per repo with the resolved onto under --json", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])
            const apiWt = await openWorktree("api", "alpha")
            const webWt = await openWorktree("web", "alpha")
            // Local work + advanced upstream so each repo actually replays.
            await fsp.writeFile(path.join(apiWt, "work.txt"), "api work\n")
            await sh(apiWt, "add", "work.txt")
            await sh(apiWt, "commit", "-m", "api task work")
            await fsp.writeFile(path.join(webWt, "work.txt"), "web work\n")
            await sh(webWt, "add", "work.txt")
            await sh(webWt, "commit", "-m", "web task work")
            await advanceUpstream("api", "u.txt", "api up\n")
            await advanceUpstream("web", "u.txt", "web up\n")

            const json = await captureJson<SyncJson>(async () => {
                await sync.run({
                    task: "alpha",
                    from: undefined,
                    "no-hooks": false,
                    check: false
                })
            })
            // Each root carries its own per-entry `base` (= the run-level onto)
            // — Phase 3 added it so a stacked child can name its parent instead.
            expect(json).toEqual({
                task: "alpha",
                onto: "origin/main",
                repos: [
                    { name: "api", status: "rebased", base: "origin/main" },
                    { name: "web", status: "rebased", base: "origin/main" }
                ],
                hooks: [],
                carry: []
            })
        })

        it("Decision A: a conflict no longer halts an independent repo — it rebases; the conflict is reported", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])
            const apiWt = await openWorktree("api", "alpha")
            const webWt = await openWorktree("web", "alpha")
            // Engineer a conflict on api (api sorts first).
            await advanceUpstream("api", "README.md", "from upstream\n")
            await fsp.writeFile(path.join(apiWt, "README.md"), "from task\n")
            await sh(apiWt, "add", "README.md")
            await sh(apiWt, "commit", "-m", "task edits readme")
            // web is an INDEPENDENT root that would rebase cleanly. Under the
            // old global-stop it was "not reached"; under Decision A it rebases.
            await fsp.writeFile(path.join(webWt, "work.txt"), "web work\n")
            await sh(webWt, "add", "work.txt")
            await sh(webWt, "commit", "-m", "web task work")
            const webTip = await advanceUpstream("web", "u.txt", "web\n")

            const previousExit = process.exitCode
            process.exitCode = undefined
            let json: SyncJson
            try {
                json = await captureJson<SyncJson>(async () => {
                    await sync.run({
                        task: "alpha",
                        from: undefined,
                        "no-hooks": false,
                        check: false
                    })
                })
                // A conflict anywhere still flips the exit code non-zero.
                expect(process.exitCode).toBe(1)
            } finally {
                process.exitCode = previousExit
            }
            // api conflicts and is reported; web — independent — still rebased.
            expect(json).toEqual({
                task: "alpha",
                onto: "origin/main",
                repos: [
                    { name: "api", status: "conflict", base: "origin/main" },
                    { name: "web", status: "rebased", base: "origin/main" }
                ],
                hooks: [],
                carry: []
            })
            // web really took the advanced tip; api is left mid-rebase.
            expect(await reachable("web", "alpha", webTip)).toBe(true)
            expect(await rebaseInProgress(apiWt)).toBe(true)
            // Leave the tree clean so afterEach can remove the worktree.
            await sh(apiWt, "rebase", "--abort")
        })

        it("emits dirty repos as skipped and clean ones as not reached under --json", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])
            const apiWt = await openWorktree("api", "alpha")
            await openWorktree("web", "alpha")
            // api dirty → the pre-flight bails before touching anything.
            await fsp.writeFile(path.join(apiWt, "README.md"), "uncommitted\n")

            const json = await captureJson<SyncJson>(async () => {
                await sync.run({
                    task: "alpha",
                    from: undefined,
                    "no-hooks": false,
                    check: false
                })
            })
            // onto stays empty: the pre-flight bailed before any repo resolved.
            expect(json).toEqual({
                task: "alpha",
                onto: "",
                repos: [
                    {
                        name: "api",
                        status: "skipped",
                        reason: "uncommitted changes"
                    },
                    { name: "web", status: "skipped", reason: "not reached" }
                ],
                hooks: [],
                carry: []
            })
        })

        it("respects --from for the onto value under --json", async () => {
            await makeSource("api")
            await register(["api"])
            const wt = await openWorktree("api", "alpha")
            await fsp.writeFile(path.join(wt, "work.txt"), "work\n")
            await sh(wt, "add", "work.txt")
            await sh(wt, "commit", "-m", "task work")

            const json = await captureJson<SyncJson>(async () => {
                await sync.run({
                    task: "alpha",
                    from: "main",
                    "no-hooks": false,
                    check: false
                })
            })
            expect(json.onto).toBe("main")
            expect(json.repos).toEqual([
                { name: "api", status: "rebased", base: "main" }
            ])
        })

        it("emits empty repos under --json when the task is not open", async () => {
            await makeSource("api")
            await register(["api"])

            const json = await captureJson<SyncJson>(async () => {
                await sync.run({
                    task: "ghost",
                    from: undefined,
                    "no-hooks": false,
                    check: false
                })
            })
            expect(json).toEqual({
                task: "ghost",
                onto: "",
                repos: [],
                hooks: [],
                carry: []
            })
        })
    })

    describe("hooks", () => {
        // Give a task branch a local commit so the rebase actually replays.
        const commitWork = async (wt: string): Promise<void> => {
            await fsp.writeFile(path.join(wt, "work.txt"), "work\n")
            await sh(wt, "add", "work.txt")
            await sh(wt, "commit", "-m", "task work")
        }

        it("fires post-sync ONLY for cleanly-rebased repos (not conflicted/not-reached)", async () => {
            await makeSource("api")
            await makeSource("web")
            await registerWithHooks(["api", "web"], {
                "post-sync": "touch hooked"
            })
            const apiWt = await openWorktree("api", "alpha")
            const webWt = await openWorktree("web", "alpha")
            // api rebases cleanly (own file); web conflicts on README.md, which
            // stops the run — api sorts first, so it is rebased before the stop.
            await commitWork(apiWt)
            await advanceUpstream("api", "u.txt", "api up\n")
            await advanceUpstream("web", "README.md", "from upstream\n")
            await fsp.writeFile(path.join(webWt, "README.md"), "from task\n")
            await sh(webWt, "add", "README.md")
            await sh(webWt, "commit", "-m", "task edits readme")

            const json = await captureJson<SyncJson>(async () => {
                await sync.run({
                    task: "alpha",
                    from: undefined,
                    "no-hooks": false,
                    check: false
                })
            })
            // api: rebased + hook ran; web: conflict + no hook.
            expect(json.hooks).toEqual([
                { event: "post-sync", repo: "api", exit: 0 }
            ])
            expect(fs.existsSync(path.join(apiWt, "hooked"))).toBe(true)
            expect(fs.existsSync(path.join(webWt, "hooked"))).toBe(false)
            // Clean up web's in-progress rebase so afterEach can remove it.
            await sh(webWt, "rebase", "--abort")
        })

        it("does not run hooks under --no-hooks", async () => {
            await makeSource("api")
            await registerWithHooks(["api"], { "post-sync": "touch hooked" })
            const wt = await openWorktree("api", "alpha")
            await commitWork(wt)
            await advanceUpstream("api", "u.txt", "up\n")

            const json = await captureJson<SyncJson>(async () => {
                await sync.run({
                    task: "alpha",
                    from: undefined,
                    "no-hooks": true,
                    check: false
                })
            })
            // Rebased, but the hook was suppressed.
            expect(json.repos).toEqual([
                { name: "api", status: "rebased", base: "origin/main" }
            ])
            expect(json.hooks).toEqual([])
            expect(fs.existsSync(path.join(wt, "hooked"))).toBe(false)
        })

        it("continues past a failing hook and exits non-zero, leaving the rebase landed", async () => {
            await makeSource("api")
            await makeSource("web")
            await registerWithHooks(["api", "web"], {
                // api's hook fails; web's still runs (both rebase cleanly).
                "post-sync": 'test "$UBEREPO_REPO" = api && exit 1 || touch ok'
            })
            const apiWt = await openWorktree("api", "alpha")
            const webWt = await openWorktree("web", "alpha")
            await commitWork(apiWt)
            await commitWork(webWt)
            const apiTip = await advanceUpstream("api", "u.txt", "api up\n")
            await advanceUpstream("web", "u.txt", "web up\n")

            const previousExit = process.exitCode
            process.exitCode = undefined
            let json: SyncJson
            try {
                json = await captureJson<SyncJson>(async () => {
                    await sync.run({
                        task: "alpha",
                        from: undefined,
                        "no-hooks": false,
                        check: false
                    })
                })
                expect(process.exitCode).toBe(1)
            } finally {
                process.exitCode = previousExit
            }
            // Both repos rebased (no rollback): api's new upstream is reachable.
            expect(json.repos).toEqual([
                { name: "api", status: "rebased", base: "origin/main" },
                { name: "web", status: "rebased", base: "origin/main" }
            ])
            expect(await reachable("api", "alpha", apiTip)).toBe(true)
            // The loop continued: web's hook ran after api's failure.
            expect(json.hooks).toEqual([
                { event: "post-sync", repo: "api", exit: 1 },
                { event: "post-sync", repo: "web", exit: 0 }
            ])
            expect(fs.existsSync(path.join(webWt, "ok"))).toBe(true)
        })

        it("pre-sync failure skips that repo, continues to the rest, and exits non-zero", async () => {
            await makeSource("api")
            await makeSource("web")
            await registerWithHooks(["api", "web"], {
                // api's gate fails; web's passes and its rebase proceeds.
                "pre-sync": 'test "$UBEREPO_REPO" != api'
            })
            const apiWt = await openWorktree("api", "alpha")
            const webWt = await openWorktree("web", "alpha")
            await commitWork(apiWt)
            await commitWork(webWt)
            const apiTip = await advanceUpstream("api", "u.txt", "api up\n")
            const webTip = await advanceUpstream("web", "u.txt", "web up\n")

            const previousExit = process.exitCode
            process.exitCode = undefined
            let json: SyncJson
            try {
                json = await captureJson<SyncJson>(async () => {
                    await sync.run({
                        task: "alpha",
                        from: undefined,
                        "no-hooks": false,
                        check: false
                    })
                })
                expect(process.exitCode).toBe(1)
            } finally {
                process.exitCode = previousExit
            }
            // api's rebase never ran (the gate held, its worktree untouched);
            // web's did, and the run CONTINUED past the failed gate.
            expect(json.repos).toEqual([
                {
                    name: "api",
                    status: "skipped",
                    reason: "pre-sync hook failed",
                    base: "origin/main"
                },
                { name: "web", status: "rebased", base: "origin/main" }
            ])
            expect(json.hooks).toEqual([
                { event: "pre-sync", repo: "api", exit: 1 },
                { event: "pre-sync", repo: "web", exit: 0 }
            ])
            expect(await reachable("api", "alpha", apiTip)).toBe(false)
            expect(await reachable("web", "alpha", webTip)).toBe(true)
        })
    })

    describe("carry", () => {
        // Register flat names plus carry patterns (and optionally hooks). The
        // carried fixtures are gitignored: a carried file that is NOT ignored
        // would count as untracked and trip sync's dirty pre-flight, exactly
        // like a hand-created one.
        const registerWithCarry = async (
            names: string[],
            carry: string[],
            hooks?: Record<string, string>
        ): Promise<void> => {
            await fsp.writeFile(
                configPath,
                `${JSON.stringify(
                    {
                        repositories: names.map(
                            (n) => `https://github.com/acme/${n}.git`
                        ),
                        carry,
                        ...(hooks ? { hooks } : {})
                    },
                    null,
                    4
                )}\n`
            )
        }

        // Commit a .gitignore on main (and push it upstream) BEFORE the
        // worktree opens, so the carried files stay ignored everywhere.
        const ignore = async (name: string, lines: string[]): Promise<void> => {
            const dir = path.join(root, "source", name)
            await fsp.writeFile(
                path.join(dir, ".gitignore"),
                `${lines.join("\n")}\n`
            )
            await sh(dir, "add", ".gitignore")
            await sh(dir, "commit", "-m", "ignore local files")
            await sh(dir, "push", "origin", "main")
        }

        it("re-copies missing carried files and never overwrites existing ones", async () => {
            await makeSource("api")
            await ignore("api", [".env", ".env.local"])
            await registerWithCarry(["api"], [".env*"])
            const source = path.join(root, "source", "api")
            await fsp.writeFile(path.join(source, ".env"), "FROM_SOURCE\n")
            await fsp.writeFile(path.join(source, ".env.local"), "LOCAL\n")
            const wt = await openWorktree("api", "alpha")
            // The worktree is missing .env entirely and carries its own edit
            // of .env.local — sync must repair the former, keep the latter.
            await fsp.writeFile(path.join(wt, ".env.local"), "EDITED\n")

            const json = await captureJson<SyncJson>(async () => {
                await sync.run({
                    task: "alpha",
                    from: undefined,
                    "no-hooks": false,
                    check: false
                })
            })

            expect(json.repos).toEqual([
                { name: "api", status: "rebased", base: "origin/main" }
            ])
            expect(await fsp.readFile(path.join(wt, ".env"), "utf8")).toBe(
                "FROM_SOURCE\n"
            )
            expect(
                await fsp.readFile(path.join(wt, ".env.local"), "utf8")
            ).toBe("EDITED\n")
            expect(json.carry).toEqual([
                {
                    repo: "api",
                    copied: [".env"],
                    keptExisting: [".env.local"],
                    skippedTracked: []
                }
            ])
        })

        it("carries BEFORE the post-sync hook fires, so the hook sees the files", async () => {
            await makeSource("api")
            await ignore("api", [".env", "env-seen-by-hook"])
            await registerWithCarry(["api"], [".env"], {
                "post-sync": "cp .env env-seen-by-hook"
            })
            await fsp.writeFile(
                path.join(root, "source", "api", ".env"),
                "SECRET=1\n"
            )
            const wt = await openWorktree("api", "alpha")

            const json = await captureJson<SyncJson>(async () => {
                await sync.run({
                    task: "alpha",
                    from: undefined,
                    "no-hooks": false,
                    check: false
                })
            })

            expect(json.hooks).toEqual([
                { event: "post-sync", repo: "api", exit: 0 }
            ])
            expect(
                await fsp.readFile(path.join(wt, "env-seen-by-hook"), "utf8")
            ).toBe("SECRET=1\n")
        })
    })

    type CheckJson = {
        task: string
        onto: string
        check: boolean
        repos: {
            name: string
            status: string
            files?: string[]
            reason?: string
            base?: string
        }[]
    }

    describe("--check", () => {
        // Run sync in forecast mode against `task` and return its JSON.
        const runCheck = (task: string, from?: string): Promise<CheckJson> =>
            captureJson<CheckJson>(async () => {
                await sync.run({
                    task,
                    from,
                    "no-hooks": false,
                    check: true
                })
            })

        // Give a task branch a local commit so the tips actually diverge.
        const commitWork = async (
            wt: string,
            file = "work.txt",
            contents = "work\n"
        ): Promise<void> => {
            await fsp.writeFile(path.join(wt, file), contents)
            await sh(wt, "add", file)
            await sh(wt, "commit", "-m", `task work: ${file}`)
        }

        it("forecasts clean, fetches, and mutates nothing else — no rebase, no hooks", async () => {
            await makeSource("api")
            // Hooks are registered but must NOT fire: a forecast is not the
            // lifecycle op.
            await registerWithHooks(["api"], {
                "pre-sync": "touch pre-hooked",
                "post-sync": "touch post-hooked"
            })
            const wt = await openWorktree("api", "alpha")
            await commitWork(wt)
            const before = await branchSha("api", "alpha")
            const tip = await advanceUpstream("api", "upstream.txt", "up\n")

            const json = await runCheck("alpha")

            expect(json).toEqual({
                task: "alpha",
                onto: "origin/main",
                check: true,
                repos: [{ name: "api", status: "clean" }]
            })
            const source = path.join(root, "source", "api")
            // The forecast DID fetch: origin/main now points at the new tip...
            expect(await sh(source, "rev-parse", "origin/main")).toBe(tip)
            // ...but nothing was rebased: branch tip unchanged, upstream work
            // not folded in, no rebase left in progress.
            expect(await branchSha("api", "alpha")).toBe(before)
            expect(await reachable("api", "alpha", tip)).toBe(false)
            expect(await rebaseInProgress(wt)).toBe(false)
            // And neither hook fired.
            expect(fs.existsSync(path.join(wt, "pre-hooked"))).toBe(false)
            expect(fs.existsSync(path.join(wt, "post-hooked"))).toBe(false)
        })

        it("forecasts conflicts with the conflicting files, leaving the worktree untouched and exiting 0", async () => {
            await makeSource("api")
            await register(["api"])
            const wt = await openWorktree("api", "alpha")
            // Upstream and the task branch edit the same line of README.md.
            await advanceUpstream("api", "README.md", "from upstream\n")
            await commitWork(wt, "README.md", "from task\n")
            const before = await branchSha("api", "alpha")

            const previousExit = process.exitCode
            process.exitCode = undefined
            let json: CheckJson
            try {
                json = await runCheck("alpha")
                // A forecast that finds conflicts did its job — exit stays 0.
                expect(process.exitCode).toBeUndefined()
            } finally {
                process.exitCode = previousExit
            }

            expect(json).toEqual({
                task: "alpha",
                onto: "origin/main",
                check: true,
                repos: [
                    {
                        name: "api",
                        status: "conflicts",
                        files: ["README.md"]
                    }
                ]
            })
            // Forecast only: no mid-rebase state, branch tip unchanged.
            expect(await rebaseInProgress(wt)).toBe(false)
            expect(await branchSha("api", "alpha")).toBe(before)

            // The human view: a forecast heading, the status line, and the
            // conflicting file indented beneath it.
            const { logs } = await captureOutput(async () => {
                await sync.run({
                    task: "alpha",
                    from: undefined,
                    "no-hooks": false,
                    check: true
                })
            })
            expect(logs[0]).toBe("alpha  vs origin/main  (forecast)")
            expect(logs[1]).toContain("api")
            expect(logs[1]).toContain("conflicts — 1 likely conflicted file")
            expect(logs[2]).toBe("    README.md")
        })

        it("reports current when the target brought nothing new — even with local commits", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])
            await openWorktree("api", "alpha")
            const webWt = await openWorktree("web", "alpha")
            // api: branch == origin/main exactly. web: local commits, upstream
            // quiet — the target is already contained, a rebase would no-op.
            await commitWork(webWt)

            const json = await runCheck("alpha")
            expect(json.repos).toEqual([
                { name: "api", status: "current" },
                { name: "web", status: "current" }
            ])
        })

        it("reports clean (not current) when sync would fast-forward a branch with no own commits", async () => {
            await makeSource("api")
            await register(["api"])
            await openWorktree("api", "alpha")
            // Upstream advanced, the task branch carries nothing of its own:
            // sync WOULD move the branch (a fast-forward), so this is not
            // "current" — it is a conflict-free rebase.
            await advanceUpstream("api", "upstream.txt", "up\n")

            const json = await runCheck("alpha")
            expect(json.repos).toEqual([{ name: "api", status: "clean" }])
        })

        it("never refuses: flags the dirty repo (with its tip-level conflicts) and still forecasts the rest", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])
            const apiWt = await openWorktree("api", "alpha")
            const webWt = await openWorktree("web", "alpha")
            // api: committed conflict at the tips PLUS uncommitted noise on
            // top — real sync would refuse the whole run here.
            await advanceUpstream("api", "README.md", "from upstream\n")
            await commitWork(apiWt, "README.md", "from task\n")
            await fsp.writeFile(path.join(apiWt, "noise.txt"), "uncommitted\n")
            // web: clean divergence.
            await commitWork(webWt)
            await advanceUpstream("web", "upstream.txt", "up\n")

            const json = await runCheck("alpha")
            expect(json.repos).toEqual([
                // dirty wins the status; the tip-level forecast still ran and
                // carries what the rebase would hit once committed/stashed.
                { name: "api", status: "dirty", files: ["README.md"] },
                { name: "web", status: "clean" }
            ])
        })

        it("flags a dirty repo without conflicts as dirty alone (no files key)", async () => {
            await makeSource("api")
            await register(["api"])
            const wt = await openWorktree("api", "alpha")
            await fsp.writeFile(path.join(wt, "noise.txt"), "uncommitted\n")

            const json = await runCheck("alpha")
            expect(json.repos).toEqual([{ name: "api", status: "dirty" }])

            const { logs } = await captureOutput(async () => {
                await sync.run({
                    task: "alpha",
                    from: undefined,
                    "no-hooks": false,
                    check: true
                })
            })
            expect(logs.find((l) => l.includes("api"))).toContain(
                "dirty — uncommitted changes; sync would refuse"
            )
        })

        it("reports a scoped repo with no worktree as skipped, like diff", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])
            await openWorktree("api", "alpha")
            // web is in the scope but was never opened.
            await writeScope("alpha", ["api", "web"])

            const json = await runCheck("alpha")
            expect(json.repos).toEqual([
                { name: "api", status: "current" },
                { name: "web", status: "skipped", reason: "no worktree" }
            ])
        })

        it("warns about a stray worktree outside the scope and leaves it out of the forecast", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])
            await openWorktree("api", "alpha")
            await openWorktree("web", "alpha")
            await writeScope("alpha", ["api"])

            let json: CheckJson | undefined
            const { warnings } = await captureOutput(async () => {
                json = await runCheck("alpha")
            })
            expect(json?.repos.map((r) => r.name)).toEqual(["api"])
            expect(warnings.join("\n")).toContain(
                "web: worktree outside task scope"
            )
        })

        it("reports a vanished task branch as skipped", async () => {
            await makeSource("api")
            await register(["api"])
            const wt = await openWorktree("api", "alpha")
            await sh(wt, "checkout", "--detach")
            await sh(
                path.join(root, "source", "api"),
                "branch",
                "-D",
                "task/alpha"
            )

            const json = await runCheck("alpha")
            expect(json.repos).toEqual([
                { name: "api", status: "skipped", reason: "branch missing" }
            ])
        })

        it("skips a repo without a resolvable origin default and CONTINUES — unlike the real sync", async () => {
            // "api" sorts first, so its skip must not stop web's forecast.
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])
            await openWorktree("api", "alpha")
            const webWt = await openWorktree("web", "alpha")
            await commitWork(webWt)
            await dropOrigin("api")

            const json = await runCheck("alpha")
            expect(json.repos).toEqual([
                {
                    name: "api",
                    status: "skipped",
                    reason: "cannot resolve origin's default branch"
                },
                { name: "web", status: "current" }
            ])
        })

        it("--from forecasts against the given ref and names it as onto", async () => {
            await makeSource("api")
            await register(["api"])
            const wt = await openWorktree("api", "alpha")
            const source = path.join(root, "source", "api")
            // A feature branch whose work.txt collides with the task's; the
            // origin default never moves, so the default forecast is clean.
            await sh(source, "branch", "feature", "main")
            await sh(source, "switch", "feature")
            await fsp.writeFile(path.join(source, "work.txt"), "feature\n")
            await sh(source, "add", "work.txt")
            await sh(source, "commit", "-m", "feature work")
            await sh(source, "switch", "main")
            await commitWork(wt, "work.txt", "task\n")

            const versus = await runCheck("alpha")
            expect(versus.onto).toBe("origin/main")
            // vs the quiet origin default the branch is simply ahead: current.
            expect(versus.repos).toEqual([{ name: "api", status: "current" }])

            const json = await runCheck("alpha", "feature")
            expect(json).toEqual({
                task: "alpha",
                onto: "feature",
                check: true,
                repos: [
                    {
                        name: "api",
                        status: "conflicts",
                        files: ["work.txt"]
                    }
                ]
            })
        })

        it("emits empty repos and warns when the task is not open", async () => {
            await makeSource("api")
            await register(["api"])

            let json: CheckJson | undefined
            const { warnings } = await captureOutput(async () => {
                json = await runCheck("ghost")
            })
            expect(json).toEqual({
                task: "ghost",
                onto: "",
                check: true,
                repos: []
            })
            expect(warnings.join("\n")).toContain("ghost")
        })

        it("errors up front on git older than 2.38 instead of degrading", async () => {
            await makeSource("api")
            await register(["api"])
            await openWorktree("api", "alpha")
            vi.spyOn(git, "version").mockResolvedValue("2.37.2")

            await expect(
                sync.run({
                    task: "alpha",
                    from: undefined,
                    "no-hooks": false,
                    check: true
                })
            ).rejects.toThrow("sync --check needs git >= 2.38, found 2.37.2")
        })

        it("passes the gate exactly at 2.38", async () => {
            await makeSource("api")
            await register(["api"])
            await openWorktree("api", "alpha")
            vi.spyOn(git, "version").mockResolvedValue("2.38.0")

            const json = await runCheck("alpha")
            expect(json.repos).toEqual([{ name: "api", status: "current" }])
        })

        it("forecasts a STACKED child against its parent's CURRENT tip (approximate), naming the parent as base", async () => {
            await makeSource("autopilot")
            await register(["autopilot"])
            const source = path.join(root, "source", "autopilot")
            // strings (root) with its own commit; logos (child) off strings,
            // editing the SAME file strings will — a tip-level merge-tree
            // against the parent's current tip forecasts a conflict.
            const stringsWt = path.join(
                root,
                "tasks",
                "alpha",
                "autopilot@strings"
            )
            await sh(
                source,
                "worktree",
                "add",
                "-b",
                "task/alpha@strings",
                stringsWt,
                "main"
            )
            await fsp.writeFile(path.join(stringsWt, "shared.txt"), "strings\n")
            await sh(stringsWt, "add", "shared.txt")
            await sh(stringsWt, "commit", "-m", "strings work")
            const logosWt = path.join(root, "tasks", "alpha", "autopilot@logos")
            await sh(
                source,
                "worktree",
                "add",
                "-b",
                "task/alpha@logos",
                logosWt,
                "main"
            )
            // logos branched off MAIN (not strings) and edits shared.txt too, so
            // its tip conflicts with strings' tip at shared.txt.
            await fsp.writeFile(path.join(logosWt, "shared.txt"), "logos\n")
            await sh(logosWt, "add", "shared.txt")
            await sh(logosWt, "commit", "-m", "logos work")
            await fsp.writeFile(
                path.join(root, "tasks", "alpha", "ubertask.yml"),
                [
                    "goal: |",
                    "  stacked",
                    "",
                    "repos:",
                    "  - autopilot@strings",
                    "  - autopilot@logos",
                    "",
                    "branches:",
                    "  autopilot@logos:",
                    "    name: task/alpha@logos",
                    "    adopted: false",
                    "    base: autopilot@strings",
                    ""
                ].join("\n")
            )

            const json = await runCheck("alpha")
            // The root forecasts against origin/main (names the run onto) and is
            // simply ahead of the quiet upstream → current; the child forecasts
            // against its PARENT's branch (its own `base`), and the shared-file
            // collision shows up as a likely conflict.
            expect(json.onto).toBe("origin/main")
            expect(json.repos).toEqual([
                {
                    name: "autopilot@logos",
                    status: "conflicts",
                    files: ["shared.txt"],
                    base: "task/alpha@strings"
                },
                { name: "autopilot@strings", status: "current" }
            ])
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

        it("rebases EACH participant of one repo onto the advanced default, sharing the source", async () => {
            await makeSource("autopilot")
            await register(["autopilot"])
            const bugFix = await openAliased("autopilot", "alpha", "bug-fix")
            const addFeat = await openAliased(
                "autopilot",
                "alpha",
                "add-feature"
            )
            // Each participant gets its own local commit so a real replay runs.
            for (const wt of [bugFix, addFeat]) {
                await fsp.writeFile(path.join(wt, "work.txt"), `${wt}\n`)
                await sh(wt, "add", "work.txt")
                await sh(wt, "commit", "-m", "participant work")
            }
            await writeScope("alpha", [
                "autopilot@bug-fix",
                "autopilot@add-feature"
            ])
            // Others advanced the SHARED upstream's main.
            const tip = await advanceUpstream("autopilot", "up.txt", "x\n")

            const json = await captureJson<{
                repos: { name: string; status: string }[]
            }>(async () => {
                await sync.run({
                    task: "alpha",
                    from: undefined,
                    "no-hooks": false,
                    check: false
                })
            })

            // Both participants rebased (per-participant), each branch now
            // carrying the advanced upstream tip.
            expect(json.repos).toEqual([
                {
                    name: "autopilot@add-feature",
                    status: "rebased",
                    base: "origin/main"
                },
                {
                    name: "autopilot@bug-fix",
                    status: "rebased",
                    base: "origin/main"
                }
            ])
            const source = path.join(root, "source", "autopilot")
            for (const branch of [
                "task/alpha@bug-fix",
                "task/alpha@add-feature"
            ]) {
                await sh(source, "merge-base", "--is-ancestor", tip, branch)
            }
        })

        // ── Phase 3 stacked-PR auto-restack ───────────────────────────────────
        // Build a `main ← P ← C` stack in `source/<repo>` for task `alpha`:
        // root participant <root> with one commit, child participant <child>
        // branched off the root's branch with its own commit, and a note
        // declaring child.base = <repo>@<root>. Returns the two worktree paths
        // and the source dir.
        const openStack = async (
            repo: string,
            opts: { root: string; child: string; grandchild?: string }
        ): Promise<{
            source: string
            rootWt: string
            childWt: string
            grandchildWt?: string
        }> => {
            const source = path.join(root, "source", repo)
            const rootWt = await openAliased(repo, "alpha", opts.root)
            await fsp.writeFile(
                path.join(rootWt, `${opts.root}.txt`),
                `${opts.root}\n`
            )
            await sh(rootWt, "add", `${opts.root}.txt`)
            await sh(rootWt, "commit", "-m", `${opts.root} work`)

            const childWt = path.join(
                root,
                "tasks",
                "alpha",
                `${repo}@${opts.child}`
            )
            await sh(
                source,
                "worktree",
                "add",
                "-b",
                `task/alpha@${opts.child}`,
                childWt,
                `task/alpha@${opts.root}`
            )
            await fsp.writeFile(
                path.join(childWt, `${opts.child}.txt`),
                `${opts.child}\n`
            )
            await sh(childWt, "add", `${opts.child}.txt`)
            await sh(childWt, "commit", "-m", `${opts.child} work`)

            let grandchildWt: string | undefined
            const lines = [
                "goal: |",
                "  stacked",
                "",
                "repos:",
                `  - ${repo}@${opts.root}`,
                `  - ${repo}@${opts.child}`
            ]
            const branches = [
                "",
                "branches:",
                `  ${repo}@${opts.child}:`,
                `    name: task/alpha@${opts.child}`,
                "    adopted: false",
                `    base: ${repo}@${opts.root}`
            ]
            if (opts.grandchild !== undefined) {
                grandchildWt = path.join(
                    root,
                    "tasks",
                    "alpha",
                    `${repo}@${opts.grandchild}`
                )
                await sh(
                    source,
                    "worktree",
                    "add",
                    "-b",
                    `task/alpha@${opts.grandchild}`,
                    grandchildWt,
                    `task/alpha@${opts.child}`
                )
                await fsp.writeFile(
                    path.join(grandchildWt, `${opts.grandchild}.txt`),
                    `${opts.grandchild}\n`
                )
                await sh(grandchildWt, "add", `${opts.grandchild}.txt`)
                await sh(
                    grandchildWt,
                    "commit",
                    "-m",
                    `${opts.grandchild} work`
                )
                lines.push(`  - ${repo}@${opts.grandchild}`)
                branches.push(
                    `  ${repo}@${opts.grandchild}:`,
                    `    name: task/alpha@${opts.grandchild}`,
                    "    adopted: false",
                    `    base: ${repo}@${opts.child}`
                )
            }
            await fsp.mkdir(path.join(root, "tasks", "alpha"), {
                recursive: true
            })
            await fsp.writeFile(
                path.join(root, "tasks", "alpha", "ubertask.yml"),
                `${[...lines, ...branches].join("\n")}\n`
            )
            return { source, rootWt, childWt, grandchildWt }
        }

        // The sha a named branch points at, in source/<repo>.
        const sha = (repo: string, branch: string): Promise<string> =>
            sh(path.join(root, "source", repo), "rev-parse", branch)

        // The persisted restack fork-point ref for a child participant.
        const restackRef = (child: string): string =>
            `refs/uberepo/restack/alpha/autopilot@${child}`

        // True when the restack ref for `child` currently exists.
        const restackRefExists = async (child: string): Promise<boolean> => {
            const source = path.join(root, "source", "autopilot")
            try {
                await sh(
                    source,
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    restackRef(child)
                )
                return true
            } catch {
                return false
            }
        }

        // The subjects of a branch's commits, newest first (for asserting that a
        // restacked child carries ONLY its own commit, not the parent's twice).
        const subjects = async (
            repo: string,
            branch: string
        ): Promise<string[]> => {
            const out = await sh(
                path.join(root, "source", repo),
                "log",
                "--format=%s",
                branch
            )
            return out.split("\n").filter((l) => l !== "")
        }

        it("happy path: P rebases onto fresh main and C restacks onto P's NEW tip with only its own commit", async () => {
            await makeSource("autopilot")
            await register(["autopilot"])
            const { source } = await openStack("autopilot", {
                root: "strings",
                child: "logos"
            })
            // Others advanced the shared upstream's main.
            const tip = await advanceUpstream("autopilot", "up.txt", "x\n")

            const json = await captureJson<{
                repos: { name: string; status: string; base?: string }[]
            }>(async () => {
                await sync.run({
                    task: "alpha",
                    from: undefined,
                    "no-hooks": false,
                    check: false
                })
            })

            // Parent rebased onto origin/main; child restacked onto the PARENT's
            // branch — topological order puts the parent (strings) first.
            expect(json.repos).toEqual([
                {
                    name: "autopilot@strings",
                    status: "rebased",
                    base: "origin/main"
                },
                {
                    name: "autopilot@logos",
                    status: "rebased",
                    base: "task/alpha@strings"
                }
            ])
            // The advanced main is now reachable from the parent...
            await sh(
                source,
                "merge-base",
                "--is-ancestor",
                tip,
                "task/alpha@strings"
            )
            // ...and, through the restack, from the child too.
            await sh(
                source,
                "merge-base",
                "--is-ancestor",
                tip,
                "task/alpha@logos"
            )
            // The child's parent IS the parent's new tip — it sits directly on
            // top of P-new, no flatten onto main.
            const stringsTip = await sha("autopilot", "task/alpha@strings")
            const logosParent = await sha("autopilot", "task/alpha@logos^")
            expect(logosParent).toBe(stringsTip)
            // The child carries ONLY its own commit beyond the parent: the
            // commits in parent..child are EXACTLY ["logos work"], and the
            // parent's "strings work" appears exactly once in the full history
            // (P's, reached through the parent — never duplicated into C).
            const own = await sh(
                source,
                "log",
                "--format=%s",
                "task/alpha@strings..task/alpha@logos"
            )
            expect(own.split("\n").filter((l) => l !== "")).toEqual([
                "logos work"
            ])
            const log = await subjects("autopilot", "task/alpha@logos")
            expect(log[0]).toBe("logos work")
            expect(log.filter((s) => s === "strings work")).toHaveLength(1)
            expect(log.filter((s) => s === "logos work")).toHaveLength(1)
            // A clean run leaves NO persisted restack refs behind.
            expect(await restackRefExists("logos")).toBe(false)
        })

        it("Decision A independence: repoA's stack root conflicts (subtree pruned) while repoB's independent root still rebases", async () => {
            await makeSource("autopilot")
            await makeSource("web")
            await register(["autopilot", "web"])
            // repoA (autopilot): a stack whose ROOT conflicts on README.md.
            await openStack("autopilot", {
                root: "strings",
                child: "logos"
            })
            // Make the root's branch edit README.md, and advance autopilot's
            // upstream README.md differently → the root's rebase conflicts.
            const stringsWt = path.join(
                root,
                "tasks",
                "alpha",
                "autopilot@strings"
            )
            await fsp.writeFile(
                path.join(stringsWt, "README.md"),
                "from strings\n"
            )
            await sh(stringsWt, "add", "README.md")
            await sh(stringsWt, "commit", "-m", "strings edits readme")
            await advanceUpstream("autopilot", "README.md", "from upstream\n")

            // repoB (web): an INDEPENDENT root that rebases cleanly.
            const webWt = await openWorktree("web", "alpha")
            await fsp.writeFile(path.join(webWt, "work.txt"), "web work\n")
            await sh(webWt, "add", "work.txt")
            await sh(webWt, "commit", "-m", "web task work")
            const webTip = await advanceUpstream("web", "u.txt", "web\n")
            // web is registered+present but NOT in the (autopilot-only) scope —
            // widen scope to include it so it's a real independent root here.
            await fsp.writeFile(
                path.join(root, "tasks", "alpha", "ubertask.yml"),
                [
                    "goal: |",
                    "  stacked",
                    "",
                    "repos:",
                    "  - autopilot@strings",
                    "  - autopilot@logos",
                    "  - web",
                    "",
                    "branches:",
                    "  autopilot@logos:",
                    "    name: task/alpha@logos",
                    "    adopted: false",
                    "    base: autopilot@strings",
                    ""
                ].join("\n")
            )
            const logosBefore = await sha("autopilot", "task/alpha@logos")

            const previousExit = process.exitCode
            process.exitCode = undefined
            let json: {
                repos: { name: string; status: string; reason?: string }[]
            }
            try {
                json = await captureJson(async () => {
                    await sync.run({
                        task: "alpha",
                        from: undefined,
                        "no-hooks": false,
                        check: false
                    })
                })
                expect(process.exitCode).toBe(1)
            } finally {
                process.exitCode = previousExit
            }

            // autopilot's root conflicts; its child is pruned "parent not
            // synced"; web — an independent root — rebases regardless. (Order:
            // logos sorts before strings, but the walk emits the parent first.)
            expect(json.repos).toEqual([
                {
                    name: "autopilot@strings",
                    status: "conflict",
                    base: "origin/main"
                },
                {
                    name: "autopilot@logos",
                    status: "skipped",
                    reason: "parent not synced",
                    base: "task/alpha@strings"
                },
                { name: "web", status: "rebased", base: "origin/main" }
            ])
            // web really took its advanced tip — NOT held back by autopilot.
            expect(await reachable("web", "alpha", webTip)).toBe(true)
            // The pruned child is untouched, and its fork-point ref is KEPT for
            // the resume (the root is mid-rebase).
            expect(await sha("autopilot", "task/alpha@logos")).toBe(logosBefore)
            expect(await restackRefExists("logos")).toBe(true)
            // Clean up the in-progress rebase so afterEach can remove the tree.
            const stringsWtPath = path.join(
                root,
                "tasks",
                "alpha",
                "autopilot@strings"
            )
            await sh(stringsWtPath, "rebase", "--abort")
        })

        it("resume correctness: P conflicts → C pruned + ref kept → user resolves P → re-run restacks C onto P-new with only its own commit", async () => {
            await makeSource("autopilot")
            await register(["autopilot"])
            const { source } = await openStack("autopilot", {
                root: "strings",
                child: "logos"
            })
            // Make the ROOT conflict: its branch edits README.md, upstream edits
            // it differently.
            const stringsWt = path.join(
                root,
                "tasks",
                "alpha",
                "autopilot@strings"
            )
            await fsp.writeFile(
                path.join(stringsWt, "README.md"),
                "from strings\n"
            )
            await sh(stringsWt, "add", "README.md")
            await sh(stringsWt, "commit", "-m", "strings edits readme")
            const tip = await advanceUpstream(
                "autopilot",
                "README.md",
                "from upstream\n"
            )
            const logosBefore = await sha("autopilot", "task/alpha@logos")
            // The fork point we expect the ref to pin: merge-base(logos, strings)
            // BEFORE strings moves — i.e. strings' tip at child-branch time.
            const forkExpected = await sha("autopilot", "task/alpha@logos^")

            // ── Run 1: the parent conflicts ──────────────────────────────────
            const prev1 = process.exitCode
            process.exitCode = undefined
            let json1: {
                repos: { name: string; status: string; reason?: string }[]
            }
            try {
                json1 = await captureJson(async () => {
                    await sync.run({
                        task: "alpha",
                        from: undefined,
                        "no-hooks": false,
                        check: false
                    })
                })
                expect(process.exitCode).toBe(1)
            } finally {
                process.exitCode = prev1
            }
            expect(json1.repos).toEqual([
                {
                    name: "autopilot@strings",
                    status: "conflict",
                    base: "origin/main"
                },
                {
                    name: "autopilot@logos",
                    status: "skipped",
                    reason: "parent not synced",
                    base: "task/alpha@strings"
                }
            ])
            // The child is untouched, and its ref is present, pinning the
            // PRE-MOVE fork point (so the resume replays only the child's work).
            expect(await sha("autopilot", "task/alpha@logos")).toBe(logosBefore)
            expect(await restackRefExists("logos")).toBe(true)
            expect(await sh(source, "rev-parse", restackRef("logos"))).toBe(
                forkExpected
            )

            // ── User resolves the parent's conflict and continues ─────────────
            // Take upstream's README, keep strings' own commit.
            await fsp.writeFile(
                path.join(stringsWt, "README.md"),
                "from upstream\n"
            )
            await sh(stringsWt, "add", "README.md")
            await sh(
                stringsWt,
                "-c",
                "core.editor=true",
                "rebase",
                "--continue"
            )
            // Parent now contains the advanced main.
            await sh(
                source,
                "merge-base",
                "--is-ancestor",
                tip,
                "task/alpha@strings"
            )

            // ── Run 2: the resume — child restacks onto P-new ─────────────────
            const json2 = await captureJson<{
                repos: { name: string; status: string; base?: string }[]
            }>(async () => {
                await sync.run({
                    task: "alpha",
                    from: undefined,
                    "no-hooks": false,
                    check: false
                })
            })
            // The parent's rebase onto origin/main is now a no-op (its finished
            // rebase already contains main) but still reports `rebased` — the
            // root path always rebases, it does not short-circuit. The CHILD
            // restacks onto the parent's new tip using the preserved ref.
            expect(json2.repos).toEqual([
                {
                    name: "autopilot@strings",
                    status: "rebased",
                    base: "origin/main"
                },
                {
                    name: "autopilot@logos",
                    status: "rebased",
                    base: "task/alpha@strings"
                }
            ])
            // The child now sits on the parent's NEW tip...
            const stringsTip = await sha("autopilot", "task/alpha@strings")
            expect(await sha("autopilot", "task/alpha@logos^")).toBe(stringsTip)
            // ...the advanced main is reachable from it...
            await sh(
                source,
                "merge-base",
                "--is-ancestor",
                tip,
                "task/alpha@logos"
            )
            // ...and it carries ONLY its own commit — strings' commits are NOT
            // replayed into it (the resume hazard the persisted ref prevents).
            // The commits in parent..child are EXACTLY the child's own: a single
            // "logos work". If a fresh merge-base had been used instead of the
            // saved fork point, the parent's commits would be replayed here and
            // this set would be larger.
            const own = await sh(
                source,
                "log",
                "--format=%s",
                "task/alpha@strings..task/alpha@logos"
            )
            expect(own.split("\n").filter((l) => l !== "")).toEqual([
                "logos work"
            ])
            // The full child history still contains the parent's "strings work"
            // exactly once (P's commit, reached through the parent — never
            // duplicated into C) and the child's own commit once.
            const log = await subjects("autopilot", "task/alpha@logos")
            expect(log.filter((s) => s === "logos work")).toHaveLength(1)
            expect(log.filter((s) => s === "strings work")).toHaveLength(1)
            // The refs are cleaned up now the run finished clean.
            expect(await restackRefExists("logos")).toBe(false)
        })

        it("multi-level prune: P conflicts → both C and G are skipped 'parent not synced'", async () => {
            await makeSource("autopilot")
            await register(["autopilot"])
            await openStack("autopilot", {
                root: "p",
                child: "c",
                grandchild: "g"
            })
            // Make the root (p) conflict on README.md.
            const pWt = path.join(root, "tasks", "alpha", "autopilot@p")
            await fsp.writeFile(path.join(pWt, "README.md"), "from p\n")
            await sh(pWt, "add", "README.md")
            await sh(pWt, "commit", "-m", "p edits readme")
            await advanceUpstream("autopilot", "README.md", "from upstream\n")

            const previousExit = process.exitCode
            process.exitCode = undefined
            let json: {
                repos: { name: string; status: string; reason?: string }[]
            }
            try {
                json = await captureJson(async () => {
                    await sync.run({
                        task: "alpha",
                        from: undefined,
                        "no-hooks": false,
                        check: false
                    })
                })
                expect(process.exitCode).toBe(1)
            } finally {
                process.exitCode = previousExit
            }
            // p conflicts; c AND g (its transitive descendant) both prune.
            expect(json.repos).toEqual([
                {
                    name: "autopilot@p",
                    status: "conflict",
                    base: "origin/main"
                },
                {
                    name: "autopilot@c",
                    status: "skipped",
                    reason: "parent not synced",
                    base: "task/alpha@p"
                },
                {
                    name: "autopilot@g",
                    status: "skipped",
                    reason: "parent not synced",
                    base: "task/alpha@c"
                }
            ])
            // Both descendants' refs are kept for the resume.
            expect(await restackRefExists("c")).toBe(true)
            expect(await restackRefExists("g")).toBe(true)
            // Clean up the in-progress rebase.
            await sh(pWt, "rebase", "--abort")
        })

        it("up-to-date no-op: a re-run with no upstream change finds the child already restacked and cleans its ref", async () => {
            await makeSource("autopilot")
            await register(["autopilot"])
            await openStack("autopilot", {
                root: "strings",
                child: "logos"
            })
            await advanceUpstream("autopilot", "up.txt", "x\n")

            // First sync: restacks the child cleanly, clearing the ref.
            await captureJson(async () => {
                await sync.run({
                    task: "alpha",
                    from: undefined,
                    "no-hooks": false,
                    check: false
                })
            })
            expect(await restackRefExists("logos")).toBe(false)
            const logosAfterFirst = await sha("autopilot", "task/alpha@logos")

            // Second sync, NO upstream change: the child is already restacked on
            // the parent's (unmoved) tip → detected up-to-date, a clean no-op.
            const json = await captureJson<{
                repos: { name: string; status: string; base?: string }[]
            }>(async () => {
                await sync.run({
                    task: "alpha",
                    from: undefined,
                    "no-hooks": false,
                    check: false
                })
            })
            // The root's rebase onto the (unchanged) origin/main is a no-op but
            // still reports `rebased`; the CHILD is detected already-restacked
            // (its parent's tip is already contained) — a clean `current` no-op.
            expect(json.repos).toEqual([
                {
                    name: "autopilot@strings",
                    status: "rebased",
                    base: "origin/main"
                },
                {
                    name: "autopilot@logos",
                    status: "current",
                    base: "task/alpha@strings"
                }
            ])
            // The child's tip did not move on the no-op re-run, and no ref leaked.
            expect(await sha("autopilot", "task/alpha@logos")).toBe(
                logosAfterFirst
            )
            expect(await restackRefExists("logos")).toBe(false)
        })
    })
})
