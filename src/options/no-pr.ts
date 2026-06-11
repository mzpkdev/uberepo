import { defineOption } from "cmdore"

// Push the task branches only — skip every `gh` call (open PRs, edits). The only
// ship mode that works without the GitHub CLI installed. cmdore keys argv by the
// literal option name (arity 0 → boolean), so this surfaces as argv["no-pr"]:
// absent is false, --no-pr is true.
export const noPr = defineOption({
    name: "no-pr",
    arity: 0,
    description: "Push only — skip opening or updating any pull request"
})
