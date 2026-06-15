import {
    type OpenInput,
    type OpenOutcomes,
    planOpen,
    summarize,
    validateSuppliedRepos
} from "@/open-plan"

// A complete OpenInput with sensible defaults; each test overrides only the
// fields its row of the matrix cares about. Defaults: nothing stored, no
// --repos, brand-new task (no note, no worktree), no --goal.
const input = (over: Partial<OpenInput> = {}): OpenInput => ({
    registered: [],
    cloned: [],
    storedScope: [],
    suppliedScope: [],
    taskExists: false,
    hasNote: false,
    goal: undefined,
    ...over
})

describe("validateSuppliedRepos", () => {
    it("returns [] when no --repos was given", () => {
        expect(validateSuppliedRepos(undefined, ["api", "web"])).toEqual([])
    })

    it("dedupes supplied names, preserving supplied order", () => {
        expect(
            validateSuppliedRepos(["web", "api", "web"], ["api", "web"])
        ).toEqual(["web", "api"])
    })

    it("throws on the first name not registered, naming the known set", () => {
        expect(() => validateSuppliedRepos(["nope"], ["api", "web"])).toThrow(
            "nope is not a registered repository — known: api, web"
        )
    })

    it("reports (none registered) when nothing is registered", () => {
        expect(() => validateSuppliedRepos(["api"], [])).toThrow(
            "known: (none registered)"
        )
    })

    it("throws on the first unknown even when earlier names are valid", () => {
        expect(() =>
            validateSuppliedRepos(["api", "ghost"], ["api", "web"])
        ).toThrow("ghost is not a registered repository")
    })
})

describe("planOpen — scope resolution (the union-never-narrow matrix)", () => {
    // Row 1: stored [], new task, no --repos → unscoped; targets = all cloned.
    it("brand-new task, no --repos: stays unscoped, targets = all cloned", () => {
        const plan = planOpen(
            input({
                registered: ["api", "web"],
                cloned: ["api", "web"],
                taskExists: false
            })
        )
        expect(plan.scope).toEqual([])
        expect(plan.targets).toEqual(["api", "web"])
    })

    // Row 2: stored [], new task, --repos a → seeds [a]; a is a target.
    it("brand-new task with --repos: seeds the scope and targets it", () => {
        const plan = planOpen(
            input({
                registered: ["api", "web"],
                cloned: ["api"],
                suppliedScope: ["web"],
                taskExists: false
            })
        )
        expect(plan.scope).toEqual(["web"])
        expect(plan.targets).toEqual(["web"])
    })

    // Row 3: stored [], existing task, no --repos → stays []; targets = cloned.
    it("existing unscoped task, no --repos: stays unscoped, targets = all cloned", () => {
        const plan = planOpen(
            input({
                registered: ["api", "web"],
                cloned: ["api", "web"],
                taskExists: true
            })
        )
        expect(plan.scope).toEqual([])
        expect(plan.targets).toEqual(["api", "web"])
    })

    // Row 4: stored [], existing task, --repos a → scope STAYS [], but a is a
    // target (cloned-on-demand + opened) so an unscoped task isn't narrowed.
    it("existing unscoped task with --repos: scope stays [] but the named repo is a target", () => {
        const plan = planOpen(
            input({
                registered: ["api", "web"],
                cloned: ["api"],
                suppliedScope: ["web"],
                taskExists: true
            })
        )
        expect(plan.scope).toEqual([])
        // Unscoped targets = cloned ∪ supplied (∩ registered), registration order.
        expect(plan.targets).toEqual(["api", "web"])
    })

    // Row 5: stored [x], any, no --repos → scope [x].
    it("scoped task, no --repos: scope unchanged, targets = scope ∩ registered", () => {
        const plan = planOpen(
            input({
                registered: ["api", "web", "cli"],
                cloned: ["api", "web", "cli"],
                storedScope: ["web"],
                taskExists: true
            })
        )
        expect(plan.scope).toEqual(["web"])
        expect(plan.targets).toEqual(["web"])
    })

    // Row 6: stored [x], any, --repos a → union [x, a]; a is a target.
    it("scoped task with --repos: unions the supplied name in (stored first)", () => {
        const plan = planOpen(
            input({
                registered: ["api", "web", "cli"],
                cloned: ["api", "web", "cli"],
                storedScope: ["web"],
                suppliedScope: ["api"],
                taskExists: true
            })
        )
        expect(plan.scope).toEqual(["web", "api"])
        // Targets are scope ∩ registered, kept in REGISTRATION order (api, web).
        expect(plan.targets).toEqual(["api", "web"])
    })

    it("scoped task targets an in-scope repo even when it is not yet cloned (on-demand)", () => {
        const plan = planOpen(
            input({
                registered: ["api", "web"],
                cloned: ["api"],
                storedScope: ["api", "web"],
                taskExists: true
            })
        )
        expect(plan.targets).toEqual(["api", "web"])
        expect(plan.notCloned).toEqual([])
    })
})

describe("planOpen — notCloned (the soft skip log set)", () => {
    it("lists registered repos that are neither cloned nor a target", () => {
        const plan = planOpen(
            input({
                registered: ["api", "web", "cli"],
                cloned: ["api"],
                taskExists: false
            })
        )
        // Unscoped: only the cloned api is a target; web and cli are skipped.
        expect(plan.targets).toEqual(["api"])
        expect(plan.notCloned).toEqual(["web", "cli"])
    })

    it("does not list a repo that is an on-demand target", () => {
        const plan = planOpen(
            input({
                registered: ["api", "web"],
                cloned: ["api"],
                suppliedScope: ["web"],
                taskExists: false
            })
        )
        // web is uncloned but supplied → a target, so not in notCloned.
        expect(plan.notCloned).toEqual([])
    })
})

describe("planOpen — unknownScope & the empty guard", () => {
    it("empty is TRUE when nothing is cloned and nothing is supplied", () => {
        const plan = planOpen(
            input({ registered: ["api", "web"], cloned: [], taskExists: false })
        )
        expect(plan.targets).toEqual([])
        expect(plan.unknownScope).toEqual([])
        expect(plan.empty).toBe(true)
    })

    it("an unregistered stored-scope name falls THROUGH (empty FALSE) so it is reported as a skip", () => {
        const plan = planOpen(
            input({
                registered: ["api"],
                cloned: [],
                storedScope: ["ghost"],
                taskExists: true
            })
        )
        // No worktree target survives, but the stray scope name must NOT make
        // the run empty — it is surfaced as a per-repo skip instead.
        expect(plan.targets).toEqual([])
        expect(plan.unknownScope).toEqual(["ghost"])
        expect(plan.empty).toBe(false)
    })

    it("collects every scope name not registered, in scope order", () => {
        const plan = planOpen(
            input({
                registered: ["api"],
                cloned: ["api"],
                storedScope: ["ghost", "api", "phantom"],
                taskExists: true
            })
        )
        expect(plan.unknownScope).toEqual(["ghost", "phantom"])
        expect(plan.targets).toEqual(["api"])
        expect(plan.empty).toBe(false)
    })
})

describe("planOpen — note action (goal × scopeGrew × hasNote)", () => {
    it("no goal, no scope growth, has a note → skip", () => {
        const plan = planOpen(
            input({
                registered: ["api"],
                cloned: ["api"],
                storedScope: ["api"],
                taskExists: true,
                hasNote: true
            })
        )
        expect(plan.noteAction).toEqual({ kind: "skip" })
    })

    it("no goal, no scope growth, no note → seed-template", () => {
        const plan = planOpen(
            input({
                registered: ["api"],
                cloned: ["api"],
                taskExists: false,
                hasNote: false
            })
        )
        expect(plan.noteAction).toEqual({ kind: "seed-template" })
    })

    it("a grown scope → write (carrying the new scope, goal undefined)", () => {
        const plan = planOpen(
            input({
                registered: ["api", "web"],
                cloned: ["api", "web"],
                storedScope: ["api"],
                suppliedScope: ["web"],
                taskExists: true,
                hasNote: true
            })
        )
        expect(plan.noteAction).toEqual({
            kind: "write",
            goal: undefined,
            repos: ["api", "web"]
        })
    })

    it("a goal with no scope growth → write (goal set, scope unchanged)", () => {
        const plan = planOpen(
            input({
                registered: ["api"],
                cloned: ["api"],
                storedScope: ["api"],
                taskExists: true,
                hasNote: true,
                goal: "ship it"
            })
        )
        expect(plan.noteAction).toEqual({
            kind: "write",
            goal: "ship it",
            repos: ["api"]
        })
    })

    it("a goal on a brand-new task → write (goal set, scope seeded from --repos)", () => {
        const plan = planOpen(
            input({
                registered: ["api", "web"],
                cloned: ["api", "web"],
                suppliedScope: ["web"],
                taskExists: false,
                hasNote: false,
                goal: "fix it"
            })
        )
        expect(plan.noteAction).toEqual({
            kind: "write",
            goal: "fix it",
            repos: ["web"]
        })
    })

    it("an existing unscoped task with --repos does NOT grow scope → seed/skip path, not write", () => {
        // scope stays [] (row 4), so scopeGrew is false; with no goal and a
        // note present this is a skip, NOT a write — the unscoped task's note
        // is left untouched even though a repo was named.
        const plan = planOpen(
            input({
                registered: ["api", "web"],
                cloned: ["api"],
                suppliedScope: ["web"],
                taskExists: true,
                hasNote: true
            })
        )
        expect(plan.noteAction).toEqual({ kind: "skip" })
    })
})

describe("summarize", () => {
    const outcomes = (over: Partial<OpenOutcomes> = {}): OpenOutcomes => ({
        task: "t",
        scope: [],
        repos: [],
        clone: [],
        hooks: [],
        carry: [],
        note: undefined,
        ...over
    })

    it("builds the JSON payload and omits note when absent (exit 0)", () => {
        const { json, failedClones, failedHooks, exitCode } = summarize(
            outcomes({
                scope: ["api"],
                repos: [{ name: "api", status: "created" }]
            })
        )
        expect(json).toEqual({
            task: "t",
            scope: ["api"],
            repos: [{ name: "api", status: "created" }],
            clone: [],
            hooks: [],
            carry: []
        })
        expect(json).not.toHaveProperty("note")
        expect(failedClones).toEqual([])
        expect(failedHooks).toEqual([])
        expect(exitCode).toBe(0)
    })

    it("includes the note key when a note landed", () => {
        const note = {
            goal: "g",
            repos: [],
            tickets: [],
            decisions: [],
            blockers: [],
            mtime: 123
        }
        const { json } = summarize(outcomes({ note }))
        expect(json).toHaveProperty("note", note)
    })

    it("exit 1 with the failed-clone names when a clone failed", () => {
        const { failedClones, failedHooks, exitCode } = summarize(
            outcomes({
                clone: [
                    { name: "api", status: "cloned" },
                    { name: "web", status: "failed", error: "boom" }
                ]
            })
        )
        expect(failedClones).toEqual(["web"])
        expect(failedHooks).toEqual([])
        expect(exitCode).toBe(1)
    })

    it("exit 1 with 'repo (event)' strings when a hook failed", () => {
        const { failedClones, failedHooks, exitCode } = summarize(
            outcomes({
                hooks: [
                    { event: "post-open", repo: "api", exit: 0 },
                    { event: "pre-open", repo: "web", exit: 2 }
                ]
            })
        )
        expect(failedClones).toEqual([])
        expect(failedHooks).toEqual(["web (pre-open)"])
        expect(exitCode).toBe(1)
    })

    it("exit 1 when both a clone and a hook failed", () => {
        const { failedClones, failedHooks, exitCode } = summarize(
            outcomes({
                clone: [{ name: "api", status: "failed", error: "x" }],
                hooks: [{ event: "post-clone", repo: "api", exit: 1 }]
            })
        )
        expect(failedClones).toEqual(["api"])
        expect(failedHooks).toEqual(["api (post-clone)"])
        expect(exitCode).toBe(1)
    })
})
