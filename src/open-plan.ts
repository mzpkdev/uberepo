import type { CarryEntry } from "@/carry"
import type { HookResult } from "@/hooks"
import type { CloneRepo } from "@/sources"
import type { TaskNote } from "@/tasks"

// The PURE decision core of `open`. Everything here works on in-memory values —
// no fs, no git, no terminal — so the scope/note/exit-code rules can be reasoned
// about and unit-tested in isolation. `open.ts` does the IO (reading sources off
// disk, creating worktrees, writing the note) and asks this module WHAT to do.

// Validate --repos BEFORE creating anything: every supplied name must be a
// registered repo. It need NOT be cloned — a registered-but-uncloned name is the
// on-demand clone path. Mirror clone's pre-flight collision guard — fail loud
// and create nothing on the first unknown name, so a typo never half-opens a
// task. Returns the supplied names de-duplicated in supplied order; [] when no
// --repos was given.
export const validateSuppliedRepos = (
    supplied: string[] | undefined,
    registered: string[]
): string[] => {
    const result: string[] = []
    if (supplied === undefined) {
        return result
    }
    for (const name of supplied) {
        if (!registered.includes(name)) {
            const known = registered.join(", ") || "(none registered)"
            throw new Error(
                `${name} is not a registered repository — known: ${known}. Register it (or fix the name) before scoping a task to it.`
            )
        }
        if (!result.includes(name)) {
            result.push(name)
        }
    }
    return result
}

// Everything planOpen needs to decide what `open` should do, gathered by the
// shell from disk. `taskExists` (a note OR an open worktree is present) and
// `hasNote` (a note actually parsed) are DISTINCT: both a brand-new task and an
// existing unscoped one have an empty stored scope, but only the former lacks a
// note, and --repos must seed the one while only growing the other.
export type OpenInput = {
    registered: string[]
    cloned: string[]
    storedScope: string[]
    suppliedScope: string[]
    taskExists: boolean
    hasNote: boolean
    goal: string | undefined
}

// One repo's open outcome: `created` (a fresh worktree landed) or `skipped`
// (its worktree was already open — the idempotent/recovery path — or no
// worktree could be attempted, with `reason` set: a failed pre-open or
// pre-clone hook, a failed on-demand clone, or a scope name that isn't
// registered at all).
export type OpenRepo = {
    name: string
    status: "created" | "skipped"
    reason?: string
}

// What `open` should do with the task's durable note, decided independently of
// the worktree plan:
//   - skip: an existing note with nothing to change — leave its bytes untouched.
//   - seed-template: a brand-new task with nothing to write — byte-copy the seed.
//   - write: --goal and/or a grown scope mutate the note (parse → mutate →
//     serialize), carrying the new goal (when set) and the recorded `repos`.
export type NoteAction =
    | { kind: "skip" }
    | { kind: "seed-template" }
    | { kind: "write"; goal?: string; repos: string[] }

// The full plan for one `open` run: the recorded scope, the worktree targets,
// the two soft-skip sets the shell logs, the note action, and whether the run is
// a no-op (nothing to open and nothing to skip).
export type OpenPlan = {
    scope: string[]
    targets: string[]
    // stored-scope names that aren't registered at all → a soft per-repo skip
    // (there's no URL to clone from; a note may outlive a repo's registration).
    unknownScope: string[]
    // registered repos that are neither cloned nor a target → the "run clone
    // first" log, so a partially-cloned workspace still opens what it can.
    notCloned: string[]
    noteAction: NoteAction
    empty: boolean
}

// Resolve a run of `open` into a plan from in-memory inputs. Scope, targets, the
// skip sets, the note action, and the empty guard are all derived here; the
// shell turns the plan into IO.
export const planOpen = (input: OpenInput): OpenPlan => {
    const { registered, cloned, storedScope, suppliedScope, taskExists } = input

    // The effective scope: --repos only ever GROWS a task's scope, never
    // narrows it. Three cases, keyed off the stored scope and whether the
    // task already exists:
    //   - Already scoped (stored scope non-empty): UNION the supplied names
    //     in — replacing would strand worktrees the task already owns.
    //   - Existing UNSCOPED task (stored scope empty, task exists): STAYS
    //     unscoped — an unscoped task is "all cloned repos", the maximal
    //     set, so --repos can't shrink it. The named repos still get
    //     cloned-on-demand + opened (added to `targets` below), but the
    //     recorded scope remains [] so no already-open worktree is stranded.
    //   - Brand-new task (stored scope empty, task doesn't exist yet):
    //     --repos SEEDS the initial scope; no --repos leaves it unscoped.
    // Order: stored first, then newly-supplied, for stable notes.
    const scope: string[] = [...storedScope]
    if (storedScope.length > 0 || !taskExists) {
        for (const name of suppliedScope) {
            if (!scope.includes(name)) {
                scope.push(name)
            }
        }
    }
    const scoped = scope.length > 0
    // Worktree targets. Scoped: the in-scope REGISTERED repos (scope ∩
    // registered, kept in registration order) — an in-scope repo that
    // isn't cloned yet is cloned on demand, because a scoped name is an
    // explicit ask for exactly that repo. Unscoped: every cloned repo PLUS any
    // supplied --repos names (∩ registered) — naming a repo is an explicit ask
    // for it, so it is cloned-on-demand + opened even on an unscoped task;
    // without --repos this is exactly today's every-cloned-repo behaviour,
    // which still never clones implicitly.
    const targets = scoped
        ? registered.filter((n) => scope.includes(n))
        : registered.filter(
              (n) => cloned.includes(n) || suppliedScope.includes(n)
          )

    // The uncloned repos this run will NOT touch (registered but outside the
    // targets), warned + skipped the way status does.
    const notCloned = registered.filter(
        (name) => !cloned.includes(name) && !targets.includes(name)
    )

    // A scope name that isn't registered at all can be neither opened nor
    // cloned (there is no URL to clone from). A note may legitimately outlive a
    // repo's registration, so this is a per-repo skip — warned and recorded,
    // never an abort.
    const unknownScope = scope.filter((name) => !registered.includes(name))

    // Nothing to open: no worktree target survived (no cloned repo and no
    // --repos name to clone on demand). The unknownScope guard keeps an
    // unregistered stored-scope name out of this path so it is still reported as
    // a per-repo skip in the loop below — an unregistered stored-scope name must
    // NOT make the run empty.
    const empty = targets.length === 0 && unknownScope.length === 0

    // The scope only changes the note when --repos actually grew it past what
    // was already stored; re-running with the same (or no) scope leaves the
    // note's repos: line untouched, preserving the no-clobber contract. The
    // note action is orthogonal to the worktree plan above.
    const scopeGrew = scope.length > storedScope.length
    let noteAction: NoteAction
    if (input.goal === undefined && !scopeGrew) {
        // Nothing to write into the note: preserve the original idempotent /
        // recovery contract — byte-copy the template only for a brand-new task
        // (no note yet); an existing note is never touched.
        noteAction = input.hasNote
            ? { kind: "skip" }
            : { kind: "seed-template" }
    } else {
        // --goal and/or a grown scope mutate the note. The shell applies the
        // change in place on an existing note, or starts from the parsed
        // template seed on a fresh task. Either way the recorded scope is
        // `scope`, and goal rides along when set.
        noteAction = { kind: "write", goal: input.goal, repos: scope }
    }

    return { scope, targets, unknownScope, notCloned, noteAction, empty }
}

// The outcomes of an `open` run, gathered by the shell, that summarize() turns
// into the JSON payload and the exit-code decision. `note` is the final TaskNote
// read back off disk (undefined when none landed — omitted from the JSON).
export type OpenOutcomes = {
    task: string
    scope: string[]
    repos: OpenRepo[]
    clone: CloneRepo[]
    hooks: HookResult[]
    carry: CarryEntry[]
    note: TaskNote | undefined
}

// Reduce an `open` run's outcomes to the data the shell needs: the terminal.json
// payload, the failed-clone and failed-hook lists, and the resulting exit code.
// Returns DATA only — the shell formats the error strings and pluralization, so
// the wording lives in one place (the command) and the rules live here.
export const summarize = (
    o: OpenOutcomes
): {
    json: object
    failedClones: string[]
    failedHooks: string[]
    exitCode: 0 | 1
} => {
    const json = {
        task: o.task,
        scope: o.scope,
        repos: o.repos,
        clone: o.clone,
        hooks: o.hooks,
        carry: o.carry,
        // Omit the note key when absent, matching status's omit-when-absent.
        ...(o.note ? { note: o.note } : {})
    }
    // A failed on-demand clone left its repo without a worktree, but the others
    // were still opened — a clone failure is never a clean run.
    const failedClones = o.clone
        .filter((c) => c.status === "failed")
        .map((c) => c.name)
    // A failing post-open never removes its worktree (and a failing pre-open
    // just left its repo unopened), but the run is not clean.
    const failedHooks = o.hooks
        .filter((h) => h.exit !== 0)
        .map((h) => `${h.repo} (${h.event})`)
    const exitCode = failedClones.length > 0 || failedHooks.length > 0 ? 1 : 0
    return { json, failedClones, failedHooks, exitCode }
}
