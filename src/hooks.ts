import { spawn } from "node:child_process"
import { terminal } from "cmdore"
import type { HookEvent, UberepoConfig } from "@/config"

// The context a single hook fires in: the workspace root, the repo whose git op
// just succeeded (its flat source/<name> name, absolute path, clone URL, and —
// for a worktree-bound event — the task branch), and the task name. `task` and
// `branch` are absent for post-clone (a clone has no task); the runner maps both
// to empty UBEREPO_* values so a hook can read the var unconditionally.
export type HookContext = {
    config: UberepoConfig
    workspace: string
    task?: string
    repo: {
        name: string
        path: string
        url: string
        branch?: string
    }
    // Honour --no-hooks (arity-0 boolean from cmdore) without threading argv in.
    noHooks?: boolean
}

// One hook's outcome, as emitted in the JSON `hooks` array: which event fired,
// for which repo, and the command's exit code (0 = success, non-zero = failure).
export type HookResult = {
    event: HookEvent
    repo: string
    exit: number
}

// True when hooks are disabled for this run: the explicit --no-hooks flag, or
// the UBEREPO_NO_HOOKS env var set to any non-empty value (the env-side kill
// switch, e.g. for CI or a one-off `UBEREPO_NO_HOOKS=1 uberepo sync ...`).
const disabled = (noHooks?: boolean): boolean => {
    if (noHooks) {
        return true
    }
    const env = process.env.UBEREPO_NO_HOOKS
    return env !== undefined && env !== ""
}

// The UBEREPO_* environment a hook receives, layered ON TOP of process.env so a
// hook still sees PATH and the rest of the ambient environment. These names are
// the public hook API; post-clone has no task, so UBEREPO_TASK / UBEREPO_BRANCH
// are empty strings there (never unset) for a stable contract.
const hookEnv = (event: HookEvent, ctx: HookContext): NodeJS.ProcessEnv => ({
    ...process.env,
    UBEREPO_EVENT: event,
    UBEREPO_TASK: ctx.task ?? "",
    UBEREPO_REPO: ctx.repo.name,
    UBEREPO_REPO_PATH: ctx.repo.path,
    UBEREPO_REPO_URL: ctx.repo.url,
    UBEREPO_BRANCH: ctx.repo.branch ?? "",
    UBEREPO_WORKSPACE: ctx.workspace
})

// Run a shell command to completion in `cwd`, resolving with its exit code. The
// command is a COMMAND LINE (not an argv) so any interpreter works — it runs
// through the platform shell (`sh -c` on posix, cmd on Windows) via spawn's
// shell option, matching the design's "value is a command line" contract. stdio
// is inherited in human mode so install output streams live; in JSON mode it is
// ignored so the single JSON object stays the only thing on stdout. A spawn
// error (e.g. the shell itself missing) surfaces as a non-zero exit, treated
// like any failing hook rather than crashing the command.
const runShell = (
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv
): Promise<number> =>
    new Promise((resolve) => {
        const child = spawn(command, {
            cwd,
            env,
            shell: true,
            stdio: terminal.jsonMode ? "ignore" : "inherit"
        })
        child.on("error", () => resolve(1))
        child.on("close", (code) => resolve(code ?? 1))
    })

// Fire the hook bound to `event` for one repo, after that repo's git op has
// already succeeded. Returns null when there is nothing to run — no `hooks`
// entry for the event, or hooks are disabled — so callers can simply skip a
// null. Otherwise runs the command and returns its { event, repo, exit }. A
// non-zero exit is NEVER thrown here: the git op is already valid, so the caller
// logs the failure, keeps going, and exits non-zero at the end (uberepo's
// partial-state, re-run model). The success/failure line is logged here (human
// mode only) so every call site reports hooks identically.
export const runHook = async (
    event: HookEvent,
    ctx: HookContext
): Promise<HookResult | null> => {
    const command = ctx.config.hooks?.[event]
    if (command === undefined) {
        return null
    }
    if (disabled(ctx.noHooks)) {
        return null
    }
    terminal.log(`${ctx.repo.name}: running ${event} hook (${command})`)
    const exit = await runShell(command, ctx.repo.path, hookEnv(event, ctx))
    if (exit === 0) {
        terminal.log(`${ctx.repo.name}: ${event} hook ok`)
    } else {
        terminal.error(`${ctx.repo.name}: ${event} hook failed (exit ${exit})`)
    }
    return { event, repo: ctx.repo.name, exit }
}
