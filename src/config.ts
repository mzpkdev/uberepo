import * as fs from "node:fs"
import * as path from "node:path"

export type UberepoConfig = {
    repositories: string[]
}

export const CONFIG_FILENAME = "uberepo.json"

export const TASKS_DIR = "tasks"

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
