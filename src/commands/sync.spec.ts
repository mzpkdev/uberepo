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
                "no-hooks": false
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
                "no-hooks": false
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
                "no-hooks": false
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
                "no-hooks": false
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

    it("conflict: stops at the first conflicting repo, leaving it mid-rebase, and skips the rest", async () => {
        // "api" sorts before "web", so api is processed first.
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

        // web would rebase cleanly (own file, advanced upstream) — but must be
        // left untouched because api stops the run first.
        const webWt = path.join(root, "tasks", "alpha", "web")
        await fsp.writeFile(path.join(webWt, "work.txt"), "web work\n")
        await sh(webWt, "add", "work.txt")
        await sh(webWt, "commit", "-m", "web task work")
        const webBefore = await branchSha("web", "alpha")
        const webTip = await advanceUpstream("web", "upstream.txt", "web\n")

        const { logs } = await captureOutput(async () => {
            await sync.run({
                task: "alpha",
                from: undefined,
                "no-hooks": false
            })
        })

        const joined = logs.join("\n")
        // Message names the repo and its path, and offers resolve/abort.
        expect(joined).toContain("api: rebase conflict")
        expect(joined).toContain(apiWt)
        expect(joined).toContain("git rebase --abort")
        // No success summary, and web was never synced.
        expect(joined).not.toContain("web: synced")
        expect(joined).not.toContain("Synced task")
        // api is left mid-rebase (the stop signal for the user).
        expect(await rebaseInProgress(apiWt)).toBe(true)
        // web is untouched: same branch tip, upstream NOT folded in.
        expect(await branchSha("web", "alpha")).toBe(webBefore)
        expect(await reachable("web", "alpha", webTip)).toBe(false)

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
                "no-hooks": false
            })
        })

        const joined = logs.join("\n")
        expect(joined).toContain(
            "api: cannot resolve origin's default branch — pass --from <ref>"
        )
        expect(joined).not.toContain("synced")
        expect(joined).not.toContain("Synced task")
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
                "no-hooks": false
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
                    "no-hooks": false
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
                    "no-hooks": false
                })
            })
            expect(json).toEqual({
                task: "alpha",
                onto: "origin/main",
                repos: [
                    { name: "api", status: "rebased" },
                    { name: "web", status: "rebased" }
                ],
                hooks: []
            })
        })

        it("emits the conflicting repo as conflict and later repos as skipped/not reached", async () => {
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
            // web would rebase cleanly but must never be reached.
            await fsp.writeFile(path.join(webWt, "work.txt"), "web work\n")
            await sh(webWt, "add", "work.txt")
            await sh(webWt, "commit", "-m", "web task work")
            await advanceUpstream("web", "u.txt", "web\n")

            const json = await captureJson<SyncJson>(async () => {
                await sync.run({
                    task: "alpha",
                    from: undefined,
                    "no-hooks": false
                })
            })
            expect(json).toEqual({
                task: "alpha",
                onto: "origin/main",
                repos: [
                    { name: "api", status: "conflict" },
                    { name: "web", status: "skipped", reason: "not reached" }
                ],
                hooks: []
            })
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
                    "no-hooks": false
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
                hooks: []
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
                    "no-hooks": false
                })
            })
            expect(json.onto).toBe("main")
            expect(json.repos).toEqual([{ name: "api", status: "rebased" }])
        })

        it("emits empty repos under --json when the task is not open", async () => {
            await makeSource("api")
            await register(["api"])

            const json = await captureJson<SyncJson>(async () => {
                await sync.run({
                    task: "ghost",
                    from: undefined,
                    "no-hooks": false
                })
            })
            expect(json).toEqual({
                task: "ghost",
                onto: "",
                repos: [],
                hooks: []
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
                    "no-hooks": false
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
                    "no-hooks": true
                })
            })
            // Rebased, but the hook was suppressed.
            expect(json.repos).toEqual([{ name: "api", status: "rebased" }])
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
                        "no-hooks": false
                    })
                })
                expect(process.exitCode).toBe(1)
            } finally {
                process.exitCode = previousExit
            }
            // Both repos rebased (no rollback): api's new upstream is reachable.
            expect(json.repos).toEqual([
                { name: "api", status: "rebased" },
                { name: "web", status: "rebased" }
            ])
            expect(await reachable("api", "alpha", apiTip)).toBe(true)
            // The loop continued: web's hook ran after api's failure.
            expect(json.hooks).toEqual([
                { event: "post-sync", repo: "api", exit: 1 },
                { event: "post-sync", repo: "web", exit: 0 }
            ])
            expect(fs.existsSync(path.join(webWt, "ok"))).toBe(true)
        })
    })
})
