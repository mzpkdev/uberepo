#!/usr/bin/env node
// Production build: bundle the TypeScript CLI into a single plain-JS ESM file.
//
// Everything is bundled — cmdore (a `file:lib` dependency that no registry can
// resolve, so it MUST be inlined for the published package to work) and
// minimatch alike — leaving node builtins as the only imports. The published
// package therefore has zero runtime dependencies.
//
// esbuild reads tsconfig.json for the "@/*" path alias. The output format is
// ESM, while the sources (and the bundled CJS deps) are CommonJS-flavored:
// the banner below provides the three CJS globals an ESM module lacks —
//   require    cmdore & co. are CJS; esbuild's interop helper falls back to a
//              scoped `require` for anything it left as a runtime require
//   __filename / __dirname
//              src/package-root.ts anchors template/ + package.json resolution
//              on __dirname (tsc under module: CommonJS rejects import.meta);
//              in the bundle these must point at dist/, derived from
//              import.meta.url
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outdir = path.join(root, "dist")

const banner = `import { createRequire as __cjsCreateRequire } from "node:module"
import { fileURLToPath as __cjsFileURLToPath } from "node:url"
import { dirname as __cjsDirname } from "node:path"
const require = __cjsCreateRequire(import.meta.url)
const __filename = __cjsFileURLToPath(import.meta.url)
const __dirname = __cjsDirname(__filename)
`

fs.rmSync(outdir, { recursive: true, force: true })

await build({
    entryPoints: [path.join(root, "src", "cli.ts")],
    outfile: path.join(outdir, "cli.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    // Keep in lockstep with "engines.node" in package.json.
    target: "node20",
    tsconfig: path.join(root, "tsconfig.json"),
    banner: { js: banner },
    // Not minified: a CLI gains nothing from it and readable stack traces in
    // bug reports are worth far more than the bytes.
    minify: false,
    sourcemap: false,
    logLevel: "info"
})
