import { defineArgument } from "cmdore"

// The command to run in each worktree, captured as a VARIADIC argument: every
// token AFTER the mandatory `--` separator. cmdore/argvex strips the `--` and
// drops everything past it into the operands, so `exec <task> -- npm test`
// yields command = ["npm", "test"] (and a post-`--` `--watch` is preserved
// verbatim, never parsed as one of exec's flags). NOT marked `required`: a
// missing command would surface as cmdore's generic "argument is required",
// whereas exec's run() throws its own pointed "exec needs a command — …" so the
// operator sees the `--` shape they forgot. Must be the LAST argument (cmdore
// rejects a non-final variadic), which it is — exec's args are [task, command].
export const command = defineArgument({
    name: "command",
    variadic: true,
    description: "The command (and its arguments) to run, after `--`"
})
