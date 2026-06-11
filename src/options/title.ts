import { defineOption } from "cmdore"

// Override the PR title for every PR this ship run touches. One arg (the title
// text). Absent → the title is resolved per the ship design (goal's first line,
// then the task name).
export const title = defineOption({
    name: "title",
    alias: "t",
    arity: 1,
    description: "PR title for every PR this run (overrides the resolved title)"
})
