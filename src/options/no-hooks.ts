import { defineOption } from "cmdore"

// Opt out of running the workspace's lifecycle hooks for this command. cmdore
// keys argv by the literal option name, so this surfaces as argv["no-hooks"]
// (arity 0 → boolean): absent is false, --no-hooks is true. The UBEREPO_NO_HOOKS
// env var is the same kill switch by another door (honoured in the runner).
export const noHooks = defineOption({
    name: "no-hooks",
    arity: 0,
    description: "Skip running lifecycle hooks declared in uberepo.json"
})
