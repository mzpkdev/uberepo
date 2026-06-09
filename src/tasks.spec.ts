import * as path from "node:path"
import { taskBranch, worktreePath } from "@/tasks"

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
