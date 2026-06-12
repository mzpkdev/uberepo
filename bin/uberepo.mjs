#!/usr/bin/env node
// Thin production launcher: load the bundled CLI in-process with plain node —
// no tsx, no TypeScript, no child process. Node resolves the bin symlink's
// realpath before executing, so ../dist lands inside the installed package.
//
// Development runs from source instead: `npm run dev -- <args>` (tsx).
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = path.join(here, "..", "dist", "cli.mjs")

if (!fs.existsSync(entry)) {
    console.error(
        "uberepo: dist/cli.mjs is missing. In a checkout, run `npm run build` first (or use `npm run dev -- <args>` to run from source)."
    )
    process.exit(1)
}

await import(pathToFileURL(entry).href)
