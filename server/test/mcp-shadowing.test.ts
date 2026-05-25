/**
 * L2+L3: MCP server tier shadowing — when team + personal define the same
 * server name, what reaches the spawned binary?
 *
 * The composition is last-wins: personal mcpServers shadow team. UI flags
 * the shadow via `shadowsWorkspace: true` on the personal entry. Plugins are
 * a separate tier that CC auto-loads at runtime; same-named plugin/team can
 * coexist (plugin doesn't "shadow" workspace because plugin-tier MCPs come
 * from the .mcp.json shipped with each plugin).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"

process.env.LOOPAT_HOME ??= `/tmp/loopat-mcp-shadow-${process.pid}`
process.env.PORT = "0"
process.env.LOOPAT_SERVE_PORT = "0"

const HOME = process.env.LOOPAT_HOME!
await rm(HOME, { recursive: true, force: true })
await mkdir(HOME, { recursive: true })
await writeFile(join(HOME, "config.json"), JSON.stringify({
  knowledge: { git: "" }, notes: { git: "" }, repos: [], providers: {},
}))

const { app } = await import("../src/index")
const { composeFromPlan } = await import("../src/compose")
const {
  loopWorkdir, loopClaudeDir, loopContextKnowledge, loopContextNotes,
  personalDir, personalLoopatDir, personalClaudeDir, personalSettingsPath,
  workspaceTeamClaudeDir, workspaceTeamSettingsPath,
} = await import("../src/paths")
const { createUser, createSession, COOKIE_NAME } = await import("../src/auth")

const USER = "shadowtester"
let COOKIE = ""

async function authed(): Promise<Record<string, string>> {
  return { Cookie: `${COOKIE_NAME}=${COOKIE}` }
}

beforeAll(async () => {
  try { await createUser({ id: USER, password: "pw" }) } catch {}
  COOKIE = createSession(USER)
  await mkdir(personalLoopatDir(USER), { recursive: true })
  await mkdir(personalClaudeDir(USER), { recursive: true })
  // Team-tier MCPs: github + linear
  await mkdir(workspaceTeamClaudeDir(), { recursive: true })
  await writeFile(workspaceTeamSettingsPath(), JSON.stringify({
    mcpServers: {
      github: { type: "http", url: "https://team.github/mcp", headers: { Authorization: "Bearer ${MCP_GITHUB_TOKEN}" } },
      linear: { type: "http", url: "https://team.linear/mcp" },
    },
  }))
  // Personal-tier MCPs: github (shadow), private-only (no shadow)
  await writeFile(personalSettingsPath(USER), JSON.stringify({
    mcpServers: {
      github: { type: "http", url: "https://my-fork.github/mcp" },
      "private-only": { type: "stdio", command: "echo", args: ["personal"] },
    },
  }))
})

afterAll(async () => { await rm(HOME, { recursive: true, force: true }) })

describe("MCP tier shadowing — UI surface via /api/mcp-servers", () => {
  test("team tier surfaces all team-defined servers", async () => {
    const r = await app.request("/api/mcp-servers", { headers: await authed() })
    const j = await r.json() as any
    const team = j.tiers.find((t: any) => t.id === "team")
    expect(team.servers.map((s: any) => s.name).sort()).toEqual(["github", "linear"])
  })

  test("personal tier carries shadowsWorkspace=true for same-named entries", async () => {
    const r = await app.request("/api/mcp-servers", { headers: await authed() })
    const j = await r.json() as any
    const personal = j.tiers.find((t: any) => t.id === "personal")
    const github = personal.servers.find((s: any) => s.name === "github")
    const privateOnly = personal.servers.find((s: any) => s.name === "private-only")
    expect(github.shadowsWorkspace).toBe(true)
    expect(privateOnly.shadowsWorkspace).toBe(false)
  })

  test("personal-only servers (no team counterpart) are reachable from the personal tier", async () => {
    const r = await app.request("/api/mcp-servers", { headers: await authed() })
    const j = await r.json() as any
    const personal = j.tiers.find((t: any) => t.id === "personal")
    expect(personal.servers.some((s: any) => s.name === "private-only")).toBe(true)
  })

  test("team URL and personal URL for same name differ (independent entries)", async () => {
    const r = await app.request("/api/mcp-servers", { headers: await authed() })
    const j = await r.json() as any
    const teamGh = j.tiers.find((t: any) => t.id === "team").servers.find((s: any) => s.name === "github")
    const persGh = j.tiers.find((t: any) => t.id === "personal").servers.find((s: any) => s.name === "github")
    expect(teamGh.url).toBe("https://team.github/mcp")
    expect(persGh.url).toBe("https://my-fork.github/mcp")
  })
})

describe("MCP tier shadowing — composed settings.json (what spawned binary actually sees)", () => {
  test("personal entry wins over team in merged loops/<id>/.claude/settings.json", async () => {
    const loopId = "shadowsh-0000-0000-0000-000000000001"
    await mkdir(loopWorkdir(loopId), { recursive: true })
    await mkdir(loopClaudeDir(loopId), { recursive: true })
    await mkdir(loopContextKnowledge(loopId), { recursive: true })
    await mkdir(loopContextNotes(loopId), { recursive: true })
    const plan = {
      user: USER,
      claudeSources: [
        { source: "team", dir: workspaceTeamClaudeDir() },
        { source: `personal:${USER}`, dir: personalDir(USER) },
      ],
    }
    await composeFromPlan(loopId, plan as any)
    const merged = JSON.parse(await readFile(join(loopClaudeDir(loopId), "settings.json"), "utf8"))
    // github URL must be the PERSONAL one — personal layered last, last-wins
    expect(merged.mcpServers.github.url).toBe("https://my-fork.github/mcp")
    // The team-only server (linear) is still there — no shadow needed
    expect(merged.mcpServers.linear.url).toBe("https://team.linear/mcp")
    // The personal-only server is also there
    expect(merged.mcpServers["private-only"]).toBeDefined()
  })

  test("personal entry without headers DROPS the team's headers (full object replacement)", async () => {
    // Important semantic: composing replaces the whole server object, not
    // shallow-merges fields. The personal "github" entry has no headers, so
    // the spawned binary sees a github server with NO Authorization template.
    const loopId = "shadowsh-0000-0000-0000-000000000002"
    await mkdir(loopWorkdir(loopId), { recursive: true })
    await mkdir(loopClaudeDir(loopId), { recursive: true })
    await mkdir(loopContextKnowledge(loopId), { recursive: true })
    await mkdir(loopContextNotes(loopId), { recursive: true })
    await composeFromPlan(loopId, {
      user: USER,
      claudeSources: [
        { source: "team", dir: workspaceTeamClaudeDir() },
        { source: `personal:${USER}`, dir: personalDir(USER) },
      ],
    } as any)
    const merged = JSON.parse(await readFile(join(loopClaudeDir(loopId), "settings.json"), "utf8"))
    expect(merged.mcpServers.github.headers).toBeUndefined()
  })

  test("when only team defines a server, team's full object survives", async () => {
    // linear is only in team — should keep team's headers/url intact.
    const loopId = "shadowsh-0000-0000-0000-000000000003"
    await mkdir(loopWorkdir(loopId), { recursive: true })
    await mkdir(loopClaudeDir(loopId), { recursive: true })
    await mkdir(loopContextKnowledge(loopId), { recursive: true })
    await mkdir(loopContextNotes(loopId), { recursive: true })
    await composeFromPlan(loopId, {
      user: USER,
      claudeSources: [
        { source: "team", dir: workspaceTeamClaudeDir() },
        { source: `personal:${USER}`, dir: personalDir(USER) },
      ],
    } as any)
    const merged = JSON.parse(await readFile(join(loopClaudeDir(loopId), "settings.json"), "utf8"))
    expect(merged.mcpServers.linear).toEqual({ type: "http", url: "https://team.linear/mcp" })
  })
})
