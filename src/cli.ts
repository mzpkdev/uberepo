import { execute } from "cmdore"
import add from "@/commands/add"
import clone from "@/commands/clone"
import close from "@/commands/close"
import context from "@/commands/context"
import diff from "@/commands/diff"
import exec from "@/commands/exec"
import init from "@/commands/init"
import open from "@/commands/open"
import prune from "@/commands/prune"
import pull from "@/commands/pull"
import remove from "@/commands/remove"
import ship from "@/commands/ship"
import sources from "@/commands/sources"
import status from "@/commands/status"
import sync from "@/commands/sync"
import { packageMetadata } from "@/package-root"

execute(
    [
        add,
        clone,
        close,
        context,
        diff,
        exec,
        init,
        open,
        prune,
        pull,
        remove,
        ship,
        sources,
        status,
        sync
    ],
    {
        // --help/--version identity. cmdore's default walks up from
        // process.cwd() and would report whatever package.json happens to
        // surround the user's workspace; pin it to uberepo's own manifest so
        // the published CLI reports itself from any directory.
        metadata: packageMetadata()
    }
)
