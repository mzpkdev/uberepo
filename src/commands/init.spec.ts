import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { terminal } from "cmdore"
import { vi } from "vitest"
import init from "@/commands/init"
import { CONFIG_FILENAME } from "@/config"
import { UBERTASK_FILENAME } from "@/tasks"

// Run `fn` with jsonMode enabled, returning the single parsed JSON object the
// command wrote to stdout. Resets jsonMode in finally before any assertion can
// throw, so a failing expect() never leaks jsonMode into sibling suites.
const captureJson = async <T>(fn: () => Promise<void>): Promise<T> => {
    const written: string[] = []
    const spy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: string | Uint8Array): boolean => {
            written.push(chunk.toString())
            return true
        })
    terminal.jsonMode = true
    try {
        await fn()
    } finally {
        terminal.jsonMode = false
        spy.mockRestore()
    }
    const output = written.join("")
    expect(written).toEqual([output])
    expect(output.endsWith("\n")).toBe(true)
    return JSON.parse(output) as T
}

const AGENTS_FILENAME = "AGENTS.md"
const CLAUDE_FILENAME = "CLAUDE.md"
const GITIGNORE_FILENAME = ".gitignore"
// The workspace .gitignore ships DOTLESS in template/ (npm install renames
// `.gitignore` files inside packages to `.npmignore` on extract); init stamps
// it back to the real dotted name. So the template source we READ and the
// stamped target we ASSERT against differ for this one file.
const GITIGNORE_TEMPLATE_FILENAME = "gitignore"
// The skill lives in the repo at template/.claude/skills/using-uberepo/ and init
// stamps it verbatim to the same relative path in the workspace. So this is both
// the template source we READ and the stamped target we ASSERT against.
const SKILL_REL = path.join(".claude", "skills", "using-uberepo", "SKILL.md")
// The skill splits depth into a sibling reference.md (progressive disclosure);
// the recursive stamp copies it verbatim alongside SKILL.md.
const SKILL_REF_REL = path.join(
    ".claude",
    "skills",
    "using-uberepo",
    "reference.md"
)
// The same skill also ships under .agents/ — a cross-tool copy read by Codex and
// Gemini (which look in .agents/skills/, not .claude/skills/). init stamps it
// verbatim too, so these are likewise both the READ source and the ASSERT target.
const AGENT_SKILL_REL = path.join(
    ".agents",
    "skills",
    "using-uberepo",
    "SKILL.md"
)
const AGENT_SKILL_REF_REL = path.join(
    ".agents",
    "skills",
    "using-uberepo",
    "reference.md"
)
// The second bundled skill, boot-uberepo, stamps the same recursive way under
// both .claude/ (Claude Code) and .agents/ (Codex & Gemini).
const BOOT_SKILL_REL = path.join(
    ".claude",
    "skills",
    "boot-uberepo",
    "SKILL.md"
)
const BOOT_AGENT_SKILL_REL = path.join(
    ".agents",
    "skills",
    "boot-uberepo",
    "SKILL.md"
)

// The on-disk template/ files are the single source of truth for what init
// stamps — read them straight off disk (resolved relative to this spec, the
// same way init resolves them relative to itself) and assert the stamped
// output is byte-identical. An empty/wrong resolution here would surface as a
// read error or a mismatch.
const TEMPLATE_DIR = path.join(__dirname, "..", "..", "template")

describe("init command", () => {
    let tmp: string
    let cwd: string
    let configPath: string
    let agentsTemplate: string
    let claudeTemplate: string
    let gitignoreTemplate: string
    let skillTemplate: string
    let skillRefTemplate: string
    let agentSkillTemplate: string
    let agentSkillRefTemplate: string

    beforeAll(async () => {
        agentsTemplate = await fsp.readFile(
            path.join(TEMPLATE_DIR, AGENTS_FILENAME),
            "utf8"
        )
        claudeTemplate = await fsp.readFile(
            path.join(TEMPLATE_DIR, CLAUDE_FILENAME),
            "utf8"
        )
        gitignoreTemplate = await fsp.readFile(
            path.join(TEMPLATE_DIR, GITIGNORE_TEMPLATE_FILENAME),
            "utf8"
        )
        skillTemplate = await fsp.readFile(
            path.join(TEMPLATE_DIR, SKILL_REL),
            "utf8"
        )
        skillRefTemplate = await fsp.readFile(
            path.join(TEMPLATE_DIR, SKILL_REF_REL),
            "utf8"
        )
        agentSkillTemplate = await fsp.readFile(
            path.join(TEMPLATE_DIR, AGENT_SKILL_REL),
            "utf8"
        )
        agentSkillRefTemplate = await fsp.readFile(
            path.join(TEMPLATE_DIR, AGENT_SKILL_REF_REL),
            "utf8"
        )
    })

    // Build a fresh empty temp dir and chdir into it for each test, since init
    // reads process.cwd(); restore the original cwd in afterEach.
    beforeEach(async () => {
        // realpath: macOS tmpdir lives under /var -> /private/var, and init
        // resolves paths through process.cwd()'s realpath, so canonicalise the
        // root we assert against here too.
        tmp = await fsp.realpath(
            await fsp.mkdtemp(path.join(os.tmpdir(), "init-spec-"))
        )
        configPath = path.join(tmp, CONFIG_FILENAME)
        cwd = process.cwd()
        process.chdir(tmp)
    })

    afterEach(async () => {
        terminal.jsonMode = false
        vi.restoreAllMocks()
        process.chdir(cwd)
        await fsp.rm(tmp, { recursive: true, force: true })
    })

    it("creates uberepo.json with the default config bytes", async () => {
        await init.run({ name: undefined, "no-agents": false })
        const written = await fsp.readFile(configPath, "utf8")
        expect(written).toBe(`{\n    "repositories": []\n}\n`)
    })

    it("stamps AGENTS.md, CLAUDE.md, and .gitignore in cwd alongside uberepo.json", async () => {
        await init.run({ name: undefined, "no-agents": false })

        expect(await fsp.readFile(configPath, "utf8")).toBe(
            `{\n    "repositories": []\n}\n`
        )
        // Byte-for-byte against the on-disk template — proves the stamp copies
        // the real template file (not an empty/garbled resolution).
        expect(
            await fsp.readFile(path.join(tmp, AGENTS_FILENAME), "utf8")
        ).toBe(agentsTemplate)
        expect(
            await fsp.readFile(path.join(tmp, CLAUDE_FILENAME), "utf8")
        ).toBe(claudeTemplate)
        // .gitignore keeps a committed workspace clean; stamped on every init.
        expect(
            await fsp.readFile(path.join(tmp, GITIGNORE_FILENAME), "utf8")
        ).toBe(gitignoreTemplate)
    })

    it("stamps the bundled Claude skill at .claude/skills/using-uberepo/SKILL.md", async () => {
        await init.run({ name: undefined, "no-agents": false })

        // The recursive stamp copies the nested skill verbatim to the same
        // relative path; SKILL.md lands byte-for-byte in the workspace.
        expect(await fsp.readFile(path.join(tmp, SKILL_REL), "utf8")).toBe(
            skillTemplate
        )
        // ...and so does the skill's sibling reference.md — the recursive walk
        // copies every file in the skill dir, not just SKILL.md.
        expect(await fsp.readFile(path.join(tmp, SKILL_REF_REL), "utf8")).toBe(
            skillRefTemplate
        )
        // The cross-tool copy under .agents/ (read by Codex & Gemini) stamps the
        // same way — SKILL.md byte-for-byte at its mirrored relative path.
        expect(
            await fsp.readFile(path.join(tmp, AGENT_SKILL_REL), "utf8")
        ).toBe(agentSkillTemplate)
        // ...and its sibling reference.md too, for the same recursive reason.
        expect(
            await fsp.readFile(path.join(tmp, AGENT_SKILL_REF_REL), "utf8")
        ).toBe(agentSkillRefTemplate)
    })

    it("stamps the boot-uberepo skill under .claude/ and .agents/", async () => {
        await init.run({ name: undefined, "no-agents": false })

        // boot-uberepo is the second bundled skill; the recursive stamp lands it
        // byte-for-byte in both trees, exactly like using-uberepo.
        expect(await fsp.readFile(path.join(tmp, BOOT_SKILL_REL), "utf8")).toBe(
            await fsp.readFile(path.join(TEMPLATE_DIR, BOOT_SKILL_REL), "utf8")
        )
        expect(
            await fsp.readFile(path.join(tmp, BOOT_AGENT_SKILL_REL), "utf8")
        ).toBe(
            await fsp.readFile(
                path.join(TEMPLATE_DIR, BOOT_AGENT_SKILL_REL),
                "utf8"
            )
        )
    })

    it("does NOT stamp ubertask.yml — it's a per-task seed open copies, not a workspace file", async () => {
        // ubertask.yml lives in template/ as the durable-note seed, but `open`
        // (not init) byte-copies it into each task dir. It must never land at
        // the workspace root, even though the recursive stamp surfaces it.
        await init.run({ name: undefined, "no-agents": false })

        await expect(
            fsp.access(path.join(tmp, UBERTASK_FILENAME))
        ).rejects.toThrow()
        // The agent files still land — proving the skip is scoped to the seed,
        // not a blanket stamp failure.
        expect(
            await fsp.readFile(path.join(tmp, AGENTS_FILENAME), "utf8")
        ).toBe(agentsTemplate)
    })

    it("stamps AGENTS.md, CLAUDE.md, and .gitignore into <name>/ with uberepo.json", async () => {
        await init.run({ name: "lokalise-workdir", "no-agents": false })
        const dir = path.join(tmp, "lokalise-workdir")

        expect(
            await fsp.readFile(path.join(dir, CONFIG_FILENAME), "utf8")
        ).toBe(`{\n    "repositories": []\n}\n`)
        expect(
            await fsp.readFile(path.join(dir, AGENTS_FILENAME), "utf8")
        ).toBe(agentsTemplate)
        expect(
            await fsp.readFile(path.join(dir, CLAUDE_FILENAME), "utf8")
        ).toBe(claudeTemplate)
        expect(
            await fsp.readFile(path.join(dir, GITIGNORE_FILENAME), "utf8")
        ).toBe(gitignoreTemplate)
    })

    it("stamps .gitignore but not AGENTS.md/CLAUDE.md when --no-agents is set", async () => {
        await init.run({ name: undefined, "no-agents": true })

        expect(await fsp.readFile(configPath, "utf8")).toBe(
            `{\n    "repositories": []\n}\n`
        )
        // The carve-out: .gitignore is workspace hygiene, decoupled from the
        // agent-files opt-out — so it still lands, byte-for-byte.
        expect(
            await fsp.readFile(path.join(tmp, GITIGNORE_FILENAME), "utf8")
        ).toBe(gitignoreTemplate)
        // ...while the agent context files are suppressed.
        await expect(
            fsp.access(path.join(tmp, AGENTS_FILENAME))
        ).rejects.toThrow()
        await expect(
            fsp.access(path.join(tmp, CLAUDE_FILENAME))
        ).rejects.toThrow()
        // ...and so is the whole .claude/ skill tree — the dir isn't created.
        await expect(fsp.access(path.join(tmp, ".claude"))).rejects.toThrow()
        // ...and the cross-tool .agents/ skill copy is suppressed too — its
        // SKILL.md never lands when --no-agents holds back the .agents/ subtree.
        await expect(
            fsp.access(path.join(tmp, AGENT_SKILL_REL))
        ).rejects.toThrow()
    })

    it("leaves an existing AGENTS.md untouched but still stamps CLAUDE.md", async () => {
        const custom = "# my own agents file\nleave me alone\n"
        await fsp.writeFile(path.join(tmp, AGENTS_FILENAME), custom)

        await init.run({ name: undefined, "no-agents": false })

        // The user's AGENTS.md is preserved verbatim — never clobbered.
        expect(
            await fsp.readFile(path.join(tmp, AGENTS_FILENAME), "utf8")
        ).toBe(custom)
        // ...but the other two files are still created.
        expect(await fsp.readFile(configPath, "utf8")).toBe(
            `{\n    "repositories": []\n}\n`
        )
        expect(
            await fsp.readFile(path.join(tmp, CLAUDE_FILENAME), "utf8")
        ).toBe(claudeTemplate)
    })

    it("leaves an existing .gitignore untouched but still stamps the rest", async () => {
        const custom = "# my own ignore rules\nbuild/\n"
        await fsp.writeFile(path.join(tmp, GITIGNORE_FILENAME), custom)

        await init.run({ name: undefined, "no-agents": false })

        // The user's .gitignore is preserved verbatim — never clobbered.
        expect(
            await fsp.readFile(path.join(tmp, GITIGNORE_FILENAME), "utf8")
        ).toBe(custom)
        // ...but the agent files are still created.
        expect(
            await fsp.readFile(path.join(tmp, AGENTS_FILENAME), "utf8")
        ).toBe(agentsTemplate)
        expect(
            await fsp.readFile(path.join(tmp, CLAUDE_FILENAME), "utf8")
        ).toBe(claudeTemplate)
    })

    it("leaves an existing nested skill file untouched but still stamps the rest", async () => {
        const custom = "---\ndescription: mine\n---\n\n# my own skill\n"
        const skillTarget = path.join(tmp, SKILL_REL)
        await fsp.mkdir(path.dirname(skillTarget), { recursive: true })
        await fsp.writeFile(skillTarget, custom)

        await init.run({ name: undefined, "no-agents": false })

        // The user's nested SKILL.md is preserved verbatim — the recursive
        // skip-if-exists guards deep paths, not just top-level files.
        expect(await fsp.readFile(skillTarget, "utf8")).toBe(custom)
        // ...but the rest of the template still lands.
        expect(await fsp.readFile(configPath, "utf8")).toBe(
            `{\n    "repositories": []\n}\n`
        )
        expect(
            await fsp.readFile(path.join(tmp, AGENTS_FILENAME), "utf8")
        ).toBe(agentsTemplate)
        expect(
            await fsp.readFile(path.join(tmp, GITIGNORE_FILENAME), "utf8")
        ).toBe(gitignoreTemplate)
    })

    it("throws and leaves the existing config untouched when one exists", async () => {
        const existing = `{\n    "repositories": ["keep"]\n}\n`
        await fsp.writeFile(configPath, existing)

        let error: unknown
        try {
            await init.run({ name: undefined, "no-agents": false })
        } catch (e) {
            error = e
        }
        expect(error).toBeInstanceOf(Error)
        // The path embedded in the message is process.cwd()'s realpath, which
        // macOS canonicalises (/var -> /private/var); assert on the stable
        // filename + refusal phrasing rather than the volatile absolute path.
        expect((error as Error).message).toContain(CONFIG_FILENAME)
        expect((error as Error).message).toContain("refusing to overwrite.")

        expect(await fsp.readFile(configPath, "utf8")).toBe(existing)
        // The throw aborts before any template files are stamped.
        await expect(
            fsp.access(path.join(tmp, AGENTS_FILENAME))
        ).rejects.toThrow()
    })

    it("creates <name>/uberepo.json with the default bytes, making the dir", async () => {
        await init.run({ name: "lokalise-workdir", "no-agents": false })
        const written = await fsp.readFile(
            path.join(tmp, "lokalise-workdir", CONFIG_FILENAME),
            "utf8"
        )
        expect(written).toBe(`{\n    "repositories": []\n}\n`)
        // The bare-cwd manifest must NOT have been written.
        await expect(fsp.access(configPath)).rejects.toThrow()
    })

    it("creates a nested <name>/uberepo.json, making parent dirs", async () => {
        await init.run({ name: path.join("a", "b"), "no-agents": false })
        const written = await fsp.readFile(
            path.join(tmp, "a", "b", CONFIG_FILENAME),
            "utf8"
        )
        expect(written).toBe(`{\n    "repositories": []\n}\n`)
    })

    it("throws and leaves <name>/uberepo.json untouched when it exists", async () => {
        const dir = path.join(tmp, "lokalise-workdir")
        await fsp.mkdir(dir, { recursive: true })
        const existing = `{\n    "repositories": ["keep"]\n}\n`
        const target = path.join(dir, CONFIG_FILENAME)
        await fsp.writeFile(target, existing)

        let error: unknown
        try {
            await init.run({ name: "lokalise-workdir", "no-agents": false })
        } catch (e) {
            error = e
        }
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain(CONFIG_FILENAME)
        expect((error as Error).message).toContain("refusing to overwrite.")

        expect(await fsp.readFile(target, "utf8")).toBe(existing)
    })

    it("emits { workspace, created:true, agents:true } under --json for a fresh init", async () => {
        const json = await captureJson<{
            workspace: string
            created: boolean
            agents: boolean
        }>(async () => {
            await init.run({ name: undefined, "no-agents": false })
        })
        // Default init seeds the agent files; workspace is the cwd it created in.
        expect(json).toEqual({ workspace: tmp, created: true, agents: true })
    })

    it("emits agents:false under --json when --no-agents is set", async () => {
        const json = await captureJson<{
            workspace: string
            created: boolean
            agents: boolean
        }>(async () => {
            await init.run({ name: undefined, "no-agents": true })
        })
        expect(json).toEqual({ workspace: tmp, created: true, agents: false })
    })

    it("reports the resolved workspace dir under --json when given a name", async () => {
        const json = await captureJson<{ workspace: string }>(async () => {
            await init.run({ name: "child", "no-agents": false })
        })
        expect(json.workspace).toBe(path.join(tmp, "child"))
    })
})
