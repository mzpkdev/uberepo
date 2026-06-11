import { defineArgument } from "cmdore"

export const repositories = defineArgument({
    name: "repositories",
    required: true,
    variadic: true,
    description: "One or more repositories to add to the workspace"
})
