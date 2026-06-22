import {
    branchNameFor,
    type OpenInput,
    type OpenOutcomes,
    parseBranchSpecs,
    parseStackSpecs,
    planOpen,
    resolveBranchMode,
    summarize,
    validateBranchScope,
    validateName,
    validateParticipants,
    validateStackSpecs,
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

    it("validates the REPO part of a repo@alias participant, keeping the full token", () => {
        // The alias is task-local and never registered — only `api` is checked.
        expect(
            validateSuppliedRepos(
                ["api@bug-fix", "api@feature"],
                ["api", "web"]
            )
        ).toEqual(["api@bug-fix", "api@feature"])
    })

    it("throws when an aliased participant's repo is not registered", () => {
        expect(() =>
            validateSuppliedRepos(["ghost@x"], ["api", "web"])
        ).toThrow("ghost is not a registered repository")
    })

    it("keeps a repo repeated under different aliases (the whole feature)", () => {
        expect(
            validateSuppliedRepos(["api@one", "api@two", "api@one"], ["api"])
        ).toEqual(["api@one", "api@two"])
    })
})

describe("validateName — the per-name shape guard", () => {
    it("accepts ordinary repo/alias names", () => {
        expect(validateName("autopilot", "repo")).toBe("autopilot")
        expect(validateName("bug-fix", "alias")).toBe("bug-fix")
        expect(validateName("api.v2_x", "repo")).toBe("api.v2_x")
    })

    it("rejects an empty name", () => {
        expect(() => validateName("", "alias")).toThrow("empty alias name")
    })

    it("rejects the @ separator inside a part", () => {
        expect(() => validateName("a@b", "repo")).toThrow('may not contain "@"')
    })

    it("rejects : (illegal in a Windows filename)", () => {
        expect(() => validateName("a:b", "alias")).toThrow(
            'may not contain ":"'
        )
    })

    it("rejects glob characters", () => {
        for (const bad of ["a*", "a?", "a[b]", "[x"]) {
            expect(() => validateName(bad, "repo")).toThrow("glob characters")
        }
    })

    it("rejects Windows reserved device names, case-insensitively", () => {
        for (const bad of ["con", "PRN", "Aux", "nul", "com1", "LPT9"]) {
            expect(() => validateName(bad, "repo")).toThrow(
                "Windows reserved device name"
            )
        }
        // A name that merely CONTAINS one is fine.
        expect(validateName("console", "repo")).toBe("console")
        expect(validateName("com10", "repo")).toBe("com10")
    })

    it("rejects a trailing dot or space (Windows strips them)", () => {
        expect(() => validateName("api.", "repo")).toThrow("dot or space")
        expect(() => validateName("api ", "alias")).toThrow("dot or space")
    })
})

describe("validateParticipants — the run's whole participant set", () => {
    it("accepts bare repos, aliased participants, and a repo under several aliases", () => {
        expect(() =>
            validateParticipants([
                "web",
                "autopilot@bug-fix",
                "autopilot@add-feature"
            ])
        ).not.toThrow()
    })

    it("validates both the repo and the alias parts", () => {
        expect(() => validateParticipants(["autopilot@bad:alias"])).toThrow(
            'alias name "bad:alias" may not contain ":"'
        )
        expect(() => validateParticipants(["bad*repo@x"])).toThrow(
            "glob characters"
        )
    })

    it("rejects two participants that differ only in case (filesystem fold)", () => {
        expect(() => validateParticipants(["Web", "web"])).toThrow(
            "differ only in case"
        )
        expect(() =>
            validateParticipants(["autopilot@BugFix", "autopilot@bugfix"])
        ).toThrow("differ only in case")
    })

    it("allows the exact same token twice (a no-op dedup, not a collision)", () => {
        expect(() => validateParticipants(["web", "web"])).not.toThrow()
    })
})

describe("planOpen — participant scope (aliases nest under a repo)", () => {
    it("a scoped task carries aliased participants as targets, repo clustered + scope-ordered", () => {
        const plan = planOpen(
            input({
                registered: ["autopilot", "web"],
                cloned: ["autopilot", "web"],
                storedScope: ["web", "autopilot@bug-fix", "autopilot@add"],
                taskExists: true
            })
        )
        // Same scope (participants), targets grouped by repo registration order
        // (autopilot before web), aliases in their declared scope order.
        expect(plan.scope).toEqual([
            "web",
            "autopilot@bug-fix",
            "autopilot@add"
        ])
        expect(plan.targets).toEqual([
            "autopilot@bug-fix",
            "autopilot@add",
            "web"
        ])
    })

    it("a brand-new task seeds an aliased scope and targets each participant", () => {
        const plan = planOpen(
            input({
                registered: ["autopilot"],
                cloned: ["autopilot"],
                suppliedScope: ["autopilot@bug-fix", "autopilot@add-feature"],
                taskExists: false
            })
        )
        expect(plan.scope).toEqual([
            "autopilot@bug-fix",
            "autopilot@add-feature"
        ])
        expect(plan.targets).toEqual([
            "autopilot@bug-fix",
            "autopilot@add-feature"
        ])
    })

    it("notCloned maps a participant to its repo (an aliased target's repo is not 'uncloned')", () => {
        const plan = planOpen(
            input({
                registered: ["autopilot", "web"],
                cloned: ["autopilot"],
                storedScope: ["autopilot@bug-fix"],
                taskExists: true
            })
        )
        // autopilot is cloned and backs the target → not in notCloned; web is
        // registered, uncloned, and not a target → listed.
        expect(plan.targets).toEqual(["autopilot@bug-fix"])
        expect(plan.notCloned).toEqual(["web"])
    })

    it("unknownScope flags a participant whose REPO is unregistered", () => {
        const plan = planOpen(
            input({
                registered: ["autopilot"],
                cloned: ["autopilot"],
                storedScope: ["autopilot@x", "ghost@y"],
                taskExists: true
            })
        )
        expect(plan.unknownScope).toEqual(["ghost@y"])
        expect(plan.targets).toEqual(["autopilot@x"])
        expect(plan.empty).toBe(false)
    })

    it("an uncloned aliased participant on a scoped task is still a target (cloned on demand)", () => {
        const plan = planOpen(
            input({
                registered: ["autopilot"],
                cloned: [],
                storedScope: ["autopilot@bug-fix", "autopilot@add"],
                taskExists: true
            })
        )
        expect(plan.targets).toEqual(["autopilot@bug-fix", "autopilot@add"])
        expect(plan.notCloned).toEqual([])
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
            branches: {},
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

describe("parseBranchSpecs — the two --branch forms", () => {
    it("undefined → an empty spec (every repo falls back to task/<task>)", () => {
        expect(parseBranchSpecs(undefined)).toEqual({ perRepo: {} })
    })

    it("a bare name sets `all` (every in-scope repo)", () => {
        expect(parseBranchSpecs(["feat/sso"])).toEqual({
            all: "feat/sso",
            perRepo: {}
        })
    })

    it("repeatable <repo>=<name> tokens fill perRepo", () => {
        expect(parseBranchSpecs(["api=feat/x", "web=feat/y"])).toEqual({
            perRepo: { api: "feat/x", web: "feat/y" }
        })
    })

    it("a branch name may itself contain `=` after the first one", () => {
        // Only the FIRST `=` splits repo from name, so a branch with `=` works.
        expect(parseBranchSpecs(["api=feat/a=b"])).toEqual({
            perRepo: { api: "feat/a=b" }
        })
    })

    it("rejects mixing a bare name with <repo>=<name> entries", () => {
        expect(() => parseBranchSpecs(["all", "api=x"])).toThrow(
            "mixes a bare name"
        )
    })

    it("rejects two bare names", () => {
        expect(() => parseBranchSpecs(["a", "b"])).toThrow(
            "more than one bare branch name"
        )
    })

    it("rejects two branches for the same repo", () => {
        expect(() => parseBranchSpecs(["api=x", "api=y"])).toThrow(
            "two branches for api"
        )
    })

    it("rejects a malformed <repo>= with an empty side", () => {
        expect(() => parseBranchSpecs(["=x"])).toThrow("malformed")
        expect(() => parseBranchSpecs(["api="])).toThrow("malformed")
    })
})

describe("branchNameFor — resolving one repo's branch from a spec", () => {
    it("prefers the per-repo entry, then the bare all, then the fallback", () => {
        const spec = { all: "all/b", perRepo: { api: "api/b" } }
        expect(branchNameFor(spec, "api", "task/t")).toBe("api/b")
        expect(branchNameFor(spec, "web", "task/t")).toBe("all/b")
        expect(branchNameFor({ perRepo: {} }, "web", "task/t")).toBe("task/t")
    })
})

describe("validateBranchScope — a per-repo branch must be in scope", () => {
    it("passes when every per-repo branch names an in-scope target", () => {
        expect(() =>
            validateBranchScope({ perRepo: { api: "x", web: "y" } }, [
                "api",
                "web"
            ])
        ).not.toThrow()
    })

    it("throws when a per-repo branch names a repo outside the targets", () => {
        expect(() =>
            validateBranchScope({ perRepo: { cli: "x" } }, ["api", "web"])
        ).toThrow("names a repo outside this open's scope")
    })

    it("ignores the bare-name form (it applies to whatever IS in scope)", () => {
        expect(() =>
            validateBranchScope({ all: "x", perRepo: {} }, [])
        ).not.toThrow()
    })
})

// The #2 backstop: a repo the user EXPLICITLY named via --branch <repo>=<name>
// must NEVER be silently honoured as task/<task>. Two guards enforce this in
// tandem — validateBranchScope errors loudly when the named repo can't be
// honoured (it isn't an open target), and branchNameFor only ever falls back to
// the task default for a repo the user did NOT name. Together they make a silent
// wrong-branch impossible: a named repo either gets its name or fails the run.
describe("no-silent-default backstop for a named --branch repo", () => {
    it("errors loudly (never silently defaults) when the named repo is outside the open's scope", () => {
        // The user asked for cli=feat/x, but cli is not a target this run —
        // honouring task/<task> instead would be a silent wrong-branch, so the
        // run must abort, naming what IS in scope.
        expect(() =>
            validateBranchScope({ perRepo: { cli: "feat/x" } }, ["api", "web"])
        ).toThrow(
            "--branch cli=feat/x names a repo outside this open's scope — in scope: api, web"
        )
    })

    it("reports (none in scope) when no repo can carry the named branch", () => {
        // An empty target set (e.g. nothing cloned) still fails loud rather than
        // dropping the --branch on the floor.
        expect(() =>
            validateBranchScope({ perRepo: { api: "feat/x" } }, [])
        ).toThrow("in scope: (none in scope)")
    })

    it("branchNameFor never returns the task default for a repo the user named", () => {
        // Once validateBranchScope has passed, every named repo resolves to ITS
        // name — the task/<task> fallback is reachable only for an UNnamed repo.
        const spec = { perRepo: { api: "feat/x" } }
        expect(branchNameFor(spec, "api", "task/t")).toBe("feat/x")
        expect(branchNameFor(spec, "api", "task/t")).not.toBe("task/t")
        // An unnamed repo (web) is the ONLY case that falls back to the default.
        expect(branchNameFor(spec, "web", "task/t")).toBe("task/t")
    })
})

describe("resolveBranchMode — the adopt-or-create decision", () => {
    it("a local branch → ADOPT, no tracking change", () => {
        expect(resolveBranchMode({ local: true, remote: false })).toEqual({
            mode: "adopt",
            track: false
        })
    })

    it("a branch only on origin → ADOPT + TRACK", () => {
        expect(resolveBranchMode({ local: false, remote: true })).toEqual({
            mode: "adopt",
            track: true
        })
    })

    it("a branch that exists nowhere → CREATE", () => {
        expect(resolveBranchMode({ local: false, remote: false })).toEqual({
            mode: "create",
            track: false
        })
    })

    it("a local branch wins even when it also exists on origin (adopt, no re-track)", () => {
        expect(resolveBranchMode({ local: true, remote: true })).toEqual({
            mode: "adopt",
            track: false
        })
    })
})

describe("parseStackSpecs — the --stack child=parent edges", () => {
    it("undefined → an empty map (no edges declared)", () => {
        expect(parseStackSpecs(undefined)).toEqual({})
    })

    it("[] → an empty map", () => {
        expect(parseStackSpecs([])).toEqual({})
    })

    it("collects each child=parent edge, keyed by the child", () => {
        expect(
            parseStackSpecs(["web@logos=web@strings", "web@api=web@logos"])
        ).toEqual({
            "web@logos": "web@strings",
            "web@api": "web@logos"
        })
    })

    it("splits on the FIRST = only (tokens never contain a second one anyway)", () => {
        // Defensive: even an odd token splits cleanly into child/parent.
        expect(parseStackSpecs(["a=b=c"])).toEqual({ a: "b=c" })
    })

    it("rejects a token with no =", () => {
        expect(() => parseStackSpecs(["web@logos"])).toThrow("malformed")
    })

    it("rejects an empty side of =", () => {
        expect(() => parseStackSpecs(["=parent"])).toThrow("malformed")
        expect(() => parseStackSpecs(["child="])).toThrow("malformed")
    })

    it("rejects a duplicate child (a branch stacks on at most one parent)", () => {
        expect(() =>
            parseStackSpecs(["web@logos=web@strings", "web@logos=web@api"])
        ).toThrow("two parents for web@logos")
    })

    it("rejects a self-edge (a branch cannot stack on itself)", () => {
        expect(() => parseStackSpecs(["web@logos=web@logos"])).toThrow(
            "stacks web@logos on itself"
        )
    })
})

describe("validateStackSpecs — scope, cross-repo, and cycle guards", () => {
    const scope = ["web@strings", "web@logos", "web@api", "api"]

    it("passes a same-repo edge whose parent is in scope", () => {
        expect(() =>
            validateStackSpecs({ "web@logos": "web@strings" }, scope, undefined)
        ).not.toThrow()
    })

    it("throws when the parent is outside the task's scope", () => {
        // The landmine: a parent that is in scope but NOT a target this run must
        // still pass — so the check is against scope, never the run's targets. A
        // parent genuinely absent from scope is the real error.
        expect(() =>
            validateStackSpecs({ "web@logos": "web@ghost" }, scope, undefined)
        ).toThrow("names a parent outside this task's scope")
    })

    it("checks the parent against SCOPE, not this run's targets (in-scope-but-not-opened parent passes)", () => {
        // web@strings IS in scope (it may have been opened on a previous run);
        // it need not be a target of THIS open for web@logos to stack on it.
        expect(() =>
            validateStackSpecs({ "web@logos": "web@strings" }, scope, undefined)
        ).not.toThrow()
    })

    it("throws on a cross-repo edge (a branch only stacks within one repo)", () => {
        expect(() =>
            validateStackSpecs({ "web@logos": "api" }, scope, undefined)
        ).toThrow("stacks across repositories")
    })

    it("throws on a direct cycle between two new specs", () => {
        expect(() =>
            validateStackSpecs(
                { "web@logos": "web@strings", "web@strings": "web@logos" },
                scope,
                undefined
            )
        ).toThrow("would create a cycle")
    })

    it("catches a cycle that spans a stored edge plus a new spec", () => {
        // Stored: web@strings stacks on web@logos. New: web@logos stacks on
        // web@strings — closing the ring. The merged graph must catch it even
        // though neither run alone declared a cycle.
        const stored = { "web@strings": { base: "web@logos" } }
        expect(() =>
            validateStackSpecs({ "web@logos": "web@strings" }, scope, stored)
        ).toThrow("would create a cycle")
    })

    it("ignores a stored REMOTE-REF base when deriving edges (no false cycle)", () => {
        // web@strings's stored base is `develop` — a remote ref, NOT a sibling —
        // so it is not an edge and cannot participate in a cycle. web@logos
        // stacking on web@strings is a clean two-node chain.
        const stored = { "web@strings": { base: "develop" } }
        expect(() =>
            validateStackSpecs({ "web@logos": "web@strings" }, scope, stored)
        ).not.toThrow()
    })

    it("an explicit spec re-points (wins over) a stored edge for the same child", () => {
        // Stored: web@logos → web@strings. New: web@logos → web@api. The new
        // edge replaces the stored one, so there is no cycle and no conflict.
        const stored = { "web@logos": { base: "web@strings" } }
        expect(() =>
            validateStackSpecs({ "web@logos": "web@api" }, scope, stored)
        ).not.toThrow()
    })

    it("reports (none in scope) when the scope is empty", () => {
        expect(() =>
            validateStackSpecs({ "web@logos": "web@strings" }, [], undefined)
        ).toThrow("in scope: (none in scope)")
    })
})
