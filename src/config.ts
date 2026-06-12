import * as fs from "node:fs"
import * as path from "node:path"

export type UberepoConfig = {
    repositories: string[]
    // A PARTIAL map: any subset of the valid events may be bound (declaring just
    // `post-clone` is valid). Absent entirely = no hooks. The validator rejects
    // unknown keys, so the runtime shape can only ever be a subset of HookEvent.
    hooks?: Partial<Record<HookEvent, string>>
}

export const CONFIG_FILENAME = "uberepo.json"

export const TASKS_DIR = "tasks"

// The lifecycle events a hook command can bind to: a pre and a post for each of
// the five lifecycle commands (kebab-case to match git's own hook naming). Each
// fires per repo and only when that repo's op actually runs — never on a skip.
// pre-<op> fires right before the op and GATES it: a non-zero exit skips that
// repo (the op never runs), the run continues, and the command exits non-zero.
// post-<op> fires right after the op succeeds; a non-zero exit is logged and
// flips the exit code without undoing anything. The list is the source of truth
// for both the config validator's typo guard and the runner's lookups.
export const HOOK_EVENTS = [
    "pre-clone",
    "post-clone",
    "pre-open",
    "post-open",
    "pre-sync",
    "post-sync",
    "pre-ship",
    "post-ship",
    "pre-close",
    "post-close"
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

const DEFAULTS: UberepoConfig = { repositories: [] }

// Walk up from `cwd` to find CONFIG_FILENAME; return the path or undefined.
const locate = (cwd: string): string | undefined => {
    let directory = cwd
    while (true) {
        const candidate = path.join(directory, CONFIG_FILENAME)
        if (fs.existsSync(candidate)) {
            return candidate
        }
        const parent = path.dirname(directory)
        if (parent === directory) {
            return undefined
        }
        directory = parent
    }
}

// JSON.parse + defaults-merge + invariant checks, with friendly throws.
const parse = (raw: string, file: string): UberepoConfig => {
    let data: unknown
    try {
        data = JSON.parse(raw)
    } catch (error) {
        throw new Error(`${file} isn't valid JSON: ${(error as Error).message}`)
    }
    const config = { ...DEFAULTS, ...(data as Partial<UberepoConfig>) }
    if (!Array.isArray(config.repositories)) {
        throw new Error(`${file}: "repositories" must be an array of strings`)
    }
    // `hooks` is optional and backward-compatible: an absent key reads as no
    // hooks (the key stays off `config` entirely). When present it must be an
    // object mapping a KNOWN event to a shell-command STRING. An unknown event
    // key is a typo guard — reject it with the valid set listed — and a
    // non-string value is rejected too, so a malformed manifest fails loud at
    // read time rather than at hook-fire time.
    if (config.hooks !== undefined) {
        if (
            typeof config.hooks !== "object" ||
            config.hooks === null ||
            Array.isArray(config.hooks)
        ) {
            throw new Error(
                `${file}: "hooks" must be an object mapping an event to a command string`
            )
        }
        for (const [event, command] of Object.entries(config.hooks)) {
            if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
                throw new Error(
                    `${file}: "hooks" has an unknown event "${event}" — valid events are ${HOOK_EVENTS.join(", ")}`
                )
            }
            if (typeof command !== "string") {
                throw new Error(
                    `${file}: "hooks.${event}" must be a command string`
                )
            }
        }
    }
    return config
}

// Serialize a config to disk bytes: 4-space indent + trailing newline.
const serialize = (config: UberepoConfig): string =>
    `${JSON.stringify(config, null, 4)}\n`

export const Config = {
    // Absolute path of the directory containing the located CONFIG_FILENAME
    // (the workspace root), found by walking up from `cwd`. Friendly throw if
    // none exists, matching read()/edit().
    root: async (options?: { cwd?: string }): Promise<string> => {
        const cwd = options?.cwd ?? process.cwd()
        const file = locate(cwd)
        if (!file) {
            throw new Error(
                `No ${CONFIG_FILENAME} found in ${cwd} or any parent directory — run this inside a uberepo workspace.`
            )
        }
        return path.dirname(file)
    },

    read: async (options?: { cwd?: string }): Promise<UberepoConfig> => {
        const cwd = options?.cwd ?? process.cwd()
        const file = locate(cwd)
        if (!file) {
            throw new Error(
                `No ${CONFIG_FILENAME} found in ${cwd} or any parent directory — run this inside a uberepo workspace.`
            )
        }
        const raw = await fs.promises.readFile(file, "utf8")
        return parse(raw, file)
    },

    edit: async (
        mutator: (draft: UberepoConfig) => void | Promise<void>,
        options?: { cwd?: string }
    ): Promise<UberepoConfig> => {
        const cwd = options?.cwd ?? process.cwd()
        const file = locate(cwd)
        if (!file) {
            throw new Error(
                `No ${CONFIG_FILENAME} found in ${cwd} or any parent directory — run this inside a uberepo workspace.`
            )
        }
        const raw = await fs.promises.readFile(file, "utf8")
        const config = parse(raw, file)
        await mutator(config)
        await fs.promises.writeFile(file, serialize(config))
        return config
    },

    create: async (options?: { cwd?: string }): Promise<UberepoConfig> => {
        const dir = options?.cwd ?? process.cwd()
        const file = path.join(dir, CONFIG_FILENAME)
        if (fs.existsSync(file)) {
            throw new Error(
                `${CONFIG_FILENAME} already exists in ${dir} — refusing to overwrite.`
            )
        }
        const config = { ...DEFAULTS }
        await fs.promises.writeFile(file, serialize(config))
        return config
    }
}
