import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { terminal } from "cmdore"
import { vi } from "vitest"
import open from "@/commands/open"
import { CONFIG_FILENAME } from "@/config"
import { type Gh, resetGh, setGh } from "@/forge"
import git, { Repository } from "@/git"
import { UBERTASK_FILENAME } from "@/tasks"
import { parse } from "@/ubertask"

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

// The seed open stamps lives in the repo's template/ dir and is the single
// source of truth — read it off disk (resolved relative to this spec, the way
// open resolves it relative to itself) and assert the stamped note is
// byte-identical, so an empty/garbled resolution surfaces as a mismatch.
const TEMPLATE_DIR = path.join(__dirname, "..", "..", "template")
const UBERTASK_TEMPLATE = path.join(TEMPLATE_DIR, UBERTASK_FILENAME)

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

// Capture terminal.log output for the duration of `fn`, then restore it.
const captureLogs = async (fn: () => Promise<void>): Promise<string[]> => {
    const original = terminal.log
    const logs: string[] = []
    terminal.log = (message?: string) => {
        logs.push(message ?? "")
    }
    try {
        await fn()
    } finally {
        terminal.log = original
    }
    return logs
}

describe("open command", () => {
    let tmp: string
    let root: string
    let cwd: string
    let configPath: string

    // Build a fresh uberepo workspace and chdir into it for each test. `root`
    // is the realpath of the workspace because macOS canonicalises /var ->
    // /private/var and git reports worktree paths under the realpath.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "open-spec-"))
        root = await fsp.realpath(tmp)
        configPath = path.join(root, CONFIG_FILENAME)
        await fsp.writeFile(configPath, `{\n    "repositories": []\n}\n`)
        cwd = process.cwd()
        process.chdir(root)
    })

    afterEach(async () => {
        terminal.jsonMode = false
        vi.restoreAllMocks()
        resetGh()
        process.chdir(cwd)
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    // Create a real git repo at `dir` with one commit on main and return its
    // path — the shared fixture builder behind both source clones and the
    // local "origin" repos the on-demand clone tests really clone from.
    const makeRepo = async (dir: string): Promise<string> => {
        await fsp.mkdir(dir, { recursive: true })
        await sh(dir, "init")
        await sh(dir, "config", "user.email", "test@example.com")
        await sh(dir, "config", "user.name", "Test User")
        await fsp.writeFile(
            path.join(dir, "README.md"),
            `${path.basename(dir)}\n`
        )
        await sh(dir, "add", "README.md")
        await sh(dir, "commit", "-m", "initial commit")
        await sh(dir, "branch", "-M", "main")
        return dir
    }

    // A real git repo at <root>/source/<name> with one commit on main.
    // Registration is done separately via register().
    const makeSource = (name: string): Promise<string> =>
        makeRepo(path.join(root, "source", name))

    // A local upstream repo OUTSIDE source/, standing in for a registered
    // repo's remote so an on-demand clone can be a REAL `git clone` without
    // touching the network.
    const makeUpstream = (name: string): Promise<string> =>
        makeRepo(path.join(root, "upstream", name))

    // Spy on git.clone so no network is hit: the registered https URL resolves
    // to its <root>/upstream/<name> fixture and is REALLY cloned from there,
    // so source/<name> ends up a true git repo worktrees can be added to. The
    // mock records every (url, dest) call, and `throwFor` makes the designated
    // flat name's clone reject (the failure-resilience path).
    const mockClone = (throwFor?: string) => {
        const calls: Array<{ url: string; dest: string }> = []
        const spy = vi
            .spyOn(git, "clone")
            .mockImplementation(async (url: string, dest: string) => {
                calls.push({ url, dest })
                const name = (url.split("/").pop() ?? "").replace(/\.git$/, "")
                if (name === throwFor) {
                    throw new Error(`boom cloning ${url}`)
                }
                const upstream = path.join(root, "upstream", name)
                if (!fs.existsSync(upstream)) {
                    throw new Error(`no upstream fixture for ${url}`)
                }
                await exec("git", ["clone", upstream, dest])
                return new Repository(dest)
            })
        return { calls, spy }
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

    // Register repositories by flat name (plain URL strings) plus any top-level
    // carry/hooks. `carry` is a single field: an array (global) or a map of
    // repo name -> patterns (per-repo), so the carry wiring can be exercised in
    // both config shapes.
    const registerWith = async (
        names: string[],
        extra: {
            carry?: string[] | Record<string, string[]>
            hooks?: Record<string, string>
        } = {}
    ): Promise<void> => {
        const repositories = names.map(
            (name) => `https://github.com/acme/${name}.git`
        )
        await fsp.writeFile(
            configPath,
            `${JSON.stringify({ repositories, ...extra }, null, 4)}\n`
        )
    }

    // Realpath of <root>/tasks/<task>/<name>, for comparing against the path
    // git reports (which is canonicalised under /private/var on macOS).
    const worktreeReal = async (task: string, name: string): Promise<string> =>
        fs.realpathSync(path.join(root, "tasks", task, name))

    // The short branch name a source repo's worktree for `task` sits on.
    const branchAt = async (name: string, task: string): Promise<string> => {
        const wt = path.join(root, "tasks", task, name)
        return sh(wt, "rev-parse", "--abbrev-ref", "HEAD")
    }

    it("opens a worktree in every cloned repo on branch task/<task>", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])

        const logs = await captureLogs(async () => {
            await open.run({
                "no-hooks": false,
                stack: undefined,
                branch: undefined,
                task: "alpha",
                from: undefined,
                goal: undefined,
                repos: undefined
            })
        })

        for (const name of ["api", "web"]) {
            const dir = path.join(root, "tasks", "alpha", name)
            expect(fs.existsSync(dir)).toBe(true)
            expect(await branchAt(name, "alpha")).toBe("task/alpha")
        }
        expect(logs.join("\n")).toContain("Opened task alpha in 2 repositories")
    })

    it("respects --from, branching off the given ref instead of HEAD", async () => {
        const dir = await makeSource("api")
        // Commit a second time on main; tag the FIRST commit so --from points
        // at a ref that is strictly behind current HEAD.
        const firstSha = await sh(dir, "rev-parse", "HEAD")
        await sh(dir, "tag", "base", firstSha)
        await fsp.writeFile(path.join(dir, "second.txt"), "second\n")
        await sh(dir, "add", "second.txt")
        await sh(dir, "commit", "-m", "second commit")
        const headSha = await sh(dir, "rev-parse", "HEAD")
        expect(headSha).not.toBe(firstSha)
        await register(["api"])

        await captureLogs(async () => {
            await open.run({
                "no-hooks": false,
                stack: undefined,
                branch: undefined,
                task: "alpha",
                from: "base",
                goal: undefined,
                repos: undefined
            })
        })

        const wt = path.join(root, "tasks", "alpha", "api")
        // The worktree branched off the tag, so its tip is the first commit,
        // not the repo's current HEAD.
        expect(await sh(wt, "rev-parse", "HEAD")).toBe(firstSha)
        expect(fs.existsSync(path.join(wt, "second.txt"))).toBe(false)
    })

    it("defaults the base to the clone's current HEAD when --from is omitted", async () => {
        const dir = await makeSource("api")
        await fsp.writeFile(path.join(dir, "second.txt"), "second\n")
        await sh(dir, "add", "second.txt")
        await sh(dir, "commit", "-m", "second commit")
        const headSha = await sh(dir, "rev-parse", "HEAD")
        await register(["api"])

        await captureLogs(async () => {
            await open.run({
                "no-hooks": false,
                stack: undefined,
                branch: undefined,
                task: "alpha",
                from: undefined,
                goal: undefined,
                repos: undefined
            })
        })

        const wt = path.join(root, "tasks", "alpha", "api")
        expect(await sh(wt, "rev-parse", "HEAD")).toBe(headSha)
        expect(fs.existsSync(path.join(wt, "second.txt"))).toBe(true)
    })

    it("is idempotent and picks up a repo cloned after the first run", async () => {
        await makeSource("api")
        await register(["api"])

        const first = await captureLogs(async () => {
            await open.run({
                "no-hooks": false,
                stack: undefined,
                branch: undefined,
                task: "alpha",
                from: undefined,
                goal: undefined,
                repos: undefined
            })
        })
        expect(first.join("\n")).toContain("Opened task alpha in 1 repository")
        const apiReal = await worktreeReal("alpha", "api")

        // A second repo is cloned + registered only AFTER the first open.
        await makeSource("web")
        await register(["api", "web"])

        const second = await captureLogs(async () => {
            await open.run({
                "no-hooks": false,
                stack: undefined,
                branch: undefined,
                task: "alpha",
                from: undefined,
                goal: undefined,
                repos: undefined
            })
        })

        // api is left exactly as it was (same path, not recreated)...
        expect(await worktreeReal("alpha", "api")).toBe(apiReal)
        expect(second.join("\n")).toContain("already open")
        // ...while web is opened on the second run.
        expect(fs.existsSync(path.join(root, "tasks", "alpha", "web"))).toBe(
            true
        )
        expect(await branchAt("web", "alpha")).toBe("task/alpha")
        expect(second.join("\n")).toContain("Opened task alpha in 1 repository")
    })

    it("seeds tasks/<task>/ubertask.yml from the template, at the task level", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])

        const logs = await captureLogs(async () => {
            await open.run({
                "no-hooks": false,
                stack: undefined,
                branch: undefined,
                task: "alpha",
                from: undefined,
                goal: undefined,
                repos: undefined
            })
        })

        // The note lands at the TASK dir — a sibling of the per-repo worktree
        // dirs, NOT inside any worktree and NOT one-per-repo.
        const note = path.join(root, "tasks", "alpha", UBERTASK_FILENAME)
        expect(fs.existsSync(note)).toBe(true)
        expect(
            fs.existsSync(
                path.join(root, "tasks", "alpha", "api", UBERTASK_FILENAME)
            )
        ).toBe(false)
        // Byte-for-byte against the on-disk template — proves the stamp copies
        // the real seed (not an empty/garbled resolution).
        expect(await fsp.readFile(note, "utf8")).toBe(
            await fsp.readFile(UBERTASK_TEMPLATE, "utf8")
        )
        expect(logs.join("\n")).toContain(
            `Seeded ${path.join("tasks", "alpha", UBERTASK_FILENAME)}`
        )
    })

    it("does NOT overwrite an existing ubertask.yml on re-run", async () => {
        await makeSource("api")
        await register(["api"])

        await captureLogs(async () => {
            await open.run({
                "no-hooks": false,
                stack: undefined,
                branch: undefined,
                task: "alpha",
                from: undefined,
                goal: undefined,
                repos: undefined
            })
        })

        // Mutate the note to a sentinel, then re-run open (the recovery path).
        const note = path.join(root, "tasks", "alpha", UBERTASK_FILENAME)
        const edited = "goal: |\n  edited by hand — keep me\n"
        await fsp.writeFile(note, edited)

        const second = await captureLogs(async () => {
            await open.run({
                "no-hooks": false,
                stack: undefined,
                branch: undefined,
                task: "alpha",
                from: undefined,
                goal: undefined,
                repos: undefined
            })
        })

        // The hand-edited note is preserved verbatim — never clobbered.
        expect(await fsp.readFile(note, "utf8")).toBe(edited)
        expect(second.join("\n")).toContain(
            `Skipping ${path.join("tasks", "alpha", UBERTASK_FILENAME)} — already exists`
        )
    })

    it("--goal seeds a fresh note with the goal populated", async () => {
        await makeSource("api")
        await register(["api"])

        const logs = await captureLogs(async () => {
            await open.run({
                "no-hooks": false,
                stack: undefined,
                branch: undefined,
                task: "alpha",
                from: undefined,
                goal: "Kill the SSO redirect loop",
                repos: undefined
            })
        })

        const note = path.join(root, "tasks", "alpha", UBERTASK_FILENAME)
        // Parsed note carries the goal; the rest keeps the documented empty
        // defaults (so #1's JSON shape stays predictable).
        expect(parse(await fsp.readFile(note, "utf8"))).toEqual({
            goal: "Kill the SSO redirect loop",
            repos: [],
            branches: {},
            tickets: [],
            decisions: [],
            blockers: []
        })
        expect(logs.join("\n")).toContain(
            `Seeded ${path.join("tasks", "alpha", UBERTASK_FILENAME)} (goal set)`
        )
    })

    it("--goal updates the goal in place, preserving every other field", async () => {
        await makeSource("api")
        await register(["api"])

        // A note that already carries tickets/decisions/blockers + an old goal.
        await captureLogs(async () => {
            await open.run({
                "no-hooks": false,
                stack: undefined,
                branch: undefined,
                task: "alpha",
                from: undefined,
                goal: undefined,
                repos: undefined
            })
        })
        const note = path.join(root, "tasks", "alpha", UBERTASK_FILENAME)
        const rich =
            "goal: |\n  old goal\n\n" +
            "tickets:\n  - https://acme/PROJ-1\n\n" +
            "decisions:\n  - note: |\n      keep v1 alive\n    repo: api\n\n" +
            "blockers:\n  - note: |\n      needs api on :8080\n"
        await fsp.writeFile(note, rich)

        const logs = await captureLogs(async () => {
            await open.run({
                "no-hooks": false,
                stack: undefined,
                branch: undefined,
                task: "alpha",
                from: undefined,
                goal: "new goal",
                repos: undefined
            })
        })

        // Only `goal` changed; tickets/decisions/blockers survived intact.
        expect(parse(await fsp.readFile(note, "utf8"))).toEqual({
            goal: "new goal",
            repos: [],
            branches: {},
            tickets: ["https://acme/PROJ-1"],
            decisions: [{ note: "keep v1 alive", repo: "api" }],
            blockers: [{ note: "needs api on :8080" }]
        })
        expect(logs.join("\n")).toContain(
            `Updated goal in ${path.join("tasks", "alpha", UBERTASK_FILENAME)}`
        )
    })

    it("without --goal, an existing goal-bearing note is left untouched", async () => {
        await makeSource("api")
        await register(["api"])

        // Seed WITH a goal, then re-run open with no --goal: no-clobber holds.
        await captureLogs(async () => {
            await open.run({
                "no-hooks": false,
                stack: undefined,
                branch: undefined,
                task: "alpha",
                from: undefined,
                goal: "keep me",
                repos: undefined
            })
        })
        const note = path.join(root, "tasks", "alpha", UBERTASK_FILENAME)
        const before = await fsp.readFile(note, "utf8")

        const second = await captureLogs(async () => {
            await open.run({
                "no-hooks": false,
                stack: undefined,
                branch: undefined,
                task: "alpha",
                from: undefined,
                goal: undefined,
                repos: undefined
            })
        })

        // Byte-identical: the no-goal re-run never rewrites the note.
        expect(await fsp.readFile(note, "utf8")).toBe(before)
        expect(second.join("\n")).toContain(
            `Skipping ${path.join("tasks", "alpha", UBERTASK_FILENAME)} — already exists`
        )
    })

    it("stamps the template seed bytes, which match the on-disk template", async () => {
        // Guards the seed asset itself: template/ubertask.yml is the committed
        // source open copies, and it carries the locked seed (comment ABOVE the
        // key, empty-array fields, a `|` block scalar for goal).
        const seed = await fsp.readFile(UBERTASK_TEMPLATE, "utf8")
        expect(seed).toBe(
            '# ubertask.yml — durable task note. The "why"; git holds the "what".\n' +
                "goal: |\n" +
                "  <one line: what done looks like & why>\n" +
                "\n" +
                "repos: []\n" +
                "\n" +
                "branches: {}\n" +
                "\n" +
                "tickets: []\n" +
                "\n" +
                "decisions: []\n" +
                "\n" +
                "blockers: []\n"
        )
    })

    it("warns and skips an uncloned repo while opening the cloned ones", async () => {
        await makeSource("api")
        // web is registered but never cloned.
        await register(["api", "web"])

        const logs = await captureLogs(async () => {
            await open.run({
                "no-hooks": false,
                stack: undefined,
                branch: undefined,
                task: "alpha",
                from: undefined,
                goal: undefined,
                repos: undefined
            })
        })

        expect(fs.existsSync(path.join(root, "tasks", "alpha", "api"))).toBe(
            true
        )
        expect(fs.existsSync(path.join(root, "tasks", "alpha", "web"))).toBe(
            false
        )
        const joined = logs.join("\n")
        expect(joined).toContain("Skipping web — not cloned")
        expect(joined).toContain("Opened task alpha in 1 repository")
    })

    it("fails fast: a later repo is not opened once one repo errors", async () => {
        await makeSource("api")
        await makeSource("web")
        // Order matters: api is first. An invalid --from makes its worktree
        // creation fail, which must abort before web is ever attempted.
        await register(["api", "web"])

        let error: unknown
        await captureLogs(async () => {
            try {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: "does-not-exist",
                    goal: undefined,
                    repos: undefined
                })
            } catch (e) {
                error = e
            }
        })

        expect(error).toBeInstanceOf(Error)
        // api failed mid-creation; web was never reached.
        expect(fs.existsSync(path.join(root, "tasks", "alpha", "web"))).toBe(
            false
        )
    })

    it("throws when no config exists in cwd or any parent", async () => {
        const orphan = await fsp.mkdtemp(path.join(os.tmpdir(), "open-orphan-"))
        process.chdir(orphan)
        try {
            let error: unknown
            try {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
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

    // The task's declared scope: the parsed repos: from its ubertask.yml.
    const scopeOf = async (task: string): Promise<string[]> => {
        const note = path.join(root, "tasks", task, UBERTASK_FILENAME)
        return parse(await fsp.readFile(note, "utf8")).repos
    }

    describe("--repos (declared scope)", () => {
        it("opens worktrees only for the named repos and persists the scope", async () => {
            await makeSource("api")
            await makeSource("web")
            await makeSource("docs")
            await register(["api", "web", "docs"])

            const logs = await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["api", "web"]
                })
            })

            // Only the named repos grew worktrees; the unnamed one did not.
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "api"))
            ).toBe(true)
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "web"))
            ).toBe(true)
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "docs"))
            ).toBe(false)
            // The scope is recorded in the note's repos:.
            expect(await scopeOf("alpha")).toEqual(["api", "web"])
            const joined = logs.join("\n")
            expect(joined).toContain("Opened task alpha in 2 repositories")
            expect(joined).toContain(
                `Seeded ${path.join("tasks", "alpha", UBERTASK_FILENAME)} (scope set)`
            )
        })

        it("--goal and --repos together seed the goal AND the scope", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])

            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: "scoped goal",
                    repos: ["api"]
                })
            })

            const note = path.join(root, "tasks", "alpha", UBERTASK_FILENAME)
            expect(parse(await fsp.readFile(note, "utf8"))).toEqual({
                goal: "scoped goal",
                repos: ["api"],
                branches: {},
                tickets: [],
                decisions: [],
                blockers: []
            })
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "web"))
            ).toBe(false)
        })

        it("fails fast on an unregistered repo and creates NOTHING", async () => {
            await makeSource("api")
            // web is registered but never cloned (that alone is fine now —
            // it would be cloned on demand); ghost was never registered, and
            // an unregistered name has no URL to clone from, so it must fail
            // loud BEFORE anything is created.
            await register(["api", "web"])

            let error: unknown
            await captureLogs(async () => {
                try {
                    await open.run({
                        "no-hooks": false,
                        stack: undefined,
                        branch: undefined,
                        task: "alpha",
                        from: undefined,
                        goal: undefined,
                        repos: ["api", "ghost"]
                    })
                } catch (e) {
                    error = e
                }
            })

            expect(error).toBeInstanceOf(Error)
            const message = (error as Error).message
            expect(message).toContain("ghost")
            expect(message).toContain("not a registered repository")
            // The error names the valid set, so a typo is self-correcting.
            expect(message).toContain("api")
            expect(message).toContain("web")
            // Nothing was created — not even the valid repo's worktree or note.
            expect(fs.existsSync(path.join(root, "tasks", "alpha"))).toBe(false)
        })

        it("is sticky: re-opening WITHOUT --repos honours the stored scope (no fan-out)", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])

            // Scope the task to api only.
            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["api"]
                })
            })
            expect(await scopeOf("alpha")).toEqual(["api"])

            // Re-open with NO --repos: must NOT fan out to web.
            const logs = await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })

            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "web"))
            ).toBe(false)
            // Scope unchanged; the note isn't rewritten (no growth, no goal).
            expect(await scopeOf("alpha")).toEqual(["api"])
            expect(logs.join("\n")).toContain(
                `Skipping ${path.join("tasks", "alpha", UBERTASK_FILENAME)} — already exists`
            )
        })

        it("unions a re-open's --repos into an existing scope (never replaces)", async () => {
            await makeSource("api")
            await makeSource("web")
            await makeSource("docs")
            await register(["api", "web", "docs"])

            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["api"]
                })
            })

            // Re-open adding web: api stays, web joins, docs still excluded.
            const logs = await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["web"]
                })
            })

            expect(await scopeOf("alpha")).toEqual(["api", "web"])
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "api"))
            ).toBe(true)
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "web"))
            ).toBe(true)
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "docs"))
            ).toBe(false)
            expect(logs.join("\n")).toContain(
                `Updated scope in ${path.join("tasks", "alpha", UBERTASK_FILENAME)}`
            )
        })

        it("an unscoped task (no --repos ever) keeps the all-cloned behaviour", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])

            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })

            // Both cloned repos opened; the recorded scope is empty (unscoped).
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "api"))
            ).toBe(true)
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "web"))
            ).toBe(true)
            expect(await scopeOf("alpha")).toEqual([])
        })

        it("is ADDITIVE: --repos on an existing UNSCOPED task never narrows it", async () => {
            await makeSource("api")
            await makeSource("web")
            await makeSource("docs")
            await register(["api", "web", "docs"])

            // First open is unscoped: every cloned repo gets a worktree, scope
            // recorded as [] (the maximal "all repos" set).
            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })
            expect(await scopeOf("alpha")).toEqual([])

            // Re-open with --repos docs: the task must STAY unscoped (not
            // collapse to [docs]) — every original worktree survives, and docs
            // (already cloned + opened) is unaffected.
            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["docs"]
                })
            })

            // All three worktrees still present — api/web were NOT stranded.
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "api"))
            ).toBe(true)
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "web"))
            ).toBe(true)
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "docs"))
            ).toBe(true)
            // Scope stays unscoped — never narrowed to just the named repo.
            expect(await scopeOf("alpha")).toEqual([])
        })

        it("clones a --repos name on demand for an existing unscoped task, staying unscoped", async () => {
            await makeSource("api")
            await makeUpstream("web") // registered, never cloned
            await register(["api", "web"])

            // Unscoped first open: only api is cloned, so only api opens.
            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "web"))
            ).toBe(false)
            expect(await scopeOf("alpha")).toEqual([])
            const { calls } = mockClone()

            // Re-open with --repos web: web is an explicit ask, so it's cloned
            // on demand and opened — but the task STAYS unscoped (scope []).
            const json = await captureJson<OpenJson>(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["web"]
                })
            })

            // web was cloned on demand and its worktree opened; api survives.
            expect(calls.map((c) => c.url)).toEqual([
                "https://github.com/acme/web.git"
            ])
            expect(
                fs.existsSync(path.join(root, "source", "web", ".git"))
            ).toBe(true)
            expect(await branchAt("web", "alpha")).toBe("task/alpha")
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "api"))
            ).toBe(true)
            expect(json.clone).toEqual([{ name: "web", status: "cloned" }])
            expect(json.repos).toEqual([
                { name: "api", status: "skipped" },
                { name: "web", status: "created" }
            ])
            // Stays unscoped in both the live JSON and the persisted note.
            expect(json.scope).toEqual([])
            expect(await scopeOf("alpha")).toEqual([])
        })

        it("GROWS a scoped task: --repos adds to the stored scope (regression guard)", async () => {
            await makeSource("api")
            await makeSource("web")
            await makeSource("db")
            await register(["api", "web", "db"])

            // Scope to [api, web] up front.
            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["api", "web"]
                })
            })
            expect(await scopeOf("alpha")).toEqual(["api", "web"])

            // Re-open with --repos db: the scope GROWS to [api, web, db].
            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["db"]
                })
            })

            expect(await scopeOf("alpha")).toEqual(["api", "web", "db"])
            for (const name of ["api", "web", "db"]) {
                expect(
                    fs.existsSync(path.join(root, "tasks", "alpha", name))
                ).toBe(true)
            }
        })

        it("a brand-new task with --repos seeds the named scope", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])

            // No prior note, no prior worktree: --repos sets the INITIAL scope.
            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["api"]
                })
            })

            expect(await scopeOf("alpha")).toEqual(["api"])
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "api"))
            ).toBe(true)
            // web is out of the seeded scope, so it gets no worktree.
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "web"))
            ).toBe(false)
        })
    })

    type OpenJson = {
        task: string
        scope: string[]
        repos: { name: string; status: string; reason?: string }[]
        clone: {
            name: string
            status: string
            reason?: string
            error?: string
        }[]
        hooks: { event: string; repo: string; exit: number }[]
        carry: {
            repo: string
            copied: string[]
            keptExisting: string[]
            skippedTracked: string[]
        }[]
        note?: {
            goal: string
            repos: string[]
            tickets: string[]
            decisions: unknown[]
            blockers: unknown[]
            mtime: number
        }
    }

    describe("clone on demand (scoped open)", () => {
        it("clones a scoped registered-but-uncloned repo, then opens it", async () => {
            await makeSource("api")
            await makeUpstream("web") // web is registered but never cloned
            await register(["api", "web"])
            const { calls } = mockClone()

            const json = await captureJson<OpenJson>(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["api", "web"]
                })
            })

            // Only the uncloned repo was cloned — api was already in source/.
            expect(calls).toEqual([
                {
                    url: "https://github.com/acme/web.git",
                    dest: path.join(root, "source", "web")
                }
            ])
            // The clone landed as a real repo, and the worktree opened off it
            // on the task branch like any other repo.
            expect(
                fs.existsSync(path.join(root, "source", "web", ".git"))
            ).toBe(true)
            expect(await branchAt("web", "alpha")).toBe("task/alpha")
            expect(json.repos).toEqual([
                { name: "api", status: "created" },
                { name: "web", status: "created" }
            ])
            // The clone phase rides its own array, in clone's per-repo shape.
            expect(json.clone).toEqual([{ name: "web", status: "cloned" }])
            expect(json.scope).toEqual(["api", "web"])
            expect(await scopeOf("alpha")).toEqual(["api", "web"])
        })

        it("never clones on an unscoped open (no --repos, empty note scope)", async () => {
            await makeSource("api")
            await makeUpstream("web")
            await register(["api", "web"])
            const { calls } = mockClone()

            const logs = await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })

            // Today's behaviour exactly: the uncloned repo is skipped with the
            // run-clone-first hint, and git.clone is never called.
            expect(calls).toEqual([])
            expect(fs.existsSync(path.join(root, "source", "web"))).toBe(false)
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "web"))
            ).toBe(false)
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "api"))
            ).toBe(true)
            expect(logs.join("\n")).toContain("Skipping web — not cloned")
        })

        it("re-open with a stored note scope clones a newly registered repo on demand", async () => {
            await makeSource("api")
            await register(["api"])
            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["api"]
                })
            })

            // web is registered AND written into the note's repos: (the
            // documented hand-edit flow) only AFTER the first open.
            await makeUpstream("web")
            await register(["api", "web"])
            const note = path.join(root, "tasks", "alpha", UBERTASK_FILENAME)
            await fsp.writeFile(
                note,
                "goal: |\n  g\n\nrepos:\n  - api\n  - web\n"
            )
            const { calls } = mockClone()

            // Re-open WITHOUT --repos: the stored scope alone triggers the
            // on-demand clone.
            const json = await captureJson<OpenJson>(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })

            expect(calls.map((c) => c.url)).toEqual([
                "https://github.com/acme/web.git"
            ])
            expect(json.repos).toEqual([
                { name: "api", status: "skipped" },
                { name: "web", status: "created" }
            ])
            expect(json.clone).toEqual([{ name: "web", status: "cloned" }])
            expect(await branchAt("web", "alpha")).toBe("task/alpha")
        })

        it("fires pre-clone and post-clone with clone's cwd/env contract", async () => {
            await makeUpstream("web")
            await registerWithHooks(["web"], {
                "pre-clone":
                    'echo "$PWD|$UBEREPO_REPO_PATH|$UBEREPO_EVENT|$UBEREPO_TASK" > "$UBEREPO_WORKSPACE/pre.txt"',
                "post-clone":
                    'echo "$PWD|$UBEREPO_TASK" > "$UBEREPO_WORKSPACE/post.txt"'
            })
            mockClone()

            const json = await captureJson<OpenJson>(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["web"]
                })
            })

            // pre-clone runs at the workspace root with UBEREPO_REPO_PATH
            // naming the would-be clone and NO task — the clone events keep
            // `uberepo clone`'s task-free env contract even when open fires
            // them.
            const pre = (
                await fsp.readFile(path.join(root, "pre.txt"), "utf8")
            ).trim()
            expect(pre).toBe(
                `${root}|${path.join(root, "source", "web")}|pre-clone|`
            )
            // post-clone runs in the fresh source clone, still task-free.
            const post = (
                await fsp.readFile(path.join(root, "post.txt"), "utf8")
            ).trim()
            expect(post).toBe(`${path.join(root, "source", "web")}|`)
            expect(json.hooks).toEqual([
                { event: "pre-clone", repo: "web", exit: 0 },
                { event: "post-clone", repo: "web", exit: 0 }
            ])
            expect(json.repos).toEqual([{ name: "web", status: "created" }])
        })

        it("carries into the fresh worktree of an on-demand clone", async () => {
            await makeUpstream("web")
            // post-clone lays an untracked .env into the fresh source clone —
            // carry must then pick it up for the worktree, proving the clone →
            // hook → open → carry ordering holds for a lazy clone.
            await registerWith(["web"], {
                carry: { web: [".env"] },
                hooks: { "post-clone": 'echo "SECRET=1" > .env' }
            })
            mockClone()

            const json = await captureJson<OpenJson>(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["web"]
                })
            })

            expect(
                await fsp.readFile(
                    path.join(root, "tasks", "alpha", "web", ".env"),
                    "utf8"
                )
            ).toBe("SECRET=1\n")
            expect(json.carry).toEqual([
                {
                    repo: "web",
                    copied: [".env"],
                    keptExisting: [],
                    skippedTracked: []
                }
            ])
        })

        it("reports a failed clone, continues with the rest, and exits non-zero", async () => {
            await makeUpstream("good")
            await register(["bad", "good"]) // both registered, neither cloned
            const { calls } = mockClone("bad")

            const previousExit = process.exitCode
            process.exitCode = undefined
            let json: OpenJson
            try {
                json = await captureJson<OpenJson>(async () => {
                    await open.run({
                        "no-hooks": false,
                        stack: undefined,
                        branch: undefined,
                        task: "alpha",
                        from: undefined,
                        goal: undefined,
                        repos: ["bad", "good"]
                    })
                })
                // The failed clone flips the exit code without aborting.
                expect(process.exitCode).toBe(1)
            } finally {
                process.exitCode = previousExit
            }
            // Both clones were attempted (per-repo resilience)...
            expect(calls.map((c) => c.url)).toEqual([
                "https://github.com/acme/bad.git",
                "https://github.com/acme/good.git"
            ])
            // ...bad carries its error, good was cloned AND opened.
            expect(json.clone).toEqual([
                {
                    name: "bad",
                    status: "failed",
                    error: "boom cloning https://github.com/acme/bad.git"
                },
                { name: "good", status: "cloned" }
            ])
            expect(json.repos).toEqual([
                { name: "bad", status: "skipped", reason: "clone failed" },
                { name: "good", status: "created" }
            ])
            expect(fs.existsSync(path.join(root, "source", "bad"))).toBe(false)
            expect(await branchAt("good", "alpha")).toBe("task/alpha")
            // The failed repo stays in the scope, so a re-run retries it.
            expect(await scopeOf("alpha")).toEqual(["bad", "good"])
        })

        it("skips a stored scope name that is not registered, without cloning", async () => {
            await makeSource("api")
            await register(["api"])
            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["api"]
                })
            })
            // The note scopes a repo that was never registered (e.g. removed
            // from the manifest after the task opened).
            const note = path.join(root, "tasks", "alpha", UBERTASK_FILENAME)
            await fsp.writeFile(
                note,
                "goal: |\n  g\n\nrepos:\n  - api\n  - gone\n"
            )
            const { calls } = mockClone()

            const json = await captureJson<OpenJson>(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })

            // Nothing to clone from — a per-repo skip, never an abort or a
            // clone attempt.
            expect(calls).toEqual([])
            expect(json.clone).toEqual([])
            expect(json.repos).toEqual([
                { name: "gone", status: "skipped", reason: "not registered" },
                { name: "api", status: "skipped" }
            ])
        })
    })

    describe("--json", () => {
        it("emits task, empty scope, created repos, and the seeded note", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])

            const json = await captureJson<OpenJson>(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })

            expect(json.task).toBe("alpha")
            expect(json.scope).toEqual([])
            expect(json.repos).toEqual([
                { name: "api", status: "created" },
                { name: "web", status: "created" }
            ])
            // No on-demand clone ran (both repos were already cloned), but the
            // key is always present, so the shape is stable.
            expect(json.clone).toEqual([])
            // A fresh task byte-copies the template seed; the JSON carries the
            // same TaskNote shape status uses (the template's placeholder goal,
            // empty lists), with a numeric mtime.
            expect(json.note).toEqual({
                goal: "<one line: what done looks like & why>",
                repos: [],
                branches: {},
                tickets: [],
                decisions: [],
                blockers: [],
                mtime: expect.any(Number)
            })
        })

        it("carries the goal, the declared scope, and a skipped re-open under --json", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])

            // First open scopes to api with a goal.
            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: "ship it",
                    repos: ["api"]
                })
            })

            // Re-open (same scope, same goal absent): api's worktree is skipped.
            const json = await captureJson<OpenJson>(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })

            expect(json.scope).toEqual(["api"])
            expect(json.repos).toEqual([{ name: "api", status: "skipped" }])
            expect(json.note?.goal).toBe("ship it")
            expect(json.note?.repos).toEqual(["api"])
        })

        it("emits empty scope/repos and no note when nothing is cloned", async () => {
            await register(["api"]) // registered, never cloned

            const json = await captureJson<OpenJson>(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })

            expect(json).toEqual({
                task: "alpha",
                scope: [],
                repos: [],
                clone: [],
                hooks: [],
                carry: []
            })
            expect(json.note).toBeUndefined()
        })
    })

    describe("hooks", () => {
        it("fires post-open ONLY for newly-created worktrees, not skipped ones", async () => {
            await makeSource("api")
            await makeSource("web")
            await registerWithHooks(["api", "web"], {
                "post-open": "touch hooked"
            })

            // First open: both worktrees created → both hooks fire.
            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })
            const apiHook = path.join(root, "tasks", "alpha", "api", "hooked")
            const webHook = path.join(root, "tasks", "alpha", "web", "hooked")
            expect(fs.existsSync(apiHook)).toBe(true)
            expect(fs.existsSync(webHook)).toBe(true)
            // Remove the sentinels so a re-fire would be detectable.
            await fsp.rm(apiHook)
            await fsp.rm(webHook)

            // Re-open: both worktrees already exist → skipped, no hook re-fires.
            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })
            expect(fs.existsSync(apiHook)).toBe(false)
            expect(fs.existsSync(webHook)).toBe(false)
        })

        it("runs the hook with cwd = the worktree and includes hooks under --json", async () => {
            await makeSource("api")
            await registerWithHooks(["api"], { "post-open": "true" })

            const json = await captureJson<OpenJson>(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })
            expect(json.hooks).toEqual([
                { event: "post-open", repo: "api", exit: 0 }
            ])
        })

        it("does not run hooks under --no-hooks", async () => {
            await makeSource("api")
            await registerWithHooks(["api"], { "post-open": "touch hooked" })

            const json = await captureJson<OpenJson>(async () => {
                await open.run({
                    "no-hooks": true,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })
            expect(json.hooks).toEqual([])
            expect(
                fs.existsSync(
                    path.join(root, "tasks", "alpha", "api", "hooked")
                )
            ).toBe(false)
        })

        it("continues past a failing hook and exits non-zero, leaving the worktree intact", async () => {
            await makeSource("api")
            await makeSource("web")
            await registerWithHooks(["api", "web"], {
                // api's hook fails; web's still runs.
                "post-open": 'test "$UBEREPO_REPO" = api && exit 1 || touch ok'
            })

            const previousExit = process.exitCode
            process.exitCode = undefined
            let json: OpenJson
            try {
                json = await captureJson<OpenJson>(async () => {
                    await open.run({
                        "no-hooks": false,
                        stack: undefined,
                        branch: undefined,
                        task: "alpha",
                        from: undefined,
                        goal: undefined,
                        repos: undefined
                    })
                })
                expect(process.exitCode).toBe(1)
            } finally {
                process.exitCode = previousExit
            }
            // Both worktrees were created (no rollback) and on the task branch.
            expect(json.repos).toEqual([
                { name: "api", status: "created" },
                { name: "web", status: "created" }
            ])
            expect(await branchAt("api", "alpha")).toBe("task/alpha")
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "api"))
            ).toBe(true)
            // The loop continued: web's hook ran after api's failure.
            expect(json.hooks).toEqual([
                { event: "post-open", repo: "api", exit: 1 },
                { event: "post-open", repo: "web", exit: 0 }
            ])
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "web", "ok"))
            ).toBe(true)
        })

        it("pre-open failure skips the repo, exits non-zero, and a re-run picks it up", async () => {
            await makeSource("api")
            await registerWithHooks(["api"], {
                // The gate holds while the block file exists.
                "pre-open": 'test ! -f "$UBEREPO_WORKSPACE/block"'
            })
            await fsp.writeFile(path.join(root, "block"), "")

            const previousExit = process.exitCode
            process.exitCode = undefined
            let json: OpenJson
            try {
                json = await captureJson<OpenJson>(async () => {
                    await open.run({
                        "no-hooks": false,
                        stack: undefined,
                        branch: undefined,
                        task: "alpha",
                        from: undefined,
                        goal: undefined,
                        repos: undefined
                    })
                })
                expect(process.exitCode).toBe(1)
            } finally {
                process.exitCode = previousExit
            }
            // The gate held: no worktree was created.
            expect(json.repos).toEqual([
                {
                    name: "api",
                    status: "skipped",
                    reason: "pre-open hook failed"
                }
            ])
            expect(json.hooks).toEqual([
                { event: "pre-open", repo: "api", exit: 1 }
            ])
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "api"))
            ).toBe(false)

            // Fix the cause and re-run: the skipped repo is picked up.
            await fsp.rm(path.join(root, "block"))
            const rerun = await captureJson<OpenJson>(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })
            expect(rerun.repos).toEqual([{ name: "api", status: "created" }])
            expect(await branchAt("api", "alpha")).toBe("task/alpha")
        })

        it("runs pre-open in the source clone with UBEREPO_REPO_PATH naming the would-be worktree", async () => {
            await makeSource("api")
            await registerWithHooks(["api"], {
                "pre-open":
                    'echo "$PWD|$UBEREPO_REPO_PATH|$UBEREPO_EVENT" > "$UBEREPO_WORKSPACE/pre.txt"'
            })
            await captureJson<OpenJson>(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })
            const line = (
                await fsp.readFile(path.join(root, "pre.txt"), "utf8")
            ).trim()
            expect(line).toBe(
                `${path.join(root, "source", "api")}|${path.join(
                    root,
                    "tasks",
                    "alpha",
                    "api"
                )}|pre-open`
            )
        })
    })

    describe("carry", () => {
        // Lay an untracked local file into a source clone (the .env that never
        // makes it into a fresh worktree).
        const localFile = async (
            name: string,
            file: string,
            contents: string
        ): Promise<void> => {
            const target = path.join(root, "source", name, file)
            await fsp.mkdir(path.dirname(target), { recursive: true })
            await fsp.writeFile(target, contents)
        }

        const openAlpha = async (): Promise<void> => {
            await open.run({
                "no-hooks": false,
                stack: undefined,
                branch: undefined,
                task: "alpha",
                from: undefined,
                goal: undefined,
                repos: undefined
            })
        }

        it("copies matching untracked files into every fresh worktree", async () => {
            await makeSource("api")
            await makeSource("web")
            await registerWith(["api", "web"], { carry: [".env*"] })
            await localFile("api", ".env", "API=1\n")
            await localFile("web", ".env", "WEB=1\n")
            await localFile("web", "notes.txt", "not carried\n")

            const json = await captureJson<OpenJson>(openAlpha)

            expect(
                await fsp.readFile(
                    path.join(root, "tasks", "alpha", "api", ".env"),
                    "utf8"
                )
            ).toBe("API=1\n")
            expect(
                await fsp.readFile(
                    path.join(root, "tasks", "alpha", "web", ".env"),
                    "utf8"
                )
            ).toBe("WEB=1\n")
            expect(
                fs.existsSync(
                    path.join(root, "tasks", "alpha", "web", "notes.txt")
                )
            ).toBe(false)
            expect(json.carry).toEqual([
                {
                    repo: "api",
                    copied: [".env"],
                    keptExisting: [],
                    skippedTracked: []
                },
                {
                    repo: "web",
                    copied: [".env"],
                    keptExisting: [],
                    skippedTracked: []
                }
            ])
        })

        it("applies each repo's patterns from the per-repo carry map", async () => {
            await makeSource("api")
            await makeSource("web")
            await registerWith(["api", "web"], {
                carry: { api: [".env", "certs/*.pem"] }
            })
            await localFile("api", ".env", "A\n")
            await localFile("api", "certs/local.pem", "PEM\n")
            // web is absent from the map, so its cert stays behind.
            await localFile("web", "certs/local.pem", "PEM\n")

            const json = await captureJson<OpenJson>(openAlpha)

            const api = path.join(root, "tasks", "alpha", "api")
            expect(fs.existsSync(path.join(api, ".env"))).toBe(true)
            expect(fs.existsSync(path.join(api, "certs", "local.pem"))).toBe(
                true
            )
            expect(
                fs.existsSync(path.join(root, "tasks", "alpha", "web", "certs"))
            ).toBe(false)
            // web is absent from the map, so it has no patterns and is omitted
            // from the carry report entirely (runCarry returns null for it).
            expect(json.carry).toEqual([
                {
                    repo: "api",
                    copied: [".env", "certs/local.pem"],
                    keptExisting: [],
                    skippedTracked: []
                }
            ])
        })

        it("carries BEFORE the post-open hook fires, so the hook sees the files", async () => {
            await makeSource("api")
            await registerWith(["api"], {
                carry: [".env"],
                // The hook can only copy .env if carry already landed it.
                hooks: { "post-open": "cp .env env-seen-by-hook" }
            })
            await localFile("api", ".env", "SECRET=1\n")

            const json = await captureJson<OpenJson>(openAlpha)

            expect(
                await fsp.readFile(
                    path.join(
                        root,
                        "tasks",
                        "alpha",
                        "api",
                        "env-seen-by-hook"
                    ),
                    "utf8"
                )
            ).toBe("SECRET=1\n")
            expect(json.hooks).toEqual([
                { event: "post-open", repo: "api", exit: 0 }
            ])
        })

        it("does NOT re-carry into an already-open (skipped) worktree", async () => {
            await makeSource("api")
            await registerWith(["api"], { carry: [".env"] })
            await localFile("api", ".env", "SECRET=1\n")

            await captureJson<OpenJson>(openAlpha)
            const carried = path.join(root, "tasks", "alpha", "api", ".env")
            expect(fs.existsSync(carried)).toBe(true)
            // Remove the carried copy; a re-open skips the worktree and must
            // leave it missing (sync is the missing-files repair).
            await fsp.rm(carried)

            const rerun = await captureJson<OpenJson>(openAlpha)
            expect(rerun.repos).toEqual([{ name: "api", status: "skipped" }])
            expect(rerun.carry).toEqual([])
            expect(fs.existsSync(carried)).toBe(false)
        })
    })

    describe("branch adoption", () => {
        // The parsed note's branches map after an open, for assertions.
        const readBranches = async (
            task: string
        ): Promise<Record<string, unknown>> => {
            const file = path.join(root, "tasks", task, UBERTASK_FILENAME)
            return parse(await fsp.readFile(file, "utf8")).branches
        }

        it("adopts a PRE-EXISTING local branch (no -b) and records it adopted, no base", async () => {
            await makeSource("api")
            await register(["api"])
            // A branch that already exists in the source clone — open must
            // attach to it, not recreate it. No gh here, so no base discovered.
            await sh(
                path.join(root, "source", "api"),
                "branch",
                "feature/x",
                "main"
            )

            const logs = await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: ["api=feature/x"],
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })

            // The worktree is checked out ON the adopted branch.
            expect(await branchAt("api", "alpha")).toBe("feature/x")
            expect(logs.join("\n")).toContain("adopting feature/x")
            // Recorded adopted with no base (no PR was found).
            expect(await readBranches("alpha")).toEqual({
                api: { name: "feature/x", adopted: true }
            })
        })

        it("creates task/<task> when the --branch name does not exist yet", async () => {
            await makeSource("api")
            await register(["api"])

            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: ["api=feature/new"],
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })

            // A fresh branch was cut at the --branch name; recorded NOT adopted,
            // no base — so it persists (a non-default name is branch-worthy).
            expect(await branchAt("api", "alpha")).toBe("feature/new")
            expect(await readBranches("alpha")).toEqual({
                api: { name: "feature/new", adopted: false }
            })
        })

        it("discovers the base from the adopted head's open PR (baseRefName)", async () => {
            await makeSource("api")
            await register(["api"])
            await sh(
                path.join(root, "source", "api"),
                "branch",
                "feature/x",
                "main"
            )
            // Stub gh: available, and `pr view <head>` reports a base of develop.
            const fake: Gh = async (args) => {
                if (args[0] === "--version") {
                    return "gh 2.0.0"
                }
                return JSON.stringify({
                    number: 5,
                    url: "https://github.com/acme/api/pull/5",
                    isDraft: true,
                    state: "OPEN",
                    baseRefName: "develop"
                })
            }
            setGh(fake)

            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: ["api=feature/x"],
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })

            // The discovered PR base AND url are persisted alongside the
            // adopted branch (status reads the pr link offline).
            expect(await readBranches("alpha")).toEqual({
                api: {
                    name: "feature/x",
                    adopted: true,
                    base: "develop",
                    pr: "https://github.com/acme/api/pull/5"
                }
            })
        })

        it("a plain open (no --branch) records NO branches map (legacy bytes preserved)", async () => {
            await makeSource("api")
            await register(["api"])

            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })

            // task/<task> created, nothing branch-worthy → the note has no
            // branches recorded (branchFor falls back to task/<task>).
            expect(await branchAt("api", "alpha")).toBe("task/alpha")
            expect(await readBranches("alpha")).toEqual({})
        })

        it("errors when --branch names a repo outside the open's scope", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])

            await expect(
                open.run({
                    "no-hooks": false,
                    stack: undefined,
                    // Scope is api only, but a branch is named for web.
                    branch: ["web=feature/x"],
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["api"]
                })
            ).rejects.toThrow("names a repo outside this open's scope")
            // Nothing was opened — the guard fired before any worktree.
            expect(fs.existsSync(path.join(root, "tasks", "alpha"))).toBe(false)
        })

        it("a bare --branch name applies to every in-scope repo", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])

            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: ["shared/feature"],
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })

            expect(await branchAt("api", "alpha")).toBe("shared/feature")
            expect(await branchAt("web", "alpha")).toBe("shared/feature")
        })
    })

    describe("aliased participants (multiple branches per repo)", () => {
        const readBranches = async (
            task: string
        ): Promise<Record<string, unknown>> => {
            const file = path.join(root, "tasks", task, UBERTASK_FILENAME)
            return parse(await fsp.readFile(file, "utf8")).branches
        }

        it("opens TWO worktrees of one repo as distinct aliased folders + branches", async () => {
            await makeSource("autopilot")
            await register(["autopilot"])

            const logs = await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["autopilot@bug-fix", "autopilot@add-feature"]
                })
            })

            // Two flat folders under the one task, each its own branch.
            for (const [alias, branch] of [
                ["bug-fix", "task/alpha@bug-fix"],
                ["add-feature", "task/alpha@add-feature"]
            ]) {
                const dir = path.join(
                    root,
                    "tasks",
                    "alpha",
                    `autopilot@${alias}`
                )
                expect(fs.existsSync(dir)).toBe(true)
                expect(await branchAt(`autopilot@${alias}`, "alpha")).toBe(
                    branch
                )
            }
            // ONE shared source clone (never per-participant).
            expect(fs.existsSync(path.join(root, "source", "autopilot"))).toBe(
                true
            )
            // The note's scope is the participant list (repo-qualified).
            expect(await scopeOf("alpha")).toEqual([
                "autopilot@bug-fix",
                "autopilot@add-feature"
            ])
            // Plain aliased participants on their default record NO branches
            // entry — branchFor reconstructs task/<task>@<alias> from the token.
            expect(await readBranches("alpha")).toEqual({})
            expect(logs.join("\n")).toContain(
                "Opened task alpha in 2 repositories"
            )
        })

        it("mixes a bare repo and an aliased participant of the SAME repo in one task", async () => {
            await makeSource("autopilot")
            await makeSource("web")
            await register(["autopilot", "web"])

            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["autopilot", "autopilot@hotfix", "web"]
                })
            })

            // Bare autopilot → task/alpha; aliased → task/alpha@hotfix; both
            // share source/autopilot. web is its own bare participant.
            expect(await branchAt("autopilot", "alpha")).toBe("task/alpha")
            expect(await branchAt("autopilot@hotfix", "alpha")).toBe(
                "task/alpha@hotfix"
            )
            expect(await branchAt("web", "alpha")).toBe("task/alpha")
            expect(await scopeOf("alpha")).toEqual([
                "autopilot",
                "autopilot@hotfix",
                "web"
            ])
        })

        it("--branch overrides one participant's branch, keyed by the full token", async () => {
            await makeSource("autopilot")
            await register(["autopilot"])
            // A pre-existing branch the bug-fix participant should ADOPT.
            await sh(
                path.join(root, "source", "autopilot"),
                "branch",
                "fix/login",
                "main"
            )

            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: ["autopilot@bug-fix=fix/login"],
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["autopilot@bug-fix", "autopilot@add-feature"]
                })
            })

            // bug-fix adopted the pre-existing branch; add-feature stayed on its
            // aliased default. The branches map keys by the full participant.
            expect(await branchAt("autopilot@bug-fix", "alpha")).toBe(
                "fix/login"
            )
            expect(await branchAt("autopilot@add-feature", "alpha")).toBe(
                "task/alpha@add-feature"
            )
            expect(await readBranches("alpha")).toEqual({
                "autopilot@bug-fix": { name: "fix/login", adopted: true }
            })
        })

        it("is idempotent per participant: re-opening skips an existing aliased worktree, opens a new one", async () => {
            await makeSource("autopilot")
            await register(["autopilot"])

            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["autopilot@bug-fix"]
                })
            })

            // Re-open ADDING a second alias: bug-fix is skipped (already open),
            // add-feature is created. Scope unions the new participant in.
            const logs = await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["autopilot@add-feature"]
                })
            })

            const joined = logs.join("\n")
            expect(joined).toContain(
                "autopilot@bug-fix — worktree already open"
            )
            expect(joined).toContain("Opened task alpha in 1 repository")
            expect(await branchAt("autopilot@add-feature", "alpha")).toBe(
                "task/alpha@add-feature"
            )
            expect(await scopeOf("alpha")).toEqual([
                "autopilot@bug-fix",
                "autopilot@add-feature"
            ])
        })

        it("rejects an invalid alias (glob char) before creating anything", async () => {
            await makeSource("autopilot")
            await register(["autopilot"])

            await expect(
                open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["autopilot@bad*alias"]
                })
            ).rejects.toThrow("glob characters")
            expect(fs.existsSync(path.join(root, "tasks", "alpha"))).toBe(false)
        })

        it("rejects two participants differing only in case before creating anything", async () => {
            await makeSource("autopilot")
            await register(["autopilot"])

            await expect(
                open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["autopilot@Fix", "autopilot@fix"]
                })
            ).rejects.toThrow("differ only in case")
            expect(fs.existsSync(path.join(root, "tasks", "alpha"))).toBe(false)
        })
    })

    describe("--stack (declaring a sibling stack edge)", () => {
        const readBranches = async (
            task: string
        ): Promise<Record<string, unknown>> => {
            const file = path.join(root, "tasks", task, UBERTASK_FILENAME)
            return parse(await fsp.readFile(file, "utf8")).branches
        }

        it("writes the child's base to the parent participant token", async () => {
            await makeSource("web")
            await register(["web"])

            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: ["web@logos=web@strings"],
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["web@strings", "web@logos"]
                })
            })

            // The child's stored base IS the parent's token — the sibling edge.
            const branches = await readBranches("alpha")
            expect(branches["web@logos"]).toEqual({
                name: "task/alpha@logos",
                adopted: false,
                base: "web@strings"
            })
            // The parent (a root on its plain default) records nothing.
            expect(branches["web@strings"]).toBeUndefined()
            // Both worktrees landed on their aliased defaults.
            expect(await branchAt("web@strings", "alpha")).toBe(
                "task/alpha@strings"
            )
            expect(await branchAt("web@logos", "alpha")).toBe(
                "task/alpha@logos"
            )
        })

        it("persists a --stack-only participant on its DEFAULT branch (base keeps it)", async () => {
            // The child is on its plain aliased default — normally dropped from
            // the branches map — but the recorded base must keep it.
            await makeSource("web")
            await register(["web"])

            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: ["web@logos=web@strings"],
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["web@strings", "web@logos"]
                })
            })

            const branches = await readBranches("alpha")
            expect(Object.keys(branches)).toEqual(["web@logos"])
            expect(branches["web@logos"]).toMatchObject({
                base: "web@strings"
            })
        })

        it("is idempotent: re-opening with the same --stack leaves the edge unchanged", async () => {
            await makeSource("web")
            await register(["web"])
            const argv = {
                "no-hooks": false,
                stack: ["web@logos=web@strings"],
                branch: undefined,
                task: "alpha",
                from: undefined,
                goal: undefined,
                repos: ["web@strings", "web@logos"]
            }
            await captureLogs(async () => {
                await open.run(argv)
            })
            const first = await readBranches("alpha")

            // Re-run identically: nothing re-opens, the edge stays put.
            await captureLogs(async () => {
                await open.run(argv)
            })
            expect(await readBranches("alpha")).toEqual(first)
        })

        it("is additive on re-open: a new --stack edge lands without re-opening", async () => {
            await makeSource("web")
            await register(["web"])
            // First open: three participants, no edges yet.
            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: undefined,
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["web@strings", "web@logos", "web@api"]
                })
            })
            expect(await readBranches("alpha")).toEqual({})

            // Re-open declaring an edge: every worktree is already open, so the
            // edge is applied purely from the note merge (the child is skipped).
            const logs = await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: ["web@logos=web@strings"],
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            })
            expect(logs.join("\n")).toContain(
                "web@logos — worktree already open"
            )
            // The new edge persisted even though nothing was created.
            const branches = await readBranches("alpha")
            expect(branches["web@logos"]).toMatchObject({
                name: "task/alpha@logos",
                base: "web@strings"
            })
        })

        it("an explicit --stack OVERRIDES an adopt-discovered base for the same child", async () => {
            await makeSource("web")
            await register(["web"])
            // A pre-existing branch the logos participant adopts; its open PR
            // reports a base of develop (a remote ref).
            await sh(
                path.join(root, "source", "web"),
                "branch",
                "feat/logos",
                "main"
            )
            const fake: Gh = async (args) => {
                if (args[0] === "--version") {
                    return "gh 2.0.0"
                }
                return JSON.stringify({
                    number: 7,
                    url: "https://github.com/acme/web/pull/7",
                    isDraft: true,
                    state: "OPEN",
                    baseRefName: "develop"
                })
            }
            setGh(fake)

            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    // logos adopts feat/logos (base develop discovered), but
                    // --stack re-points it at the sibling web@strings.
                    branch: ["web@logos=feat/logos"],
                    stack: ["web@logos=web@strings"],
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["web@strings", "web@logos"]
                })
            })

            // The sibling edge WON — the discovered `develop` was overridden.
            expect(await readBranches("alpha")).toMatchObject({
                "web@logos": {
                    name: "feat/logos",
                    adopted: true,
                    base: "web@strings"
                }
            })
        })

        it("rejects a cross-repo edge before creating anything", async () => {
            await makeSource("web")
            await makeSource("api")
            await register(["web", "api"])

            await expect(
                open.run({
                    "no-hooks": false,
                    stack: ["web@logos=api"],
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["web@logos", "api"]
                })
            ).rejects.toThrow("stacks across repositories")
            expect(fs.existsSync(path.join(root, "tasks", "alpha"))).toBe(false)
        })

        it("rejects an out-of-scope parent before creating anything", async () => {
            await makeSource("web")
            await register(["web"])

            await expect(
                open.run({
                    "no-hooks": false,
                    // web@strings is not in this open's scope.
                    stack: ["web@logos=web@strings"],
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["web@logos"]
                })
            ).rejects.toThrow("names a parent outside this task's scope")
            expect(fs.existsSync(path.join(root, "tasks", "alpha"))).toBe(false)
        })

        it("rejects a self-edge before creating anything", async () => {
            await makeSource("web")
            await register(["web"])

            await expect(
                open.run({
                    "no-hooks": false,
                    stack: ["web@logos=web@logos"],
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["web@logos"]
                })
            ).rejects.toThrow("stack on its own branch")
            expect(fs.existsSync(path.join(root, "tasks", "alpha"))).toBe(false)
        })

        it("rejects a cycle that closes across two opens", async () => {
            await makeSource("web")
            await register(["web"])
            // First open declares strings → logos.
            await captureLogs(async () => {
                await open.run({
                    "no-hooks": false,
                    stack: ["web@strings=web@logos"],
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: ["web@strings", "web@logos"]
                })
            })

            // Re-open declaring logos → strings closes the ring — caught against
            // the merged stored+new graph.
            await expect(
                open.run({
                    "no-hooks": false,
                    stack: ["web@logos=web@strings"],
                    branch: undefined,
                    task: "alpha",
                    from: undefined,
                    goal: undefined,
                    repos: undefined
                })
            ).rejects.toThrow("would create a cycle")
        })
    })
})
