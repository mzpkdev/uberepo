import { defineArgument } from "cmdore"

export const repository = defineArgument({
    name: "repository",
    required: true,
    description: "Repository to add to the workspace"
})
