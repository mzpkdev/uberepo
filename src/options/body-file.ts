import { defineOption } from "cmdore"

// Like --body, but read the override body from a file. Mutually exclusive with
// --body. cmdore keys argv by the literal option name, so this surfaces as
// argv["body-file"].
export const bodyFile = defineOption({
    name: "body-file",
    arity: 1,
    description: "Read the PR body for every PR this run from a file"
})
