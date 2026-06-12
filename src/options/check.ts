import { defineOption } from "cmdore"

// Forecast-only mode for sync: fetch, then predict each repo's rebase outcome
// with `git merge-tree` — no rebase, no hooks, no carry, no worktree mutation.
// cmdore keys argv by the literal option name (arity 0 → boolean): absent is
// false, --check is true.
export const check = defineOption({
    name: "check",
    arity: 0,
    description: "Forecast the sync per repo without rebasing anything"
})
