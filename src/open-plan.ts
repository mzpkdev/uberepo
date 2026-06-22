import type { CarryEntry } from "@/carry"
import type { HookResult } from "@/hooks"
import type { CloneRepo } from "@/sources"
import {
    ALIAS_SEPARATOR,
    splitParticipant,
    stackParent,
    type TaskNote
} from "@/tasks"

// The PURE decision core of `open`. Everything here works on in-memory values —
// no fs, no git, no terminal — so the scope/note/exit-code rules can be reasoned
// about and unit-tested in isolation. `open.ts` does the IO (reading sources off
// disk, creating worktrees, writing the note) and asks this module WHAT to do.

// The parsed `--branch` option: a single bare `--branch <name>` sets `all`
// (every in-scope repo adopts/creates that branch); repeatable `--branch
// <repo>=<name>` tokens fill `perRepo`. cmdore gives us a flat string[] (the
// variadic shape `--repos` uses — the framework has no native key=value map),
// so this is where the two forms are told apart. The two forms are mutually
// exclusive: a bare name means "all repos", a `repo=name` means "this repo",
// and mixing them is ambiguous (does the bare name cover the named repo too?),
// so it is rejected up front.
export type BranchSpec = {
    all?: string
    perRepo: Record<string, string>
}

// Classify the raw `--branch` tokens into a BranchSpec, failing loud on a
// malformed or contradictory option BEFORE anything is created (mirrors
// validateSuppliedRepos' fail-first contract). Undefined / [] → an empty spec
// (every repo falls back to task/<task>). A token with `=` is `repo=name`
// (both sides required); a token without is a bare all-repos name. Errors: an
// empty side of `=`, more than one bare name, more than one entry for the same
// repo, or any mix of the bare and per-repo forms.
export const parseBranchSpecs = (tokens: string[] | undefined): BranchSpec => {
    const spec: BranchSpec = { perRepo: {} }
    if (tokens === undefined) {
        return spec
    }
    let bare: string | undefined
    for (const token of tokens) {
        const eq = token.indexOf("=")
        if (eq === -1) {
            if (bare !== undefined) {
                throw new Error(
                    `--branch was given more than one bare branch name (${bare}, ${token}) — pass a single bare name for all repos, or one <repo>=<name> per repo.`
                )
            }
            if (token === "") {
                throw new Error("--branch was given an empty branch name.")
            }
            bare = token
        } else {
            const repo = token.slice(0, eq)
            const name = token.slice(eq + 1)
            if (repo === "" || name === "") {
                throw new Error(
                    `--branch ${token} is malformed — expected <repo>=<branch>.`
                )
            }
            if (spec.perRepo[repo] !== undefined) {
                throw new Error(
                    `--branch was given two branches for ${repo} (${spec.perRepo[repo]}, ${name}).`
                )
            }
            spec.perRepo[repo] = name
        }
    }
    if (bare !== undefined && Object.keys(spec.perRepo).length > 0) {
        throw new Error(
            "--branch mixes a bare name (all repos) with <repo>=<name> entries — use one form or the other."
        )
    }
    if (bare !== undefined) {
        spec.all = bare
    }
    return spec
}

// Validate the per-participant `--branch <repo[@alias]>=<name>` keys against the
// run's targets BEFORE anything is created: a branch named for a participant
// that is not in the task's open scope this run is an error (consistent with
// open's fail-loud unknown-name guard — a `--branch repo=name` for a participant
// --repos didn't put in scope is a typo or a stale command, never silently
// ignored). The bare-name form is scope-agnostic (it applies to whatever IS in
// scope), so it is not checked here. Throws on the first offending participant.
export const validateBranchScope = (
    spec: BranchSpec,
    targets: string[]
): void => {
    for (const repo of Object.keys(spec.perRepo)) {
        if (!targets.includes(repo)) {
            const known = targets.join(", ") || "(none in scope)"
            throw new Error(
                `--branch ${repo}=${spec.perRepo[repo]} names a repo outside this open's scope — in scope: ${known}. Add it with --repos, or drop the --branch entry.`
            )
        }
    }
}

// Classify the raw `--stack` tokens into a child→parent map, failing loud on a
// malformed option BEFORE anything is created (mirrors parseBranchSpecs'
// fail-first contract). Each token is `<child>=<parent>`, split on the FIRST `=`
// (a participant token never contains `=`, so a single split is unambiguous).
// Simpler than parseBranchSpecs: there is no bare/all form — a base is inherently
// per-participant, so every token names exactly one edge. Undefined / [] → {}.
// Errors, each naming the offender: an empty side of `=`, a child declared twice
// (a branch stacks on at MOST one parent), or a self-edge (a branch can't stack
// on itself). The deeper scope/cross-repo/cycle checks are validateStackSpecs'
// job — this only parses the shape.
export const parseStackSpecs = (
    tokens: string[] | undefined
): Record<string, string> => {
    const specs: Record<string, string> = {}
    if (tokens === undefined) {
        return specs
    }
    for (const token of tokens) {
        const eq = token.indexOf("=")
        if (eq === -1) {
            throw new Error(
                `--stack ${token} is malformed — expected <child>=<parent>.`
            )
        }
        const child = token.slice(0, eq)
        const parent = token.slice(eq + 1)
        if (child === "" || parent === "") {
            throw new Error(
                `--stack ${token} is malformed — expected <child>=<parent>.`
            )
        }
        if (specs[child] !== undefined) {
            throw new Error(
                `--stack was given two parents for ${child} (${specs[child]}, ${parent}) — a branch stacks on at most one sibling.`
            )
        }
        if (child === parent) {
            throw new Error(
                `--stack ${token} stacks ${child} on itself — a branch cannot stack on its own branch.`
            )
        }
        specs[child] = parent
    }
    return specs
}

// Validate the `--stack <child>=<parent>` edges against the run's SCOPE BEFORE
// any IO — fail loud, create nothing (mirrors validateBranchScope's contract).
// The check is against the MERGED view of the edges already stored in the note
// PLUS the new specs, so a cycle that spans two `open` runs (run A declares
// a→b, run B declares b→a) is still caught at plan time. Three checks, each
// throwing a clear message naming the offender:
//   - parent ∉ scope → throw. Checked against `scope`, NOT this run's targets:
//     a parent can be in scope yet already open / not a target this run, and a
//     base is a sibling-in-the-TASK edge, not a sibling-opened-together one.
//   - cross-repo (child's repo ≠ parent's repo) → throw. A branch can only stack
//     within one git repo; splitParticipant(token).repo is the repo identity.
//   - a cycle in the merged child→parent map (a self-edge included) → throw,
//     naming the cycle. A stack is a forest, never a ring.
// `scope` is the task's declared participant set (plan.scope). `storedBranches`
// is the note's existing `branches:` map; its edges are derived via stackParent
// over the stored scope so only true sibling edges (not remote-ref bases) merge.
export const validateStackSpecs = (
    specs: Record<string, string>,
    scope: string[],
    storedBranches: Record<string, { base?: string }> | undefined
): void => {
    // Per-edge shape checks on the NEW specs first (the stored edges already
    // passed these when they were written): the parent must be in scope, and a
    // child can only stack on a sibling of the same repo.
    for (const [child, parent] of Object.entries(specs)) {
        if (!scope.includes(parent)) {
            const known = scope.join(", ") || "(none in scope)"
            throw new Error(
                `--stack ${child}=${parent} names a parent outside this task's scope — in scope: ${known}. Add it with --repos, or fix the --stack entry.`
            )
        }
        if (splitParticipant(child).repo !== splitParticipant(parent).repo) {
            throw new Error(
                `--stack ${child}=${parent} stacks across repositories — a branch can only stack on a sibling of the same repo.`
            )
        }
    }

    // The merged child→parent map: the edges already stored (an in-scope base is
    // a sibling edge — stackParent filters out remote-ref bases) overlaid with
    // the new specs, which WIN (an explicit --stack re-points an existing edge).
    // A cycle is detected over this whole graph so a ring split across two runs
    // is still caught.
    const edges: Record<string, string> = {}
    for (const name of scope) {
        const parent = stackParent(name, storedBranches, scope)
        if (parent !== undefined) {
            edges[name] = parent
        }
    }
    for (const [child, parent] of Object.entries(specs)) {
        edges[child] = parent
    }
    // Walk parent pointers from each child; a node revisited on the same walk is
    // a cycle. The visited path is reported so the operator sees the ring.
    for (const start of Object.keys(edges)) {
        const seen: string[] = []
        let node: string | undefined = start
        while (node !== undefined) {
            if (seen.includes(node)) {
                seen.push(node)
                throw new Error(
                    `--stack would create a cycle: ${seen.join(" → ")}.`
                )
            }
            seen.push(node)
            node = edges[node]
        }
    }
}

// The resolved branch NAME for one participant from a BranchSpec: its explicit
// per-participant entry (keyed by the full `repo` / `repo@alias` token), else
// the bare all-repos name, else the participant default. Pure — the caller
// passes the default in (participantBranch(task, name)) so this module stays
// free of the task→branch convention.
export const branchNameFor = (
    spec: BranchSpec,
    repo: string,
    fallback: string
): string => spec.perRepo[repo] ?? spec.all ?? fallback

// The adopt-or-create decision for one repo, from the resolved branch name's
// existence on disk (both checks done by the effectful caller):
//   - local branch exists → ADOPT it, no tracking change (attach the worktree
//     to the branch as-is).
//   - exists only on origin → ADOPT + TRACK (create the local branch from
//     origin/<name> and set it as upstream).
//   - exists nowhere → CREATE a fresh branch (the original `worktree add -b`).
// Pure decision; openRepoWorktree turns it into the right `Worktree.create`
// call (and into the recorded {adopted, base}).
export type BranchMode = {
    mode: "adopt" | "create"
    track: boolean
}

export const resolveBranchMode = (exists: {
    local: boolean
    remote: boolean
}): BranchMode => {
    if (exists.local) {
        return { mode: "adopt", track: false }
    }
    if (exists.remote) {
        return { mode: "adopt", track: true }
    }
    return { mode: "create", track: false }
}

// Windows reserved device names — illegal as a file/dir name on Windows
// regardless of extension (CON, PRN, …, COM1-9, LPT1-9). A task's folder is one
// of these names, so a repo or alias matching one (case-insensitively) would
// produce an unopenable worktree dir on Windows; reject it at open time on every
// platform so a workspace stays portable.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

// Validate one repo or alias NAME (a single token part, NOT a `repo@alias`
// pair). Rejects what would break the folder/branch/note conventions: the
// reserved separators (`@` would re-split a participant; `:` is illegal in a
// Windows filename), glob metacharacters (`[ ] * ?` — these names feed
// minimatch patterns and shell globs), Windows reserved device names, and a
// trailing dot or space (Windows silently strips them, so two names would
// collide on disk). Empty is rejected too (a `@bug-fix` with no repo, or a
// `web@` with no alias, is malformed). Returns the name on success; throws a
// fail-loud message naming the offending token otherwise. `kind` ("repo" /
// "alias") only colours the message.
export const validateName = (name: string, kind: "repo" | "alias"): string => {
    if (name === "") {
        throw new Error(`an empty ${kind} name is not allowed.`)
    }
    if (name.includes(ALIAS_SEPARATOR)) {
        throw new Error(
            `${kind} name "${name}" may not contain "${ALIAS_SEPARATOR}" — it separates a repo from its alias.`
        )
    }
    if (name.includes(":")) {
        throw new Error(
            `${kind} name "${name}" may not contain ":" — it is illegal in a Windows filename.`
        )
    }
    if (/[[\]*?]/.test(name)) {
        throw new Error(
            `${kind} name "${name}" may not contain glob characters ([ ] * ?).`
        )
    }
    if (WINDOWS_RESERVED.test(name)) {
        throw new Error(
            `${kind} name "${name}" is a Windows reserved device name.`
        )
    }
    if (/[. ]$/.test(name)) {
        throw new Error(
            `${kind} name "${name}" may not end with a dot or space (Windows strips them).`
        )
    }
    return name
}

// Validate a run's full PARTICIPANT set up front (open time), before anything is
// created. Each token is split into repo[@alias]; both parts pass validateName,
// and the whole set is checked for case-INSENSITIVE uniqueness — macOS and
// Windows fold filename case, so `Web` and `web` (or two `autopilot@BugFix` /
// `autopilot@bugfix` participants) would map to one folder and clobber each
// other. Throws on the first offender, naming it, so a typo never half-opens a
// task. A repo MAY legitimately repeat with DIFFERENT aliases (that's the whole
// feature), so uniqueness is over the full lowercased token, not the repo.
export const validateParticipants = (tokens: string[]): void => {
    const seen = new Map<string, string>()
    for (const token of tokens) {
        const { repo, alias } = splitParticipant(token)
        validateName(repo, "repo")
        if (alias !== undefined) {
            validateName(alias, "alias")
        }
        const fold = token.toLowerCase()
        const prior = seen.get(fold)
        if (prior !== undefined && prior !== token) {
            throw new Error(
                `participants "${prior}" and "${token}" differ only in case — they would collide on a case-insensitive filesystem.`
            )
        }
        seen.set(fold, token)
    }
}

// Validate --repos BEFORE creating anything: every supplied participant's REPO
// part must be a registered repo (the alias is task-local and never registered).
// A repo need NOT be cloned — a registered-but-uncloned name is the on-demand
// clone path. Mirror clone's pre-flight collision guard — fail loud and create
// nothing on the first unknown repo, so a typo never half-opens a task. Returns
// the supplied PARTICIPANT TOKENS de-duplicated in supplied order (a repo may
// recur under different aliases); [] when no --repos was given. Name-shape
// validation (separators, globs, reserved names, case collisions) is
// validateParticipants' job — call it first.
export const validateSuppliedRepos = (
    supplied: string[] | undefined,
    registered: string[]
): string[] => {
    const result: string[] = []
    if (supplied === undefined) {
        return result
    }
    for (const token of supplied) {
        const { repo } = splitParticipant(token)
        if (!registered.includes(repo)) {
            const known = registered.join(", ") || "(none registered)"
            throw new Error(
                `${repo} is not a registered repository — known: ${known}. Register it (or fix the name) before scoping a task to it.`
            )
        }
        if (!result.includes(token)) {
            result.push(token)
        }
    }
    return result
}

// Everything planOpen needs to decide what `open` should do, gathered by the
// shell from disk. `registered`/`cloned` are bare REPO names (the manifest's
// unit). `storedScope`/`suppliedScope` are PARTICIPANT tokens (`repo` or
// `repo@alias`) — a repo may appear several times under different aliases. The
// plan maps each participant back to its repo (splitParticipant) to test
// registration/clone state. `taskExists` (a note OR an open worktree is present)
// and `hasNote` (a note actually parsed) are DISTINCT: both a brand-new task and
// an existing unscoped one have an empty stored scope, but only the former lacks
// a note, and --repos must seed the one while only growing the other.
export type OpenInput = {
    registered: string[]
    cloned: string[]
    storedScope: string[]
    suppliedScope: string[]
    taskExists: boolean
    hasNote: boolean
    goal: string | undefined
}

// One PARTICIPANT's open outcome: `created` (a fresh worktree landed) or
// `skipped` (its worktree was already open — the idempotent/recovery path — or
// no worktree could be attempted, with `reason` set: a failed pre-open or
// pre-clone hook, a failed on-demand clone, or a scope name whose repo isn't
// registered at all). `name` is the participant token (`repo` or `repo@alias`),
// the folder/JSON identity — distinct from the repo it clones from.
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
    const isRegistered = (token: string): boolean =>
        registered.includes(splitParticipant(token).repo)
    // Worktree targets — PARTICIPANT tokens. Scoped: the in-scope participants
    // whose repo is REGISTERED — an in-scope participant whose repo isn't cloned
    // yet is cloned on demand, because a scoped name is an explicit ask. Ordered
    // by (the repo's registration index, then the scope's own order) so bare
    // repos keep registration order — the original contract — while a repo's
    // several aliases cluster together in the order the scope declares them.
    // Unscoped: every cloned repo as a BARE participant (registration order) PLUS
    // any supplied --repos participants whose repo is registered and that aren't
    // already one of those bare cloned entries — naming a participant is an
    // explicit ask, so it is cloned-on-demand + opened even on an unscoped task;
    // without --repos this is exactly today's every-cloned-repo behaviour, which
    // still never clones implicitly. An aliased participant is only ever a target
    // via an explicit scope/--repos entry, never implicitly.
    const regIndex = (token: string): number =>
        registered.indexOf(splitParticipant(token).repo)
    const targets = scoped
        ? scope
              .filter(isRegistered)
              .map((token, i) => ({ token, i }))
              .sort(
                  (a, b) => regIndex(a.token) - regIndex(b.token) || a.i - b.i
              )
              .map((e) => e.token)
        : [
              ...registered.filter((n) => cloned.includes(n)),
              ...suppliedScope.filter(
                  (token) => isRegistered(token) && !cloned.includes(token)
              )
          ]

    // The repos a target will clone-or-open, so notCloned can exclude them. A
    // participant maps to its repo; several participants may share one repo.
    const targetRepos = new Set(targets.map((t) => splitParticipant(t).repo))
    // The uncloned repos this run will NOT touch (registered but neither cloned
    // nor backing a target), warned + skipped the way status does.
    const notCloned = registered.filter(
        (name) => !cloned.includes(name) && !targetRepos.has(name)
    )

    // A scope participant whose repo isn't registered at all can be neither
    // opened nor cloned (there is no URL to clone from). A note may legitimately
    // outlive a repo's registration, so this is a per-participant skip — warned
    // and recorded, never an abort.
    const unknownScope = scope.filter((token) => !isRegistered(token))

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
