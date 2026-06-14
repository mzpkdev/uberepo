import * as fs from "node:fs"
import * as path from "node:path"
import { terminal } from "cmdore"
import { normalizeRepository } from "@/url"

// One registered repository: a bare clone-URL string. Per-repo settings no
// longer ride the entry — `carry` is a single top-level field (see below), so
// an entry is just its clone URL.
export type RepositoryEntry = string

export type UberepoConfig = {
    repositories: RepositoryEntry[]
    // Carry patterns — glob patterns (relative to a repo root) of untracked
    // local files to copy into task worktrees — in one of two forms:
    //   - an ARRAY: GLOBAL patterns applied to EVERY repo, or
    //   - an OBJECT: a PER-REPO map of repo `name` -> that repo's patterns; a
    //     repo absent from the map carries nothing.
    // Absent entirely = nothing is carried.
    carry?: string[] | Record<string, string[]>
    // A PARTIAL map: any subset of the valid events may be bound (declaring just
    // `post-clone` is valid). Absent entirely = no hooks. The validator rejects
    // unknown keys, so the runtime shape can only ever be a subset of HookEvent.
    hooks?: Partial<Record<HookEvent, string>>
}

// The registered clone URL of a repositories entry. Entries are bare URL
// strings now, but commands keep reading the URL through this helper so the
// call sites stay stable if the entry shape ever grows again.
export const repositoryUrl = (entry: RepositoryEntry): string => entry

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

// Invariant for a carry pattern LIST: an array of non-empty pattern strings.
// `where` names the offending site in the throw so a multi-repo manifest fails
// loud AND located — `"carry"` for the global form, `"carry" for <name>` for a
// per-repo list inside the object form.
const validateCarryList = (
    value: unknown,
    where: string,
    file: string
): void => {
    if (
        !Array.isArray(value) ||
        value.some((p) => typeof p !== "string" || p.trim() === "")
    ) {
        throw new Error(
            `${file}: ${where} must be an array of non-empty glob pattern strings`
        )
    }
}

// Validate the top-level `carry` field in either form, and — for the per-repo
// object form — WARN (never throw) on any key matching no registered repo
// `name`, since a typo'd key would silently carry into nothing. `repoNames`
// is the set of trailing-slug names derived from `repositories`.
const validateCarry = (
    value: unknown,
    file: string,
    repoNames: Set<string>
): void => {
    if (Array.isArray(value)) {
        // GLOBAL form: a flat list applied to every repo.
        validateCarryList(value, `"carry"`, file)
        return
    }
    if (typeof value !== "object" || value === null) {
        throw new Error(
            `${file}: "carry" must be an array of glob patterns (applied to every repo) or an object mapping a repo name to its patterns`
        )
    }
    // PER-REPO form: each value is its own pattern list; an unrecognised key is
    // a soft warning so the rest of the manifest still loads.
    for (const [name, patterns] of Object.entries(value)) {
        validateCarryList(patterns, `"carry" for ${name}`, file)
        if (!repoNames.has(name)) {
            terminal.warn(
                `${file}: "carry" key "${name}" matches no registered repository — it carries nothing`
            )
        }
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
            `${file}: "repositories" must be an array of URL strings`
        )
    }
    // Each entry is a bare URL string. The old { url, carry } object form is
    // gone — carry is now a single top-level field — so an object entry is
    // rejected, with a targeted hint when it still carries a `carry` key (the
    // most likely stale manifest) so the fix is obvious.
    for (const entry of config.repositories) {
        if (typeof entry === "string") {
            continue
        }
        if (
            typeof entry === "object" &&
            entry !== null &&
            !Array.isArray(entry) &&
            "carry" in entry
        ) {
            throw new Error(
                `${file}: a "repositories" entry has a "carry" key — carry is now a top-level field (an array applied to every repo, or an object mapping a repo name to its patterns), not a per-entry one. Replace the object entry with its bare URL string and move "carry" to the top level.`
            )
        }
        throw new Error(
            `${file}: each "repositories" entry must be a URL string`
        )
    }
    // Build the set of repo names (trailing slugs) so the per-repo carry form
    // can warn on keys that match no repo. Skip entries that don't parse as a
    // URL — a malformed repository URL is surfaced later, at clone time, where
    // it has historically been reported; failing here would change that.
    const repoNames = new Set<string>()
    for (const entry of config.repositories) {
        try {
            repoNames.add(normalizeRepository(entry).name)
        } catch {
            // not a parseable URL — ignore for name-matching purposes
        }
    }
    // Top-level carry: optional and backward-compatible like hooks — an absent
    // key reads as no patterns (the key stays off `config` entirely).
    if (config.carry !== undefined) {
        validateCarry(config.carry, file, repoNames)
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
