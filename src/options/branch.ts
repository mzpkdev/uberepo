import { defineOption } from "cmdore"

// Variadic by omitting `arity` (execute defaults it to Infinity), exactly like
// --repos: `--branch <tok>...` collects every following token into a string[].
// Two forms share the one flag — a bare `--branch <name>` (the branch every
// in-scope repo adopts/creates) or repeatable `--branch <repo>=<name>` (per
// repo) — because cmdore has no native key=value map; open-plan's
// parseBranchSpecs tells them apart and rejects mixing the two. Unset for a
// repo → the task/<task> default. A branch that already exists (locally or on
// origin) is ADOPTED, not recreated.
export const branch = defineOption({
    name: "branch",
    hint: "spec",
    description:
        "Branch per repo: a bare name for all, or repeatable <repo>=<name> (adopts an existing branch)"
})
