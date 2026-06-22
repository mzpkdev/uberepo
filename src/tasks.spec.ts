import * as path from "node:path"
import {
    baseFor,
    branchFor,
    participantBranch,
    sourceName,
    splitParticipant,
    stackOrder,
    stackParent,
    taskBranch,
    worktreePath
} from "@/tasks"

describe("worktreePath", () => {
    it("joins root/tasks/<task>/<name>", () => {
        expect(worktreePath("/ws", "feature", "api")).toBe(
            path.join("/ws", "tasks", "feature", "api")
        )
    })

    it("uses the platform separator via path.join", () => {
        expect(worktreePath("/ws", "t", "n")).toBe(
            ["", "ws", "tasks", "t", "n"].join(path.sep)
        )
    })

    it("keeps an aliased participant as a FLAT one-level folder name", () => {
        // The typed token IS the folder; `@` is not a separator here.
        expect(worktreePath("/ws", "t", "autopilot@bug-fix")).toBe(
            path.join("/ws", "tasks", "t", "autopilot@bug-fix")
        )
    })
})

describe("splitParticipant", () => {
    it("returns the bare repo with no alias for a plain token", () => {
        expect(splitParticipant("web")).toEqual({ repo: "web" })
    })

    it("splits repo@alias on the first @", () => {
        expect(splitParticipant("autopilot@bug-fix")).toEqual({
            repo: "autopilot",
            alias: "bug-fix"
        })
    })

    it("a trailing @ with nothing after is a bare repo (no empty alias)", () => {
        expect(splitParticipant("web@")).toEqual({ repo: "web" })
    })
})

describe("sourceName", () => {
    it("is the repo for a bare token, the repo part for an aliased one", () => {
        // THE seam: aliased participants share one source/<repo> clone.
        expect(sourceName("web")).toBe("web")
        expect(sourceName("autopilot@bug-fix")).toBe("autopilot")
        expect(sourceName("autopilot@add-feature")).toBe("autopilot")
    })
})

describe("participantBranch", () => {
    it("is task/<task> for a bare participant", () => {
        expect(participantBranch("alpha", "web")).toBe("task/alpha")
    })

    it("is task/<task>@<alias> for an aliased participant", () => {
        // `@` leaf (not `/`) so it sits beside a bare task/<task> in git's ref
        // store without collision.
        expect(participantBranch("alpha", "autopilot@bug-fix")).toBe(
            "task/alpha@bug-fix"
        )
    })
})

describe("taskBranch", () => {
    it("prefixes the task name with task/", () => {
        expect(taskBranch("feature")).toBe("task/feature")
    })

    it("leaves slashes in the task name intact", () => {
        expect(taskBranch("foo/bar")).toBe("task/foo/bar")
    })
})

describe("branchFor", () => {
    it("falls back to task/<task> for a LEGACY task (no branches map)", () => {
        // The hard requirement: a task that never recorded branches resolves
        // exactly as today, whether the map is undefined or empty.
        expect(branchFor("feature", "api", undefined)).toBe("task/feature")
        expect(branchFor("feature", "api", {})).toBe("task/feature")
    })

    it("falls back to task/<task> for a repo absent from the map", () => {
        expect(branchFor("feature", "web", { api: { name: "feat/x" } })).toBe(
            "task/feature"
        )
    })

    it("returns the recorded branch name when the repo has one", () => {
        expect(branchFor("feature", "api", { api: { name: "feat/sso" } })).toBe(
            "feat/sso"
        )
    })

    it("falls back to the ALIASED default for an aliased participant with no entry", () => {
        // An aliased participant needs no branches entry: branchFor
        // reconstructs task/<task>@<alias> from the token itself.
        expect(branchFor("feature", "autopilot@bug-fix", {})).toBe(
            "task/feature@bug-fix"
        )
        expect(branchFor("feature", "autopilot@add-feature", undefined)).toBe(
            "task/feature@add-feature"
        )
    })

    it("keys overrides by the FULL participant token, so a repo's aliases stay distinct", () => {
        const branches = {
            "autopilot@bug-fix": { name: "fix/login" },
            "autopilot@add-feature": { name: "feat/sso" }
        }
        expect(branchFor("feature", "autopilot@bug-fix", branches)).toBe(
            "fix/login"
        )
        expect(branchFor("feature", "autopilot@add-feature", branches)).toBe(
            "feat/sso"
        )
    })
})

describe("baseFor", () => {
    it("returns undefined for a legacy task (no branches map) — falls through to remoteDefault", () => {
        expect(baseFor("api", undefined)).toBeUndefined()
        expect(baseFor("api", {})).toBeUndefined()
    })

    it("returns undefined for a repo with no recorded base (a created branch)", () => {
        expect(baseFor("api", { api: { base: undefined } })).toBeUndefined()
        expect(baseFor("web", { api: { base: "develop" } })).toBeUndefined()
    })

    it("returns the persisted base when one was recorded (an adopted branch)", () => {
        expect(baseFor("api", { api: { base: "develop" } })).toBe("develop")
    })

    it("keys the base by the full participant token (per-alias bases)", () => {
        const branches = {
            "autopilot@bug-fix": { base: "develop" },
            "autopilot@add-feature": { base: "release/2" }
        }
        expect(baseFor("autopilot@bug-fix", branches)).toBe("develop")
        expect(baseFor("autopilot@add-feature", branches)).toBe("release/2")
    })
})

describe("stackParent — classify a base as a sibling edge vs a remote ref", () => {
    // The whole task scope; the classifier asks only whether the stored base
    // names one of these participants.
    const scope = ["web@strings", "web@logos", "api"]

    it("a base naming an in-scope sibling is the stack parent", () => {
        const branches = { "web@logos": { base: "web@strings" } }
        expect(stackParent("web@logos", branches, scope)).toBe("web@strings")
    })

    it("a base that is a remote ref (not in scope) is NOT a stack edge", () => {
        // `develop` is a remote ref an adopted branch's PR targets — it is not a
        // participant, so it stays a remote base, never a sibling.
        const branches = { "web@logos": { base: "develop" } }
        expect(stackParent("web@logos", branches, scope)).toBeUndefined()
    })

    it("an unset base is not a stack edge (a created branch on its default)", () => {
        expect(stackParent("api", {}, scope)).toBeUndefined()
        expect(stackParent("api", undefined, scope)).toBeUndefined()
        expect(
            stackParent("web@logos", { "web@logos": {} }, scope)
        ).toBeUndefined()
    })

    it("resolves a base keyed by the FULL aliased token to its sibling", () => {
        // Both child and parent are aliased participants of the one repo; the
        // edge is keyed and resolved by the full `@`-token.
        const branches = {
            "web@logos": { base: "web@strings" },
            "web@strings": { base: "develop" }
        }
        expect(stackParent("web@logos", branches, scope)).toBe("web@strings")
        // The parent itself stacks on a remote ref, so it is a root, not a child.
        expect(stackParent("web@strings", branches, scope)).toBeUndefined()
    })
})

describe("stackOrder — topological walk of the per-repo stack forest", () => {
    it("leaves non-stacked participants in their input order (no edges)", () => {
        expect(stackOrder(["api", "web"], {}, ["api", "web"])).toEqual([
            "api",
            "web"
        ])
        expect(stackOrder(["api", "web"], undefined, [])).toEqual([
            "api",
            "web"
        ])
    })

    it("puts a parent before its child regardless of input order", () => {
        // logos sorts/arrives before strings, but its parent must come first.
        const scope = ["web@strings", "web@logos"]
        const branches = { "web@logos": { base: "web@strings" } }
        expect(
            stackOrder(["web@logos", "web@strings"], branches, scope)
        ).toEqual(["web@strings", "web@logos"])
    })

    it("orders a multi-level chain parent → child → grandchild", () => {
        const scope = ["r@p", "r@c", "r@g"]
        const branches = {
            "r@c": { base: "r@p" },
            "r@g": { base: "r@c" }
        }
        // Even fed in reverse, the chain comes out root-first.
        expect(stackOrder(["r@g", "r@c", "r@p"], branches, scope)).toEqual([
            "r@p",
            "r@c",
            "r@g"
        ])
    })

    it("emits every participant exactly once across several stacks and roots", () => {
        const scope = ["a", "b@p", "b@c", "c"]
        const branches = { "b@c": { base: "b@p" } }
        const ordered = stackOrder(["a", "b@c", "b@p", "c"], branches, scope)
        expect([...ordered].sort()).toEqual(["a", "b@c", "b@p", "c"])
        // b@p precedes b@c; the independent roots keep their relative order.
        expect(ordered.indexOf("b@p")).toBeLessThan(ordered.indexOf("b@c"))
    })

    it("treats a base whose sibling is NOT present as a root (so it still syncs)", () => {
        // logos.base names strings, but strings isn't in `present` (its worktree
        // was closed): logos must not wait on an absent parent.
        const scope = ["web@strings", "web@logos"]
        const branches = { "web@logos": { base: "web@strings" } }
        expect(stackOrder(["web@logos"], branches, scope)).toEqual([
            "web@logos"
        ])
    })

    it("emits each node once even if a (validation-forbidden) cycle were present", () => {
        // Defensive: a malformed note with a 2-cycle must not hang or duplicate.
        const scope = ["r@x", "r@y"]
        const branches = {
            "r@x": { base: "r@y" },
            "r@y": { base: "r@x" }
        }
        const ordered = stackOrder(["r@x", "r@y"], branches, scope)
        expect([...ordered].sort()).toEqual(["r@x", "r@y"])
    })
})
