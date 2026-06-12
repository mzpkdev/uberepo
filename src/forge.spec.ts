import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
    type Gh,
    GhError,
    ghAvailable,
    prCreate,
    prList,
    prView,
    pullRequestNumber,
    readPrTemplate
} from "@/forge"

// A fake gh runner that records every (args, cwd) call and replays canned
// stdout per call, so the wrappers can be tested without a network or binary.
const fakeGh = (
    responses: string[]
): { run: Gh; calls: { args: string[]; cwd: string }[] } => {
    const calls: { args: string[]; cwd: string }[] = []
    let i = 0
    const run: Gh = async (args, cwd) => {
        calls.push({ args, cwd })
        return responses[i++] ?? ""
    }
    return { run, calls }
}

describe("forge: gh wrappers", () => {
    it("prList passes the exact argv and parses the JSON array", async () => {
        const { run, calls } = fakeGh([
            JSON.stringify([
                {
                    number: 7,
                    url: "https://github.com/acme/api/pull/7",
                    state: "OPEN"
                }
            ])
        ])
        const prs = await prList(run, "/wt/api", "task/alpha")
        expect(calls).toEqual([
            {
                args: [
                    "pr",
                    "list",
                    "--head",
                    "task/alpha",
                    "--json",
                    "number,url,state"
                ],
                cwd: "/wt/api"
            }
        ])
        expect(prs).toEqual([
            {
                number: 7,
                url: "https://github.com/acme/api/pull/7",
                state: "OPEN"
            }
        ])
    })

    it("prList returns [] on empty output", async () => {
        const { run } = fakeGh([""])
        expect(await prList(run, "/wt/api", "task/alpha")).toEqual([])
    })

    it("prCreate passes --draft --base --head --title --body-file and returns the url", async () => {
        const { run, calls } = fakeGh(["https://github.com/acme/api/pull/12\n"])
        const url = await prCreate(run, "/wt/api", {
            base: "main",
            head: "task/alpha",
            title: "My PR",
            bodyFile: "/tmp/body.md"
        })
        expect(calls[0]).toEqual({
            args: [
                "pr",
                "create",
                "--draft",
                "--base",
                "main",
                "--head",
                "task/alpha",
                "--title",
                "My PR",
                "--body-file",
                "/tmp/body.md"
            ],
            cwd: "/wt/api"
        })
        expect(url).toBe("https://github.com/acme/api/pull/12")
    })

    it("prView passes the exact argv and parses the JSON object", async () => {
        const { run, calls } = fakeGh([
            JSON.stringify({
                number: 12,
                url: "https://github.com/acme/api/pull/12",
                isDraft: true,
                state: "OPEN"
            })
        ])
        const pr = await prView(run, "/wt/api", "task/alpha")
        expect(calls).toEqual([
            {
                args: [
                    "pr",
                    "view",
                    "task/alpha",
                    "--json",
                    "number,url,isDraft,state"
                ],
                cwd: "/wt/api"
            }
        ])
        expect(pr).toEqual({
            number: 12,
            url: "https://github.com/acme/api/pull/12",
            isDraft: true,
            state: "OPEN"
        })
    })

    it("prView swallows a gh failure (no PR, no auth, no gh) as undefined", async () => {
        const failing: Gh = async (args) => {
            throw new GhError(args, 1, "no pull requests found for branch")
        }
        expect(await prView(failing, "/wt/api", "task/alpha")).toBeUndefined()
        // Empty / garbled stdout degrades the same way — never a throw.
        const { run } = fakeGh([""])
        expect(await prView(run, "/wt/api", "task/alpha")).toBeUndefined()
        const { run: garbled } = fakeGh(["not json"])
        expect(await prView(garbled, "/wt/api", "task/alpha")).toBeUndefined()
    })

    it("ghAvailable is true when the runner succeeds, false when it throws", async () => {
        const ok: Gh = async () => "gh version 2.0.0"
        const missing: Gh = async () => {
            throw new GhError(["--version"], 1, "not found")
        }
        expect(await ghAvailable(ok)).toBe(true)
        expect(await ghAvailable(missing)).toBe(false)
    })
})

describe("forge: pullRequestNumber", () => {
    it("parses the number from a PR url", () => {
        expect(pullRequestNumber("https://github.com/acme/api/pull/42")).toBe(
            42
        )
    })

    it("returns undefined for a non-PR url", () => {
        expect(pullRequestNumber("https://example.com/x")).toBeUndefined()
    })
})

describe("forge: readPrTemplate", () => {
    let dir: string
    beforeEach(async () => {
        dir = await fsp.realpath(
            await fsp.mkdtemp(path.join(os.tmpdir(), "tmpl-"))
        )
    })
    afterEach(async () => {
        await fsp.rm(dir, { recursive: true, force: true })
    })

    it("finds .github/pull_request_template.md", async () => {
        await fsp.mkdir(path.join(dir, ".github"))
        await fsp.writeFile(
            path.join(dir, ".github", "pull_request_template.md"),
            "## From .github\n"
        )
        expect(readPrTemplate(dir)).toBe("## From .github\n")
    })

    it("falls back to the repo root, then docs/, case-insensitively", async () => {
        // Root template (capitalised) wins over docs.
        await fsp.writeFile(
            path.join(dir, "PULL_REQUEST_TEMPLATE.md"),
            "root\n"
        )
        await fsp.mkdir(path.join(dir, "docs"))
        await fsp.writeFile(
            path.join(dir, "docs", "pull_request_template.md"),
            "docs\n"
        )
        expect(readPrTemplate(dir)).toBe("root\n")
    })

    it("uses docs/ when neither .github nor root has one", async () => {
        await fsp.mkdir(path.join(dir, "docs"))
        await fsp.writeFile(
            path.join(dir, "docs", "Pull_Request_Template.md"),
            "docs\n"
        )
        expect(readPrTemplate(dir)).toBe("docs\n")
    })

    it("ignores a multi-template DIRECTORY (treats it as no template)", async () => {
        const multi = path.join(dir, ".github", "PULL_REQUEST_TEMPLATE")
        await fsp.mkdir(multi, { recursive: true })
        await fsp.writeFile(path.join(multi, "a.md"), "a\n")
        expect(readPrTemplate(dir)).toBeUndefined()
    })

    it("returns undefined when there is no template anywhere", () => {
        expect(readPrTemplate(dir)).toBeUndefined()
    })
})
