import { defineOption } from "cmdore"

// Override the PR body for every PR this ship run touches. One arg (the body
// text). Mutually exclusive with --body-file. Absent → the body is resolved
// per the ship design (the repo's .github PR template, else empty). The managed
// uberepo block is appended to whichever body wins.
export const body = defineOption({
    name: "body",
    arity: 1,
    description: "PR body for every PR this run (overrides the resolved body)"
})
