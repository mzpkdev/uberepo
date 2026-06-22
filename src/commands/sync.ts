import { defineCommand, terminal } from "cmdore"
import { task } from "@/arguments/task"
import { type CarryEntry, runCarry } from "@/carry"
import { Config, type UberepoConfig } from "@/config"
import git, { versionAtLeast } from "@/git"
import { type HookResult, runHook } from "@/hooks"
import { check } from "@/options/check"
import { from } from "@/options/from"
import { noHooks } from "@/options/no-hooks"
import {
    baseFor,
    branchFor,
    partitionScope,
    readNote,
    stackOrder,
    stackParent,
    type TaskNote,
    taskParticipants,
    worktreePath
} from "@/tasks"

// One participant's sync outcome. `rebased` = its branch replayed onto the
// upstream (a root) or restacked onto its parent's new tip (a stacked child);
// `current` = nothing to do — the target was already contained, so the rebase
// would no-op (most often a stacked child whose parent did not move, detected
// up-to-date); `conflict` = the rebase stopped on a conflict (left mid-rebase);
// `skipped` = not rebased, `reason` mirroring the human line: uncommitted
// changes, an unresolved upstream, "not reached" (a dirty-preflight bail), or
// "parent not synced" (a stacked descendant pruned because an ancestor in its
// stack conflicted — see Decision A below). `base`/`onto` is this participant's
// ACTUAL rebase target: the remote ref for a root (= the run-level `onto`), or
// the PARENT's branch name for a stacked child (the run-level `onto` can't name
// it — children rebase onto a sibling, not the shared upstream). Omitted when
// there was no rebase target (a skip before resolution).
type SyncRepo = {
    name: string
    status: "rebased" | "current" | "conflict" | "skipped"
    reason?: string
    base?: string
}

// One repo's forecast under --check — what a real sync would LIKELY hit, read
// off the committed tips. `current` = the rebase target is already contained
// in the task branch, so the rebase would no-op; `clean` = merge-tree of the
// two tips reports no conflict (likely, not promised: a rebase replays commits
// one-by-one, merge-tree merges the tips once, so multi-commit branches can
// differ); `conflicts` = merge-tree conflicts, with the conflicted paths in
// `files`; `dirty` = uncommitted changes — the one thing the real sync refuses
// outright — flagged per repo while the tip-level forecast still runs, so
// `files` appears when the rebase would ALSO conflict after a commit/stash;
// `skipped` = nothing to forecast, `reason` mirroring diff's strings (no
// worktree, branch missing, an unresolvable origin default) or the per-repo
// error (e.g. a failed fetch).
type CheckRepo = {
    name: string
    status: "clean" | "conflicts" | "current" | "dirty" | "skipped"
    files?: string[]
    reason?: string
    base?: string
}

export default defineCommand({
    name: "sync",
    description: "Sync an open task's worktrees with their upstream branches",
    arguments: [task],
    options: [from, noHooks, check],
    async run(argv) {
        const config = await Config.read()
        const root = await Config.root()
        // The note carries the task's scope AND its per-repo branches (adopt-
        // or-create + persisted base). Read once; a legacy note resolves every
        // repo to task/<task> with no base, exactly as before.
        const note = await readNote(root, argv.task)

        // --check forks off before any sync machinery: it shares the scope
        // resolution and target semantics but mutates nothing (beyond a fetch)
        // and fires no hooks — a forecast is not the lifecycle op.
        if (argv.check) {
            await forecast(root, config, argv.task, note, argv.from)
            return
        }

        // The task's worktrees, by PARTICIPANT: every tasks/<task>/<name> folder
        // (bare or aliased) whose repo is cloned. A repo's several aliased
        // participants each rebase their own branch, sharing the source/<repo>
        // clone. `url` is the registered URL, carried through so a fired
        // post-sync hook can surface it as UBEREPO_REPO_URL.
        const present = taskParticipants(config, root, argv.task).map((p) => ({
            name: p.name,
            repo: p.repo,
            url: p.url,
            source: p.source,
            dest: worktreePath(root, argv.task, p.name)
        }))

        // Honour the task's declared scope: act only on its owned repos. A
        // worktree outside a non-empty scope is drift — warn about it (never
        // touch it silently, never silently skip the in-scope work) and proceed
        // on the in-scope intersection. Unscoped → every worktree-bearing repo.
        const scope = note?.repos ?? []
        const { inScope, strays } = partitionScope(
            present.map((t) => t.name),
            scope
        )
        for (const name of strays) {
            terminal.warn(
                `${name}: worktree outside task scope (not in repos:) — skipping; close it or add it with open --repos`
            )
        }
        const targets = present.filter((t) => inScope.includes(t.name))
        // The top-level rebase target: an explicit --from wins for every repo;
        // otherwise it is each repo's resolved origin default (by convention the
        // same branch name across repos). Filled in once resolved below so the
        // JSON names what the sync rebased onto. Empty until then.
        let onto = argv.from ?? ""

        if (targets.length === 0) {
            terminal.json({
                task: argv.task,
                onto,
                repos: [],
                hooks: [],
                carry: []
            })
            terminal.warn(`No open task ${argv.task} to sync.`)
            return
        }

        // Pre-flight: refuse to touch anything if any of the task's worktrees
        // is dirty. Rebasing a dirty tree would either fail mid-way or strand
        // uncommitted work, so we clean preconditions before any side effect.
        const dirty = new Set<string>()
        for (const target of targets) {
            const wt = git(target.source).worktree(target.dest)
            if (await wt.dirty()) {
                dirty.add(target.name)
            }
        }
        if (dirty.size > 0) {
            for (const target of targets) {
                if (dirty.has(target.name)) {
                    terminal.log(
                        `${target.name}: uncommitted changes — commit or stash first`
                    )
                }
            }
            // Nothing was rebased: dirty repos are skipped for that reason, the
            // clean ones were never reached (the pre-flight bailed first). No
            // worktree was rebased, so no post-sync hook or carry ran.
            const repos: SyncRepo[] = targets.map((target) =>
                dirty.has(target.name)
                    ? {
                          name: target.name,
                          status: "skipped",
                          reason: "uncommitted changes"
                      }
                    : {
                          name: target.name,
                          status: "skipped",
                          reason: "not reached"
                      }
            )
            terminal.json({
                task: argv.task,
                onto,
                repos,
                hooks: [],
                carry: []
            })
            return
        }

        let synced = 0
        const repos: SyncRepo[] = []
        // One entry per hook that actually ran: pre-sync for every participant
        // whose rebase was attempted, post-sync for cleanly rebased ones only —
        // never dirty-skipped, conflicted, pruned, or not-reached ones. A non-
        // zero exit is collected and flips the command's exit code at the end
        // without aborting the remaining work.
        const hooks: HookResult[] = []
        const failedHooks: HookResult[] = []
        // One entry per participant whose carry actually ran (a cleanly-rebased
        // one with carry patterns). The never-overwrite rule makes this re-run a
        // missing-files-only repair: existing worktree files are kept, only
        // matches that vanished (or appeared in source since open) are copied.
        const carry: CarryEntry[] = []

        // Index the targets by participant name so the topological walk (which
        // yields names) can reach each one's repo/url/source/dest.
        const byName = new Map(targets.map((t) => [t.name, t]))

        // The persisted fork-point ref for a stacked child:
        // refs/uberepo/restack/<task>/<child-leaf>, in the child's source clone.
        // It is LOCAL-ONLY — outside refs/heads|remotes|tags, so a `push` never
        // sends it — and serves two jobs at once: it NAMES the `--onto` upstream
        // (merge-base(child, parent) snapshotted before the parent moved) AND,
        // being a ref, keeps the parent's OLD tip reachable so it survives a
        // conflict-resume re-run. The leaf is the FULL participant token
        // (`autopilot@logos`), which is `@`-safe in a ref path the way the branch
        // name is, so two aliased children of one repo never collide.
        const refName = (child: string): string =>
            `refs/uberepo/restack/${argv.task}/${child}`

        // STEP 3 — up-front fork-point snapshot, WRITE-ONCE, before ANY rebase.
        // For every stacked child across all repos, capture merge-base(child,
        // parent) NOW, while the parent still sits at its pre-sync tip — that is
        // the boundary below which commits are the parent's and above which the
        // child's. Why before any rebase, and why write-once: if a parent's
        // rebase conflicts and the user resolves + `rebase --continue`s it, a
        // FRESH merge-base(child, parent_new) on the re-run would sit too far
        // back and replay the parent's commits into the child. So a ref left by
        // an interrupted run is KEPT (it holds the correct pre-move boundary);
        // only a child with no ref yet gets one written. DEFENSIVE: a leftover
        // ref that is no longer an ancestor of the child branch (the child was
        // reset independently between runs) is stale — re-snapshot it.
        for (const target of targets) {
            const parent = stackParent(target.name, note?.branches, scope)
            if (parent === undefined || !byName.has(parent)) {
                continue
            }
            const repo = git(target.source)
            const childBranch = branchFor(
                argv.task,
                target.name,
                note?.branches
            )
            const parentBranch = branchFor(argv.task, parent, note?.branches)
            const ref = refName(target.name)
            const exists = await repo.refExists(ref)
            // Keep a still-valid leftover (the resume case); (re)write when
            // absent, or when a leftover no longer sits under the child branch.
            if (!exists || !(await repo.isMerged(ref, childBranch))) {
                await repo.setRef(
                    ref,
                    await repo.mergeBase(childBranch, parentBranch)
                )
            }
        }

        // STEP 4/5 — DECISION A: a rebase conflict prunes only ITS subtree, not
        // the whole run. `pruned` collects the descendants of any conflicted
        // node (filled as the walk hits a conflict, in topological order so a
        // parent is always seen before its children). Independent roots and
        // independent repos keep rebasing — this is a deliberate change from the
        // old global-stop contract (a conflict in `api` no longer halts `web`).
        const pruned = new Set<string>()
        // True when this stacked child's parent did NOT cleanly sync this run
        // (conflicted, or was itself pruned). Such a child must not rebase — its
        // parent's new tip isn't settled — so we prune it and KEEP its ref for
        // the resume.
        const parentPruned = (name: string): boolean => {
            const parent = stackParent(name, note?.branches, scope)
            return parent !== undefined && pruned.has(parent)
        }

        // Carry + post-sync for a participant whose rebase just landed cleanly,
        // shared by the root and child paths so both honour open's ordering
        // (carry the untracked locals, THEN fire post-sync). Pattern lookup is
        // by the bare repo; the entry is tagged with the participant.
        const afterRebase = async (
            name: string,
            repoName: string,
            url: string,
            source: string,
            dest: string,
            branch: string
        ): Promise<void> => {
            const carried = await runCarry({
                config,
                name: repoName,
                source,
                worktree: dest
            })
            if (carried) {
                carry.push({ repo: name, ...carried })
            }
            const result = await runHook("post-sync", {
                config,
                workspace: root,
                task: argv.task,
                repo: { name, path: dest, url, branch },
                noHooks: argv["no-hooks"]
            })
            if (result) {
                hooks.push(result)
                if (result.exit !== 0) {
                    failedHooks.push(result)
                }
            }
        }

        // Walk participants parents-before-children (a forest per repo, stable
        // for the non-stacked ones), so a child only restacks once its parent's
        // new tip is settled. A root rebases onto its remote target exactly as
        // before; a child rebases --onto the parent's new tip using its
        // persisted fork point. A conflict prunes the subtree and CONTINUES.
        for (const name of stackOrder(
            targets.map((t) => t.name),
            note?.branches,
            scope
        )) {
            const target = byName.get(name)
            if (target === undefined) {
                continue
            }
            const { repo: repoName, url, source, dest } = target
            const repo = git(source)
            const wt = repo.worktree(dest)
            // This participant's branch (adopted/--branch, else its default:
            // task/<task> bare, task/<task>@<alias> aliased).
            const branch = branchFor(argv.task, name, note?.branches)
            const parent = stackParent(name, note?.branches, scope)

            // An ancestor in this stack conflicted (or was itself pruned): do
            // NOT rebase this child. Its parent's tip isn't settled, so its
            // persisted fork point STAYS for the resume run, and any deeper
            // descendants prune off it too.
            if (parent !== undefined && parentPruned(name)) {
                pruned.add(name)
                repos.push({
                    name,
                    status: "skipped",
                    reason: "parent not synced",
                    base: branchFor(argv.task, parent, note?.branches)
                })
                terminal.log(
                    `${name}: parent ${parent} not synced — skipping (resolve the parent's conflict, then re-run sync)`
                )
                continue
            }

            // ── Stacked child: restack onto the parent's NEW tip ──────────────
            if (parent !== undefined) {
                const parentBranch = branchFor(
                    argv.task,
                    parent,
                    note?.branches
                )
                const ref = refName(name)
                // The parent already rebased this run (it precedes us in the
                // walk), so its branch now points at its new tip.
                const parentNewTip = await repo.revParse(parentBranch)

                // pre-sync GATES the restack, same contract as a root: a non-
                // zero exit skips this child (worktree untouched, ref kept for a
                // later run), the walk continues, exit is non-zero at the end.
                const pre = await runHook("pre-sync", {
                    config,
                    workspace: root,
                    task: argv.task,
                    repo: { name, path: dest, url, branch },
                    noHooks: argv["no-hooks"]
                })
                if (pre) {
                    hooks.push(pre)
                    if (pre.exit !== 0) {
                        failedHooks.push(pre)
                        repos.push({
                            name,
                            status: "skipped",
                            reason: "pre-sync hook failed",
                            base: parentBranch
                        })
                        terminal.log(`${name}: pre-sync hook failed — skipping`)
                        continue
                    }
                }

                // Already restacked / up-to-date: the parent's new tip is
                // already contained in the child, so a restack would no-op.
                // This is the resume's happy ending AND the steady-state re-run
                // (parent didn't move). Clear the ref — nothing left to pin.
                if (await repo.isMerged(parentNewTip, branch)) {
                    if (await repo.refExists(ref)) {
                        await repo.delRef(ref)
                    }
                    repos.push({ name, status: "current", base: parentBranch })
                    terminal.log(`${name}: already restacked on ${parent}`)
                    continue
                }

                terminal.log(
                    `Syncing ${name} → restacking ${branch} onto ${parent}`
                )
                try {
                    // --onto parentNewTip, replaying only the child's own
                    // commits (those above the persisted fork point) — never the
                    // parent's. A conflict throws, handled below.
                    await wt.rebaseOnto(parentNewTip, ref, branch)
                } catch {
                    // DECISION A: prune this subtree, keep going. Mid-rebase
                    // state is left for the user; the ref STAYS so a resume run
                    // restacks correctly.
                    pruned.add(name)
                    repos.push({ name, status: "conflict", base: parentBranch })
                    terminal.log(
                        `${name}: restack conflict — resolve in ${dest} then re-run sync (or git rebase --abort)`
                    )
                    continue
                }
                // Restacked cleanly: the fork point has served its purpose, drop
                // the ref so a clean run leaves none behind.
                if (await repo.refExists(ref)) {
                    await repo.delRef(ref)
                }
                repos.push({ name, status: "rebased", base: parentBranch })
                synced += 1
                terminal.log(`${name}: synced`)
                await afterRebase(name, repoName, url, source, dest, branch)
                continue
            }

            // ── Root: rebase onto the remote target, exactly as before ────────
            // Resolve the rebase target before fetching. An explicit --from ref
            // wins; then the persisted per-repo base (an adopted branch's PR
            // base); otherwise we resolve the remote default branch *name*
            // (e.g. origin/main) from the local origin/HEAD symref. Resolving
            // first means a missing/unconfigured origin yields a clean error
            // instead of a raw fetch failure, and never rebases onto a guessed
            // target. The name is stable across the fetch; fetch then advances
            // what it points at, so the rebase still lands on the freshest
            // upstream.
            const resolved =
                argv.from ??
                baseFor(name, note?.branches) ??
                (await repo.remoteDefault())

            if (!resolved) {
                repos.push({
                    name,
                    status: "skipped",
                    reason: "cannot resolve origin's default branch"
                })
                terminal.log(
                    `${name}: cannot resolve origin's default branch — pass --from <ref>`
                )
                // Unlike a conflict this leaves nothing half-done; CONTINUE so
                // an independent repo/root still syncs (the same per-forest
                // independence Decision A gives conflicts). Marked non-zero at
                // the end via failedHooks? No — this isn't a hook failure; it is
                // a per-repo skip, reported in the JSON, and the run is still a
                // success for the repos that did resolve.
                continue
            }
            // First resolved target names the run's onto (when --from is unset).
            if (onto === "") {
                onto = resolved
            }

            // pre-sync GATES the rebase: a non-zero exit skips this repo (its
            // worktree is left untouched), the run CONTINUES to the next
            // participant (unlike a conflict, nothing is half-done here), and
            // the command exits non-zero at the end.
            const pre = await runHook("pre-sync", {
                config,
                workspace: root,
                task: argv.task,
                repo: { name, path: dest, url, branch },
                noHooks: argv["no-hooks"]
            })
            if (pre) {
                hooks.push(pre)
                if (pre.exit !== 0) {
                    failedHooks.push(pre)
                    repos.push({
                        name,
                        status: "skipped",
                        reason: "pre-sync hook failed",
                        base: resolved
                    })
                    terminal.log(`${name}: pre-sync hook failed — skipping`)
                    continue
                }
            }

            await repo.fetch()
            terminal.log(
                `Syncing ${name} → rebasing ${branch} onto ${resolved}`
            )
            try {
                await wt.rebase(resolved)
            } catch {
                // DECISION A: a conflict prunes only this node's subtree (its
                // stacked children, marked "parent not synced" when the walk
                // reaches them) and leaves this rebase in progress as the
                // resolve/abort signal — but the run CONTINUES to independent
                // roots and other repos. This deliberately replaces the old
                // global-stop: a conflict here no longer marks unrelated repos
                // "not reached". The post-walk check emits the JSON and exits
                // non-zero when any conflict occurred.
                pruned.add(name)
                repos.push({ name, status: "conflict", base: resolved })
                terminal.log(
                    `${name}: rebase conflict — resolve in ${dest} then re-run sync (or git rebase --abort)`
                )
                continue
            }
            repos.push({ name, status: "rebased", base: resolved })
            synced += 1
            terminal.log(`${name}: synced`)
            await afterRebase(name, repoName, url, source, dest, branch)
        }

        // DECISION A: if any participant conflicted, the run is not clean — emit
        // the JSON and exit non-zero, but only AFTER the full walk (so every
        // independent root/repo got its chance). The conflicted worktrees are
        // left mid-rebase, their subtrees' refs preserved for the resume.
        const conflicted = repos.filter((r) => r.status === "conflict")
        if (conflicted.length > 0) {
            terminal.json({ task: argv.task, onto, repos, hooks, carry })
            terminal.log(
                `Sync of task ${argv.task} stopped on ${
                    conflicted.length === 1 ? "a conflict" : "conflicts"
                } in ${conflicted.map((r) => r.name).join(", ")} — resolve, then re-run sync`
            )
            process.exitCode = 1
            return
        }

        terminal.json({ task: argv.task, onto, repos, hooks, carry })
        terminal.log(
            `Synced task ${argv.task} in ${synced} ${
                synced === 1 ? "repository" : "repositories"
            }`
        )
        // A failing post-sync never undoes its rebase (and a failing pre-sync
        // just left its repo unrebased), but the run is not clean: summarise
        // and exit non-zero so a wrapper/CI sees the failure.
        if (failedHooks.length > 0) {
            const which = failedHooks
                .map((h) => `${h.repo} (${h.event})`)
                .join(", ")
            terminal.error(
                `hooks failed in ${failedHooks.length} ${
                    failedHooks.length === 1 ? "repository" : "repositories"
                }: ${which}`
            )
            process.exitCode = 1
        }
    }
})

// `sync --check`: a per-repo conflict FORECAST of what the real sync would
// hit, touching nothing but the remote-tracking refs. Each repo is fetched
// first (the one mutation-adjacent step — a forecast against stale refs is a
// lie), the rebase target resolves exactly like sync (--from wins, else
// origin's default), then `git merge-tree --write-tree` judges the tips. No
// rebase, no carry, no worktree mutation, and no hooks. Unlike the real sync
// it NEVER refuses and never stops early: a dirty worktree is flagged per repo
// instead of vetoing the run (that's the point of a pre-flight), a skip moves
// on to the next repo, and — like diff, unlike sync — a scoped repo MISSING
// its worktree still gets a line. Exits 0 even when conflicts are forecast:
// finding them is the job (the prune-preview convention).
const forecast = async (
    root: string,
    config: UberepoConfig,
    task: string,
    note: TaskNote | undefined,
    from: string | undefined
): Promise<void> => {
    // merge-tree --write-tree landed in git 2.38 — gate up front with an
    // actionable error rather than degrading into raw git noise per repo.
    const version = await git.version()
    if (!versionAtLeast(version, "2.38")) {
        throw new Error(`sync --check needs git >= 2.38, found ${version}`)
    }

    // The participants that can be forecast: every tasks/<task>/<name> folder
    // (bare or aliased) whose repo is cloned, in stable sorted folder order
    // (matches diff/status/ship). source/<repo> is shared by a repo's
    // participants.
    const participants = taskParticipants(config, root, task)
    const sourceByName = new Map(participants.map((p) => [p.name, p.source]))
    const present = participants.map((p) => p.name)

    // Honour the task's declared scope the way sync does (warn about strays,
    // act on the in-scope intersection), but report like diff: a scoped repo
    // with no worktree is a `skipped` line, not a silent omission — the
    // pre-flight should say "nothing to sync here", not hide the repo.
    const scope = note?.repos ?? []
    const { inScope, strays } = partitionScope(present, scope)
    for (const name of strays) {
        terminal.warn(
            `${name}: worktree outside task scope (not in repos:) — skipping; close it or add it with open --repos`
        )
    }
    const missing = scope.filter((name) => !present.includes(name))
    const targets = [...new Set([...inScope, ...missing])].sort()

    // The forecast's rebase target, reported in the JSON exactly like sync's
    // `onto`: an explicit --from wins; otherwise the first resolved origin
    // default names the run. Empty until then.
    let onto = from ?? ""

    if (targets.length === 0) {
        terminal.json({ task, onto, check: true, repos: [] })
        terminal.warn(`No open task ${task} to sync.`)
        return
    }

    const repos: CheckRepo[] = []
    for (const name of targets) {
        const dest = worktreePath(root, task, name)
        if (!present.includes(name)) {
            repos.push({ name, status: "skipped", reason: "no worktree" })
            continue
        }
        // Source is the shared source/<repo> clone (present, by the filter).
        const repo = git(sourceByName.get(name) as string)
        // This participant's branch to forecast (adopted/--branch, else its
        // default).
        const branch = branchFor(task, name, note?.branches)

        // A STACKED child forecasts against its PARENT's branch, not a remote
        // ref. The real sync restacks it --onto the parent's NEW tip, but that
        // tip doesn't exist during --check (no rebase runs), so we forecast
        // against the parent's CURRENT tip with merge-tree(parent, child) and
        // treat the verdict like any other. APPROXIMATE — the same class of
        // caveat the code already documents for multi-commit rebases (merge-tree
        // merges tips once; a real rebase replays commit-by-commit) AND, on top,
        // the parent will move before the restack actually happens. We do NOT
        // try to simulate the post-rebase parent tip. The sibling base token is
        // not a git ref, so resolving it via remoteDefault would be wrong —
        // we override the target to the parent's branch name here.
        const parent = stackParent(name, note?.branches, scope)
        // Resolve before fetching, the same order as sync: --from, then the
        // persisted per-repo base, then the remote default. A missing or
        // unconfigured origin reads as a clean skip, never a raw fetch error.
        // For a stacked child this is short-circuited to the parent's branch.
        const resolved =
            parent !== undefined
                ? branchFor(task, parent, note?.branches)
                : (from ??
                  baseFor(name, note?.branches) ??
                  (await repo.remoteDefault()))

        if (!resolved) {
            repos.push({
                name,
                status: "skipped",
                reason: "cannot resolve origin's default branch"
            })
            continue
        }
        // The run-level `onto` names the ROOTS' target only; a stacked child's
        // target (its parent's branch) rides its own per-repo `base`, so a child
        // never claims the run heading.
        if (onto === "" && parent === undefined) {
            onto = resolved
        }

        try {
            // The same fetch sync performs before rebasing, so the forecast
            // judges the freshest upstream — its only ref mutation. (Harmless
            // for a stacked child, whose target is a local sibling branch.)
            await repo.fetch()

            // The task branch can vanish while its worktree dir lingers —
            // report, never crash the cross-repo run (mirrors diff).
            if (!(await repo.branchExists(branch))) {
                repos.push({
                    name,
                    status: "skipped",
                    reason: "branch missing"
                })
                continue
            }

            const dirty = await repo.worktree(dest).dirty()
            // Already up to date: the target is contained in the task branch,
            // so the rebase would no-op — nothing can conflict, skip the
            // merge-tree question entirely. For a child this reads as "already
            // restacked on the parent's current tip".
            const current = await repo.isMerged(resolved, branch)
            const conflicts = current
                ? []
                : (await repo.mergeTree(resolved, branch)).conflicts
            const status: CheckRepo["status"] = dirty
                ? "dirty"
                : current
                  ? "current"
                  : conflicts.length > 0
                    ? "conflicts"
                    : "clean"
            // Spread keeps `files` off the object entirely when empty, so the
            // key only appears when there is a conflict list to act on. A
            // stacked child also carries `base` = its parent's branch, the
            // approximate target it was forecast against.
            repos.push({
                name,
                status,
                ...(conflicts.length > 0 ? { files: conflicts } : {}),
                ...(parent !== undefined ? { base: resolved } : {})
            })
        } catch (error) {
            // Safety net (mirrors diff): one repo's failure — an offline
            // fetch, unrelated histories — becomes a skip, never an abort of
            // the whole forecast.
            repos.push({
                name,
                status: "skipped",
                reason: error instanceof Error ? error.message : String(error)
            })
        }
    }

    terminal.json({ task, onto, check: true, repos })
    printForecast(task, onto, repos)
}

// Print the forecast heading ("<task>  vs <onto>  (forecast)" once a target
// resolved) followed by one aligned line per repo — the JSON status verbatim,
// an em-dash detail spelling out what it means for the real sync — with the
// likely-conflicted files indented beneath conflicted (and dirty-and-
// conflicted) repos. "likely" is deliberate: merge-tree forecasts, it doesn't
// promise.
const printForecast = (
    task: string,
    onto: string,
    repos: CheckRepo[]
): void => {
    terminal.log(
        onto === "" ? `${task}  (forecast)` : `${task}  vs ${onto}  (forecast)`
    )
    const width = repos.reduce((max, r) => Math.max(max, r.name.length), 0)
    for (const repo of repos) {
        const name = repo.name.padEnd(width)
        if (repo.status === "skipped") {
            terminal.log(`  ${name}  skipped — ${repo.reason}`)
            continue
        }
        if (repo.status === "current") {
            terminal.log(`  ${name}  current — already up to date`)
            continue
        }
        if (repo.status === "clean") {
            terminal.log(`  ${name}  clean — rebase likely clean`)
            continue
        }
        const files = repo.files ?? []
        const count = `${files.length} likely conflicted ${
            files.length === 1 ? "file" : "files"
        }`
        terminal.log(
            repo.status === "dirty"
                ? `  ${name}  dirty — uncommitted changes; sync would refuse${
                      files.length > 0 ? `; ${count}` : ""
                  }`
                : `  ${name}  conflicts — ${count}`
        )
        for (const file of files) {
            terminal.log(`    ${file}`)
        }
    }
}
