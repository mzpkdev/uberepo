import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { terminal } from "cmdore"
import { vi } from "vitest"
import ship from "@/commands/ship"
import { CONFIG_FILENAME } from "@/config"
import { type Gh, GhError, resetGh, setGh } from "@/forge"

const exec = promisify(execFile)

// ── JSON / output capture (same pattern as the other command specs) ──

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

const captureOutput = async (
    fn: () => Promise<void>
): Promise<{ logs: string[]; warnings: string[]; errors: string[] }> => {
    const originalLog = terminal.log
    const originalWarn = terminal.warn
    const originalError = terminal.error
    const logs: string[] = []
    const warnings: string[] = []
    const errors: string[] = []
    terminal.log = (m?: string) => {
        logs.push(m ?? "")
    }
    terminal.warn = (m?: string) => {
        warnings.push(m ?? "")
    }
    terminal.error = (m?: string) => {
        errors.push(m ?? "")
    }
    try {
        await fn()
    } finally {
        terminal.log = originalLog
        terminal.warn = originalWarn
        terminal.error = originalError
    }
    return { logs, warnings, errors }
}

const sh = async (cwd: string, ...args: string[]): Promise<string> => {
    const { stdout } = await exec("git", args, { cwd })
    return stdout.trim()
}

// ── A programmable gh fake ──
//
// Records every gh argv (with cwd) and replays canned `pr list`/`create` output
// keyed by the repo flat name (derived from the worktree cwd's basename). For
// create it reads the --body-file the command wrote, so specs can assert the
// exact body passed. No network, no gh binary.

type GhRecord = { args: string[]; cwd: string; bodyFile?: string }

type GhFake = {
    run: Gh
    calls: GhRecord[]
    // create call bodies keyed by repo name (the body passed to `pr create`).
    createdBodies: Record<string, string>
}

type GhConfig = {
    // existing OPEN/closed PRs to return from `pr list`, keyed by repo name.
    existing?: Record<string, { number: number; url: string; state: string }[]>
    // the url `pr create` returns, keyed by repo name.
    createUrl?: Record<string, string>
    // repo names whose `pr create` should throw (auth/permission failure).
    failCreate?: string[]
    // throw on `gh --version` (gh not installed).
    noGh?: boolean
}

const repoOf = (cwd: string): string => path.basename(cwd)

const makeGh = (config: GhConfig = {}): GhFake => {
    const calls: GhRecord[] = []
    const createdBodies: Record<string, string> = {}
    let nextNumber = 100
    const run: Gh = async (args, cwd) => {
        const sub = `${args[0]} ${args[1] ?? ""}`.trim()
        const name = repoOf(cwd)
        // Capture a --body-file's contents before the caller deletes it.
        const bodyIdx = args.indexOf("--body-file")
        const bodyFile = bodyIdx === -1 ? undefined : args[bodyIdx + 1]
        const record: GhRecord = { args, cwd }
        if (bodyFile !== undefined) {
            record.bodyFile = fs.readFileSync(bodyFile, "utf8")
        }
        calls.push(record)

        if (args[0] === "--version") {
            if (config.noGh) {
                throw new GhError(["--version"], 1, "command not found: gh")
            }
            return "gh version 2.40.0"
        }
        if (sub === "pr list") {
            const prs = config.existing?.[name] ?? []
            return JSON.stringify(prs)
        }
        if (sub === "pr create") {
            if (config.failCreate?.includes(name)) {
                throw new GhError(
                    args,
                    1,
                    "HTTP 403: must have admin rights (auth)"
                )
            }
            if (record.bodyFile !== undefined) {
                createdBodies[name] = record.bodyFile
            }
            const url =
                config.createUrl?.[name] ??
                `https://github.com/acme/${name}/pull/${nextNumber++}`
            return `${url}\n`
        }
        return ""
    }
    return { run, calls, createdBodies }
}

// The gh subcommands a fake recorded, as "pr list" / "pr create" / "--version".
const subsOf = (gh: GhFake): string[] =>
    gh.calls.map((c) => `${c.args[0]} ${c.args[1] ?? ""}`.trim())

// Argv defaults so each test only sets what it cares about.
const argv = (over: Partial<Parameters<typeof ship.run>[0]> = {}) => ({
    task: "alpha",
    repos: undefined,
    title: undefined,
    body: undefined,
    "body-file": undefined,
    base: undefined,
    "no-pr": false,
    force: false,
    "no-hooks": false,
    ...over
})

describe("ship command", () => {
    let tmp: string
    let root: string
    let cwd: string
    let configPath: string

    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ship-spec-"))
        root = await fsp.realpath(tmp)
        configPath = path.join(root, CONFIG_FILENAME)
        await fsp.writeFile(configPath, `{\n    "repositories": []\n}\n`)
        cwd = process.cwd()
        process.chdir(root)
    })

    afterEach(async () => {
        terminal.jsonMode = false
        resetGh()
        vi.restoreAllMocks()
        process.chdir(cwd)
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    // A real source repo at source/<name> with one commit on main, wired to a
    // local bare upstream as origin with origin/HEAD → main, so a real
    // `git push` lands in the bare remote and remoteDefault() resolves.
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
        await sh(dir, "remote", "set-head", "origin", "main")
        return dir
    }

    const register = async (names: string[]): Promise<void> => {
        await fsp.writeFile(
            configPath,
            `${JSON.stringify(
                {
                    repositories: names.map(
                        (n) => `https://github.com/acme/${n}.git`
                    )
                },
                null,
                4
            )}\n`
        )
    }

    // Add a worktree for `task` to source repo `name`, on branch task/<task>.
    const openWorktree = async (
        name: string,
        task: string
    ): Promise<string> => {
        const source = path.join(root, "source", name)
        const wt = path.join(root, "tasks", task, name)
        await sh(source, "worktree", "add", "-b", `task/${task}`, wt, "main")
        return wt
    }

    // Commit a file on the task worktree so the branch is ahead of base.
    const commitWork = async (wt: string, file = "work.txt"): Promise<void> => {
        await fsp.writeFile(path.join(wt, file), "work\n")
        await sh(wt, "add", file)
        await sh(wt, "commit", "-m", `task work ${file}`)
    }

    // Commit a .github/pull_request_template.md into the worktree (so the tree
    // stays clean — an UNcommitted template would read as a dirty worktree and
    // ship would skip the repo). Mirrors a repo that ships a PR template.
    const commitTemplate = async (
        wt: string,
        contents: string,
        file = ".github/pull_request_template.md"
    ): Promise<void> => {
        const abs = path.join(wt, file)
        await fsp.mkdir(path.dirname(abs), { recursive: true })
        await fsp.writeFile(abs, contents)
        await sh(wt, "add", file)
        await sh(wt, "commit", "-m", "add PR template")
    }

    // Write a ubertask.yml at the task level (scope/goal).
    const writeNote = async (task: string, yaml: string): Promise<void> => {
        const dir = path.join(root, "tasks", task)
        await fsp.mkdir(dir, { recursive: true })
        await fsp.writeFile(path.join(dir, "ubertask.yml"), yaml)
    }

    // The sha the bare upstream's task/<task> ref points at (proves a push landed).
    const remoteBranchSha = (name: string, task: string): Promise<string> =>
        sh(
            path.join(root, "upstream", `${name}.git`),
            "rev-parse",
            `task/${task}`
        )

    type ShipJson = {
        task: string
        base: string
        repos: {
            name: string
            branch: string
            base?: string
            pushed: boolean
            pr?: { number: number; url: string; action: string }
            status: string
            reason?: string
            error?: string
        }[]
        hooks: { event: string; repo: string; exit: number }[]
    }

    // ── State matrix ──

    it("ahead + no PR → push + create draft PR (shipped)", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        await commitWork(wt)
        const gh = makeGh()
        setGh(gh.run)

        const json = await captureJson<ShipJson>(async () => {
            await ship.run(argv())
        })

        // The branch reached the bare remote.
        expect(await remoteBranchSha("api", "alpha")).toBe(
            await sh(wt, "rev-parse", "HEAD")
        )
        expect(json.base).toBe("main")
        expect(json.repos).toHaveLength(1)
        const api = json.repos[0]
        expect(api.status).toBe("shipped")
        expect(api.pushed).toBe(true)
        expect(api.pr?.action).toBe("created")
        expect(api.pr?.url).toContain("/pull/")
        // gh saw a list then a create (draft) — and NO edit (single pass).
        const subs = subsOf(gh)
        expect(subs).toContain("pr list")
        expect(subs).toContain("pr create")
        expect(subs).not.toContain("pr edit")
        expect(subs).not.toContain("pr view")
        // create carried --draft and --base main.
        const create = gh.calls.find((c) => c.args[1] === "create")
        expect(create?.args).toContain("--draft")
        expect(create?.args).toEqual(
            expect.arrayContaining(["--base", "main", "--head", "task/alpha"])
        )
    })

    it("not ahead of base → skip with reason 'nothing to ship', no gh PR calls", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha") // no commits → not ahead
        const gh = makeGh()
        setGh(gh.run)

        const json = await captureJson<ShipJson>(async () => {
            await ship.run(argv())
        })
        expect(json.repos).toEqual([
            {
                name: "api",
                branch: "task/alpha",
                base: "main",
                pushed: false,
                status: "skipped",
                reason: "nothing to ship"
            }
        ])
        // No push, no create — only the up-front `gh --version` ran.
        expect(subsOf(gh)).toEqual(["--version"])
    })

    it("ahead + PR exists → push only (action 'updated'); PR is NOT edited", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        await commitWork(wt)
        const gh = makeGh({
            existing: {
                api: [
                    {
                        number: 5,
                        url: "https://github.com/acme/api/pull/5",
                        state: "OPEN"
                    }
                ]
            }
        })
        setGh(gh.run)

        const json = await captureJson<ShipJson>(async () => {
            await ship.run(argv())
        })
        const api = json.repos[0]
        expect(api.status).toBe("shipped")
        expect(api.pushed).toBe(true)
        expect(api.pr).toEqual({
            number: 5,
            url: "https://github.com/acme/api/pull/5",
            action: "updated"
        })
        // The branch was pushed (refreshes the PR), but gh was NOT asked to
        // create or edit anything — the existing PR is left untouched.
        expect(await remoteBranchSha("api", "alpha")).toBe(
            await sh(wt, "rev-parse", "HEAD")
        )
        const subs = subsOf(gh)
        expect(subs).toContain("pr list")
        expect(subs).not.toContain("pr create")
        expect(subs).not.toContain("pr edit")
        expect(subs).not.toContain("pr view")
    })

    it("dirty worktree → skip with reason 'uncommitted changes' (does not abort siblings)", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        const apiWt = await openWorktree("api", "alpha")
        const webWt = await openWorktree("web", "alpha")
        await commitWork(apiWt)
        await commitWork(webWt)
        // api is dirty.
        await fsp.writeFile(path.join(apiWt, "README.md"), "uncommitted\n")
        const gh = makeGh()
        setGh(gh.run)

        const json = await captureJson<ShipJson>(async () => {
            await ship.run(argv())
        })
        const api = json.repos.find((r) => r.name === "api")
        const web = json.repos.find((r) => r.name === "web")
        expect(api).toMatchObject({
            status: "skipped",
            reason: "uncommitted changes",
            pushed: false
        })
        // web still shipped despite api's skip.
        expect(web?.status).toBe("shipped")
        expect(web?.pushed).toBe(true)
    })

    // ── Title resolution ──

    it("title chain: --title wins", async () => {
        await makeSource("api")
        await register(["api"])
        await commitWork(await openWorktree("api", "alpha"))
        await writeNote("alpha", "goal: |\n  The goal line\n")
        const gh = makeGh()
        setGh(gh.run)
        await captureOutput(async () => {
            await ship.run(argv({ title: "Explicit title" }))
        })
        const create = gh.calls.find((c) => c.args[1] === "create")
        const ti = create?.args.indexOf("--title") ?? -1
        expect(create?.args[ti + 1]).toBe("Explicit title")
    })

    it("title chain: falls back to the goal's first line", async () => {
        await makeSource("api")
        await register(["api"])
        await commitWork(await openWorktree("api", "alpha"))
        await writeNote(
            "alpha",
            "goal: |\n  Kill the SSO loop\n  more detail\n"
        )
        const gh = makeGh()
        setGh(gh.run)
        await captureOutput(async () => {
            await ship.run(argv())
        })
        const create = gh.calls.find((c) => c.args[1] === "create")
        const ti = create?.args.indexOf("--title") ?? -1
        expect(create?.args[ti + 1]).toBe("Kill the SSO loop")
    })

    it("title chain: falls back to the task name when there is no goal", async () => {
        await makeSource("api")
        await register(["api"])
        await commitWork(await openWorktree("api", "alpha"))
        // No note at all.
        const gh = makeGh()
        setGh(gh.run)
        await captureOutput(async () => {
            await ship.run(argv())
        })
        const create = gh.calls.find((c) => c.args[1] === "create")
        const ti = create?.args.indexOf("--title") ?? -1
        expect(create?.args[ti + 1]).toBe("alpha")
    })

    // ── Body resolution: override → template → empty (nothing appended) ──

    it("create body = the repo's .github PR template verbatim (nothing appended)", async () => {
        await makeSource("api")
        await register(["api"])
        const apiWt = await openWorktree("api", "alpha")
        await commitWork(apiWt)
        await commitTemplate(apiWt, "## Summary\n\nWhat & why.\n")
        const gh = makeGh()
        setGh(gh.run)
        await captureOutput(async () => {
            await ship.run(argv())
        })
        // The body is EXACTLY the template — no managed block, no markers.
        expect(gh.createdBodies.api).toBe("## Summary\n\nWhat & why.\n")
        expect(gh.createdBodies.api).not.toContain("uberepo:task")
        expect(gh.createdBodies.api).not.toContain("Closes")
    })

    it("create body is empty when the repo has no template", async () => {
        await makeSource("api")
        await register(["api"])
        await commitWork(await openWorktree("api", "alpha"))
        const gh = makeGh()
        setGh(gh.run)
        await captureOutput(async () => {
            await ship.run(argv())
        })
        expect(gh.createdBodies.api).toBe("")
    })

    it("--body overrides the template for the create body", async () => {
        await makeSource("api")
        await register(["api"])
        const apiWt = await openWorktree("api", "alpha")
        await commitWork(apiWt)
        await commitTemplate(apiWt, "TEMPLATE\n")
        const gh = makeGh()
        setGh(gh.run)
        await captureOutput(async () => {
            await ship.run(argv({ body: "Custom body" }))
        })
        expect(gh.createdBodies.api).toBe("Custom body")
        expect(gh.createdBodies.api).not.toContain("TEMPLATE")
    })

    it("--body-file reads the override body from a file", async () => {
        await makeSource("api")
        await register(["api"])
        await commitWork(await openWorktree("api", "alpha"))
        const bf = path.join(root, "body.md")
        await fsp.writeFile(bf, "From a file\n")
        const gh = makeGh()
        setGh(gh.run)
        await captureOutput(async () => {
            await ship.run(argv({ "body-file": bf }))
        })
        expect(gh.createdBodies.api).toBe("From a file\n")
    })

    it("--body and --body-file together is an error", async () => {
        await makeSource("api")
        await register(["api"])
        await commitWork(await openWorktree("api", "alpha"))
        setGh(makeGh().run)
        await expect(
            ship.run(argv({ body: "x", "body-file": "/tmp/y" }))
        ).rejects.toThrow(/mutually exclusive/)
    })

    // ── --repos filter + unknown name ──

    it("--repos filters to a subset (transient; the other repo is untouched)", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        const apiWt = await openWorktree("api", "alpha")
        const webWt = await openWorktree("web", "alpha")
        await commitWork(apiWt)
        await commitWork(webWt)
        const gh = makeGh()
        setGh(gh.run)

        const json = await captureJson<ShipJson>(async () => {
            await ship.run(argv({ repos: ["api"] }))
        })
        expect(json.repos.map((r) => r.name)).toEqual(["api"])
        // web was never pushed.
        await expect(remoteBranchSha("web", "alpha")).rejects.toBeTruthy()
    })

    it("--repos with a name outside the task errors before pushing anything", async () => {
        await makeSource("api")
        await register(["api"])
        const apiWt = await openWorktree("api", "alpha")
        await commitWork(apiWt)
        setGh(makeGh().run)
        await expect(ship.run(argv({ repos: ["ghost"] }))).rejects.toThrow(
            /ghost is not a repo in task alpha/
        )
        // Nothing pushed.
        await expect(remoteBranchSha("api", "alpha")).rejects.toBeTruthy()
    })

    it("honours the task's declared scope as the universe", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await commitWork(await openWorktree("api", "alpha"))
        await commitWork(await openWorktree("web", "alpha"))
        // Scope owns api only.
        await writeNote("alpha", "goal: |\n  g\nrepos:\n  - api\n")
        const gh = makeGh()
        setGh(gh.run)
        const json = await captureJson<ShipJson>(async () => {
            await ship.run(argv())
        })
        expect(json.repos.map((r) => r.name)).toEqual(["api"])
    })

    // ── --no-pr (zero gh calls) ──

    it("--no-pr pushes only and makes ZERO gh calls", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        await commitWork(wt)
        const gh = makeGh()
        setGh(gh.run)

        const json = await captureJson<ShipJson>(async () => {
            await ship.run(argv({ "no-pr": true }))
        })
        // Pushed, shipped, but no PR object.
        const api = json.repos[0]
        expect(api.status).toBe("shipped")
        expect(api.pushed).toBe(true)
        expect(api.pr).toBeUndefined()
        // The branch landed in the remote.
        expect(await remoteBranchSha("api", "alpha")).toBe(
            await sh(wt, "rev-parse", "HEAD")
        )
        // gh was never invoked at all (not even --version).
        expect(gh.calls).toHaveLength(0)
    })

    // ── --force (uses --force-with-lease) ──

    it("--force pushes with --force-with-lease (lands a diverged branch)", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        await commitWork(wt)
        const gh = makeGh()
        setGh(gh.run)
        // First plain ship to publish the branch.
        await captureOutput(async () => {
            await ship.run(argv())
        })
        const firstRemote = await remoteBranchSha("api", "alpha")
        // Rewrite history on the task branch so the pushed branch diverges.
        await sh(wt, "commit", "--amend", "-m", "amended work")
        const amended = await sh(wt, "rev-parse", "HEAD")
        expect(amended).not.toBe(firstRemote)

        const json = await captureJson<ShipJson>(async () => {
            await ship.run(argv({ force: true }))
        })
        expect(json.repos[0].status).toBe("shipped")
        // The remote moved to the amended commit (force-with-lease overwrote it).
        expect(await remoteBranchSha("api", "alpha")).toBe(amended)
    })

    it("plain push of a diverged branch is rejected → failed with the sync hint, loop continues", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        const apiWt = await openWorktree("api", "alpha")
        const webWt = await openWorktree("web", "alpha")
        await commitWork(apiWt)
        await commitWork(webWt)
        // Publish api's branch, then diverge it locally (amend) so a PLAIN push
        // is rejected non-fast-forward on the next run.
        const gh0 = makeGh()
        setGh(gh0.run)
        await captureOutput(async () => {
            await ship.run(argv({ repos: ["api"] }))
        })
        await sh(apiWt, "commit", "--amend", "-m", "amended")

        const gh = makeGh()
        setGh(gh.run)
        const prev = process.exitCode
        process.exitCode = undefined
        let json: ShipJson
        try {
            json = await captureJson<ShipJson>(async () => {
                await ship.run(argv())
            })
            expect(process.exitCode).toBe(1)
        } finally {
            process.exitCode = prev
        }
        const api = json.repos.find((r) => r.name === "api")
        const web = json.repos.find((r) => r.name === "web")
        expect(api?.status).toBe("failed")
        expect(api?.error).toContain("branch diverged — did you sync?")
        expect(api?.pushed).toBe(false)
        // web (clean, fresh) still shipped after api's failure.
        expect(web?.status).toBe("shipped")
        expect(web?.pushed).toBe(true)
    })

    // ── Per-repo gh failure → continue + non-zero exit ──

    it("a gh create failure for one repo → that repo failed, sibling shipped, exit non-zero", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await commitWork(await openWorktree("api", "alpha"))
        await commitWork(await openWorktree("web", "alpha"))
        // api's create throws (auth/permission); web's succeeds.
        const gh = makeGh({ failCreate: ["api"] })
        setGh(gh.run)

        const prev = process.exitCode
        process.exitCode = undefined
        let json: ShipJson
        try {
            json = await captureJson<ShipJson>(async () => {
                await ship.run(argv())
            })
            expect(process.exitCode).toBe(1)
        } finally {
            process.exitCode = prev
        }
        const api = json.repos.find((r) => r.name === "api")
        const web = json.repos.find((r) => r.name === "web")
        expect(api?.status).toBe("failed")
        // api was pushed before the gh failure (push precedes create).
        expect(api?.pushed).toBe(true)
        expect(api?.error).toContain("403")
        expect(web?.status).toBe("shipped")
        expect(web?.pr?.action).toBe("created")
    })

    // ── gh prerequisite ──

    it("errors up front when gh is missing (and is not --no-pr), pushing nothing", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        await commitWork(wt)
        setGh(makeGh({ noGh: true }).run)
        await expect(ship.run(argv())).rejects.toThrow(
            /ship needs the GitHub CLI/
        )
        // Nothing was pushed.
        await expect(remoteBranchSha("api", "alpha")).rejects.toBeTruthy()
    })

    it("--no-pr works even when gh is missing", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        await commitWork(wt)
        // A gh fake that would throw on --version, but --no-pr never calls it.
        setGh(makeGh({ noGh: true }).run)
        const json = await captureJson<ShipJson>(async () => {
            await ship.run(argv({ "no-pr": true }))
        })
        expect(json.repos[0].status).toBe("shipped")
        expect(await remoteBranchSha("api", "alpha")).toBe(
            await sh(wt, "rev-parse", "HEAD")
        )
    })

    // ── empty universe ──

    it("warns and emits empty repos when the task has no worktrees", async () => {
        await makeSource("api")
        await register(["api"])
        setGh(makeGh().run)
        const json = await captureJson<ShipJson>(async () => {
            await ship.run(argv({ task: "ghost" }))
        })
        expect(json).toEqual({ task: "ghost", base: "", repos: [], hooks: [] })
    })

    // ── config guard ──

    it("throws when no config exists in cwd or any parent", async () => {
        const orphan = await fsp.mkdtemp(path.join(os.tmpdir(), "ship-orphan-"))
        process.chdir(orphan)
        try {
            await expect(ship.run(argv())).rejects.toThrow(CONFIG_FILENAME)
        } finally {
            process.chdir(root)
            await fsp.rm(orphan, { recursive: true, force: true })
        }
    })

    // ── JSON shape ──

    it("emits the full per-repo JSON shape", async () => {
        await makeSource("api")
        await register(["api"])
        await commitWork(await openWorktree("api", "alpha"))
        const gh = makeGh({
            createUrl: { api: "https://github.com/acme/api/pull/77" }
        })
        setGh(gh.run)
        const json = await captureJson<ShipJson>(async () => {
            await ship.run(argv())
        })
        expect(json.task).toBe("alpha")
        expect(json.base).toBe("main")
        expect(json.repos).toEqual([
            {
                name: "api",
                branch: "task/alpha",
                base: "main",
                pushed: true,
                pr: {
                    number: 77,
                    url: "https://github.com/acme/api/pull/77",
                    action: "created"
                },
                status: "shipped"
            }
        ])
    })

    describe("hooks", () => {
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

        it("pre-ship failure skips the repo: nothing pushed, no gh calls, exit non-zero", async () => {
            await makeSource("api")
            await registerWithHooks(["api"], { "pre-ship": "exit 1" })
            const wt = await openWorktree("api", "alpha")
            await commitWork(wt)
            const gh = makeGh()
            setGh(gh.run)

            const previousExit = process.exitCode
            process.exitCode = undefined
            let json: ShipJson
            try {
                json = await captureJson<ShipJson>(async () => {
                    await ship.run(argv())
                })
                expect(process.exitCode).toBe(1)
            } finally {
                process.exitCode = previousExit
            }
            // The gate held: skipped with the reason, nothing pushed...
            expect(json.repos).toEqual([
                {
                    name: "api",
                    branch: "task/alpha",
                    base: "main",
                    pushed: false,
                    status: "skipped",
                    reason: "pre-ship hook failed"
                }
            ])
            expect(json.hooks).toEqual([
                { event: "pre-ship", repo: "api", exit: 1 }
            ])
            // ...the branch never reached the bare remote, and gh saw no PR
            // call (only the up-front --version availability probe).
            await expect(remoteBranchSha("api", "alpha")).rejects.toThrow()
            expect(gh.calls.filter((c) => c.args[0] === "pr")).toEqual([])
        })

        it("post-ship fires after a created PR with UBEREPO_PR_URL set to it", async () => {
            await makeSource("api")
            await registerWithHooks(["api"], {
                "post-ship":
                    'echo "$UBEREPO_PR_URL|$UBEREPO_EVENT" > "$UBEREPO_WORKSPACE/post.txt"'
            })
            const wt = await openWorktree("api", "alpha")
            await commitWork(wt)
            const gh = makeGh()
            setGh(gh.run)

            const json = await captureJson<ShipJson>(async () => {
                await ship.run(argv())
            })
            expect(json.repos[0].status).toBe("shipped")
            const url = json.repos[0].pr?.url
            expect(url).toContain("/pull/")
            expect(json.hooks).toEqual([
                { event: "post-ship", repo: "api", exit: 0 }
            ])
            const line = (
                await fsp.readFile(path.join(root, "post.txt"), "utf8")
            ).trim()
            expect(line).toBe(`${url}|post-ship`)
        })

        it("post-ship fires under --no-pr with an empty UBEREPO_PR_URL", async () => {
            await makeSource("api")
            await registerWithHooks(["api"], {
                "post-ship":
                    'echo "[$UBEREPO_PR_URL]" > "$UBEREPO_WORKSPACE/post.txt"'
            })
            const wt = await openWorktree("api", "alpha")
            await commitWork(wt)
            const gh = makeGh()
            setGh(gh.run)

            const json = await captureJson<ShipJson>(async () => {
                await ship.run(argv({ "no-pr": true }))
            })
            // Pushed for real, no gh call, and post-ship still fired.
            expect(json.repos[0].status).toBe("shipped")
            expect(json.repos[0].pushed).toBe(true)
            expect(gh.calls).toEqual([])
            expect(json.hooks).toEqual([
                { event: "post-ship", repo: "api", exit: 0 }
            ])
            const line = (
                await fsp.readFile(path.join(root, "post.txt"), "utf8")
            ).trim()
            expect(line).toBe("[]")
        })
    })

    describe("aliased participants (multiple branches per repo)", () => {
        // Add an aliased worktree for `task` to source repo `name`, on branch
        // task/<task>@<alias> — the on-disk shape open produces for a participant.
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

        it("ships two branches of ONE repo as two participants, grouped under the repo", async () => {
            await makeSource("autopilot")
            await register(["autopilot"])
            const bugFix = await openAliased("autopilot", "alpha", "bug-fix")
            const addFeat = await openAliased(
                "autopilot",
                "alpha",
                "add-feature"
            )
            await commitWork(bugFix, "fix.txt")
            await commitWork(addFeat, "feat.txt")
            // The note's scope is the two participants.
            await writeNote(
                "alpha",
                "goal: |\n  two PRs\n\nrepos:\n  - autopilot@bug-fix\n  - autopilot@add-feature\n"
            )
            const gh = makeGh()
            setGh(gh.run)

            const json = await captureJson<ShipJson>(async () => {
                await ship.run(argv())
            })

            // One shipped entry per participant (each its own branch + PR), in
            // the note's declared scope order (a repo's participants stay
            // together — the universe is the scope, not two independent repos).
            expect(json.repos.map((r) => [r.name, r.branch, r.status])).toEqual(
                [
                    ["autopilot@bug-fix", "task/alpha@bug-fix", "shipped"],
                    [
                        "autopilot@add-feature",
                        "task/alpha@add-feature",
                        "shipped"
                    ]
                ]
            )
            // Both aliased branches were really pushed to the ONE upstream
            // (there is no bare task/alpha — each participant has its own ref).
            expect(
                await sh(
                    path.join(root, "upstream", "autopilot.git"),
                    "rev-parse",
                    "task/alpha@bug-fix"
                )
            ).toBeTruthy()
            expect(
                await sh(
                    path.join(root, "upstream", "autopilot.git"),
                    "rev-parse",
                    "task/alpha@add-feature"
                )
            ).toBeTruthy()
            // One PR per branch (two creates against the same repo).
            const creates = gh.calls.filter(
                (c) => `${c.args[0]} ${c.args[1]}` === "pr create"
            )
            expect(creates).toHaveLength(2)
        })

        it("--repos can narrow a multi-branch ship to ONE of the repo's participants", async () => {
            await makeSource("autopilot")
            await register(["autopilot"])
            const bugFix = await openAliased("autopilot", "alpha", "bug-fix")
            const addFeat = await openAliased(
                "autopilot",
                "alpha",
                "add-feature"
            )
            await commitWork(bugFix, "fix.txt")
            await commitWork(addFeat, "feat.txt")
            await writeNote(
                "alpha",
                "goal: |\n  g\n\nrepos:\n  - autopilot@bug-fix\n  - autopilot@add-feature\n"
            )
            const gh = makeGh()
            setGh(gh.run)

            const json = await captureJson<ShipJson>(async () => {
                await ship.run(argv({ repos: ["autopilot@bug-fix"] }))
            })

            // Only the named participant shipped; the other was untouched.
            expect(json.repos.map((r) => r.name)).toEqual(["autopilot@bug-fix"])
            await expect(
                sh(
                    path.join(root, "upstream", "autopilot.git"),
                    "rev-parse",
                    "task/alpha@add-feature"
                )
            ).rejects.toThrow()
        })
    })

    describe("stacked participants (a child PR based on a sibling)", () => {
        // Open an aliased worktree on branch task/<task>@<alias>, branched off
        // `from` (main for a root, the PARENT's branch for a stacked child).
        const openAliasedFrom = async (
            name: string,
            task: string,
            alias: string,
            from: string
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
                from
            )
            return wt
        }

        // The gh subcommand of a recorded call ("pr list" / "pr create").
        const subOf = (c: { args: string[] }): string =>
            `${c.args[0]} ${c.args[1] ?? ""}`.trim()

        // Set up a parent (strings) + a child (logos) stacked on it: the child
        // branches off the parent's branch and commits its own work, and the
        // note declares the sibling edge (logos.base = autopilot@strings).
        const stackedPair = async (): Promise<{
            parentWt: string
            childWt: string
        }> => {
            await makeSource("autopilot")
            await register(["autopilot"])
            const parentWt = await openAliasedFrom(
                "autopilot",
                "alpha",
                "strings",
                "main"
            )
            await commitWork(parentWt, "strings.txt")
            // The child stacks ON the parent's branch — branched from it, with
            // its own commit on top, so it is ahead of the PARENT (not flat
            // against main).
            const childWt = await openAliasedFrom(
                "autopilot",
                "alpha",
                "logos",
                "task/alpha@strings"
            )
            await commitWork(childWt, "logos.txt")
            // The note: both participants in scope, the child's base = the
            // parent's participant token (the stack edge open --stack writes).
            await writeNote(
                "alpha",
                "goal: |\n  stacked\n\nrepos:\n  - autopilot@strings\n  - autopilot@logos\n\nbranches:\n  autopilot@logos:\n    name: task/alpha@logos\n    adopted: false\n    base: autopilot@strings\n"
            )
            return { parentWt, childWt }
        }

        it("opens the child PR against the PARENT's branch (not the remote default)", async () => {
            await stackedPair()
            const gh = makeGh()
            setGh(gh.run)

            const json = await captureJson<ShipJson>(async () => {
                await ship.run(argv())
            })

            // The child's gh create targets the parent branch, NOT main, and the
            // branch name is passed verbatim (no origin/ strip).
            const childCreate = gh.calls.find(
                (c) =>
                    subOf(c) === "pr create" &&
                    c.cwd.endsWith("autopilot@logos")
            )
            expect(childCreate).toBeDefined()
            expect(childCreate?.args).toEqual(
                expect.arrayContaining([
                    "--base",
                    "task/alpha@strings",
                    "--head",
                    "task/alpha@logos"
                ])
            )
            // The parent's PR still targets the remote default.
            const parentCreate = gh.calls.find(
                (c) =>
                    subOf(c) === "pr create" &&
                    c.cwd.endsWith("autopilot@strings")
            )
            expect(parentCreate?.args).toEqual(
                expect.arrayContaining(["--base", "main"])
            )
            // The per-entry base is truthful: parent branch for the child, the
            // remote default for the parent.
            const byName = new Map(json.repos.map((r) => [r.name, r]))
            expect(byName.get("autopilot@logos")?.base).toBe(
                "task/alpha@strings"
            )
            expect(byName.get("autopilot@strings")?.base).toBe("main")
            // The run-level base stays the ROOTS' base (never the child's edge).
            expect(json.base).toBe("main")
        })

        it("pushes + creates the PARENT before the child (parent-first single pass)", async () => {
            await stackedPair()
            const gh = makeGh()
            setGh(gh.run)

            await captureJson<ShipJson>(async () => {
                await ship.run(argv())
            })

            // The parent's create must be recorded BEFORE the child's create —
            // the child's `--base task/alpha@strings` needs the parent branch on
            // the remote, which only the parent's push (earlier in the pass)
            // puts there.
            const creates = gh.calls.filter((c) => subOf(c) === "pr create")
            const parentIdx = creates.findIndex((c) =>
                c.cwd.endsWith("autopilot@strings")
            )
            const childIdx = creates.findIndex((c) =>
                c.cwd.endsWith("autopilot@logos")
            )
            expect(parentIdx).toBeGreaterThanOrEqual(0)
            expect(childIdx).toBeGreaterThan(parentIdx)
            // Both branches really reached the one shared upstream.
            for (const branch of ["task/alpha@strings", "task/alpha@logos"]) {
                expect(
                    await sh(
                        path.join(root, "upstream", "autopilot.git"),
                        "rev-parse",
                        branch
                    )
                ).toBeTruthy()
            }
        })

        it("skips the child when its parent did NOT ship (parent not on remote)", async () => {
            const { parentWt } = await stackedPair()
            // Make the parent dirty so its pre-flight skips it (not shipped), and
            // its branch never reaches the remote — the child must then skip.
            await fsp.writeFile(
                path.join(parentWt, "dirty.txt"),
                "uncommitted\n"
            )
            const gh = makeGh()
            setGh(gh.run)

            const json = await captureJson<ShipJson>(async () => {
                await ship.run(argv())
            })

            const byName = new Map(json.repos.map((r) => [r.name, r]))
            // Parent skipped for its dirty tree.
            expect(byName.get("autopilot@strings")?.status).toBe("skipped")
            expect(byName.get("autopilot@strings")?.reason).toBe(
                "uncommitted changes"
            )
            // Child skipped because the parent branch isn't on the remote.
            expect(byName.get("autopilot@logos")?.status).toBe("skipped")
            expect(byName.get("autopilot@logos")?.reason).toBe(
                "parent autopilot@strings not on remote — ship it first"
            )
            // Neither branch reached the remote, and the child's PR was never
            // created (no create against a missing base).
            await expect(
                sh(
                    path.join(root, "upstream", "autopilot.git"),
                    "rev-parse",
                    "task/alpha@logos"
                )
            ).rejects.toThrow()
            expect(gh.calls.some((c) => subOf(c) === "pr create")).toBe(false)
        })

        it("ships the child when its parent ALREADY exists on the remote (prior ship)", async () => {
            const { parentWt, childWt } = await stackedPair()
            // Simulate the parent having been shipped on an earlier run: push its
            // branch to the shared upstream directly, then NARROW this run to the
            // child only (so the parent isn't a target now).
            await sh(parentWt, "push", "origin", "task/alpha@strings")
            const gh = makeGh()
            setGh(gh.run)

            const json = await captureJson<ShipJson>(async () => {
                await ship.run(argv({ repos: ["autopilot@logos"] }))
            })

            // The child shipped: its parent branch was already on origin, so the
            // dependency guard let it through even though the parent wasn't a
            // target this run.
            expect(json.repos.map((r) => [r.name, r.status])).toEqual([
                ["autopilot@logos", "shipped"]
            ])
            const childCreate = gh.calls.find((c) => subOf(c) === "pr create")
            expect(childCreate?.args).toEqual(
                expect.arrayContaining(["--base", "task/alpha@strings"])
            )
            void childWt
        })
    })
})
