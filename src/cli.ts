import { execute } from "cmdore"
import add from "@/commands/add"
import clone from "@/commands/clone"
import close from "@/commands/close"
import context from "@/commands/context"
import diff from "@/commands/diff"
import init from "@/commands/init"
import open from "@/commands/open"
import prune from "@/commands/prune"
import pull from "@/commands/pull"
import remove from "@/commands/remove"
import ship from "@/commands/ship"
import sources from "@/commands/sources"
import status from "@/commands/status"
import sync from "@/commands/sync"

execute([
    add,
    clone,
    close,
    context,
    diff,
    init,
    open,
    prune,
    pull,
    remove,
    ship,
    sources,
    status,
    sync
])
