import { defineCommand, terminal } from "cmdore"
import { task } from "@/arguments/task"
import { Config } from "@/config"
import {
    type FootprintOk,
    type FootprintSkipped,
    taskFootprint
} from "@/footprint"
import { currentGh, ghAvailable, prView } from "@/forge"
import { age, readNote, type TaskNote, worktreePath } from "@/tasks"
import type { UbertaskItem } from "@/ubertask"

// `uberepo context <task>` — the handoff blob: everything a fresh session
// (human or agent) needs to resume a task, in one read-only command. Composes
// the durable note (the "why"), each repo's footprint (diff's machinery:
// commits ahead + diffstat + dirty), and each branch's PR state from `gh`.
// Read-only by design: no fetch, no hooks, no carry, no mutations — and `gh`
// is opportunistic: missing or failing gh silently degrades to "no PR state",
// never an error (so there is no --no-pr flag to need).

// PR state for one repo's task branch, as the JSON documents it: gh's
// `pr view` collapsed to number/url/draft/state (state is gh's enum:
// OPEN / CLOSED / MERGED). Absent when the branch has no PR — or when gh is
// missing/failed (indistinguishable on purpose; both mean "no PR known").
type ContextPr = {
    number: number
    url: string
    draft: boolean
    state: string
}

// One repo's slice of the context: the footprint entry, enriched with `pr`
// when gh knows of one. A skipped repo carries its reason and nothing else.
type ContextRepo = (FootprintOk & { pr?: ContextPr }) | FootprintSkipped

export default defineCommand({
    name: "context",
    description:
        "Show everything needed to resume a task: note, per-repo state, PRs",
    arguments: [task],
    async run(argv) {
        const config = await Config.read()
        const root = await Config.root()

        // The durable note, exactly as status/open emit it (parsed fields +
        // mtime), omitted from the JSON when the task has none. Its `branches:`
        // map also names the branch (adopt-or-create) gh's PR lookup keys on
        // per repo, below.
        const note = await readNote(root, argv.task)

        // The shared per-repo computation (footprint.ts, also behind diff).
        const footprint = await taskFootprint(config, root, argv.task)
        for (const name of footprint.strays) {
            terminal.warn(
                `${name}: worktree outside task scope (not in repos:) — skipping; close it or add it with open --repos`
            )
        }

        if (footprint.repos.length === 0) {
            terminal.json({
                task: argv.task,
                base: footprint.base,
                ...(note ? { note } : {}),
                repos: []
            })
            terminal.warn(`No open task ${argv.task}.`)
            return
        }

        // PR state, the way ship talks to GitHub: shell to `gh` in each
        // repo's worktree so gh infers the repo from its origin. One up-front
        // availability probe; without gh every pr field is silently omitted
        // (automatic degradation — by design not even an info line, since a
        // missing optional binary is not news the handoff needs). A per-repo
        // gh error (no PR, not authed, not GitHub) reads as no-PR via prView.
        const run = currentGh()
        const lookup =
            footprint.repos.some((r) => r.status === "ok") &&
            (await ghAvailable(run))

        const repos: ContextRepo[] = []
        for (const repo of footprint.repos) {
            if (repo.status === "skipped" || !lookup) {
                repos.push(repo)
                continue
            }
            const dest = worktreePath(root, argv.task, repo.name)
            // Key the PR lookup on this repo's branch (adopted/--branch, else
            // task/<task>) — the footprint entry already carries it.
            const view = await prView(run, dest, repo.branch)
            repos.push(
                view
                    ? {
                          ...repo,
                          pr: {
                              number: view.number,
                              url: view.url,
                              draft: view.isDraft,
                              state: view.state
                          }
                      }
                    : repo
            )
        }

        terminal.json({
            task: argv.task,
            base: footprint.base,
            ...(note ? { note } : {}),
            repos
        })
        print(argv.task, footprint.base, note, repos, lookup)
    }
})

// Print the handoff as a small markdown document — built to be piped or
// pasted (Slack handoff, PR cover, Monday-morning re-read) and to read fine
// raw in a terminal. Shape:
//
//     # Task: <task>
//
//     Goal: <full goal text>
//     Tickets: <comma list>
//     Note updated: <relative age>
//
//     ## Repos (vs <base>)
//
//     - <name>  <branch>  <N ahead>  <N files +ins -del>  <PR>  <clean|dirty>
//       - <sha7> <commit subject>
//     - <name>  <branch>  skipped — <reason>
//
//     ## Decisions / ## Blockers
//
//     - <item text> (<repo>)
//
// Empty sections are omitted (no decisions → no Decisions heading; no note →
// no header lines at all). The diffstat chunk is omitted at 0 ahead, mirroring
// diff. The PR column appears only when gh was consulted: `PR #n (draft|ready|
// merged|closed)` or `no PR`; without gh the column is omitted entirely rather
// than claiming "no PR" it can't know. Repo lines are bullets (not diff's bare
// lines) so several repos render as a list, not one folded paragraph.
const print = (
    task: string,
    base: string,
    note: TaskNote | undefined,
    repos: ContextRepo[],
    lookup: boolean
): void => {
    const lines: string[] = [`# Task: ${task}`, ""]

    const header: string[] = []
    if (note && note.goal !== "") {
        header.push(`Goal: ${note.goal}`)
    }
    if (note && note.tickets.length > 0) {
        header.push(`Tickets: ${note.tickets.join(", ")}`)
    }
    if (note) {
        header.push(`Note updated: ${age(note.mtime)}`)
    }
    if (header.length > 0) {
        lines.push(...header, "")
    }

    lines.push(base === "" ? "## Repos" : `## Repos (vs ${base})`, "")
    const width = repos.reduce((max, r) => Math.max(max, r.name.length), 0)
    for (const repo of repos) {
        if (repo.status === "skipped") {
            lines.push(
                `- ${repo.name.padEnd(width)}  ${repo.branch}  skipped — ${repo.reason}`
            )
            continue
        }
        const columns = [
            repo.name.padEnd(width),
            repo.branch,
            `${repo.ahead} ahead`
        ]
        if (repo.ahead > 0) {
            columns.push(
                `${repo.files} ${
                    repo.files === 1 ? "file" : "files"
                } +${repo.insertions} -${repo.deletions}`
            )
        }
        if (lookup) {
            columns.push(
                repo.pr
                    ? `PR #${repo.pr.number} (${prState(repo.pr)})`
                    : "no PR"
            )
        }
        columns.push(repo.dirty ? "dirty" : "clean")
        lines.push(`- ${columns.join("  ")}`)
        for (const commit of repo.commits) {
            lines.push(`  - ${commit.sha.slice(0, 7)} ${commit.subject}`)
        }
    }

    pushItems(lines, "Decisions", note?.decisions ?? [])
    pushItems(lines, "Blockers", note?.blockers ?? [])

    for (const line of lines) {
        terminal.log(line)
    }
}

// The human word for a PR's state: an open PR is "draft" or "ready" (the
// draft flag only means something while open), anything else is gh's state
// lowercased — "merged" / "closed", exactly what a resume needs to know.
const prState = (pr: ContextPr): string => {
    if (pr.state === "OPEN") {
        return pr.draft ? "draft" : "ready"
    }
    return pr.state.toLowerCase()
}

// Append a "## Decisions" / "## Blockers" section: one bullet per item, its
// text folded to a single line (whitespace runs collapse — full text, no
// truncation) with the optional per-item repo attribution appended. An empty
// list appends nothing, so empty sections vanish entirely.
const pushItems = (
    lines: string[],
    heading: string,
    items: UbertaskItem[]
): void => {
    if (items.length === 0) {
        return
    }
    lines.push("", `## ${heading}`, "")
    for (const item of items) {
        const text = item.note.replace(/\s+/g, " ").trim()
        lines.push(item.repo ? `- ${text} (${item.repo})` : `- ${text}`)
    }
}
