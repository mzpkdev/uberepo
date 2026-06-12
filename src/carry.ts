import * as fs from "node:fs"
import * as path from "node:path"
import { terminal } from "cmdore"
import { minimatch } from "minimatch"
import { repositoryUrl, type UberepoConfig } from "@/config"
import git from "@/git"
import { normalizeRepository } from "@/url"

// A fresh worktree holds only tracked files, so the untracked local config a
// repo needs to boot (.env, docker-compose.override.yml, local certs) stays
// behind in source/<name>. "carry" copies the configured untracked files from
// the source clone into a task worktree, right after the worktree lands and
// BEFORE the post-open/post-sync hook fires — a hook like `npm ci && db:migrate`
// can rely on its .env being there.

// One repo's carry outcome: the files copied into the worktree this run, the
// matches left alone because the worktree already had them (the never-overwrite
// rule — what makes a re-run a missing-files-only repair), and the pattern
// matches skipped because git TRACKS them (copying would stomp checked-out
// content). All paths are repo-root-relative, in git's stable sorted order.
export type CarryResult = {
    copied: string[]
    keptExisting: string[]
    skippedTracked: string[]
}

// One repo's carry outcome as emitted in a command's JSON `carry` array,
// mirroring how HookResult rides the `hooks` array.
export type CarryEntry = CarryResult & {
    repo: string
}

// The context one repo's carry runs in: the workspace config (patterns live
// there), the repo's flat source/<name> name, and the absolute paths of its
// source clone and task worktree.
export type CarryContext = {
    config: UberepoConfig
    name: string
    source: string
    worktree: string
}

// The effective pattern set for a repo: the workspace-level `carry` UNIONED
// with the repo entry's own `carry`, in that order, de-duplicated. Empty means
// carry is a no-op for the repo.
export const carryPatterns = (
    config: UberepoConfig,
    name: string
): string[] => {
    const patterns: string[] = []
    const add = (list: string[] | undefined): void => {
        for (const pattern of list ?? []) {
            if (!patterns.includes(pattern)) {
                patterns.push(pattern)
            }
        }
    }
    add(config.carry)
    for (const entry of config.repositories) {
        if (typeof entry === "string") {
            continue
        }
        if (normalizeRepository(repositoryUrl(entry)).name === name) {
            add(entry.carry)
        }
    }
    return patterns
}

// gitignore-flavoured matching against a repo-root-relative path: patterns are
// ANCHORED at the repo root (`.env*` matches only root-level .env files; use
// `**/.env*` for any depth), `*`/`?` never cross a `/`, `**` crosses
// directories, and `dot: true` lets `*` match dotfiles — the files carry exists
// for are dotfile-heavy (.env, .envrc), so `config/*` must see them.
const matches = (relative: string, patterns: string[]): boolean =>
    patterns.some((pattern) => minimatch(relative, pattern, { dot: true }))

// One `git ls-files` listing as repo-root-relative paths. `-z` NUL-terminates
// entries so filenames with spaces or quotes parse cleanly.
const list = async (source: string, args: string[]): Promise<string[]> => {
    const out = await git(source).raw(...args, "-z")
    return out.split("\0").filter((line) => line !== "")
}

// The candidate files of a source clone: everything git does NOT track —
// plain untracked files plus ignored ones (.env is almost always gitignored),
// as the union of the two ls-files views. Sorted for stable output.
const candidates = async (source: string): Promise<string[]> => {
    const untracked = await list(source, [
        "ls-files",
        "--others",
        "--exclude-standard"
    ])
    const ignored = await list(source, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard"
    ])
    return [...new Set([...untracked, ...ignored])].sort()
}

// Copy the repo's configured untracked files from its source clone into the
// task worktree. Returns null when the repo has no effective patterns —
// nothing to do — so callers can simply skip a null (mirroring runHook).
//
// - Only untracked/ignored source files are copied; a pattern match that git
//   TRACKS is warned about and skipped, never copied (the worktree already
//   checked it out — copying would stomp it).
// - A destination that already exists is NEVER overwritten; it counts as kept,
//   not an error, which makes carry idempotent and a re-run (sync) a
//   missing-files-only repair.
// - Relative paths are preserved (parents created as needed), and so is the
//   file mode — certs/keys are often 0600 and must stay that way.
//
// The per-file lines are logged here (human mode only) so every call site
// reports carry identically, the way runHook reports hooks.
export const runCarry = async (
    ctx: CarryContext
): Promise<CarryResult | null> => {
    const patterns = carryPatterns(ctx.config, ctx.name)
    if (patterns.length === 0) {
        return null
    }
    const result: CarryResult = {
        copied: [],
        keptExisting: [],
        skippedTracked: []
    }
    for (const file of await list(ctx.source, ["ls-files"])) {
        if (matches(file, patterns)) {
            result.skippedTracked.push(file)
            terminal.warn(
                `${ctx.name}: carry skipped ${file} — tracked in git, the worktree already has it`
            )
        }
    }
    for (const file of await candidates(ctx.source)) {
        if (!matches(file, patterns)) {
            continue
        }
        const from = path.join(ctx.source, file)
        const to = path.join(ctx.worktree, file)
        await fs.promises.mkdir(path.dirname(to), { recursive: true })
        try {
            // COPYFILE_EXCL refuses an existing destination atomically: the
            // worktree's copy wins, recorded as kept rather than failed.
            await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
                result.keptExisting.push(file)
                continue
            }
            throw error
        }
        const stat = await fs.promises.stat(from)
        await fs.promises.chmod(to, stat.mode & 0o777)
        result.copied.push(file)
        terminal.log(`${ctx.name}: carried ${file}`)
    }
    return result
}

// The carried files of a worktree whose bytes have DIVERGED from their source
// copies — close warns these edits are about to be lost with the worktree.
// Compares the repo's current carry candidates (the files carry would copy
// today) against the worktree byte for byte; a candidate missing from the
// worktree has nothing to lose, and a worktree-only file matching a pattern
// was never carried, so neither counts as drift.
export const carryDrift = async (ctx: CarryContext): Promise<string[]> => {
    const patterns = carryPatterns(ctx.config, ctx.name)
    if (patterns.length === 0) {
        return []
    }
    const drifted: string[] = []
    for (const file of await candidates(ctx.source)) {
        if (!matches(file, patterns)) {
            continue
        }
        const to = path.join(ctx.worktree, file)
        if (!fs.existsSync(to)) {
            continue
        }
        const [source, worktree] = await Promise.all([
            fs.promises.readFile(path.join(ctx.source, file)),
            fs.promises.readFile(to)
        ])
        if (!source.equals(worktree)) {
            drifted.push(file)
        }
    }
    return drifted
}
