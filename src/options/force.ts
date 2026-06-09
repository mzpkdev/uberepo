import { defineOption } from "cmdore"

export const force = defineOption({
    name: "force",
    alias: "f",
    arity: 0,
    description: "Skip confirmation / overwrite"
})
