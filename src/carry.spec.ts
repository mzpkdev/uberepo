import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { terminal } from "cmdore"
import { carryDrift, carryPatterns, runCarry } from "@/carry"
import type { UberepoConfig } from "@/config"

const exec = promisify(execFile)

// Run a git command directly (NOT the wrapper under test) so test setup and
// assertions stay independent of git.ts.
const sh = async (cwd: string, ...args: string[]): Promise<string> => {
    const { stdout } = await exec("git", args, { cwd })
    return stdout.trim()
}

// Capture terminal.log + terminal.warn output for the duration of `fn`, then
// restore them, handing back `fn`'s value alongside. carry logs a line per
// copied file and warns on tracked matches, so both streams are needed.
const captureOutput = async <T>(
    fn: () => Promise<T>
): Promise<{ value: T; logs: string[]; warnings: string[] }> => {
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
        return { value: await fn(), logs, warnings }
    } finally {
        terminal.log = originalLog
        terminal.warn = originalWarn
    }
}

describe("carry", () => {
    let tmp: string
    let root: string

    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "carry-spec-"))
        // realpath because macOS canonicalises /var -> /private/var.
        root = await fsp.realpath(tmp)
    })

    afterEach(async () => {
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    // A real git repo at <root>/source/<name> with one commit (README.md), the
    // role source/<name> plays in a workspace. Untracked/ignored files are laid
    // on top per test.
    const makeSource = async (name: string): Promise<string> => {
        const dir = path.join(root, "source", name)
        await fsp.mkdir(dir, { recursive: true })
        await sh(dir, "init")
        await sh(dir, "config", "user.email", "test@example.com")
        await sh(dir, "config", "user.name", "Test User")
        await fsp.writeFile(path.join(dir, "README.md"), `${name}\n`)
        await sh(dir, "add", "README.md")
        await sh(dir, "commit", "-m", "initial commit")
        return dir
    }

    // The destination dir standing in for tasks/<task>/<name>. carry only
    // writes plain files into it, so a plain dir is enough.
    const makeWorktree = async (name: string): Promise<string> => {
        const dir = path.join(root, "tasks", "alpha", name)
        await fsp.mkdir(dir, { recursive: true })
        return dir
    }

    const write = async (
        dir: string,
        file: string,
        contents: string
    ): Promise<void> => {
        await fsp.mkdir(path.join(dir, path.dirname(file)), {
            recursive: true
        })
        await fsp.writeFile(path.join(dir, file), contents)
    }

    const url = (name: string): string => `https://github.com/acme/${name}.git`

    describe("carryPatterns", () => {
        it("unions workspace-level and per-repo patterns, workspace first", () => {
            const config: UberepoConfig = {
                repositories: [{ url: url("api"), carry: ["certs/*.pem"] }],
                carry: [".env*"]
            }
            expect(carryPatterns(config, "api")).toEqual([
                ".env*",
                "certs/*.pem"
            ])
        })

        it("de-duplicates a pattern declared at both levels", () => {
            const config: UberepoConfig = {
                repositories: [
                    { url: url("api"), carry: [".env*", "local.json"] }
                ],
                carry: [".env*"]
            }
            expect(carryPatterns(config, "api")).toEqual([
                ".env*",
                "local.json"
            ])
        })

        it("ignores other repos' entries and plain string entries", () => {
            const config: UberepoConfig = {
                repositories: [
                    url("api"),
                    { url: url("web"), carry: ["web-only.json"] }
                ]
            }
            expect(carryPatterns(config, "api")).toEqual([])
            expect(carryPatterns(config, "web")).toEqual(["web-only.json"])
        })
    })

    describe("runCarry", () => {
        it("returns null and copies nothing when the repo has no patterns", async () => {
            const source = await makeSource("api")
            const worktree = await makeWorktree("api")
            await write(source, ".env", "SECRET=1\n")

            const result = await runCarry({
                config: { repositories: [url("api")] },
                name: "api",
                source,
                worktree
            })

            expect(result).toBeNull()
            expect(fs.existsSync(path.join(worktree, ".env"))).toBe(false)
        })

        it("copies matching untracked AND ignored files, not the rest", async () => {
            const source = await makeSource("api")
            const worktree = await makeWorktree("api")
            // .env is IGNORED (the common case), local.json plain untracked.
            await write(source, ".gitignore", ".env\n")
            await sh(source, "add", ".gitignore")
            await sh(source, "commit", "-m", "ignore .env")
            await write(source, ".env", "SECRET=1\n")
            await write(source, "config/local.json", "{}\n")
            await write(source, "notes.txt", "not carried\n")

            const { value: result } = await captureOutput(() =>
                runCarry({
                    config: {
                        repositories: [url("api")],
                        carry: [".env*", "config/local.json"]
                    },
                    name: "api",
                    source,
                    worktree
                })
            )

            expect(result).toEqual({
                copied: [".env", "config/local.json"],
                keptExisting: [],
                skippedTracked: []
            })
            expect(
                await fsp.readFile(path.join(worktree, ".env"), "utf8")
            ).toBe("SECRET=1\n")
            // Parents are created so nested paths land at the same relative
            // spot.
            expect(
                await fsp.readFile(
                    path.join(worktree, "config", "local.json"),
                    "utf8"
                )
            ).toBe("{}\n")
            expect(fs.existsSync(path.join(worktree, "notes.txt"))).toBe(false)
        })

        it("logs a line per carried file", async () => {
            const source = await makeSource("api")
            const worktree = await makeWorktree("api")
            await write(source, ".env", "SECRET=1\n")

            const { logs } = await captureOutput(async () => {
                await runCarry({
                    config: { repositories: [url("api")], carry: [".env*"] },
                    name: "api",
                    source,
                    worktree
                })
            })

            expect(logs).toContain("api: carried .env")
        })

        it("skips and warns when a pattern matches a TRACKED file", async () => {
            const source = await makeSource("api")
            const worktree = await makeWorktree("api")
            // .env.example is committed; .env is local-only.
            await write(source, ".env.example", "SECRET=\n")
            await sh(source, "add", ".env.example")
            await sh(source, "commit", "-m", "add env example")
            await write(source, ".env", "SECRET=1\n")

            const { value: result, warnings } = await captureOutput(() =>
                runCarry({
                    config: { repositories: [url("api")], carry: [".env*"] },
                    name: "api",
                    source,
                    worktree
                })
            )

            expect(result).toEqual({
                copied: [".env"],
                keptExisting: [],
                skippedTracked: [".env.example"]
            })
            // The tracked match is never copied — the worktree's checkout owns
            // that path.
            expect(fs.existsSync(path.join(worktree, ".env.example"))).toBe(
                false
            )
            expect(warnings.join("\n")).toContain(".env.example")
        })

        it("never overwrites an existing destination (kept, not an error)", async () => {
            const source = await makeSource("api")
            const worktree = await makeWorktree("api")
            await write(source, ".env", "FROM_SOURCE\n")
            await write(worktree, ".env", "EDITED_IN_TASK\n")

            const { value: result } = await captureOutput(() =>
                runCarry({
                    config: { repositories: [url("api")], carry: [".env"] },
                    name: "api",
                    source,
                    worktree
                })
            )

            expect(result).toEqual({
                copied: [],
                keptExisting: [".env"],
                skippedTracked: []
            })
            expect(
                await fsp.readFile(path.join(worktree, ".env"), "utf8")
            ).toBe("EDITED_IN_TASK\n")
        })

        it("is idempotent: a re-run keeps the first run's copies", async () => {
            const source = await makeSource("api")
            const worktree = await makeWorktree("api")
            await write(source, ".env", "SECRET=1\n")
            const config: UberepoConfig = {
                repositories: [url("api")],
                carry: [".env"]
            }

            await captureOutput(async () => {
                const first = await runCarry({
                    config,
                    name: "api",
                    source,
                    worktree
                })
                expect(first?.copied).toEqual([".env"])
                const second = await runCarry({
                    config,
                    name: "api",
                    source,
                    worktree
                })
                expect(second).toEqual({
                    copied: [],
                    keptExisting: [".env"],
                    skippedTracked: []
                })
            })
        })

        it("preserves the source file's mode (0600 certs stay 0600)", async () => {
            const source = await makeSource("api")
            const worktree = await makeWorktree("api")
            await write(source, "certs/local.pem", "PEM\n")
            await fsp.chmod(path.join(source, "certs", "local.pem"), 0o600)

            await captureOutput(async () => {
                await runCarry({
                    config: {
                        repositories: [url("api")],
                        carry: ["certs/*.pem"]
                    },
                    name: "api",
                    source,
                    worktree
                })
            })

            const stat = await fsp.stat(
                path.join(worktree, "certs", "local.pem")
            )
            expect(stat.mode & 0o777).toBe(0o600)
        })

        it("anchors patterns at the repo root: * stays in its segment, ** crosses", async () => {
            const source = await makeSource("api")
            const worktree = await makeWorktree("api")
            await write(source, ".env", "ROOT\n")
            await write(source, "packages/app/.env", "NESTED\n")
            await write(source, "certs/a.pem", "A\n")
            await write(source, "certs/sub/b.pem", "B\n")

            const { value: result } = await captureOutput(() =>
                runCarry({
                    config: {
                        repositories: [url("api")],
                        // `.env` only at the root; `**/.env` would catch both.
                        carry: [".env", "certs/*.pem"]
                    },
                    name: "api",
                    source,
                    worktree
                })
            )
            expect(result?.copied).toEqual([".env", "certs/a.pem"])

            const deepWorktree = await makeWorktree("api-deep")
            const { value: deep } = await captureOutput(() =>
                runCarry({
                    config: { repositories: [url("api")], carry: ["**/.env"] },
                    name: "api",
                    source,
                    worktree: deepWorktree
                })
            )
            expect(deep?.copied).toEqual([".env", "packages/app/.env"])
        })

        it("applies the union of workspace and per-repo patterns", async () => {
            const source = await makeSource("api")
            const worktree = await makeWorktree("api")
            await write(source, ".env", "SECRET=1\n")
            await write(source, "certs/local.pem", "PEM\n")

            const { value: result } = await captureOutput(() =>
                runCarry({
                    config: {
                        repositories: [
                            { url: url("api"), carry: ["certs/*.pem"] }
                        ],
                        carry: [".env*"]
                    },
                    name: "api",
                    source,
                    worktree
                })
            )

            expect(result?.copied).toEqual([".env", "certs/local.pem"])
        })
    })

    describe("carryDrift", () => {
        it("is empty without patterns, identical copies, or missing files", async () => {
            const source = await makeSource("api")
            const worktree = await makeWorktree("api")
            await write(source, ".env", "SAME\n")
            await write(source, ".env.local", "NEVER CARRIED\n")
            await write(worktree, ".env", "SAME\n")
            // Matches the pattern but exists ONLY in the worktree: never
            // carried, so not drift.
            await write(worktree, ".env.task-only", "NEW\n")

            expect(
                await carryDrift({
                    config: { repositories: [url("api")] },
                    name: "api",
                    source,
                    worktree
                })
            ).toEqual([])
            expect(
                await carryDrift({
                    config: { repositories: [url("api")], carry: [".env*"] },
                    name: "api",
                    source,
                    worktree
                })
            ).toEqual([])
        })

        it("lists carried files whose worktree bytes diverged from source", async () => {
            const source = await makeSource("api")
            const worktree = await makeWorktree("api")
            await write(source, ".env", "ORIGINAL\n")
            await write(source, "certs/local.pem", "PEM\n")
            await write(worktree, ".env", "EDITED\n")
            await write(worktree, "certs/local.pem", "PEM\n")

            expect(
                await carryDrift({
                    config: {
                        repositories: [url("api")],
                        carry: [".env*", "certs/*.pem"]
                    },
                    name: "api",
                    source,
                    worktree
                })
            ).toEqual([".env"])
        })
    })
})
