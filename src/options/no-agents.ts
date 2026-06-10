import { defineOption } from "cmdore"

// Opt out of seeding AGENTS.md / CLAUDE.md when initializing a workspace.
// cmdore keys argv by the literal option name, so this surfaces as
// argv["no-agents"] (arity 0 → boolean): absent is false, --no-agents is true.
export const noAgents = defineOption({
    name: "no-agents",
    arity: 0,
    description: "Skip seeding AGENTS.md / CLAUDE.md for AI agents"
})
