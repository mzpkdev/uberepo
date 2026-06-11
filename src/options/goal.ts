import { defineOption } from "cmdore"

export const goal = defineOption({
    name: "goal",
    alias: "g",
    arity: 1,
    description: "Set the task note's goal (creates/updates ubertask.yml)"
})
