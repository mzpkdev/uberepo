import { defineOption } from "cmdore"

// Variadic by omitting `arity` (execute defaults it to Infinity), so
// `--repos api web` collects every following token into a string[]. Declares
// the task's scope — the source/<name> repos the task owns; commands then act
// only on those. Mirrors from/goal in shape.
export const repos = defineOption({
    name: "repos",
    alias: "r",
    hint: "names",
    description: "Limit the task to these repos (scopes ubertask.yml repos)"
})
