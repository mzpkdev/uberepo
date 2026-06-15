import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { terminal } from "cmdore"
import { vi } from "vitest"
import close from "@/commands/close"
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
// restore them. close uses log for per-repo lines + summary and warn for the
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

describe("close command", () => {
    let tmp: string
    let root: string
    let cwd: string
    let configPath: string

    // Build a fresh uberepo workspace and chdir into it for each test. `root`
    // is the realpath of the workspace because macOS canonicalises /var ->
    // /private/var and git reports worktree paths under the realpath.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "close-spec-"))
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
    // origin/HEAD set to main. This makes the unmerged check meaningful: a task
    // branch is "merged" only while its tip is an ancestor of origin/main.
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
    // is merged into origin/main).
    const openWorktree = async (
        name: string,
        task: string
    ): Promise<string> => {
        const source = path.join(root, "source", name)
        const wt = path.join(root, "tasks", task, name)
        await sh(source, "worktree", "add", "-b", `task/${task}`, wt, "main")
        return wt
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
    // task owns), so close can be exercised against a scoped task.
    const writeScope = async (task: string, repos: string[]): Promise<void> => {
        const dir = path.join(root, "tasks", task)
        await fsp.mkdir(dir, { recursive: true })
        const list = repos.map((r) => `  - ${r}`).join("\n")
        await fsp.writeFile(
            path.join(dir, "ubertask.yml"),
            `goal: |\n  g\n\nrepos:\n${list}\n`
        )
    }

    // Open a worktree on a PRE-EXISTING branch `branch` (not task/<task>) and
    // record it as ADOPTED in the note — the data-loss case close must never
    // delete the branch for.
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
        await fsp.writeFile(
            path.join(dir, "ubertask.yml"),
            `goal: |\n  g\n\nbranches:\n  ${name}:\n    name: ${branch}\n    adopted: true\n`
        )
        return wt
    }

    // Whether the local branch `branch` still exists in source repo `name`.
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

    it("ADOPTED branch: removes the worktree but never deletes the branch", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await adoptWorktree("api", "alpha", "feature/login")

        const { logs } = await captureOutput(async () => {
            await close.run({ task: "alpha", force: false, "no-hooks": false })
        })

        // The worktree is gone, the task is closed — but the adopted branch
        // SURVIVES (never close's to delete), and the merged-check was moot.
        expect(fs.existsSync(wt)).toBe(false)
        expect(await namedBranchExists("api", "feature/login")).toBe(true)
        const joined = logs.join("\n")
        expect(joined).toContain("api: kept adopted branch feature/login")
        expect(joined).toContain("api: closed")
    })

    it("ADOPTED branch survives even an unmerged tip without --force", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await adoptWorktree("api", "alpha", "feature/login")
        // Commit on the adopted branch so its tip is NOT merged into origin/main
        // — a created branch here would be skipped as "unmerged commits", but an
        // adopted one closes (worktree removed) and keeps its branch.
        await fsp.writeFile(path.join(wt, "x.txt"), "work\n")
        await sh(wt, "add", "x.txt")
        await sh(wt, "commit", "-m", "adopted work")

        await captureOutput(async () => {
            await close.run({ task: "alpha", force: false, "no-hooks": false })
        })

        expect(fs.existsSync(wt)).toBe(false)
        expect(await namedBranchExists("api", "feature/login")).toBe(true)
    })

    it("closes a fully-merged task: removes every worktree and deletes the branch", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")

        const { logs } = await captureOutput(async () => {
            await close.run({ task: "alpha", force: false, "no-hooks": false })
        })

        for (const name of ["api", "web"]) {
            expect(fs.existsSync(taskDir("alpha", name))).toBe(false)
            expect(await branchExists(name, "alpha")).toBe(false)
        }
        const joined = logs.join("\n")
        expect(joined).toContain("api: closed")
        expect(joined).toContain("web: closed")
        expect(joined).toContain("Closed task alpha in 2 repositories")
    })

    it("respects a declared scope: closes in-scope repos and warns about a stray worktree", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")
        // Scope owns api only; web's worktree is drift.
        await writeScope("alpha", ["api"])

        const { logs, warnings } = await captureOutput(async () => {
            await close.run({ task: "alpha", force: false, "no-hooks": false })
        })

        // api (in scope) closed: worktree + branch gone.
        expect(fs.existsSync(taskDir("alpha", "api"))).toBe(false)
        expect(await branchExists("api", "alpha")).toBe(false)
        // web (the stray) left standing, with a warning.
        expect(fs.existsSync(taskDir("alpha", "web"))).toBe(true)
        expect(await branchExists("web", "alpha")).toBe(true)
        expect(warnings.join("\n")).toContain(
            "web: worktree outside task scope"
        )
        const joined = logs.join("\n")
        expect(joined).toContain("api: closed")
        expect(joined).not.toContain("web: closed")
        expect(joined).toContain("Closed task alpha in 1 repository")
    })

    it("without --force, skips a repo with uncommitted changes; --force closes it", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        // Uncommitted change in the worktree makes it dirty -> unsafe.
        await fsp.writeFile(path.join(wt, "README.md"), "uncommitted\n")

        const { logs } = await captureOutput(async () => {
            await close.run({ task: "alpha", force: false, "no-hooks": false })
        })

        // Skipped: worktree and branch both remain.
        expect(fs.existsSync(taskDir("alpha", "api"))).toBe(true)
        expect(await branchExists("api", "alpha")).toBe(true)
        const joined = logs.join("\n")
        expect(joined).toContain("api: uncommitted changes — use --force")
        expect(joined).toContain("Closed task alpha in 0 repositories")
        expect(joined).toContain("Skipped 1 repository")

        // --force closes the dirty repo regardless.
        const forced = await captureOutput(async () => {
            await close.run({ task: "alpha", force: true, "no-hooks": false })
        })
        expect(fs.existsSync(taskDir("alpha", "api"))).toBe(false)
        expect(await branchExists("api", "alpha")).toBe(false)
        expect(forced.logs.join("\n")).toContain("api: closed")
    })

    it("without --force, skips a repo whose task branch has unmerged commits; --force closes it", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        // A committed-but-unpushed change on the task branch: its tip is no
        // longer an ancestor of origin/main, so the branch is unmerged.
        await fsp.writeFile(path.join(wt, "feature.txt"), "work\n")
        await sh(wt, "add", "feature.txt")
        await sh(wt, "commit", "-m", "feature work")

        const { logs } = await captureOutput(async () => {
            await close.run({ task: "alpha", force: false, "no-hooks": false })
        })

        expect(fs.existsSync(taskDir("alpha", "api"))).toBe(true)
        expect(await branchExists("api", "alpha")).toBe(true)
        const joined = logs.join("\n")
        expect(joined).toContain("api: unmerged commits — use --force")
        expect(joined).toContain("Closed task alpha in 0 repositories")
        expect(joined).toContain("Skipped 1 repository")

        // --force closes the unmerged repo regardless.
        const forced = await captureOutput(async () => {
            await close.run({ task: "alpha", force: true, "no-hooks": false })
        })
        expect(fs.existsSync(taskDir("alpha", "api"))).toBe(false)
        expect(await branchExists("api", "alpha")).toBe(false)
        expect(forced.logs.join("\n")).toContain("api: closed")
    })

    it("continues and reports: closes the safe repo, skips the unsafe one", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha") // safe (merged, clean)
        const webWt = await openWorktree("web", "alpha")
        // Make web unsafe via an uncommitted change.
        await fsp.writeFile(path.join(webWt, "README.md"), "uncommitted\n")

        const { logs } = await captureOutput(async () => {
            await close.run({ task: "alpha", force: false, "no-hooks": false })
        })

        // api closed...
        expect(fs.existsSync(taskDir("alpha", "api"))).toBe(false)
        expect(await branchExists("api", "alpha")).toBe(false)
        // ...web left intact.
        expect(fs.existsSync(taskDir("alpha", "web"))).toBe(true)
        expect(await branchExists("web", "alpha")).toBe(true)
        const joined = logs.join("\n")
        expect(joined).toContain("api: closed")
        expect(joined).toContain("web: uncommitted changes — use --force")
        expect(joined).toContain("Closed task alpha in 1 repository")
        expect(joined).toContain("Skipped 1 repository")
    })

    it("warns and exits clean when the task is not found, touching nothing", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")

        const { logs, warnings } = await captureOutput(async () => {
            await close.run({ task: "ghost", force: false, "no-hooks": false })
        })

        // The real task is untouched.
        expect(fs.existsSync(taskDir("alpha", "api"))).toBe(true)
        expect(await branchExists("api", "alpha")).toBe(true)
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain("ghost")
        expect(logs.some((l) => l.includes("Closed task"))).toBe(false)
    })

    it("--force closes everything regardless of dirty or unmerged state", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        const apiWt = await openWorktree("api", "alpha")
        const webWt = await openWorktree("web", "alpha")
        // api dirty, web unmerged — both would be skipped without --force.
        await fsp.writeFile(path.join(apiWt, "README.md"), "uncommitted\n")
        await fsp.writeFile(path.join(webWt, "feature.txt"), "work\n")
        await sh(webWt, "add", "feature.txt")
        await sh(webWt, "commit", "-m", "feature work")

        const { logs } = await captureOutput(async () => {
            await close.run({ task: "alpha", force: true, "no-hooks": false })
        })

        for (const name of ["api", "web"]) {
            expect(fs.existsSync(taskDir("alpha", name))).toBe(false)
            expect(await branchExists(name, "alpha")).toBe(false)
        }
        const joined = logs.join("\n")
        expect(joined).toContain("Closed task alpha in 2 repositories")
        expect(joined).not.toContain("Skipped")
    })

    it("throws when no config exists in cwd or any parent", async () => {
        const orphan = await fsp.mkdtemp(
            path.join(os.tmpdir(), "close-orphan-")
        )
        process.chdir(orphan)
        try {
            let error: unknown
            try {
                await close.run({
                    task: "alpha",
                    force: false,
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

    type CloseJson = {
        task: string
        forced: boolean
        hooks: { event: string; repo: string; exit: number }[]
        repos: { name: string; status: string; reason?: string }[]
        carry: { repo: string; modified: string[] }[]
    }

    describe("--json", () => {
        it("emits closed repos and forced:false for a clean merged task", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])
            await openWorktree("api", "alpha")
            await openWorktree("web", "alpha")

            const json = await captureJson<CloseJson>(async () => {
                await close.run({
                    task: "alpha",
                    force: false,
                    "no-hooks": false
                })
            })
            expect(json).toEqual({
                task: "alpha",
                forced: false,
                hooks: [],
                repos: [
                    { name: "api", status: "closed" },
                    { name: "web", status: "closed" }
                ],
                carry: []
            })
        })

        it("emits skipped with reason for dirty and unmerged repos under --json", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])
            const apiWt = await openWorktree("api", "alpha")
            const webWt = await openWorktree("web", "alpha")
            // api dirty (uncommitted), web unmerged (committed, unpushed).
            await fsp.writeFile(path.join(apiWt, "README.md"), "uncommitted\n")
            await fsp.writeFile(path.join(webWt, "feature.txt"), "work\n")
            await sh(webWt, "add", "feature.txt")
            await sh(webWt, "commit", "-m", "feature work")

            const json = await captureJson<CloseJson>(async () => {
                await close.run({
                    task: "alpha",
                    force: false,
                    "no-hooks": false
                })
            })
            expect(json).toEqual({
                task: "alpha",
                forced: false,
                hooks: [],
                repos: [
                    {
                        name: "api",
                        status: "skipped",
                        reason: "uncommitted changes"
                    },
                    {
                        name: "web",
                        status: "skipped",
                        reason: "unmerged commits"
                    }
                ],
                carry: []
            })
        })

        it("emits forced:true and closed under --json when --force overrides", async () => {
            await makeSource("api")
            await register(["api"])
            const wt = await openWorktree("api", "alpha")
            await fsp.writeFile(path.join(wt, "README.md"), "uncommitted\n")

            const json = await captureJson<CloseJson>(async () => {
                await close.run({
                    task: "alpha",
                    force: true,
                    "no-hooks": false
                })
            })
            expect(json).toEqual({
                task: "alpha",
                forced: true,
                hooks: [],
                repos: [{ name: "api", status: "closed" }],
                carry: []
            })
        })

        it("emits empty repos under --json when the task is not open", async () => {
            await makeSource("api")
            await register(["api"])

            const json = await captureJson<CloseJson>(async () => {
                await close.run({
                    task: "ghost",
                    force: false,
                    "no-hooks": false
                })
            })
            expect(json).toEqual({
                task: "ghost",
                forced: false,
                hooks: [],
                repos: [],
                carry: []
            })
        })
    })

    describe("hooks", () => {
        type CloseHooksJson = {
            task: string
            forced: boolean
            repos: { name: string; status: string; reason?: string }[]
            hooks: { event: string; repo: string; exit: number }[]
        }

        // Register flat names AND a hooks map, so the hook wiring can be
        // exercised (mirrors the helper in the other command specs).
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

        it("pre-close failure leaves the worktree and branch standing and exits non-zero", async () => {
            await makeSource("api")
            await registerWithHooks(["api"], { "pre-close": "exit 1" })
            await openWorktree("api", "alpha")

            const previousExit = process.exitCode
            process.exitCode = undefined
            let json: CloseHooksJson
            try {
                json = await captureJson<CloseHooksJson>(async () => {
                    await close.run({
                        task: "alpha",
                        force: false,
                        "no-hooks": false
                    })
                })
                expect(process.exitCode).toBe(1)
            } finally {
                process.exitCode = previousExit
            }
            // The gate held: nothing was torn down.
            expect(json.repos).toEqual([
                {
                    name: "api",
                    status: "skipped",
                    reason: "pre-close hook failed"
                }
            ])
            expect(json.hooks).toEqual([
                { event: "pre-close", repo: "api", exit: 1 }
            ])
            expect(fs.existsSync(taskDir("alpha", "api"))).toBe(true)
            expect(await branchExists("api", "alpha")).toBe(true)
        })

        it("post-close runs in the source clone after the worktree is gone, with UBEREPO_REPO_PATH naming it", async () => {
            await makeSource("api")
            await registerWithHooks(["api"], {
                // Prove the worktree is already gone at fire time, then record
                // where the hook ran and which path the event was about.
                "post-close":
                    'test ! -d "$UBEREPO_REPO_PATH" && echo "$PWD|$UBEREPO_REPO_PATH|$UBEREPO_EVENT" > "$UBEREPO_WORKSPACE/post.txt"'
            })
            await openWorktree("api", "alpha")

            const json = await captureJson<CloseHooksJson>(async () => {
                await close.run({
                    task: "alpha",
                    force: false,
                    "no-hooks": false
                })
            })
            expect(json.repos).toEqual([{ name: "api", status: "closed" }])
            expect(json.hooks).toEqual([
                { event: "post-close", repo: "api", exit: 0 }
            ])
            const line = (
                await fsp.readFile(path.join(root, "post.txt"), "utf8")
            ).trim()
            expect(line).toBe(
                `${path.join(root, "source", "api")}|${path.join(
                    root,
                    "tasks",
                    "alpha",
                    "api"
                )}|post-close`
            )
        })

        it("does not run close hooks under --no-hooks", async () => {
            await makeSource("api")
            await registerWithHooks(["api"], {
                "pre-close": "exit 1",
                "post-close": "exit 1"
            })
            await openWorktree("api", "alpha")

            const json = await captureJson<CloseHooksJson>(async () => {
                await close.run({
                    task: "alpha",
                    force: false,
                    "no-hooks": true
                })
            })
            expect(json.repos).toEqual([{ name: "api", status: "closed" }])
            expect(json.hooks).toEqual([])
            expect(fs.existsSync(taskDir("alpha", "api"))).toBe(false)
        })
    })

    describe("carry", () => {
        // Register flat names plus workspace-level carry patterns. The carried
        // fixtures are gitignored so they never trip close's dirty guard —
        // exactly the gap the drift warning exists to cover.
        const registerWithCarry = async (
            names: string[],
            carry: string[]
        ): Promise<void> => {
            await fsp.writeFile(
                configPath,
                `${JSON.stringify(
                    {
                        repositories: names.map(
                            (n) => `https://github.com/acme/${n}.git`
                        ),
                        carry
                    },
                    null,
                    4
                )}\n`
            )
        }

        // Commit a .gitignore on main (and push it upstream) BEFORE the
        // worktree opens, so the carried files stay ignored everywhere and the
        // task branch remains merged into origin/main.
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

        it("warns about carried files modified in the task, without blocking the close", async () => {
            await makeSource("api")
            await ignore("api", [".env"])
            await registerWithCarry(["api"], [".env"])
            await fsp.writeFile(
                path.join(root, "source", "api", ".env"),
                "ORIGINAL\n"
            )
            const wt = await openWorktree("api", "alpha")
            // The carried copy was edited inside the task; git never saw it.
            await fsp.writeFile(path.join(wt, ".env"), "EDITED\n")

            const { warnings } = await captureOutput(async () => {
                await close.run({
                    task: "alpha",
                    force: false,
                    "no-hooks": false
                })
            })

            expect(warnings.join("\n")).toContain(
                "api: carried files modified in this task; changes will be lost — .env"
            )
            // Warn-only: the worktree and branch are gone regardless.
            expect(fs.existsSync(taskDir("alpha", "api"))).toBe(false)
            expect(await branchExists("api", "alpha")).toBe(false)
        })

        it("emits the modified files under --json and stays silent when identical", async () => {
            await makeSource("api")
            await makeSource("web")
            await ignore("api", [".env"])
            await ignore("web", [".env"])
            await registerWithCarry(["api", "web"], [".env"])
            await fsp.writeFile(
                path.join(root, "source", "api", ".env"),
                "ORIGINAL\n"
            )
            await fsp.writeFile(
                path.join(root, "source", "web", ".env"),
                "SAME\n"
            )
            const apiWt = await openWorktree("api", "alpha")
            const webWt = await openWorktree("web", "alpha")
            await fsp.writeFile(path.join(apiWt, ".env"), "EDITED\n")
            await fsp.writeFile(path.join(webWt, ".env"), "SAME\n")

            const json = await captureJson<CloseJson>(async () => {
                await close.run({
                    task: "alpha",
                    force: false,
                    "no-hooks": false
                })
            })

            // Only the diverged repo appears; the byte-identical one is quiet.
            expect(json.carry).toEqual([{ repo: "api", modified: [".env"] }])
            expect(json.repos).toEqual([
                { name: "api", status: "closed" },
                { name: "web", status: "closed" }
            ])
        })
    })
})
