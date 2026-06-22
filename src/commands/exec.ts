import { spawn } from "node:child_process"
import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { command } from "@/arguments/command"
import { task } from "@/arguments/task"
import { Config, TASKS_DIR } from "@/config"
import { bail } from "@/options/bail"
import { repos } from "@/options/repos"
import {
    branchFor,
    taskParticipants,
    UBERTASK_FILENAME,
    worktreePath
} from "@/tasks"
import * as ubertask from "@/ubertask"

// One worktree's exec outcome.
//   status: ok      — the command exited 0
//           failed  — the command exited non-zero (loop continued unless --bail;
//                     the run's exit is non-zero either way)
//           skipped — a scope name with no worktree on disk (never run)
//   exitCode: the child's exit code; null collapses to 1 (a signal-killed or
//             un-spawnable child is a failure, not a success). A skipped repo
//             carries no exit code.
//   branch:   the branch the worktree is on, for the human header + JSON parity
//             with ship/diff (resolved through branchFor like every command).
//   stdout/stderr: captured ONLY in JSON mode (piped); in human mode the child
//             streams live to the terminal, so there is nothing to record.
type ExecRepo = {
    name: string
    branch: string
    exitCode?: number
    status: "ok" | "failed" | "skipped"
    stdout?: string
    stderr?: string
}

// The UBEREPO_* environment a spawned command inherits, layered ON TOP of the
// ambient process.env so PATH and the rest survive. These are the SAME names
// hooks export (see hooks.ts' hookEnv), minus the hook-only UBEREPO_EVENT and
// UBEREPO_PR_URL — an exec'd command is not a hook firing, so it gets the task
// context (task / repo / path / url / branch / workspace) without the lifecycle
// vars. Reusing the names means a script written for a hook works under exec too.
const execEnv = (
    workspace: string,
    taskName: string,
    repo: { name: string; path: string; url: string; branch: string }
): NodeJS.ProcessEnv => ({
    ...process.env,
    UBEREPO_TASK: taskName,
    UBEREPO_REPO: repo.name,
    UBEREPO_REPO_PATH: repo.path,
    UBEREPO_REPO_URL: repo.url,
    UBEREPO_BRANCH: repo.branch,
    UBEREPO_WORKSPACE: workspace
})

// Run one command to completion in `cwd`, resolving with its exit code (a
// signal-killed or un-spawnable child resolves 1, never rejects — exec's
// per-repo contract is to record a failure and carry on, like a failing hook).
// In JSON mode stdio is PIPED and the streams are collected so the single JSON
// object can carry them; in human mode it is INHERITED so the child streams
// live (test/build output the operator wants to watch). NO shell: argv[0] is
// the program and the rest its arguments, passed verbatim (mirrors git.ts'
// execFile — a token like `;` is an argument, never a shell operator).
const runCommand = (
    argv: string[],
    cwd: string,
    env: NodeJS.ProcessEnv
): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
        const child = spawn(argv[0], argv.slice(1), {
            cwd,
            env,
            stdio: terminal.jsonMode ? "pipe" : "inherit"
        })
        // Buffers stay empty in human mode (stdio inherited → no pipes attached);
        // in JSON mode they accumulate the child's two streams as utf8.
        let stdout = ""
        let stderr = ""
        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString()
        })
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString()
        })
        // A spawn error (e.g. argv[0] not on PATH) is a failed run, not a crash:
        // surface ENOENT et al. on the captured stderr so JSON mode still
        // reports why, and resolve non-zero.
        child.on("error", (error) => {
            stderr += error instanceof Error ? error.message : String(error)
            resolve({ exitCode: 1, stdout, stderr })
        })
        child.on("close", (code) => {
            resolve({ exitCode: code ?? 1, stdout, stderr })
        })
    })

export default defineCommand({
    name: "exec",
    description: "Run one command inside every one of a task's worktrees",
    arguments: [task, command],
    options: [repos, bail],
    async run(argv) {
        const config = await Config.read()
        const root = await Config.root()

        // The command is captured as the variadic argument (everything after
        // `--`). cmdore lets it be empty (it is not `required` — see
        // arguments/command.ts), so guard here with a pointed message that
        // reminds the operator of the `--` shape, rather than fanning out a
        // no-op or leaking cmdore's generic "argument is required".
        if (argv.command === undefined || argv.command.length === 0) {
            throw new Error(
                `exec needs a command — uberepo exec ${argv.task} -- <cmd>`
            )
        }

        // The durable note supplies the task's declared scope (which
        // participants it owns). Read straight from the note file (mirrors
        // ship): nothing else from the note matters to exec.
        const notePath = path.join(
            root,
            TASKS_DIR,
            argv.task,
            UBERTASK_FILENAME
        )
        const note = await ubertask.read(notePath)

        // Universe = the task's declared scope when non-empty, else every
        // PARTICIPANT (bare or aliased) that currently has a worktree for this
        // task. Then ∩ the --repos filter. participantByName maps a participant
        // name back to its source/repo/url so each target can spawn in the right
        // worktree with the right UBEREPO_* env. Identical to ship's universe.
        const scope = note?.repos ?? []
        const participants = taskParticipants(config, root, argv.task)
        const participantByName = new Map(participants.map((p) => [p.name, p]))
        const present = participants.map((p) => p.name)
        const universe =
            scope.length > 0
                ? scope.filter((n) => present.includes(n))
                : present

        // The --repos filter is transient (it never touches the note's scope):
        // it narrows this run to a subset of the universe. A name outside the
        // universe is an error (mirrors ship) — fail before running anything, so
        // a typo never silently runs against the wrong (or no) repos.
        let targets = universe
        if (argv.repos !== undefined) {
            const filter: string[] = []
            for (const name of argv.repos) {
                if (!universe.includes(name)) {
                    const known = universe.join(", ") || "(none)"
                    throw new Error(
                        `${name} is not a repo in task ${argv.task} — known: ${known}.`
                    )
                }
                if (!filter.includes(name)) {
                    filter.push(name)
                }
            }
            targets = universe.filter((n) => filter.includes(n))
        }

        // Nothing to run (no worktrees, or the filter emptied the universe):
        // emit the same empty JSON shape exec always emits, warn, and return —
        // never spawn (mirrors diff/ship's empty guard).
        if (targets.length === 0) {
            terminal.json({ task: argv.task, command: argv.command, repos: [] })
            terminal.warn(`Nothing to run for task ${argv.task}.`)
            return
        }

        // ── SEQUENTIAL fan-out: run the command in each target's worktree in
        // turn. Sequential on purpose — exec's payload is tests/builds whose
        // output the operator reads, and interleaving N live streams would be
        // unreadable; parallelism is explicitly out of scope. A non-zero exit is
        // recorded and the loop continues (so one failing repo never hides the
        // rest), UNLESS --bail, which stops after the first failure.
        const results: ExecRepo[] = []
        // The command joined back for the human header only (display, never
        // re-parsed — the child is always spawned from the argv array).
        const display = argv.command.join(" ")
        for (const name of targets) {
            const participant = participantByName.get(name)
            const branch = branchFor(argv.task, name, note?.branches)
            // A scope name with no worktree on disk: skip it (like ship's
            // missing-participant skip) rather than spawning in a path that
            // isn't a worktree.
            if (!participant) {
                results.push({
                    name,
                    branch,
                    status: "skipped"
                })
                terminal.log(`${name}: no worktree — skipping`)
                continue
            }

            const cwd = worktreePath(root, argv.task, name)
            // Human mode: one header line per repo, then the child streams live
            // beneath it (stdio inherited). JSON mode prints nothing here — the
            // single JSON object at the end is the only thing on stdout.
            if (!terminal.jsonMode) {
                terminal.log(`▸ ${name}  $ ${display}`)
            }
            const { exitCode, stdout, stderr } = await runCommand(
                argv.command,
                cwd,
                execEnv(root, argv.task, {
                    name,
                    path: cwd,
                    url: participant.url,
                    branch
                })
            )
            const out: ExecRepo = {
                name,
                branch,
                exitCode,
                status: exitCode === 0 ? "ok" : "failed"
            }
            // Only JSON mode captured the streams; omit the keys entirely in
            // human mode (and never carry empty strings that mean nothing).
            if (terminal.jsonMode) {
                out.stdout = stdout
                out.stderr = stderr
            }
            results.push(out)

            // --bail: the first non-zero exit stops the fan-out. The repos that
            // already ran are still reported (and the failure summary below
            // still fires); the untouched repos simply don't appear.
            if (argv.bail && exitCode !== 0) {
                break
            }
        }

        terminal.json({
            task: argv.task,
            command: argv.command,
            repos: results
        })

        // Continue-on-fail with a non-zero exit: if ANY command failed, flip the
        // command's exit code and print a summary naming the failed repos and
        // their exit codes (mirrors ship's failure summary), so a wrapper/CI
        // sees the failure even though exec ran every (non-bailed) target.
        const failed = results.filter((r) => r.status === "failed")
        if (failed.length > 0) {
            const which = failed
                .map((r) => `${r.name} (exit ${r.exitCode})`)
                .join(", ")
            terminal.error(
                `exec failed in ${failed.length} ${
                    failed.length === 1 ? "repository" : "repositories"
                }: ${which}`
            )
            process.exitCode = 1
        }
    }
})
