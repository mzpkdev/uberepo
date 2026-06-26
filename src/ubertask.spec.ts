import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
    parse,
    read,
    serialize,
    type Ubertask,
    type UbertaskItem,
    write
} from "@/ubertask"

// The committed seed bytes (template/ubertask.yml), the empty-note baseline.
const SEED =
    '# ubertask.yml — durable task note. The "why"; git holds the "what".\n' +
    "goal: |\n" +
    "  <one line: what done looks like & why>\n" +
    "\n" +
    "repos: []\n" +
    "\n" +
    "branches: {}\n" +
    "\n" +
    "tickets: []\n" +
    "\n" +
    "decisions: []\n" +
    "\n" +
    "blockers: []\n"

// A fully-populated note matching the schema documented in reference.md, used
// to exercise every field (block goal, ticket list, repo-scoped items).
const RICH =
    '# ubertask.yml — durable task note. The "why"; git holds the "what".\n' +
    "goal: |\n" +
    "  Kill the SSO redirect loop — users bounce /login ↔ /callback\n" +
    "\n" +
    "repos:\n" +
    "  - api\n" +
    "  - web\n" +
    "\n" +
    "branches:\n" +
    "  api:\n" +
    "    name: feat/sso\n" +
    "    adopted: true\n" +
    "    base: develop\n" +
    "  web:\n" +
    "    name: task/sso\n" +
    "    adopted: false\n" +
    "\n" +
    "tickets:\n" +
    "  - https://acme.atlassian.net/browse/PROJ-1234\n" +
    "\n" +
    "decisions:\n" +
    "  - note: |\n" +
    "      keep /v1 alive — mobile still rides it\n" +
    "    repo: api\n" +
    "\n" +
    "blockers:\n" +
    "  - note: |\n" +
    "      dev server needs api on :8080 first or /callback 502s\n" +
    "    repo: web\n"

describe("parse", () => {
    it("parses the empty seed to empty fields", () => {
        expect(parse(SEED)).toEqual<Ubertask>({
            goal: "<one line: what done looks like & why>",
            repos: [],
            branches: {},
            tickets: [],
            decisions: [],
            blockers: []
        })
    })

    it("parses a fully-populated note", () => {
        expect(parse(RICH)).toEqual<Ubertask>({
            goal: "Kill the SSO redirect loop — users bounce /login ↔ /callback",
            repos: ["api", "web"],
            branches: {
                api: { name: "feat/sso", adopted: true, base: "develop" },
                web: { name: "task/sso", adopted: false }
            },
            tickets: ["https://acme.atlassian.net/browse/PROJ-1234"],
            decisions: [
                { note: "keep /v1 alive — mobile still rides it", repo: "api" }
            ],
            blockers: [
                {
                    note: "dev server needs api on :8080 first or /callback 502s",
                    repo: "web"
                }
            ]
        })
    })

    it("reads a `|` block goal as a single logical line, trimming the trailing blank", () => {
        const note = parse("goal: |\n  do the thing\n\ntickets: []\n")
        expect(note.goal).toBe("do the thing")
    })

    it("preserves colons, # and slashes inside block text (no quoting needed)", () => {
        const note = parse(
            "decisions:\n  - note: |\n      use http://x:8080 # not 9090\n"
        )
        expect(note.decisions).toEqual<UbertaskItem[]>([
            { note: "use http://x:8080 # not 9090" }
        ])
    })

    it("treats a repo-less item as cross-cutting (no repo key)", () => {
        const note = parse(
            "blockers:\n  - note: |\n      cross-cutting thing\n"
        )
        expect(note.blockers).toEqual<UbertaskItem[]>([
            { note: "cross-cutting thing" }
        ])
        expect(note.blockers[0]).not.toHaveProperty("repo")
    })

    it("keeps multiple list items in document order", () => {
        const note = parse(
            "tickets:\n  - https://one\n  - https://two\n  - https://three\n"
        )
        expect(note.tickets).toEqual([
            "https://one",
            "https://two",
            "https://three"
        ])
    })

    it("parses a `repos:` block into the task's declared scope", () => {
        const note = parse("repos:\n  - api\n  - web\n")
        expect(note.repos).toEqual(["api", "web"])
    })

    it("treats an unscoped task (`repos: []`) as an empty scope", () => {
        expect(parse("goal: |\n  g\n\nrepos: []\n").repos).toEqual([])
    })

    it("is tolerant: missing keys fall back to empty defaults", () => {
        // Only `goal` present — the lists must still come back as []./
        expect(parse("goal: |\n  just a goal\n")).toEqual<Ubertask>({
            goal: "just a goal",
            repos: [],
            branches: {},
            tickets: [],
            decisions: [],
            blockers: []
        })
    })

    it("is tolerant: an empty document parses to a fully-empty note", () => {
        expect(parse("")).toEqual<Ubertask>({
            goal: "",
            repos: [],
            branches: {},
            tickets: [],
            decisions: [],
            blockers: []
        })
    })

    it("ignores unknown top-level keys", () => {
        const note = parse("goal: |\n  g\n\nmystery: whatever\n\ntickets: []\n")
        expect(note.goal).toBe("g")
        expect(note).not.toHaveProperty("mystery")
    })

    it("accepts a flow (single-line) goal too", () => {
        expect(parse("goal: just inline\n").goal).toBe("just inline")
    })
})

describe("serialize", () => {
    it("round-trips the empty seed byte-for-byte", () => {
        // Parsing then re-serializing the committed seed must reproduce it
        // exactly — the property open relies on when seeding with --goal.
        expect(serialize(parse(SEED))).toBe(SEED)
    })

    it("round-trips the fully-populated note byte-for-byte", () => {
        expect(serialize(parse(RICH))).toBe(RICH)
    })

    it("emits empty lists as `[]` and goal as a `|` block", () => {
        const note: Ubertask = {
            goal: "ship it",
            repos: [],
            branches: {},
            tickets: [],
            decisions: [],
            blockers: []
        }
        expect(serialize(note)).toBe(
            '# ubertask.yml — durable task note. The "why"; git holds the "what".\n' +
                "goal: |\n" +
                "  ship it\n" +
                "\n" +
                "repos: []\n" +
                "\n" +
                "branches: {}\n" +
                "\n" +
                "tickets: []\n" +
                "\n" +
                "decisions: []\n" +
                "\n" +
                "blockers: []\n"
        )
    })

    it("serializes a declared scope as a `repos:` block, omitting it as `[]` when unscoped", () => {
        // The task's owned repos round-trip as a string-list block, exactly like
        // tickets; an unscoped task collapses to the `repos: []` flow form.
        const scoped: Ubertask = {
            goal: "g",
            repos: ["api", "web"],
            branches: {},
            tickets: [],
            decisions: [],
            blockers: []
        }
        expect(serialize(scoped)).toContain("repos:\n  - api\n  - web\n")
        expect(parse(serialize(scoped)).repos).toEqual(["api", "web"])

        const unscoped: Ubertask = { ...scoped, repos: [] }
        expect(serialize(unscoped)).toContain("repos: []")
    })

    it("renders an empty goal as a bare `|` block with no body", () => {
        const note: Ubertask = {
            goal: "",
            repos: [],
            branches: {},
            tickets: [],
            decisions: [],
            blockers: []
        }
        expect(serialize(note)).toContain("goal: |\n\nrepos: []")
    })

    it("survives a parse→serialize→parse cycle (structural stability)", () => {
        const note: Ubertask = {
            goal: "do a thing with: colons # and hashes",
            repos: ["api", "web"],
            branches: {
                api: { name: "feat/x", adopted: true, base: "develop" },
                web: { name: "task/x", adopted: false }
            },
            tickets: ["https://a", "https://b"],
            decisions: [
                { note: "decided x", repo: "api" },
                { note: "decided y" }
            ],
            blockers: [{ note: "blocked on z" }]
        }
        expect(parse(serialize(note))).toEqual(note)
    })
})

describe("branches map", () => {
    it("parses an adopted entry (name + adopted + base) and a created entry (no base)", () => {
        const note = parse(
            "branches:\n" +
                "  api:\n" +
                "    name: feat/sso\n" +
                "    adopted: true\n" +
                "    base: develop\n" +
                "  web:\n" +
                "    name: task/sso\n" +
                "    adopted: false\n"
        )
        expect(note.branches).toEqual({
            api: { name: "feat/sso", adopted: true, base: "develop" },
            web: { name: "task/sso", adopted: false }
        })
    })

    it("treats `branches: {}` as no branches", () => {
        expect(parse("branches: {}\n").branches).toEqual({})
    })

    it("is tolerant: a repo block with no name is dropped", () => {
        const note = parse(
            "branches:\n  api:\n    adopted: true\n  web:\n    name: task/x\n    adopted: false\n"
        )
        // api had no name → dropped; web survives.
        expect(note.branches).toEqual({
            web: { name: "task/x", adopted: false }
        })
    })

    it("parses and round-trips a `pr` link on a branch entry", () => {
        const note = parse(
            "branches:\n" +
                "  api:\n" +
                "    name: feat/sso\n" +
                "    adopted: true\n" +
                "    base: develop\n" +
                "    pr: https://github.com/acme/api/pull/42\n"
        )
        expect(note.branches).toEqual({
            api: {
                name: "feat/sso",
                adopted: true,
                base: "develop",
                pr: "https://github.com/acme/api/pull/42"
            }
        })
        // The URL (colons, slashes) survives serialize→parse unquoted, and the
        // pr line follows base in the emitted block.
        expect(parse(serialize(note)).branches).toEqual(note.branches)
        expect(serialize(note)).toContain(
            "    base: develop\n    pr: https://github.com/acme/api/pull/42\n"
        )
    })

    it("persists a `pr` on an otherwise-default (created) branch — name + adopted:false + pr", () => {
        // ship materializes a minimal entry to hold the PR link even when the
        // branch is on its plain default and would otherwise record nothing.
        const note: Ubertask = {
            goal: "g",
            repos: [],
            branches: {
                web: {
                    name: "task/g",
                    adopted: false,
                    pr: "https://github.com/acme/web/pull/7"
                }
            },
            tickets: [],
            decisions: [],
            blockers: []
        }
        expect(parse(serialize(note)).branches).toEqual(note.branches)
    })

    it("omits the pr line for a branch without one", () => {
        const note: Ubertask = {
            goal: "g",
            repos: [],
            branches: { web: { name: "task/g", adopted: false } },
            tickets: [],
            decisions: [],
            blockers: []
        }
        expect(serialize(note)).not.toContain("pr:")
    })

    it("round-trips created and adopted entries byte-stably", () => {
        const note: Ubertask = {
            goal: "g",
            repos: [],
            branches: {
                api: { name: "feat/x", adopted: true, base: "release/2" },
                web: { name: "task/g", adopted: false }
            },
            tickets: [],
            decisions: [],
            blockers: []
        }
        expect(parse(serialize(note)).branches).toEqual(note.branches)
        // The created entry serializes WITHOUT a base line.
        expect(serialize(note)).toContain(
            "  web:\n    name: task/g\n    adopted: false\n"
        )
        expect(serialize(note)).not.toContain(
            "web:\n    name: task/g\n    adopted: false\n    base"
        )
    })
})

describe("aliased participants (multiple branches per repo)", () => {
    it("parses a repo-qualified `repos:` list with @ participants", () => {
        const note = parse(
            "repos:\n  - autopilot@bug-fix\n  - autopilot@add-feature\n  - web\n"
        )
        expect(note.repos).toEqual([
            "autopilot@bug-fix",
            "autopilot@add-feature",
            "web"
        ])
    })

    it("parses a branches map keyed by an aliased participant token (@ in the key)", () => {
        const note = parse(
            "branches:\n" +
                "  autopilot@bug-fix:\n" +
                "    name: fix/login\n" +
                "    adopted: true\n" +
                "    base: develop\n" +
                "  autopilot@add-feature:\n" +
                "    name: task/alpha@add-feature\n" +
                "    adopted: false\n"
        )
        expect(note.branches).toEqual({
            "autopilot@bug-fix": {
                name: "fix/login",
                adopted: true,
                base: "develop"
            },
            "autopilot@add-feature": {
                name: "task/alpha@add-feature",
                adopted: false
            }
        })
    })

    it("round-trips a full multi-branch note (parse∘serialize = identity)", () => {
        const note: Ubertask = {
            goal: "two PRs in autopilot",
            repos: ["autopilot@bug-fix", "autopilot@add-feature", "web"],
            branches: {
                "autopilot@bug-fix": {
                    name: "fix/login",
                    adopted: true,
                    base: "develop"
                },
                "autopilot@add-feature": {
                    name: "task/alpha@add-feature",
                    adopted: false
                }
            },
            tickets: [],
            decisions: [],
            blockers: []
        }
        expect(parse(serialize(note))).toEqual(note)
        // The @ participant survives as both a repos: item and a branches: key.
        expect(serialize(note)).toContain("  - autopilot@bug-fix")
        expect(serialize(note)).toContain("  autopilot@bug-fix:")
    })
})

describe("read / write", () => {
    let tmp: string

    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ubertask-spec-"))
    })

    afterEach(async () => {
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    it("read returns undefined when the file does not exist", async () => {
        const missing = path.join(tmp, "nope.yml")
        expect(await read(missing)).toBeUndefined()
    })

    it("write then read round-trips a note through disk", async () => {
        const file = path.join(tmp, "ubertask.yml")
        const note: Ubertask = {
            goal: "round trip",
            repos: ["api"],
            branches: { api: { name: "task/round-trip", adopted: false } },
            tickets: ["https://t"],
            decisions: [{ note: "d", repo: "web" }],
            blockers: []
        }
        await write(file, note)
        expect(await read(file)).toEqual(note)
        // The on-disk bytes are exactly what serialize() produces.
        expect(await fsp.readFile(file, "utf8")).toBe(serialize(note))
    })
})
