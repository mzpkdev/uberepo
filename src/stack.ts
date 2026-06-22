import type { FootprintRepo } from "@/footprint"

// The ONE place the read surfaces (diff, context, status) agree on how a stack
// renders, so the three printers stay byte-for-byte consistent. The feature is
// invisible until a stack edge exists: a participant with no `parent` keeps
// today's plain indent, so a non-stacked task renders exactly as it always did.

// A root / non-stacked row's lead-in: the original two-space indent every
// printer used before stacking existed. Using it for the no-parent case is what
// guarantees the regression: an unstacked task's lines are unchanged.
export const STACK_INDENT = "  "

// A stacked CHILD's lead-in: the same two-space indent, then a `└─ ` connector,
// so the child hangs visibly off the parent printed just above it (the
// footprint is ordered parent-first). `└─` is the box-drawing connector the
// README's directory trees already use — on-brand, and the only stack glyph,
// shared across all three printers via this constant.
export const STACK_CHILD = "  └─ "

// The bullet-list equivalent for context's markdown handoff: a child bullet is
// nested one level under its parent bullet (two leading spaces before the `- `),
// the standard markdown nesting, so the same parent→child structure reads in a
// rendered brief and raw alike. A root keeps context's original `- ` bullet.
export const STACK_BULLET_ROOT = "- "
export const STACK_BULLET_CHILD = "  - "

// The ref a single footprint row was compared against: a stacked child measures
// against its PARENT's branch (so its ahead-count/diffstat are the child's own
// commits beyond the sibling it sits on), a root against the run's resolved
// `base`. The footprint already carries `parent` (the sibling token) and every
// sibling's `branch`, so the child's base is simply the parent entry's branch —
// derived here, not recomputed from the note, so diff/context surface the exact
// branch the comparison used. Falls back to the run base if the named parent
// somehow isn't in the set (it always is — they share scope).
export const rowBase = (
    repo: FootprintRepo,
    repos: FootprintRepo[],
    base: string
): string => {
    if (repo.parent === undefined) {
        return base
    }
    const parent = repos.find((other) => other.name === repo.parent)
    return parent?.branch ?? base
}
