import * as fs from "node:fs"
import * as path from "node:path"
import { defineCommand, effect, terminal } from "cmdore"
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
    validateParticipants,
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
    participantBranch,
    type TaskNote,
    taskPath,
    UBERTASK_FILENAME
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
        // The participant folders already on disk for this task — any
        // tasks/<task>/<name> subdir (bare repo OR repo@alias), not just the
        // registered bare names, so an existing aliased worktree still marks the
        // task as existing. A missing task dir reads as none.
        let present: string[] = []
        try {
            present = fs
                .readdirSync(taskPath(root, argv.task), {
                    withFileTypes: true
                })
                .filter((e) => e.isDirectory())
                .map((e) => e.name)
        } catch {
            // No task dir yet — brand-new task, no worktrees present.
        }
        const taskExists = existing !== undefined || present.length > 0

        // Validate the run's participant SHAPE up front (separators, globs,
        // reserved names, case collisions) across both the stored scope and the
        // newly supplied --repos, before anything is created — a malformed or
        // colliding name must fail loud, never half-open a task.
        validateParticipants([...storedScope, ...(argv.repos ?? [])])
        // Validate --repos BEFORE creating anything (deduped, supplied order;
        // throws on the first unregistered repo), then let the pure planner
        // resolve the scope, the worktree targets, and the skip sets. The shell
        // below only does the IO the plan calls for. Each entry may be a
        // `repo@alias` participant; only the repo part is checked for registration.
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
        // `clonedRepos` tracks the bare repos clone-attempted this run so a repo
        // backing several participants is cloned ONCE (the step consults +
        // updates it). Shared across the loop's iterations via the one ctx.
        const ctx = {
            config,
            root,
            task: argv.task,
            branchSpec,
            base,
            urlByName,
            noHooks: argv["no-hooks"],
            clonedRepos: new Set<string>()
        }
        // The branches each newly-created worktree landed on, keyed by the
        // PARTICIPANT token — collected from the step outcomes to persist in the
        // note's `branches:` map. Only `created` participants carry one; a skip
        // (already open, hook gate, failed clone) records nothing this run.
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

        // The branch records worth persisting: only those that DEVIATE from the
        // participant's default — an adopted branch, OR a created branch with a
        // non-default name (an explicit --branch). A participant on its plain
        // default (task/<task> bare, task/<task>@<alias> aliased) is dropped:
        // branchFor() reconstructs that default from the token, so storing it
        // would just be a redundant entry. This keeps the `branches:` map an
        // overrides-only record even when some participants in the same open
        // deviate and others don't.
        const deviating: Record<string, UbertaskBranch> = {}
        for (const [name, b] of Object.entries(branchRecords)) {
            if (b.adopted || b.name !== participantBranch(argv.task, name)) {
                deviating[name] = b
            }
        }
        // Persist the map only when at least one participant deviated — a plain
        // `open` that just cut every participant's default records nothing,
        // preserving the no-clobber/idempotent note contract (a bare re-open
        // never rewrites a hand-edited note).
        const persistBranches = Object.keys(deviating).length > 0

        // Seed the task's durable note at the TASK level (sibling of the per-repo
        // worktree dirs), so it survives a fresh session as the standing "why".
        // The task dir already exists (a worktree just landed under it); mkdir -p
        // covers the all-skipped case for safety. Wrapped in effect(): under
        // --dry-run nothing is written to disk, but the planning + projection
        // below still run so the summary reports the note that WOULD land.
        await effect(() =>
            fs.promises.mkdir(path.dirname(note), { recursive: true })
        )
        // Apply the planner's note action, with one addition: a deviating
        // branch (adopt or --branch) forces a write even when the action was
        // skip/seed-template, because the `branches:` map MUST be recorded for
        // close/prune/sync to know which branch each repo is on and whether it
        // was adopted. `skip` leaves an existing note's bytes untouched
        // (idempotent/recovery) ONLY when nothing branch-worthy landed.
        // `seed-template` byte-copies the template into a brand-new task.
        // `write` mutates the note — on an existing note IN PLACE (every other
        // field preserved), on a fresh task from the parsed template seed.
        //
        // The disk MUTATION (copyFile / ubertask.write) is wrapped in effect();
        // the in-memory `projected` note — what the note's content WOULD be — is
        // computed OUTSIDE it, so the JSON/summary report the plan faithfully
        // under --dry-run. The terminal wording is prefixed "Would " in dry-run.
        const action = plan.noteAction
        const verb = effect.enabled
            ? { skip: "Skipping", seed: "Seeded", upd: "Updated" }
            : { skip: "Would skip", seed: "Would seed", upd: "Would update" }
        // The note's projected final content (read back for the summary). The
        // skip path keeps the existing note; seed-template projects the parsed
        // template; write projects the mutated target. undefined only if no
        // template can be read AND there is no existing note (not expected).
        let projected: ubertask.Ubertask | undefined
        if (action.kind === "skip" && !persistBranches) {
            terminal.log(`${verb.skip} ${noteRelative} — already exists`)
            projected = existing
        } else if (action.kind === "seed-template" && !persistBranches) {
            await effect(() => fs.promises.copyFile(UBERTASK_TEMPLATE, note))
            terminal.log(`${verb.seed} ${noteRelative}`)
            projected = ubertask.parse(
                await fs.promises.readFile(UBERTASK_TEMPLATE, "utf8")
            )
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
            // over any already stored, so a re-open that adopts a new
            // participant adds to the map without dropping branches recorded
            // earlier. A participant on its plain default is NOT written
            // (branchFor reconstructs it), keeping the note free of redundant
            // default entries.
            if (persistBranches) {
                target.branches = { ...target.branches, ...deviating }
            }
            await effect(() => ubertask.write(note, target))
            projected = target
            // Word the line for the change that actually happened: goal wins the
            // headline when set, then a grown scope, else the recorded branches.
            const what =
                action.kind === "write" && action.goal !== undefined
                    ? "goal"
                    : action.kind === "write"
                      ? "scope"
                      : "branches"
            if (existing) {
                terminal.log(`${verb.upd} ${what} in ${noteRelative}`)
            } else {
                terminal.log(`${verb.seed} ${noteRelative} (${what} set)`)
            }
        }

        // The TaskNote to emit, carrying the same shape #2 froze for status so
        // the agent's open and status views agree. A real run reads it back off
        // disk for the true mtime; under --dry-run nothing was written, so the
        // in-memory `projected` note is surfaced with a synthetic "now" mtime —
        // the JSON describes the note that WOULD land, never a stale read.
        let finalNote: TaskNote | undefined
        if (effect.enabled) {
            const parsed = await ubertask.read(note)
            const stat = await fs.promises.stat(note)
            finalNote = parsed ? { ...parsed, mtime: stat.mtimeMs } : undefined
        } else {
            finalNote = projected
                ? { ...projected, mtime: Date.now() }
                : undefined
        }
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

        // The headline reports the planned count under --dry-run (nothing was
        // actually opened); the worktrees the plan WOULD create are counted the
        // same way, so the number is faithful either way.
        terminal.log(
            `${effect.enabled ? "Opened" : "Would open"} task ${argv.task} in ${opened} ${
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
