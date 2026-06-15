import * as path from "node:path"
import { baseFor, branchFor, taskBranch, worktreePath } from "@/tasks"

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
})
