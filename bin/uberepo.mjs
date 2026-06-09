#!/usr/bin/env node
import { spawn } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const tsx = path.join(root, "node_modules", ".bin", "tsx")
const entry = path.join(root, "src", "cli.ts")
const tsconfig = path.join(root, "tsconfig.json")

const child = spawn(tsx, ["--tsconfig", tsconfig, entry, ...process.argv.slice(2)], {
    stdio: "inherit"
})
child.on("exit", (code) => process.exit(code ?? 1))
child.on("error", (err) => {
    console.error(err.message)
    process.exit(1)
})
