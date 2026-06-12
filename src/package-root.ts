import * as fs from "node:fs"
import * as path from "node:path"

// Assets that ship INSIDE the npm package (template/) and the package's own
// manifest must be resolved relative to the installed code, never process.cwd()
// — the CWD is the user's workspace, not our install dir. The code runs from
// two different depths, so a fixed number of ".."s cannot work:
//
//   dev        tsx runs src/cli.ts        → modules live in src/ and src/commands/
//   published  node runs dist/cli.mjs     → the whole CLI is one bundle in dist/
//
// Walking UP from this module to the first package.json named "uberepo" anchors
// every asset to the package root in both modes (and under `npm link`, where
// module resolution has already realpath'd us into the real checkout). Under
// tsx/vitest `__dirname` is the real src/ dir (module: CommonJS — tsc rejects
// import.meta.url as TS1343 here); in the dist bundle the build injects an
// ESM-safe `__dirname` shim pointing at dist/ (see scripts/build.mjs).
const findPackageRoot = (start: string): string => {
    let current = start
    while (true) {
        const candidate = path.join(current, "package.json")
        if (fs.existsSync(candidate)) {
            try {
                const manifest = JSON.parse(
                    fs.readFileSync(candidate, "utf8")
                ) as { name?: string }
                if (manifest.name === "uberepo") {
                    return current
                }
            } catch {
                // An unreadable or malformed package.json on the way up isn't
                // ours — keep walking toward the filesystem root.
            }
        }
        const parent = path.dirname(current)
        if (parent === current) {
            throw new Error(
                `Could not find the uberepo package root above ${start} — the installation looks broken.`
            )
        }
        current = parent
    }
}

export const PACKAGE_ROOT = findPackageRoot(__dirname)

// The default workspace files stamped by `init` (and the per-task seeds copied
// by `open`) live in the package's real template/ directory.
export const TEMPLATE_DIR = path.join(PACKAGE_ROOT, "template")

// The CLI's own identity for --help/--version, read from the package's own
// manifest. cmdore's default would walk up from process.cwd() and report
// whatever package.json surrounds the WORKSPACE (or nothing at all); anchoring
// to PACKAGE_ROOT reports uberepo itself from any directory, in dev and from
// the published bundle alike.
export const packageMetadata = (): {
    name: string
    version: string
    description: string
} => {
    const raw = JSON.parse(
        fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")
    ) as { name?: string; version?: string; description?: string }
    return {
        name: raw.name ?? "uberepo",
        version: raw.version ?? "",
        description: raw.description ?? ""
    }
}
