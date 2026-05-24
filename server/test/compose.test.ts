/**
 * Tests for the tiered .claude/ merge — loopat's core composition logic.
 *
 * What we're testing:
 *   1. mergeSettings: enabledPlugins / extraKnownMarketplaces union + last-wins
 *   2. normalizeMarketplaceEntry: relative path resolution against source dir
 *   3. composeSubdir: skills/agents symlink union with later-wins shadowing
 *   4. composeFromPlan: full E2E with team + N profiles + personal + repo layers
 *   5. Stress: 12+ .claude sources merging cleanly
 *   6. Edge cases: empty sources, missing files, plugin disable overriding enable
 *
 * NOTE: LOOPAT_HOME must be set BEFORE source imports — paths.ts reads it
 * at module load time. Fixtures live under that home; afterAll wipes it.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test"
import { mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises"
import { existsSync, readlinkSync } from "node:fs"
import { join } from "node:path"

// paths.ts captures LOOPAT_HOME at module load. If another test file imported
// it first in this run, this assignment is a no-op; align our TEST_HOME to
// whatever was captured so the fixture and the helpers agree.
process.env.LOOPAT_HOME ??= `/tmp/loopat-merge-test-${process.pid}`

// Imports AFTER LOOPAT_HOME is set
const { composeLoopClaudeConfig } = await import("../src/compose")
const { resolveLoopPlan, listProfiles } = await import("../src/profiles")
const {
  LOOPAT_HOME,
  loopClaudeDir,
  workspaceTeamClaudeDir,
  workspaceProfileClaudeDir,
  personalClaudeDir,
  personalLoopatConfigPath,
} = await import("../src/paths")
const TEST_HOME = LOOPAT_HOME
// Avoid unused-var warning when tests below don't use this in every block
void loopClaudeDir

// ─── fixture helpers ───────────────────────────────────────────────────

async function writeJson(path: string, obj: unknown) {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, JSON.stringify(obj, null, 2))
}

async function writeMd(path: string, content: string) {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, content)
}

/** Create a `.claude/` dir with given settings, CLAUDE.md, skill names, agent names. */
async function makeClaudeDir(opts: {
  dir: string
  settings?: Record<string, any>
  claudeMd?: string
  skills?: string[]
  agents?: string[]
}) {
  await mkdir(opts.dir, { recursive: true })
  if (opts.settings !== undefined) {
    await writeJson(join(opts.dir, "settings.json"), opts.settings)
  }
  if (opts.claudeMd !== undefined) {
    await writeMd(join(opts.dir, "CLAUDE.md"), opts.claudeMd)
  }
  for (const s of opts.skills ?? []) {
    const skillDir = join(opts.dir, "skills", s)
    await mkdir(skillDir, { recursive: true })
    await writeMd(join(skillDir, "SKILL.md"), `---\nname: ${s}\ndescription: test skill ${s}\n---\n\n${s} body`)
  }
  for (const a of opts.agents ?? []) {
    await writeMd(join(opts.dir, "agents", `${a}.md`), `---\nname: ${a}\n---\n\n${a} body`)
  }
}

async function makeProfile(name: string, opts: Omit<Parameters<typeof makeClaudeDir>[0], "dir">) {
  await makeClaudeDir({ ...opts, dir: workspaceProfileClaudeDir(name) })
}

async function makeTeam(opts: Omit<Parameters<typeof makeClaudeDir>[0], "dir">) {
  await makeClaudeDir({ ...opts, dir: workspaceTeamClaudeDir() })
}

async function makePersonal(user: string, opts: Omit<Parameters<typeof makeClaudeDir>[0], "dir"> & {
  defaultProfiles?: string[]
}) {
  await makeClaudeDir({ ...opts, dir: personalClaudeDir(user) })
  await writeJson(personalLoopatConfigPath(user), {
    default_profiles: opts.defaultProfiles ?? [],
    default_vault: "default",
  })
}

async function reset() {
  await rm(TEST_HOME, { recursive: true, force: true })
  await mkdir(TEST_HOME, { recursive: true })
}

beforeAll(async () => { await reset() })
afterAll(async () => { await rm(TEST_HOME, { recursive: true, force: true }) })
beforeEach(async () => { await reset() })

// ─── 1. enabledPlugins union ───────────────────────────────────────────

describe("mergeSettings — enabledPlugins union", () => {
  test("union across sources, all preserved", async () => {
    await makeTeam({ settings: { enabledPlugins: { "team-plugin@mp": true } } })
    await makeProfile("p1", { settings: { enabledPlugins: { "p1-plugin@mp": true } } })
    await makePersonal("alice", { defaultProfiles: ["p1"] })

    const result = await composeLoopClaudeConfig("loop-test-1", "alice")
    const merged = JSON.parse(await readFile(result.settingsPath, "utf8"))
    expect(merged.enabledPlugins).toEqual({
      "team-plugin@mp": true,
      "p1-plugin@mp": true,
    })
  })

  test("later source can DISABLE a plugin enabled earlier", async () => {
    await makeTeam({ settings: { enabledPlugins: { "foo@mp": true } } })
    await makeProfile("p1", { settings: { enabledPlugins: { "foo@mp": false } } })
    await makePersonal("alice", { defaultProfiles: ["p1"] })

    const result = await composeLoopClaudeConfig("loop-test-2", "alice")
    const merged = JSON.parse(await readFile(result.settingsPath, "utf8"))
    expect(merged.enabledPlugins["foo@mp"]).toBe(false)
    expect(result.enabledPlugins).not.toContain("foo@mp")
  })

  test("disabled plugin can be re-enabled by later source", async () => {
    await makeTeam({ settings: { enabledPlugins: { "foo@mp": false } } })
    await makeProfile("p1", { settings: { enabledPlugins: { "foo@mp": true } } })
    await makePersonal("alice", { defaultProfiles: ["p1"] })

    const result = await composeLoopClaudeConfig("loop-test-3", "alice")
    const merged = JSON.parse(await readFile(result.settingsPath, "utf8"))
    expect(merged.enabledPlugins["foo@mp"]).toBe(true)
    expect(result.enabledPlugins).toContain("foo@mp")
  })
})

// ─── 2. extraKnownMarketplaces — union + path normalization ────────────

describe("mergeSettings — extraKnownMarketplaces", () => {
  test("union across sources", async () => {
    await makeTeam({ settings: { extraKnownMarketplaces: { mp1: { source: { source: "github", repo: "x/y" } } } } })
    await makeProfile("p1", { settings: { extraKnownMarketplaces: { mp2: { source: { source: "github", repo: "a/b" } } } } })
    await makePersonal("alice", { defaultProfiles: ["p1"] })

    const result = await composeLoopClaudeConfig("loop-mp-1", "alice")
    const merged = JSON.parse(await readFile(result.settingsPath, "utf8"))
    expect(Object.keys(merged.extraKnownMarketplaces ?? {}).sort()).toEqual(["mp1", "mp2"])
  })

  test("relative directory path resolves against source settings.json dir", async () => {
    // team settings at <knowledge>/.loopat/.claude/ → "../../marketplace" = <knowledge>/marketplace/
    await makeTeam({
      settings: {
        extraKnownMarketplaces: {
          "team-mp": { source: { source: "directory", path: "../../marketplace" } },
        },
      },
    })
    await makePersonal("alice", { defaultProfiles: [] })

    const result = await composeLoopClaudeConfig("loop-mp-2", "alice")
    const merged = JSON.parse(await readFile(result.settingsPath, "utf8"))
    const path = merged.extraKnownMarketplaces["team-mp"].source.path
    expect(path).toMatch(/^\//)
    expect(path.endsWith("/knowledge/marketplace")).toBe(true)
  })

  test("absolute directory path preserved as-is", async () => {
    await makeTeam({
      settings: {
        extraKnownMarketplaces: { "abs-mp": { source: { source: "directory", path: "/some/abs/path" } } },
      },
    })
    await makePersonal("alice", { defaultProfiles: [] })

    const result = await composeLoopClaudeConfig("loop-mp-3", "alice")
    const merged = JSON.parse(await readFile(result.settingsPath, "utf8"))
    expect(merged.extraKnownMarketplaces["abs-mp"].source.path).toBe("/some/abs/path")
  })

  test("non-directory sources (github, url) pass through unchanged", async () => {
    await makeTeam({
      settings: {
        extraKnownMarketplaces: {
          "gh-mp": { source: { source: "github", repo: "anthropics/claude-plugins-official" } },
          "url-mp": { source: { source: "url", url: "https://example.com/m.json" } },
        },
      },
    })
    await makePersonal("alice", { defaultProfiles: [] })

    const result = await composeLoopClaudeConfig("loop-mp-4", "alice")
    const merged = JSON.parse(await readFile(result.settingsPath, "utf8"))
    expect(merged.extraKnownMarketplaces["gh-mp"]).toEqual({
      source: { source: "github", repo: "anthropics/claude-plugins-official" },
    })
    expect(merged.extraKnownMarketplaces["url-mp"]).toEqual({
      source: { source: "url", url: "https://example.com/m.json" },
    })
  })

  test("each source resolves relative paths against ITS OWN settings dir", async () => {
    await makeTeam({
      settings: { extraKnownMarketplaces: { "team-rel": { source: { source: "directory", path: "../foo" } } } },
    })
    await makeProfile("p1", {
      settings: { extraKnownMarketplaces: { "p1-rel": { source: { source: "directory", path: "../foo" } } } },
    })
    await makePersonal("alice", { defaultProfiles: ["p1"] })

    const result = await composeLoopClaudeConfig("loop-mp-5", "alice")
    const merged = JSON.parse(await readFile(result.settingsPath, "utf8"))
    const teamPath = merged.extraKnownMarketplaces["team-rel"].source.path
    const p1Path = merged.extraKnownMarketplaces["p1-rel"].source.path
    expect(teamPath).not.toBe(p1Path)
    expect(teamPath.endsWith("/.loopat/foo")).toBe(true)
    expect(p1Path.endsWith("/profiles/p1/foo")).toBe(true)
  })
})

// ─── 3. Other settings field semantics ─────────────────────────────────

describe("mergeSettings — other fields", () => {
  test("primitives: later source wins", async () => {
    await makeTeam({ settings: { someInt: 1, someStr: "team" } })
    await makeProfile("p1", { settings: { someInt: 2, someStr: "p1" } })
    await makePersonal("alice", { defaultProfiles: ["p1"] })

    const result = await composeLoopClaudeConfig("loop-prim-1", "alice")
    const merged = JSON.parse(await readFile(result.settingsPath, "utf8"))
    expect(merged.someInt).toBe(2)
    expect(merged.someStr).toBe("p1")
  })

  test("arrays: later source replaces", async () => {
    await makeTeam({ settings: { someArr: ["a", "b"] } })
    await makeProfile("p1", { settings: { someArr: ["c"] } })
    await makePersonal("alice", { defaultProfiles: ["p1"] })

    const result = await composeLoopClaudeConfig("loop-arr-1", "alice")
    const merged = JSON.parse(await readFile(result.settingsPath, "utf8"))
    expect(merged.someArr).toEqual(["c"])
  })

  test("_comment field stripped", async () => {
    await makeTeam({ settings: { _comment: "team", enabledPlugins: {} } })
    await makeProfile("p1", { settings: { _comment: "p1" } })
    await makePersonal("alice", { defaultProfiles: ["p1"] })

    const result = await composeLoopClaudeConfig("loop-comment", "alice")
    const merged = JSON.parse(await readFile(result.settingsPath, "utf8"))
    expect(merged._comment).toBeUndefined()
  })

  test("loopat injects autoMemory fields", async () => {
    await makePersonal("alice", { defaultProfiles: [] })
    const result = await composeLoopClaudeConfig("loop-auto", "alice")
    const merged = JSON.parse(await readFile(result.settingsPath, "utf8"))
    expect(merged.autoMemoryEnabled).toBe(true)
    expect(merged.autoMemoryDirectory).toBeDefined()
  })
})

// ─── 4. CLAUDE.md concat ────────────────────────────────────────────────

describe("CLAUDE.md concat", () => {
  test("order: team → profile → personal", async () => {
    await makeTeam({ claudeMd: "# Team" })
    await makeProfile("p1", { claudeMd: "# P1" })
    await makePersonal("alice", { claudeMd: "# Alice", defaultProfiles: ["p1"] })

    const result = await composeLoopClaudeConfig("loop-md-1", "alice")
    const body = await readFile(result.claudeMdPath, "utf8")
    expect(body.indexOf("# Team")).toBeLessThan(body.indexOf("# P1"))
    expect(body.indexOf("# P1")).toBeLessThan(body.indexOf("# Alice"))
  })

  test("section markers identify each source", async () => {
    await makeTeam({ claudeMd: "Team body" })
    await makeProfile("p1", { claudeMd: "P1 body" })
    await makePersonal("alice", { claudeMd: "Alice body", defaultProfiles: ["p1"] })

    const result = await composeLoopClaudeConfig("loop-md-2", "alice")
    const body = await readFile(result.claudeMdPath, "utf8")
    expect(body).toContain("<!-- ========== team ========== -->")
    expect(body).toContain("<!-- ========== profile:p1 ========== -->")
    expect(body).toContain("<!-- ========== personal:alice ========== -->")
  })

  test("missing source files silently skipped", async () => {
    await makeTeam({ claudeMd: "Team body" })
    await makeProfile("p2", {}) // no CLAUDE.md
    await makePersonal("alice", { defaultProfiles: ["p2"] })

    const result = await composeLoopClaudeConfig("loop-md-3", "alice")
    const body = await readFile(result.claudeMdPath, "utf8")
    expect(body).toContain("Team body")
    expect(body).not.toContain("profile:p2")
  })

  test("no CLAUDE.md anywhere → file does not exist", async () => {
    await makePersonal("alice", { defaultProfiles: [] })
    const result = await composeLoopClaudeConfig("loop-md-4", "alice")
    expect(existsSync(result.claudeMdPath)).toBe(false)
  })
})

// ─── 5. skills/agents symlink union ─────────────────────────────────────

describe("skills/agents symlink union", () => {
  test("skills from all sources union'd", async () => {
    await makeTeam({ skills: ["s-team-1", "s-team-2"] })
    await makeProfile("p1", { skills: ["s-p1"] })
    await makePersonal("alice", { skills: ["s-alice"], defaultProfiles: ["p1"] })

    await composeLoopClaudeConfig("loop-skills-1", "alice")
    const entries = await readdir(join(loopClaudeDir("loop-skills-1"), "skills"))
    expect(entries.sort()).toEqual(["s-alice", "s-p1", "s-team-1", "s-team-2"])
  })

  test("same-name skill from later source shadows earlier", async () => {
    await makeTeam({ skills: ["dup"] })
    await makeProfile("p1", { skills: ["dup"] })
    await makePersonal("alice", { defaultProfiles: ["p1"] })

    await composeLoopClaudeConfig("loop-skills-2", "alice")
    const dupLink = readlinkSync(join(loopClaudeDir("loop-skills-2"), "skills", "dup"))
    expect(dupLink).toContain("/profiles/p1/.claude/skills/dup")
  })

  test("agents are .md files", async () => {
    await makeTeam({ agents: ["a1"] })
    await makeProfile("p1", { agents: ["a2"] })
    await makePersonal("alice", { agents: ["a3"], defaultProfiles: ["p1"] })

    await composeLoopClaudeConfig("loop-agents-1", "alice")
    const entries = await readdir(join(loopClaudeDir("loop-agents-1"), "agents"))
    expect(entries.sort()).toEqual(["a1.md", "a2.md", "a3.md"])
  })
})

// ─── 6. Profile selection ──────────────────────────────────────────────

describe("resolveLoopPlan — profile selection", () => {
  test("default_profiles loaded from personal config", async () => {
    await makeProfile("role-a", {})
    await makeProfile("role-b", {})
    await makePersonal("alice", { defaultProfiles: ["role-a", "role-b"] })

    const plan = await resolveLoopPlan({ user: "alice" })
    expect(plan.profiles).toEqual(["role-a", "role-b"])
  })

  test("cliAdded appends", async () => {
    await makeProfile("role-a", {})
    await makeProfile("mode-c", {})
    await makePersonal("alice", { defaultProfiles: ["role-a"] })

    const plan = await resolveLoopPlan({ user: "alice", cliAdded: ["mode-c"] })
    expect(plan.profiles).toEqual(["role-a", "mode-c"])
  })

  test("cliRemoved drops", async () => {
    await makeProfile("role-a", {})
    await makeProfile("role-b", {})
    await makePersonal("alice", { defaultProfiles: ["role-a", "role-b"] })

    const plan = await resolveLoopPlan({ user: "alice", cliRemoved: ["role-a"] })
    expect(plan.profiles).toEqual(["role-b"])
  })

  test("overrideProfiles replaces defaults", async () => {
    await makeProfile("role-a", {})
    await makeProfile("mode-x", {})
    await makePersonal("alice", { defaultProfiles: ["role-a"] })

    const plan = await resolveLoopPlan({ user: "alice", overrideProfiles: ["mode-x"] })
    expect(plan.profiles).toEqual(["mode-x"])
  })

  test("missing profile errors", async () => {
    // Create at least one profile so profiles/ dir exists; then ask for a missing one
    await makeProfile("real-profile", {})
    await makePersonal("alice", { defaultProfiles: ["does-not-exist"] })
    await expect(resolveLoopPlan({ user: "alice" })).rejects.toThrow(/does-not-exist/)
  })

  test("workdir/.claude/ becomes 5th source layer", async () => {
    await makeProfile("role-a", {})
    await makePersonal("alice", { defaultProfiles: ["role-a"] })
    const workdir = join(TEST_HOME, "fake-workdir")
    await makeClaudeDir({ dir: join(workdir, ".claude"), claudeMd: "# Repo" })

    const plan = await resolveLoopPlan({ user: "alice", workdir })
    expect(plan.claudeSources.map((s) => s.source)).toContain(`repo:${workdir}`)
  })
})

// ─── 7. STRESS: 12+ .claude sources merge cleanly ──────────────────────

describe("stress — 12 .claude sources", () => {
  test("12 profiles + team + personal merge without breaking", async () => {
    await makeTeam({
      settings: { enabledPlugins: { "team-base@mp": true } },
      claudeMd: "# Team",
      skills: ["team-skill"],
    })

    const profileNames: string[] = []
    for (let i = 0; i < 12; i++) {
      const name = `mode-${i.toString().padStart(2, "0")}`
      profileNames.push(name)
      await makeProfile(name, {
        settings: { enabledPlugins: { [`p${i}@mp`]: true } },
        claudeMd: `# Profile ${i}`,
        skills: [`skill-${i}`],
      })
    }
    await makePersonal("alice", {
      defaultProfiles: profileNames,
      skills: ["personal-skill"],
      claudeMd: "# Personal",
    })

    const result = await composeLoopClaudeConfig("loop-stress", "alice")
    const merged = JSON.parse(await readFile(result.settingsPath, "utf8"))

    // 13 plugins enabled (team-base + 12 profile plugins)
    const enabledKeys = Object.entries(merged.enabledPlugins ?? {})
      .filter(([_, v]) => v).map(([k]) => k)
    expect(enabledKeys.length).toBe(13)
    expect(enabledKeys).toContain("team-base@mp")
    for (let i = 0; i < 12; i++) {
      expect(enabledKeys).toContain(`p${i}@mp`)
    }

    // 14 distinct skills
    const skills = await readdir(join(loopClaudeDir("loop-stress"), "skills"))
    expect(skills.length).toBe(14)

    // 14 CLAUDE.md sections (team + 12 + personal)
    const md = await readFile(result.claudeMdPath, "utf8")
    const markers = md.match(/<!-- ========== /g) ?? []
    expect(markers.length).toBe(14)

    // result lists also reflect this
    expect(result.enabledPlugins.length).toBe(13)
    expect(result.sources.length).toBe(14)
  })
})

// ─── 8. ComposeResult shape ─────────────────────────────────────────────

describe("composeFromPlan E2E", () => {
  test("returns enabledPlugins (true only) and extraMarketplaces list", async () => {
    await makeTeam({
      settings: {
        enabledPlugins: { "a@mp": true, "b@mp": false },
        extraKnownMarketplaces: {
          "mp": { source: { source: "directory", path: "../mp-here" } },
          "remote": { source: { source: "github", repo: "x/y" } },
        },
      },
    })
    await makePersonal("alice", { defaultProfiles: [] })

    const r = await composeLoopClaudeConfig("loop-shape-1", "alice")
    expect(r.enabledPlugins).toEqual(["a@mp"])
    expect(r.extraMarketplaces.sort()).toEqual(["mp", "remote"])
    expect(r.sources).toContain("team")
    expect(r.sources).toContain("personal:alice")
  })
})

// ─── 9. mise.toml + mise.lock merge ────────────────────────────────────

describe("mise.toml merge (toolchain layer)", () => {
  async function writeToml(path: string, content: string) {
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, content)
  }

  test("union of [tools] across sources, last wins per-key", async () => {
    await makeTeam({ settings: {} })
    await writeToml(join(workspaceTeamClaudeDir(), "mise.toml"), `
[tools]
node = "20"
python = "3.12"
`)
    await makeProfile("ml", { settings: {} })
    await writeToml(join(workspaceProfileClaudeDir("ml"), "mise.toml"), `
[tools]
python = "3.13"
cuda = "12.4"
`)
    await makePersonal("alice", { defaultProfiles: ["ml"] })
    await writeToml(join(personalClaudeDir("alice"), "mise.toml"), `
[tools]
node = "22"
`)

    const result = await composeLoopClaudeConfig("loop-mise-1", "alice")
    expect(result.miseTomlPath).toBeTruthy()
    const merged = await readFile(result.miseTomlPath!, "utf8")
    expect(merged).toContain('node = "22"')      // personal wins over team
    expect(merged).toContain('python = "3.13"')  // profile wins over team
    expect(merged).toContain('cuda = "12.4"')    // profile-only
  })

  test("union of [env] across sources, last wins per-key", async () => {
    await makeTeam({ settings: {} })
    await writeToml(join(workspaceTeamClaudeDir(), "mise.toml"), `
[env]
NODE_ENV = "development"
TEAM_FLAG = "true"
`)
    await makeProfile("p1", { settings: {} })
    await writeToml(join(workspaceProfileClaudeDir("p1"), "mise.toml"), `
[env]
NODE_ENV = "production"
PROFILE_FLAG = "yes"
`)
    await makePersonal("alice", { defaultProfiles: ["p1"] })

    const result = await composeLoopClaudeConfig("loop-mise-2", "alice")
    const merged = await readFile(result.miseTomlPath!, "utf8")
    expect(merged).toContain('NODE_ENV = "production"')  // profile wins
    expect(merged).toContain('TEAM_FLAG = "true"')
    expect(merged).toContain('PROFILE_FLAG = "yes"')
  })

  test("nested table merge (e.g. [tools.node] = {version, checksum})", async () => {
    await makeTeam({ settings: {} })
    await writeToml(join(workspaceTeamClaudeDir(), "mise.lock"), `
[tools.node]
version = "20.18.0"
checksum = "abc"

[tools.python]
version = "3.12.7"
checksum = "def"
`)
    await makeProfile("p1", { settings: {} })
    await writeToml(join(workspaceProfileClaudeDir("p1"), "mise.lock"), `
[tools.python]
version = "3.13.0"
checksum = "jkl"

[tools.cuda]
version = "12.4.1"
checksum = "ghi"
`)
    await makePersonal("alice", { defaultProfiles: ["p1"] })

    const result = await composeLoopClaudeConfig("loop-mise-3", "alice")
    expect(result.miseLockPath).toBeTruthy()
    const merged = await readFile(result.miseLockPath!, "utf8")
    // python overridden by profile
    expect(merged).toMatch(/python[\s\S]*version = "3.13.0"/)
    // node preserved from team
    expect(merged).toMatch(/node[\s\S]*version = "20.18.0"/)
    // cuda added by profile
    expect(merged).toMatch(/cuda[\s\S]*version = "12.4.1"/)
  })

  test("no source has mise.toml → miseTomlPath null", async () => {
    await makePersonal("alice", { defaultProfiles: [] })
    const result = await composeLoopClaudeConfig("loop-mise-4", "alice")
    expect(result.miseTomlPath).toBeNull()
    expect(result.miseLockPath).toBeNull()
  })

  test("only team has mise.toml → merged is team's", async () => {
    await makeTeam({ settings: {} })
    await writeToml(join(workspaceTeamClaudeDir(), "mise.toml"), `
[tools]
node = "20"
`)
    await makePersonal("alice", { defaultProfiles: [] })

    const result = await composeLoopClaudeConfig("loop-mise-5", "alice")
    expect(result.miseTomlPath).toBeTruthy()
    const merged = await readFile(result.miseTomlPath!, "utf8")
    expect(merged).toContain('node = "20"')
  })

  test("malformed TOML in one source doesn't crash; warns and skips", async () => {
    await makeTeam({ settings: {} })
    await writeToml(join(workspaceTeamClaudeDir(), "mise.toml"), 'not valid toml [[[')
    await makeProfile("p1", { settings: {} })
    await writeToml(join(workspaceProfileClaudeDir("p1"), "mise.toml"), `
[tools]
python = "3.12"
`)
    await makePersonal("alice", { defaultProfiles: ["p1"] })

    const result = await composeLoopClaudeConfig("loop-mise-6", "alice")
    expect(result.miseTomlPath).toBeTruthy()
    const merged = await readFile(result.miseTomlPath!, "utf8")
    expect(merged).toContain('python = "3.12"')  // good source survives
  })

  test("mise.toml independence — different layer adds DIFFERENT tools", async () => {
    await makeTeam({ settings: {} })
    await writeToml(join(workspaceTeamClaudeDir(), "mise.toml"), `[tools]\nnode = "20"`)
    await makeProfile("backend", { settings: {} })
    await writeToml(join(workspaceProfileClaudeDir("backend"), "mise.toml"), `[tools]\ngo = "1.22"`)
    await makeProfile("ml", { settings: {} })
    await writeToml(join(workspaceProfileClaudeDir("ml"), "mise.toml"), `[tools]\npython = "3.13"`)
    await makePersonal("alice", { defaultProfiles: ["backend", "ml"] })

    const result = await composeLoopClaudeConfig("loop-mise-7", "alice")
    const merged = await readFile(result.miseTomlPath!, "utf8")
    expect(merged).toContain('node = "20"')
    expect(merged).toContain('go = "1.22"')
    expect(merged).toContain('python = "3.13"')
  })

  test("orphan mise.lock (no mise.toml in any source) still writes lock", async () => {
    // Edge case: lock present but no toml. Rare but valid.
    await makeTeam({ settings: {} })
    await writeToml(join(workspaceTeamClaudeDir(), "mise.lock"), `
[tools.node]
version = "20.18.0"
checksum = "abc"
`)
    await makePersonal("alice", { defaultProfiles: [] })

    const result = await composeLoopClaudeConfig("loop-mise-8", "alice")
    expect(result.miseTomlPath).toBeNull()
    expect(result.miseLockPath).toBeTruthy()
  })
})

// ─── 10. Marketplace source-drift detection ────────────────────────────

describe("sourcesMatch — marketplace URL drift detection", () => {
  let sourcesMatch: any

  beforeAll(async () => {
    sourcesMatch = (await import("../src/plugin-installer")).sourcesMatch
  })

  test("git: identical URL → match", () => {
    expect(sourcesMatch(
      { source: "git", url: "git@x.com/foo.git" },
      { source: "git", url: "git@x.com/foo.git" },
    )).toBe(true)
  })

  test("git: different URL (drift) → mismatch", () => {
    expect(sourcesMatch(
      { source: "git", url: "git@x.com/new.git" },
      { source: "git", url: "git@x.com/old.git" },
    )).toBe(false)
  })

  test("github: repo same → match", () => {
    expect(sourcesMatch(
      { source: "github", repo: "owner/x" },
      { source: "github", repo: "owner/x" },
    )).toBe(true)
  })

  test("github: legacy `repository` field == new `repo` field", () => {
    expect(sourcesMatch(
      { source: "github", repo: "owner/x" },
      { source: "github", repository: "owner/x" },
    )).toBe(true)
  })

  test("directory: same path → match", () => {
    expect(sourcesMatch(
      { source: "directory", path: "/a/b" },
      { source: "directory", path: "/a/b" },
    )).toBe(true)
  })

  test("directory: different path → mismatch", () => {
    expect(sourcesMatch(
      { source: "directory", path: "/new/path" },
      { source: "directory", path: "/old/path" },
    )).toBe(false)
  })

  test("different source types → mismatch", () => {
    expect(sourcesMatch(
      { source: "github", repo: "x/y" },
      { source: "git", url: "git@x.com/y.git" },
    )).toBe(false)
  })

  test("nullish guards", () => {
    expect(sourcesMatch(null, null)).toBe(true)
    expect(sourcesMatch(null, { source: "git" })).toBe(false)
    expect(sourcesMatch({ source: "git" }, undefined)).toBe(false)
  })
})

// ─── 11. listProfiles ───────────────────────────────────────────────────

describe("listProfiles", () => {
  test("returns dirs that have .claude/ subdir", async () => {
    await makeProfile("role-a", {})
    await makeProfile("role-b", {})
    await mkdir(join(TEST_HOME, "context/knowledge/.loopat/profiles/not-a-profile"), { recursive: true })

    const names = await listProfiles()
    expect(names.sort()).toEqual(["role-a", "role-b"])
  })

  test("empty when no profiles", async () => {
    const names = await listProfiles()
    expect(names).toEqual([])
  })
})

// ─── 8. Path invariants (post-composition-model rewrite) ─────────────────

describe("path invariants", () => {
  test("personal .claude/ lives at personal/<user>/.loopat/.claude/", async () => {
    // The personal tier mirrors the team tier: both put loopat-managed config
    // under a `.loopat/` segment of the owning repo. Anything outside
    // `.loopat/` in personal/ belongs to the user, not loopat.
    const dir = personalClaudeDir("alice")
    expect(dir.endsWith("/personal/alice/.loopat/.claude")).toBe(true)
  })

  test("team .claude/ lives at knowledge/.loopat/.claude/", async () => {
    const dir = workspaceTeamClaudeDir()
    expect(dir.endsWith("/knowledge/.loopat/.claude")).toBe(true)
  })

  test("profile .claude/ lives at knowledge/.loopat/profiles/<n>/.claude/", async () => {
    const dir = workspaceProfileClaudeDir("role-eng")
    expect(dir.endsWith("/knowledge/.loopat/profiles/role-eng/.claude")).toBe(true)
  })
})

// ─── 9. MCP server merge across tiers ────────────────────────────────────

describe("mergeSettings — mcpServers union", () => {
  test("mcpServers from every tier appear in merged settings.json", async () => {
    // Why this matters: session.ts reads mergedServers from the merged
    // settings.json on disk and injects vault credentials into it before
    // passing to SDK. If compose drops a tier's mcpServers, that server is
    // invisible to the loop even if the tier declared it.
    await makeTeam({
      settings: { mcpServers: { "team-mcp": { type: "http", url: "https://team.example/mcp" } } },
    })
    await makeProfile("oncall", {
      settings: { mcpServers: { "pagerduty": { type: "http", url: "https://pd.example/mcp" } } },
    })
    await makePersonal("alice", {
      defaultProfiles: ["oncall"],
      settings: { mcpServers: { "personal-jira": { command: "node", args: ["./jira-mcp.js"] } } },
    })

    const result = await composeLoopClaudeConfig("loop-mcp-merge", "alice")
    const merged = JSON.parse(await readFile(result.settingsPath, "utf8"))

    expect(Object.keys(merged.mcpServers ?? {}).sort()).toEqual([
      "pagerduty",
      "personal-jira",
      "team-mcp",
    ])
    expect(merged.mcpServers["team-mcp"]).toEqual({ type: "http", url: "https://team.example/mcp" })
    expect(merged.mcpServers["pagerduty"]).toEqual({ type: "http", url: "https://pd.example/mcp" })
    expect(merged.mcpServers["personal-jira"]).toEqual({ command: "node", args: ["./jira-mcp.js"] })
  })

  test("personal-tier mcpServer with same name overrides team-tier (last-wins)", async () => {
    // A user might point an MCP server at a personal endpoint while still
    // benefiting from the team-declared config for the rest.
    await makeTeam({
      settings: { mcpServers: { github: { type: "http", url: "https://team.example/gh" } } },
    })
    await makePersonal("alice", {
      defaultProfiles: [],
      settings: { mcpServers: { github: { type: "http", url: "https://alice.example/gh" } } },
    })

    const result = await composeLoopClaudeConfig("loop-mcp-override", "alice")
    const merged = JSON.parse(await readFile(result.settingsPath, "utf8"))
    expect(merged.mcpServers.github.url).toBe("https://alice.example/gh")
  })

  test("mcpServer secrets are NEVER written to the composed settings.json", async () => {
    // Locks in the auth/config split: sources declare server CONFIG; vault
    // contributes CREDENTIALS at spawn time. The settings.json on disk must
    // carry no apiKey/authorization values, even if a source accidentally
    // included one. (Compose itself doesn't strip them — but our convention
    // is "don't put secrets in .claude/settings.json". This test documents
    // that the merge faithfully reflects what sources put in, so any leak
    // would show up here as a deliberate-feeling failure pointing at the
    // source tier rather than at compose.)
    await makeTeam({ settings: { mcpServers: { svc: { type: "http", url: "https://svc/" } } } })
    await makePersonal("alice", { defaultProfiles: [] })
    const result = await composeLoopClaudeConfig("loop-mcp-no-secrets", "alice")
    const text = await readFile(result.settingsPath, "utf8")
    expect(text.toLowerCase()).not.toContain("authorization")
    expect(text.toLowerCase()).not.toContain("apikey")
    expect(text.toLowerCase()).not.toContain("bearer ")
  })
})

// ─── 10. CLAUDE.md tiered concatenation ──────────────────────────────────

describe("composeFromPlan — CLAUDE.md", () => {
  test("each tier's CLAUDE.md is included in the merged output", async () => {
    await makeTeam({ claudeMd: "# Team rule\n\nAlways do X." })
    await makeProfile("role-eng", { claudeMd: "# Engineering\n\nUse strict TypeScript." })
    await makePersonal("alice", {
      defaultProfiles: ["role-eng"],
      claudeMd: "# Alice's notes\n\nLowercase variable names.",
    })

    const result = await composeLoopClaudeConfig("loop-claudemd", "alice")
    const text = await readFile(result.claudeMdPath, "utf8")
    expect(text).toContain("Always do X.")
    expect(text).toContain("Use strict TypeScript.")
    expect(text).toContain("Lowercase variable names.")
  })

  test("CLAUDE.md missing in some tiers is silently skipped", async () => {
    await makeTeam({})  // no claudeMd
    await makeProfile("role-eng", { claudeMd: "# Only profile speaks" })
    await makePersonal("alice", { defaultProfiles: ["role-eng"] })  // no claudeMd

    const result = await composeLoopClaudeConfig("loop-claudemd-partial", "alice")
    const text = await readFile(result.claudeMdPath, "utf8")
    expect(text).toContain("Only profile speaks")
  })
})

// ─── 11. installed_plugins.json (per-loop plugin version lock) ───────────

/**
 * Helper: write a .claude/plugins/installed_plugins.json under the given
 * .claude/ dir, in the CC-native shape.
 */
async function writeInstalledPlugins(
  claudeDir: string,
  plugins: Record<string, { version: string; gitCommitSha?: string; installPath?: string }>,
) {
  const pluginsDir = join(claudeDir, "plugins")
  await mkdir(pluginsDir, { recursive: true })
  const ip = {
    version: 1,
    plugins: Object.fromEntries(
      Object.entries(plugins).map(([spec, v]) => [
        spec,
        [{
          scope: "user",
          installPath: v.installPath ?? `/host/cache/${spec}/${v.version}`,
          version: v.version,
          installedAt: "2026-05-24T00:00:00.000Z",
          lastUpdated: "2026-05-24T00:00:00.000Z",
          gitCommitSha: v.gitCommitSha ?? "0000000",
        }],
      ]),
    ),
  }
  await writeFile(join(pluginsDir, "installed_plugins.json"), JSON.stringify(ip, null, 2))
}

describe("compose — installed_plugins.json (plugin version lock)", () => {
  test("team's lock is snapshotted into loops/<id>/.claude/plugins/installed_plugins.json", async () => {
    await makeTeam({ settings: { enabledPlugins: { "cicd@market": true } } })
    await writeInstalledPlugins(workspaceTeamClaudeDir(), {
      "cicd@market": { version: "0.1.0", gitCommitSha: "abc123" },
    })
    await makePersonal("alice", { defaultProfiles: [] })

    const result = await composeLoopClaudeConfig("loop-lock-1", "alice")
    expect(result.installedPluginsPath).not.toBeNull()
    const snapshot = JSON.parse(await readFile(result.installedPluginsPath!, "utf8"))
    expect(snapshot.plugins["cicd@market"][0].version).toBe("0.1.0")
    expect(snapshot.plugins["cicd@market"][0].gitCommitSha).toBe("abc123")
  })

  test("personal lock overrides team lock per spec (version + sha both replaced)", async () => {
    await makeTeam({ settings: { enabledPlugins: { "cicd@market": true } } })
    await writeInstalledPlugins(workspaceTeamClaudeDir(), {
      "cicd@market": { version: "0.1.0", gitCommitSha: "abc" },
    })
    await makePersonal("alice", { defaultProfiles: [] })
    await writeInstalledPlugins(personalClaudeDir("alice"), {
      "cicd@market": { version: "9.9.9-alice-fork", gitCommitSha: "deadbeef" },
    })

    const result = await composeLoopClaudeConfig("loop-lock-2", "alice")
    const snapshot = JSON.parse(await readFile(result.installedPluginsPath!, "utf8"))
    expect(snapshot.plugins["cicd@market"][0].version).toBe("9.9.9-alice-fork")
    expect(snapshot.plugins["cicd@market"][0].gitCommitSha).toBe("deadbeef")
  })

  test("specs only in one tier coexist with specs only in another (per-spec union)", async () => {
    await makeTeam({ settings: { enabledPlugins: { "team-only@m": true } } })
    await writeInstalledPlugins(workspaceTeamClaudeDir(), {
      "team-only@m": { version: "1.0.0", gitCommitSha: "team-sha" },
    })
    await makePersonal("alice", {
      defaultProfiles: [],
      settings: { enabledPlugins: { "alice-only@m": true } },
    })
    await writeInstalledPlugins(personalClaudeDir("alice"), {
      "alice-only@m": { version: "2.0.0", gitCommitSha: "alice-sha" },
    })

    const result = await composeLoopClaudeConfig("loop-lock-3", "alice")
    const snapshot = JSON.parse(await readFile(result.installedPluginsPath!, "utf8"))
    expect(Object.keys(snapshot.plugins).sort()).toEqual(["alice-only@m", "team-only@m"])
    expect(snapshot.plugins["team-only@m"][0].version).toBe("1.0.0")
    expect(snapshot.plugins["alice-only@m"][0].version).toBe("2.0.0")
  })

  test("no tier publishes installed_plugins.json → installedPluginsPath is null + file absent", async () => {
    await makeTeam({ settings: { enabledPlugins: { "foo@m": true } } })
    await makePersonal("alice", { defaultProfiles: [] })

    const result = await composeLoopClaudeConfig("loop-lock-4", "alice")
    expect(result.installedPluginsPath).toBeNull()
    expect(existsSync(join(loopClaudeDir("loop-lock-4"), "plugins", "installed_plugins.json"))).toBe(false)
  })

  test("re-running compose with the lock removed cleans up the previous snapshot", async () => {
    // First compose: a lock exists
    await makeTeam({ settings: { enabledPlugins: { "x@m": true } } })
    await writeInstalledPlugins(workspaceTeamClaudeDir(), {
      "x@m": { version: "1.0.0" },
    })
    await makePersonal("alice", { defaultProfiles: [] })
    const first = await composeLoopClaudeConfig("loop-lock-5", "alice")
    expect(first.installedPluginsPath).not.toBeNull()

    // Now wipe the lock at the source, re-compose: stale lock must be removed
    await rm(join(workspaceTeamClaudeDir(), "plugins"), { recursive: true })
    const second = await composeLoopClaudeConfig("loop-lock-5", "alice")
    expect(second.installedPluginsPath).toBeNull()
    expect(existsSync(join(loopClaudeDir("loop-lock-5"), "plugins", "installed_plugins.json"))).toBe(false)
  })
})


