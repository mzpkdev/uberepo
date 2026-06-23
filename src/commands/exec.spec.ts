import { execFile } from "node:child_process"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { execute, terminal } from "cmdore"
import { vi } from "vitest"
import exec from "@/commands/exec"
import { CONFIG_FILENAME } from "@/config"

const run = promisify(execFile)

// ── JSON / output capture (same pattern as the other command specs) ──

// Run `fn` with jsonMode on, returning the single parsed JSON object the
// command wrote to stdout. jsonMode is reset in finally before any assertion
// can throw, so a failing expect() never leaks it into sibling suites.
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

// Capture terminal.log/warn/error for the duration of `fn`, then restore. exec
// uses log for the per-repo headers, warn for the empty guard, and error for
// the failure summary.
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

// Run a git command directly (NOT the wrapper under test) so setup/assertions
// stay independent of git.ts.
const sh = async (cwd: string, ...args: string[]): Promise<string> => {
    const { stdout } = await run("git", args, { cwd })
    return stdout.trim()
}

// Argv defaults so each test sets only what it cares about.
const argv = (over: Partial<Parameters<typeof exec.run>[0]> = {}) => ({
    task: "alpha",
    command: ["true"],
    repos: undefined,
    bail: false,
    ...over
})

describe("exec command", () => {
    let tmp: string
    let root: string
    let cwd: string
    let configPath: string

    // Build a fresh uberepo workspace and chdir into it. `root` is the realpath
    // because macOS canonicalises /var -> /private/var and git reports worktree
    // paths under the realpath (exec spawns in worktreePath, which must match).
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "exec-spec-"))
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

    // A real source repo at source/<name> with one commit on main.
    const makeSource = async (name: string): Promise<string> => {
        const dir = path.join(root, "source", name)
        await fsp.mkdir(dir, { recursive: true })
        await sh(dir, "init", "--initial-branch=main")
        await sh(dir, "config", "user.email", "test@example.com")
        await sh(dir, "config", "user.name", "Test User")
        await fsp.writeFile(path.join(dir, "README.md"), `${name}\n`)
        await sh(dir, "add", "README.md")
        await sh(dir, "commit", "-m", "initial commit")
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

    // Add an aliased worktree for `task` on branch task/<task>@<alias> — the
    // on-disk shape open produces for an aliased participant.
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

    // Write a ubertask.yml at the task level declaring a scope (repos: owned).
    const writeNote = async (task: string, yaml: string): Promise<void> => {
        const dir = path.join(root, "tasks", task)
        await fsp.mkdir(dir, { recursive: true })
        await fsp.writeFile(path.join(dir, "ubertask.yml"), yaml)
    }

    type ExecJson = {
        task: string
        command: string[]
        repos: {
            name: string
            branch: string
            exitCode?: number
            status: string
            stdout?: string
            stderr?: string
        }[]
    }

    // ── Real-worktree happy path ──

    it("runs the command in every worktree, capturing per-repo stdout + exitCode", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        const apiWt = await openWorktree("api", "alpha")
        const webWt = await openWorktree("web", "alpha")

        // A harmless command that prints its own cwd, proving exec spawned IN
        // each worktree (not the workspace root or a shared dir).
        const json = await captureJson<ExecJson>(async () => {
            await exec.run(
                argv({
                    command: [
                        "node",
                        "-e",
                        "require('node:fs').writeSync(1, process.cwd())"
                    ]
                })
            )
        })

        expect(json.task).toBe("alpha")
        expect(json.command).toEqual([
            "node",
            "-e",
            "require('node:fs').writeSync(1, process.cwd())"
        ])
        const api = json.repos.find((r) => r.name === "api")
        const web = json.repos.find((r) => r.name === "web")
        expect(api).toMatchObject({
            name: "api",
            branch: "task/alpha",
            exitCode: 0,
            status: "ok",
            stdout: apiWt,
            stderr: ""
        })
        expect(web).toMatchObject({
            name: "web",
            branch: "task/alpha",
            exitCode: 0,
            status: "ok",
            stdout: webWt
        })
    })

    it("the spawned command sees the branch via the UBEREPO_* environment", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")

        // The command echoes the env exec injects (the same names hooks use),
        // proving the task context reaches the child process.
        const json = await captureJson<ExecJson>(async () => {
            await exec.run(
                argv({
                    command: [
                        "node",
                        "-e",
                        "const e = process.env; require('node:fs').writeSync(1, [e.UBEREPO_TASK, e.UBEREPO_REPO, e.UBEREPO_BRANCH].join('|'))"
                    ]
                })
            )
        })
        expect(json.repos[0].stdout).toBe("alpha|api|task/alpha")
    })

    it("runs the real git rev-parse in each worktree (reports each branch)", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")

        const json = await captureJson<ExecJson>(async () => {
            await exec.run(
                argv({
                    command: ["git", "rev-parse", "--abbrev-ref", "HEAD"]
                })
            )
        })
        // Each child resolved its OWN worktree's branch.
        for (const repo of json.repos) {
            expect(repo.status).toBe("ok")
            expect(repo.stdout?.trim()).toBe("task/alpha")
        }
    })

    // ── Failure case ──

    it("one repo's command fails → that repo failed, the rest still ran, exit non-zero", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")

        // api's command exits 3; web's exits 0. exec must run BOTH (no --bail)
        // and flip the process exit code.
        const prev = process.exitCode
        process.exitCode = undefined
        let json: ExecJson
        try {
            json = await captureJson<ExecJson>(async () => {
                await exec.run(
                    argv({
                        command: [
                            "node",
                            "-e",
                            "process.exit(process.env.UBEREPO_REPO === 'api' ? 3 : 0)"
                        ]
                    })
                )
            })
            expect(process.exitCode).toBe(1)
        } finally {
            process.exitCode = prev
        }
        const api = json.repos.find((r) => r.name === "api")
        const web = json.repos.find((r) => r.name === "web")
        expect(api).toMatchObject({ status: "failed", exitCode: 3 })
        // web still ran after api's failure (continue-on-fail).
        expect(web).toMatchObject({ status: "ok", exitCode: 0 })
    })

    it("a non-existent program is a failed run (exitCode 1), not a crash", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")

        const prev = process.exitCode
        process.exitCode = undefined
        let json: ExecJson
        try {
            json = await captureJson<ExecJson>(async () => {
                await exec.run(
                    argv({ command: ["definitely-not-a-real-binary-xyz"] })
                )
            })
            expect(process.exitCode).toBe(1)
        } finally {
            process.exitCode = prev
        }
        expect(json.repos[0]).toMatchObject({ status: "failed", exitCode: 1 })
        // The spawn error surfaced on the captured stderr (so JSON mode says why).
        expect(json.repos[0].stderr).not.toBe("")
    })

    // ── --bail ──

    it("--bail stops after the first failing repo (later repos never run)", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")

        // api sorts first and fails; with --bail, web must never run, so its
        // marker file is never written.
        const prev = process.exitCode
        process.exitCode = undefined
        let json: ExecJson
        try {
            json = await captureJson<ExecJson>(async () => {
                await exec.run(
                    argv({
                        bail: true,
                        command: [
                            "node",
                            "-e",
                            "require('fs').writeFileSync('ran.txt','x'); process.exit(process.env.UBEREPO_REPO === 'api' ? 1 : 0)"
                        ]
                    })
                )
            })
            expect(process.exitCode).toBe(1)
        } finally {
            process.exitCode = prev
        }
        // Only api appears in the results — the loop broke before web.
        expect(json.repos.map((r) => r.name)).toEqual(["api"])
        expect(json.repos[0].status).toBe("failed")
        // api's command ran (wrote its marker); web's did not.
        await expect(
            fsp.stat(path.join(root, "tasks", "alpha", "api", "ran.txt"))
        ).resolves.toBeTruthy()
        await expect(
            fsp.stat(path.join(root, "tasks", "alpha", "web", "ran.txt"))
        ).rejects.toBeTruthy()
    })

    // ── --repos filter ──

    it("--repos narrows the targets to a subset (the other repo is untouched)", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")

        const json = await captureJson<ExecJson>(async () => {
            await exec.run(
                argv({
                    repos: ["api"],
                    command: [
                        "node",
                        "-e",
                        "require('fs').writeFileSync('ran.txt','x')"
                    ]
                })
            )
        })
        expect(json.repos.map((r) => r.name)).toEqual(["api"])
        // web's worktree was never run in.
        await expect(
            fsp.stat(path.join(root, "tasks", "alpha", "web", "ran.txt"))
        ).rejects.toBeTruthy()
    })

    it("--repos with a name outside the task errors before running anything", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")

        await expect(
            exec.run(
                argv({
                    repos: ["ghost"],
                    command: [
                        "node",
                        "-e",
                        "require('fs').writeFileSync('ran.txt','x')"
                    ]
                })
            )
        ).rejects.toThrow(/ghost is not a repo in task alpha/)
        // Nothing ran in api either (fail before the fan-out).
        await expect(
            fsp.stat(path.join(root, "tasks", "alpha", "api", "ran.txt"))
        ).rejects.toBeTruthy()
    })

    it("honours the task's declared scope as the universe", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        await openWorktree("web", "alpha")
        // Scope owns api only; web's worktree is out of scope for exec.
        await writeNote("alpha", "goal: |\n  g\nrepos:\n  - api\n")

        const json = await captureJson<ExecJson>(async () => {
            await exec.run(argv({ command: ["true"] }))
        })
        expect(json.repos.map((r) => r.name)).toEqual(["api"])
    })

    // ── Empty / guard paths ──

    it("throws when no command is given (reminds of the `--` shape)", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")

        await expect(exec.run(argv({ command: [] }))).rejects.toThrow(
            /exec needs a command — uberepo exec alpha -- <cmd>/
        )
    })

    it("warns and emits empty repos when the task has no worktrees", async () => {
        await makeSource("api")
        await register(["api"])

        let json: ExecJson | undefined
        const { warnings } = await captureOutput(async () => {
            json = await captureJson<ExecJson>(async () => {
                await exec.run(argv({ task: "ghost", command: ["true"] }))
            })
        })
        expect(json).toEqual({ task: "ghost", command: ["true"], repos: [] })
        expect(warnings.join("\n")).toContain("Nothing to run for task ghost.")
    })

    it("a scoped repo with no worktree never enters the run (universe ∩ present, like ship)", async () => {
        await makeSource("api")
        await makeSource("web")
        await register(["api", "web"])
        await openWorktree("api", "alpha")
        // web is in scope but was never opened. exec's universe is the scope
        // INTERSECTED with the present participants (mirroring ship), so a
        // scoped-but-absent repo is filtered out before the fan-out — it is not
        // a target and does not appear in the results.
        await writeNote("alpha", "goal: |\n  g\nrepos:\n  - api\n  - web\n")

        const json = await captureJson<ExecJson>(async () => {
            await exec.run(argv({ command: ["true"] }))
        })
        expect(json.repos).toEqual([
            {
                name: "api",
                branch: "task/alpha",
                exitCode: 0,
                status: "ok",
                stdout: "",
                stderr: ""
            }
        ])
    })

    // ── config guard ──

    it("throws when no config exists in cwd or any parent", async () => {
        const orphan = await fsp.mkdtemp(path.join(os.tmpdir(), "exec-orphan-"))
        process.chdir(orphan)
        try {
            await expect(exec.run(argv())).rejects.toThrow(CONFIG_FILENAME)
        } finally {
            process.chdir(root)
            await fsp.rm(orphan, { recursive: true, force: true })
        }
    })

    // ── Human-mode header ──

    it("prints a per-repo header in human mode (the command streams beneath it)", async () => {
        await makeSource("api")
        await register(["api"])
        await openWorktree("api", "alpha")

        const { logs } = await captureOutput(async () => {
            await exec.run(argv({ command: ["true"] }))
        })
        // The header names the repo and the joined command, the way ▸ marks it.
        expect(logs.join("\n")).toContain("▸ api  $ true")
    })

    // ── aliased participants ──

    it("runs in EACH participant of one repo (two branches, one source)", async () => {
        await makeSource("autopilot")
        await register(["autopilot"])
        await openAliased("autopilot", "alpha", "bug-fix")
        await openAliased("autopilot", "alpha", "add-feature")
        await writeNote(
            "alpha",
            "goal: |\n  two PRs\n\nrepos:\n  - autopilot@bug-fix\n  - autopilot@add-feature\n"
        )

        const json = await captureJson<ExecJson>(async () => {
            await exec.run(
                argv({
                    command: ["git", "rev-parse", "--abbrev-ref", "HEAD"]
                })
            )
        })
        // Each participant ran on its OWN aliased branch, in scope order.
        expect(
            json.repos.map((r) => [r.name, r.branch, r.stdout?.trim()])
        ).toEqual([
            ["autopilot@bug-fix", "task/alpha@bug-fix", "task/alpha@bug-fix"],
            [
                "autopilot@add-feature",
                "task/alpha@add-feature",
                "task/alpha@add-feature"
            ]
        ])
    })

    // ── The `--` parsing proof (the ONLY path that exercises argvex) ──
    //
    // Direct exec.run({...}) calls hand `command` in already-split — they never
    // touch the argument parser. This drives the WHOLE pipeline through cmdore's
    // execute(): argvex strips `--`, drops the trailing tokens into the operands,
    // and execute's positionalOperands.slice(i) hands them to the variadic
    // `command` argument. Asserting the command actually RAN in the worktree is
    // the only genuine proof the `--` flow captured it.
    describe("`--` parsing via execute()", () => {
        const metadata = { name: "uberepo", version: "0.0.0", description: "" }

        it("captures the post-`--` tokens as the command and runs them", async () => {
            await makeSource("api")
            await register(["api"])
            await openWorktree("api", "alpha")

            const json = await captureJson<ExecJson>(async () => {
                await execute([exec], {
                    argv: [
                        "exec",
                        "alpha",
                        "--",
                        "git",
                        "rev-parse",
                        "--abbrev-ref",
                        "HEAD"
                    ],
                    metadata,
                    onError: "throw"
                })
            })
            // The command was captured verbatim (note: `--abbrev-ref` survived
            // the parse as a command token, NOT as one of exec's flags)...
            expect(json.command).toEqual([
                "git",
                "rev-parse",
                "--abbrev-ref",
                "HEAD"
            ])
            // ...and it really ran in the worktree, resolving its branch.
            expect(json.repos[0].status).toBe("ok")
            expect(json.repos[0].stdout?.trim()).toBe("task/alpha")
        })

        it("parses exec's flags BEFORE `--` and the command AFTER it", async () => {
            await makeSource("api")
            await makeSource("web")
            await register(["api", "web"])
            await openWorktree("api", "alpha")
            await openWorktree("web", "alpha")

            // --repos api is exec's own flag (before --); the rest is the command.
            const json = await captureJson<ExecJson>(async () => {
                await execute([exec], {
                    argv: [
                        "exec",
                        "alpha",
                        "--repos",
                        "api",
                        "--",
                        "git",
                        "rev-parse",
                        "--abbrev-ref",
                        "HEAD"
                    ],
                    metadata,
                    onError: "throw"
                })
            })
            // The filter narrowed to api; the command parsed cleanly past `--`.
            expect(json.repos.map((r) => r.name)).toEqual(["api"])
            expect(json.command).toEqual([
                "git",
                "rev-parse",
                "--abbrev-ref",
                "HEAD"
            ])
        })

        it("throws the pointed empty-command error when nothing follows the task", async () => {
            await makeSource("api")
            await register(["api"])
            await openWorktree("api", "alpha")

            await expect(
                execute([exec], {
                    argv: ["exec", "alpha"],
                    metadata,
                    onError: "throw"
                })
            ).rejects.toThrow(/exec needs a command/)
        })
    })
})
