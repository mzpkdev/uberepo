import { defineOption } from "cmdore"

// Stop the fan-out at the FIRST worktree whose command exits non-zero, instead
// of running the command in every target and reporting all the failures at the
// end. cmdore keys argv by the literal option name (arity 0 → boolean), so this
// surfaces as argv.bail: absent is false, --bail is true. Either way exec exits
// non-zero when any command failed; --bail only changes how far the loop gets.
export const bail = defineOption({
    name: "bail",
    arity: 0,
    description: "Stop at the first repo whose command fails"
})
