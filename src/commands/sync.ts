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
    stackParent,
    type TaskNote,
    taskParticipants,
    worktreePath
} from "@/tasks"

// One repo's sync outcome. `rebased` = task branch replayed onto the upstream,
// `current` is reserved for an already-up-to-date repo, `conflict` = the rebase
// stopped on a conflict (left mid-rebase), `skipped` = not rebased (`reason`
// mirroring the human line: uncommitted changes, an unresolved upstream, or
// "not reached" for repos after the one that stopped the sequential run).
type SyncRepo = {
    name: string
    status: "rebased" | "current" | "conflict" | "skipped"
    reason?: string
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

        // Sync sequentially. On the first repo whose rebase conflicts we stop
        // and leave that rebase in progress (the signal for the user to resolve
        // or abort), deliberately not touching the repos that follow.
        let synced = 0
        const repos: SyncRepo[] = []
        // One entry per hook that actually ran: pre-sync for every repo whose
        // rebase was attempted, post-sync for cleanly rebased repos only —
        // never dirty-skipped, conflicted, or not-reached ones. A non-zero
        // exit is collected and flips the command's exit code at the end
        // without aborting the remaining repos.
        const hooks: HookResult[] = []
        const failedHooks: HookResult[] = []
        // One entry per repo whose carry actually ran (a cleanly-rebased repo
        // with carry patterns). The never-overwrite rule makes this re-run a
        // missing-files-only repair: existing worktree files are kept, only
        // matches that vanished (or appeared in source since open) are copied.
        const carry: CarryEntry[] = []
        // Mark every target the sequential run never reached as skipped, append
        // them to the per-repo outcomes, and emit the JSON for an early return.
        // Carries the hooks and carry results that did land (for the
        // cleanly-rebased repos before the stop), keeping both contracts on
        // every exit path.
        const emitStopped = (): void => {
            const reached = new Set(repos.map((r) => r.name))
            for (const target of targets) {
                if (!reached.has(target.name)) {
                    repos.push({
                        name: target.name,
                        status: "skipped",
                        reason: "not reached"
                    })
                }
            }
            terminal.json({ task: argv.task, onto, repos, hooks, carry })
        }
        for (const target of targets) {
            const { name, repo: repoName, url, source, dest } = target
            const repo = git(source)
            const wt = repo.worktree(dest)
            // This participant's branch to rebase (adopted/--branch, else its
            // default: task/<task> bare, task/<task>@<alias> aliased).
            const branch = branchFor(argv.task, name, note?.branches)

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

            // A STACKED child must NEVER be rebased here: its base is a sibling
            // participant's branch, and rebasing it onto remoteDefault (or a
            // blanket --from) would FLATTEN the stack onto main, destroying the
            // edge. Until Phase 3 adds a real `--onto <parent>` restack, the safe
            // interim is to skip it — leaving its tip untouched — and say so. The
            // sibling token its base names is also not a git ref, so this guard
            // additionally keeps `resolved` (which would be that token) from ever
            // reaching git. Roots and non-stacked participants fall straight
            // through to the rebase below, exactly as before.
            if (stackParent(name, note?.branches, scope) !== undefined) {
                repos.push({
                    name,
                    status: "skipped",
                    reason: "stacked (restack pending)"
                })
                terminal.log(
                    `${name}: stacked on a sibling — skipping (restack pending)`
                )
                continue
            }

            if (!resolved) {
                repos.push({
                    name,
                    status: "skipped",
                    reason: "cannot resolve origin's default branch"
                })
                emitStopped()
                terminal.log(
                    `${name}: cannot resolve origin's default branch — pass --from <ref>`
                )
                return
            }
            // First resolved target names the run's onto (when --from is unset).
            if (onto === "") {
                onto = resolved
            }

            // pre-sync GATES the rebase: a non-zero exit skips this repo (its
            // worktree is left untouched), the run CONTINUES to the next repo
            // (unlike a conflict, nothing is half-done here), and the command
            // exits non-zero at the end.
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
                        reason: "pre-sync hook failed"
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
                repos.push({ name, status: "conflict" })
                emitStopped()
                terminal.log(
                    `${name}: rebase conflict — resolve in ${dest} then re-run sync (or git rebase --abort)`
                )
                return
            }
            repos.push({ name, status: "rebased" })
            synced += 1
            terminal.log(`${name}: synced`)
            // Re-carry the configured untracked local files BEFORE post-sync
            // fires, mirroring open's ordering: existing files are never
            // overwritten, so this only fills in what the worktree is missing.
            // Pattern lookup is by the bare repo; the entry is tagged with the
            // participant.
            const carried = await runCarry({
                config,
                name: repoName,
                source,
                worktree: dest
            })
            if (carried) {
                carry.push({ repo: name, ...carried })
            }
            // post-sync fires for the cleanly-rebased worktree only, with cwd =
            // the worktree and branch = task/<task>. A hook failure is recorded
            // and the loop continues — the rebase already landed.
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

        // Resolve before fetching, the same order as sync: --from, then the
        // persisted per-repo base, then the remote default. A missing or
        // unconfigured origin reads as a clean skip, never a raw fetch error.
        const resolved =
            from ??
            baseFor(name, note?.branches) ??
            (await repo.remoteDefault())

        // A STACKED child is reported as skipped here too, for the same reason
        // the real sync skips it: the real run won't rebase it (no flatten),
        // and its base is a sibling token, not a ref merge-tree could judge.
        // The forecast must mirror what sync would actually do — Phase 3 will
        // forecast the restack instead.
        if (stackParent(name, note?.branches, scope) !== undefined) {
            repos.push({
                name,
                status: "skipped",
                reason: "stacked (restack pending)"
            })
            continue
        }

        if (!resolved) {
            repos.push({
                name,
                status: "skipped",
                reason: "cannot resolve origin's default branch"
            })
            continue
        }
        if (onto === "") {
            onto = resolved
        }

        try {
            // The same fetch sync performs before rebasing, so the forecast
            // judges the freshest upstream — its only ref mutation.
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
            // merge-tree question entirely.
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
            // key only appears when there is a conflict list to act on.
            repos.push({
                name,
                status,
                ...(conflicts.length > 0 ? { files: conflicts } : {})
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
