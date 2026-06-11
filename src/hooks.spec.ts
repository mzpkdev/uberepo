import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { terminal } from "cmdore"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { UberepoConfig } from "@/config"
import { runHook } from "@/hooks"

// The runner shells out for real, so each test gets a real temp "repo" dir to
// use as cwd and a sentinel path the hook command writes into — proving cwd and
// the UBEREPO_* env without depending on git. stdio is inherited in human mode,
// so commands always redirect their own output to a file (never stdout) to keep
// the test runner's output clean.
describe("runHook", () => {
    let tmp: string
    let repoPath: string

    // A config carrying just the hooks map under test (repositories is unused by
    // the runner, which only reads config.hooks).
    const configWith = (hooks: UberepoConfig["hooks"]): UberepoConfig => ({
        repositories: [],
        hooks
    })

    beforeEach(async () => {
        tmp = await fsp.realpath(
            await fsp.mkdtemp(path.join(os.tmpdir(), "hooks-spec-"))
        )
        repoPath = path.join(tmp, "repo")
        await fsp.mkdir(repoPath, { recursive: true })
    })

    afterEach(async () => {
        terminal.jsonMode = false
        delete process.env.UBEREPO_NO_HOOKS
        vi.restoreAllMocks()
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    // Silence the runner's human log/error lines for the duration of `fn`.
    const quiet = async (fn: () => Promise<void>): Promise<void> => {
        const log = terminal.log
        const error = terminal.error
        terminal.log = () => {}
        terminal.error = () => {}
        try {
            await fn()
        } finally {
            terminal.log = log
            terminal.error = error
        }
    }

    it("returns null and runs nothing when the event has no hook", async () => {
        const result = await runHook("post-clone", {
            config: configWith({ "post-open": "touch ran" }),
            workspace: tmp,
            repo: { name: "api", path: repoPath, url: "u" }
        })
        expect(result).toBeNull()
        // The post-open command must NOT have fired (wrong event).
        await expect(fsp.stat(path.join(repoPath, "ran"))).rejects.toThrow()
    })

    it("runs the command in ctx.repo.path (cwd) and reports exit 0", async () => {
        let result: Awaited<ReturnType<typeof runHook>> = null
        await quiet(async () => {
            result = await runHook("post-clone", {
                config: configWith({ "post-clone": "touch sentinel.txt" }),
                workspace: tmp,
                repo: { name: "api", path: repoPath, url: "u" }
            })
        })
        // The relative `touch` landed inside the repo dir → cwd was repoPath.
        const stat = await fsp.stat(path.join(repoPath, "sentinel.txt"))
        expect(stat.isFile()).toBe(true)
        expect(result).toEqual({
            event: "post-clone",
            repo: "api",
            exit: 0
        })
    })

    it("passes the UBEREPO_* env vars to the hook", async () => {
        const out = path.join(tmp, "env.txt")
        // Dump the public env contract to a file (one var per line) so we can
        // read back exactly what the hook saw.
        const command = [
            `printf '%s\\n'`,
            `"$UBEREPO_EVENT"`,
            `"$UBEREPO_TASK"`,
            `"$UBEREPO_REPO"`,
            `"$UBEREPO_REPO_PATH"`,
            `"$UBEREPO_REPO_URL"`,
            `"$UBEREPO_BRANCH"`,
            `"$UBEREPO_WORKSPACE"`,
            `> "${out}"`
        ].join(" ")
        await quiet(async () => {
            await runHook("post-sync", {
                config: configWith({ "post-sync": command }),
                workspace: tmp,
                task: "alpha",
                repo: {
                    name: "api",
                    path: repoPath,
                    url: "git@github.com:acme/api.git",
                    branch: "task/alpha"
                }
            })
        })
        const lines = (await fsp.readFile(out, "utf8")).split("\n")
        expect(lines.slice(0, 7)).toEqual([
            "post-sync",
            "alpha",
            "api",
            repoPath,
            "git@github.com:acme/api.git",
            "task/alpha",
            tmp
        ])
    })

    it("leaves UBEREPO_TASK and UBEREPO_BRANCH empty when absent (post-clone)", async () => {
        const out = path.join(tmp, "env.txt")
        const command = `printf '[%s][%s]\\n' "$UBEREPO_TASK" "$UBEREPO_BRANCH" > "${out}"`
        await quiet(async () => {
            await runHook("post-clone", {
                config: configWith({ "post-clone": command }),
                workspace: tmp,
                repo: { name: "api", path: repoPath, url: "u" }
            })
        })
        expect((await fsp.readFile(out, "utf8")).trim()).toBe("[][]")
    })

    it("captures a non-zero exit without throwing", async () => {
        let result: Awaited<ReturnType<typeof runHook>> = null
        await quiet(async () => {
            result = await runHook("post-clone", {
                config: configWith({ "post-clone": "exit 3" }),
                workspace: tmp,
                repo: { name: "api", path: repoPath, url: "u" }
            })
        })
        expect(result).toEqual({ event: "post-clone", repo: "api", exit: 3 })
    })

    it("no-ops (returns null, runs nothing) when noHooks is set", async () => {
        const result = await runHook("post-clone", {
            config: configWith({ "post-clone": "touch ran" }),
            workspace: tmp,
            repo: { name: "api", path: repoPath, url: "u" },
            noHooks: true
        })
        expect(result).toBeNull()
        await expect(fsp.stat(path.join(repoPath, "ran"))).rejects.toThrow()
    })

    it("no-ops when UBEREPO_NO_HOOKS is set in the env", async () => {
        process.env.UBEREPO_NO_HOOKS = "1"
        const result = await runHook("post-clone", {
            config: configWith({ "post-clone": "touch ran" }),
            workspace: tmp,
            repo: { name: "api", path: repoPath, url: "u" }
        })
        expect(result).toBeNull()
        await expect(fsp.stat(path.join(repoPath, "ran"))).rejects.toThrow()
    })

    it("runs normally when UBEREPO_NO_HOOKS is set but empty", async () => {
        process.env.UBEREPO_NO_HOOKS = ""
        await quiet(async () => {
            const result = await runHook("post-clone", {
                config: configWith({ "post-clone": "touch ran" }),
                workspace: tmp,
                repo: { name: "api", path: repoPath, url: "u" }
            })
            expect(result?.exit).toBe(0)
        })
        const stat = await fsp.stat(path.join(repoPath, "ran"))
        expect(stat.isFile()).toBe(true)
    })

    it("prints nothing to stdout in JSON mode (stdio ignored)", async () => {
        const written: string[] = []
        const spy = vi
            .spyOn(process.stdout, "write")
            .mockImplementation((chunk: string | Uint8Array): boolean => {
                written.push(chunk.toString())
                return true
            })
        terminal.jsonMode = true
        try {
            // A command that WOULD print to stdout; in JSON mode its stdio is
            // ignored, so nothing reaches process.stdout.
            await runHook("post-clone", {
                config: configWith({ "post-clone": "echo HELLO" }),
                workspace: tmp,
                repo: { name: "api", path: repoPath, url: "u" }
            })
        } finally {
            terminal.jsonMode = false
            spy.mockRestore()
        }
        expect(written.join("")).not.toContain("HELLO")
    })
})
