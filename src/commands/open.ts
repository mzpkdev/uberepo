import * as fs from "node:fs"
import * as path from "node:path"
import { defineCommand, terminal } from "cmdore"
import { task } from "@/arguments/task"
import type { CarryEntry } from "@/carry"
import { Config, TASKS_DIR } from "@/config"
import type { HookResult } from "@/hooks"
import {
    type OpenRepo,
    parseBranchSpecs,
    planOpen,
    summarize,
    validateBranchScope,
    validateSuppliedRepos
} from "@/open-plan"
import { collectSources, openRepoWorktree } from "@/open-steps"
import { branch as branchOpt } from "@/options/branch"
import { from } from "@/options/from"
import { goal } from "@/options/goal"
import { noHooks } from "@/options/no-hooks"
import { repos } from "@/options/repos"
import { TEMPLATE_DIR } from "@/package-root"
import type { CloneRepo } from "@/sources"
import {
    type TaskNote,
    taskBranch,
    UBERTASK_FILENAME,
    worktreePath
} from "@/tasks"
import type { UbertaskBranch } from "@/ubertask"
import * as ubertask from "@/ubertask"

// The seed ubertask.yml lives in the package's real template/ dir and is
// byte-copied into a task at runtime. TEMPLATE_DIR is anchored to the package
// root (see package-root.ts) — not process.cwd(), which is the workspace — so
// it resolves from source under tsx, from the published dist/ bundle, and
// under `npm link` alike.
const UBERTASK_TEMPLATE = path.join(TEMPLATE_DIR, UBERTASK_FILENAME)

export default defineCommand({
    name: "open",
    description:
        "Open a task, creating its worktree in every source repository",
    arguments: [task],
    options: [from, goal, repos, branchOpt, noHooks],
    async run(argv) {
        const config = await Config.read()
        const root = await Config.root()
        // Omitting --from branches each CREATED worktree off its clone's
        // current HEAD; an ADOPTED branch ignores this (it checks out the
        // existing branch's own tip).
        const base = argv.from ?? "HEAD"
        // The resolved --branch spec (both forms, validated for format up
        // front). The per-repo adopt-or-create decision happens inside each
        // open step; here it is only parsed and — once targets are known —
        // validated against the scope.
        const branchSpec = parseBranchSpecs(argv.branch)

        // The registered flat names (registration order) with their URLs, and
        // which of them are already cloned, read off disk. Whether an uncloned
        // repo is merely skipped or cloned on demand depends on the scope —
        // computed below — so nothing is logged here yet. The URL map lets a
        // fired hook surface UBEREPO_REPO_URL and feeds the on-demand clones
        // (the loops below work in flat names).
        const { registered, cloned, urlByName } = collectSources(config, root)

        // The task's durable note carries its declared scope; read it once up
        // front so a re-open without --repos can honour a previously-stored
        // scope and a re-open with --repos can UNION into it.
        const note = path.join(root, TASKS_DIR, argv.task, UBERTASK_FILENAME)
        const noteRelative = path.join(TASKS_DIR, argv.task, UBERTASK_FILENAME)
        const existing = await ubertask.read(note)
        const storedScope = existing?.repos ?? []

        // Whether this task ALREADY EXISTS — needed because both a brand-new
        // task and an existing UNSCOPED one have an empty stored scope, yet
        // --repos must treat them differently: it SEEDS the initial scope of a
        // brand-new task but must only ADD to (never narrow) an existing
        // unscoped task, which stays unscoped (= all cloned repos). A bare
        // unscoped open seeds a note, but the nothing-to-open path below does
        // not, so the open worktree dirs are consulted too: a re-open must
        // never strand a worktree the task already owns, note present or not.
        const present = registered.filter((name) =>
            fs.existsSync(worktreePath(root, argv.task, name))
        )
        const taskExists = existing !== undefined || present.length > 0

        // Validate --repos BEFORE creating anything (deduped, supplied order;
        // throws on the first unregistered name), then let the pure planner
        // resolve the scope, the worktree targets, and the skip sets. The shell
        // below only does the IO the plan calls for.
        const suppliedScope = validateSuppliedRepos(argv.repos, registered)
        const plan = planOpen({
            registered,
            cloned,
            storedScope,
            suppliedScope,
            taskExists,
            hasNote: existing !== undefined,
            goal: argv.goal
        })
        const scope = plan.scope

        // A `--branch <repo>=<name>` for a repo this open won't touch is an
        // error (fail loud, create nothing — like the unknown-name guard).
        // Checked against the worktree targets, the repos a branch can apply to.
        validateBranchScope(branchSpec, plan.targets)

        // Warn + skip the uncloned repos this run will NOT touch (registered
        // but outside the targets), the way status does, so a partially-cloned
        // workspace still opens what it can.
        for (const name of plan.notCloned) {
            terminal.log(`Skipping ${name} — not cloned (run clone first)`)
        }

        if (plan.empty) {
            // Nothing to open: no worktree target survived (no cloned repo and
            // no --repos name to clone on demand). No worktree is opened and no
            // note is seeded on this path, so the JSON carries an empty scope/
            // repos, no clone, hooks, or carry, and no note key. The empty guard
            // keeps an unregistered stored-scope name off this path so it is
            // still reported as a per-repo skip in the loop below.
            terminal.json({
                task: argv.task,
                scope: [],
                repos: [],
                clone: [],
                hooks: [],
                carry: []
            })
            terminal.log("Nothing to open — no cloned repositories.")
            return
        }

        let opened = 0
        const repos: OpenRepo[] = []
        // One entry per repo this run clone-attempted ON DEMAND (an explicitly
        // asked-for target with no source/<name> yet — a scoped name, or a
        // --repos name on an unscoped task) — the same per-repo shape `clone`
        // emits. Empty whenever no on-demand clone ran.
        const clone: CloneRepo[] = []
        // One entry per hook that actually ran (pre-/post-clone for on-demand
        // clones, pre-open and post-open for worktrees this run actually tried
        // to create — never an already-open skip). A non-zero exit is
        // collected and flips the command's exit code at the end without
        // aborting the rest.
        const hooks: HookResult[] = []
        // One entry per repo whose carry actually ran (a NEWLY-created worktree
        // in a repo with carry patterns): the untracked local files copied in,
        // kept, or skipped as tracked. A skipped (already-open) worktree keeps
        // its files as-is — `sync` is the missing-files repair.
        const carry: CarryEntry[] = []
        // A scope name that isn't registered at all can be neither opened nor
        // cloned (there is no URL to clone from). A note may legitimately
        // outlive a repo's registration, so this is a per-repo skip — warned
        // and recorded, never an abort.
        for (const name of plan.unknownScope) {
            repos.push({
                name,
                status: "skipped",
                reason: "not registered"
            })
            terminal.warn(
                `${name}: in the task scope but not a registered repository — skipping; add it or remove it from the note's repos:`
            )
        }
        // Each target's worktree is opened (and, on demand, cloned) by the
        // effectful step, which RETURNS its outcome as a value — the per-repo
        // entry, an optional on-demand-clone entry, the hooks that ran, an
        // optional carry entry, and whether a worktree actually landed. The loop
        // just aggregates those into the run's arrays; the fail-fast
        // worktree-create error propagates straight through to abort the run.
        const ctx = {
            config,
            root,
            task: argv.task,
            branchSpec,
            base,
            urlByName,
            noHooks: argv["no-hooks"]
        }
        // The branches each newly-created worktree landed on, keyed by repo —
        // collected from the step outcomes to persist in the note's `branches:`
        // map. Only `created` repos carry one; a skip (already open, hook gate,
        // failed clone) records nothing this run.
        const branchRecords: Record<string, UbertaskBranch> = {}
        for (const name of plan.targets) {
            const out = await openRepoWorktree(name, ctx)
            repos.push(out.repo)
            if (out.clone) {
                clone.push(out.clone)
            }
            hooks.push(...out.hooks)
            if (out.carry) {
                carry.push(out.carry)
            }
            if (out.opened) {
                opened += 1
            }
            if (out.branch) {
                branchRecords[name] = out.branch
            }
        }

        // A branch record is worth persisting only when it deviates from the
        // pure task/<task> default: an adopted branch, OR a created branch with
        // a non-default name (an explicit --branch). A plain `open` that just
        // cut task/<task> in every repo records nothing — preserving the
        // no-clobber/idempotent note contract (a bare re-open never rewrites a
        // hand-edited note). branchFor() falls back to task/<task> for those.
        const persistBranches = Object.values(branchRecords).some(
            (b) => b.adopted || b.name !== taskBranch(argv.task)
        )

        // Seed the task's durable note at the TASK level (sibling of the per-repo
        // worktree dirs), so it survives a fresh session as the standing "why".
        // The task dir already exists (a worktree just landed under it); mkdir -p
        // covers the all-skipped case for safety.
        await fs.promises.mkdir(path.dirname(note), { recursive: true })
        // Apply the planner's note action, with one addition: a deviating
        // branch (adopt or --branch) forces a write even when the action was
        // skip/seed-template, because the `branches:` map MUST be recorded for
        // close/prune/sync to know which branch each repo is on and whether it
        // was adopted. `skip` leaves an existing note's bytes untouched
        // (idempotent/recovery) ONLY when nothing branch-worthy landed.
        // `seed-template` byte-copies the template into a brand-new task.
        // `write` mutates the note — on an existing note IN PLACE (every other
        // field preserved), on a fresh task from the parsed template seed.
        const action = plan.noteAction
        if (action.kind === "skip" && !persistBranches) {
            terminal.log(`Skipping ${noteRelative} — already exists`)
        } else if (action.kind === "seed-template" && !persistBranches) {
            await fs.promises.copyFile(UBERTASK_TEMPLATE, note)
            terminal.log(`Seeded ${noteRelative}`)
        } else {
            const target =
                existing ??
                ubertask.parse(
                    await fs.promises.readFile(UBERTASK_TEMPLATE, "utf8")
                )
            if (action.kind === "write" && action.goal !== undefined) {
                target.goal = action.goal
            }
            if (action.kind === "write") {
                target.repos = action.repos
            }
            // Record the deviating branches (adopt / --branch) only — merging
            // over any already stored, so a re-open that adopts a new repo adds
            // to the map without dropping branches recorded earlier. A plain
            // created task/<task> is NOT written (branchFor falls back to it),
            // keeping the note free of redundant default entries.
            if (persistBranches) {
                target.branches = { ...target.branches, ...branchRecords }
            }
            await ubertask.write(note, target)
            // Word the line for the change that actually happened: goal wins the
            // headline when set, then a grown scope, else the recorded branches.
            const what =
                action.kind === "write" && action.goal !== undefined
                    ? "goal"
                    : action.kind === "write"
                      ? "scope"
                      : "branches"
            if (existing) {
                terminal.log(`Updated ${what} in ${noteRelative}`)
            } else {
                terminal.log(`Seeded ${noteRelative} (${what} set)`)
            }
        }

        // A note always lands on this path (seeded, copied, or updated above),
        // so read it back with its mtime to emit the same TaskNote shape #2
        // froze for status — the agent's open and status views then agree.
        const parsed = await ubertask.read(note)
        const stat = await fs.promises.stat(note)
        const finalNote: TaskNote | undefined = parsed
            ? { ...parsed, mtime: stat.mtimeMs }
            : undefined
        // The pure summary turns the run's outcomes into the JSON payload, the
        // failed-clone/failed-hook lists, and the exit code; the shell owns the
        // wording and pluralization of the error lines.
        const { json, failedClones, failedHooks, exitCode } = summarize({
            task: argv.task,
            scope,
            repos,
            clone,
            hooks,
            carry,
            note: finalNote
        })
        terminal.json(json)

        terminal.log(
            `Opened task ${argv.task} in ${opened} ${
                opened === 1 ? "repository" : "repositories"
            }`
        )
        // A failed on-demand clone left its repo without a worktree, but the
        // others were still opened: summarise and exit non-zero, matching
        // clone's convention that a clone failure is never a clean run. A
        // re-run retries it — the repo stays in the scope.
        if (failedClones.length > 0) {
            terminal.error(
                `clone failed in ${failedClones.length} ${
                    failedClones.length === 1 ? "repository" : "repositories"
                }: ${failedClones.join(", ")}`
            )
        }
        // A failing post-open never removes its worktree (and a failing
        // pre-open just left its repo unopened), but the run is not clean:
        // summarise and exit non-zero so a wrapper/CI sees the failure.
        if (failedHooks.length > 0) {
            terminal.error(
                `hooks failed in ${failedHooks.length} ${
                    failedHooks.length === 1 ? "repository" : "repositories"
                }: ${failedHooks.join(", ")}`
            )
        }
        process.exitCode = exitCode || undefined
    }
})
