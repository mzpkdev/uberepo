import { defineArgument } from "cmdore"

export const task = defineArgument({
    name: "task",
    required: true,
    description: "Task (worktree set) name"
})
