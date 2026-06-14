import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { terminal } from "cmdore"
import { CONFIG_FILENAME, Config } from "@/config"

const configPath = (dir: string): string => path.join(dir, CONFIG_FILENAME)

const writeConfig = async (dir: string, raw: string): Promise<void> => {
    await fsp.writeFile(configPath(dir), raw)
}

// Capture terminal.warn for the duration of `fn` (parse emits a warning, never
// a throw, for a per-repo carry key that matches no registered repository),
// then restore it, handing back `fn`'s value alongside the collected lines.
const captureWarnings = async <T>(
    fn: () => Promise<T>
): Promise<{ value: T; warnings: string[] }> => {
    const originalWarn = terminal.warn
    const warnings: string[] = []
    terminal.warn = (message?: string) => {
        warnings.push(message ?? "")
    }
    try {
        return { value: await fn(), warnings }
    } finally {
        terminal.warn = originalWarn
    }
}

describe("Config", () => {
    let tmp: string

    // Build a fresh temp workspace root for each test; never touch process.cwd.
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "config-spec-"))
    })

    afterEach(async () => {
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    describe("read", () => {
        it("reads a config in the given workspace directory", async () => {
            await writeConfig(tmp, `{\n    "repositories": ["a", "b"]\n}\n`)
            const config = await Config.read({ cwd: tmp })
            expect(config).toEqual({ repositories: ["a", "b"] })
        })

        it("walks up parent directories from a nested subdir", async () => {
            await writeConfig(tmp, `{\n    "repositories": ["root"]\n}\n`)
            const nested = path.join(tmp, "packages", "deep")
            await fsp.mkdir(nested, { recursive: true })
            const config = await Config.read({ cwd: nested })
            expect(config).toEqual({ repositories: ["root"] })
        })

        it("throws the not-in-workspace error outside any workspace", async () => {
            const orphan = await fsp.mkdtemp(
                path.join(os.tmpdir(), "config-orphan-")
            )
            try {
                const error = await Config.read({ cwd: orphan }).catch((e) => e)
                expect(error).toBeInstanceOf(Error)
                expect((error as Error).message).toBe(
                    `No ${CONFIG_FILENAME} found in ${orphan} or any parent directory — run this inside a uberepo workspace.`
                )
            } finally {
                await fsp.rm(orphan, { recursive: true, force: true })
            }
        })

        it("throws a friendly error on malformed JSON", async () => {
            await writeConfig(tmp, "{ not json")
            const error = await Config.read({ cwd: tmp }).catch((e) => e)
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toContain(
                `${configPath(tmp)} isn't valid JSON:`
            )
        })

        it("throws when repositories is not an array", async () => {
            await writeConfig(tmp, `{ "repositories": "oops" }`)
            const error = await Config.read({ cwd: tmp }).catch((e) => e)
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toBe(
                `${configPath(tmp)}: "repositories" must be an array of URL strings`
            )
        })

        it("defaults a missing repositories field to an empty array", async () => {
            await writeConfig(tmp, `{}`)
            const config = await Config.read({ cwd: tmp })
            expect(config).toEqual({ repositories: [] })
        })

        it("reads a valid hooks map of event -> command string", async () => {
            await writeConfig(
                tmp,
                JSON.stringify({
                    repositories: ["a"],
                    hooks: {
                        "post-clone": "npm ci",
                        "post-open": "bash setup.sh",
                        "post-sync": "python3 relink.py"
                    }
                })
            )
            const config = await Config.read({ cwd: tmp })
            expect(config).toEqual({
                repositories: ["a"],
                hooks: {
                    "post-clone": "npm ci",
                    "post-open": "bash setup.sh",
                    "post-sync": "python3 relink.py"
                }
            })
        })

        it("accepts every pre/post lifecycle event", async () => {
            const hooks = {
                "pre-clone": "a",
                "post-clone": "b",
                "pre-open": "c",
                "post-open": "d",
                "pre-sync": "e",
                "post-sync": "f",
                "pre-ship": "g",
                "post-ship": "h",
                "pre-close": "i",
                "post-close": "j"
            }
            await writeConfig(tmp, JSON.stringify({ repositories: [], hooks }))
            const config = await Config.read({ cwd: tmp })
            expect(config.hooks).toEqual(hooks)
        })

        it("keeps an old manifest with no hooks key working unchanged", async () => {
            await writeConfig(tmp, `{\n    "repositories": ["a", "b"]\n}\n`)
            const config = await Config.read({ cwd: tmp })
            // No `hooks` key is added — backward compatible.
            expect(config).toEqual({ repositories: ["a", "b"] })
            expect("hooks" in config).toBe(false)
        })

        it("rejects an unknown hook event with the valid events listed", async () => {
            await writeConfig(
                tmp,
                JSON.stringify({
                    repositories: [],
                    hooks: { "pre-commit": "echo no" }
                })
            )
            const error = await Config.read({ cwd: tmp }).catch((e) => e)
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toBe(
                `${configPath(tmp)}: "hooks" has an unknown event "pre-commit" — valid events are pre-clone, post-clone, pre-open, post-open, pre-sync, post-sync, pre-ship, post-ship, pre-close, post-close`
            )
        })

        it("rejects a non-string hook command value", async () => {
            await writeConfig(
                tmp,
                JSON.stringify({
                    repositories: [],
                    hooks: { "post-clone": 123 }
                })
            )
            const error = await Config.read({ cwd: tmp }).catch((e) => e)
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toBe(
                `${configPath(tmp)}: "hooks.post-clone" must be a command string`
            )
        })

        it("rejects hooks that is not an object", async () => {
            await writeConfig(
                tmp,
                JSON.stringify({ repositories: [], hooks: ["post-clone"] })
            )
            const error = await Config.read({ cwd: tmp }).catch((e) => e)
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toBe(
                `${configPath(tmp)}: "hooks" must be an object mapping an event to a command string`
            )
        })

        it("reads a workspace-level carry list", async () => {
            await writeConfig(
                tmp,
                JSON.stringify({
                    repositories: ["a"],
                    carry: [".env*", "config/local.json"]
                })
            )
            const config = await Config.read({ cwd: tmp })
            expect(config).toEqual({
                repositories: ["a"],
                carry: [".env*", "config/local.json"]
            })
        })

        it("keeps an old manifest with no carry key working unchanged", async () => {
            await writeConfig(tmp, `{\n    "repositories": ["a"]\n}\n`)
            const config = await Config.read({ cwd: tmp })
            expect("carry" in config).toBe(false)
        })

        it("reads a per-repo carry map keyed by repo name", async () => {
            await writeConfig(
                tmp,
                JSON.stringify({
                    repositories: [
                        "https://github.com/acme/api.git",
                        "https://github.com/acme/web.git"
                    ],
                    carry: {
                        api: [".env*"],
                        web: ["certs/*.pem"]
                    }
                })
            )
            const { value: config, warnings } = await captureWarnings(() =>
                Config.read({ cwd: tmp })
            )
            expect(config).toEqual({
                repositories: [
                    "https://github.com/acme/api.git",
                    "https://github.com/acme/web.git"
                ],
                carry: {
                    api: [".env*"],
                    web: ["certs/*.pem"]
                }
            })
            // Every key matches a repo, so nothing is warned about.
            expect(warnings).toEqual([])
        })

        it("warns (does not throw) on a carry map key matching no repo", async () => {
            await writeConfig(
                tmp,
                JSON.stringify({
                    repositories: ["https://github.com/acme/api.git"],
                    carry: { api: [".env"], ghost: [".env"] }
                })
            )
            const { value: config, warnings } = await captureWarnings(() =>
                Config.read({ cwd: tmp })
            )
            // The config still loads — the warning is advisory only.
            expect(config.carry).toEqual({ api: [".env"], ghost: [".env"] })
            expect(warnings.join("\n")).toContain(`"carry" key "ghost"`)
            // The matching key is not warned about.
            expect(warnings.join("\n")).not.toContain(`"carry" key "api"`)
        })

        it("rejects a workspace carry array of non-empty strings", async () => {
            for (const carry of [[".env*", 7], [""], ["  "]]) {
                await writeConfig(
                    tmp,
                    JSON.stringify({ repositories: [], carry })
                )
                const error = await Config.read({ cwd: tmp }).catch((e) => e)
                expect(error).toBeInstanceOf(Error)
                expect((error as Error).message).toBe(
                    `${configPath(tmp)}: "carry" must be an array of non-empty glob pattern strings`
                )
            }
        })

        it("rejects a carry that is neither an array nor an object", async () => {
            await writeConfig(
                tmp,
                JSON.stringify({ repositories: [], carry: ".env*" })
            )
            const error = await Config.read({ cwd: tmp }).catch((e) => e)
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toBe(
                `${configPath(tmp)}: "carry" must be an array of glob patterns (applied to every repo) or an object mapping a repo name to its patterns`
            )
        })

        it("rejects a carry map value that is not a string array, naming the key", async () => {
            await writeConfig(
                tmp,
                JSON.stringify({
                    repositories: ["https://github.com/acme/api.git"],
                    carry: { api: "no" }
                })
            )
            const error = await Config.read({ cwd: tmp }).catch((e) => e)
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toBe(
                `${configPath(tmp)}: "carry" for api must be an array of non-empty glob pattern strings`
            )
        })

        it("rejects a repository entry that is not a string", async () => {
            await writeConfig(tmp, JSON.stringify({ repositories: [42] }))
            const error = await Config.read({ cwd: tmp }).catch((e) => e)
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toBe(
                `${configPath(tmp)}: each "repositories" entry must be a URL string`
            )
        })

        it("rejects a repository entry carrying a carry key, pointing to top-level carry", async () => {
            await writeConfig(
                tmp,
                JSON.stringify({
                    repositories: [
                        {
                            url: "https://github.com/acme/api.git",
                            carry: [".env"]
                        }
                    ]
                })
            )
            const error = await Config.read({ cwd: tmp }).catch((e) => e)
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toBe(
                `${configPath(tmp)}: a "repositories" entry has a "carry" key — carry is now a top-level field (an array applied to every repo, or an object mapping a repo name to its patterns), not a per-entry one. Replace the object entry with its bare URL string and move "carry" to the top level.`
            )
        })
    })

    describe("edit", () => {
        it("mutates and persists, writing exact 4-space + newline bytes", async () => {
            await writeConfig(tmp, `{\n    "repositories": []\n}\n`)
            await Config.edit(
                (draft) => {
                    draft.repositories.push("x")
                },
                { cwd: tmp }
            )
            const written = await fsp.readFile(configPath(tmp), "utf8")
            const expected = { repositories: ["x"] }
            expect(written).toBe(`${JSON.stringify(expected, null, 4)}\n`)
        })

        it("returns the saved config", async () => {
            await writeConfig(tmp, `{\n    "repositories": ["a"]\n}\n`)
            const saved = await Config.edit(
                (draft) => {
                    draft.repositories.push("b")
                },
                { cwd: tmp }
            )
            expect(saved).toEqual({ repositories: ["a", "b"] })
        })

        it("awaits an async mutator before writing", async () => {
            await writeConfig(tmp, `{\n    "repositories": []\n}\n`)
            const saved = await Config.edit(
                async (draft) => {
                    await Promise.resolve()
                    draft.repositories.push("async")
                },
                { cwd: tmp }
            )
            expect(saved).toEqual({ repositories: ["async"] })
            expect(await Config.read({ cwd: tmp })).toEqual({
                repositories: ["async"]
            })
        })
    })

    describe("create", () => {
        it("writes the default config to a fresh directory", async () => {
            const config = await Config.create({ cwd: tmp })
            expect(config).toEqual({ repositories: [] })
            const written = await fsp.readFile(configPath(tmp), "utf8")
            expect(written).toBe(`{\n    "repositories": []\n}\n`)
        })

        it("throws when a config already exists", async () => {
            await Config.create({ cwd: tmp })
            const error = await Config.create({ cwd: tmp }).catch((e) => e)
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toContain(CONFIG_FILENAME)
        })
    })
})
