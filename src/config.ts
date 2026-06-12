import * as fs from "node:fs"
import * as path from "node:path"

// One registered repository: a bare clone-URL string (the original, common
// form) or an object carrying per-repo settings alongside the same `url`.
// Today the only per-repo setting is `carry` — glob patterns (relative to the
// repo root) of untracked local files to copy into task worktrees.
export type RepositoryEntry =
    | string
    | {
          url: string
          carry?: string[]
      }

export type UberepoConfig = {
    repositories: RepositoryEntry[]
    // Workspace-level carry patterns, applied to EVERY repo. A repo's effective
    // pattern set is the union of this list and its own entry's `carry`.
    carry?: string[]
    // A PARTIAL map: any subset of the valid events may be bound (declaring just
    // `post-clone` is valid). Absent entirely = no hooks. The validator rejects
    // unknown keys, so the runtime shape can only ever be a subset of HookEvent.
    hooks?: Partial<Record<HookEvent, string>>
}

// The registered clone URL of a repositories entry, whichever form it takes.
// Commands that only need the URL (every iteration over `repositories`) read
// it through this so both entry forms stay interchangeable.
export const repositoryUrl = (entry: RepositoryEntry): string =>
    typeof entry === "string" ? entry : entry.url

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

// Shared invariant for both carry sites (the workspace level and a repo
// entry): an array of non-empty pattern strings. `where` names the offending
// site in the throw so a multi-repo manifest fails loud AND located.
const validateCarry = (value: unknown, where: string, file: string): void => {
    if (
        !Array.isArray(value) ||
        value.some((p) => typeof p !== "string" || p.trim() === "")
    ) {
        throw new Error(
            `${file}: ${where} must be an array of non-empty glob pattern strings`
        )
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
        throw new Error(
            `${file}: "repositories" must be an array of URL strings or { url, carry } objects`
        )
    }
    // Each entry is a URL string (backward compatible) or a { url, carry }
    // object. Object entries are validated key by key — an unknown key is a
    // typo guard (mirroring the hooks event guard), a missing/empty `url` or a
    // malformed `carry` fails loud at read time rather than mid-command.
    for (const entry of config.repositories) {
        if (typeof entry === "string") {
            continue
        }
        if (
            typeof entry !== "object" ||
            entry === null ||
            Array.isArray(entry)
        ) {
            throw new Error(
                `${file}: each "repositories" entry must be a URL string or a { url, carry } object`
            )
        }
        for (const key of Object.keys(entry)) {
            if (key !== "url" && key !== "carry") {
                throw new Error(
                    `${file}: a "repositories" entry has an unknown key "${key}" — valid keys are url, carry`
                )
            }
        }
        if (typeof entry.url !== "string" || entry.url.trim() === "") {
            throw new Error(
                `${file}: a "repositories" entry object must have a non-empty "url" string`
            )
        }
        if (entry.carry !== undefined) {
            validateCarry(entry.carry, `"carry" for ${entry.url}`, file)
        }
    }
    // Workspace-level carry: optional and backward-compatible like hooks — an
    // absent key reads as no patterns (the key stays off `config` entirely).
    if (config.carry !== undefined) {
        validateCarry(config.carry, `"carry"`, file)
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
