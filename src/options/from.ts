import { defineOption } from "cmdore"

export const from = defineOption({
    name: "from",
    alias: "b",
    arity: 1,
    description: "Base ref to branch/rebase from"
})
