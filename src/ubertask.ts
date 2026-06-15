import * as fs from "node:fs"

// The durable per-task note (tasks/<task>/ubertask.yml), parsed into a typed
// object. It carries the "why" git can't regenerate — the goal, related links,
// deliberate decisions, and known blockers. The schema mirrors what the
// using-uberepo skill documents (template/.claude/skills/using-uberepo/
// reference.md) and seeds (template/ubertask.yml): keep these in lockstep.
//
// This module hand-rolls a parser for that fixed, shallow schema rather than
// pulling in a YAML dependency — the project runs with zero runtime deps beyond
// cmdore, and Config already hand-rolls JSON round-tripping the same way. The
// parser is deliberately narrow: it understands exactly the documented shapes
// (a `|` block scalar, `[]` empty lists, `- ` string-list items, and `- note:
// |` mapping items) and treats anything it doesn't recognise as absent rather
// than throwing — the note is a hint, and a half-edited one must never crash a
// read-only `status`.

// One `decisions`/`blockers` entry: a free-text note, optionally scoped to a
// single repo (a source/<name>; omitted for cross-cutting items).
export type UbertaskItem = {
    note: string
    repo?: string
}

// One repo's recorded branch in a task: the branch its worktree lives on
// (`name`), whether `open` ADOPTED a pre-existing branch (`adopted`) rather
// than creating `task/<task>`, and — for an adopted branch whose PR base was
// discovered — the persisted `base` ref the consumers rebase/diff/ship
// against (omitted when none was discovered, so callers fall back to
// remoteDefault). A created branch is `{ name, adopted: false }`, no base.
// Keyed by the flat source/<name> repo name in the `branches:` map.
export type UbertaskBranch = {
    name: string
    adopted: boolean
    base?: string
}

// The parsed note. Every field is always present so callers never branch on
// undefined: `goal` is "" when unset, the lists are [] when empty. `goal` is a
// single logical line (the documented one-line `|` block); the lists preserve
// document order. `repos` is the task's declared scope — the flat source/<name>
// names a task OWNS, so commands act only on those; [] means unscoped, i.e. all
// cloned repos (the original behaviour). This is the TASK's scope and is
// DISTINCT from a `decisions`/`blockers` item's per-item `repo` attribution.
export type Ubertask = {
    goal: string
    repos: string[]
    tickets: string[]
    decisions: UbertaskItem[]
    blockers: UbertaskItem[]
    // The per-repo recorded branches (adopt-or-create), keyed by flat repo
    // name. {} when the task records none — a legacy note (no `branches:`) or
    // a freshly-seeded one — so callers fall back to taskBranch()/remoteDefault.
    branches: Record<string, UbertaskBranch>
}

// An empty note — the shape a freshly-seeded template parses to, and the base
// every parse starts from so missing keys fall back to documented defaults.
const empty = (): Ubertask => ({
    goal: "",
    repos: [],
    tickets: [],
    decisions: [],
    blockers: [],
    branches: {}
})

// Strip a trailing inline comment from a single-line scalar. Only used for the
// flow forms (`key: value`, `key: []`); block scalars take everything verbatim,
// so `#` inside note/goal text is preserved (the schema promises that).
const stripComment = (value: string): string => {
    const hash = value.indexOf(" #")
    return (hash === -1 ? value : value.slice(0, hash)).trim()
}

// Collect the lines of a block scalar (`key: |`) introduced at `indent`: every
// following line more-indented than the key belongs to the block. Returns the
// dedented text (joined with "\n", trailing blank lines trimmed) and the index
// of the first line that is NOT part of the block, so the caller resumes there.
const readBlock = (
    lines: string[],
    start: number,
    indent: number
): { text: string; next: number } => {
    const body: string[] = []
    let i = start
    for (; i < lines.length; i++) {
        const line = lines[i]
        if (line.trim() === "") {
            body.push("")
            continue
        }
        const lineIndent = line.length - line.trimStart().length
        if (lineIndent <= indent) {
            break
        }
        body.push(line.slice(indent + 2))
    }
    // Drop trailing blank lines so a `|` block followed by a blank separator
    // (as the seed has) yields clean text, not a dangling newline.
    while (body.length > 0 && body[body.length - 1] === "") {
        body.pop()
    }
    return { text: body.join("\n"), next: i }
}

// Parse a `decisions`/`blockers` list: a sequence of `  - note: |` items, each
// with a `|` block note and an optional `    repo:` line. Starts at the first
// line after the key; returns the items and the index to resume from. Anything
// that isn't a recognised item line ends the list.
const readItems = (
    lines: string[],
    start: number
): { items: UbertaskItem[]; next: number } => {
    const items: UbertaskItem[] = []
    let i = start
    while (i < lines.length) {
        const line = lines[i]
        if (line.trim() === "") {
            i++
            continue
        }
        const item = /^(\s*)-\s+note:\s*\|\s*$/.exec(line)
        if (!item) {
            break
        }
        const dashIndent = item[1].length
        const block = readBlock(lines, i + 1, dashIndent + 2)
        const entry: UbertaskItem = { note: block.text }
        i = block.next
        // An optional `repo:` line, indented past the dash, scopes the item.
        if (i < lines.length) {
            const repo = /^(\s*)repo:\s*(.*)$/.exec(lines[i])
            if (repo && repo[1].length > dashIndent) {
                const value = stripComment(repo[2])
                if (value !== "") {
                    entry.repo = value
                }
                i++
            }
        }
        items.push(entry)
    }
    return { items, next: i }
}

// Parse a string list: either inline `[]` (handled by the caller) or a block of
// `  - <value>` lines. Starts after the key; returns values + resume index.
const readStringList = (
    lines: string[],
    start: number
): { values: string[]; next: number } => {
    const values: string[] = []
    let i = start
    while (i < lines.length) {
        const line = lines[i]
        if (line.trim() === "") {
            i++
            continue
        }
        const match = /^\s*-\s+(.*)$/.exec(line)
        if (!match) {
            break
        }
        const value = stripComment(match[1])
        if (value !== "") {
            values.push(value)
        }
        i++
    }
    return { values, next: i }
}

// Parse the `branches:` map: a sequence of `  <repo>:` blocks, each with
// `name:`, `adopted:` and an optional `base:` line indented beneath it.
// Starts at the first line after the `branches:` key; returns the map and the
// index to resume from. Tolerant like the rest: a repo block missing `name`
// is dropped (a branch with no name is meaningless), `adopted` defaults to
// false, and anything that isn't a recognised `<repo>:` header at the map's
// indent ends the map.
const readBranches = (
    lines: string[],
    start: number
): { branches: Record<string, UbertaskBranch>; next: number } => {
    const branches: Record<string, UbertaskBranch> = {}
    let i = start
    // The map's repo headers sit one level in; lock onto the first one's
    // indent so deeper field lines (name/adopted/base) are never mistaken for
    // a repo header.
    let mapIndent = -1
    while (i < lines.length) {
        const line = lines[i]
        if (line.trim() === "") {
            i++
            continue
        }
        const indent = line.length - line.trimStart().length
        const header = /^(\s*)([A-Za-z0-9._-]+):\s*$/.exec(line)
        // A top-level (column-0) line, or a non-header line, ends the map.
        if (indent === 0 || !header) {
            break
        }
        if (mapIndent === -1) {
            mapIndent = indent
        }
        if (indent !== mapIndent) {
            break
        }
        const repo = header[2]
        i++
        let name: string | undefined
        let adopted = false
        let base: string | undefined
        // Consume the field lines indented past the repo header.
        while (i < lines.length) {
            const field = lines[i]
            if (field.trim() === "") {
                i++
                continue
            }
            const fieldIndent = field.length - field.trimStart().length
            if (fieldIndent <= mapIndent) {
                break
            }
            const kv = /^\s*([a-z]+):\s*(.*)$/.exec(field)
            if (!kv) {
                i++
                continue
            }
            const value = stripComment(kv[2])
            if (kv[1] === "name") {
                name = value
            } else if (kv[1] === "adopted") {
                adopted = value === "true"
            } else if (kv[1] === "base" && value !== "") {
                base = value
            }
            i++
        }
        if (name !== undefined && name !== "") {
            branches[repo] = {
                name,
                adopted,
                ...(base !== undefined ? { base } : {})
            }
        }
    }
    return { branches, next: i }
}

// Parse ubertask.yml text into a typed note. Tolerant by design: unknown
// top-level keys are skipped, recognised keys win, and absent keys keep their
// empty defaults — a partial or hand-edited note parses to its best
// interpretation rather than throwing, because the note is a hint feeding a
// read-only surface (status), not a config that must be valid to proceed.
export const parse = (raw: string): Ubertask => {
    const note = empty()
    const lines = raw.split("\n")
    let i = 0
    while (i < lines.length) {
        const line = lines[i]
        // Skip blanks and whole-line comments between top-level keys.
        if (line.trim() === "" || line.trimStart().startsWith("#")) {
            i++
            continue
        }
        // Only top-level (column-0) keys are structural; deeper lines are
        // consumed by the block/list readers above.
        const key = /^([a-z]+):\s*(.*)$/.exec(line)
        if (!key) {
            i++
            continue
        }
        const [, name, rest] = key
        const value = rest.trim()
        if (name === "goal") {
            if (value === "|" || value === "|-" || value === "|+") {
                const block = readBlock(lines, i + 1, 0)
                note.goal = block.text
                i = block.next
            } else {
                note.goal = stripComment(rest)
                i++
            }
        } else if (name === "repos" || name === "tickets") {
            if (value === "[]") {
                i++
            } else {
                const list = readStringList(lines, i + 1)
                note[name] = list.values
                i = list.next
            }
        } else if (name === "decisions" || name === "blockers") {
            if (value === "[]") {
                i++
            } else {
                const parsed = readItems(lines, i + 1)
                note[name] = parsed.items
                i = parsed.next
            }
        } else if (name === "branches") {
            if (value === "{}" || value === "[]") {
                i++
            } else {
                const parsed = readBranches(lines, i + 1)
                note.branches = parsed.branches
                i = parsed.next
            }
        } else {
            i++
        }
    }
    return note
}

// Indent every line of `text` by `spaces`, leaving blank lines empty (no
// trailing whitespace, so output stays biome/editor clean).
const indent = (text: string, spaces: number): string =>
    text
        .split("\n")
        .map((line) => (line === "" ? "" : " ".repeat(spaces) + line))
        .join("\n")

// The fixed comment header the seed and the documented schema carry verbatim.
const HEADER =
    '# ubertask.yml — durable task note. The "why"; git holds the "what".'

// Serialize a string list as either `key: []` (empty) or a `key:`/`  - item`
// block, matching the documented schema.
const serializeStringList = (key: string, values: string[]): string => {
    if (values.length === 0) {
        return `${key}: []`
    }
    return [`${key}:`, ...values.map((value) => `  - ${value}`)].join("\n")
}

// Serialize the `branches:` map: one `  <repo>:` block per recorded repo (in
// the key's natural insertion order, which open preserves in registration
// order), each with `name:`, `adopted:` and — only when present — `base:`.
// Empty map → `branches: {}` (the flow form parse treats as no branches),
// mirroring how the lists collapse to `[]`. Round-trips with readBranches.
const serializeBranches = (
    branches: Record<string, UbertaskBranch>
): string => {
    const names = Object.keys(branches)
    if (names.length === 0) {
        return "branches: {}"
    }
    const blocks = names.map((repo) => {
        const branch = branches[repo]
        const lines = [
            `  ${repo}:`,
            `    name: ${branch.name}`,
            `    adopted: ${branch.adopted}`
        ]
        if (branch.base !== undefined && branch.base !== "") {
            lines.push(`    base: ${branch.base}`)
        }
        return lines.join("\n")
    })
    return [`branches:`, ...blocks].join("\n")
}

// Serialize a `decisions`/`blockers` list. Each item is a `- note: |` block
// scalar (free text needs no quoting) plus an optional `repo:` line, exactly as
// the schema documents. Empty list → `key: []`.
const serializeItems = (key: string, items: UbertaskItem[]): string => {
    if (items.length === 0) {
        return `${key}: []`
    }
    const blocks = items.map((item) => {
        const lines = ["  - note: |", indent(item.note, 6)]
        if (item.repo !== undefined && item.repo !== "") {
            lines.push(`    repo: ${item.repo}`)
        }
        return lines.join("\n")
    })
    return [`${key}:`, ...blocks].join("\n")
}

// Serialize a note back to ubertask.yml bytes: the comment header, then `goal`
// as a `|` block scalar, then the three lists, each section separated by a
// blank line and the whole document terminated by a trailing newline. Round-
// trips with parse(): parse(serialize(x)) deep-equals a normalised x.
export const serialize = (note: Ubertask): string => {
    const goalBody = note.goal === "" ? "" : `\n${indent(note.goal, 2)}`
    const sections = [
        `${HEADER}\ngoal: |${goalBody}`,
        serializeStringList("repos", note.repos),
        serializeBranches(note.branches),
        serializeStringList("tickets", note.tickets),
        serializeItems("decisions", note.decisions),
        serializeItems("blockers", note.blockers)
    ]
    return `${sections.join("\n\n")}\n`
}

// Read + parse a note off disk, or undefined when the file does not exist. Any
// other read error propagates (a note we can't read is a real problem, distinct
// from a task that simply has none).
export const read = async (file: string): Promise<Ubertask | undefined> => {
    let raw: string
    try {
        raw = await fs.promises.readFile(file, "utf8")
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined
        }
        throw error
    }
    return parse(raw)
}

// Serialize + write a note to disk (overwriting). Pairs with read() for the
// round-trip open uses when applying --goal.
export const write = async (file: string, note: Ubertask): Promise<void> => {
    await fs.promises.writeFile(file, serialize(note))
}
