import { defineOption } from "cmdore"

// Variadic by omitting `arity` (execute defaults it to Infinity), exactly like
// --branch/--repos: `--stack <child>=<parent>...` collects every following token
// into a string[]. Each token declares a STACK EDGE — one participant's branch
// sits on a SIBLING participant's branch in the same repo (`web@logos`'s base is
// `web@strings`), so its PR is opened against the parent's branch, not the
// remote default. cmdore has no native key=value map, so open-plan's
// parseStackSpecs splits each token on the first `=` and validateStackSpecs
// rejects a cross-repo / out-of-scope / cyclic edge. Writes the note's existing
// per-participant `base` field — a base that names a sibling IS the edge (see
// tasks.stackParent). A name needs no `--stack` to land on its default.
export const stack = defineOption({
    name: "stack",
    hint: "child=parent",
    description:
        "Stack one participant's branch on a sibling's: --stack web@logos=web@strings (repeatable)"
})
