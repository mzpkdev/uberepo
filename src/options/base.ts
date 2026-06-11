import { defineOption } from "cmdore"

// The base branch the PRs target. One arg (a ref). Absent → each repo's
// remoteDefault() (e.g. main). The "ahead of base" check and `gh pr create
// --base` both read this.
export const base = defineOption({
    name: "base",
    arity: 1,
    description: "Base branch for the PRs (default: each repo's remote default)"
})
