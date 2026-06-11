import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

// ────────────────────────────────────────────────────────────────────────────
// The gh seam
//
// Every GitHub call ship makes goes through one function — Gh — so tests can
// inject a fake and assert the exact `gh` argv without a network. The default
// impl shells out to the `gh` CLI exactly the way git.ts shells out to git: no
// API client, no token handling. gh infers the repo from the worktree's origin,
// so every call passes the worktree as cwd.
// ────────────────────────────────────────────────────────────────────────────

// A single gh invocation: the argv after `gh`, and the cwd (a repo worktree) gh
// resolves the repo from. Returns stdout; a non-zero exit throws GhError with
// gh's own stderr so auth/permission errors surface as-is.
export type Gh = (args: string[], cwd: string) => Promise<string>

export class GhError extends Error {
    constructor(
        readonly args: string[],
        readonly exitCode: number,
        readonly stderr: string
    ) {
        super(
            `gh ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`
        )
        this.name = "GhError"
    }
}

// The real gh runner: shell out to the `gh` binary on PATH. Mirrors git.ts's
// run() — capture stdout, wrap a failure (including a missing binary) in a typed
// error carrying gh's stderr verbatim.
export const gh: Gh = async (args: string[], cwd: string): Promise<string> => {
    try {
        const { stdout } = await exec("gh", args, { cwd })
        return stdout
    } catch (error) {
        const err = error as { code?: number; stderr?: string }
        const exitCode = typeof err.code === "number" ? err.code : 1
        throw new GhError(args, exitCode, err.stderr ?? "")
    }
}

// The gh runner ship actually calls. Defaults to the real `gh` shell-out;
// specs swap it via setGh() to a fake that records argv and returns canned
// `pr list`/`create` output, so the whole ship flow runs with no network and no
// gh binary. resetGh() restores the default (afterEach in specs).
let activeGh: Gh = gh

export const currentGh = (): Gh => activeGh

export const setGh = (run: Gh): void => {
    activeGh = run
}

export const resetGh = (): void => {
    activeGh = gh
}

// Verify the GitHub CLI is installed before the PR step runs. `gh --version`
// exits 0 and prints a version when present; a missing binary throws (ENOENT →
// GhError). ship calls this once up front (unless --no-pr) and errors clearly
// when it returns false, so it never half-ships before discovering gh is absent.
export const ghAvailable = async (run: Gh = activeGh): Promise<boolean> => {
    try {
        await run(["--version"], process.cwd())
        return true
    } catch {
        return false
    }
}

// ────────────────────────────────────────────────────────────────────────────
// gh wrappers — the two pr subcommands ship uses
// ────────────────────────────────────────────────────────────────────────────

// One PR as gh reports it from `pr list --json number,url,state`. state is
// gh's enum: OPEN / CLOSED / MERGED.
export type PullRequest = {
    number: number
    url: string
    state: string
}

// List PRs whose head branch is `head`, in the repo gh infers from `cwd`. Used
// to decide create-vs-(push-only update). Returns [] when none.
export const prList = async (
    run: Gh,
    cwd: string,
    head: string
): Promise<PullRequest[]> => {
    const out = await run(
        ["pr", "list", "--head", head, "--json", "number,url,state"],
        cwd
    )
    const trimmed = out.trim()
    if (trimmed === "") {
        return []
    }
    return JSON.parse(trimmed) as PullRequest[]
}

// Create a draft PR for `head` against `base`, reading the body from a temp file
// (gh does not apply PR templates, so we always pass the resolved body
// explicitly). Returns the new PR's URL (the one line `gh pr create` prints on
// success).
export const prCreate = async (
    run: Gh,
    cwd: string,
    opts: { base: string; head: string; title: string; bodyFile: string }
): Promise<string> => {
    const out = await run(
        [
            "pr",
            "create",
            "--draft",
            "--base",
            opts.base,
            "--head",
            opts.head,
            "--title",
            opts.title,
            "--body-file",
            opts.bodyFile
        ],
        cwd
    )
    return out.trim()
}

// The PR number parsed from a GitHub PR URL
// (https://github.com/<owner>/<repo>/pull/<n>) — `gh pr create` prints the URL,
// and the JSON outcome reports the number. Returns undefined for a non-matching
// URL so a surprising gh url never crashes the run.
const PR_URL = /\/pull\/(\d+)/

export const pullRequestNumber = (url: string): number | undefined => {
    const match = PR_URL.exec(url)
    return match ? Number(match[1]) : undefined
}

// ────────────────────────────────────────────────────────────────────────────
// PR template lookup
// ────────────────────────────────────────────────────────────────────────────

// Case-insensitive `pull_request_template.md` lookup in the worktree, checked in
// .github/, the repo root, then docs/ — GitHub's own search order. Returns the
// file's text, or undefined when none is found. A multi-template DIRECTORY
// (.github/PULL_REQUEST_TEMPLATE/) is deliberately ignored (treated as no
// template): ship can't choose among many, and gh wouldn't apply one anyway.
export const readPrTemplate = (worktree: string): string | undefined => {
    const dirs = [
        path.join(worktree, ".github"),
        worktree,
        path.join(worktree, "docs")
    ]
    for (const dir of dirs) {
        const found = findTemplateFile(dir)
        if (found !== undefined) {
            return fs.readFileSync(found, "utf8")
        }
    }
    return undefined
}

// The path of a case-insensitive `pull_request_template.md` directly inside
// `dir`, or undefined. Only a regular file counts — a directory by that name
// (the multi-template form) is skipped. A missing/unreadable dir → undefined.
const findTemplateFile = (dir: string): string | undefined => {
    let entries: fs.Dirent[]
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
        return undefined
    }
    for (const entry of entries) {
        if (
            entry.name.toLowerCase() === "pull_request_template.md" &&
            entry.isFile()
        ) {
            return path.join(dir, entry.name)
        }
    }
    return undefined
}
