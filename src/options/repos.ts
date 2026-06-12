import { defineOption } from "cmdore"

// Variadic by omitting `arity` (execute defaults it to Infinity), so
// `--repos api web` collects every following token into a string[]. Names the
// flat source/<name> repos a command acts on: open records them as the task's
// declared scope (ubertask.yml repos:), ship filters this run to them, and
// clone clones only them. Mirrors from/goal in shape.
export const repos = defineOption({
    name: "repos",
    alias: "r",
    hint: "names",
    description:
        "Limit the command to these repos (open records them as the task's scope)"
})
