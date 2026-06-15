import { execFile } from "node:child_process"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { terminal } from "cmdore"
import { vi } from "vitest"
import context from "@/commands/context"
import { CONFIG_FILENAME } from "@/config"
import { type Gh, GhError, resetGh, setGh } from "@/forge"

const exec = promisify(execFile)

// The one stable JSON object context emits: diff's footprint per repo,
// enriched with `pr` when gh knows of one, plus the task note when present.
type ContextJson = {
    task: string
    base: string
    note?: {
        goal: string
        repos: string[]
        tickets: string[]
        decisions: { note: string; repo?: string }[]
        blockers: { note: string; repo?: string }[]
        mtime: number
    }
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
        pr?: { number: number; url: string; draft: boolean; state: string }
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

// Capture terminal.log + terminal.warn output for the duration of `fn`, then
// restore them. context uses log for the markdown document and warn for the
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

// Run a git command directly (NOT the wrapper under test) so test setup and
// assertions stay independent of git.ts.
const sh = async (cwd: string, ...args: string[]): Promise<string> => {
    const { stdout } = await exec("git", args, { cwd })
    return stdout.trim()
}

// ── A programmable gh fake (the pr-view sibling of ship.spec's) ──
//
// Records every gh argv (with cwd) and replays a canned `pr view` response
// keyed by the repo flat name (the worktree cwd's basename). A repo with no
// canned PR throws gh's real "no pull requests found" error; `noGh` makes the
// up-front `gh --version` probe throw (gh not installed). No network, no gh
// binary.

type GhRecord = { args: string[]; cwd: string }

type ViewPr = { number: number; url: string; isDraft: boolean; state: string }

type GhConfig = {
    prs?: Record<string, ViewPr>
    noGh?: boolean
}

const makeGh = (config: GhConfig = {}): { run: Gh; calls: GhRecord[] } => {
    const calls: GhRecord[] = []
    const run: Gh = async (args, cwd) => {
        calls.push({ args, cwd })
        if (args[0] === "--version") {
            if (config.noGh) {
                throw new GhError(["--version"], 1, "command not found: gh")
            }
            return "gh version 2.40.0"
        }
        if (args[0] === "pr" && args[1] === "view") {
            const pr = config.prs?.[path.basename(cwd)]
            if (!pr) {
                throw new GhError(
                    args,
                    1,
                    `no pull requests found for branch "${args[2]}"`
                )
            }
            return `${JSON.stringify(pr)}\n`
        }
        return ""
    }
    return { run, calls }
}

describe("context command", () => {
    let tmp: string
    let root: string
    let cwd: string
    let configPath: string

    // Build a fresh uberepo workspace and chdir into it for each test. `root`
    // is the realpath of the workspace because macOS canonicalises /var ->
    // /private/var and git reports worktree paths under the realpath.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "context-spec-"))
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
        await sh(dir, "remote", "set-head", "origin", "main")
        return dir
    }

    // Register flat names in the config as github urls, without cloning.
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

    // Write a full ubertask.yml at the task level: goal, tickets, a decision
    // scoped to api, and an unscoped blocker (the schema's documented shapes).
    const writeNote = async (task: string): Promise<void> => {
        const dir = path.join(root, "tasks", task)
        await fsp.mkdir(dir, { recursive: true })
        await fsp.writeFile(
            path.join(dir, "ubertask.yml"),
            [
                "goal: |",
                "  Kill the redirect loop",
                "repos: []",
                "tickets:",
                "  - https://acme.test/PROJ-1",
                "decisions:",
                "  - note: |",
                "      keep /v1 alive",
                "    repo: api",
                "blockers:",
                "  - note: |",
                "      api on :8080 first",
                ""
            ].join("\n")
        )
    }

    // Write a ubertask.yml declaring only a scope (the repos: the task owns).
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

    it("composes note, footprint, and PR state into the documented JSON shape", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        await commit(wt, "work.txt", "hello\n", "add work")
        // Uncommitted edit on top: flips `dirty`, must NOT move the numbers.
        await fsp.writeFile(path.join(wt, "README.md"), "uncommitted\n")
        await writeNote("alpha")
        const sha = await sh(
            path.join(root, "source", "api"),
            "rev-parse",
            "task/alpha"
        )
        const gh = makeGh({
            prs: {
                api: {
                    number: 7,
                    url: "https://github.com/acme/api/pull/7",
                    isDraft: true,
                    state: "OPEN"
                }
            }
        })
        setGh(gh.run)

        const parsed = await captureJson<ContextJson>(async () => {
            await context.run({ task: "alpha" })
        })

        expect(parsed).toEqual({
            task: "alpha",
            base: "origin/main",
            note: {
                goal: "Kill the redirect loop",
                repos: [],
                branches: {},
                tickets: ["https://acme.test/PROJ-1"],
                decisions: [{ note: "keep /v1 alive", repo: "api" }],
                blockers: [{ note: "api on :8080 first" }],
                mtime: expect.any(Number)
            },
            repos: [
                {
                    name: "api",
                    branch: "task/alpha",
                    ahead: 1,
                    dirty: true,
                    files: 1,
                    insertions: 1,
                    deletions: 0,
                    commits: [{ sha, subject: "add work" }],
                    status: "ok",
                    pr: {
                        number: 7,
                        url: "https://github.com/acme/api/pull/7",
                        draft: true,
                        state: "OPEN"
                    }
                }
            ]
        })

        // gh was probed once, then asked exactly the documented pr view, run
        // in the repo's WORKTREE so gh infers the repo from its origin.
        expect(gh.calls[0]?.args).toEqual(["--version"])
        expect(gh.calls[1]).toEqual({
            args: [
                "pr",
                "view",
                "task/alpha",
                "--json",
                "number,url,isDraft,state,baseRefName"
            ],
            cwd: path.join(root, "tasks", "alpha", "api")
        })
        expect(gh.calls).toHaveLength(2)
    })

    it("renders the handoff as one clean markdown document", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        const wt = await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")
        await commit(wt, "work.txt", "hello\n", "add work")
        await fsp.writeFile(path.join(wt, "README.md"), "uncommitted\n")
        await writeNote("alpha")
        const sha = await sh(
            path.join(root, "source", "api"),
            "rev-parse",
            "task/alpha"
        )
        const gh = makeGh({
            prs: {
                api: {
                    number: 7,
                    url: "https://github.com/acme/api/pull/7",
                    isDraft: true,
                    state: "OPEN"
                }
            }
        })
        setGh(gh.run)

        const { logs } = await captureOutput(async () => {
            await context.run({ task: "alpha" })
        })

        expect(logs).toEqual([
            "# Task: alpha",
            "",
            "Goal: Kill the redirect loop",
            "Tickets: https://acme.test/PROJ-1",
            "Note updated: just now",
            "",
            "## Repos (vs origin/main)",
            "",
            "- api  task/alpha  1 ahead  1 file +1 -0  PR #7 (draft)  dirty",
            `  - ${sha.slice(0, 7)} add work`,
            "- web  task/alpha  0 ahead  no PR  clean",
            "",
            "## Decisions",
            "",
            "- keep /v1 alive (api)",
            "",
            "## Blockers",
            "",
            "- api on :8080 first"
        ])
    })

    it("omits the note and its sections entirely when the task has none", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")
        const gh = makeGh()
        setGh(gh.run)

        const parsed = await captureJson<ContextJson>(async () => {
            await context.run({ task: "alpha" })
        })
        expect("note" in parsed).toBe(false)
        expect(parsed.repos.map((r) => r.name)).toEqual(["api"])

        const { logs } = await captureOutput(async () => {
            await context.run({ task: "alpha" })
        })
        // Straight from the title to the repos — no Goal/Tickets/Note lines,
        // no Decisions/Blockers sections.
        expect(logs[0]).toBe("# Task: alpha")
        expect(logs[2]).toBe("## Repos (vs origin/main)")
        expect(logs.join("\n")).not.toMatch(/Goal:|Tickets:|Note updated:/)
        expect(logs.join("\n")).not.toMatch(/## Decisions|## Blockers/)
    })

    it("silently omits all PR state when gh is missing", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        await commit(wt, "work.txt", "hello\n", "add work")
        const gh = makeGh({ noGh: true })
        setGh(gh.run)

        let parsed: ContextJson | undefined
        const { warnings } = await captureOutput(async () => {
            parsed = await captureJson<ContextJson>(async () => {
                await context.run({ task: "alpha" })
            })
        })

        // No pr key anywhere, no warning — the degradation is automatic.
        expect(parsed?.repos[0]?.status).toBe("ok")
        expect(parsed?.repos.some((r) => "pr" in r)).toBe(false)
        expect(warnings).toEqual([])
        // The probe failed once; no pr view was ever attempted.
        expect(gh.calls.map((c) => c.args[0])).toEqual(["--version"])

        // The human line carries no PR column at all (it can't know "no PR").
        const { logs } = await captureOutput(async () => {
            await context.run({ task: "alpha" })
        })
        const line = logs.find((l) => l.startsWith("- api"))
        expect(line).toBe("- api  task/alpha  1 ahead  1 file +1 -0  clean")
    })

    it("treats a gh error (or simply no PR) as no PR, never an abort", async () => {
        await makeSource("api")
        await register(["api"])
        const wt = await openWorktree("api", "alpha")
        await commit(wt, "work.txt", "hello\n", "add work")
        // gh is present but `pr view` throws (no PR / not authed / whatever).
        const gh = makeGh({ prs: {} })
        setGh(gh.run)

        const parsed = await captureJson<ContextJson>(async () => {
            await context.run({ task: "alpha" })
        })
        expect(parsed.repos[0]?.status).toBe("ok")
        expect(parsed.repos.some((r) => "pr" in r)).toBe(false)

        // gh WAS consulted here, so the human line says so explicitly.
        const { logs } = await captureOutput(async () => {
            await context.run({ task: "alpha" })
        })
        expect(logs.find((l) => l.startsWith("- api"))).toContain("no PR")
    })

    it("reports a scoped repo with no worktree as skipped and asks gh nothing about it", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        // web is in the scope but was never opened (or its worktree is gone).
        await writeScope("alpha", ["api", "web"])
        const gh = makeGh({
            prs: {
                api: {
                    number: 9,
                    url: "https://github.com/acme/api/pull/9",
                    isDraft: false,
                    state: "OPEN"
                }
            }
        })
        setGh(gh.run)

        const parsed = await captureJson<ContextJson>(async () => {
            await context.run({ task: "alpha" })
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
        // One probe + one pr view (api) — the skipped repo got no gh call.
        expect(gh.calls).toHaveLength(2)

        const { logs } = await captureOutput(async () => {
            await context.run({ task: "alpha" })
        })
        expect(logs.find((l) => l.startsWith("- api"))).toContain(
            "PR #9 (ready)"
        )
        expect(logs.find((l) => l.startsWith("- web"))).toContain(
            "skipped — no worktree"
        )
    })

    it("warns and emits an empty repos list when the task is not open", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")
        const gh = makeGh()
        setGh(gh.run)

        let parsed: ContextJson | undefined
        const { warnings } = await captureOutput(async () => {
            parsed = await captureJson<ContextJson>(async () => {
                await context.run({ task: "ghost" })
            })
        })

        expect(parsed).toEqual({ task: "ghost", base: "", repos: [] })
        expect(warnings.join("\n")).toContain("ghost")
        // Nothing to look up — gh was never touched.
        expect(gh.calls).toEqual([])
    })
})
